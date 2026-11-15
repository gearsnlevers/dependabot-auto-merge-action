/*
 * Reads what the policy needs from the dependabot.yml of the repository that calls the action: the patterns of the
 * Dependabot group `tooling` of its npm entry, and where its lockfile is. No dependency: dependabot.yml uses a small
 * part of YAML (block mappings and sequences, quoted and plain strings, comments), and that part is parsed here. What
 * is outside it (anchors, tags, block scalars, flow mappings, tabs) is an error, never a guess: a policy that cannot
 * be read arms nothing.
 */

function fail(line, message) {
  throw new Error(`dependabot.yml, line ${line}: ${message}`);
}

/** Remove a comment: a `#` at the start or after white space, outside quotes. */
function stripComment(text) {
  let quote = '';
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      if (c === '\\' && quote === '"') i++;
      else if (c === quote) quote = '';
    } else if (c === '"' || c === "'") {
      // a quote starts a quoted scalar only at the start of a value
      if (i === 0 || /[\s:[,{-]/.test(text[i - 1])) quote = c;
    } else if (c === '#' && (i === 0 || /\s/.test(text[i - 1]))) {
      return text.slice(0, i);
    }
  }
  return text;
}

function scalar(text, line) {
  const t = text.trim();
  if (t.startsWith('"')) {
    if (t.length < 2 || !t.endsWith('"')) fail(line, `unterminated string ${t}`);
    return t.slice(1, -1).replace(/\\(["\\/])/g, '$1').replace(/\\n/g, '\n');
  }
  if (t.startsWith("'")) {
    if (t.length < 2 || !t.endsWith("'")) fail(line, `unterminated string ${t}`);
    return t.slice(1, -1).replace(/''/g, "'");
  }
  if (/^[&*!|>%@`]/.test(t)) {
    fail(line, `${t[0]} (anchor, alias, tag or block scalar) is not supported`);
  }
  if (t === '~' || t === 'null') return null;
  if (/^-?\d+$/.test(t)) return Number(t);
  return t;
}

function flowSequence(text, line) {
  const body = text.trim().slice(1, -1);
  if (!text.trim().endsWith(']')) fail(line, 'a flow sequence must end on its line');
  const items = [];
  let current = '';
  let quote = '';
  for (const c of body) {
    if (quote) {
      current += c;
      if (c === quote) quote = '';
    } else if (c === '"' || c === "'") {
      quote = c;
      current += c;
    } else if (c === ',') {
      items.push(current);
      current = '';
    } else {
      current += c;
    }
  }
  if (current.trim() !== '') items.push(current);
  return items.map((i) => scalar(i, line));
}

function value(text, line) {
  const t = text.trim();
  if (t.startsWith('[')) return flowSequence(t, line);
  if (t.startsWith('{')) {
    if (t === '{}') return {};
    fail(line, 'a flow mapping is not supported');
  }
  return scalar(t, line);
}

function splitKey(text, line) {
  let i = 0;
  if (text[0] === '"' || text[0] === "'") {
    const q = text[0];
    i = 1;
    while (i < text.length && text[i] !== q) i += text[i] === '\\' && q === '"' ? 2 : 1;
    if (text[i] !== q || text[i + 1] !== ':') return undefined;
    return { key: scalar(text.slice(0, i + 1), line), rest: text.slice(i + 2) };
  }
  const m = /^([^\s:#][^:]*?):(?:\s+(.*))?$/.exec(text);
  return m ? { key: m[1].trim(), rest: m[2] ?? '' } : undefined;
}

/**
 * Parse the subset of YAML that dependabot.yml uses.
 * @param {string} text the file
 * @returns {any} the parsed value (objects, arrays, strings, integers, null)
 */
export function parseYaml(text) {
  const lines = [];
  String(text)
    .split('\n')
    .forEach((raw, index) => {
      const line = raw.replace(/\r$/, '');
      const body = stripComment(line);
      if (body.trim() === '' || /^(---|\.\.\.)\s*$/.test(body.trim())) return;
      const indent = /^ */.exec(body)[0].length;
      if (/^\s*\t/.test(body)) fail(index + 1, 'a tab in the indentation');
      lines.push({ indent, text: body.trim(), line: index + 1 });
    });
  let pos = 0;

  function block(indent) {
    const first = lines[pos];
    return first.text === '-' || first.text.startsWith('- ')
      ? sequence(first.indent)
      : mapping(indent ?? first.indent);
  }

  function nested(parentIndent, line) {
    const next = lines[pos];
    if (next && next.indent > parentIndent) return block(next.indent);
    // a sequence may sit at the indentation of its key
    if (next && next.indent === parentIndent && (next.text === '-' || next.text.startsWith('- '))) {
      return sequence(next.indent);
    }
    return null;
  }

  function sequence(indent) {
    const out = [];
    while (pos < lines.length && lines[pos].indent === indent) {
      const l = lines[pos];
      if (!(l.text === '-' || l.text.startsWith('- '))) break;
      const rest = l.text.slice(1).trimStart();
      if (rest === '') {
        pos++;
        out.push(nested(indent, l.line));
      } else if (splitKey(rest, l.line) && !rest.startsWith('[')) {
        // a mapping whose first key is on the line of the dash: its other keys line up with it
        const contentIndent = indent + (l.text.length - rest.length);
        lines[pos] = { indent: contentIndent, text: rest, line: l.line };
        out.push(mapping(contentIndent));
      } else {
        pos++;
        out.push(value(rest, l.line));
      }
    }
    return out;
  }

  function mapping(indent) {
    const out = {};
    while (pos < lines.length && lines[pos].indent === indent) {
      const l = lines[pos];
      if (l.text === '-' || l.text.startsWith('- ')) break;
      const kv = splitKey(l.text, l.line);
      if (!kv) fail(l.line, `cannot read "${l.text}" as a key`);
      if (Object.hasOwn(out, kv.key)) fail(l.line, `the key ${kv.key} appears twice`);
      pos++;
      out[kv.key] = kv.rest.trim() === '' ? nested(indent, l.line) : value(kv.rest, l.line);
    }
    if (pos < lines.length && lines[pos].indent > indent) {
      fail(lines[pos].line, 'unexpected indentation');
    }
    return out;
  }

  if (lines.length === 0) return null;
  const result = block(lines[0].indent);
  if (pos < lines.length) fail(lines[pos].line, 'unexpected content');
  return result;
}

/**
 * What the policy needs from a parsed dependabot.yml.
 * @param {any} config the parsed file
 * @returns {{patterns: string[], excludePatterns: string[], lockfile: string}} the patterns of the group `tooling` of
 *   the npm entry and the path of its lockfile in the repository
 * @throws {Error} when the file has no single npm entry with such a group: then nothing is armed
 */
export function toolingFromConfig(config) {
  const updates = config?.updates;
  if (!Array.isArray(updates)) throw new Error('dependabot.yml has no `updates` list');
  const npm = updates.filter((u) => u?.['package-ecosystem'] === 'npm');
  if (npm.length === 0) throw new Error('dependabot.yml has no npm entry');
  if (npm.length > 1) {
    throw new Error('dependabot.yml has more than one npm entry: not supported, nothing is armed');
  }
  const entry = npm[0];
  if (entry.directories !== undefined) {
    throw new Error('the npm entry uses `directories`: not supported, nothing is armed');
  }
  const group = entry.groups?.tooling;
  const patterns = group?.patterns;
  if (!Array.isArray(patterns) || patterns.length === 0 || patterns.some((p) => typeof p !== 'string')) {
    throw new Error('the npm entry of dependabot.yml has no group `tooling` with patterns: nothing is armed');
  }
  const excludePatterns = group['exclude-patterns'] ?? [];
  if (!Array.isArray(excludePatterns) || excludePatterns.some((p) => typeof p !== 'string')) {
    throw new Error('`exclude-patterns` of the group `tooling` is not a list of strings');
  }
  const directory = entry.directory === undefined ? '/' : entry.directory;
  if (typeof directory !== 'string' || !directory.startsWith('/') || directory.split('/').includes('..')) {
    throw new Error(`the directory of the npm entry is not usable: ${JSON.stringify(directory)}`);
  }
  const base = directory.replace(/^\/+|\/+$/g, '');
  return {
    patterns,
    excludePatterns,
    lockfile: base === '' ? 'package-lock.json' : `${base}/package-lock.json`,
  };
}

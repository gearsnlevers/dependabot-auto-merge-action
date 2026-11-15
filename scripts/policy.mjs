/*
 * The policy of core record 0023 as pure functions: no GitHub, no registry, no clock. Everything a decision needs is
 * passed in, so that every rule can be tested alone.
 *
 * The record: https://github.com/rockcarver/frodo-lib/blob/main/decisions/core/0023-dependency-updates-arrive-late-and-only-tooling-merges-without-a-person.md
 *
 * A Dependabot pull request may be armed for auto-merge only when ALL of this holds, and anything doubtful means that
 * it is not armed:
 *  - every commit of it is by Dependabot and the head commit carries the metadata that says what was updated;
 *  - it is an npm pull request (a GitHub Actions update is never armed, whatever its size);
 *  - every update is a patch or a minor update (the type comes from the metadata, or from the lockfile when the
 *    metadata has none, as for a security update);
 *  - no updated package has a name that stays manual (Prettier, TypeScript, ESLint and what belongs to them);
 *  - every update is in the Dependabot group `tooling` of dependabot.yml (a version update names its group; a
 *    security update has none, so its package must match the patterns of that group);
 *  - every package version that the lockfile adds or changes, direct or transitive, was published at least
 *    `minAgeDays` days ago (npm registry). A registry that cannot be read means: not armed.
 */

/** A published version must be at least this old (days) before a pull request that brings it is armed. */
export const MIN_AGE_DAYS = 7;

/** The Dependabot group of dependabot.yml whose pull requests may be armed. */
export const TOOLING_GROUP = 'tooling';

/** The only author that counts as Dependabot. */
export const DEPENDABOT_LOGIN = 'dependabot[bot]';

/** Names that stay manual: the whole word eslint, prettier or typescript in the scope or in the name. */
export const MANUAL_WORDS = ['eslint', 'prettier', 'typescript'];

const DAY_MS = 24 * 60 * 60 * 1000;

const PATCH = 'version-update:semver-patch';
const MINOR = 'version-update:semver-minor';

/**
 * Whether a package name stays manual: its scope or its name contains the whole word `eslint`, `prettier` or
 * `typescript` (words are separated by hyphens). `eslint-plugin-import-x`, `@typescript-eslint/parser`, `@eslint/js`,
 * `@types/eslint` and `@ianvs/prettier-plugin-sort-imports` are manual; `axios`, `rimraf`, `prettierx` and
 * `@types/node` are not.
 * @param {string} name package name, with its scope if it has one
 * @returns {boolean} true if the name stays manual
 */
export function isManualName(name) {
  return String(name)
    .toLowerCase()
    .split(/[/@-]+/)
    .some((word) => MANUAL_WORDS.includes(word));
}

function patternToRegExp(pattern) {
  const source = String(pattern)
    .split('*')
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*');
  return new RegExp(`^${source}$`);
}

/**
 * Whether a package name belongs to the tooling group: it matches a pattern and no excluded pattern (`*` is any run
 * of characters, as in dependabot.yml).
 * @param {string} name package name, with its scope if it has one
 * @param {string[]} patterns the `patterns` of the group
 * @param {string[]} [excludePatterns] the `exclude-patterns` of the group
 * @returns {boolean} true if the name is tooling
 */
export function isToolingName(name, patterns, excludePatterns = []) {
  const text = String(name);
  return (
    patterns.some((p) => patternToRegExp(p).test(text)) &&
    !excludePatterns.some((p) => patternToRegExp(p).test(text))
  );
}

function unquote(value) {
  const v = String(value).trim();
  return /^(["']).*\1$/.test(v) ? v.slice(1, -1) : v;
}

/**
 * The entries of the metadata block that Dependabot appends to its commit message:
 *
 *     ---
 *     updated-dependencies:
 *     - dependency-name: axios
 *       dependency-version: 1.21.1
 *       dependency-type: direct:development
 *       update-type: version-update:semver-patch
 *       dependency-group: tooling
 *     ...
 *
 * The block ends at the first line that is neither an entry nor a field of one (the closing `...`, a blank line
 * followed by text); anything after it is not read.
 * @param {string} message commit message
 * @returns {{name:string,version?:string,type?:string,updateType?:string,group?:string}[] | null} the entries, or
 *   null when the message has no such block or the block names no dependency
 */
export function parseUpdatedDependencies(message) {
  const lines = String(message ?? '').split('\n');
  const start = lines.findIndex((l) => l.trim() === 'updated-dependencies:');
  if (start === -1) return null;
  const entries = [];
  let current;
  for (const raw of lines.slice(start + 1)) {
    const line = raw.replace(/\r$/, '');
    const item = /^-\s+dependency-name:\s*(.+?)\s*$/.exec(line);
    if (item) {
      current = { name: unquote(item[1]) };
      entries.push(current);
      continue;
    }
    const field = /^\s+([a-z-]+):\s*(.*?)\s*$/.exec(line);
    if (field && current) {
      const value = unquote(field[2]);
      if (field[1] === 'dependency-version') current.version = value;
      else if (field[1] === 'dependency-type') current.type = value;
      else if (field[1] === 'update-type') current.updateType = value;
      else if (field[1] === 'dependency-group') current.group = value;
      continue;
    }
    // anything else that is neither an entry nor a field of one ends the block: the closing `...` is such a line,
    // and so is whatever follows it
    if (line.trim() !== '') break;
  }
  return entries.length > 0 ? entries : null;
}

/**
 * The package name of a `packages` key of a lockfile: what follows the last `node_modules/`.
 * @param {string} lockPath key such as `node_modules/a/node_modules/@s/b`
 * @returns {string} the name, `''` for the root entry or a workspace path
 */
export function lockEntryName(lockPath) {
  const marker = 'node_modules/';
  const at = String(lockPath).lastIndexOf(marker);
  return at === -1 ? '' : lockPath.slice(at + marker.length);
}

/**
 * The package versions that the head lockfile adds or changes compared with the base lockfile (direct and
 * transitive). A removed entry is not listed; a `link` entry, an entry without a version and the root entry are
 * skipped.
 * @param {{packages?: Record<string, {version?: string, link?: boolean}>}} baseLock lockfile of the merge base
 * @param {{packages?: Record<string, {version?: string, link?: boolean}>}} headLock lockfile of the head
 * @returns {{path:string,name:string,version:string,from?:string}[]} the added or changed versions, sorted by path
 *   (`from`: the base version of a changed entry)
 */
export function lockChanges(baseLock, headLock) {
  const base = baseLock?.packages ?? {};
  const head = headLock?.packages ?? {};
  const changes = [];
  for (const [path, entry] of Object.entries(head)) {
    const name = lockEntryName(path);
    if (!name || !entry || entry.link || typeof entry.version !== 'string') {
      continue;
    }
    if (base[path]?.version === entry.version) continue;
    changes.push({ path, name, version: entry.version, from: base[path]?.version });
  }
  return changes.sort((a, b) => a.path.localeCompare(b.path));
}

/**
 * The kind of change between two versions, as Dependabot names it.
 * @param {string | undefined} from the old version
 * @param {string} to the new version
 * @returns {'major' | 'minor' | 'patch' | 'unknown'} `unknown` for a missing old version, a prerelease or anything
 *   that is not a plain semantic version
 */
export function semverBump(from, to) {
  const parse = (v) => /^(\d+)\.(\d+)\.(\d+)$/.exec(String(v ?? ''));
  const a = parse(from);
  const b = parse(to);
  if (!a || !b) return 'unknown';
  if (a[1] !== b[1]) return 'major';
  if (a[2] !== b[2]) return 'minor';
  return a[3] !== b[3] ? 'patch' : 'unknown';
}

/**
 * The update type of a dependency whose metadata has none (a security update and an indirect dependency have none):
 * the widest change of the lockfile entries of that name.
 * @param {string} name the dependency
 * @param {{name:string,version:string,from?:string}[] | undefined} changes the lockfile difference
 * @returns {string | undefined} `version-update:semver-major`, `-minor` or `-patch`; undefined when the lockfile has
 *   no changed entry of that name or one of them cannot be compared (a new entry, a prerelease)
 */
export function derivedUpdateType(name, changes) {
  const bumps = (changes ?? [])
    .filter((c) => c.name === name)
    .map((c) => semverBump(c.from, c.version));
  if (bumps.length === 0 || bumps.includes('unknown')) return undefined;
  const widest = ['major', 'minor', 'patch'].find((b) => bumps.includes(b));
  return `version-update:semver-${widest}`;
}

/**
 * The Dependabot ecosystem of a pull request, from its branch name `dependabot/<ecosystem>/...`.
 * @param {string} ref branch name
 * @returns {string} for example `npm_and_yarn` or `github_actions`; `unknown` for a branch that is not Dependabot's
 */
export function ecosystemOfBranch(ref) {
  const m = /^dependabot\/([^/]+)\//.exec(String(ref));
  return m ? m[1] : 'unknown';
}

/**
 * The registry address of a package document (a scoped name needs its slash encoded).
 * @param {string} name package name
 * @returns {string} url
 */
export function registryUrl(name) {
  return `https://registry.npmjs.org/${String(name).replace('/', '%2f')}`;
}

/**
 * The publish time of one version in a registry package document.
 * @param {{time?: Record<string, string>} | undefined} packument the document
 * @param {string} version version
 * @returns {number | undefined} milliseconds since the epoch; undefined if unknown or unparsable
 */
export function publishTimeOf(packument, version) {
  const text = packument?.time?.[version];
  const ms = typeof text === 'string' ? Date.parse(text) : NaN;
  return Number.isFinite(ms) ? ms : undefined;
}

/**
 * Whether an update belongs to the group that may arm. A version update names its group; a security update has none,
 * so it belongs when its package is in the group by its name.
 * @param {{name:string,group?:string}} update the `updated-dependencies` entry
 * @param {{patterns: string[], excludePatterns?: string[]}} tooling the patterns of the group
 * @returns {boolean} true if it belongs to the group
 */
export function belongsToTooling(update, tooling) {
  return update.group === undefined
    ? isToolingName(update.name, tooling.patterns, tooling.excludePatterns)
    : update.group === TOOLING_GROUP;
}

/**
 * The reasons why a pull request is never armed, however old its versions are: what a later look cannot change.
 * Every reason is listed, not only the first.
 * @param {object} input what is known about the pull request
 * @param {{name:string,updateType?:string,group?:string}[] | null} input.updates the `updated-dependencies` entries,
 *   with the update type filled in where the lockfile says it
 * @param {string[]} input.commitAuthors login of the author of each commit of the pull request
 * @param {string} input.ecosystem the ecosystem of the pull request (`ecosystemOfBranch`)
 * @param {boolean} [input.hasActionsLabel] true if the pull request carries the label `github_actions`
 * @param {{patterns: string[], excludePatterns?: string[]}} input.tooling the patterns of the tooling group
 * @param {boolean} [input.deferMissingTypes] true to leave an update without a stated type out of the type test (the
 *   caller will read it from the lockfile and test again), so that what is refused anyway needs no lockfile
 * @returns {string[]} the reasons, empty when none applies
 */
export function permanentRefusals({
  updates,
  commitAuthors,
  ecosystem,
  hasActionsLabel = false,
  tooling,
  deferMissingTypes = false,
}) {
  const reasons = [];
  const others = (commitAuthors ?? []).filter((a) => a !== DEPENDABOT_LOGIN);
  if (!commitAuthors?.length || others.length > 0) {
    reasons.push(
      `commits not made by Dependabot: ${others.map((a) => a || '(unknown)').join(', ') || 'none found'}`
    );
  }
  if (!updates || updates.length === 0) {
    // without the metadata nothing can be said about what is updated
    reasons.push('no Dependabot metadata (updated-dependencies) in the head commit message');
    return reasons;
  }
  if (ecosystem === 'github_actions' || hasActionsLabel) {
    // never armed, whatever the update type: an action runs with the credentials of our workflows
    reasons.push('GitHub Actions update: a person merges it');
  } else if (ecosystem !== 'npm_and_yarn' && ecosystem !== 'npm') {
    reasons.push(`the ecosystem ${ecosystem} is never armed: a person merges it`);
  }
  for (const u of updates) {
    const typeStated = u.updateType !== undefined || !deferMissingTypes;
    if (typeStated && u.updateType !== PATCH && u.updateType !== MINOR) {
      reasons.push(
        `${u.name}: ${u.updateType ?? 'unknown update type'} is not a patch or minor update`
      );
    }
    if (isManualName(u.name)) {
      reasons.push(`${u.name}: belongs to the manual set (eslint, prettier or typescript)`);
    }
    if (!belongsToTooling(u, tooling)) {
      reasons.push(
        `${u.name}: not in the ${TOOLING_GROUP} group (${u.group ?? 'no group'}): a bundled package, a GitHub Action or a package that is not listed, a person merges it`
      );
    }
  }
  return reasons;
}

/**
 * The age test: which of the changed versions are younger than `minAgeDays` or have no publish time.
 * @param {{name:string,version:string}[]} changes versions added or changed by the pull request
 * @param {Record<string, number | undefined>} times publish time in milliseconds per `name@version`
 * @param {Record<string, string>} errors why a version could not be read, per `name@version`
 * @param {number} now milliseconds since the epoch of the moment that counts
 * @param {number} minAgeDays minimum age in days
 * @returns {string[]} one reason per failing version (each version once); empty when all pass
 */
export function ageReasons(changes, times, errors, now, minAgeDays) {
  const reasons = [];
  const seen = new Set();
  for (const c of changes) {
    const key = `${c.name}@${c.version}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (errors[key]) {
      reasons.push(`${key}: the registry could not be read (${errors[key]})`);
    } else if (times[key] === undefined) {
      reasons.push(`${key}: publish time unknown`);
    } else if (now - times[key] < minAgeDays * DAY_MS) {
      const days = Math.floor(((now - times[key]) / DAY_MS) * 10) / 10;
      reasons.push(`${key}: ${days} days old, less than ${minAgeDays}`);
    }
  }
  return reasons;
}

/**
 * The decision for one pull request. Pure: everything it needs is passed in.
 * @param {object} input what is known about the pull request
 * @param {{name:string,updateType?:string,group?:string}[] | null} input.updates `updated-dependencies` entries
 * @param {string[]} input.commitAuthors login of the author of each commit
 * @param {string} input.ecosystem ecosystem of the pull request
 * @param {boolean} [input.hasActionsLabel] true if the pull request carries the label `github_actions`
 * @param {{patterns: string[], excludePatterns?: string[]}} input.tooling the patterns of the tooling group
 * @param {{name:string,version:string}[] | undefined} input.changes lockfile versions added or changed; undefined when
 *   the lockfile could not be read
 * @param {Record<string, number | undefined>} input.times publish time per `name@version`
 * @param {Record<string, string>} [input.errors] why a version could not be read, per `name@version`
 * @param {number} input.now milliseconds since the epoch
 * @param {number} [input.minAgeDays] minimum age in days
 * @returns {{arm:boolean,retryLater:boolean,reasons:string[]}} the verdict; `retryLater` is true when what fails is
 *   only the age of a version or a read that may succeed later, so that a later look can pass
 */
export function decide({
  updates,
  commitAuthors,
  ecosystem,
  hasActionsLabel = false,
  tooling,
  changes,
  times,
  errors = {},
  now,
  minAgeDays = MIN_AGE_DAYS,
}) {
  const refusals = permanentRefusals({
    updates,
    commitAuthors,
    ecosystem,
    hasActionsLabel,
    tooling,
  });
  if (refusals.length > 0) {
    return { arm: false, retryLater: false, reasons: refusals };
  }
  if (!changes) {
    return {
      arm: false,
      retryLater: true,
      reasons: ['the lockfile difference could not be read'],
    };
  }
  if (changes.length === 0) {
    return {
      arm: false,
      retryLater: false,
      reasons: ['no change of package-lock.json found'],
    };
  }
  const reasons = ageReasons(changes, times, errors, now, minAgeDays);
  if (reasons.length > 0) return { arm: false, retryLater: true, reasons };
  const versions = new Set(changes.map((c) => `${c.name}@${c.version}`)).size;
  return {
    arm: true,
    retryLater: false,
    reasons: [`${versions} lockfile versions, all at least ${minAgeDays} days old`],
  };
}

#!/usr/bin/env node
/*
 * Records one real Dependabot pull request as a corpus file (see docs/corpus.md): the pull request, its commits, the
 * entries of the lockfile that differ, the publish time of every changed version, and the tooling patterns of the
 * repository. Public data only. The file is then replayed through the real `evaluate`, and the verdict is printed for
 * a person to read; the file gets its `expected` verdict by hand, never from the recorder.
 *
 *   node scripts/record-corpus.mjs --repo <owner/name> --pr <number> [--tooling-config <file>] [--out <dir>]
 *
 * Needs `gh` (GH_TOKEN) and the npm registry.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { fetchJsonDefault, ghDefault } from './dependabot-auto-merge.mjs';
import { parseYaml, toolingFromConfig } from './dependabot-yml.mjs';
import { evaluate } from './evaluate.mjs';
import { lockChanges, registryUrl } from './policy.mjs';

function option(argv, name) {
  const i = argv.indexOf(name);
  return i === -1 ? undefined : argv[i + 1];
}

/** The lockfile reduced to the entries at `paths` and the root entry. */
function slim(lockfile, paths) {
  const packages = { '': {} };
  for (const path of paths) {
    const entry = lockfile.packages?.[path];
    if (entry && typeof entry.version === 'string') packages[path] = { version: entry.version };
  }
  return { packages };
}

export async function record({ repo, number, toolingConfig, gh = ghDefault, fetchJson = fetchJsonDefault }) {
  const pr = JSON.parse(await gh(['api', `repos/${repo}/pulls/${number}`]));
  const commitsRaw = JSON.parse(await gh(['api', '--paginate', '--slurp', `repos/${repo}/pulls/${number}/commits`])).flat();
  const mergeBase = (
    await gh(['api', `repos/${repo}/compare/${pr.base.sha}...${pr.head.sha}`, '--jq', '.merge_base_commit.sha'])
  ).trim();
  let tooling;
  if (toolingConfig) {
    tooling = toolingFromConfig(parseYaml(readFileSync(toolingConfig, 'utf8')));
  } else {
    const branch = (await gh(['api', `repos/${repo}`, '--jq', '.default_branch'])).trim();
    const text = await gh([
      'api',
      '-H',
      'Accept: application/vnd.github.raw',
      `repos/${repo}/contents/.github/dependabot.yml?ref=${encodeURIComponent(branch)}`,
    ]);
    tooling = toolingFromConfig(parseYaml(text));
  }
  const raw = async (ref) =>
    JSON.parse(
      await gh(['api', '-H', 'Accept: application/vnd.github.raw', `repos/${repo}/contents/${tooling.lockfile}?ref=${ref}`])
    );
  let baseLock = { packages: {} };
  let headLock = { packages: {} };
  let changes = [];
  const isNpm = /^dependabot\/(npm_and_yarn|npm)\//.test(pr.head.ref);
  if (isNpm) {
    [baseLock, headLock] = await Promise.all([raw(mergeBase), raw(pr.head.sha)]);
    changes = lockChanges(baseLock, headLock);
  }
  const paths = changes.map((c) => c.path);
  const registry = {};
  for (const name of new Set(changes.map((c) => c.name))) {
    const doc = await fetchJson(registryUrl(name));
    registry[name] = {};
    for (const c of changes.filter((x) => x.name === name)) {
      if (typeof doc.time?.[c.version] === 'string') registry[name][c.version] = doc.time[c.version];
    }
  }
  const fixture = {
    repo,
    number,
    asOf: pr.created_at,
    pr: {
      number,
      title: pr.title,
      state: pr.state,
      user: { login: pr.user?.login },
      head: { ref: pr.head.ref, sha: pr.head.sha },
      base: { ref: pr.base.ref, sha: pr.base.sha },
      labels: (pr.labels ?? []).map((l) => ({ name: l.name })),
      auto_merge: pr.auto_merge ? { merge_method: pr.auto_merge.merge_method } : null,
    },
    // a commit by a person is recorded as one, without the login or the message: the policy only needs to know that it
    // is not Dependabot's
    commits: commitsRaw.map((c) =>
      c.author?.login === 'dependabot[bot]'
        ? { author: { login: 'dependabot[bot]' }, commit: { message: c.commit?.message ?? '' } }
        : { author: { login: c.author?.login ? 'a-person' : '' }, commit: { message: '(a commit by a person: not recorded)' } }
    ),
    mergeBase,
    baseLock: slim(baseLock, paths),
    headLock: slim(headLock, paths),
    registry,
    tooling,
    expectations: [],
    why: '',
  };
  return fixture;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2);
  const repo = option(argv, '--repo');
  const number = Number(option(argv, '--pr'));
  const out = option(argv, '--out') ?? new URL('../test/corpus/', import.meta.url).pathname;
  if (!repo || !Number.isInteger(number)) {
    console.error('usage: record-corpus.mjs --repo <owner/name> --pr <number> [--tooling-config <file>] [--out <dir>]');
    process.exit(2);
  }
  const fixture = await record({ repo, number, toolingConfig: option(argv, '--tooling-config') });
  mkdirSync(out, { recursive: true });
  const file = `${out.replace(/\/$/, '')}/${repo.replace('/', '-')}-${number}.json`;
  writeFileSync(file, JSON.stringify(fixture, null, 2) + '\n');
  // replay what was just written, so that what is printed is what the test will see
  const { replay } = await import('../test/corpus-replay.mjs');
  const result = await replay(fixture, new Date(fixture.asOf).getTime());
  console.log(`${file}\n#${number} ${fixture.pr.title}\n  arm=${result.verdict.arm} retryLater=${result.verdict.retryLater}`);
  for (const reason of result.verdict.reasons.slice(0, 6)) console.log(`    ${reason}`);
}

/*
 * What the tests share: a clock, Dependabot commit messages, and fakes for `gh` and the registry, so that every test
 * runs offline. Names and versions are real names of packages of the two repositories that use the action; the dates
 * are made up unless a test says otherwise.
 */
export const DAY = 24 * 60 * 60 * 1000;
export const NOW = Date.parse('2026-11-14T12:00:00Z');
export const ago = (days) => NOW - days * DAY;
export const agoIso = (days) => new Date(ago(days)).toISOString();

export const TOOLING = {
  patterns: ['@types/*', 'jest', 'rimraf', 'ts-jest', 'winston'],
  excludePatterns: [],
  lockfile: 'package-lock.json',
};

export const PATCH = 'version-update:semver-patch';
export const MINOR = 'version-update:semver-minor';
export const MAJOR = 'version-update:semver-major';

/** A dependency as `parseUpdatedDependencies` returns it; `group` null means a pull request without a group. */
export const dep = (name, updateType = PATCH, group = 'tooling') => ({
  name,
  updateType,
  ...(group === null ? {} : { group }),
});

/** The commit message that Dependabot writes, with the metadata block. */
export function commitMessage(deps, title = 'build(deps-dev): bump the tooling group with updates') {
  const lines = [title, '', 'Bumps the group.', '', '---', 'updated-dependencies:'];
  for (const d of deps) {
    lines.push(`- dependency-name: ${d.name.startsWith('@') ? `"${d.name}"` : d.name}`);
    if (d.version) lines.push(`  dependency-version: ${d.version}`);
    lines.push('  dependency-type: direct:development');
    if (d.updateType) lines.push(`  update-type: ${d.updateType}`);
    if (d.group) lines.push(`  dependency-group: ${d.group}`);
  }
  lines.push('...', '', 'Signed-off-by: dependabot[bot] <support@github.com>');
  return lines.join('\n');
}

export const lock = (entries) => ({ packages: { '': { name: 'x' }, ...entries } });
export const entry = (version) => ({ version });

export const SHA = (c) => c.repeat(40);

/**
 * A fake `gh`. It answers the calls of the action from the data of a pull request; any call it does not know is an
 * error, so that a test notices a new request. `calls` records every call.
 */
export function makeGh(options = {}) {
  const {
    repo = 'acme/widgets',
    defaultBranch = 'main',
    config = null,
    pr = {},
    commits,
    mergeBase = SHA('b'),
    baseLock = lock({ 'node_modules/rimraf': entry('6.1.3') }),
    headLock = lock({ 'node_modules/rimraf': entry('6.1.4') }),
    lockError = false,
    open = [],
    mergeError,
  } = options;
  const calls = [];
  const pullRequest = {
    number: 7,
    title: 'build(deps-dev): bump rimraf from 6.1.3 to 6.1.4',
    state: 'open',
    user: { login: 'dependabot[bot]' },
    head: { ref: 'dependabot/npm_and_yarn/tooling-abc', sha: SHA('a') },
    base: { sha: SHA('c'), ref: 'main' },
    labels: [{ name: 'dependencies' }],
    auto_merge: null,
    ...pr,
  };
  const theCommits = commits ?? [
    {
      author: { login: 'dependabot[bot]' },
      commit: {
        message: commitMessage([{ name: 'rimraf', version: '6.1.4', updateType: PATCH, group: 'tooling' }]),
      },
    },
  ];
  const gh = async (args) => {
    calls.push(args);
    const line = args.join(' ');
    if (line === `api repos/${repo} --jq .default_branch`) return `${defaultBranch}\n`;
    if (line.startsWith(`api -H Accept: application/vnd.github.raw repos/${repo}/contents/`)) {
      const [, path, ref] = /contents\/(.+)\?ref=(.+)$/.exec(args[3]);
      if (path.endsWith('dependabot.yml')) {
        if (config === null) throw new Error('HTTP 404');
        return config;
      }
      if (lockError) throw new Error('HTTP 404');
      if (decodeURIComponent(ref) === mergeBase) return JSON.stringify(baseLock);
      if (decodeURIComponent(ref) === pullRequest.head.sha) return JSON.stringify(headLock);
      throw new Error(`unexpected ref ${ref}`);
    }
    if (line === `api repos/${repo}/pulls/${pullRequest.number}`) return JSON.stringify(pullRequest);
    if (line === `api --paginate --slurp repos/${repo}/pulls/${pullRequest.number}/commits`) {
      return JSON.stringify([theCommits]);
    }
    if (line.startsWith(`api repos/${repo}/compare/`) && line.endsWith('--jq .merge_base_commit.sha')) {
      return `${mergeBase}\n`;
    }
    if (line.startsWith(`pr list -R ${repo} --author app/dependabot --state open`)) {
      return JSON.stringify(open.map((number) => ({ number })));
    }
    if (line.startsWith(`pr merge ${pullRequest.number} -R ${repo} --auto --squash`)) {
      if (mergeError) throw new Error(mergeError);
      return '';
    }
    throw new Error(`unexpected gh call: ${line}`);
  };
  gh.calls = calls;
  gh.merges = () => calls.filter((c) => c[0] === 'pr' && c[1] === 'merge');
  return gh;
}

/** A fake registry: package name (as in the URL) to `{ version: iso time }`, or an Error to throw. */
export function makeFetchJson(docs) {
  const asked = [];
  const fetchJson = async (url) => {
    asked.push(url);
    const name = decodeURIComponent(url.replace('https://registry.npmjs.org/', ''));
    const doc = docs[name];
    if (doc instanceof Error) throw doc;
    if (doc === undefined) throw new Error('HTTP 404');
    return { time: doc };
  };
  fetchJson.asked = asked;
  return fetchJson;
}

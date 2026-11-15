import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseArguments, run } from '../scripts/dependabot-auto-merge.mjs';
import { MAJOR, NOW, PATCH, SHA, agoIso, commitMessage, entry, lock, makeFetchJson, makeGh } from './support.mjs';

const CONFIG = [
  'version: 2',
  'updates:',
  '  - package-ecosystem: "npm"',
  '    directory: "/"',
  '    groups:',
  '      tooling:',
  '        patterns:',
  '          - "@types/*"',
  '          - "jest"',
  '          - "rimraf"',
].join('\n');

const REGISTRY = { rimraf: { '6.1.4': agoIso(10) } };

async function go(argv, ghOptions = {}, extra = {}) {
  const gh = makeGh({ config: CONFIG, open: [7], ...ghOptions });
  const lines = [];
  const files = {};
  const code = await run({
    argv: ['--repo', 'acme/widgets', ...argv],
    env: { GITHUB_OUTPUT: 'out', GITHUB_STEP_SUMMARY: 'summary' },
    gh,
    fetchJson: makeFetchJson(extra.registry ?? REGISTRY),
    log: (line) => lines.push(line),
    append: (file, text) => (files[file] = (files[file] ?? '') + text),
  });
  return { code, lines, files, gh };
}

describe('run: one pull request', () => {
  it('arms a tooling pull request with `gh pr merge --auto --squash` and says so', async () => {
    const { code, lines, gh } = await go(['--pr', '7', '--as-of', new Date(NOW).toISOString()]);
    assert.equal(code, 0);
    assert.deepEqual(gh.merges(), [['pr', 'merge', '7', '-R', 'acme/widgets', '--auto', '--squash']]);
    assert.match(lines[0], /^#7 ARMED: build\(deps-dev\): bump rimraf from 6\.1\.3 to 6\.1\.4$/);
    assert.match(lines[1], /^ {4}1 lockfile versions, all at least 7 days old$/);
  });
  it('arms nothing in a dry run', async () => {
    const { code, lines, gh } = await go(['--pr', '7', '--dry-run', '--as-of', new Date(NOW).toISOString()]);
    assert.equal(code, 0);
    assert.deepEqual(gh.merges(), []);
    assert.match(lines[0], /^#7 WOULD ARM:/);
  });
  it('does not arm a pull request that is armed already', async () => {
    const { lines, gh } = await go(['--pr', '7', '--as-of', new Date(NOW).toISOString()], { pr: { auto_merge: { merge_method: 'squash' } } });
    assert.deepEqual(gh.merges(), []);
    assert.match(lines[0], /^#7 ALREADY ARMED:/);
  });
  it('leaves a bundled package to a person and exits 0: a decision is not a failure', async () => {
    const gh = { commits: [{ author: { login: 'dependabot[bot]' }, commit: { message: commitMessage([{ name: 'axios', updateType: PATCH }]) } }] };
    const { code, lines, gh: used } = await go(['--pr', '7'], gh);
    assert.equal(code, 0);
    assert.deepEqual(used.merges(), []);
    assert.match(lines[0], /^#7 SKIPPED, A PERSON MERGES IT:/);
  });
  it('says when it will look again, for what only the age or a read holds back', async () => {
    const { code, lines, gh } = await go(['--pr', '7', '--as-of', new Date(NOW - 8 * 86400000).toISOString()]);
    assert.equal(code, 0);
    assert.deepEqual(gh.merges(), []);
    assert.match(lines[0], /^#7 SKIPPED, LOOK AGAIN LATER:/);
    assert.match(lines[1], /rimraf@6\.1\.4: 2 days old, less than 7/);
  });
  it('honours --min-age-days', async () => {
    const asOf = new Date(NOW - 8 * 86400000).toISOString();
    assert.equal((await go(['--pr', '7', '--as-of', asOf, '--min-age-days', '1'])).gh.merges().length, 1);
    assert.equal((await go(['--pr', '7', '--as-of', asOf, '--min-age-days', '30'])).gh.merges().length, 0);
  });
});

describe('run: the sweep', () => {
  it('looks at every open Dependabot pull request, and a failure of one does not stop the others', async () => {
    const { code, lines, gh } = await go(['--all', '--as-of', new Date(NOW).toISOString()], { open: [8, 7] });
    assert.equal(code, 1, 'a pull request that could not be looked at is a failure');
    assert.match(lines[0], /^#8 FAILED: /);
    assert.deepEqual(gh.merges(), [['pr', 'merge', '7', '-R', 'acme/widgets', '--auto', '--squash']]);
  });
  it('says so when there is none', async () => {
    const { code, lines } = await go(['--all'], { open: [] });
    assert.equal(code, 0);
    assert.deepEqual(lines, ['No open Dependabot pull request.']);
  });
});

describe('run: the policy is read from the default branch, and an unreadable policy arms nothing', () => {
  it('reads dependabot.yml at the default branch of the repository, whatever its name', async () => {
    const { gh } = await go(['--pr', '7'], { defaultBranch: 'trunk' });
    const read = gh.calls.find((c) => c[3]?.includes('dependabot.yml'));
    assert.equal(read[3], 'repos/acme/widgets/contents/.github/dependabot.yml?ref=trunk');
    assert.ok(gh.calls.findIndex((c) => c === read) < gh.calls.findIndex((c) => c[1]?.includes('/pulls/')), 'before any pull request');
  });
  it('reads the file named by --config', async () => {
    const { gh } = await go(['--pr', '7', '--config', 'ci/dependabot.yml']);
    assert.ok(gh.calls.some((c) => c[3] === 'repos/acme/widgets/contents/ci/dependabot.yml?ref=main'));
  });
  for (const [label, ghOptions] of [
    ['a missing file', { config: null }],
    ['a file without the group', { config: 'version: 2\nupdates:\n  - package-ecosystem: "npm"\n    directory: "/"\n' }],
    ['a file that cannot be parsed', { config: 'a: &anchor 1\n' }],
    ['a default branch with a strange name', { defaultBranch: 'a b' }],
  ]) {
    it(`${label}: exit 1, a clear line, nothing looked at, nothing armed`, async () => {
      const { code, lines, gh } = await go(['--pr', '7'], ghOptions);
      assert.equal(code, 1);
      assert.match(lines[0], /^The policy cannot be read, so nothing is armed: /);
      assert.deepEqual(gh.merges(), []);
      assert.equal(gh.calls.some((c) => c[1]?.includes('/pulls/')), false);
    });
  }
});

describe('run: failures', () => {
  it('an arming that fails is an exit code 1 and is said', async () => {
    const { code, lines } = await go(['--pr', '7', '--as-of', new Date(NOW).toISOString()], { mergeError: 'GraphQL: Pull request is in clean status' });
    assert.equal(code, 1);
    assert.match(lines[0], /^#7 FAILED TO ARM:/);
    assert.match(lines.join('\n'), /Pull request is in clean status/);
  });
});

describe('run: outputs, summary and log lines', () => {
  it('writes the verdicts as one line of JSON and the armed numbers', async () => {
    const { files } = await go(['--pr', '7', '--as-of', new Date(NOW).toISOString()]);
    const [verdicts, armed] = files.out.trimEnd().split('\n');
    assert.match(verdicts, /^verdicts=\[/);
    const parsed = JSON.parse(verdicts.slice('verdicts='.length));
    assert.equal(parsed.length, 1);
    assert.deepEqual(Object.keys(parsed[0]).sort(), ['action', 'alreadyArmed', 'arm', 'number', 'reasons', 'retryLater', 'title']);
    assert.equal(parsed[0].action, 'armed');
    assert.equal(armed, 'armed=7');
    assert.equal(files.out.trimEnd().split('\n').length, 2);
  });
  it('a pull request that is armed already is in `armed` as well', async () => {
    const { files } = await go(['--pr', '7', '--as-of', new Date(NOW).toISOString()], { pr: { auto_merge: { merge_method: 'squash' } } });
    assert.match(files.out, /\narmed=7\n$/);
    assert.equal(JSON.parse(files.out.split('\n')[0].slice('verdicts='.length))[0].action, 'already armed');
  });
  it('a pull request that is not armed is not in `armed`', async () => {
    const { files } = await go(['--pr', '7'], { commits: [{ author: { login: 'dependabot[bot]' }, commit: { message: 'no metadata' } }] });
    assert.match(files.out, /\narmed=\n$/);
  });
  it('a title cannot inject a workflow command, a line or a table cell', async () => {
    const title = 'bump x\n::set-output name=pwned::1\n| a | b |`c`';
    const { lines, files } = await go(['--pr', '7', '--dry-run', '--as-of', new Date(NOW).toISOString()], { pr: { title } });
    for (const line of lines) assert.match(line, /^(#\d+ |\s{4}|No open|The policy)/, line);
    assert.ok(lines.every((l) => !l.includes('\n')));
    const rows = files.summary.trimEnd().split('\n');
    assert.equal(rows.length, 3);
    assert.equal(rows[2].split('|').length, 6, 'one row of four cells');
    assert.equal(JSON.parse(files.out.split('\n')[0].slice('verdicts='.length))[0].title.includes('\n'), false);
  });
  it('writes nothing to GITHUB_OUTPUT outside Actions', async () => {
    const files = {};
    await run({
      argv: ['--repo', 'acme/widgets', '--pr', '7', '--dry-run'],
      env: {},
      gh: makeGh({ config: CONFIG }),
      fetchJson: makeFetchJson(REGISTRY),
      log: () => {},
      append: (f, t) => (files[f] = t),
    });
    assert.deepEqual(files, {});
  });
});

describe('parseArguments: the command line', () => {
  const ok = parseArguments(['--repo', 'a/b', '--pr', '12', '--dry-run', '--ignore-state', '--min-age-days', '3', '--as-of', '2026-11-01T00:00:00Z', '--config', 'x/y.yml']);
  it('reads the options', () => {
    assert.deepEqual(ok, { repo: 'a/b', pr: 12, all: false, config: 'x/y.yml', minAgeDays: 3, now: Date.parse('2026-11-01T00:00:00Z'), dryRun: true, ignoreState: true });
  });
  it('takes the repository from GITHUB_REPOSITORY and the defaults for the rest', () => {
    const o = parseArguments(['--all'], { GITHUB_REPOSITORY: 'o/n' });
    assert.deepEqual([o.repo, o.all, o.pr, o.config, o.minAgeDays, o.dryRun], ['o/n', true, undefined, '.github/dependabot.yml', 7, false]);
  });
  for (const [label, argv] of [
    ['no repository', ['--pr', '1']],
    ['a repository that is not owner/name', ['--repo', 'x', '--pr', '1']],
    ['a repository with something in it', ['--repo', 'a/b;c', '--pr', '1']],
    ['neither --pr nor --all', ['--repo', 'a/b']],
    ['both --pr and --all', ['--repo', 'a/b', '--pr', '1', '--all']],
    ['a pull request that is not a number', ['--repo', 'a/b', '--pr', 'x']],
    ['pull request 0', ['--repo', 'a/b', '--pr', '0']],
    ['a decimal pull request', ['--repo', 'a/b', '--pr', '1.5']],
    ['a config path that climbs', ['--repo', 'a/b', '--pr', '1', '--config', '../x.yml']],
    ['an absolute config path', ['--repo', 'a/b', '--pr', '1', '--config', '/etc/x']],
    ['a config path with a query', ['--repo', 'a/b', '--pr', '1', '--config', 'x.yml?ref=evil']],
    ['a negative minimum age', ['--repo', 'a/b', '--pr', '1', '--min-age-days', '-1']],
    ['a minimum age that is not a number', ['--repo', 'a/b', '--pr', '1', '--min-age-days', 'x']],
    ['a date that is not one', ['--repo', 'a/b', '--pr', '1', '--as-of', 'yesterday']],
    ['--ignore-state without --dry-run', ['--repo', 'a/b', '--pr', '1', '--ignore-state']],
  ]) {
    it(`refuses ${label}`, () => assert.throws(() => parseArguments(argv), /usage:/));
  }
  it('run answers a wrong command line with exit code 2 and the usage', async () => {
    const lines = [];
    const code = await run({ argv: ['--pr', '1'], env: {}, gh: async () => assert.fail('no call'), log: (l) => lines.push(l) });
    assert.equal(code, 2);
    assert.match(lines[0], /^usage:/);
  });
});

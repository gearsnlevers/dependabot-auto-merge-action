import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { evaluate, fetchPublishTimes } from '../scripts/evaluate.mjs';
import {
  MAJOR,
  MINOR,
  NOW,
  PATCH,
  SHA,
  TOOLING,
  agoIso,
  commitMessage,
  entry,
  lock,
  makeFetchJson,
  makeGh,
} from './support.mjs';

const base = (gh, fetchJson, over = {}) => ({
  repo: 'acme/widgets',
  number: 7,
  gh,
  fetchJson,
  now: NOW,
  tooling: TOOLING,
  ...over,
});
/** The registry time of rimraf 6.1.4, `days` old. */
const old = (days = 10) => ({ '6.1.4': agoIso(days) });
const dependabot = (message) => [{ author: { login: 'dependabot[bot]' }, commit: { message } }];
const touchedLockfile = (gh) => gh.calls.some((c) => c.join(' ').includes('/contents/package-lock.json') || c.includes('--jq'));

describe('evaluate: a pull request, with GitHub and the registry replaced', () => {
  it('arms a tooling pull request whose versions are all old', async () => {
    const gh = makeGh();
    const fetchJson = makeFetchJson({ rimraf: old(10) });
    const r = await evaluate(base(gh, fetchJson));
    assert.equal(r.number, 7);
    assert.equal(r.verdict.arm, true);
    assert.equal(r.checked, 1);
    assert.equal(r.alreadyArmed, false);
    assert.deepEqual(gh.merges(), [], 'evaluate decides and never arms');
  });
  it('refuses when one transitive version is young, names it, and reads each registry document once', async () => {
    const gh = makeGh({
      headLock: lock({
        'node_modules/rimraf': entry('6.1.4'),
        'node_modules/rimraf/node_modules/glob': entry('14.0.5'),
        'node_modules/glob': entry('14.0.5'),
      }),
    });
    const fetchJson = makeFetchJson({
      rimraf: { '6.1.4': agoIso(11) },
      glob: { '14.0.5': agoIso(3.2) },
    });
    const r = await evaluate(base(gh, fetchJson));
    assert.deepEqual(r.verdict, { arm: false, retryLater: true, reasons: ['glob@14.0.5: 3.2 days old, less than 7'] });
    assert.deepEqual(fetchJson.asked.sort(), ['https://registry.npmjs.org/glob', 'https://registry.npmjs.org/rimraf']);
  });
  it('refuses, for a later look, when the registry cannot be read', async () => {
    const r = await evaluate(base(makeGh(), makeFetchJson({ rimraf: new Error('HTTP 503') })));
    assert.equal(r.verdict.arm, false);
    assert.equal(r.verdict.retryLater, true);
    assert.match(r.verdict.reasons[0], /rimraf@6\.1\.4: the registry could not be read \(HTTP 503\)/);
  });
  it('refuses, for a later look, when the lockfile cannot be read, and for good when it has no change', async () => {
    const unreadable = await evaluate(base(makeGh({ lockError: true }), makeFetchJson({})));
    assert.deepEqual([unreadable.verdict.arm, unreadable.verdict.retryLater], [false, true]);
    assert.match(unreadable.verdict.reasons[0], /lockfile difference could not be read/);
    const same = lock({ 'node_modules/rimraf': entry('6.1.4') });
    const empty = await evaluate(base(makeGh({ baseLock: same, headLock: same }), makeFetchJson({})));
    assert.deepEqual([empty.verdict.arm, empty.verdict.retryLater], [false, false]);
  });
  it('reads the lockfile at the path the policy names', async () => {
    const gh = makeGh();
    await evaluate(base(gh, makeFetchJson({ rimraf: old() }), { tooling: { ...TOOLING, lockfile: 'app/package-lock.json' } }));
    const reads = gh.calls.filter((c) => c[3]?.includes('/contents/'));
    assert.equal(reads.length, 2);
    assert.ok(reads.every((c) => c[3].includes('/contents/app/package-lock.json?ref=')));
  });
  it('reads the lockfile of the merge base and of the head, as commit ids', async () => {
    const gh = makeGh();
    await evaluate(base(gh, makeFetchJson({ rimraf: old() })));
    const refs = gh.calls.filter((c) => c[3]?.includes('/contents/')).map((c) => c[3].split('ref=')[1]);
    assert.deepEqual(refs.sort(), [SHA('a'), SHA('b')].sort());
    const compare = gh.calls.find((c) => c[1]?.includes('/compare/'));
    assert.equal(compare[1], `repos/acme/widgets/compare/${SHA('c')}...${SHA('a')}`);
  });
  it('does not look at a pull request that is closed or merged, unless asked to for an analysis', async () => {
    const closed = makeGh({ pr: { state: 'closed' } });
    const r = await evaluate(base(closed, makeFetchJson({ rimraf: old() })));
    assert.deepEqual(r.verdict.reasons, ['the pull request is not open']);
    assert.equal(touchedLockfile(closed), false);
    const again = await evaluate(base(makeGh({ pr: { state: 'closed' } }), makeFetchJson({ rimraf: old() }), { ignoreState: true }));
    assert.equal(again.verdict.arm, true);
  });
  it('does not look at a pull request that Dependabot did not open', async () => {
    const gh = makeGh({ pr: { user: { login: 'someone' } } });
    const r = await evaluate(base(gh, makeFetchJson({})));
    assert.deepEqual(r.verdict.reasons, ['the pull request was not opened by Dependabot']);
    assert.equal(touchedLockfile(gh), false);
  });
  it('a commit of a person on the pull request keeps it manual and costs no lockfile read or registry request', async () => {
    const gh = makeGh({
      commits: [
        { author: { login: 'dependabot[bot]' }, commit: { message: commitMessage([{ name: 'rimraf', updateType: PATCH, group: 'tooling' }]) } },
        { author: { login: 'someone' }, commit: { message: 'tweak the lockfile' } },
      ],
    });
    const fetchJson = makeFetchJson({ rimraf: old() });
    const r = await evaluate(base(gh, fetchJson));
    assert.equal(r.verdict.arm, false);
    assert.equal(r.verdict.retryLater, false);
    assert.match(r.verdict.reasons.join(), /commits not made by Dependabot: someone/);
    assert.equal(touchedLockfile(gh), false);
    assert.deepEqual(fetchJson.asked, []);
  });
  it('reads the metadata of the head commit', async () => {
    const fine = commitMessage([{ name: 'rimraf', version: '6.1.4', updateType: PATCH, group: 'tooling' }]);
    const gh = makeGh({
      commits: [
        { author: { login: 'dependabot[bot]' }, commit: { message: 'first commit without metadata' } },
        { author: { login: 'dependabot[bot]' }, commit: { message: fine } },
      ],
    });
    assert.equal((await evaluate(base(gh, makeFetchJson({ rimraf: old() })))).verdict.arm, true);
    const swapped = makeGh({
      commits: [
        { author: { login: 'dependabot[bot]' }, commit: { message: fine } },
        { author: { login: 'dependabot[bot]' }, commit: { message: 'last commit without metadata' } },
      ],
    });
    const r = await evaluate(base(swapped, makeFetchJson({ rimraf: old() })));
    assert.match(r.verdict.reasons[0], /no Dependabot metadata/);
  });
  it('a pull request without metadata is refused', async () => {
    const gh = makeGh({ commits: dependabot('chore: bump') });
    assert.match((await evaluate(base(gh, makeFetchJson({})))).verdict.reasons[0], /no Dependabot metadata/);
  });
  it('never arms a GitHub Actions pull request, reads no lockfile for it and asks no registry', async () => {
    const gh = makeGh({
      pr: { head: { ref: 'dependabot/github_actions/actions/checkout-7.1.0', sha: SHA('a') }, labels: [{ name: 'github_actions' }] },
      commits: dependabot(commitMessage([{ name: 'actions/checkout', version: '7.1.0', updateType: PATCH }])),
    });
    const fetchJson = makeFetchJson({});
    const r = await evaluate(base(gh, fetchJson));
    assert.equal(r.verdict.arm, false);
    assert.equal(r.verdict.retryLater, false);
    assert.ok(r.verdict.reasons.includes('GitHub Actions update: a person merges it'));
    assert.equal(touchedLockfile(gh), false);
    assert.deepEqual(fetchJson.asked, []);
  });
  it('never arms an npm pull request that carries the label github_actions', async () => {
    const r = await evaluate(base(makeGh({ pr: { labels: [{ name: 'github_actions' }] } }), makeFetchJson({ rimraf: old() })));
    assert.equal(r.verdict.arm, false);
  });
  it('never arms an ecosystem it does not know, and a branch that is not a Dependabot branch', async () => {
    for (const ref of ['dependabot/docker/node-22', 'my-branch']) {
      const r = await evaluate(base(makeGh({ pr: { head: { ref, sha: SHA('a') } } }), makeFetchJson({ rimraf: old() })));
      assert.equal(r.verdict.arm, false, ref);
    }
  });
  it('reports a pull request that is armed already', async () => {
    const r = await evaluate(base(makeGh({ pr: { auto_merge: { merge_method: 'squash' } } }), makeFetchJson({ rimraf: old() })));
    assert.equal(r.alreadyArmed, true);
    assert.equal(r.verdict.arm, true);
  });
  it('refuses a pull request of the real group that holds a name that stays manual', async () => {
    const gh = makeGh({
      commits: dependabot(commitMessage([{ name: 'rimraf', updateType: PATCH, group: 'tooling' }, { name: 'eslint-plugin-import-x', updateType: MINOR, group: 'tooling' }])),
    });
    const r = await evaluate(base(gh, makeFetchJson({})));
    assert.equal(r.verdict.arm, false);
    assert.match(r.verdict.reasons.join(), /eslint-plugin-import-x: belongs to the manual set/);
  });
});

describe('evaluate: a security update has no group and no update type', () => {
  const securityGh = (name, from, to, over = {}) =>
    makeGh({
      pr: { title: `chore(deps): bump ${name} from ${from} to ${to}`, head: { ref: `dependabot/npm_and_yarn/${name}-${to}`, sha: SHA('a') } },
      commits: dependabot(commitMessage([{ name, version: to }], `chore(deps): bump ${name}`)),
      baseLock: lock({ [`node_modules/${name}`]: entry(from) }),
      headLock: lock({ [`node_modules/${name}`]: entry(to) }),
      ...over,
    });
  it('arms the security update of a tooling package once its version is old (the update type comes from the lockfile)', async () => {
    const r = await evaluate(base(securityGh('rimraf', '6.1.3', '6.1.4'), makeFetchJson({ rimraf: old(9) })));
    assert.equal(r.verdict.arm, true);
  });
  it('holds a young one for a later look', async () => {
    const r = await evaluate(base(securityGh('rimraf', '6.1.3', '6.1.4'), makeFetchJson({ rimraf: old(1.5) })));
    assert.deepEqual([r.verdict.arm, r.verdict.retryLater], [false, true]);
    assert.match(r.verdict.reasons[0], /rimraf@6\.1\.4: 1\.5 days old/);
  });
  it('leaves the security update of a bundled package to a person, and reads no registry for it', async () => {
    const fetchJson = makeFetchJson({ axios: { '1.21.1': agoIso(30) } });
    const r = await evaluate(base(securityGh('axios', '1.21.0', '1.21.1'), fetchJson));
    assert.deepEqual([r.verdict.arm, r.verdict.retryLater], [false, false]);
    assert.match(r.verdict.reasons[0], /axios: not in the tooling group \(no group\)/);
    assert.deepEqual(fetchJson.asked, []);
  });
  it('refuses a security update of a tooling package that is a major bump of the lockfile', async () => {
    const r = await evaluate(base(securityGh('rimraf', '5.0.0', '6.0.0'), makeFetchJson({ rimraf: { '6.0.0': agoIso(30) } })));
    assert.equal(r.verdict.arm, false);
    assert.match(r.verdict.reasons[0], new RegExp(`rimraf: ${MAJOR} is not a patch or minor update`));
  });
  it('asks no registry for a security update that the lockfile shows to be a major one', async () => {
    const fetchJson = makeFetchJson({ rimraf: { '6.0.0': agoIso(30) } });
    await evaluate(base(securityGh('rimraf', '5.0.0', '6.0.0'), fetchJson));
    assert.deepEqual(fetchJson.asked, []);
  });
  it('refuses when the lockfile cannot say what kind of update it is, and asks no registry', async () => {
    const fetchJson = makeFetchJson({ rimraf: old() });
    const r = await evaluate(base(securityGh('rimraf', '6.1.3', '6.1.4', { lockError: true }), fetchJson));
    assert.equal(r.verdict.arm, false);
    assert.match(r.verdict.reasons[0], /unknown update type/);
    assert.deepEqual(fetchJson.asked, []);
  });
});

describe('evaluate: what it does not accept', () => {
  it('a repository name or a number that could carry something else is an error', async () => {
    const gh = makeGh();
    for (const repo of ['acme', 'acme/widgets/x', 'acme/wid gets', '../x/y', 'a/b;rm']) {
      await assert.rejects(evaluate(base(gh, makeFetchJson({}), { repo })), /not a repository name/);
    }
    for (const number of [0, -1, 1.5, NaN, '7']) {
      await assert.rejects(evaluate(base(gh, makeFetchJson({}), { number })), /not a pull request number/);
    }
    assert.deepEqual(gh.calls, []);
  });
  it('a head or base that is not a commit id is not used in a request', async () => {
    const gh = makeGh({ pr: { head: { ref: 'dependabot/npm_and_yarn/x', sha: '../../etc' }, base: { sha: SHA('c') } } });
    const r = await evaluate(base(gh, makeFetchJson({ rimraf: old() })));
    assert.equal(r.verdict.arm, false);
    assert.equal(gh.calls.some((c) => c.join(' ').includes('etc')), false);
  });
  it('a merge base that is not a commit id is not used in a request, and the lockfile is then unreadable', async () => {
    const gh = makeGh({ mergeBase: '../../etc/passwd' });
    const r = await evaluate(base(gh, makeFetchJson({ rimraf: old() })));
    assert.deepEqual([r.verdict.arm, r.verdict.retryLater], [false, true]);
    assert.match(r.verdict.reasons[0], /lockfile difference could not be read/);
    assert.equal(gh.calls.some((c) => c.join(' ').includes('passwd')), false);
  });
  it('a lockfile that is not JSON is unreadable, not a crash', async () => {
    const gh = makeGh();
    const original = gh;
    const broken = async (args) => (args[3]?.includes('/contents/') ? 'not json' : original(args));
    const r = await evaluate(base(broken, makeFetchJson({})));
    assert.deepEqual([r.verdict.arm, r.verdict.retryLater], [false, true]);
  });
});

describe('fetchPublishTimes: the registry', () => {
  const doc = (times) => ({ time: times });
  it('asks once per package and keeps the publish time of each version', async () => {
    const asked = [];
    const fetchJson = async (url) => {
      asked.push(url);
      return doc({ '1.21.1': '2026-11-04T12:00:00.000Z', '1.21.0': '2026-10-05T12:00:00.000Z' });
    };
    const { times, errors } = await fetchPublishTimes(
      [{ name: 'axios', version: '1.21.1' }, { name: 'axios', version: '1.21.0' }],
      fetchJson
    );
    assert.deepEqual(asked, ['https://registry.npmjs.org/axios']);
    assert.equal(times['axios@1.21.1'], Date.parse('2026-11-04T12:00:00.000Z'));
    assert.equal(times['axios@1.21.0'], Date.parse('2026-10-05T12:00:00.000Z'));
    assert.deepEqual(errors, {});
  });
  it('a failing registry, a throwing fetch and a missing version leave the version unknown or unreadable; a failing package is tried three times', async () => {
    let calls = 0;
    const fetchJson = async (url) => {
      calls++;
      if (url.endsWith('/down')) throw new Error('HTTP 503');
      if (url.endsWith('/boom')) throw new Error('network');
      return doc({ '1.0.0': '2026-11-01T00:00:00.000Z' });
    };
    const { times, errors } = await fetchPublishTimes(
      [
        { name: 'down', version: '1.0.0' },
        { name: 'boom', version: '1.0.0' },
        { name: 'there', version: '1.0.0' },
        { name: 'there', version: '9.9.9' },
      ],
      fetchJson
    );
    assert.deepEqual(errors, { 'down@1.0.0': 'HTTP 503', 'boom@1.0.0': 'network' });
    assert.equal(times['there@1.0.0'], Date.parse('2026-11-01T00:00:00.000Z'));
    assert.equal(times['there@9.9.9'], undefined);
    assert.equal(calls, 3 + 3 + 1);
  });
  it('a package that fails twice and then answers is read', async () => {
    let n = 0;
    const fetchJson = async () => {
      if (++n < 3) throw new Error('flaky');
      return doc({ '1.0.0': '2026-11-01T00:00:00.000Z' });
    };
    const { times, errors } = await fetchPublishTimes([{ name: 'a', version: '1.0.0' }], fetchJson);
    assert.ok(times['a@1.0.0']);
    assert.deepEqual(errors, {});
  });
  it('keeps what a cache already holds and asks only for the rest', async () => {
    const cache = new Map([['a', { doc: doc({ '1.0.0': '2026-11-01T00:00:00.000Z' }) }]]);
    const asked = [];
    const { times } = await fetchPublishTimes(
      [{ name: 'a', version: '1.0.0' }, { name: 'b', version: '2.0.0' }],
      async (url) => {
        asked.push(url);
        return doc({ '2.0.0': '2026-11-02T00:00:00.000Z' });
      },
      cache
    );
    assert.deepEqual(asked, ['https://registry.npmjs.org/b']);
    assert.ok(times['a@1.0.0'] && times['b@2.0.0']);
  });
  it('asks at most five packages at a time', async () => {
    let running = 0;
    let most = 0;
    const fetchJson = async () => {
      running++;
      most = Math.max(most, running);
      await new Promise((r) => setTimeout(r, 5));
      running--;
      return doc({});
    };
    await fetchPublishTimes(Array.from({ length: 20 }, (_, i) => ({ name: `p${i}`, version: '1.0.0' })), fetchJson);
    assert.ok(most > 1 && most <= 5, `most ${most}`);
  });
  it('encodes the slash of a scoped name in the request', async () => {
    const asked = [];
    await fetchPublishTimes([{ name: '@types/node', version: '1.0.0' }], async (url) => {
      asked.push(url);
      return doc({});
    });
    assert.deepEqual(asked, ['https://registry.npmjs.org/@types%2fnode']);
  });
});

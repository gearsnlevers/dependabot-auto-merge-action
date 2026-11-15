import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  MIN_AGE_DAYS,
  TOOLING_GROUP,
  ageReasons,
  belongsToTooling,
  decide,
  derivedUpdateType,
  ecosystemOfBranch,
  isManualName,
  isToolingName,
  lockChanges,
  lockEntryName,
  parseUpdatedDependencies,
  permanentRefusals,
  publishTimeOf,
  registryUrl,
  semverBump,
} from '../scripts/policy.mjs';
import { MAJOR, MINOR, NOW, PATCH, TOOLING, ago, commitMessage, dep } from './support.mjs';

/*
 * Pins the policy of core record 0023: which Dependabot pull requests are armed. The first half of the cases comes
 * from the test suites of frodo-lib and frodo-cli, where the two copies of this policy lived before the action.
 */

describe('isManualName: the manual set (Prettier, TypeScript, ESLint and what belongs to them)', () => {
  for (const name of [
    'prettier',
    'typescript',
    'eslint',
    '@eslint/js',
    'typescript-eslint',
    '@typescript-eslint/parser',
    '@typescript-eslint/eslint-plugin',
    'eslint-plugin-import-x',
    'eslint-config-prettier',
    '@ianvs/prettier-plugin-sort-imports',
    '@types/eslint',
    'ESLint-Plugin-Foo',
  ]) {
    it(`${name} stays manual`, () => assert.equal(isManualName(name), true));
  }
  for (const name of [
    'axios',
    'jose',
    'rimraf',
    'jest',
    'ts-jest',
    '@jest/globals',
    '@types/node',
    'typedoc',
    'typedoc-plugin-missing-exports',
    'uuid',
    'proxy-agent',
    'prettierx',
    'my-typescripty',
    'eslintrc',
    'cli-progress',
  ]) {
    it(`${name} may be armed (by name)`, () => assert.equal(isManualName(name), false));
  }
});

describe('isToolingName: the packages of the tooling group, for an update that has no group', () => {
  const patterns = ['@jest/*', '@types/*', 'jest', 'rimraf', 'ts-jest'];
  it('matches a name and a scope pattern', () => {
    for (const name of ['jest', '@jest/globals', '@types/node', 'rimraf', 'ts-jest']) {
      assert.equal(isToolingName(name, patterns), true, name);
    }
  });
  it('matches nothing else: a bundled package, a longer name, a name that only contains a pattern', () => {
    for (const name of ['axios', 'jest-extended', 'my-rimraf', 'rimraf2', '@types', '@jestx/a', 'tsdown']) {
      assert.equal(isToolingName(name, patterns), false, name);
    }
  });
  it('takes `*` as any run of characters and escapes everything else', () => {
    assert.equal(isToolingName('a.b', ['a.b']), true);
    assert.equal(isToolingName('axb', ['a.b']), false);
    assert.equal(isToolingName('a+b', ['a+b']), true);
    assert.equal(isToolingName('@s/x-y', ['@s/*']), true);
    assert.equal(isToolingName('(a)', ['(a)']), true);
  });
  it('honours exclude patterns', () => {
    assert.equal(isToolingName('@types/node', ['@types/*'], ['@types/node']), false);
    assert.equal(isToolingName('@types/jest', ['@types/*'], ['@types/node']), true);
  });
  it('an empty list names nothing', () => assert.equal(isToolingName('jest', []), false));
});

describe('parseUpdatedDependencies: the block at the end of the commit message', () => {
  const group = commitMessage([
    { name: 'axios', version: '1.21.1', updateType: PATCH, group: 'dev-minor-patch' },
    { name: '@types/node', version: '26.6.4', updateType: MINOR, group: 'dev-minor-patch' },
  ]);
  it('reads every entry, a quoted scoped name included', () => {
    assert.deepEqual(parseUpdatedDependencies(group), [
      {
        name: 'axios',
        version: '1.21.1',
        type: 'direct:development',
        updateType: PATCH,
        group: 'dev-minor-patch',
      },
      {
        name: '@types/node',
        version: '26.6.4',
        type: 'direct:development',
        updateType: MINOR,
        group: 'dev-minor-patch',
      },
    ]);
  });
  it('a single update has no group', () => {
    const one = ['bump prettier', '', '---', 'updated-dependencies:', '- dependency-name: prettier', '  dependency-version: 3.10.0', '  dependency-type: direct:development', `  update-type: ${MINOR}`, '...'].join('\n');
    assert.deepEqual(parseUpdatedDependencies(one), [
      { name: 'prettier', version: '3.10.0', type: 'direct:development', updateType: MINOR },
    ]);
  });
  it('a security update has no update type either', () => {
    const msg = ['x', '---', 'updated-dependencies:', '- dependency-name: glob', '  dependency-version: 14.0.5', '  dependency-type: indirect', '...'].join('\n');
    assert.deepEqual(parseUpdatedDependencies(msg), [{ name: 'glob', version: '14.0.5', type: 'indirect' }]);
  });
  for (const [label, message] of [
    ['a message without the block', 'fix: a human commit'],
    ['an empty message', ''],
    ['no message', undefined],
    ['a block without a dependency', 'x\n---\nupdated-dependencies:\n...\n'],
  ]) {
    it(`${label} gives null`, () => assert.equal(parseUpdatedDependencies(message), null));
  }
  it('text after the closing marker is not read', () => {
    const upToMarker = group.slice(0, group.indexOf('...') + 3);
    const msg = `${upToMarker}\n- dependency-name: sneaky\n  update-type: ${PATCH}`;
    assert.deepEqual(parseUpdatedDependencies(msg).map((d) => d.name), ['axios', '@types/node']);
  });
  it('a line that is neither an entry nor a field ends the block', () => {
    const msg = ['---', 'updated-dependencies:', '- dependency-name: a', `  update-type: ${PATCH}`, 'some text', '- dependency-name: sneaky'].join('\n');
    assert.deepEqual(parseUpdatedDependencies(msg).map((d) => d.name), ['a']);
  });
  it('reads a message with Windows line ends', () => {
    assert.deepEqual(parseUpdatedDependencies(group.replace(/\n/g, '\r\n')).map((d) => d.name), ['axios', '@types/node']);
  });
});

describe('the lockfile', () => {
  it('lockEntryName is the part after the last node_modules/', () => {
    assert.equal(lockEntryName('node_modules/axios'), 'axios');
    assert.equal(lockEntryName('node_modules/@types/node'), '@types/node');
    assert.equal(lockEntryName('node_modules/rimraf/node_modules/glob'), 'glob');
    assert.equal(lockEntryName('node_modules/a/node_modules/@scope/b'), '@scope/b');
    assert.equal(lockEntryName(''), '');
    assert.equal(lockEntryName('packages/workspace'), '');
  });
  const lock = (packages) => ({ packages });
  it('lockChanges lists new and changed entries of the head, direct and transitive, sorted by path, with the old version', () => {
    const base = lock({
      '': { name: 'x' },
      'node_modules/axios': { version: '1.21.0' },
      'node_modules/jose': { version: '6.2.14' },
      'node_modules/rimraf': { version: '6.1.3' },
      'node_modules/gone': { version: '1.0.0' },
    });
    const head = lock({
      '': { name: 'x' },
      'node_modules/rimraf/node_modules/glob': { version: '14.0.5' },
      'node_modules/axios': { version: '1.21.1' },
      'node_modules/jose': { version: '6.2.14' },
      'node_modules/rimraf': { version: '6.1.4' },
      'node_modules/@scope/new': { version: '2.0.0' },
    });
    assert.deepEqual(lockChanges(base, head), [
      { path: 'node_modules/@scope/new', name: '@scope/new', version: '2.0.0', from: undefined },
      { path: 'node_modules/axios', name: 'axios', version: '1.21.1', from: '1.21.0' },
      { path: 'node_modules/rimraf', name: 'rimraf', version: '6.1.4', from: '6.1.3' },
      { path: 'node_modules/rimraf/node_modules/glob', name: 'glob', version: '14.0.5', from: undefined },
    ]);
  });
  it('removed entries, links, entries without a version, the root entry and an identical lock give no change', () => {
    const base = lock({ 'node_modules/a': { version: '1.0.0' } });
    assert.deepEqual(lockChanges(base, base), []);
    assert.deepEqual(
      lockChanges(lock({}), lock({ '': { version: '9.9.9' }, 'node_modules/linked': { link: true, version: '1.0.0' }, 'node_modules/noversion': {} })),
      []
    );
    assert.deepEqual(lockChanges(undefined, undefined), []);
  });
});

describe('the update type that metadata may lack (a security update, an indirect dependency)', () => {
  for (const [from, to, expected] of [
    ['1.2.3', '1.2.4', 'patch'],
    ['1.2.3', '1.3.0', 'minor'],
    ['1.2.3', '2.0.0', 'major'],
    ['1.2.3', '1.2.3', 'unknown'],
    [undefined, '1.2.3', 'unknown'],
    ['1.0.0-beta.1', '1.0.0-beta.2', 'unknown'],
    ['2026.1', '2026.2', 'unknown'],
  ]) {
    it(`${from} to ${to} is ${expected}`, () => assert.equal(semverBump(from, to), expected));
  }
  it('derivedUpdateType takes the widest change of the entries of that name', () => {
    const changes = [
      { name: 'glob', version: '14.0.5', from: '14.0.4' },
      { name: 'glob', version: '15.1.0', from: '14.9.0' },
      { name: 'other', version: '2.0.0', from: '1.0.0' },
    ];
    assert.equal(derivedUpdateType('glob', changes), 'version-update:semver-major');
    assert.equal(derivedUpdateType('other', changes), 'version-update:semver-major');
    assert.equal(derivedUpdateType('glob', [changes[0]]), 'version-update:semver-patch');
  });
  it('is undefined when the lockfile cannot say', () => {
    assert.equal(derivedUpdateType('glob', []), undefined);
    assert.equal(derivedUpdateType('glob', undefined), undefined);
    assert.equal(derivedUpdateType('glob', [{ name: 'glob', version: '1.0.0' }]), undefined);
    assert.equal(derivedUpdateType('glob', [{ name: 'glob', version: '1.0.0-rc.2', from: '1.0.0-rc.1' }]), undefined);
  });
});

describe('the ecosystem, the registry', () => {
  it('knows the ecosystem from the branch', () => {
    assert.equal(ecosystemOfBranch('dependabot/npm_and_yarn/tooling-1a2b'), 'npm_and_yarn');
    assert.equal(ecosystemOfBranch('dependabot/github_actions/actions/checkout-7'), 'github_actions');
    assert.equal(ecosystemOfBranch('feature/dependabot/npm_and_yarn/x'), 'unknown');
    assert.equal(ecosystemOfBranch('main'), 'unknown');
    assert.equal(ecosystemOfBranch(undefined), 'unknown');
  });
  it('registryUrl encodes the slash of a scoped name', () => {
    assert.equal(registryUrl('axios'), 'https://registry.npmjs.org/axios');
    assert.equal(registryUrl('@types/node'), 'https://registry.npmjs.org/@types%2fnode');
  });
  it('publishTimeOf reads a time and nothing for what is unknown or unparsable', () => {
    const doc = { time: { '1.0.0': '2026-11-01T00:00:00.000Z', '2.0.0': 'yesterday', '3.0.0': 7 } };
    assert.equal(publishTimeOf(doc, '1.0.0'), Date.parse('2026-11-01T00:00:00.000Z'));
    assert.equal(publishTimeOf(doc, '2.0.0'), undefined);
    assert.equal(publishTimeOf(doc, '3.0.0'), undefined);
    assert.equal(publishTimeOf(doc, '9.9.9'), undefined);
    assert.equal(publishTimeOf(undefined, '1.0.0'), undefined);
  });
});

describe('ageReasons: the age test', () => {
  const changes = [{ name: 'a', version: '1.0.0' }];
  for (const [label, days, fails] of [
    ['older than 7 days', 7.5, false],
    ['exactly 7 days', 7, false],
    ['just under 7 days', 6.99, true],
    ['one day', 1, true],
  ]) {
    it(label, () => {
      const reasons = ageReasons(changes, { 'a@1.0.0': ago(days) }, {}, NOW, 7);
      assert.equal(reasons.length === 1, fails);
    });
  }
  it('an unknown publish time fails', () => {
    assert.deepEqual(ageReasons(changes, {}, {}, NOW, 7), ['a@1.0.0: publish time unknown']);
  });
  it('an unreadable registry fails and says so', () => {
    assert.deepEqual(ageReasons(changes, {}, { 'a@1.0.0': 'HTTP 503' }, NOW, 7), ['a@1.0.0: the registry could not be read (HTTP 503)']);
  });
  it('the same version listed twice is reported once, and the age is shown in days', () => {
    const twice = [changes[0], changes[0]];
    assert.deepEqual(ageReasons(twice, { 'a@1.0.0': ago(3.2) }, {}, NOW, 7), ['a@1.0.0: 3.2 days old, less than 7']);
  });
  it('honours another minimum age', () => {
    assert.equal(ageReasons(changes, { 'a@1.0.0': ago(10) }, {}, NOW, 14).length, 1);
    assert.equal(ageReasons(changes, { 'a@1.0.0': ago(10) }, {}, NOW, 3).length, 0);
  });
});

describe('decide: a Dependabot pull request is armed only under the policy', () => {
  const verdict = (over = {}) =>
    decide({
      updates: [dep('rimraf')],
      commitAuthors: ['dependabot[bot]'],
      ecosystem: 'npm_and_yarn',
      tooling: TOOLING,
      changes: [{ name: 'rimraf', version: '6.1.4' }],
      times: { 'rimraf@6.1.4': ago(10) },
      now: NOW,
      ...over,
    });

  it('an old patch update of a tooling package is armed', () => {
    assert.deepEqual(verdict(), {
      arm: true,
      retryLater: false,
      reasons: ['1 lockfile versions, all at least 7 days old'],
    });
  });
  it('a minor update is armed too, and both spellings of the npm ecosystem', () => {
    assert.equal(verdict({ updates: [dep('jest', MINOR)] }).arm, true);
    assert.equal(verdict({ ecosystem: 'npm' }).arm, true);
  });
  it('a group of tooling packages is armed when every version is old enough, transitive ones included', () => {
    const v = verdict({
      updates: [dep('jest'), dep('rimraf', MINOR), dep('@types/node')],
      changes: [
        { name: 'jest', version: '30.1.1' },
        { name: 'rimraf', version: '6.2.0' },
        { name: 'glob', version: '14.0.5' },
      ],
      times: { 'jest@30.1.1': ago(8), 'rimraf@6.2.0': ago(9), 'glob@14.0.5': ago(7) },
    });
    assert.equal(v.arm, true);
  });
  it('a young transitive version holds a group back although every direct update is old, and the next look may pass', () => {
    const v = verdict({
      changes: [
        { name: 'rimraf', version: '6.1.4' },
        { name: 'glob', version: '14.0.5' },
      ],
      times: { 'rimraf@6.1.4': ago(11), 'glob@14.0.5': ago(3.2) },
    });
    assert.deepEqual(v, { arm: false, retryLater: true, reasons: ['glob@14.0.5: 3.2 days old, less than 7'] });
  });
  it('exactly 7 days is enough and a little less is not', () => {
    assert.equal(verdict({ times: { 'rimraf@6.1.4': ago(7) } }).arm, true);
    assert.equal(verdict({ times: { 'rimraf@6.1.4': ago(6.9) } }).arm, false);
  });
  it('honours another minimum age', () => {
    assert.equal(verdict({ minAgeDays: 14 }).arm, false);
    assert.equal(verdict({ minAgeDays: 3, times: { 'rimraf@6.1.4': ago(4) } }).arm, true);
  });
  it('an unknown publish time or an unreadable registry holds it back, and a later look may pass', () => {
    const unknown = verdict({ times: {} });
    assert.equal(unknown.arm, false);
    assert.equal(unknown.retryLater, true);
    assert.match(unknown.reasons[0], /publish time unknown/);
    const unreadable = verdict({ times: {}, errors: { 'rimraf@6.1.4': 'HTTP 503' } });
    assert.equal(unreadable.retryLater, true);
    assert.match(unreadable.reasons[0], /registry could not be read/);
  });
  it('a lockfile that could not be read holds it back for a later look; an empty difference does not', () => {
    const unreadable = verdict({ changes: undefined });
    assert.deepEqual([unreadable.arm, unreadable.retryLater], [false, true]);
    const empty = verdict({ changes: [] });
    assert.deepEqual([empty.arm, empty.retryLater], [false, false]);
    assert.match(empty.reasons[0], /no change of package-lock.json/);
  });
  it('a major update is never armed, and no later look changes that', () => {
    const v = verdict({ updates: [dep('rimraf', MAJOR)] });
    assert.deepEqual([v.arm, v.retryLater], [false, false]);
    assert.match(v.reasons[0], /not a patch or minor update/);
  });
  it('an update of an unknown type is not armed', () => {
    const v = verdict({ updates: [{ name: 'rimraf', group: 'tooling' }] });
    assert.equal(v.arm, false);
    assert.match(v.reasons[0], /unknown update type/);
  });
  for (const name of ['prettier', 'typescript-eslint', 'eslint-plugin-import-x', '@eslint/js']) {
    it(`${name} is never armed, whatever its age`, () => {
      const v = verdict({ updates: [dep(name)] });
      assert.deepEqual([v.arm, v.retryLater], [false, false]);
      assert.ok(v.reasons.some((r) => /manual set/.test(r)));
    });
  }
  it('one manual package keeps a whole group manual', () => {
    assert.equal(verdict({ updates: [dep('rimraf'), dep('eslint-plugin-import-x', MINOR)] }).arm, false);
  });
  it('no metadata, no arming', () => {
    for (const updates of [null, undefined, []]) {
      const v = verdict({ updates });
      assert.equal(v.arm, false);
      assert.match(v.reasons[0], /no Dependabot metadata/);
    }
  });
  for (const [label, authors] of [
    ['a commit by a person', ['dependabot[bot]', 'someone']],
    ['a commit without a known author', ['dependabot[bot]', '']],
    ['no commits found', []],
  ]) {
    it(`${label} keeps it manual`, () => {
      const v = verdict({ commitAuthors: authors });
      assert.equal(v.arm, false);
      assert.match(v.reasons[0], /commits not made by Dependabot/);
    });
  }
  it('a bundled package in a pull request of its own (no group) is never armed: a person merges it', () => {
    const v = verdict({ updates: [dep('axios', PATCH, null)] });
    assert.deepEqual([v.arm, v.retryLater], [false, false]);
    assert.match(v.reasons[0], /not in the tooling group/);
  });
  it('another Dependabot group is not the tooling group, and the name does not matter then', () => {
    assert.equal(verdict({ updates: [dep('axios', PATCH, 'dev-minor-patch')] }).arm, false);
    const v = verdict({ updates: [dep('rimraf', PATCH, 'dev-minor-patch')] });
    assert.equal(v.arm, false, 'a group name that is not tooling is not rescued by a name on the list');
  });
  it('one package outside the group keeps a whole group manual', () => {
    assert.equal(verdict({ updates: [dep('rimraf'), dep('axios', PATCH, null)] }).arm, false);
  });
  for (const [label, type] of [['patch', PATCH], ['minor', MINOR], ['major', MAJOR]]) {
    it(`a GitHub Actions ${label} update is never armed: a person merges it`, () => {
      const v = verdict({ ecosystem: 'github_actions', updates: [dep('actions/checkout', type, null)], changes: undefined });
      assert.deepEqual([v.arm, v.retryLater], [false, false]);
      assert.ok(v.reasons.includes('GitHub Actions update: a person merges it'));
    });
  }
  it('a GitHub Actions update is not armed even when everything else would pass, by branch or by label', () => {
    for (const over of [{ ecosystem: 'github_actions' }, { hasActionsLabel: true }]) {
      const v = verdict({ ...over, updates: [dep('rimraf')], times: { 'rimraf@6.1.4': ago(30) } });
      assert.deepEqual([v.arm, v.retryLater], [false, false]);
    }
  });
  it('an ecosystem that is not npm is never armed, a branch that is not Dependabot-style included', () => {
    for (const ecosystem of ['docker', 'pip', 'unknown']) {
      const v = verdict({ ecosystem });
      assert.equal(v.arm, false);
      assert.ok(v.reasons.some((r) => r.includes(`the ecosystem ${ecosystem}`)));
    }
  });
  it('reasons of a permanent refusal win over the age: it is not retried', () => {
    const v = verdict({ updates: [dep('rimraf', MAJOR)], times: {} });
    assert.equal(v.retryLater, false);
  });
});

describe('decide: a security update has no group, so the package decides', () => {
  const security = (name, over = {}) =>
    decide({
      updates: [{ name, updateType: PATCH }],
      commitAuthors: ['dependabot[bot]'],
      ecosystem: 'npm_and_yarn',
      tooling: TOOLING,
      changes: [{ name, version: '1.0.1' }],
      times: { [`${name}@1.0.1`]: ago(10) },
      now: NOW,
      ...over,
    });
  it('arms the security update of a tooling package that passes the age test (the record says so)', () => {
    assert.equal(security('rimraf').arm, true);
    assert.equal(security('@types/node').arm, true);
  });
  it('holds it for a later look while its version is young, as any other update', () => {
    const v = security('rimraf', { times: { 'rimraf@1.0.1': ago(2) } });
    assert.deepEqual([v.arm, v.retryLater], [false, true]);
  });
  it('leaves the security update of a bundled package, the bundler and a manual name to a person', () => {
    for (const name of ['axios', 'tsdown', 'eslint-plugin-import-x']) {
      const v = security(name);
      assert.deepEqual([v.arm, v.retryLater], [false, false], name);
    }
  });
  it('belongsToTooling: a stated group decides by name of the group, no group by name of the package', () => {
    assert.equal(belongsToTooling({ name: 'axios', group: TOOLING_GROUP }, TOOLING), true);
    assert.equal(belongsToTooling({ name: 'axios', group: 'other' }, TOOLING), false);
    assert.equal(belongsToTooling({ name: 'rimraf' }, TOOLING), true);
    assert.equal(belongsToTooling({ name: 'axios' }, TOOLING), false);
  });
});

describe('permanentRefusals: what no later look can change', () => {
  const ok = { updates: [dep('rimraf')], commitAuthors: ['dependabot[bot]'], ecosystem: 'npm_and_yarn', tooling: TOOLING };
  it('a tooling patch update by Dependabot has none', () => assert.deepEqual(permanentRefusals(ok), []));
  it('every reason is listed, not only the first', () => {
    const reasons = permanentRefusals({
      ...ok,
      updates: [{ name: 'eslint-plugin-import-x', updateType: MAJOR }],
      commitAuthors: ['dependabot[bot]', 'someone'],
    });
    assert.equal(reasons.length, 4);
  });
  it('an update without a stated type can wait for the lockfile', () => {
    const untyped = { ...ok, updates: [{ name: 'rimraf', group: 'tooling' }] };
    assert.equal(permanentRefusals(untyped).length, 1);
    assert.deepEqual(permanentRefusals({ ...untyped, deferMissingTypes: true }), []);
    // but a stated type is tested at once
    assert.equal(permanentRefusals({ ...ok, updates: [dep('rimraf', MAJOR)], deferMissingTypes: true }).length, 1);
  });
  it('the name of the tooling group is the one of dependabot.yml, and the default age is 7 days', () => {
    assert.equal(TOOLING_GROUP, 'tooling');
    assert.equal(MIN_AGE_DAYS, 7);
  });
});

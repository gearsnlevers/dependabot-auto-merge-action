import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { parseYaml, toolingFromConfig } from '../scripts/dependabot-yml.mjs';
import { isManualName, isToolingName } from '../scripts/policy.mjs';

const fixture = (name) => readFileSync(new URL(`./fixtures/dependabot/${name}`, import.meta.url), 'utf8');

describe('parseYaml: the part of YAML that dependabot.yml uses', () => {
  it('reads mappings, sequences, comments, quoted and plain scalars', () => {
    const text = [
      '# a comment',
      'version: 2',
      'updates:',
      '  - package-ecosystem: "npm"   # trailing comment',
      '    directory: /',
      '    groups:',
      '      tooling:',
      '        patterns:',
      '          - "@types/*"',
      "          - 'jest'",
      '          - rimraf # plain',
      '    ignore:',
      '      - dependency-name: "typescript"',
      '        update-types:',
      '          - "version-update:semver-major"',
    ].join('\n');
    assert.deepEqual(parseYaml(text), {
      version: 2,
      updates: [
        {
          'package-ecosystem': 'npm',
          directory: '/',
          groups: { tooling: { patterns: ['@types/*', 'jest', 'rimraf'] } },
          ignore: [{ 'dependency-name': 'typescript', 'update-types': ['version-update:semver-major'] }],
        },
      ],
    });
  });
  it('keeps a # inside quotes, an escaped quote, a doubled single quote and a colon in a value', () => {
    assert.deepEqual(parseYaml('a: "x # y"\nb: "say \\"hi\\""\nc: \'it\'\'s\'\nd: "k: v"\n'), {
      a: 'x # y',
      b: 'say "hi"',
      c: "it's",
      d: 'k: v',
    });
  });
  it('reads a flow sequence of scalars and the empty ones', () => {
    assert.deepEqual(parseYaml('a: [x, "y,z", \'w\']\nb: []\nc: {}\n'), { a: ['x', 'y,z', 'w'], b: [], c: {} });
  });
  it('a # inside a plain value is not a comment, a # after a blank is', () => {
    assert.deepEqual(parseYaml('a: x#y\nb: /dir#frag # comment\n'), { a: 'x#y', b: '/dir#frag' });
  });
  it('lets a sequence sit at the indentation of its key', () => {
    assert.deepEqual(parseYaml('a:\n- 1\n- 2\nb: x\n'), { a: [1, 2], b: 'x' });
  });
  it('reads an item that is a mapping with several keys, and an item that starts on the next line', () => {
    assert.deepEqual(parseYaml('l:\n  - k: v\n    m: w\n  -\n    n: o\n'), { l: [{ k: 'v', m: 'w' }, { n: 'o' }] });
  });
  it('reads an empty value as null and an empty file as null', () => {
    assert.deepEqual(parseYaml('a:\nb: ~\n'), { a: null, b: null });
    assert.equal(parseYaml('# only a comment\n'), null);
  });
  for (const [label, text, message] of [
    ['an anchor', 'a: &x 1\n', /not supported/],
    ['an alias', 'a: *x\n', /not supported/],
    ['a tag', 'a: !!str 1\n', /not supported/],
    ['a block scalar', 'a: |\n  text\n', /not supported/],
    ['a flow mapping', 'a: {b: 1}\n', /flow mapping/],
    ['a tab in the indentation', 'a:\n\tb: 1\n', /tab/],
    ['a duplicate key', 'a: 1\na: 2\n', /twice/],
    ['an unterminated string', 'a: "x\n', /unterminated/],
    ['bad indentation', 'a: 1\n  b: 2\n', /unexpected indentation/],
  ]) {
    it(`refuses ${label}`, () => assert.throws(() => parseYaml(text), message));
  }
});

describe('the dependabot.yml of the two repositories that use the action', () => {
  for (const [file, patterns, first, last] of [
    ['frodo-lib.dependabot.yml', 14, '@jest/*', 'winston'],
    ['frodo-cli.dependabot.yml', 12, '@modelcontextprotocol/client', 'ts-jest'],
  ]) {
    it(`${file}: one npm entry with ${patterns} tooling patterns, the lockfile at the root`, () => {
      const config = parseYaml(fixture(file));
      assert.equal(config.version, 2);
      assert.deepEqual(config.updates.map((u) => u['package-ecosystem']), ['npm', 'github-actions']);
      const tooling = toolingFromConfig(config);
      assert.equal(tooling.patterns.length, patterns);
      assert.equal(tooling.patterns[0], first);
      assert.equal(tooling.patterns.at(-1), last);
      assert.deepEqual(tooling.excludePatterns, []);
      assert.equal(tooling.lockfile, 'package-lock.json');
    });
  }
  it('no pattern of either file names a package that stays manual, and neither names the bundler', () => {
    for (const file of ['frodo-lib.dependabot.yml', 'frodo-cli.dependabot.yml']) {
      const { patterns } = toolingFromConfig(parseYaml(fixture(file)));
      assert.equal(patterns.some((p) => isManualName(p)), false, file);
      assert.equal(isToolingName('tsdown', patterns), false, file);
      assert.equal(isToolingName('axios', patterns), false, file);
    }
  });
});

describe('toolingFromConfig: what the policy needs, and nothing armed when it is missing', () => {
  const npm = (extra = {}) => ({
    'package-ecosystem': 'npm',
    directory: '/',
    groups: { tooling: { patterns: ['jest'] } },
    ...extra,
  });
  it('takes patterns, exclude patterns and a lockfile in a subdirectory', () => {
    const t = toolingFromConfig({
      updates: [npm({ directory: '/app/', groups: { tooling: { patterns: ['a', 'b'], 'exclude-patterns': ['c'] } } })],
    });
    assert.deepEqual(t, { patterns: ['a', 'b'], excludePatterns: ['c'], lockfile: 'app/package-lock.json' });
  });
  it('a missing directory is the root', () => {
    const { directory, ...entry } = npm();
    assert.equal(toolingFromConfig({ updates: [entry] }).lockfile, 'package-lock.json');
  });
  for (const [label, config, message] of [
    ['no updates', {}, /no `updates` list/],
    ['no npm entry', { updates: [{ 'package-ecosystem': 'github-actions' }] }, /no npm entry/],
    ['two npm entries', { updates: [npm(), npm({ directory: '/b' })] }, /more than one npm entry/],
    ['`directories`', { updates: [npm({ directories: ['/a', '/b'] })] }, /directories/],
    ['no tooling group', { updates: [npm({ groups: { other: { patterns: ['x'] } } })] }, /no group `tooling`/],
    ['no groups at all', { updates: [{ 'package-ecosystem': 'npm', directory: '/' }] }, /no group `tooling`/],
    ['empty patterns', { updates: [npm({ groups: { tooling: { patterns: [] } } })] }, /no group `tooling`/],
    ['a pattern that is not a string', { updates: [npm({ groups: { tooling: { patterns: [1] } } })] }, /no group `tooling`/],
    ['bad exclude patterns', { updates: [npm({ groups: { tooling: { patterns: ['a'], 'exclude-patterns': 'x' } } })] }, /exclude-patterns/],
    ['a directory that climbs out', { updates: [npm({ directory: '/../x' })] }, /not usable/],
    ['a relative directory', { updates: [npm({ directory: 'app' })] }, /not usable/],
  ]) {
    it(`throws for ${label}`, () => assert.throws(() => toolingFromConfig(config), message));
  }
});

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

/*
 * The properties of the action and of this repository's own workflow that the policy relies on: the token reaches one
 * step, inputs never become shell text, nothing third-party is used unpinned, the README says what the action takes.
 */
const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const action = read('action.yml');
const readme = read('README.md');
const ci = read('.github/workflows/ci.yml');
const pkg = JSON.parse(read('package.json'));

const INPUTS = {
  'github-token': undefined,
  'pull-request': "''",
  repository: '${{ github.repository }}',
  'dependabot-config': "'.github/dependabot.yml'",
  'min-age-days': "'7'",
  'dry-run': "'false'",
};

describe('action.yml', () => {
  it('is one composite step with an id, and calls nothing else', () => {
    assert.match(action, /using: 'composite'/);
    assert.equal(action.match(/^\s+- id: /gm).length, 1);
    assert.equal(action.match(/^\s+- /gm).length, 1);
    assert.doesNotMatch(action, /\buses:/, 'no third-party action to pin');
  });
  it('has the documented inputs with their defaults, and only those', () => {
    const block = action.slice(action.indexOf('inputs:'), action.indexOf('outputs:'));
    const names = [...block.matchAll(/^ {2}([a-z-]+):$/gm)].map((m) => m[1]);
    assert.deepEqual(names, Object.keys(INPUTS));
    for (const [name, value] of Object.entries(INPUTS)) {
      const part = block.slice(block.indexOf(`  ${name}:`)).split(/\n {2}[a-z-]+:\n/)[0];
      if (value === undefined) assert.match(part, /required: true/, name);
      else assert.ok(part.includes(`default: ${value}`), `${name} default ${value}`);
    }
  });
  it('has the two outputs, wired to the step', () => {
    assert.match(action, /verdicts:[\s\S]*?value: \$\{\{ steps\.run\.outputs\.verdicts \}\}/);
    assert.match(action, /armed:[\s\S]*?value: \$\{\{ steps\.run\.outputs\.armed \}\}/);
  });
  it('hands the token to one step only, as the environment of the script', () => {
    assert.equal(action.match(/inputs\.github-token/g).length, 1);
    assert.match(action, /GH_TOKEN: \$\{\{ inputs\.github-token \}\}/);
  });
  it('never splices an input into shell text: the run block has no expression at all', () => {
    const run = action.slice(action.indexOf('run: |'));
    assert.doesNotMatch(run, /\$\{\{/);
    assert.match(run, /exec node "\$GITHUB_ACTION_PATH\/scripts\/dependabot-auto-merge\.mjs" "\$\{args\[@\]\}"/);
  });
  it('the README documents every input, every output and the pinning by SHA', () => {
    for (const name of Object.keys(INPUTS)) assert.ok(readme.includes(`\`${name}\``), name);
    for (const name of ['verdicts', 'armed']) assert.ok(readme.includes(`\`${name}\``), name);
    assert.match(readme, /full commit SHA/);
    assert.match(readme, /core-record|0023-dependency-updates-arrive-late/);
  });
});

describe('the workflow of this repository', () => {
  it('has the job named CI that branch protection requires', () => {
    assert.match(ci, /^name: CI$/m);
    assert.match(ci, /^ {4}name: CI$/m);
    assert.match(pkg.scripts.test, /node --test/);
  });
  it('pins every action to a full commit SHA, reads only, and keeps no credentials', () => {
    const uses = ci.split('\n').filter((l) => l.includes('uses:'));
    assert.ok(uses.length >= 2);
    for (const line of uses) assert.match(line, /@[0-9a-f]{40}\s+#/, line);
    assert.match(ci, /permissions:\n\s+contents: read/);
    assert.match(ci, /persist-credentials: false/);
  });
  it('the package has no dependency: nothing is installed at run time', () => {
    assert.equal(pkg.dependencies, undefined);
    assert.equal(pkg.devDependencies, undefined);
  });
});

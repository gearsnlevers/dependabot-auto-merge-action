import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

/*
 * Runs the real `run:` block of action.yml with a stub for `node`, to see exactly which arguments the script would
 * get, and that an input with shell syntax in it arrives as one plain argument and is never executed.
 */
const action = readFileSync(new URL('../action.yml', import.meta.url), 'utf8');
const block = action.slice(action.indexOf('run: |') + 'run: |'.length).replace(/^ {8}/gm, '');

function step(inputs) {
  const dir = mkdtempSync(join(tmpdir(), 'action-step-'));
  const stub = join(dir, 'node');
  writeFileSync(stub, '#!/bin/bash\nprintf "%s\\n" "$@"\n');
  chmodSync(stub, 0o755);
  const result = spawnSync('bash', ['-c', block], {
    env: {
      PATH: `${dir}:${process.env.PATH}`,
      GITHUB_ACTION_PATH: '/action',
      INPUT_REPOSITORY: 'acme/widgets',
      INPUT_CONFIG: '.github/dependabot.yml',
      INPUT_MIN_AGE_DAYS: '7',
      INPUT_PULL_REQUEST: '',
      INPUT_DRY_RUN: 'false',
      ...inputs,
    },
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trimEnd().split('\n');
}

const SCRIPT = '/action/scripts/dependabot-auto-merge.mjs';

describe('the step of action.yml', () => {
  it('sweeps by default', () => {
    assert.deepEqual(step({}), [SCRIPT, '--repo', 'acme/widgets', '--config', '.github/dependabot.yml', '--min-age-days', '7', '--all']);
  });
  it('looks at one pull request when it is given one', () => {
    assert.deepEqual(step({ INPUT_PULL_REQUEST: '42' }).slice(-2), ['--pr', '42']);
  });
  it('passes a dry run on, and only for the word true', () => {
    assert.equal(step({ INPUT_DRY_RUN: 'true' }).at(-1), '--dry-run');
    for (const value of ['false', '', 'TRUE', 'yes']) assert.equal(step({ INPUT_DRY_RUN: value }).includes('--dry-run'), false, value);
  });
  it('passes the repository, the path and the age as they are given', () => {
    const args = step({ INPUT_REPOSITORY: 'o/n', INPUT_CONFIG: 'ci/d.yml', INPUT_MIN_AGE_DAYS: '14' });
    assert.deepEqual(args.slice(1, 7), ['--repo', 'o/n', '--config', 'ci/d.yml', '--min-age-days', '14']);
  });
  it('an input with shell syntax is one argument and is never run', () => {
    const evil = '$(touch /tmp/pwned-by-input) `touch /tmp/pwned2`; echo x';
    const args = step({ INPUT_REPOSITORY: evil, INPUT_PULL_REQUEST: evil });
    assert.ok(args.includes(evil));
    assert.equal(args.filter((a) => a === evil).length, 2);
  });
});

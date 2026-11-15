import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { describe, it } from 'node:test';
import { replay } from './corpus-replay.mjs';

/*
 * Real Dependabot pull requests of frodo-lib and frodo-cli (docs/corpus.md), replayed through the real `evaluate`
 * with GitHub and the registry replaced by the recording. Each file says what the policy of core record 0023 gives
 * for it, and why; those verdicts were written by a person from the record, not copied from the recorder.
 */
const DIR = new URL('./corpus/', import.meta.url);
const files = readdirSync(DIR).filter((f) => f.endsWith('.json')).sort();
const fixtures = files.map((f) => ({ file: f, text: readFileSync(new URL(f, DIR), 'utf8') }));

describe('the corpus', () => {
  it('holds at least 14 real pull requests of both repositories, and an armed one', () => {
    const parsed = fixtures.map((f) => JSON.parse(f.text));
    assert.ok(parsed.length >= 14, `${parsed.length} files`);
    assert.ok(parsed.some((f) => f.repo === 'rockcarver/frodo-lib'));
    assert.ok(parsed.some((f) => f.repo === 'rockcarver/frodo-cli'));
    assert.ok(parsed.some((f) => f.expectations.some((e) => e.arm === true)));
  });
  it('covers every kind of refusal of the record', () => {
    const wanted = ['not in the tooling group', 'manual set', 'not a patch or minor update', 'GitHub Actions update', 'commits not made by Dependabot', 'days old, less than 7'];
    const mentions = fixtures.flatMap((f) => JSON.parse(f.text).expectations.map((e) => e.mention));
    for (const w of wanted) assert.ok(mentions.some((m) => m.includes(w)), w);
  });
  it('holds public data only: no token, no key, no address of a person', () => {
    for (const { file, text } of fixtures) {
      assert.doesNotMatch(text, /gh[pousr]_[A-Za-z0-9]{20,}|eyJ[A-Za-z0-9_-]{20,}|BEGIN [A-Z ]*PRIVATE|Authorization|password|secret/i, file);
      const emails = text.match(/[A-Za-z0-9._-]+@[A-Za-z0-9.-]+\.[a-z]+/g) ?? [];
      assert.ok(emails.every((e) => e === 'support@github.com'), `${file}: ${emails}`);
    }
  });
});

for (const { file, text } of fixtures) {
  const fixture = JSON.parse(text);
  describe(`${fixture.repo}#${fixture.number}: ${fixture.pr.title}`, () => {
    it('says why', () => {
      assert.ok(fixture.why.length > 20, 'a reason is written');
      assert.ok(fixture.expectations.length >= 1, 'a verdict is expected');
    });
    for (const expected of fixture.expectations) {
      const day = expected.asOf ?? fixture.asOf;
      it(`as of ${day}: ${expected.arm ? 'armed' : expected.retryLater ? 'held, look again later' : 'a person merges it'} (${expected.mention})`, async () => {
        const result = await replay(fixture, Date.parse(day));
        assert.equal(result.verdict.arm, expected.arm, result.verdict.reasons.join('; '));
        assert.equal(result.verdict.retryLater, expected.retryLater, result.verdict.reasons.join('; '));
        assert.ok(
          result.verdict.reasons.some((r) => r.includes(expected.mention)),
          `${JSON.stringify(expected.mention)} not in ${JSON.stringify(result.verdict.reasons)}`
        );
      });
    }
  });
}

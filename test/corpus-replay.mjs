/*
 * Replays a recorded pull request (a corpus file, see docs/corpus.md) through the real `evaluate`, with GitHub and the
 * registry replaced by what was recorded. The recorder and the corpus test use it, so that what the recorder prints
 * is what the test sees.
 */
import { evaluate } from '../scripts/evaluate.mjs';
import { makeFetchJson, makeGh } from './support.mjs';

export async function replay(fixture, now, over = {}) {
  const gh = makeGh({
    repo: fixture.repo,
    pr: fixture.pr,
    commits: fixture.commits,
    mergeBase: fixture.mergeBase,
    baseLock: fixture.baseLock,
    headLock: fixture.headLock,
  });
  return evaluate({
    repo: fixture.repo,
    number: fixture.number,
    gh,
    fetchJson: makeFetchJson(fixture.registry),
    now,
    tooling: fixture.tooling,
    // most of the recorded pull requests are merged or closed: the question is what the policy says about them
    ignoreState: true,
    ...over,
  });
}

/*
 * Collects what is known about one Dependabot pull request (GitHub, the registry) and decides with the pure policy
 * of policy.mjs. Everything that talks to the outside is passed in (`gh`, `fetchJson`), so that tests replace it.
 *
 * Nothing that the pull request itself controls is run or read as code: the policy comes from the default branch
 * (see the caller), the pull request only supplies data (its commits, its lockfile, its branch name).
 */
import {
  MIN_AGE_DAYS,
  DEPENDABOT_LOGIN,
  decide,
  derivedUpdateType,
  ecosystemOfBranch,
  lockChanges,
  parseUpdatedDependencies,
  permanentRefusals,
  publishTimeOf,
  registryUrl,
} from './policy.mjs';

const SHA = /^[0-9a-f]{40}$/;
const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

/**
 * The publish time of every changed version, read from the registry. One document per package, a few in parallel,
 * each tried up to three times.
 * @param {{name:string,version:string}[]} changes the versions to look up
 * @param {(url:string)=>Promise<any>} fetchJson reads and parses a JSON document, throws on any failure
 * @param {Map<string, {doc?: any, error?: string}>} [cache] documents already read (a sweep reads each package once)
 * @returns {Promise<{times: Record<string, number | undefined>, errors: Record<string, string>}>} the publish time
 *   in milliseconds per `name@version`; a version of a package that could not be read has an error, a version that
 *   the document does not list has neither
 */
export async function fetchPublishTimes(changes, fetchJson, cache = new Map()) {
  const names = [...new Set(changes.map((c) => c.name))].filter((n) => !cache.has(n));
  let next = 0;
  async function worker() {
    while (next < names.length) {
      const name = names[next++];
      let last;
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          cache.set(name, { doc: await fetchJson(registryUrl(name)) });
          last = undefined;
          break;
        } catch (error) {
          last = error;
        }
      }
      if (last) {
        cache.set(name, { error: String(last?.message ?? last).split('\n')[0].slice(0, 80) });
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(5, names.length) }, () => worker()));
  const times = {};
  const errors = {};
  for (const c of changes) {
    const key = `${c.name}@${c.version}`;
    const entry = cache.get(c.name);
    if (entry?.error) errors[key] = entry.error;
    else times[key] = publishTimeOf(entry?.doc, c.version);
  }
  return { times, errors };
}

async function rawFile(gh, repo, path, ref) {
  return gh([
    'api',
    '-H',
    'Accept: application/vnd.github.raw',
    `repos/${repo}/contents/${path}?ref=${encodeURIComponent(ref)}`,
  ]);
}

/**
 * Evaluate one pull request.
 * @param {object} io what to talk to and what the policy is
 * @param {string} io.repo owner/name
 * @param {number} io.number pull request number
 * @param {(args: string[]) => Promise<string>} io.gh runs `gh`, returns stdout
 * @param {(url: string) => Promise<any>} io.fetchJson reads a JSON document, throws on failure
 * @param {number} io.now the moment that counts, milliseconds
 * @param {{patterns: string[], excludePatterns?: string[], lockfile: string}} io.tooling the policy of the repository
 *   (`toolingFromConfig`)
 * @param {number} [io.minAgeDays] minimum age of every added version
 * @param {Map<string, any>} [io.cache] registry documents already read
 * @param {boolean} [io.ignoreState] also look at a closed or merged pull request (for a dry run that analyses one)
 * @returns {Promise<{number:number,title:string,alreadyArmed:boolean,checked:number,verdict:{arm:boolean,retryLater:boolean,reasons:string[]}}>}
 *   the verdict
 */
export async function evaluate({
  repo,
  number,
  gh,
  fetchJson,
  now,
  tooling,
  minAgeDays = MIN_AGE_DAYS,
  cache = new Map(),
  ignoreState = false,
}) {
  if (!REPO.test(repo)) throw new Error(`not a repository name: ${repo}`);
  if (!Number.isInteger(number) || number < 1) throw new Error(`not a pull request number: ${number}`);
  const pr = JSON.parse(await gh(['api', `repos/${repo}/pulls/${number}`]));
  const title = String(pr.title ?? '');
  const alreadyArmed = !!pr.auto_merge;
  const out = (arm, retryLater, reasons, checked = 0) => ({
    number,
    title,
    alreadyArmed,
    checked,
    verdict: { arm, retryLater, reasons },
  });
  if (pr.state !== 'open' && !ignoreState) return out(false, false, ['the pull request is not open']);
  if (pr.user?.login !== DEPENDABOT_LOGIN) {
    return out(false, false, ['the pull request was not opened by Dependabot']);
  }
  const ecosystem = ecosystemOfBranch(pr.head?.ref);
  const hasActionsLabel = (pr.labels ?? []).some((l) => l?.name === 'github_actions');
  const commits = JSON.parse(
    await gh(['api', '--paginate', '--slurp', `repos/${repo}/pulls/${number}/commits`])
  ).flat();
  const commitAuthors = commits.map((c) => c.author?.login ?? '');
  const head = commits.length ? commits[commits.length - 1] : undefined;
  const updates = parseUpdatedDependencies(head?.commit?.message ?? '');
  const base = { updates, commitAuthors, ecosystem, hasActionsLabel, tooling };

  // what is already a refusal needs neither the lockfile nor the registry (an update without a stated type waits)
  const early = permanentRefusals({ ...base, deferMissingTypes: true });
  if (early.length > 0) return out(false, false, early);

  let changes;
  try {
    if (!SHA.test(pr.base?.sha ?? '') || !SHA.test(pr.head?.sha ?? '')) {
      throw new Error('the pull request has no usable commits');
    }
    const mergeBase = (
      await gh([
        'api',
        `repos/${repo}/compare/${pr.base.sha}...${pr.head.sha}`,
        '--jq',
        '.merge_base_commit.sha',
      ])
    ).trim();
    if (!SHA.test(mergeBase)) throw new Error('no merge base');
    const [baseLock, headLock] = await Promise.all([
      rawFile(gh, repo, tooling.lockfile, mergeBase).then(JSON.parse),
      rawFile(gh, repo, tooling.lockfile, pr.head.sha).then(JSON.parse),
    ]);
    changes = lockChanges(baseLock, headLock);
  } catch {
    changes = undefined;
  }
  // an update without a stated type (a security update, an indirect dependency): the lockfile says what it is
  const typed = (updates ?? []).map((u) =>
    u.updateType ? u : { ...u, updateType: derivedUpdateType(u.name, changes) }
  );
  const late = permanentRefusals({ ...base, updates: typed });
  if (late.length > 0) return out(false, false, late, changes?.length ?? 0);
  let times = {};
  let errors = {};
  if (changes && changes.length > 0) {
    ({ times, errors } = await fetchPublishTimes(changes, fetchJson, cache));
  }
  const verdict = decide({ ...base, updates: typed, changes, times, errors, now, minAgeDays });
  return { number, title, alreadyArmed, checked: changes?.length ?? 0, verdict };
}

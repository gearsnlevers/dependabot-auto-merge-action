# Dependabot Auto-Merge Action

Arms auto-merge on Dependabot pull requests, under a written policy, and on nothing else. A pull request is armed only when it is a patch or minor update of a package in your `tooling` group, every package version that it adds to the lockfile is at least a week old, and everything else about it is as expected. GitHub then merges it once your required checks pass; the action only arms the merge.

The policy is core record 0023 of frodo-lib and frodo-cli: [Dependency updates arrive late, and only tooling merges without a person](https://github.com/rockcarver/frodo-lib/blob/main/decisions/core/0023-dependency-updates-arrive-late-and-only-tooling-merges-without-a-person.md). The action is its one implementation; before it, each repository had its own copy of the script.

## The policy

A pull request is armed when **all** of this holds. Anything doubtful means: not armed, and a person merges it.

- Dependabot opened it, it is open, **every commit** of it is by Dependabot, and the head commit carries the metadata block (`updated-dependencies`) that says what is updated.
- It is an npm pull request. A **GitHub Actions** update is never armed, whatever its size: an action runs with the credentials of your workflows, so a person reads it first. The same goes for every other ecosystem.
- Every update is a **patch or minor** update. A security update and an indirect dependency have no update type in the metadata; the action takes it from the lockfile (the widest change of the entries of that name; a prerelease or an entry it cannot compare is not armed).
- No updated package has a name that stays **manual**: the whole word `eslint`, `prettier` or `typescript` in its scope or name (`eslint-plugin-import-x`, `@typescript-eslint/parser`, `@eslint/js` and `@ianvs/prettier-plugin-sort-imports` are manual; `prettierx` is not).
- Every update is in the Dependabot **group `tooling`** of your `dependabot.yml`. A version update names its group. A security update has none, so its package is matched against the `patterns` (and `exclude-patterns`) of the same group: a security update of a tooling package is armed once it passes the age test below; the security update of a bundled package, of the bundler or of a manual name is for a person.
- Every package version that the lockfile **adds or changes, direct or transitive**, was published at least `min-age-days` (7) days ago according to the npm registry. Dependabot's cooldown only delays what it proposes; a bump also moves transitive packages to whatever is newest. A registry that cannot be read, or a version without a publish time, is a refusal.

A pull request that fails only the age test (or a read that may work later) is looked at again by the next sweep, so run the action daily as well as for pull requests.

## What the action reads, and from where

The policy of your repository is your `dependabot.yml`, read **from the default branch through the API**, never from the pull request and never from a checkout: a pull request cannot change the rule that decides about itself, and the workflow needs no checkout step. The action reads the `patterns` and `exclude-patterns` of `groups.tooling` of the npm entry, and the `directory` of that entry for the lockfile (`package-lock.json` at that directory). It needs exactly one `npm` entry (`directories` and several npm entries are not supported) and a `tooling` group with patterns; otherwise **nothing is armed** and the step fails with the reason.

The pull request supplies only data: its commits, its branch name, its lockfile at the head and at the merge base. No code of the pull request is ever run.

## Use

```yaml
name: 'Dependabot Auto-Merge'

on:
  pull_request:
  schedule:
    - cron: '17 6 * * *'
  workflow_dispatch:

permissions:
  contents: write
  pull-requests: write

concurrency:
  group: dependabot-auto-merge-${{ github.event.pull_request.number || 'sweep' }}
  cancel-in-progress: false

jobs:
  dependabot:
    runs-on: ubuntu-latest
    # skips at once for every pull request that is not Dependabot's; the daily sweep and a manual run look at the open
    # Dependabot pull requests only
    if: github.event_name != 'pull_request' || github.actor == 'dependabot[bot]'
    steps:
      - uses: gearsnlevers/dependabot-auto-merge-action@<full commit SHA of the release you reviewed> # v1.x.y
        with:
          github-token: ${{ secrets.GITHUB_TOKEN }}
          pull-request: ${{ github.event.pull_request.number }}
```

Pin the action by its **full commit SHA**, with the version as a comment. Dependabot proposes the next SHA like any other action update, and a person reads and merges it (Actions updates are never armed). Branch protection must allow auto-merge, and the required checks decide when GitHub merges.

| Input | Default | |
| --- | --- | --- |
| `github-token` | required | The `GITHUB_TOKEN` of the workflow. It reaches only the step that runs the script. |
| `pull-request` | empty | Number of one pull request; empty looks at every open Dependabot pull request. |
| `repository` | the caller | `owner/name`. |
| `dependabot-config` | `.github/dependabot.yml` | Path of the file in the repository, read from its default branch. |
| `min-age-days` | `7` | Age every added or changed lockfile version must have. |
| `dry-run` | `false` | `true` decides and reports, and arms nothing. |

| Output | |
| --- | --- |
| `verdicts` | JSON array, one object per pull request looked at: `number`, `title`, `action` (`armed`, `already armed`, `would arm`, `skipped, look again later`, `skipped, a person merges it`, `failed`, `failed to arm`), `arm`, `retryLater`, `alreadyArmed`, `reasons`. |
| `armed` | Comma-separated numbers of the pull requests that are armed, now or already. |

The step also writes a table to the job summary. It fails (exit code 1) when the policy cannot be read, when a pull request could not be looked at, or when arming failed; a pull request that is simply not armed is a decision, not a failure.

Needs a runner with Node 20 or later and the `gh` CLI (both are on `ubuntu-latest`). Nothing is installed at run time: the action has no dependency.

## Security notes

- The workflow token is `contents: write` and `pull-requests: write`. The action uses it to read the repository and to run `gh pr merge --auto --squash`, and for nothing else.
- Inputs reach the script as environment variables, never spliced into shell text. The repository name, pull request number, configuration path and every commit id are checked before they are used in a request. Titles and reasons are reduced to one line before they are logged, so that a pull request title cannot write a workflow command.
- The action is only as trustworthy as the commit you pin: read what changed before you merge the Dependabot pull request that moves the pin.

## Development

`npm test` runs the tests with the Node test runner; they run offline (GitHub and the registry are replaced). Layout:

- `action.yml`: the interface. `scripts/policy.mjs`: the policy as pure functions. `scripts/dependabot-yml.mjs`: reads `dependabot.yml`. `scripts/evaluate.mjs`: collects what is known about a pull request and decides. `scripts/dependabot-auto-merge.mjs`: the entry point.
- `test/corpus/`: recorded real Dependabot pull requests of frodo-lib and frodo-cli with the verdict the record gives each of them, see [docs/corpus.md](docs/corpus.md).

To look at one pull request without arming it (also a closed one, as of the day it was opened):

```console
GH_TOKEN=$(gh auth token) node scripts/dependabot-auto-merge.mjs --repo owner/name --pr 123 --dry-run --ignore-state --as-of 2026-11-01T00:00:00Z
```

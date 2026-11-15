# dependabot-auto-merge-action: instructions for coding agents

Arms auto-merge on Dependabot pull requests under one written policy, and nothing else. It is a composite GitHub Action (`action.yml`) around a Node program without dependencies. It is called by the workflows of frodo-lib and frodo-cli, pinned by full commit SHA. Read [README.md](README.md) first.

## Layout

- `action.yml`: the interface (inputs, outputs, the one step). `scripts/policy.mjs`: the policy of core record 0023 as pure functions. `scripts/dependabot-yml.mjs`: reads the `dependabot.yml` of the caller. `scripts/evaluate.mjs`: GitHub and registry reads, then the decision. `scripts/dependabot-auto-merge.mjs`: the entry point.
- `test/`: the tests (`node --test`), all offline. `test/corpus/`: recorded real pull requests with their expected verdicts; `scripts/record-corpus.mjs` records them, see [docs/corpus.md](docs/corpus.md).
- `.github/workflows/ci.yml`: the check named `CI`, which branch protection requires.

## Checks

- `npm test` runs every test. CI runs it on Node 22; the action itself needs Node 20 or later.

## Rules

- **The policy is core record 0023**: https://github.com/rockcarver/frodo-lib/blob/main/decisions/core/0023-dependency-updates-arrive-late-and-only-tooling-merges-without-a-person.md. A change of what is armed is a change of that record first (a maintainer decides, in frodo-lib and frodo-cli), then of this code. If your task conflicts with the record, stop and say so in the issue or pull request.
- **When in doubt the answer is: not armed.** Every new rule must be able to refuse; none may make a refusal into an arming without a record behind it.
- **Inputs and outputs are a public interface.** Callers pin a commit; do not remove or rename an input or output, or change a default, in a way that changes what an existing caller gets. Keep `action.yml` and the README in step (a test checks it).
- **No dependency, nothing installed at run time.** Every third-party action in this repository's own workflows is pinned by full commit SHA.
- **Nothing the pull request controls is run or read as code.** The policy comes from the default branch; the pull request supplies data only. Validate every value that goes into a request (repository, number, path, commit id) and never print a raw title or reason without `oneLine`.
- **Add or change a test for every behaviour change**, with a negative proof (the test fails without the change). A new real-world case belongs in `test/corpus/`.
- **Never commit credentials.** This repository is public; fixtures hold public data only (package names, versions, publish times).

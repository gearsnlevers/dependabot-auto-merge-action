# The corpus of recorded pull requests

`test/corpus/*.json` holds real Dependabot pull requests of frodo-lib and frodo-cli, as the action sees them, and the verdict that core record 0023 gives each one. `test/corpus.test.mjs` runs the real `evaluate` on every file with GitHub and the registry replaced by the recording, and compares the verdict with `expected`.

A file has: `repo`, `number`, `asOf` (the day the pull request was opened: the age test is judged as of that day, so the verdict does not change as the versions get older), `pr` (state, author, title, head and base, labels, auto-merge), `commits` (author login and message), `baseLock` and `headLock` (the entries of the lockfile that differ, plus the root entry), `registry` (the publish time of every changed version, from the npm registry), `tooling` (the patterns of the `tooling` group of the repository's `dependabot.yml` as it was when the file was recorded), and `expected` (`arm`, `retryLater`, and a word that must appear in the reasons).

`expected` is written by a person, from the record, after reading the recorded verdict: the recorder prints the verdict but never writes it. The reason of each case is in the file (`why`).

To record one more:

```console
node scripts/record-corpus.mjs --repo rockcarver/frodo-lib --pr 1096 --tooling-config path/to/dependabot.yml
```

It needs `gh` and reads only public data (the pull request, its commits, two lockfiles, the registry). Look at the printed verdict, add `expected` and `why` to the file by hand, and run `npm test`.

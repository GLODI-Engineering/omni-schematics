# Real `gsim-core` trees, for the bundle-freshness gate

Each file is `git ls-tree -r --format='%(objectname) %(path)' <commit>` run in `gsim-core`, so
every line is a git blob hash and a path — exactly what the GitHub tree API returns for the same
commit, and exactly what `scripts/build-gsim-wasm.mjs` fingerprints from.

They are here so `bundle-freshness.test.ts` can assert the gate's behaviour on **real engine
history** without the network, and they were chosen for what they prove (#280):

| commit | what it was | engine code |
|---|---|---|
| `4e30fd6` | `chore(release): 0.7.0` | the version bump — changed |
| `2b1cc2a` | `fix(examples)`: regenerate netlists | unchanged from `4e30fd6` |
| `872efda` | `docs(decisions)`: 0010 | unchanged — **the decision record that reddened CI** |
| `3df5e09` | `chore(release): 0.7.1` | the version bump — changed |
| `6f8d1b0` | `feat(library)!`: the catalogue declares specifications | changed |

Refresh one with the command above if a case ever needs a different commit; do not hand-edit.

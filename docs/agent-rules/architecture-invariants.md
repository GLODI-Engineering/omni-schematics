# Architectural Invariants

These are project-defining decisions that cannot be silently violated.
Each one has a mechanical check in `scripts/check-invariants.sh`, but the
check is a *floor* — it catches obvious surface violations. The rationale
below is what you need to read to recognize the same mistake in a form the
grep doesn't catch.

When in doubt, the rationale wins over the mechanical check. If you find
a way around a check that still violates the spirit of the rule, you have
broken the invariant and the check needs to be tightened.

---

## 1. Tpetra, not Epetra {#tpetra}

**Rule.** All new linear-algebra code in `packages/engine-*/` targets the
Trilinos modern stack: **Tpetra** (distributed LA) + **Kokkos** (kernels) +
**Belos** (iterative solvers) + **MueLu** or **FROSch** (preconditioners).

**Why.** The Epetra stack was archived and removed from Trilinos at the end
of 2025. Writing new code against Epetra means writing code against a
removed API — it will not compile against current Trilinos, and Xyce's own
migration is moving the same direction.

**Check.** `scripts/check-invariants.sh` greps for `#include <Epetra…>`,
`#include "Epetra…"`, `from epetra`, `import epetra` (case-insensitive)
across `packages/` and `apps/` and fails on any match.

**If the check fails.** Replace the Epetra type with its Tpetra equivalent:

| Epetra | Tpetra |
|---|---|
| `Epetra_Map` | `Tpetra::Map` |
| `Epetra_CrsMatrix` | `Tpetra::CrsMatrix` |
| `Epetra_Vector` | `Tpetra::Vector` |
| `Epetra_MultiVector` | `Tpetra::MultiVector` |
| `AztecOO` | `Belos` |

Comments and documentation may *mention* Epetra (e.g., explaining the
migration); only `#include` / `import` statements are forbidden.

---

## 2. Optimistic canvas — no synchronous waits on the solver {#optimistic-canvas}

**Rule.** Code in `apps/frontend/src/canvas/` must not synchronously await
the compiler or the solver. All such interactions are asynchronous and
surfaced via non-blocking indicators (port colors, status bar, toasts).

**Why.** OpenModelica's OMEdit couples its canvas tightly to the compiler;
the result is the editor freezing for 5–6 seconds on every keystroke for
medium-sized models. The single biggest UX failure mode of every
open-source block-diagram alternative is this synchronous coupling.

**Check.** `scripts/check-invariants.sh` greps the canvas folder for
suspicious patterns: `await.*compile`, `await.*solverCall`, `await.*runSim`,
`blockOnSolver`, `synchronousCompile`. The check is heuristic — write
clearly-named async functions to stay on the right side of it.

**If the check fails.** The canvas operation must complete using only local
state. Compilation happens in the committed WebAssembly engine
(`packages/gsim-wasm`) and a run happens in the `general-simulator` binary the
extension host spawns; either way the result is delivered as a separate
`postMessage`. The user is never blocked on a
compiler round-trip to complete a diagram edit.

---

## Retired — smooth component models only {#smooth-models}

**Retired in #155.** This invariant governed equation templates in
`packages/components/src/components/templates/`: they had to be smooth and
continuous, because a piecewise model turns the DAE into a hybrid system the
symbolic processor cannot index-reduce across.

The rule is still true of the product. It is no longer an invariant *of this
repository*, because the subtree it named never held anything. Every `.py`
file in `packages/components` was an empty `__init__.py`, nothing imported the
package, and the component library it was a skeleton for landed in the Rust
engine instead. The package is deleted, and a grep over a directory that does
not exist is a check that cannot fail — so it went with it rather than stay
here reporting a tick it had not earned.

Where the rule lives now: the engine owns the component library, so smoothness
is the engine's invariant to hold. The heading and anchor are kept so the
`#smooth-models` links elsewhere still land on this explanation. If equation
templates ever come back to Python here, this section and its check come back
with them.

---

## 3. Hooks must not be bypassed in automation {#no-no-verify}

**Rule.** `scripts/` and `.github/workflows/` must not contain `--no-verify`,
`--no-gpg-sign`, `SKIP=` (pre-commit's skip env), or other hook-bypass
mechanisms.

**Why.** The whole point of pre-commit and CI gates is that they apply
*every* time. If automation can bypass them, the gate becomes optional in
practice and drifts. A human deciding to bypass once is a recoverable
mistake; automation bypassing silently is a regression we won't notice for
months.

**Check.** `scripts/check-invariants.sh` greps `scripts/` and
`.github/workflows/` for `--no-verify`, `--no-gpg-sign`, `SKIP=`, and
`HUSKY=0`, and fails on any match.

**If the check fails.** Don't add the bypass. If a hook is wrong, fix the
hook. If a hook is too slow, make it faster or move it to CI. If a check is
catching something that isn't actually wrong, tighten the check until it
distinguishes the cases.

---

## Adding a new invariant

When you find yourself writing "remember to do X" in a code review, that's
a signal — turn it into an invariant. The process:

1. Add a section here with rule, rationale, and a link to the spec source.
2. Add a check to `scripts/check-invariants.sh`.
3. Run the check locally to confirm it passes against current code.
4. Commit. The next CI run will gate it on every PR going forward.

The bar for adding an invariant is: a violation would be subtle, costly to
discover later, and hard to spot in code review. If it's just a style
preference, it belongs in Biome's config, not here.

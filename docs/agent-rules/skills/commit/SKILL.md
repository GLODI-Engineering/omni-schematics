---
name: commit
description: Gate-checked commit workflow — runs lint, both typechecks, both test suites and the drift gates before staging any files, then creates a conventional-commit message from the diff.
---

# `/commit` — Lint, test, then commit

Use this skill whenever you are about to commit changes. No agent may attempt a
`git commit` without completing every step below first.

> **Non-negotiable.** This gate applies to every agent, every task, every
> branch. "It's a small change" is not an exception. If a step fails, fix
> the root cause before proceeding. Never use `--no-verify`, never override
> `core.hooksPath`, never skip a step.
> (See architectural invariant #4 in `AGENTS.md`.)

The gate list below is the same one `.github/workflows/ci.yml` runs and the
same one `docs/DEVELOPMENT.md` §9 draws. It is TypeScript, Node and one Rust
crate: there is no `uv`, no `pyproject.toml` and no Python package in this
repository (#162), so `ruff`, `mypy` and `pytest` are not gates here. The two
`.py` files that remain are the example generators under `examples/`, and
`scripts/check-examples.mjs` is what holds them to their documents.

---

## Step 0 — Build the protocol package if you touched it

```bash
pnpm -F @gensim/webview-protocol build
```

`packages/webview-protocol` is consumed through its **built** `dist/`, so a
change to `src/index.ts` is invisible to both typechecks until it is compiled.
Skipping this reports the opposite of the truth: a correct change fails
typecheck with "has no exported member", and a stale `dist` can let a wrong
one pass. Everything below assumes this has run if that package changed.

---

## Step 1 — Lint

```bash
# TypeScript / JavaScript / JSON — the whole repo, one pinned Biome.
pnpm exec biome check .

# Rust (only if a .rs file changed) — the one crate in this repository.
cargo fmt --manifest-path crates/waveform-store/Cargo.toml --check
```

`biome check .` must report **0 errors**. It also reports warnings; the
accepted baseline is the count already on `main` (112 at the time of writing).
Do not chase pre-existing warnings in an unrelated commit, and do not add one.

---

## Step 2 — Type-check

Both of them. They are separate `tsconfig`s over separate trees and each has
caught what the other could not see.

```bash
pnpm -F @gensim/frontend typecheck
pnpm -F ./apps/vscode-extension typecheck
```

All type errors must be resolved before continuing.

---

## Step 3 — Tests

```bash
pnpm -F @gensim/frontend test            # vitest, the webview app
pnpm -F ./apps/vscode-extension test     # vitest, the extension host
```

Those two are the suites CI runs and the ones that must be green. There is a
third workspace package, `tests/schemas` (`@gensim/tests-schemas`), which no
workflow invokes and which is **red on `main`**: twelve cases in
`test_port_kind_schema.ts`, `test_gsim_schema.ts` and `test_gsim_sch_schema.ts`
assert the v1 shapes their own `_v2` siblings replaced — a `gsim.schema.json`
that was deleted, a port kind that may not carry `dims`, six paradigms where
there are now seven. Do not make a green run of it a condition of your commit.
Do not add to it either, and if you fix it, fix it in its own commit.

Run the Playwright suite when the frontend changed:

```bash
pnpm e2e
```

and the real-VS-Code suite when the extension changed (it needs a display and
a solver binary):

```bash
xvfb-run -a pnpm -F ./apps/vscode-extension test:integration
```

All tests must be green before continuing. If a test was passing before your
change and is now failing, fix it — do not mark it skipped. A new test must be
watched failing before it is believed: a test that has never been red is not
known to test anything.

---

## Step 4 — Drift and invariant gates

These are cheap, and each one exists because something generated in this tree
stopped matching its source once already.

```bash
./scripts/check-invariants.sh                    # architectural invariants
pnpm -F @gensim/schemas codegen:check            # schema → TypeScript drift
node scripts/check-keymap.mjs                    # keyboard-map.md → keymap.ts
node scripts/gen-keybindings.mjs --check         # keymap → package.json keybindings
node scripts/check-gsim-wasm-fresh.mjs --check   # the committed compiler bundle
node scripts/check-waveform-wasm-fresh.mjs --check  # the committed decimator bundle
node scripts/check-examples.mjs --check          # every example still compiles
```

If a generator's output changed, commit the regenerated file **with** the
change that caused it. Never edit a generated file by hand.

---

## Step 5 — Review the diff

```bash
git diff --staged   # if already staged
git diff            # unstaged changes
git status
```

Check for:
- accidentally included files (`.env`, large binaries, generated artifacts
  that should be gitignored)
- debug prints, `console.log`, `TODO` comments introduced by you
- leftover merge-conflict markers

---

## Step 6 — Stage selectively

Add specific files. Never use `git add -A` or `git add .` without first
reviewing `git status` output.

```bash
git add path/to/file1 path/to/file2 ...
```

---

## Step 7 — Write the commit message

Follow Conventional Commits (enforced by the `commit-msg` hook):

```
<type>(<scope>): <short imperative summary>

<body — optional, explains WHY not WHAT>
<footer — breaking changes, closes #issue>
```

Types: `feat`, `fix`, `docs`, `style`, `refactor`, `perf`, `test`, `build`,
`ci`, `chore`, `revert`. Append `!` after the type for breaking changes.

Derive the message from the actual diff, not from memory of what you
intended to do.

---

## Step 8 — Commit

```bash
git commit -m "$(cat <<'EOF'
<type>(<scope>): <summary>

<body if needed>
EOF
)"
```

If the pre-commit hook modifies files (whitespace, end-of-file fixes), it
will exit non-zero. Re-stage the modified files and create a **new** commit —
never `--amend` after a hook failure.

---

## What to do when a gate fails

| Gate | Failure action |
|---|---|
| Biome | Fix the reported lines; do not suppress a rule without approval |
| Typecheck | Fix the type error; a `@ts-expect-error` needs a comment saying why |
| Tests | Fix the failing test or the code; do not skip a passing test |
| Drift gate | Regenerate and commit the output, in the same commit |
| Pre-commit hook | Re-stage hook-modified files; create a new commit |
| `commit-msg` hook | Rewrite the message to conform; do not bypass |

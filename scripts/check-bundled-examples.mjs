#!/usr/bin/env node
/**
 * Refuse to package a .vsix whose examples are not the examples.
 *
 * `media/examples/` is what **Omni Schematics: Open Example Schematic…**
 * reads; `examples/` is what every gate in this repository checks --
 * `check-examples.mjs` for the layout, the compile, the netlist and the match
 * against each `build_*.py`. They are the same five documents by convention
 * and nothing enforced it.
 *
 * They had drifted. On `main`, `pnpm package` rewrote all five: not
 * whitespace, but block positions and rotations -- the buck example's voltage
 * source sat at `[0, 140]` rotated 90° in the source and at `[0, 0]` rotated
 * 0° in the copy a user opened. So everything proved about `examples/` said
 * nothing about what shipped (#179).
 *
 * The cause was that the copy was committed. `media/frontend/` is git-ignored
 * precisely so it cannot go stale *in the repository*, with a gate refusing to
 * package a stale one; `media/examples/` was tracked, so a stale copy was the
 * committed state and `pnpm package` silently fixed it for whoever happened to
 * run it. It is git-ignored now, and this is its gate.
 *
 * Content, not timestamps. The webview bundle is compared by mtime because it
 * is a build output of thousands of files; these are five small documents that
 * are copied verbatim, so the exact question -- "is this the same file?" --
 * is cheap to ask and cannot be fooled by a touch.
 */
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const from = path.join(root, "examples");
const to = path.join(root, "apps", "vscode-extension", "media", "examples");

const hint =
  "Run `pnpm package` from the repository root, which copies them in and then packages.\n" +
  "Or, by hand:\n  pnpm bundle:examples";

const read = (file) => {
  try {
    return readFileSync(file);
  } catch {
    return null;
  }
};

const list = (dir) => {
  try {
    return readdirSync(dir)
      .filter((name) => name.endsWith(".gsim_sch"))
      .sort();
  } catch {
    return null;
  }
};

const sources = list(from);
if (sources === null || sources.length === 0) {
  console.error(`check-bundled-examples: no .gsim_sch files in\n  ${from}`);
  process.exit(1);
}

const bundled = list(to);
if (bundled === null) {
  console.error(
    `check-bundled-examples: the extension has no bundled examples at\n  ${to}\n\n${hint}`,
  );
  process.exit(1);
}

const problems = [];

for (const name of sources) {
  const want = read(path.join(from, name));
  const got = read(path.join(to, name));
  if (got === null) {
    problems.push(`${name} is in examples/ and not in the .vsix`);
    continue;
  }
  if (!want.equals(got)) {
    problems.push(
      `${name} differs: ${want.length} bytes in examples/, ${got.length} in the bundle`,
    );
  }
}

// An example deleted upstream must not linger where Open Example still offers
// it. `bundle-examples.mjs` clears the directory for this reason; the check
// holds it to that.
for (const name of bundled) {
  if (!sources.includes(name)) {
    problems.push(`${name} is in the .vsix and no longer in examples/`);
  }
}

if (problems.length > 0) {
  console.error(
    "check-bundled-examples: the examples a user opens are not the examples CI checks.",
  );
  for (const problem of problems) {
    console.error(`  ${problem}`);
  }
  console.error(`\n${hint}`);
  process.exit(1);
}

console.log(
  `check-bundled-examples: ${sources.length} example(s) in the .vsix are byte-identical to examples/`,
);

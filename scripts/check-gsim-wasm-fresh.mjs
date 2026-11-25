#!/usr/bin/env node
/**
 * Hold the committed WebAssembly engine to the engine it claims to be.
 *
 * `packages/gsim-wasm/pkg/` is a 1.7 MB binary in the source tree. It is
 * there for a good reason (see `scripts/build-gsim-wasm.mjs`) and it carries
 * the standing risk of every generated artefact that is committed: it can stop
 * matching its source and nothing says so. For this one the failure mode is
 * the worst available — the editor would compile with a *fork* of the engine,
 * silently, which is precisely the two-implementations problem issue #158
 * exists to end.
 *
 * Three arms, in increasing cost:
 *
 *   1. **integrity**, offline: every file `provenance.json` lists is present
 *      with the recorded size and SHA-256, and the exports it lists are the
 *      ones the generated `.d.ts` declares. Catches a half-copied bundle, a
 *      hand-edited glue file, and a `provenance.json` written for a build that
 *      is no longer there.
 *
 *   2. **the engine has not moved** (`--against-engine`, needs the network):
 *      the commit in `provenance.json` is the engine's default-branch HEAD.
 *      The same question `engine-catalogue-drift` asks of the catalogue, for
 *      the same reason: the copy stays a cache rather than becoming a second
 *      opinion.
 *
 *   3. **the API surface is the engine's** (also `--against-engine`): the
 *      exported names match the `#[wasm_bindgen]` items the engine declares at
 *      that commit. Arm 1 proves the bundle is self-consistent; this proves it
 *      is consistent with the engine's source.
 *
 * What no arm does is compare the `.wasm` bytes against a rebuild. Two
 * `wasm-pack` runs of the same commit agree only if the Rust toolchain,
 * `wasm-bindgen` and `wasm-opt` versions all match, so a byte comparison would
 * go red on a toolchain bump with nothing wrong — and a gate that cries wolf
 * gets deleted. What the rebuild is for instead is behaviour:
 * `scripts/check-examples.mjs --engine <dir>` compiles every example with a
 * given bundle, and CI runs it twice, once with the committed bundle and once
 * with one built fresh from the pinned commit. Identical netlists from both is
 * a stronger statement than identical bytes, and it does not depend on the
 * toolchain.
 *
 * Usage:
 *   node scripts/check-gsim-wasm-fresh.mjs                      # integrity, report
 *   node scripts/check-gsim-wasm-fresh.mjs --check              # integrity, exit 1
 *   node scripts/check-gsim-wasm-fresh.mjs --check --against-engine
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import {
  ENGINE_CRATE,
  engineDefaultBranchHead,
  exportedFunctions,
  sha256,
} from "./build-gsim-wasm.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..");
const BUNDLE = join(REPO_ROOT, "packages", "gsim-wasm");
const STRICT = process.argv.includes("--check");
const AGAINST_ENGINE = process.argv.includes("--against-engine");

const REBUILD =
  "Rebuild it with `node scripts/build-gsim-wasm.mjs` (needs wasm-pack and a Rust\n" +
  "toolchain) and commit packages/gsim-wasm/pkg and provenance.json together.";

const failures = [];
const fail = (message) => failures.push(message);

// --- arm 1: the bundle is what provenance.json says it is -------------------

const provenancePath = join(BUNDLE, "provenance.json");
if (!existsSync(provenancePath)) {
  console.error(`check-gsim-wasm-fresh: no ${provenancePath}.\n\n${REBUILD}`);
  process.exit(1);
}
const provenance = JSON.parse(readFileSync(provenancePath, "utf8"));

for (const [relative, expected] of Object.entries(provenance.files ?? {})) {
  const path = join(BUNDLE, relative);
  if (!existsSync(path)) {
    fail(`${relative} is missing but provenance.json lists it`);
    continue;
  }
  const bytes = statSync(path).size;
  if (bytes !== expected.bytes) {
    fail(`${relative} is ${bytes} bytes; provenance.json records ${expected.bytes}`);
    continue;
  }
  const digest = sha256(path);
  if (digest !== expected.sha256) {
    fail(`${relative} hashes to ${digest}; provenance.json records ${expected.sha256}`);
  }
}

const declared = exportedFunctions(join(BUNDLE, "pkg", "gsim_wasm.d.ts"));
const recorded = [...(provenance.exports ?? [])].sort();
if (declared.join(",") !== recorded.join(",")) {
  fail(
    "provenance.json's export list is not what pkg/gsim_wasm.d.ts declares.\n" +
      `  declared: ${declared.join(", ")}\n` +
      `  recorded: ${recorded.join(", ")}`,
  );
}

// The engine's own JSON-in/JSON-out surface. Named here so that a build which
// dropped `compile` — the one function the editor cannot work without — fails
// with that word in the message instead of a count.
const COMPILE_SURFACE = ["capabilities", "catalog", "compile", "loadDocument", "version"];
for (const name of COMPILE_SURFACE) {
  if (!declared.includes(name)) {
    fail(`the bundle does not export ${name}(), which the editor compiles through`);
  }
}

if (failures.length === 0) {
  const wasm = provenance.files?.["pkg/gsim_wasm_bg.wasm"];
  console.log(
    `check-gsim-wasm-fresh: ${declared.length} exports, ` +
      `${((wasm?.bytes ?? 0) / 1024) | 0} KiB of WebAssembly, ` +
      `built from ${provenance.engine?.crate} ${provenance.engine?.version} ` +
      `at ${String(provenance.engine?.commit).slice(0, 12)}.`,
  );
}

// --- arms 2 and 3: against the engine itself --------------------------------

if (AGAINST_ENGINE) {
  const head = engineDefaultBranchHead();
  if (head !== provenance.engine?.commit) {
    fail(
      "the engine's default branch has moved past the committed bundle.\n" +
        `  bundle: ${provenance.engine?.commit}\n` +
        `  engine: ${head}\n\n` +
        "The editor would compile with an engine older than the one `gsim_tools` and the\n" +
        `catalogue are generated from — the drift #158 removed. ${REBUILD}`,
    );
  }

  // The engine's source at the commit the bundle names, not at HEAD: if arm 2
  // has already failed, this should still report on the bundle's own commit.
  const source = await engineSource(provenance.engine?.commit);
  if (source !== null) {
    const names = engineExports(source);
    if (names.join(",") !== declared.join(",")) {
      fail(
        `the bundle's exports are not the ones ${ENGINE_CRATE}/src/lib.rs declares at ` +
          `${String(provenance.engine?.commit).slice(0, 12)}.\n` +
          `  bundle: ${declared.join(", ")}\n` +
          `  engine: ${names.join(", ")}\n\n${REBUILD}`,
      );
    } else {
      console.log(
        `check-gsim-wasm-fresh: the engine declares the same ${names.length} exports at that commit.`,
      );
    }
  }
}

/** The engine's wasm crate source at `commit`, or null if it cannot be read. */
async function engineSource(commit) {
  if (!/^[0-9a-f]{40}$/.test(String(commit))) {
    fail(`provenance.json's engine.commit is not a commit sha: ${commit}`);
    return null;
  }
  const url = `https://raw.githubusercontent.com/GLODI-Engineering/gsim-core/${commit}/${ENGINE_CRATE}/src/lib.rs`;
  const response = await fetch(url);
  if (!response.ok) {
    fail(`could not read the engine's ${ENGINE_CRATE}/src/lib.rs at ${commit}: ${response.status}`);
    return null;
  }
  return response.text();
}

/**
 * The names `#[wasm_bindgen]` exports from the engine's crate source.
 *
 * An attribute may rename the function (`#[wasm_bindgen(js_name = compile)]`
 * on `pub fn compile`, `js_name = loadDocument` on `pub fn load_document`), so
 * the JS name is the renamed one when there is one and the Rust name
 * otherwise. Functions inside `#[cfg(test)] mod tests` carry no attribute, so
 * they do not appear.
 */
function engineExports(source) {
  const names = new Set();
  const pattern = /#\[wasm_bindgen(?:\(([^)]*)\))?\]\s*(?:#\[[^\]]*\]\s*)*pub fn (\w+)/g;
  for (const [, attributes, rustName] of source.matchAll(pattern)) {
    const renamed = attributes?.match(/js_name\s*=\s*([\w$]+)/);
    names.add(renamed ? renamed[1] : rustName);
  }
  return [...names].sort();
}

console.log("");
if (failures.length > 0) {
  for (const failure of failures) {
    console.error(`check-gsim-wasm-fresh: ${failure}`);
  }
  console.error(`\ncheck-gsim-wasm-fresh: ${failures.length} problem(s).`);
  process.exit(STRICT ? 1 : 0);
}

#!/usr/bin/env node
/**
 * Hold the committed decimator bundle to the crate it was built from.
 *
 * `packages/waveform-wasm/pkg/` is a 203 KB binary in the source tree. It is
 * there for the reason `scripts/build-waveform-wasm.mjs` gives, and it
 * carries the standing risk of every committed generated artefact: it can
 * stop matching its source and nothing says so. For this one the failure mode
 * is the one #157 exists to end — the viewer drawing a window with a
 * *different* decimator from the one the crate's tests assert, so a trace
 * changes shape depending on which copy produced it and a disagreement
 * between the browser and the server is indistinguishable from a bug in the
 * simulation.
 *
 * Two arms, both **offline**, which is the difference from
 * `check-gsim-wasm-fresh.mjs`:
 *
 *   1. **integrity**: every file `provenance.json` lists is present with the
 *      recorded size and SHA-256, the exports it lists are the ones the
 *      generated `.d.ts` declares, and the names the viewer reads through are
 *      among them. Catches a half-copied bundle, a hand-edited glue file, and
 *      a `provenance.json` written for a build that is no longer there.
 *
 *   2. **the crate has not moved**: `Cargo.toml`, `Cargo.lock` and every file
 *      under `crates/waveform-store/src/` hash to what `provenance.json`
 *      recorded. The engine's bundle has to ask a remote branch this question
 *      over the network; this crate is in the same repository, so the answer
 *      is here, exact, and arrives in the same commit that changed the crate
 *      rather than whenever someone pushes. A failure names the files that
 *      moved, because "rebuild it" is useless without "because you edited
 *      decimate.rs".
 *
 * What neither arm does is compare the `.wasm` bytes against a rebuild. Two
 * `wasm-pack` runs of the same sources agree only if the Rust toolchain,
 * `wasm-bindgen` and `wasm-opt` versions all match, so a byte comparison
 * would go red on a toolchain bump with nothing wrong — and a gate that cries
 * wolf gets deleted. What the rebuild is for instead is behaviour: the
 * frontend's own tests run every assertion about reduction *through this
 * bundle* (`apps/frontend/src/test-setup.ts` loads it), so a bundle that does
 * not reduce the way the crate's `cargo test` says it does fails the
 * `frontend` job rather than this one.
 *
 * Usage:
 *   node scripts/check-waveform-wasm-fresh.mjs           # report
 *   node scripts/check-waveform-wasm-fresh.mjs --check   # exit 1
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import {
  CRATE_DIR,
  REQUIRED_EXPORTS,
  crateSources,
  exportedSymbols,
  sha256,
  sourceDigest,
} from "./build-waveform-wasm.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..");
const BUNDLE = join(REPO_ROOT, "packages", "waveform-wasm");
const STRICT = process.argv.includes("--check");

const REBUILD =
  "Rebuild it with `node scripts/build-waveform-wasm.mjs` (needs wasm-pack and a Rust\n" +
  "toolchain) and commit packages/waveform-wasm/pkg and provenance.json together.";

const failures = [];
const fail = (message) => failures.push(message);

const provenancePath = join(BUNDLE, "provenance.json");
if (!existsSync(provenancePath)) {
  console.error(`check-waveform-wasm-fresh: no ${provenancePath}.\n\n${REBUILD}`);
  process.exit(1);
}
const provenance = JSON.parse(readFileSync(provenancePath, "utf8"));

// --- arm 1: the bundle is what provenance.json says it is -------------------

for (const [relativePath, expected] of Object.entries(provenance.files ?? {})) {
  const path = join(BUNDLE, relativePath);
  if (!existsSync(path)) {
    fail(`${relativePath} is missing but provenance.json lists it`);
    continue;
  }
  const bytes = statSync(path).size;
  if (bytes !== expected.bytes) {
    fail(`${relativePath} is ${bytes} bytes; provenance.json records ${expected.bytes}`);
    continue;
  }
  const digest = sha256(path);
  if (digest !== expected.sha256) {
    fail(`${relativePath} hashes to ${digest}; provenance.json records ${expected.sha256}`);
  }
}

const dts = join(BUNDLE, "pkg", "waveform_store.d.ts");
let declared = [];
if (existsSync(dts)) {
  declared = exportedSymbols(dts);
  const recorded = [...(provenance.exports ?? [])].sort();
  if (declared.join(",") !== recorded.join(",")) {
    fail(
      "provenance.json's export list is not what pkg/waveform_store.d.ts declares.\n" +
        `  declared: ${declared.join(", ")}\n` +
        `  recorded: ${recorded.join(", ")}`,
    );
  }
  for (const name of REQUIRED_EXPORTS) {
    if (!declared.includes(name)) {
      fail(`the bundle does not export ${name}, which the viewer reads through`);
    }
  }
} else {
  fail("pkg/waveform_store.d.ts is missing, so the bundle exports nothing readable");
}

// --- arm 2: the crate has not moved under the bundle ------------------------

const sources = crateSources(CRATE_DIR);
const digest = sourceDigest(sources);
if (digest !== provenance.crate?.source_digest) {
  const recorded = provenance.crate?.sources ?? {};
  const moved = [];
  for (const [path, hash] of Object.entries(sources)) {
    if (recorded[path] === undefined) moved.push(`${path} (new)`);
    else if (recorded[path] !== hash) moved.push(`${path} (changed)`);
  }
  for (const path of Object.keys(recorded)) {
    if (sources[path] === undefined) moved.push(`${path} (deleted)`);
  }
  fail(
    "crates/waveform-store has changed since the bundle was built.\n" +
      `${moved.map((entry) => `  ${entry}`).join("\n")}\n\n` +
      "The viewer would decimate with an older build of the crate than the one `cargo test`\n" +
      `checks — the two-implementations problem #157 removed, wearing a different hat. ${REBUILD}`,
  );
}

if (failures.length === 0) {
  const wasm = provenance.files?.["pkg/waveform_store_bg.wasm"];
  console.log(
    `check-waveform-wasm-fresh: ${declared.length} exports, ` +
      `${((wasm?.bytes ?? 0) / 1024) | 0} KiB of WebAssembly, ` +
      `built from ${provenance.crate?.path} ${provenance.crate?.version} ` +
      `at source digest ${String(digest).slice(0, 12)} ` +
      `(${Object.keys(sources).length} files).`,
  );
  process.exit(0);
}

for (const failure of failures) {
  console.error(`check-waveform-wasm-fresh: ${failure}`);
}
console.error(`\ncheck-waveform-wasm-fresh: ${failures.length} problem(s).`);
process.exit(STRICT ? 1 : 0);

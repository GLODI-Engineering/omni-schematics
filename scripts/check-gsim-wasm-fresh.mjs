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
 *   2. **the engine's code has not moved** (`--against-engine`, needs the
 *      network): the engine files the bundle is built from have the same
 *      content now as when it was built, and the bundle really was built from
 *      the commit it names. Not *"the pinned commit is HEAD"* -- that was the
 *      question until #280, and it reddened this repository three times on
 *      2026-11-26, once for a decision record. A gate that is red for reasons
 *      unrelated to the change in front of you teaches people to merge past
 *      it. `ENGINE_CODE_PATHS` in `build-gsim-wasm.mjs` says which files
 *      count and why.
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
  ENGINE_CODE_PATHS,
  ENGINE_CRATE,
  changedPaths,
  engineCodeFingerprint,
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
  await checkEngineCode();

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

/**
 * The bundle is built from the engine's current code, and from the commit it claims.
 *
 * Two comparisons, both over content rather than commit identity (#280):
 *
 *   recorded vs the pinned commit   the bundle really was built from those sources, so a
 *                                   `provenance.json` cannot name a commit it was not built
 *                                   from -- including a build from a dirty checkout, which the
 *                                   build script marks and this refuses outright
 *   recorded vs the engine's HEAD   no engine file has changed content since, whatever else
 *                                   merged over there
 *
 * The second is the one #280 is about. A docs merge, a journal entry, a netlist regeneration or
 * a decision record moves HEAD and changes none of these files, so this stays green -- while an
 * actual engine change still reds it, naming the files that moved rather than two commit shas.
 */
async function checkEngineCode() {
  const recorded = provenance.engine?.code_fingerprint;
  if (typeof recorded?.digest !== "string") {
    fail(
      "provenance.json records no engine code fingerprint, so there is nothing to compare the\n" +
        `engine's code against. It was written before #280. ${REBUILD}`,
    );
    return;
  }
  if (Array.isArray(recorded.dirty) && recorded.dirty.length > 0) {
    fail(
      `the bundle was built from a checkout with ${recorded.dirty.length} uncommitted engine ` +
        `file(s):\n  ${recorded.dirty.join("\n  ")}\n\n` +
        "So no commit describes what is in the binary, and a fingerprint read out of git cannot\n" +
        `see the difference. Commit the engine change, then rebuild. ${REBUILD}`,
    );
    return;
  }
  // The selection itself is part of the claim: a digest over a different set of paths is not
  // comparable with this one, so changing ENGINE_CODE_PATHS requires a rebuild rather than
  // silently comparing two different questions.
  const inputs = [...(recorded.inputs ?? [])].sort().join(",");
  if (inputs !== [...ENGINE_CODE_PATHS].sort().join(",")) {
    fail(
      "provenance.json's fingerprint covers a different set of engine paths than this script\n" +
        "now uses, so the two digests are not comparable.\n" +
        `  recorded: ${(recorded.inputs ?? []).join(", ")}\n` +
        `  now:      ${ENGINE_CODE_PATHS.join(", ")}\n\n${REBUILD}`,
    );
    return;
  }

  const pinnedBlobs = await engineBlobs(provenance.engine?.commit);
  if (pinnedBlobs !== null) {
    const pinned = engineCodeFingerprint(pinnedBlobs);
    if (pinned.digest !== recorded.digest) {
      fail(
        `the bundle does not match the engine code at ${short(provenance.engine?.commit)}, the ` +
          "commit it says it was built from.\n" +
          `  recorded: ${short(recorded.digest)} over ${recorded.paths} path(s)\n` +
          `  that commit: ${short(pinned.digest)} over ${pinned.paths} path(s)\n\n` +
          "Either provenance.json was hand-edited or the bundle was built from something else.\n" +
          REBUILD,
      );
    }
  }

  const head = engineDefaultBranchHead();
  if (head === provenance.engine?.commit) {
    console.log(`check-gsim-wasm-fresh: the engine's default branch is still ${short(head)}.`);
    return;
  }
  const headBlobs = await engineBlobs(head);
  if (headBlobs === null) return;
  const current = engineCodeFingerprint(headBlobs);
  if (current.digest === recorded.digest) {
    console.log(
      `check-gsim-wasm-fresh: the engine's default branch has moved to ${short(head)} and not ` +
        `one of the ${recorded.paths} files the bundle is built from changed.`,
    );
    return;
  }
  const moved = changedPaths(engineCodeFingerprint(pinnedBlobs ?? headBlobs).blobs, current.blobs);
  fail(
    `the engine's code has moved past the committed bundle.\n` +
      `  bundle: ${short(provenance.engine?.commit)}  ${short(recorded.digest)}\n` +
      `  engine: ${short(head)}  ${short(current.digest)}\n` +
      `${moved.map((line) => `  ${line}`).join("\n")}\n\n` +
      "The editor would compile with an engine older than the one `gsim_tools` and the\n" +
      `catalogue are generated from — the drift #158 removed. ${REBUILD}`,
  );
}

/** A function declaration, not a const: `checkEngineCode` runs before this line is reached. */
function short(sha) {
  return String(sha).slice(0, 12);
}

/**
 * Every blob in the engine's tree at `commit`, from the GitHub API, or null.
 *
 * The blob shas are git's own content hashes, which is what makes them comparable with the
 * `git ls-tree` the build script fingerprints from: nothing here hashes a file itself, so no
 * line ending or encoding decision can creep in between the two sides.
 *
 * A truncated tree fails rather than being used. The answer would be a digest over some of the
 * files, which would differ from the recorded one for a reason that has nothing to do with the
 * engine -- a gate that cannot do its job must say so, not guess.
 */
async function engineBlobs(commit) {
  if (!/^[0-9a-f]{40}$/.test(String(commit))) {
    fail(`provenance.json's engine.commit is not a commit sha: ${commit}`);
    return null;
  }
  const url = `https://api.github.com/repos/GLODI-Engineering/gsim-core/git/trees/${commit}?recursive=1`;
  const token = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN ?? null;
  const response = await fetch(url, {
    headers: {
      Accept: "application/vnd.github+json",
      "User-Agent": "omni-schematics-freshness-gate",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
  });
  if (!response.ok) {
    fail(
      `could not read the engine's tree at ${short(commit)}: ${response.status} ${response.statusText}.\n` +
        (response.status === 403 || response.status === 429
          ? "The GitHub API rate limit for unauthenticated requests is 60 an hour; set GH_TOKEN."
          : "gsim-core is public, so this needs no credentials."),
    );
    return null;
  }
  const body = await response.json();
  if (body.truncated) {
    fail(
      `the engine's tree at ${short(commit)} came back truncated, so a fingerprint over it ` +
        "would cover only some of the files and differ for a reason unrelated to the engine.",
    );
    return null;
  }
  return (body.tree ?? [])
    .filter((entry) => entry.type === "blob")
    .map((entry) => ({ path: entry.path, sha: entry.sha }));
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

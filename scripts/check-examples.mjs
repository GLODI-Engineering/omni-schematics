#!/usr/bin/env node
/**
 * Example-schematic staleness check.
 *
 * An example is the one artefact whose entire purpose is to work the first time
 * someone opens it, and it was the only one with no test holding it to that.
 * When this check was first written, `examples/buck_converter.gsim_sch` -- the
 * sole example in the repository -- already used a block type the engine no
 * longer declares, and nothing had noticed.
 *
 * Five things are checked per file in `examples/`:
 *
 *   1. it parses as a `.gsim_sch` document with blocks in it;
 *   2. every block type resolves in the engine catalogue, by name or alias;
 *   3. every resolved type is one the engine says it can compile;
 *   4. the editor's own loader accepts it (the generated schema validator the
 *      webview itself loads);
 *   5. it compiles, **to the netlist byte for byte**, and emits exactly the
 *      compiler notes recorded in `examples/expected-netlists/`;
 *   6. the committed file matches what its generating script emits, when it has
 *      one -- the same shape as gsim-core's `examples-still-emit-what-they-
 *      emitted` job.
 *
 * ## Why arm 5 is the whole point now, and what it replaced
 *
 * Two arms used to live where arm 5 is. One compiled with `gsim_py` and counted
 * the netlist's lines; the other asked
 * `simulator.compiler.compile_input.prepare_document` whether every wire landed
 * on a port the engine declares. The second existed because the first reached
 * the compiler by a route the product did not take: the product went through
 * `simulator.compiler.gsim_py_netlist`, this script went straight to `gsim_py`,
 * and a transform on only one of those routes is invisible to the other by
 * construction. #143 was exactly that -- a port respelling on the product's
 * side turned every example into `floating-port` at Run time while this script
 * reported five examples OK.
 *
 * There is no second route left to reconcile (#158). The editor compiles with
 * `gsim-core` built to WebAssembly, through `packages/gsim-wasm/compile.js`,
 * and this script imports *that file*. Nothing is between a document and the
 * compiler on either side, so there is nothing for a transform to hide in --
 * and the undeclared-port arm is gone because the thing it guarded against
 * cannot exist any more. What it is replaced by is stronger: a count of netlist
 * lines could not tell a correct netlist from a differently-wrong one of the
 * same length, and the expectations under `examples/expected-netlists/` can.
 *
 * Those expectations were captured from the Python path as it stood on `main`
 * before #158 -- `compile_gsim_document_full`, with `gsim_py` built from
 * gsim-core 0.6.0 -- so "the same netlist as today" is a fact about this file
 * and not a claim about it. See `examples/expected-netlists/README.md`.
 *
 * No Python is needed for arms 1-5. Arm 6 runs the generators, which author
 * documents in Python with `gsim-tools`; without them it says so rather than
 * failing.
 *
 * Usage:
 *   node scripts/check-examples.mjs --check     # exit 1 on any failure
 *   node scripts/check-examples.mjs            # report, exit 0
 *   node scripts/check-examples.mjs --check --engine /tmp/fresh-bundle
 *       # compile with a bundle built elsewhere -- what `gsim-wasm-drift` uses
 *       # to prove the committed bundle is what the pinned engine commit emits
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { fileURLToPath } from "node:url";

// The editor's own generated validator, loaded dynamically rather than with a
// static `import` so that a checkout which has not run codegen yet gets a named
// reason from the arm below instead of this whole script failing to load.
let validateDocument = null;
try {
  ({ validateGsimSchDocument: validateDocument } = await import(
    "../apps/frontend/src/generated/validators/gsim-sch.js"
  ));
} catch {
  validateDocument = null;
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..");
const STRICT = process.argv.includes("--check");

const EXAMPLES_DIR = join(REPO_ROOT, "examples");
const EXPECTED_DIR = join(EXAMPLES_DIR, "expected-netlists");
const CATALOG = join(REPO_ROOT, "apps", "frontend", "src", "library", "engine-catalog.json");

/** Which WebAssembly bundle to compile with; the committed one unless told otherwise. */
function engineDir() {
  const index = process.argv.indexOf("--engine");
  return index >= 0 && process.argv[index + 1]
    ? resolve(process.argv[index + 1])
    : join(REPO_ROOT, "packages", "gsim-wasm");
}

/**
 * The interpreter that has `gsim_tools` and `gsim_py` in it.
 *
 * Needed by arm 6 alone -- the example generators author their documents in
 * Python. `python3` on PATH is almost never the right one: the engine bindings
 * live in this workspace's venv, and `gsim_py` is a compiled extension that has
 * to be built. Preference order mirrors `gen-engine-catalog.mjs`: an explicit
 * `GSIM_PYTHON`, then the workspace venv, then PATH.
 */
function enginePython() {
  if (process.env.GSIM_PYTHON) {
    return process.env.GSIM_PYTHON;
  }
  for (const candidate of [
    join(REPO_ROOT, ".venv", "bin", "python"),
    join(REPO_ROOT, ".venv", "Scripts", "python.exe"),
  ]) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  return "python3";
}

const PYTHON = enginePython();

/**
 * Do the document's wires name ports the engine actually declares?
 *
 * This question used to have an arm of its own, asked of the product's own
 * preparation step in Python. It is now answered by the compile arm itself and
 * by nothing else, because the compile arm *is* the product's route: the engine
 * answers `floating-port` naming the wire, which is a better message than the
 * one this script used to build. Kept as a note rather than deleted silently,
 * because the lesson is about routes and not about ports -- put nothing between
 * a document and the compiler, on either side, and there is nothing to
 * reconcile.
 */

/**
 * Does the editor's own loader accept this document?
 *
 * This is the arm whose absence let every example ship unopenable. Arms 1-3 read
 * the document with `JSON.parse` and ask the catalogue about its blocks; the
 * compile arm asks the engine. Neither is the code the editor runs when a user
 * opens a file, and the editor is stricter than both -- it validates against
 * `packages/schemas/definitions/model/gsim_sch.schema.json`, which requires
 * fields the engine is content to omit and pins a block's paradigm to its type
 * prefix.
 *
 * All five examples failed it two ways at once while this script reported
 * "5 example(s) OK":
 *
 *   /model/blocks/8/paradigm: must be equal to constant
 *   /model/wires/0: must have required property 'net'
 *
 * The validator used here is the generated one the webview itself loads -- not a
 * reimplementation, and not `ajv.compile()` at runtime, which the webview's CSP
 * forbids. It is plain JavaScript with no dependencies, so unlike arm 6 this one
 * needs nothing installed and only degrades to `ok: null` if codegen has never
 * been run.
 */
function loadsInTheEditor(documentPath) {
  if (validateDocument === null) {
    return {
      ok: null,
      reason: "the generated validator is missing; run `pnpm --filter ./apps/frontend codegen`",
    };
  }
  let document;
  try {
    document = JSON.parse(readFileSync(documentPath, "utf8"));
  } catch (error) {
    return { ok: false, reason: `is not JSON — ${error.message}` };
  }
  if (validateDocument(document)) {
    return { ok: true };
  }
  // Every distinct error, not just the first. `validateModelDocument` throws on
  // the first one, which is right for a user opening a file and wrong for a gate:
  // fixing the paradigm only to be told about `net` on the next run is two cycles
  // where one would do, and that is exactly how this went by hand.
  const seen = new Set(
    (validateDocument.errors ?? []).map(
      (error) => `${error.instancePath || "/"}: ${error.message}`,
    ),
  );
  return {
    ok: false,
    reason: seen.size > 0 ? [...seen].join("; ") : "failed schema validation with no message",
  };
}

/**
 * Compile with the engine, and hold the result to the byte.
 *
 * The netlist is the product. "It compiles" is a far weaker statement than "it
 * compiles to this", and the gap between them is where a change to the engine,
 * to an example, or to this repository's own preparation of a document goes
 * unnoticed: a netlist with the wrong reference node, a parameter silently
 * defaulted, a `.model` card dropped, all still compile and all still have
 * about the same number of lines.
 *
 * The notes are held to the byte too. They are the decisions the compiler made
 * *for* the user -- the DC references it adds for nodes nothing else ties down
 * -- and an unreferenced node does not fail a solve, it returns a different
 * answer. A note appearing or disappearing is therefore a change in what the
 * circuit means, which is exactly the class of change an expectation file is
 * for.
 */
function compilesToTheExpectedNetlist(engine, compileDocument, name, documentPath) {
  const expectedNetlist = join(EXPECTED_DIR, `${name}.net`);
  const expectedNotes = join(EXPECTED_DIR, `${name}.notes.txt`);
  if (!existsSync(expectedNetlist) || !existsSync(expectedNotes)) {
    return {
      ok: false,
      reason:
        "has no recorded expectation. Compile it and commit the result:\n" +
        `      ${expectedNetlist}\n      ${expectedNotes}\n` +
        "    See examples/expected-netlists/README.md.",
    };
  }

  let result;
  try {
    result = compileDocument(engine, readFileSync(documentPath, "utf8"));
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }

  const problems = [];
  const netlist = readFileSync(expectedNetlist, "utf8");
  if (result.netlist !== netlist) {
    problems.push(
      `the netlist differs from ${name}.net${firstDifference(netlist, result.netlist)}`,
    );
  }
  const notes = readFileSync(expectedNotes, "utf8");
  const actualNotes = result.notes.map((note) => `${note}\n`).join("");
  if (actualNotes !== notes) {
    problems.push(
      `the compiler notes differ from ${name}.notes.txt\n` +
        `      expected ${notes.split("\n").filter(Boolean).length}, got ${result.notes.length}` +
        result.notes.map((note) => `\n        + ${note}`).join(""),
    );
  }
  if (problems.length > 0) {
    return { ok: false, reason: problems.join("\n    ") };
  }
  const lines = result.netlist.split("\n").filter((line) => line.trim() && !line.startsWith("*"));
  return { ok: true, lines: lines.length, notes: result.notes.length };
}

/** Where two texts first diverge, as a line number and the two lines. */
function firstDifference(expected, actual) {
  const a = expected.split("\n");
  const b = actual.split("\n");
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    if (a[i] !== b[i]) {
      return (
        `, first at line ${i + 1}:\n` +
        `      expected: ${a[i] === undefined ? "(end of netlist)" : JSON.stringify(a[i])}\n` +
        `      actual:   ${b[i] === undefined ? "(end of netlist)" : JSON.stringify(b[i])}`
      );
    }
  }
  return "";
}

/**
 * Every name the catalogue answers to, and whether the engine can compile it.
 *
 * Hyphens and underscores are both normalised away because the catalogue, the
 * saved documents and the symbol registry do not agree on which to use --
 * `physical-electrical.*` and `physical_electrical.*` are the same type, and a
 * checker that treated them as different would reject correct examples.
 */
function loadCatalog() {
  const entries = JSON.parse(readFileSync(CATALOG, "utf8"));
  const canonical = new Map();
  const aliases = new Map();
  for (const entry of entries) {
    const meta = entry.metadata ?? {};
    if (typeof meta.name !== "string" || meta.name.length === 0) {
      continue;
    }
    canonical.set(normalise(meta.name), { compilable: meta.compilable === true, name: meta.name });
    for (const alias of meta.aliases ?? []) {
      if (typeof alias === "string" && alias.length > 0 && !aliases.has(normalise(alias))) {
        aliases.set(normalise(alias), meta.name);
      }
    }
  }
  return { canonical, aliases };
}

const normalise = (key) => key.replace(/-/g, "_");

/** Block types used by a document, in first-seen order. */
function blockTypes(doc) {
  const blocks = doc?.model?.blocks ?? doc?.blocks ?? [];
  const seen = [];
  for (const block of blocks) {
    if (typeof block?.type === "string" && !seen.includes(block.type)) {
      seen.push(block.type);
    }
  }
  return seen;
}

/**
 * Re-run the generator and compare, when one exists.
 *
 * The generator is found by convention: `build_<name>.py` beside the document.
 * Its interface is `build_<name>.py <output-path>` -- it writes the document to
 * the path given and uses stdout for a human-readable log. Passing a flag
 * instead of a path makes it write a file named after the flag and print that
 * log, which the first version of this checker then compared against the
 * document and reported as drift. The generator was right and the checker was
 * wrong; writing the contract down here so the next reader does not repeat it.
 */
function regenerates(name, documentPath, failures) {
  const script = join(EXAMPLES_DIR, `build_${name}.py`);
  if (!existsSync(script)) {
    return "no generator";
  }
  const committed = readFileSync(documentPath, "utf8");
  const scratch = join(mkdtempSync(join(tmpdir(), "gsim-examples-")), `${name}.gsim_sch`);
  try {
    execFileSync(PYTHON, [script, scratch], {
      cwd: EXAMPLES_DIR,
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    // A generator that cannot run is not evidence the document is wrong, and
    // saying so plainly beats failing the example for it.
    return `generator did not run (${String(error.message ?? error).split("\n")[0]})`;
  }
  if (!existsSync(scratch)) {
    return "generator wrote nothing to the path it was given";
  }
  if (normaliseJson(readFileSync(scratch, "utf8")) !== normaliseJson(committed)) {
    failures.push(`${name}: the committed document differs from what build_${name}.py emits`);
    return "DRIFTED";
  }
  return "matches its generator";
}

/** Compare as data, so formatting and key order cannot fail an example. */
function normaliseJson(text) {
  try {
    return JSON.stringify(sortKeys(JSON.parse(text)));
  } catch {
    return text;
  }
}

function sortKeys(value) {
  if (Array.isArray(value)) {
    return value.map(sortKeys);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, sortKeys(value[key])]),
    );
  }
  return value;
}

// ---------------------------------------------------------------------------

const ENGINE_DIR = engineDir();
let engine = null;
let compileDocument = null;
let engineReason = "";
try {
  const loader = await import(pathToFileURL(join(ENGINE_DIR, "node.js")).href);
  engine = await loader.loadEngine();
  compileDocument = loader.compileDocument;
} catch (error) {
  engineReason = error instanceof Error ? error.message : String(error);
}

const { canonical, aliases } = loadCatalog();
const files = readdirSync(EXAMPLES_DIR)
  .filter((name) => name.endsWith(".gsim_sch"))
  .sort();

if (files.length === 0) {
  console.error("check-examples: no .gsim_sch files in examples/");
  process.exit(STRICT ? 1 : 0);
}

const failures = [];

// The engine is not optional. Every arm that matters compiles, the bundle is
// committed, and loading it needs nothing installed -- so "no engine" is a
// broken checkout, not a reduced-capability one, and reporting it as a skip
// would turn this whole script into a check that cannot fail.
if (engine === null) {
  failures.push(
    `the WebAssembly engine at ${ENGINE_DIR} did not load — ${engineReason}\n` +
      "  Rebuild it with `node scripts/build-gsim-wasm.mjs`, or check it with\n" +
      "  `node scripts/check-gsim-wasm-fresh.mjs --check`.",
  );
} else {
  console.log(`engine: gsim-core ${engine.version()} (WebAssembly, ${ENGINE_DIR})`);
}

for (const file of files) {
  const name = file.replace(/\.gsim_sch$/, "");
  const path = join(EXAMPLES_DIR, file);
  console.log(`\n${file}`);

  let doc;
  try {
    doc = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    failures.push(`${name}: not valid JSON — ${error.message}`);
    console.log("  ✗ does not parse");
    continue;
  }

  const types = blockTypes(doc);
  if (types.length === 0) {
    failures.push(`${name}: the document has no blocks`);
    console.log("  ✗ no blocks");
    continue;
  }

  for (const type of types) {
    const hit = canonical.get(normalise(type));
    if (hit) {
      if (hit.compilable) {
        console.log(`  ✓ ${type}`);
      } else {
        failures.push(`${name}: block type "${type}" is not compilable by the engine`);
        console.log(`  ✗ ${type} — in the catalogue but not compilable`);
      }
      continue;
    }

    // An alias is not good enough, and this is the subtle one. Aliases resolve
    // in the catalogue and in the symbol registry, so a sheet using one looks
    // entirely correct in the palette -- and the netlist emitter rejects them:
    //
    //   unknown-type: block 'vin' has type
    //   'physical-electrical.source.voltage_dc', which no netlist emitter knows
    //
    // The previous buck example used two such spellings and a catalogue-only
    // check passed it. Examples use canonical names.
    const canonicalName = aliases.get(normalise(type));
    if (canonicalName) {
      failures.push(
        `${name}: block type "${type}" is an alias of "${canonicalName}"; the netlist ` +
          "emitter only accepts the canonical name",
      );
      console.log(`  ✗ ${type} — alias of ${canonicalName}, not accepted by the emitter`);
    } else {
      failures.push(`${name}: block type "${type}" is not in the engine catalogue`);
      console.log(`  ✗ ${type} — not in the catalogue`);
    }
  }

  const loads = loadsInTheEditor(path);
  if (loads.ok === true) {
    console.log("  · opens in the editor (passes the document schema)");
  } else if (loads.ok === null) {
    console.log(`  · not validated (${loads.reason})`);
  } else {
    failures.push(`${name}: the editor cannot open it — ${loads.reason}`);
    console.log(`  ✗ the editor cannot open it — ${loads.reason}`);
  }

  if (engine !== null) {
    const compiled = compilesToTheExpectedNetlist(engine, compileDocument, name, path);
    if (compiled.ok) {
      console.log(
        "  · compiles to the recorded netlist, byte for byte " +
          `(${compiled.lines} lines, ${compiled.notes} note(s))`,
      );
    } else {
      failures.push(`${name}: ${compiled.reason}`);
      console.log(`  ✗ ${compiled.reason}`);
    }
  }

  console.log(`  · ${regenerates(name, path, failures)}`);
}

// An expectation with no example is a file nothing holds to anything, and the
// likeliest reason for one is an example renamed or deleted without its
// expectation -- after which this script would happily report everything OK.
if (existsSync(EXPECTED_DIR)) {
  const documented = new Set(files.map((file) => file.replace(/\.gsim_sch$/, "")));
  for (const file of readdirSync(EXPECTED_DIR).sort()) {
    const name = file.replace(/\.(net|notes\.txt)$/, "");
    if (name !== file && !documented.has(name)) {
      failures.push(
        `expected-netlists/${file} has no examples/${name}.gsim_sch — delete it or restore the example`,
      );
    }
  }
}

console.log("");
if (failures.length > 0) {
  for (const failure of failures) {
    console.error(`check-examples: ${failure}`);
  }
  console.error(`\ncheck-examples: ${failures.length} problem(s) in ${files.length} example(s).`);
  process.exit(STRICT ? 1 : 0);
}
console.log(`check-examples: ${files.length} example(s) OK.`);

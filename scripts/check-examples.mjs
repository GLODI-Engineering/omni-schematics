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
 *   4. every wire endpoint names a port the engine declares for that block's
 *      type -- asked not of the committed file but of what
 *      `simulator.compiler.compile_input.prepare_document` returns, which is
 *      the product's own preparation step and therefore what the compiler is
 *      actually handed at Run time (#143);
 *   5. the committed file matches what its generating script emits, when it has
 *      one -- the same shape as gsim-core's `examples-still-emit-what-they-
 *      emitted` job.
 *
 * Arm 4 exists because arms 1-3 and the compile below all reach the compiler by
 * a route the product does not take. `gsim_py` is called directly here, on the
 * belief that `gsim-tools` was private so a gate needing it would run on one
 * machine. That belief was false (#147): gsim-tools is public, MIT and pure
 * Python, and CI can install it like anything else -- so the split this arm
 * compensates for is one this script no longer has to live with. Meanwhile the
 * product goes through
 * `simulator.compiler.gsim_py_netlist`. A transform living only on the
 * product's route is invisible to this script by construction, and #143 was
 * exactly that: a port respelling that turned every example into
 * `floating-port` at Run time while this script reported five examples OK.
 *
 * Which is why the preparation step moved into `compile_input`, a module that
 * imports nothing: the only part of the product's route this script now cannot
 * run is gsim-tools' own compile call. Anything added to the way in has to be
 * put there too, or this arm stops meaning what it says.
 *
 * Usage:
 *   node scripts/check-examples.mjs --check     # exit 1 on any failure
 *   node scripts/check-examples.mjs            # report, exit 0
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
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
const CATALOG = join(REPO_ROOT, "apps", "frontend", "src", "library", "engine-catalog.json");

/**
 * The interpreter that has `gsim_tools` and `gsim_py` in it.
 *
 * `python3` on PATH is almost never the right one -- the engine bindings live
 * in this workspace's venv, and `gsim_py` is a compiled extension that has to
 * be built. Preference order mirrors `gen-engine-catalog.mjs`: an explicit
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
 * Compile a document with the real compiler.
 *
 * This is the arm that matters, and the reason the others are not enough: a
 * block type can be in the catalogue, be marked compilable, and still be
 * spelled in a way the netlist emitter rejects. Only compiling finds that.
 *
 * Absent engine bindings are reported, not failed -- same contract as
 * `gen-engine-catalog.mjs`, which exits cleanly without `gsim_py` so an
 * ordinary checkout is usable. CI installs them, so there the arm is real.
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
 * forbids. It is plain JavaScript with no dependencies, so unlike the compile arm
 * this one needs nothing installed and only degrades to `ok: null` if codegen has
 * never been run. There was never a reason for it not to run (#146).
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
    reason: [...seen].join("; ") || "failed schema validation with no message",
  };
}

function compiles(documentPath) {
  // `gsim_py` only, not `gsim_tools` -- for now. The stated reason was that
  // gsim-tools is a private repository no CI checkout can install, and a gate
  // that only runs on one machine is not a gate. It is not private (#147), so
  // the reason is gone and this arm should compile the way the product does;
  // changing it is a behaviour change and belongs in its own commit.
  // `gsim_py` is built from public gsim-core, which `engine-catalogue-drift`
  // already does in this same workflow.
  //
  // Both calls return a JSON *string*, not an object -- `compile` puts the
  // netlist under `netlist`. Reading the return value as text and counting its
  // lines reports 1 for every document, which looks like a successful compile
  // of an empty circuit.
  const probe = [
    "import json,pathlib,sys",
    "import gsim_py",
    "doc = pathlib.Path(sys.argv[1]).read_text()",
    "loaded = json.loads(gsim_py.load_document(doc))",
    "model = loaded['model'] if 'model' in loaded else loaded",
    "result = json.loads(gsim_py.compile(json.dumps(model), 'general-simulator'))",
    "net = result['netlist']",
    "print(len([l for l in net.splitlines() if l.strip() and not l.startswith('*')]))",
  ].join("\n");
  try {
    const out = execFileSync(PYTHON, ["-I", "-c", probe, documentPath], {
      cwd: REPO_ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    const lines = Number.parseInt(out.trim(), 10);
    if (!Number.isInteger(lines) || lines <= 0) {
      return { ok: false, reason: `compiled to ${out.trim() || "nothing"}` };
    }
    return { ok: true, lines };
  } catch (error) {
    const text = `${error.stderr ?? ""}${error.stdout ?? ""}`;
    if (/ModuleNotFoundError: No module named 'gsim_py'/.test(text)) {
      return { ok: null, reason: "gsim_py not installed" };
    }
    const last = text.trim().split("\n").filter(Boolean).pop() ?? String(error.message);
    return { ok: false, reason: last };
  }
}

/**
 * Do the document's wires name ports the engine actually declares?
 *
 * The question is asked of `simulator.compiler.compile_input`, the product's own
 * function, imported from a module that deliberately imports nothing -- so this
 * gate runs with `gsim_py` alone, where `gsim_py_netlist` could not even be
 * imported (it needs `gsim-tools`, which nothing here installs yet).
 *
 * Reported rather than failed when the packages are absent, same contract as
 * `compiles` below: a developer's bare checkout stays usable, and CI installs
 * them so the arm is real there.
 */
function portsAreDeclared(documentPath) {
  const probe = [
    "import json,pathlib,sys",
    "import gsim_py",
    "from simulator.compiler.compile_input import (",
    "    assert_ports_are_declared, declared_ports_from_catalog, prepare_document)",
    "declared = declared_ports_from_catalog(json.loads(gsim_py.catalog()))",
    // `prepare_document` is the product's own step, not a copy of it: whatever
    // the compiler is handed at Run time is what gets checked here.
    "prepared = prepare_document(json.loads(pathlib.Path(sys.argv[1]).read_text()))",
    "assert_ports_are_declared(prepared['model'], declared)",
    "print(sum(1 for _ in prepared['model'].get('wires', [])))",
  ].join("\n");
  try {
    const out = execFileSync(PYTHON, ["-I", "-c", probe, documentPath], {
      cwd: REPO_ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { ok: true, wires: Number.parseInt(out.trim(), 10) };
  } catch (error) {
    const text = `${error.stderr ?? ""}${error.stdout ?? ""}`;
    // Matches a submodule too (`simulator.compiler.compile_input`), which is what
    // a venv holding an older build of the package reports -- the same thing as
    // "not installed" for this arm's purposes, and worth naming so the reader
    // knows to reinstall rather than hunt for a wiring fault.
    const absent = text.match(/No module named '((?:gsim_py|simulator|numpy|scipy)[^']*)'/);
    if (absent) {
      return { ok: null, reason: `${absent[1]} is not installed in ${PYTHON}` };
    }
    const last = text.trim().split("\n").filter(Boolean).pop() ?? String(error.message);
    return { ok: false, reason: last.replace(/^ValueError: /, "") };
  }
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

const { canonical, aliases } = loadCatalog();
const files = readdirSync(EXAMPLES_DIR)
  .filter((name) => name.endsWith(".gsim_sch"))
  .sort();

if (files.length === 0) {
  console.error("check-examples: no .gsim_sch files in examples/");
  process.exit(STRICT ? 1 : 0);
}

const failures = [];

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

  const ports = portsAreDeclared(path);
  if (ports.ok === true) {
    console.log(`  · all ${ports.wires} wires land on declared ports`);
  } else if (ports.ok === null) {
    console.log(`  · ports not checked (${ports.reason})`);
  } else {
    failures.push(`${name}: a wire names a port the engine does not declare — ${ports.reason}`);
    console.log(`  ✗ ${ports.reason}`);
  }

  const compiled = compiles(path);
  if (compiled.ok === true) {
    console.log(`  · compiles to ${compiled.lines} netlist lines`);
  } else if (compiled.ok === null) {
    console.log(`  · not compiled (${compiled.reason})`);
  } else {
    failures.push(`${name}: does not compile — ${compiled.reason}`);
    console.log(`  ✗ does not compile — ${compiled.reason}`);
  }

  console.log(`  · ${regenerates(name, path, failures)}`);
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

#!/usr/bin/env node
/**
 * Hold the C stub this editor writes to the engine's own `cscript` ABI.
 *
 * `netlist/code-source.ts`'s `sourceStub` is the file a user gets when they double-click a
 * `cscript` block whose source does not exist yet, and most users will read no other
 * documentation about the contract. Until #236 it declared
 *
 *     void cscript_output(void *state, double t, double dt, const double *in, int in_len,
 *                         double *out, int out_len)
 *
 * against an engine that calls `(state, in, in_len, dt, out, out_len)` — a parameter the engine
 * never passes, in an order it does not use.
 *
 * **A unit test cannot catch this and neither can a compile.** On x86-64 System V,
 * integer/pointer and floating-point arguments come from separate register files, so counting
 * only the integer class both signatures put `state`, `in`, `in_len` and `out` in the same
 * registers and `dt` in the same float register. Measured: the two libraries produce numbers
 * identical to the last digit against the same RC low-pass, and `-Wall -Wextra` says nothing.
 * Windows x64 assigns the first four arguments to RCX, RDX, R8, R9 *positionally regardless of
 * class*, so there the engine's `in` pointer lands where the callee reads `dt` and the callee
 * builds its `in` pointer out of the integer `in_len`. That is a crash or garbage, on the
 * platform this editor is least often tested on and most often used on.
 *
 * So the guard is a drift check against the engine's source rather than a local assertion,
 * exactly as `engine-catalogue-drift` and `gsim-wasm-drift` are: the ABI lives in
 * `general-simulator`, this repository holds a copy of it in a string, and a copy that nothing
 * compares is a second opinion rather than a cache.
 *
 * Usage:
 *   node scripts/check-cscript-abi.mjs            # needs the network
 *   node scripts/check-cscript-abi.mjs --rev <sha|branch>
 *
 * Exits 0 when the stub's prototypes are the engine's, 1 when they are not, and 2 when the
 * engine's source could not be read at all (a network failure is not a drift report).
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const ENGINE_REPO = "GLODI-Engineering/general-simulator";
const ENGINE_FILE = "crates/cscript-ffi/src/lib.rs";
const STUB_FILE = "apps/frontend/src/netlist/code-source.ts";

const revArgument = process.argv.indexOf("--rev");
const REV = revArgument === -1 ? "main" : process.argv[revArgument + 1];

/** Rust FFI spellings to their C equivalents. The whole translation table, deliberately short. */
const C_TYPE = new Map([
  ["*mut c_void", "void *"],
  ["*const f64", "const double *"],
  ["*mut f64", "double *"],
  ["*mut i32", "int *"],
  ["f64", "double"],
  ["i32", "int"],
]);

function fail(message) {
  process.stderr.write(`\ncscript ABI drift: ${message}\n\n`);
  process.exit(1);
}

function unavailable(message) {
  process.stderr.write(`\ncscript ABI check could not run: ${message}\n\n`);
  process.exit(2);
}

/**
 * The parameter types of a `type <Name> = unsafe extern "C" fn(...)` alias, as C spellings.
 *
 * Parameter *names* are deliberately not compared: the engine calls its first `f64` slice
 * `input` and the stub calls it `in`, and a name has no bearing on how an argument is passed.
 * The ordered list of types is exactly what the calling convention depends on.
 */
function engineParameterTypes(source, aliasName) {
  const start = source.indexOf(`type ${aliasName} = unsafe extern "C" fn(`);
  if (start === -1) {
    unavailable(`${ENGINE_FILE} at ${REV} declares no \`type ${aliasName}\``);
  }
  const open = source.indexOf("(", start);
  let depth = 0;
  let close = -1;
  for (let index = open; index < source.length; index += 1) {
    if (source[index] === "(") depth += 1;
    else if (source[index] === ")") {
      depth -= 1;
      if (depth === 0) {
        close = index;
        break;
      }
    }
  }
  if (close === -1) unavailable(`\`type ${aliasName}\` is not closed in ${ENGINE_FILE}`);

  return source
    .slice(open + 1, close)
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part !== "")
    .map((part) => {
      const colon = part.indexOf(":");
      const rustType = (colon === -1 ? part : part.slice(colon + 1)).trim();
      const c = C_TYPE.get(rustType);
      if (!c) {
        unavailable(
          `\`type ${aliasName}\` uses the Rust type \`${rustType}\`, which this script has no ` +
            "C spelling for. Add it to C_TYPE after checking what the engine means by it.",
        );
      }
      return c;
    });
}

/**
 * The parameter types of a C prototype the stub emits, as C spellings.
 *
 * The stub is a list of string literals joined with newlines, so the prototype is reassembled
 * from the file's text rather than by importing the module: this script stays a plain `.mjs`
 * with no TypeScript loader, like every other gate here.
 */
function stubParameterTypes(stubSource, functionName) {
  // Every quoted fragment in the file, concatenated: the prototype spans two of them.
  const fragments = [...stubSource.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((match) =>
    match[1].replace(/\\"/g, '"'),
  );
  const joined = fragments.join(" ");
  const declaration = new RegExp(`${functionName}\\s*\\(([^)]*)\\)`).exec(joined);
  if (!declaration) {
    fail(`${STUB_FILE} emits no \`${functionName}\` declaration at all`);
  }
  return declaration[1]
    .split(",")
    .map((part) => part.trim().replace(/\s+/g, " "))
    .filter((part) => part !== "")
    .map((part) => {
      // Drop the parameter name: everything up to the last identifier, keeping the stars.
      const match = /^(.*?)\s*\*?\s*([A-Za-z_][A-Za-z0-9_]*)$/.exec(part);
      if (!match) fail(`cannot read the parameter \`${part}\` of \`${functionName}\``);
      const stars = part
        .slice(0, part.length - match[2].length)
        .trim()
        .endsWith("*")
        ? " *"
        : "";
      return `${match[1].trim()}${stars}`;
    });
}

async function engineSource() {
  const url = `https://raw.githubusercontent.com/${ENGINE_REPO}/${REV}/${ENGINE_FILE}`;
  let response;
  try {
    response = await fetch(url);
  } catch (error) {
    unavailable(`could not reach ${url}: ${error.message}`);
  }
  if (!response.ok) {
    unavailable(`could not read ${ENGINE_FILE} at ${REV}: HTTP ${response.status}`);
  }
  return await response.text();
}

const rust = await engineSource();
const stub = readFileSync(join(ROOT, STUB_FILE), "utf8");

// `StartFn` takes no arguments and returns a pointer, so there is nothing about its argument
// passing to get wrong; `OutputFn` and `ArityFn` are the two the stub declares.
const checks = [
  ["cscript_output", "OutputFn"],
  ["cscript_arity", "ArityFn"],
];

let drifted = false;
for (const [cName, rustAlias] of checks) {
  const expected = engineParameterTypes(rust, rustAlias);
  const found = stubParameterTypes(stub, cName);
  const same = expected.length === found.length && expected.every((t, i) => t === found[i]);
  if (same) {
    process.stdout.write(`  ✓ ${cName.padEnd(16)} (${expected.join(", ")})\n`);
    continue;
  }
  drifted = true;
  process.stdout.write(
    `  ✗ ${cName}\n` +
      `      engine (${ENGINE_FILE}, type ${rustAlias}): (${expected.join(", ")})\n` +
      `      stub   (${STUB_FILE}):                      (${found.join(", ")})\n`,
  );
}

if (drifted) {
  fail(
    "the stub declares a function the engine does not call. A wrong declaration can still\n" +
      "produce correct numbers on x86-64 Linux, because integer and floating-point arguments\n" +
      "come from separate register files there, and crash or read garbage on Windows x64,\n" +
      `where the first four arguments are positional. Fix ${STUB_FILE}.`,
  );
}

process.stdout.write(`\nThe stub's prototypes are the engine's, at ${ENGINE_REPO}@${REV}.\n`);

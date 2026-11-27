#!/usr/bin/env node
/**
 * Write the front end's component catalogue from the engine itself.
 *
 * The engine owns the component library — labels, categories, port geometry, parameters and
 * their defaults — and says for each component whether it can compile it. This script moves
 * that declaration into the front end and reshapes it into what `loadCatalog` already reads;
 * it never edits the content. `--check` fails when the committed copy stops matching, which
 * is what keeps these files a cache of the engine's answer instead of a second opinion.
 *
 * Two files, because the front end asks two different questions:
 *   engine-catalog.json       what to show, in the shape `catalog-core.loadCatalog` takes
 *   engine-capabilities.json  the compile facts, per engine type
 *
 * Needs `gsim_py` importable. Without it the committed files stand and `--check` says so
 * rather than failing: a checkout without the Rust toolchain is a working checkout. CI passes
 * `--require-engine`, which turns that into a failure -- in a gate, "I could not ask the
 * engine" must not be reported the same way as "the engine agrees". A green run that checked
 * nothing is how this repository shipped four gates that were never doing their job, and it
 * caught me once more while landing decision 0010: a regeneration printed success, had done
 * nothing, and the drift job failed afterwards.
 *
 * Every component the engine submits is validated against the block-metadata
 * schema before anything is written. The drift check answers "did the engine's
 * answer change?"; this answers "is the engine's answer a legal one?" -- a
 * different question, and the one that was never asked. A malformed component
 * used to flow through here into the front end untouched, to be discovered as
 * a blank symbol or a missing port on somebody's sheet.
 *
 *   node scripts/gen-engine-catalog.mjs                            # write
 *   node scripts/gen-engine-catalog.mjs --check                    # verify, exit 1 on drift
 *   node scripts/gen-engine-catalog.mjs --check --require-engine   # ...and on no engine
 */

import Ajv from "ajv/dist/2020.js";

import { DISPLAY_FIELDS, catalogueDisagreements } from "./catalogue-agreement.mjs";

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const LIB = join(REPO_ROOT, "apps/frontend/src/library");

// This repository's half of the catalogue. Read rather than generated: it is edited by hand,
// because a label and a symbol are decisions somebody makes rather than facts to derive.
const DISPLAY = JSON.parse(readFileSync(join(LIB, "display-catalog.json"), "utf8"));
const CHECK = process.argv.includes("--check");
const REQUIRE_ENGINE = process.argv.includes("--require-engine");

/** Ask the engine. `null` when `gsim_py` is not importable here. */
function fromEngine(call) {
  const python = process.env.GSIM_PYTHON ?? "python3";
  try {
    return execFileSync(python, ["-c", `import gsim_py; print(gsim_py.${call}())`], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch {
    return null;
  }
}

/**
 * The engine's catalogue in the shape `loadCatalog` reads: `{filePath, metadata}` records.
 *
 * `filePath` is where the component is declared, which is now a path inside the engine rather
 * than a file in this repository. It is kept because `loadCatalog` reports it in errors, and
 * pointing at the engine is the honest answer to "where does this component come from".
 */
function toCatalogEntries(catalog) {
  const missing = [];
  const reclaimed = [];
  const entries = catalog.components.map((component) => {
    const { id, compilable, compiles_to: compilesTo, ...rest } = component;
    // The split, asserted from this side. gsim-core 0.7.1 stopped sending these six (its
    // #115), and this repository owns them now. If the engine ever declares one again there
    // would be two owners of a label, and the overlay below would silently prefer one of them
    // per component -- `label` is in every display entry so the editor's would win, while
    // `main_param` is in 37 of 78, so the engine's would leak through for the other 41. That
    // is the split being undone with nothing failing, which is what this refuses.
    for (const field of DISPLAY_FIELDS) {
      if (field in rest) reclaimed.push(`${id}.${field}`);
    }
    const display = DISPLAY.components[id];
    if (display === undefined) {
      missing.push(id);
    }
    return {
      filePath: `gsim-core/crates/gsim-core/data/component-library.json#${id}`,
      metadata: {
        ...rest,
        ...(display ?? {}),
        // `loadCatalog` keys entries by `name`, `type` and every alias, so a sheet saved under
        // the catalogue's old spelling still resolves — those spellings are in `aliases`.
        name: rest.name ?? id,
        ...(rest.type ? { type: rest.type } : {}),
        engineId: id,
        engineType: compilesTo ?? null,
        compilable,
      },
    };
  });
  if (reclaimed.length > 0) {
    console.error(
      `gen-engine-catalog: the engine declares ${reclaimed.length} display field(s) that this ` +
        `repository owns (gsim-core decision 0010):\n  ${reclaimed.join("\n  ")}` +
        "\n\nRemove them from the engine's component library, or amend 0010 if the ownership " +
        "itself should change. Two owners of one field is the drift the split was made to end.",
    );
    process.exit(1);
  }
  // Loudly, because a component that reaches a palette with nothing to draw is the failure this
  // split could introduce. Not a warning: the catalogue is not writable without an answer.
  if (missing.length > 0) {
    console.error(
      `gen-engine-catalog: ${missing.length} engine component(s) have no entry in ` +
        `display-catalog.json, so there is nothing to draw for them:\n  ${missing.join("\n  ")}` +
        "\n\nAdd each one to apps/frontend/src/library/display-catalog.json.",
    );
    process.exit(1);
  }
  return entries;
}

const catalogRaw = fromEngine("catalog");
const capabilitiesRaw = fromEngine("capabilities");
if (catalogRaw === null || capabilitiesRaw === null) {
  if (REQUIRE_ENGINE) {
    console.error(
      "gen-engine-catalog: --require-engine was passed and gsim_py is not importable, so " +
        "nothing here was checked against the engine.\n\n" +
        `Tried ${process.env.GSIM_PYTHON ?? "python3"}. Build the wheel from gsim-core's ` +
        "crates/gsim-py with maturin and point GSIM_PYTHON at the interpreter that has it.",
    );
    process.exit(1);
  }
  console.log(
    "gen-engine-catalog: gsim_py is not importable here — leaving the committed files " +
      "alone. Set GSIM_PYTHON to an interpreter that has it to regenerate.",
  );
  process.exit(0);
}

const catalog = JSON.parse(catalogRaw);

/**
 * The contract the engine's submission has to satisfy.
 *
 * `block-metadata.schema.json` is the front end's half of the bargain: it says
 * what a component declaration must look like for this app to be able to draw
 * it, search it and offer its parameters. The engine owns *which* components
 * exist; this owns *what shape* a component is described in. Validating here
 * is what makes it a contract rather than a convention.
 */
const SCHEMA = JSON.parse(
  readFileSync(
    join(REPO_ROOT, "packages/schemas/definitions/blocks/block-metadata.schema.json"),
    "utf8",
  ),
);
const validateComponent = new Ajv({ strict: false, allErrors: true }).compile(SCHEMA);

const entries = toCatalogEntries(catalog);
const offenders = [];
for (const entry of entries) {
  if (validateComponent(entry.metadata)) continue;
  const why = validateComponent.errors
    .slice(0, 4)
    .map((e) => `${e.instancePath || "/"} ${e.message}`)
    .join("; ");
  offenders.push(`  ${entry.metadata.engineId}: ${why}`);
}
/**
 * A port must sit where artwork can reach it.
 *
 * A symbol is drawn inside its bbox, so a port declared on a face *corner*
 * can only be met by artwork that runs into the corner — which no symbol
 * does. The port marker then draws as a small circle beside the component
 * with nothing joining the two, and a reader cannot tell which component the
 * terminal belongs to.
 *
 * That is not hypothetical. Both current-controlled sources declared `p` and
 * `n` on the right face at offsets 1 and 59 of 60 — the two corners — while
 * their diamond drew leads out of the left and right vertices at mid-height.
 * Neither terminal touched the symbol. The comparator carried `vn` at offset
 * 40 of a 40-tall face, outside a triangle that ends at y=38, and the MESFET
 * put drain and source on the far corner of faces every other FET centres.
 *
 * Two units of margin, because a port exactly on a corner and a port one unit
 * from it are the same mistake.
 */
const CORNER_MARGIN = 2;
for (const entry of entries) {
  const meta = entry.metadata;
  const bbox = meta.symbol?.bbox;
  if (!bbox) continue;
  const [width, height] = bbox;
  for (const group of ["inputs", "outputs"]) {
    for (const port of meta.ports?.[group] ?? []) {
      if (port.side == null || port.offset == null) continue;
      const face = port.side === "left" || port.side === "right" ? height : width;
      if (port.offset <= CORNER_MARGIN || port.offset >= face - CORNER_MARGIN) {
        offenders.push(
          `  ${meta.engineId}: port '${port.id}' sits on a corner of the ${port.side} ` +
            `face (offset ${port.offset} of ${face}) — no artwork can reach it`,
        );
      }
    }
  }
}

if (offenders.length > 0) {
  console.error(
    `gen-engine-catalog: ${offenders.length} of ${entries.length} components do not satisfy ` +
      "the block-metadata contract:",
  );
  for (const line of offenders.slice(0, 20)) console.error(line);
  if (offenders.length > 20) console.error(`  ...and ${offenders.length - 20} more`);
  console.error(
    "\nThe engine owns which components exist; this schema owns how one is described. " +
      "Fix the engine's declaration, or change the schema if the contract itself should widen.",
  );
  process.exit(1);
}

/**
 * The compiler agrees with itself about a component (gsim-core#110).
 *
 * The schema check above asks whether a declaration is *well shaped*. This asks whether the
 * engine's two answers about the same component *say the same thing*: the component library
 * declares a component's terminals, their domains and its parameters, and the compile registry
 * declares the card that gets written, the terminals it writes positionally and the parameters
 * it reads. A netlist is positional, so two orders of the same four terminals are two
 * different circuits -- and nothing compared those two lists until this check, which found
 * that two components disagree (#281) and that six parameters are read by nothing (#283).
 *
 * It lives here because here is where both answers are in hand: `catalog()` and
 * `capabilities()` are two calls into the same engine, and comparing the committed copies
 * instead would be comparing this script's own output with itself.
 */
const agreement = catalogueDisagreements(catalog, JSON.parse(capabilitiesRaw));
// Before the empty result is believed. A loop that runs zero times reports agreement, and
// that is the shape of every gate this repository has shipped green while checking nothing.
const tooLittleChecked = Object.entries({ components: 60, terminals: 40, outputs: 40, params: 150 })
  .filter(([key, floor]) => (agreement.checked[key] ?? 0) < floor)
  .map(([key, floor]) => `${key}: ${agreement.checked[key] ?? 0}, expected at least ${floor}`);
if (tooLittleChecked.length > 0) {
  console.error(
    "gen-engine-catalog: the agreement check ran but examined far less than it should have, " +
      "so its result means nothing:\n  " +
      tooLittleChecked.join("\n  "),
  );
  process.exit(1);
}
if (agreement.unexpected.length > 0) {
  console.error(
    `gen-engine-catalog: ${agreement.unexpected.length} new disagreement(s) between the ` +
      "engine's component library and its compile registry:",
  );
  for (const finding of agreement.unexpected) console.error(`  ${finding}`);
  console.error(
    "\nEach line is `rule|component|detail`. Fix the disagreement, or -- if it is a defect " +
      "that has to be lived with for now -- file it and add its exact line to " +
      "KNOWN_DISAGREEMENTS in scripts/catalogue-agreement.mjs with the issue number.",
  );
  process.exit(1);
}
if (agreement.repaired.length > 0) {
  console.error(
    `gen-engine-catalog: ${agreement.repaired.length} known disagreement(s) no longer ` +
      "disagree, so KNOWN_DISAGREEMENTS is now listing things that are fixed:",
  );
  for (const finding of agreement.repaired) console.error(`  ${finding}`);
  console.error(
    "\nRemove each one from KNOWN_DISAGREEMENTS in scripts/catalogue-agreement.mjs. A ratchet " +
      "that is never released stops saying anything about the present.",
  );
  process.exit(1);
}

const outputs = [
  [join(LIB, "engine-catalog.json"), entries],
  [join(LIB, "engine-capabilities.json"), JSON.parse(capabilitiesRaw)],
];

let drifted = false;
for (const [path, value] of outputs) {
  const formatted = `${JSON.stringify(value, null, 2)}\n`;
  if (!CHECK) {
    writeFileSync(path, formatted);
    continue;
  }
  let committed = "";
  try {
    committed = readFileSync(path, "utf8");
  } catch {
    committed = "";
  }
  if (committed !== formatted) {
    console.error(`gen-engine-catalog: ${path} does not match what the engine declares.`);
    drifted = true;
  }
}

if (CHECK) {
  if (drifted) {
    console.error("Run `node scripts/gen-engine-catalog.mjs` and commit the result.");
    process.exit(1);
  }
  console.log("gen-engine-catalog: the committed catalogue matches the engine.");
  process.exit(0);
}

const compilable = catalog.components.filter((c) => c.compilable).length;
console.log(
  `gen-engine-catalog: wrote ${catalog.components.length} components ` +
    `(${compilable} compilable) from ${catalog.generator}`,
);

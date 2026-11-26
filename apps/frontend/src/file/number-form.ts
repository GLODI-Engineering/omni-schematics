/**
 * Whether a number in a `.gsim_sch` is real-valued or integral — declared, not
 * guessed from the value.
 *
 * ## Why a declaration is needed at all
 *
 * JSON has one number type and JavaScript has one number type, so `48` and
 * `48.0` are the same `number` here and `JSON.stringify` writes the shorter of
 * the two. Python does not: `json.loads` reads `48` as an `int` and `48.0` as a
 * `float`. An editor that writes `48` where the generator wrote `48.0` has
 * therefore changed a real-valued parameter into an integer *in the file*, for
 * every Python consumer of it — `gsim-tools`, `examples/build_*.py`, anything a
 * user writes to script a sheet (#268).
 *
 * The runtime value cannot answer the question: by the time the editor holds
 * it, `48.0` has already become `48`. Only a declaration can, which is why this
 * file exists and why the catalogue is where it starts.
 *
 * ## Two declaration sites, because there are two kinds of number
 *
 * A **component parameter** is declared by the component, in the engine's own
 * library (`gsim-core/crates/gsim-core/data/component-library.json`, reaching
 * the editor as `library/engine-catalog.json`). `V` on a DC source is `number`;
 * `pole_pairs` on a PMSM is `integer`. That is the declaration this file reads
 * through [`paramDeclaredType`], and it is the engine's to change, not the
 * editor's.
 *
 * The **document's own numbers** — an analysis window, a solver tolerance — are
 * not a component's parameters and the catalogue says nothing about them. They
 * are declared below, one site at a time, keyed by the `.gsim_sch` schema
 * definition they live in. `number-form.test.ts` holds that table to the
 * schema: every place the format admits a real number must appear here, so a
 * field added to the schema cannot quietly arrive undeclared.
 *
 * ## The weakest true statement, and why `undeclared` is a real answer
 *
 * A *wrong* declaration is worse than none. A real-valued parameter called
 * integral truncates meaning in every Python reader; an integral one called
 * real turns a count into `3.0`. So each site below says only what is true of
 * every value it can hold, and the ones that genuinely cannot be pinned down
 * say `undeclared` with the reason. `undeclared` means "write it the way it
 * arrived", never "probably real".
 */

import { paramDeclaredType } from "../library/engine-types";
import type { ModelDocument } from "../model/types";

/** What a writer needs to know: does this number need a decimal point? */
export type NumberForm = "real" | "integer";

/**
 * How one numeric site of the document's own structure is declared.
 *
 * `catalogue` is the third answer and not a dodge: it says the declaration
 * exists but is the component's, so this table must not restate it.
 */
type SiteDeclaration =
  | { form: NumberForm; why: string }
  | { form: "catalogue"; why: string }
  | { form: "undeclared"; why: string };

/**
 * Every place the `.gsim_sch` schema admits a real number, and what it is.
 *
 * Keyed by `<definition>.<field>` as `gsim_sch.schema.json` spells it, because
 * that key is what the cross-check in `number-form.test.ts` can compute from
 * the schema itself. Sites the schema already types `integer` are absent on
 * purpose: `integer` is a declaration, and there is nothing left to say.
 */
export const DOCUMENT_SITES: Record<string, SiteDeclaration> = {
  "Block.params": {
    form: "catalogue",
    why: "the component declares its own parameters; see paramDeclaredType",
  },
  "Block.ic": {
    form: "undeclared",
    why: "keyed by a block variable name that nothing declares — an initial current is real, a counter's initial count is not",
  },
  "ParamEntry.value": {
    form: "undeclared",
    why: "a model-level parameter is whatever its author meant it to be; the document carries no type for it",
  },
  "SubcktInstance.params": {
    form: "undeclared",
    why: "a .SUBCKT's parameters are declared in its SPICE text, which this editor does not parse",
  },
  "AnalysisTRAN.t_start": { form: "real", why: "a time in seconds" },
  "AnalysisTRAN.t_end": { form: "real", why: "a time in seconds" },
  "AnalysisTRAN.t_step": { form: "real", why: "a time in seconds" },
  "AnalysisAC.f_start": { form: "real", why: "a frequency in hertz" },
  "AnalysisAC.f_end": { form: "real", why: "a frequency in hertz" },
  "AnalysisAC.n_points": { form: "integer", why: "a count of points" },
  "AnalysisDC.start": { form: "real", why: "a value of the swept source — a voltage or a current" },
  "AnalysisDC.stop": { form: "real", why: "a value of the swept source — a voltage or a current" },
  "AnalysisDC.step": { form: "real", why: "an increment of the swept source" },
  "SweepLin.lin.start": {
    form: "undeclared",
    why: "takes the form of the parameter being swept, which `param` names but does not type",
  },
  "SweepLin.lin.stop": {
    form: "undeclared",
    why: "takes the form of the parameter being swept, which `param` names but does not type",
  },
  "SweepLin.lin.n": { form: "integer", why: "a count of sweep points" },
  "SweepDec.dec.start": {
    form: "undeclared",
    why: "takes the form of the parameter being swept, which `param` names but does not type",
  },
  "SweepDec.dec.stop": {
    form: "undeclared",
    why: "takes the form of the parameter being swept, which `param` names but does not type",
  },
  "SweepDec.dec.n_per_decade": { form: "integer", why: "a count of sweep points per decade" },
  "SweepByValues.values": {
    form: "undeclared",
    why: "takes the form of the parameter being swept, which `param` names but does not type",
  },
  "ICEntryNode.value": { form: "real", why: "a node's initial voltage" },
  "ICEntryBlock.value": {
    form: "undeclared",
    why: "`var` names a block's internal state, which nothing here types",
  },
  "SolverOptions.abstol": { form: "real", why: "an absolute tolerance" },
  "SolverOptions.reltol": { form: "real", why: "a relative tolerance" },
  "SolverOptions.vntol": { form: "real", why: "a voltage tolerance" },
  "CodeDefine.literal": {
    form: "undeclared",
    why: "a constant the author writes out for a -D, and §20 lets it be anything: a count of steps and a gain are both legal and only the author knows which was meant",
  },
  StructuredValue: {
    form: "undeclared",
    why: "a table, vector or matrix -- the same reason a catalogue `matrix` says nothing: the shape is declared and the element kind is not",
  },
};

/** A step of a path from the document root: an object key or an array index. */
export type PathStep = string | number;

function at(root: unknown, path: ReadonlyArray<PathStep>): unknown {
  let value: unknown = root;
  for (const step of path) {
    if (value === null || typeof value !== "object") return undefined;
    value = (value as Record<PathStep, unknown>)[step];
  }
  return value;
}

function stringField(value: unknown, field: string): string | undefined {
  if (value === null || typeof value !== "object") return undefined;
  const found = (value as Record<string, unknown>)[field];
  return typeof found === "string" ? found : undefined;
}

/**
 * The schema site a document path lands in, or `undefined` when it lands
 * nowhere this table knows about.
 *
 * Matched on the *end* of the path rather than the whole of it, so a block
 * inside a subsystem or inside a `.SUBCKT` definition's own body resolves the
 * same way a top-level one does — which is the only way this can stay true of
 * a nested document.
 */
export function siteKeyFor(path: ReadonlyArray<PathStep>, root: unknown): string | undefined {
  const length = path.length;
  const last = path[length - 1];
  const parent = at(root, path.slice(0, -1));

  if (typeof last === "string") {
    const container = path[length - 2];

    // `blocks[i].params.<name>` and `blocks[i].ic.<name>`. A block is the only
    // thing carrying both a `type` and a `fidelity`, which is what tells it
    // apart from a `SubcktInstance`'s `params` and from `model.params` -- an
    // array, so its own steps are numbers and never reach here.
    if (container === "params" || container === "ic") {
      const owner = at(root, path.slice(0, -2));
      if (stringField(owner, "type") && stringField(owner, "fidelity")) {
        return container === "params" ? "Block.params" : "Block.ic";
      }
      if (container === "params" && stringField(owner, "def_ref")) {
        return "SubcktInstance.params";
      }
      return undefined;
    }

    // `analyses[i].<field>`, named by the analysis's own `type`.
    if (path[length - 3] === "analyses" && typeof container === "number") {
      const type = stringField(parent, "type");
      return type ? `Analysis${type}.${last}` : undefined;
    }

    // `sweeps[j].lin.<field>` / `sweeps[j].dec.<field>`.
    if ((container === "lin" || container === "dec") && path[length - 4] === "sweeps") {
      return container === "lin" ? `SweepLin.lin.${last}` : `SweepDec.dec.${last}`;
    }

    if (container === "solver" || container === "solver_options") {
      return `SolverOptions.${last}`;
    }

    if (last === "value") {
      if (path[length - 3] === "params") return "ParamEntry.value";
      if (path[length - 3] === "initial_conditions") {
        const kind = stringField(parent, "kind");
        if (kind === "node") return "ICEntryNode.value";
        if (kind === "block") return "ICEntryBlock.value";
      }
    }
    return undefined;
  }

  // `sweeps[j].values[k]`.
  if (path[length - 2] === "values" && path[length - 4] === "sweeps") {
    return "SweepByValues.values";
  }
  return undefined;
}

/**
 * The form declared for the number at `path` in `document`, or `undefined` when
 * nothing declares it.
 *
 * Callers must treat `undefined` as "leave this number exactly as it arrived".
 */
export function numberFormAt(
  path: ReadonlyArray<PathStep>,
  document: ModelDocument,
): NumberForm | undefined {
  const site = siteKeyFor(path, document);
  if (site === undefined) return undefined;

  if (site === "Block.params") {
    const block = at(document, path.slice(0, -2));
    const type = stringField(block, "type");
    if (!type) return undefined;
    const declared = paramDeclaredType(type, stringField(block, "fidelity"), String(path.at(-1)));
    if (declared === "number") return "real";
    if (declared === "integer") return "integer";
    // `vector` and `matrix` name the container, not the element, so the
    // catalogue says nothing about the numbers inside one. Left alone on
    // purpose rather than assumed real.
    return undefined;
  }

  const declaration = DOCUMENT_SITES[site];
  if (!declaration) return undefined;
  if (declaration.form === "real" || declaration.form === "integer") return declaration.form;
  return undefined;
}

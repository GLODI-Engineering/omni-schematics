/**
 * Which directory the solver is spawned in, and when a run has to be refused instead (#234).
 *
 * ## The defect
 *
 * The solver was spawned with `cwd` set to `.gsim/runs/<id>/` — created fresh for the run and
 * holding only `netlist.cir`, the samples container, the event log and the manifest. Every
 * relative path in the compiled netlist then resolved against *that* directory, and a code
 * block's source path is a relative path:
 *
 * | block | parameter | e.g. |
 * | --- | --- | --- |
 * | `extensibility.cscript` | `lib` | `./ctrl.so` |
 * | `extensibility.pyblock` / `pyfunc` | `path` | `./ctrl.py` |
 * | `extensibility.octfunc` / `octblock` | `path` | `./ctrl.m` |
 *
 * Nothing between the document and the solver rewrites them, so a sheet saved next to its own
 * `ctrl.py` compiled to a netlist that looked right and ran in a directory where `ctrl.py` does
 * not exist. Measured against `general-simulator` 0.8.0:
 *
 * ```text
 * error: PyBlock(Load { path: "./ctrl.py", message: "No such file or directory (os error 2)" })
 * ```
 *
 * For Octave it was worse than an error: `octfunc` resolved its function by *name* through
 * Octave's search path with the working directory first, so a relative `path=` that did not
 * resolve could pick up a same-named function from elsewhere and run it, completing with the
 * wrong numbers. (Closed engine-side as `general-simulator#123`, but the reason this issue is
 * not a papercut.)
 *
 * ## The fix, and why it is `cwd` rather than a rewrite
 *
 * The run's four files are already named by absolute paths — `runSimulation` builds every one of
 * them with `path.join(runDirectory, …)` — so `cwd` was never what put them in the run
 * directory, and moving it costs nothing there. The solver is therefore spawned in **the
 * schematic's own directory**, which is what every relative path in a netlist is written
 * relative to.
 *
 * Relative to the *schematic*, not the workspace root: a project with two sheets in two folders,
 * each with its own blocks, is ordinary.
 *
 * The two alternatives were considered and are worse. Rewriting `lib=`/`path=` to absolute at
 * compile time makes `netlist.cir` — a file users read and re-run by hand — carry machine paths,
 * and puts path knowledge into the compile route that Invariant 0a says to keep clear. Copying
 * the referenced files into the run directory cannot know what *else* a file needs: a Python
 * block's sibling import, a C library's shared sources.
 *
 * ## The unsaved sheet
 *
 * An `untitled:` schematic has no directory, so there is nothing to resolve a relative path
 * against. The run is refused with a sentence that says what to do — but only when the sheet
 * actually carries a code block with a relative path, because a sheet of resistors has nothing
 * to resolve and refusing it would be a regression.
 *
 * This module is pure so the decision can be asserted without a solver, a workspace or a
 * webview: everything it needs is the netlist text and whether the document has a folder.
 */

/** Every `kind=` whose own parameter names a file the engine opens. */
const CODE_BLOCK_KINDS = ["cscript", "pyblock", "pyfunc", "octfunc", "octblock"] as const;

/** The parameter each one carries its path in. `cscript` is the odd one: a compiled library. */
const PATH_PARAMETER: Record<string, "lib" | "path"> = {
  cscript: "lib",
  pyblock: "path",
  pyfunc: "path",
  octfunc: "path",
  octblock: "path",
};

/** One code block the netlist declares, and the path it names. */
export interface CodeBlockReference {
  /** The block's own netlist name, e.g. `G1`. */
  block: string;
  /** Its `kind=`, without the `extensibility.` prefix the document uses. */
  kind: (typeof CODE_BLOCK_KINDS)[number];
  /** `lib` for `cscript`, `path` for the rest. */
  parameter: "lib" | "path";
  /** The value as written, quotes already removed. */
  value: string;
  /** Whether that value is a relative path, and so depends on the working directory. */
  relative: boolean;
}

function unquote(value: string): string {
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    return value.slice(1, -1);
  }
  return value;
}

/**
 * Whether a path is absolute, in the engine's terms, on either platform.
 *
 * Deliberately permissive about Windows: a netlist written on Windows and read on Linux should
 * still be *recognised* as carrying an absolute path, because the question being asked is "does
 * this depend on the working directory", not "can I open it".
 */
function isAbsolutePath(value: string): boolean {
  return value.startsWith("/") || /^[A-Za-z]:[\\/]/.test(value) || value.startsWith("\\\\");
}

/**
 * Every code block in a compiled netlist, with the path it names.
 *
 * A line-by-line scan of the netlist text rather than a read of the document, because the
 * netlist is what the solver is given and a document that compiled to something else is not
 * what will run. Blocks are `<name> kind=<kind> <key>=<value> …`, whitespace-delimited, with a
 * quoted value when it contains a space — the grammar `general-spice-core` parses.
 */
export function codeBlocksIn(netlist: string): CodeBlockReference[] {
  const found: CodeBlockReference[] = [];
  for (const raw of netlist.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === "" || line.startsWith("*") || line.startsWith(".")) {
      continue;
    }
    // A field is a run of non-space characters, except that a quoted segment inside one keeps
    // its spaces: `path="a lib dir/ctrl.py"` is *one* field, and the quote is in the middle of
    // it rather than at its start, so matching `"…"` as an alternative token does not work.
    const fields = line.match(/(?:[^\s"]|"[^"]*")+/g);
    if (!fields || fields.length < 2) {
      continue;
    }
    const kindField = fields.find((field) => field.startsWith("kind="));
    if (!kindField) {
      continue;
    }
    const kind = kindField.slice("kind=".length) as (typeof CODE_BLOCK_KINDS)[number];
    if (!CODE_BLOCK_KINDS.includes(kind)) {
      continue;
    }
    const parameter = PATH_PARAMETER[kind] as "lib" | "path";
    // The value may be quoted and the quote may hold the `=`, so the field is found by prefix
    // and split once rather than by a tokenising pass.
    const prefix = `${parameter}=`;
    const valueField = fields.find((field) => field.startsWith(prefix));
    const value = valueField === undefined ? "" : unquote(valueField.slice(prefix.length));
    found.push({
      block: fields[0] as string,
      kind,
      parameter,
      value,
      relative: value !== "" && !isAbsolutePath(value),
    });
  }
  return found;
}

export type WorkingDirectory =
  | {
      ok: true;
      /** What to spawn the solver in. */
      cwd: string;
      /** One line for the Output panel, so a reader can reproduce the run by hand. */
      note: string;
    }
  | {
      ok: false;
      summary: string;
      detail: string;
    };

export interface WorkingDirectoryInput {
  /** The compiled netlist, as it will be written to `netlist.cir`. */
  netlist: string;
  /**
   * The folder holding the `.gsim_sch`, or `undefined` for a sheet that has never been saved.
   */
  schematicFolder: string | undefined;
  /** `.gsim/runs/<id>/`, the fallback and where the run's own files go regardless. */
  runDirectory: string;
}

/**
 * Where to spawn the solver, or why this run cannot be spawned at all.
 *
 * The schematic's folder whenever there is one — not only when a code block is present. Every
 * relative path a netlist carries is written relative to the sheet, code blocks included but
 * also a file-backed source's own capture, and one rule is easier to reason about than a rule
 * that changes with the contents of the sheet.
 */
export function workingDirectoryFor(input: WorkingDirectoryInput): WorkingDirectory {
  const { netlist, schematicFolder, runDirectory } = input;
  if (schematicFolder !== undefined && schematicFolder !== "") {
    return {
      ok: true,
      cwd: schematicFolder,
      note: `working directory ${schematicFolder} (the schematic's own folder, which is what a relative lib=/path= resolves against)`,
    };
  }

  const unresolvable = codeBlocksIn(netlist).filter((block) => block.relative);
  if (unresolvable.length > 0) {
    const named = unresolvable
      .map((block) => `${block.block} (${block.parameter}=${block.value})`)
      .join(", ");
    return {
      ok: false,
      summary: "Save the schematic before running a code block",
      detail:
        "This sheet has not been saved, so it has no folder for a relative path to resolve " +
        `against, and ${unresolvable.length === 1 ? "this block names one" : "these blocks name one"}: ` +
        `${named}. Save the sheet next to its sources and run again, or give the block an ` +
        "absolute path.",
    };
  }

  return {
    ok: true,
    cwd: runDirectory,
    note:
      `working directory ${runDirectory} (this sheet has never been saved, so it has no ` +
      "folder of its own; nothing on it needs one)",
  };
}

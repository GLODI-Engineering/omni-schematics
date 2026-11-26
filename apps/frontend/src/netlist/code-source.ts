/**
 * Where a scripted block's source lives, and what an empty one should say.
 *
 * ## The parameter is not always the source
 *
 * Four of the five extensibility blocks point straight at the file the user
 * edits:
 *
 * | type | parameter | what it names |
 * | --- | --- | --- |
 * | `extensibility.pyblock` | `path` | a `.py` file |
 * | `extensibility.pyfunc`  | `path` | a `.py` file, with `function` |
 * | `extensibility.octfunc` | `path` | one `.m` file, named for its function |
 * | `extensibility.octblock`| `path` | a **directory** of `.m` files |
 * | `extensibility.cscript` | `lib`  | a compiled `.so` / `.dylib` / `.dll` |
 *
 * `cscript` is the exception and it is not a small one: the engine loads a
 * binary, and "this CLI never invokes a compiler" — the user builds it. So a
 * cscript block has no parameter naming its source, and double-clicking it
 * can only follow a convention. That is why this returns a *list*: the host
 * opens the first candidate that exists, and the convention is documented
 * here rather than guessed at in three places.
 *
 * `docs/specs/code-blocks-vscode-integration.md` §6 recommends adding a
 * display-only `source` parameter to the block in the engine, which would
 * make this exact. That is a cross-repo change; until it happens the
 * convention below is what a double-click has to work from.
 *
 * ## The stubs
 *
 * Each stub is written so that `code-ports.ts` — the parser the Inspector
 * already uses to say what ports a source declares — reads back exactly the
 * ports the block carries. `code-source.test.ts` asserts that round trip, so
 * a stub and the parser cannot drift: a created file is never one the editor
 * would then report as disagreeing with its own block.
 */

export type ScriptLanguage = "c" | "python" | "octave";

export interface ScriptedBlock {
  id: string;
  type: string;
  params: Record<string, unknown>;
}

export interface ScriptedSource {
  language: ScriptLanguage;
  /** Paths relative to the schematic, best first. The host opens the first that exists. */
  candidates: string[];
  /** The one to offer to create. Always `candidates[0]`. */
  create: string;
  /**
   * Set when `candidates` is a convention rather than something the document
   * states — i.e. for `cscript`, whose parameter names a binary. Shown to the
   * user, because "we guessed" is information they need.
   */
  inferred: boolean;
}

const EXTENSIBILITY = /^extensibility\.(cscript|pyblock|pyfunc|octblock|octfunc)$/;

export function isScriptedBlockType(type: string): boolean {
  return EXTENSIBILITY.test(type);
}

function languageOf(type: string): ScriptLanguage | null {
  if (type === "extensibility.cscript") return "c";
  if (type === "extensibility.pyblock" || type === "extensibility.pyfunc") return "python";
  if (type === "extensibility.octblock" || type === "extensibility.octfunc") return "octave";
  return null;
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/** `build/ctrl.so` -> `ctrl`. Also copes with `ctrl` and `ctrl.dylib`. */
function stem(path: string): string {
  const base = path.replace(/\\/g, "/").split("/").pop() ?? path;
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(0, dot) : base;
}

function directory(path: string): string {
  const normalised = path.replace(/\\/g, "/");
  const slash = normalised.lastIndexOf("/");
  return slash < 0 ? "" : normalised.slice(0, slash);
}

function join(folder: string, name: string): string {
  return folder === "" ? name : `${folder}/${name}`;
}

/**
 * Where to look for a `cscript` block's source.
 *
 * `blocks/` first, because that is the convention the spec settles on and the
 * directory a created file goes into; then beside the binary, which is what
 * someone who put `ctrl.c` and `ctrl.so` in one folder will expect; then the
 * schematic's own folder and `src/`. `.c` before `.cpp` at each step.
 */
function cscriptCandidates(lib: string, blockId: string): string[] {
  const name = lib === "" ? blockId : stem(lib);
  const folders = ["blocks", directory(lib), "", "src"];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const folder of folders) {
    for (const extension of [".c", ".cpp"]) {
      const candidate = join(folder, `${name}${extension}`);
      if (seen.has(candidate)) continue;
      seen.add(candidate);
      out.push(candidate);
    }
  }
  return out;
}

/**
 * The source file a block's double-click should open, or null when the block
 * is not a scripted one or names nothing to open.
 *
 * Returns null — rather than inventing a name — when a `path`-carrying block
 * has an empty `path`. The block simply has no source yet, and the answer to
 * that is the Inspector's Path field, not a file the user did not ask for.
 */
export function scriptedSourceFor(block: ScriptedBlock): ScriptedSource | null {
  const language = languageOf(block.type);
  if (!language) return null;

  if (block.type === "extensibility.cscript") {
    const candidates = cscriptCandidates(text(block.params.lib), block.id);
    return {
      language,
      candidates,
      create: candidates[0] as string,
      inferred: true,
    };
  }

  const path = text(block.params.path);
  if (path === "") return null;

  // `octblock`'s `path` is a directory holding `<function>_start.m` and
  // `<function>.m`; the one to open is the function itself.
  if (block.type === "extensibility.octblock") {
    const fn = text(block.params.function) || "block";
    const file = join(path, `${fn}.m`);
    return { language, candidates: [file], create: file, inferred: false };
  }

  return { language, candidates: [path], create: path, inferred: false };
}

function portNames(value: unknown, fallback: string, count = 1): string[] {
  const list = Array.isArray(value)
    ? (value as unknown[]).filter((entry): entry is string => typeof entry === "string")
    : typeof value === "string"
      ? value
          .split(",")
          .map((part) => part.trim())
          .filter((part) => part !== "")
      : [];
  if (list.length > 0) return list;
  return Array.from({ length: count }, (_, index) => `${fallback}${index + 1}`);
}

/**
 * A runnable file with the block's own port names already in it.
 *
 * Getting the entry point's name or argument order wrong is the dominant
 * beginner failure with these blocks, and the editor knows the answer: it has
 * the block's type and its declared ports. A correct file is worth more here
 * than any amount of documentation.
 */
export function sourceStub(block: ScriptedBlock): string {
  const inputs = portNames(block.params.input_names, "u");
  const outputs = portNames(block.params.output_names, "y");
  const fn = text(block.params.function);

  if (block.type === "extensibility.cscript") {
    // `cscript_arity` is the one thing a .c file says about its shape that the
    // engine itself checks against the netlist before the first step
    // (general-simulator#30), so the stub declares it rather than leaving the
    // counts to be inferred from how far the code indexes.
    return [
      `/* ${block.id}: ${inputs.length} input(s), ${outputs.length} output(s).`,
      " *",
      " * Build this into the shared library the block's `lib` parameter names. A real",
      " * block is usually a thin adapter like this one plus one or two shared sources --",
      " * a control law, a modulator, a transform -- reused by several blocks on the same",
      " * sheet, so the build line takes a list and an include path:",
      " *",
      ` *     cc -shared -fPIC -O2 -I include -o <lib> ${block.id}.c <shared sources...> -lm`,
      " *",
      " * `-lm` because almost every block reaches for math.h. The engine loads the binary;",
      " * it never compiles anything itself.",
      " *",
      ' * In C++, every export below must be `extern "C"` or the names are mangled',
      " * and the engine reports a missing symbol.",
      " *",
      " * The prototypes below are the engine's ABI, from `general-simulator`'s",
      " * crates/cscript-ffi/src/lib.rs. Copy them exactly: a declaration that merely looks",
      " * right can pass arguments in the wrong registers on one platform and the right ones",
      " * on another.",
      " */",
      "#include <stdlib.h>",
      "",
      "/* Checked against the netlist before the run starts. */",
      "int cscript_arity(int *in_len, int *out_len) {",
      `    *in_len = ${inputs.length};`,
      `    *out_len = ${outputs.length};`,
      "    return 0;",
      "}",
      "",
      "void *cscript_start(void) {",
      "    return NULL; /* no state */",
      "}",
      "",
      "/* A cscript block never receives absolute time: there is no `t` in this ABI, and",
      " * nothing in the engine passes one. A block that needs time takes it as an input",
      " * signal, wired from a kind=time block on the sheet.",
      " */",
      "void cscript_output(void *state, const double *in, int in_len, double dt,",
      "                    double *out, int out_len) {",
      "    (void)state; (void)in_len; (void)dt; (void)out_len;",
      ...inputs.map((name, index) => `    /* in[${index}] is ${name} */`),
      ...outputs.map((name, index) => `    out[${index}] = 0.0; /* ${name} */`),
      "}",
      "",
      "/* Needed only for adaptive stepping, which this editor does not use. */",
      "/* void *cscript_clone(void *state) { return state; } */",
      "",
    ].join("\n");
  }

  if (block.type === "extensibility.pyfunc") {
    const name = fn || "block";
    return [
      `"""${block.id}: called as ${name}(${inputs.join(", ")}), matched by position."""`,
      "",
      "",
      `def ${name}(${inputs.join(", ")}):`,
      `    return ${outputs.map(() => "0.0").join(", ")}`,
      "",
    ].join("\n");
  }

  if (block.type === "extensibility.pyblock") {
    return [
      `"""${block.id}: inputs ${inputs.join(", ")}; outputs ${outputs.join(", ")}."""`,
      "",
      "",
      "def start():",
      "    return {}",
      "",
      "",
      "def output(state, t, dt, inputs):",
      `    ${inputs.join(", ")}${inputs.length === 1 ? "," : ""} = inputs`,
      `    return ${outputs.map(() => "0.0").join(", ")}`,
      "",
    ].join("\n");
  }

  // Octave, both kinds. The file name must equal the function name.
  const name = fn || "block";
  return [
    `function [${outputs.join(", ")}] = ${name}(${inputs.join(", ")})`,
    `  % ${block.id}`,
    ...outputs.map((output) => `  ${output} = 0;`),
    "end",
    "",
  ].join("\n");
}

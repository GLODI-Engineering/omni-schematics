/**
 * The one route from a `.gsim_sch` document to a netlist.
 *
 * Plain JavaScript on purpose. Three callers have to take *the same* route
 * through the engine, and they do not share a build:
 *
 *   - the webview (`apps/frontend/src/engine/engine.ts`), bundled by Vite;
 *   - `scripts/check-examples.mjs`, a bare Node script with no transpiler;
 *   - the extension host, and the release gate, which are also bare Node.
 *
 * TypeScript would exclude the second and third; a copy in each would
 * reintroduce #143 — a gate and a product reaching the compiler by two
 * different routes, so that a transform on one of them is invisible to the
 * other by construction. That bug cost every example its ability to compile
 * while the gate reported five examples OK. There is one route and this is it.
 *
 * It is also the whole of what `simulator.compiler.gsim_py_netlist` and
 * `simulator.compiler.compile_input` used to be: wrap a bare model into a
 * document, let the engine validate and canonicalise it, compile the model
 * inside. Everything else those modules did — expression evaluation,
 * Goto/From resolution, subcircuit flattening, loading, writing — the engine
 * does, and did already.
 */

/** The document schema version `loadDocument` accepts. */
export const SCHEMA_VERSION = 2;

/** The only compile target the engine has. */
export const DEFAULT_TARGET = "general-simulator";

/**
 * A document, in the shape the engine is given.
 *
 * `input` may be any of the three things a caller actually holds:
 *
 *   - the text of a `.gsim_sch` file (`scripts/check-examples.mjs`);
 *   - a parsed `{schema_version, model}` document;
 *   - a bare model — what the editor's own store holds, and what the IPC
 *     `simulate` payload used to carry.
 *
 * A bare model is wrapped rather than compiled directly, so that every caller
 * goes through `loadDocument` and gets the engine's own schema check. The
 * input is never modified.
 */
export function asDocumentText(input) {
  const parsed = typeof input === "string" ? JSON.parse(input) : input;
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new TypeError("a .gsim_sch document is a JSON object");
  }
  if ("schema_version" in parsed && "model" in parsed) {
    return JSON.stringify(parsed);
  }
  return JSON.stringify({ schema_version: SCHEMA_VERSION, model: parsed });
}

/**
 * Compile a document to netlist text, with the compiler's own notes.
 *
 * `engine` is the initialised `@gensim/gsim-wasm` module namespace — see
 * `./node.js` for Node and `apps/frontend/src/engine/engine.ts` for the
 * webview. Passed in rather than imported here because initialising the
 * WebAssembly module is the one thing that differs between the two, and a
 * module that fetches its own `.wasm` cannot serve both.
 *
 * Returns `{netlist, notes, provenance}` — the engine's own shape, unaltered.
 * `notes` are decisions the compiler made *for* the user rather than errors:
 * the reference net it picked, and the DC references it added for nodes
 * nothing else ties down. That second kind has to reach the user, because the
 * alternative is silent — an unreferenced node does not fail the solve, it
 * returns a different answer.
 *
 * Throws the engine's own `Error`, message and all, on a document that does
 * not compile (`floating-port`, `unknown-type`, a missing parameter).
 */
export function compileDocument(engine, input, target = DEFAULT_TARGET) {
  const document = JSON.parse(engine.loadDocument(asDocumentText(input)));
  const model = "model" in document ? document.model : document;
  const result = JSON.parse(engine.compile(JSON.stringify(model), target));
  return {
    netlist: result.netlist,
    notes: result.notes ?? [],
    provenance: result.provenance ?? null,
  };
}

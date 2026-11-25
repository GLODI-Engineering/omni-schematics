/**
 * The engine, inside the editor.
 *
 * `gsim-core` compiled to WebAssembly — the same Rust that `gsim_tools` and
 * the component catalogue come from, running in the webview. Before #158 the
 * editor posted the whole document to a Python kernel and let
 * `simulator.compiler.gsim_py_netlist` compile it there, which meant the
 * editor's compiler and the engine's were two programs: one in Rust, one a
 * 1,600-line Python reimplementation of expression evaluation, Goto/From
 * resolution, subcircuit flattening and document I/O. They drifted (#143,
 * #153). There is one now, and it is this.
 *
 * ## Why the module is a singleton with an async door
 *
 * `WebAssembly.instantiate` is asynchronous and the compile itself is not, so
 * the shape that fits is: await the engine once, then call it synchronously
 * for the rest of the session. Run is the only caller that needs it today, so
 * the instantiation is lazy — opening a sheet does not pay for a compiler the
 * user may never invoke, and a 1.7 MB module is not something to fetch on the
 * off chance.
 *
 * ## Why `initEngine` takes an optional source
 *
 * The bundle is `wasm-pack --target web` output, whose loader fetches a URL.
 * That is right in the webview and wrong in a test runner: `fetch` of a
 * `file:` URL fails under Node. A test hands the bytes in instead. The webview
 * never passes anything, so the default path is the only one shipped.
 *
 * ## The CSP this needs
 *
 * Instantiating a module requires `'wasm-unsafe-eval'` in the webview's
 * `script-src` — see `apps/vscode-extension/src/webview-html.ts`, which
 * explains at length why `'unsafe-eval'` is *not* there and must not come
 * back. `'wasm-unsafe-eval'` is the narrow directive that permits WebAssembly
 * compilation and nothing else: no `new Function`, no `eval`. The rule that
 * nothing in the bundle may generate JavaScript at runtime still holds.
 */

import init from "@gensim/gsim-wasm";
import * as engine from "@gensim/gsim-wasm";
import { compileDocument } from "@gensim/gsim-wasm/compile";
import type { CompileResult, Engine } from "@gensim/gsim-wasm/compile";
import wasmUrl from "@gensim/gsim-wasm/wasm?url";

export type { CompileResult };

let ready: Promise<Engine> | null = null;

/**
 * The initialised engine. Idempotent; the first caller pays for the fetch.
 *
 * `source` is for tests only (bytes, or a `WebAssembly.Module`). In the webview
 * the `.wasm` is an ordinary bundled asset, fetched from the extension's own
 * `vscode-webview-resource:` origin, which the CSP's `connect-src` already
 * allows.
 */
export function initEngine(source?: BufferSource | WebAssembly.Module): Promise<Engine> {
  if (ready === null) {
    ready = init({ module_or_path: source ?? wasmUrl }).then(() => engine as unknown as Engine);
  }
  return ready;
}

/** For tests: forget the instantiated engine so the next `initEngine` re-runs. */
export function resetEngineForTests(): void {
  ready = null;
}

/**
 * Compile a document or a bare model to netlist text.
 *
 * Synchronous, and deliberately so: the engine is already in the page by the
 * time this is called, and a compile of a sheet-sized document is sub-
 * millisecond. The route itself lives in `@gensim/gsim-wasm/compile`, shared
 * byte for byte with `scripts/check-examples.mjs` and the release gate, so
 * that the thing the gates compile is the thing the Run button compiles — the
 * lesson of #143, where a transform on the product's route alone turned every
 * example into `floating-port` while the gate reported five examples OK.
 *
 * Throws the engine's own `Error`, message intact, when the document does not
 * compile.
 */
export function compileSchematic(engineModule: Engine, document: unknown): CompileResult {
  return compileDocument(engineModule, document as object);
}

/** The engine's version string, once it is loaded. */
export function engineVersion(engineModule: Engine): string {
  return engineModule.version();
}

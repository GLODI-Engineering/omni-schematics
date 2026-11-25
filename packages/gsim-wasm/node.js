/**
 * The engine, in a Node process.
 *
 * The bundle is built with `wasm-pack --target web`, which is the target the
 * webview needs; its loader fetches a URL. Node 20 has `fetch`, but not for
 * `file:` URLs, so the bytes are read here and handed over directly — which
 * `wasm-bindgen`'s loader accepts as a `BufferSource`. One bundle serves both
 * hosts, and the only difference between them is these six lines.
 *
 * Used by `scripts/check-examples.mjs`, by the release gate in
 * `.github/workflows/release.yml`, and by the extension host.
 */
import { readFile } from "node:fs/promises";

import init, * as engine from "./pkg/gsim_wasm.js";

let ready = null;

/**
 * The initialised engine module namespace. Idempotent, and cheap after the
 * first call: `wasm-bindgen`'s loader memoises the instantiation itself.
 */
export function loadEngine() {
  if (ready === null) {
    ready = readFile(new URL("./pkg/gsim_wasm_bg.wasm", import.meta.url))
      .then((bytes) => init({ module_or_path: bytes }))
      .then(() => engine);
  }
  return ready;
}

export { compileDocument, asDocumentText, DEFAULT_TARGET, SCHEMA_VERSION } from "./compile.js";

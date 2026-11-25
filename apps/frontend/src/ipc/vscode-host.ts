/**
 * Thin wrapper around the VS Code webview <-> extension-host message channel.
 *
 * Every General Simulator webview (the schematic custom editor, the library
 * sidebar view, the waveform panel) talks to the extension host through this
 * module. Outside VS Code — the Vite dev server, vitest, the Tauri shell — all
 * of these are inert no-ops, so component code can call them unconditionally.
 */

import {
  GSIM_INIT_GLOBAL,
  type HostBoundMessage,
  type OpenBlockSourceResult,
  type WebviewBoundMessage,
  type WebviewInit,
} from "./vscode-protocol";

export interface VsCodeApi {
  postMessage(message: unknown): void;
  getState(): unknown;
  setState(state: unknown): unknown;
}

type HostGlobals = typeof globalThis & {
  acquireVsCodeApi?: () => VsCodeApi;
  /** Handle acquired by the extension host's injected bootstrap script. */
  __GSIM_VSCODE_API__?: VsCodeApi;
  [GSIM_INIT_GLOBAL]?: WebviewInit;
};

// `acquireVsCodeApi()` may only be called once per webview document.
let cachedApi: VsCodeApi | null | undefined;

export function getVsCodeApi(): VsCodeApi | null {
  if (cachedApi !== undefined) {
    return cachedApi;
  }
  const globals = globalThis as HostGlobals;
  // The injected bootstrap already acquired it (calling twice throws), so
  // prefer its handle and only fall back for safety.
  if (globals.__GSIM_VSCODE_API__) {
    cachedApi = globals.__GSIM_VSCODE_API__;
    return cachedApi;
  }
  cachedApi = typeof globals.acquireVsCodeApi === "function" ? globals.acquireVsCodeApi() : null;
  return cachedApi;
}

/** Test seam: lets vitest install a fake host API. */
export function setVsCodeApi(api: VsCodeApi | null): void {
  cachedApi = api;
}

export function isVsCodeHost(): boolean {
  return getVsCodeApi() !== null;
}

export function getWebviewInit(): WebviewInit | null {
  return (globalThis as HostGlobals)[GSIM_INIT_GLOBAL] ?? null;
}

export function postToHost(message: HostBoundMessage): void {
  getVsCodeApi()?.postMessage(message);
}

/**
 * Subscribe to messages sent by the extension host. Returns an unsubscribe fn.
 */
export function onHostMessage(handler: (message: WebviewBoundMessage) => void): () => void {
  const listener = (event: MessageEvent) => {
    const data = event.data as WebviewBoundMessage | undefined;
    if (data && typeof data === "object" && typeof data.type === "string") {
      if (data.type.startsWith("gsim/")) {
        handler(data);
      }
    }
  };
  globalThis.addEventListener("message", listener as EventListener);
  return () => {
    globalThis.removeEventListener("message", listener as EventListener);
  };
}

/**
 * Ask the extension host for a workspace file's text.
 *
 * Used to show what ports a scripted block's source looks like it expects.
 * Resolves to `null` outside VS Code, where there is no host to ask and no
 * filesystem to read — the caller shows nothing rather than an error, since
 * "this only works in the editor" is not news worth interrupting for.
 */
export function requestSource(path: string, timeoutMs = 5_000): Promise<string | null> {
  const init = getWebviewInit();
  if (init === null) return Promise.resolve(null);

  const requestId = `src-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  return new Promise((resolve) => {
    const done = (value: string | null) => {
      clearTimeout(timer);
      stop();
      resolve(value);
    };
    const timer = setTimeout(() => done(null), timeoutMs);
    const stop = onHostMessage((message) => {
      if (message.type !== "gsim/sourceContent" || message.requestId !== requestId) return;
      done(typeof message.text === "string" ? message.text : null);
    });
    postToHost({
      type: "gsim/readSource",
      requestId,
      path,
      // A block parameter is written relative to the sheet it is on. Reading it
      // relative to the workspace root worked only while the two were the same
      // directory, and it meant the Inspector could report the ports of one
      // file while a double-click opened another (#212).
      ...(init.documentUri ? { relativeTo: init.documentUri } : {}),
    });
  });
}

/**
 * Ask the extension host to open a scripted block's source in a text editor.
 *
 * The webview says which paths it would accept and what an empty file should
 * contain; the **host** decides whether a path may be opened at all, and does
 * the opening. A webview cannot read a file, cannot create one, and must not
 * be the thing that adjudicates a path a document handed it.
 *
 * Resolves to `null` outside VS Code — the dev harness and vitest, where there
 * is no host and no filesystem.
 */
export function requestOpenBlockSource(
  request: {
    blockId: string;
    candidates: string[];
    create: string;
    stub: string;
  },
  timeoutMs = 20_000,
): Promise<OpenBlockSourceResult | null> {
  const init = getWebviewInit();
  if (init === null) return Promise.resolve(null);

  const requestId = `open-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  return new Promise((resolve) => {
    const done = (value: OpenBlockSourceResult | null) => {
      clearTimeout(timer);
      stop();
      resolve(value);
    };
    // Generous, because the host may be waiting on a modal confirmation —
    // "this file does not exist, create it?" is a question with a person on
    // the other end of it.
    const timer = setTimeout(() => done(null), timeoutMs);
    const stop = onHostMessage((message) => {
      if (message.type !== "gsim/blockSourceOpened" || message.requestId !== requestId) return;
      done(message.result);
    });
    postToHost({
      type: "gsim/openBlockSource",
      requestId,
      ...request,
      ...(init.documentUri ? { relativeTo: init.documentUri } : {}),
    });
  });
}

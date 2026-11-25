/**
 * Ask the extension host for byte ranges of a `.gsim_samples` container, and
 * wait for its answer (#157).
 *
 * ## Why the bytes make this trip at all
 *
 * A webview can run WebAssembly and cannot read a file. The extension host can
 * read a file and cannot load the WebAssembly — `vsce package
 * --no-dependencies` ships no `node_modules`, so a value import of a workspace
 * package from the host throws `Cannot find module` on every machine but a
 * developer's, which is the decision recorded on #175. Neither side can do
 * this alone, so: the webview plans which ranges it needs, the host fetches
 * them, the webview decimates.
 *
 * What makes that affordable rather than a round trip per sample is the
 * container. Which ranges a window needs is decided from the stripe directory
 * and index arithmetic alone — no sample value takes part — so one plan
 * answers one view, and a view is tens of kilobytes whatever the run's length.
 *
 * Outside VS Code — the Vite dev server, the Playwright harness, vitest —
 * there is no host, and this says so rather than hanging.
 */

import type { SamplesRange, SamplesReadResult } from "@gensim/webview-protocol";

import { isVsCodeHost, onHostMessage, postToHost } from "../ipc/vscode-host";

export type { SamplesRange, SamplesReadResult };

export const NO_HOST_REASON =
  "Reading a sample container needs the Omni Schematics extension host: a webview cannot " +
  "open a file. Open the result in VS Code to plot it.";

/** How long to wait before giving up on a host that stopped listening. */
const DEFAULT_TIMEOUT_MS = 30_000;

export interface SamplesReadTarget {
  /** Absolute, or relative to {@link SamplesReadTarget.relativeTo}. */
  path: string;
  /** URI of the document `path` is relative to, when it is relative. */
  relativeTo?: string;
}

/**
 * Post the request and resolve with the host's reply.
 *
 * Always settles, for the reason `run-host.ts` gives: the host answers every
 * `gsim/readSamples` with a `gsim/samplesBytes`, including a refusal, and a
 * reader left waiting on bytes that never come shows an empty plot — which is
 * the one thing FE-146 says must not be presented as a result.
 */
export function requestSamples(
  target: SamplesReadTarget,
  ranges: SamplesRange[],
  options: { timeoutMs?: number } = {},
): Promise<SamplesReadResult> {
  if (!isVsCodeHost()) {
    return Promise.resolve({ ok: false, summary: NO_HOST_REASON });
  }

  const requestId = `samples-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  return new Promise<SamplesReadResult>((resolve) => {
    const finish = (result: SamplesReadResult) => {
      clearTimeout(timer);
      stop();
      resolve(result);
    };
    const timer = setTimeout(
      () =>
        finish({
          ok: false,
          summary:
            "The extension host never answered a request for the result's samples. " +
            "Check the Omni Schematics output channel, and reload the window if it is empty.",
        }),
      options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    );
    const stop = onHostMessage((message) => {
      if (message.type === "gsim/samplesBytes" && message.requestId === requestId) {
        finish(message.result);
      }
    });
    postToHost({
      type: "gsim/readSamples",
      requestId,
      request: {
        path: target.path,
        ...(target.relativeTo ? { relativeTo: target.relativeTo } : {}),
        ranges,
      },
    });
  });
}

/**
 * `[offset, len, offset, len, …]`, as `SamplesFile` hands spans back, turned
 * into the list this channel carries.
 *
 * Flat across the WebAssembly boundary because a pair of numbers per range is
 * not worth an object each; objects on the wire because a message is JSON and
 * `{offset, length}` is the shape that survives being read by a human in a
 * log.
 */
export function rangesFromSpans(spans: Float64Array): SamplesRange[] {
  const ranges: SamplesRange[] = [];
  for (let i = 0; i + 1 < spans.length; i += 2) {
    ranges.push({ offset: spans[i] as number, length: spans[i + 1] as number });
  }
  return ranges;
}

/** Base64 of one range, back to bytes. */
export function bytesFromBase64(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

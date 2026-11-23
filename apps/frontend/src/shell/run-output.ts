/**
 * Forward a run's output to the extension host, for VS Code's Output panel.
 *
 * #139. The webview talks to the kernel over its own socket, so the host sees
 * nothing of a run unless it is told. Everything here is additive: output still
 * goes to the webview's own Output tab exactly as before, because that tab is
 * the only one a browser-hosted shell has.
 *
 * Outside a VS Code host -- the Playwright harness, the dev server -- this is
 * inert rather than an error. There is no panel to write to, and a run in that
 * shell is not broken for the lack of one.
 */
import type { RunOutputLine, RunOutputSeverity, RunOutputSource } from "@gensim/webview-protocol";

import { isVsCodeHost, postToHost } from "../ipc/vscode-host";

export type { RunOutputLine, RunOutputSeverity, RunOutputSource };

/**
 * Send lines to the host, if there is one.
 *
 * Batched rather than one message per line: a run emits thousands of lines and
 * each `postMessage` is a structured-clone hop across the webview boundary.
 */
export function reportRunOutput(lines: readonly RunOutputLine[]): void {
  if (lines.length === 0 || !isVsCodeHost()) {
    return;
  }
  postToHost({ type: "gsim/output", lines: [...lines] });
}

/** One line, for the many call sites that have exactly one. */
export function reportRunLine(
  source: RunOutputSource,
  severity: RunOutputSeverity,
  text: string,
): void {
  reportRunOutput([{ source, severity, text }]);
}

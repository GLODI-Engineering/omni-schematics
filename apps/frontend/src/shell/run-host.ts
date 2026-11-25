/**
 * Ask the extension host to run a netlist, and wait for its answer (#159).
 *
 * ## The direction of travel
 *
 * One way, already compiled, as a string. The webview holds the engine
 * (`../engine/engine.ts`) and compiles its own sheet; the host does what a
 * webview cannot — resolve a binary, spawn it, read and write files, own an
 * Output channel. Nothing is passed *back* in to ask what a block means, which
 * is the shape #175 warned about and the division its decision settles.
 *
 * ## Why this replaced a socket
 *
 * The webview used to open `ws://127.0.0.1:<port>` to a Python sidecar that
 * found the solver binary, spawned it, read what it printed and timed it out —
 * 794 lines of Python wrapping a process the extension host was already
 * perfectly placed to start. The host now starts it directly, so a machine
 * with no Python runs a simulation, which is the whole of the milestone.
 *
 * Outside VS Code — the Vite dev server, the Playwright harness, vitest —
 * there is no host, and this says so rather than hanging. A browser-hosted
 * shell can still compile a sheet and read its netlist; it cannot spawn a
 * process, and never could.
 */

import type { RunRequest, RunResult } from "@gensim/webview-protocol";

import { isVsCodeHost, onHostMessage, postToHost } from "../ipc/vscode-host";

export type { RunRequest, RunResult };

/** The request id of the run in flight, so Stop can name it. */
let inFlight: string | null = null;

export function runInFlight(): string | null {
  return inFlight;
}

/**
 * Why a run cannot even be asked for. Distinct from a run that was asked for
 * and failed, because the user can do nothing about this one.
 */
export const NO_HOST_REASON =
  "Running a simulation needs the Omni Schematics extension host, which starts the " +
  "general-simulator binary. This shell has none — open the schematic in VS Code to run it.";

/**
 * Post the request and resolve with the host's reply.
 *
 * Always settles: the host answers every `gsim/runSimulation` with a
 * `gsim/runResult`, including for a solver it could not find, and the only way
 * a reply goes missing is the host process dying. `timeoutMs` bounds that
 * case, and it is deliberately long — the solver's own deadline is
 * `omniSchematics.solverTimeoutSeconds`, enforced where the process is, and
 * this is only a guard against a host that stopped listening.
 */
export function requestRun(
  request: RunRequest,
  options: { timeoutMs?: number } = {},
): Promise<RunResult> {
  if (!isVsCodeHost()) {
    return Promise.resolve({
      ok: false,
      kind: "could-not-start",
      summary: "There is no extension host to run the solver",
      detail: NO_HOST_REASON,
    });
  }

  const requestId = `run-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  inFlight = requestId;

  return new Promise<RunResult>((resolve) => {
    const finish = (result: RunResult) => {
      clearTimeout(timer);
      stop();
      if (inFlight === requestId) {
        inFlight = null;
      }
      resolve(result);
    };

    const timer = setTimeout(
      () =>
        finish({
          ok: false,
          kind: "could-not-start",
          summary: "The extension host never answered",
          detail:
            "The run was sent to the extension host and no result came back. " +
            "Check the Omni Schematics output channel, and reload the window if it is empty.",
        }),
      options.timeoutMs ?? 24 * 60 * 60 * 1000,
    );

    const stop = onHostMessage((message) => {
      if (message.type === "gsim/runResult" && message.requestId === requestId) {
        finish(message.result);
      }
    });

    postToHost({ type: "gsim/runSimulation", requestId, request });
  });
}

/**
 * Stop the run in flight, if there is one.
 *
 * The host signals the solver process itself. Stop used to close the kernel
 * socket, which left the solver running as the sidecar's child with nothing
 * watching it.
 */
export function cancelRun(): void {
  if (!inFlight || !isVsCodeHost()) {
    return;
  }
  postToHost({ type: "gsim/cancelRun", requestId: inFlight });
}

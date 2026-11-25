/**
 * #159: asking the extension host to run a netlist.
 *
 * Three things are worth pinning: what goes out, that the matching reply comes
 * back, and that a shell with no host says so instead of hanging. The last one
 * is the Playwright harness and the Vite dev server, where there is no process
 * to spawn a solver and never was.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { setVsCodeApi } from "../ipc/vscode-host";

import { NO_HOST_REASON, cancelRun, requestRun, runInFlight } from "./run-host";

const posted: Array<Record<string, unknown>> = [];

const request = {
  mode: "transient" as const,
  netlist: "* deck\nr1 a 0 1\n",
  tEnd: 0.01,
  tStep: 1e-6,
  analysis: "TRAN",
};

/** Reply the way the host does: a `message` event on the window. */
function replyFromHost(message: unknown): void {
  globalThis.dispatchEvent(new MessageEvent("message", { data: message }));
}

function installFakeHost(onPost?: (message: Record<string, unknown>) => void): void {
  setVsCodeApi({
    postMessage: (message: unknown) => {
      posted.push(message as Record<string, unknown>);
      onPost?.(message as Record<string, unknown>);
    },
    getState: () => null,
    setState: (state: unknown) => state,
  });
}

beforeEach(() => {
  posted.length = 0;
});

afterEach(() => {
  setVsCodeApi(null);
});

describe("requestRun", () => {
  it("posts the netlist, already compiled, and resolves with the host's reply", async () => {
    const result = {
      ok: true,
      resultPath: "/w/.gsim/runs/run-1/result.gsim_sim_result",
      samplesPath: "/w/.gsim/runs/run-1/run.gsim_samples",
      samplesBytes: 953,
      rows: 20,
      signals: ["V(a)"],
      worstSeverity: null,
      events: [],
      eventsTotal: 0,
    };
    installFakeHost((message) => {
      // Answered on the next tick, the way a real host does.
      setTimeout(() =>
        replyFromHost({ type: "gsim/runResult", requestId: message.requestId, result }),
      );
    });

    const answer = await requestRun(request);
    expect(posted).toHaveLength(1);
    expect(posted[0]).toMatchObject({ type: "gsim/runSimulation", request });
    expect(answer).toEqual(result);
    // And the run is no longer in flight, so Stop has nothing to name.
    expect(runInFlight()).toBe(null);
  });

  it("ignores a reply for a different request", async () => {
    installFakeHost((message) => {
      setTimeout(() => {
        replyFromHost({ type: "gsim/runResult", requestId: "someone-else", result: { ok: true } });
        replyFromHost({
          type: "gsim/runResult",
          requestId: message.requestId,
          result: { ok: false, kind: "failed", summary: "mine" },
        });
      });
    });

    const answer = await requestRun(request);
    expect(answer).toEqual({ ok: false, kind: "failed", summary: "mine" });
  });

  it("answers rather than hanging when there is no host at all", async () => {
    // A browser-hosted shell can compile a sheet and read its netlist; it
    // cannot spawn a process.
    const answer = await requestRun(request);
    expect(answer.ok).toBe(false);
    if (!answer.ok) {
      expect(answer.detail).toBe(NO_HOST_REASON);
    }
    expect(posted).toHaveLength(0);
  });

  it("gives up if the host never answers, and says that is what happened", async () => {
    installFakeHost();
    const answer = await requestRun(request, { timeoutMs: 10 });
    expect(answer.ok).toBe(false);
    if (!answer.ok) {
      expect(answer.summary).toMatch(/never answered/);
    }
  });
});

describe("cancelRun", () => {
  it("names the run in flight, so the host knows which child to signal", async () => {
    let requestId: unknown;
    installFakeHost((message) => {
      if (message.type === "gsim/runSimulation") {
        requestId = message.requestId;
        cancelRun();
        setTimeout(() =>
          replyFromHost({
            type: "gsim/runResult",
            requestId: message.requestId,
            result: { ok: false, kind: "failed", summary: "stopped" },
          }),
        );
      }
    });

    await requestRun(request);
    expect(posted[1]).toEqual({ type: "gsim/cancelRun", requestId });
  });

  it("is silent when nothing is running", () => {
    installFakeHost();
    cancelRun();
    expect(posted).toHaveLength(0);
  });
});

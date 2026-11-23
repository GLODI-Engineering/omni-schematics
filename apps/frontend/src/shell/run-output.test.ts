/**
 * #139: forwarding run output to the extension host.
 *
 * The two things worth pinning are that it reaches the host when there is one,
 * and that it is silent when there is not -- the Playwright harness and the dev
 * server have no panel to write to, and a run there is not broken for it.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { setVsCodeApi } from "../ipc/vscode-host";

import { reportRunLine, reportRunOutput } from "./run-output";

const posted: unknown[] = [];

beforeEach(() => {
  posted.length = 0;
});

afterEach(() => {
  setVsCodeApi(null);
});

function installFakeHost(): void {
  setVsCodeApi({
    postMessage: (message: unknown) => {
      posted.push(message);
    },
    getState: () => null,
    setState: (state: unknown) => state,
  });
}

describe("reportRunOutput", () => {
  it("sends one batched message, not one per line", () => {
    // A run emits thousands of lines and every postMessage is a
    // structured-clone hop across the webview boundary.
    installFakeHost();

    reportRunOutput([
      { source: "solver", severity: "info", text: "a" },
      { source: "solver", severity: "info", text: "b" },
      { source: "build", severity: "error", text: "c" },
    ]);

    expect(posted).toHaveLength(1);
    expect(posted[0]).toEqual({
      type: "gsim/output",
      lines: [
        { source: "solver", severity: "info", text: "a" },
        { source: "solver", severity: "info", text: "b" },
        { source: "build", severity: "error", text: "c" },
      ],
    });
  });

  it("is inert with no extension host, rather than throwing", () => {
    setVsCodeApi(null);
    expect(() => reportRunLine("solver", "error", "boom")).not.toThrow();
    expect(posted).toEqual([]);
  });

  it("posts nothing for an empty batch", () => {
    installFakeHost();
    reportRunOutput([]);
    expect(posted).toEqual([]);
  });

  it("carries the source through, so the host can label it", () => {
    installFakeHost();
    reportRunLine("kernel", "error", "no interpreter at that path");
    expect(posted).toEqual([
      {
        type: "gsim/output",
        lines: [{ source: "kernel", severity: "error", text: "no interpreter at that path" }],
      },
    ]);
  });
});

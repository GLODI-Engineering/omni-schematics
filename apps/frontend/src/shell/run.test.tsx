/**
 * Simulate (Ctrl+T): what Run asks for, and what it says about the answer.
 *
 * Rewritten by #159. These tests used to mock the kernel socket's `execute`
 * and assert on the manifest it answered with; the solver runs in the
 * extension host now, so what is mocked is the host request and what is
 * asserted is the request's shape and the reporting of its outcome. The axes
 * layout the old version checked through this path moved to
 * `waveform/populate.test.ts` with `populateWaveformViewer`.
 */

import { act, render } from "@testing-library/react";
import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { RunButton } from "./RunButton";
import { triggerCancel, triggerRun } from "./run";

// ---------------------------------------------------------------------------
// The host, and the compiler
// ---------------------------------------------------------------------------
const mockRequestRun = vi.hoisted(() => vi.fn());
const mockCancelRun = vi.hoisted(() => vi.fn());
vi.mock("./run-host", () => ({
  requestRun: mockRequestRun,
  cancelRun: mockCancelRun,
  runInFlight: () => null,
}));

const mockSetProblems = vi.fn();
const mockSetActiveEditorTab = vi.fn();
const mockAppendOutput = vi.fn();
const mockSetSimProgress = vi.fn();
const mockSetRunStartedAt = vi.fn();
const mockSetLastNetlist = vi.fn();
const mockOpenDiagnostics = vi.fn();

// The compiler is in the editor now (#158), so Run goes through it before it
// reaches the host. These tests are about the run flow, not about compiling:
// `src/engine/engine.test.ts` is where the real engine compiles real documents
// and is held to the netlist, byte for byte.
const mockInitEngine = vi.hoisted(() => vi.fn().mockResolvedValue({}));
const mockCompileSchematic = vi.hoisted(() =>
  vi.fn(() => ({ netlist: "* mocked\nr1 n1 0 1\n", notes: [], provenance: null })),
);
vi.mock("../engine/engine", () => ({
  initEngine: mockInitEngine,
  compileSchematic: mockCompileSchematic,
  resetEngineForTests: () => {},
  engineVersion: () => "0.0.0-test",
}));

let isModelValid = true;
vi.mock("../store", () => ({
  useGraphStore: {
    getState: () => ({
      document: {
        model: {
          name: "sheet",
          // One block, because Run refuses an empty sheet rather than sending
          // a netlist with nothing in it. The empty case has its own tests in
          // run-feedback.test.ts.
          blocks: [{ id: "a" }],
          wires: isModelValid
            ? []
            : [{ from: { block: "a", port: "out" }, to: { block: "a", port: "in" } }],
        },
      },
    }),
  },
  useIpcStore: {
    getState: () => ({
      status: "idle",
      // Read by `publishCompilerNotes` and `publishRunEvents`, which Run calls
      // on every run so neither outlives the edit that fixed it.
      problems: [],
      setProblems: mockSetProblems,
      setActiveEditorTab: mockSetActiveEditorTab,
      appendOutput: mockAppendOutput,
      setSimProgress: mockSetSimProgress,
      setRunStartedAt: mockSetRunStartedAt,
      setLastNetlist: mockSetLastNetlist,
      importedNetlist: null,
    }),
  },
  useLibraryStore: { getState: () => ({ activeSimulator: "all" }) },
  useUiStore: { getState: () => ({ focusBottomTab: mockOpenDiagnostics }) },
}));

const completed = {
  ok: true as const,
  resultPath: "/w/.gsim/runs/run-1/result.gsim_sim_result",
  samplesPath: "/w/.gsim/runs/run-1/run.gsim_samples",
  samplesBytes: 743648,
  rows: 20000,
  signals: ["V(out)", "I(l1)"],
  worstSeverity: null,
  events: [],
  eventsTotal: 0,
};

describe("Simulate flow", () => {
  beforeEach(() => {
    mockRequestRun.mockReset().mockResolvedValue(completed);
    mockCancelRun.mockReset();
    mockOpenDiagnostics.mockReset();
    mockSetProblems.mockReset();
    mockSetActiveEditorTab.mockReset();
    mockAppendOutput.mockReset();
    mockSetSimProgress.mockReset();
    mockSetRunStartedAt.mockReset();
    isModelValid = true;
  });

  it("an invalid model opens diagnostics and never reaches the host", async () => {
    isModelValid = false;
    await act(async () => {
      await triggerRun();
    });
    expect(mockOpenDiagnostics).toHaveBeenCalled();
    expect(mockRequestRun).not.toHaveBeenCalled();
  });

  it("sends the compiled netlist to the host exactly once", async () => {
    await act(async () => {
      await triggerRun();
    });
    expect(mockRequestRun).toHaveBeenCalledTimes(1);
    const request = mockRequestRun.mock.calls[0][0];
    // The netlist travels one way, already compiled, as a string (#175). The
    // host is never handed a document to compile.
    expect(request).toMatchObject({ mode: "transient", netlist: "* mocked\nr1 n1 0 1\n" });
    expect(request).not.toHaveProperty("model");
    expect(typeof request.tEnd).toBe("number");
    expect(typeof request.tStep).toBe("number");
  });

  it("says where the result landed, in words the user can act on", async () => {
    await act(async () => {
      await triggerRun();
    });
    const written = mockAppendOutput.mock.calls.map(([text]) => String(text));
    expect(written.some((text) => text.includes(completed.resultPath))).toBe(true);
    expect(written.some((text) => text.includes("20000 samples"))).toBe(true);
  });

  it("marks when the run started, and clears it when the reply lands", async () => {
    // What drives the toolbar's elapsed time, and the only honest progress
    // number this process has: the solver reports no fraction, so a meter
    // stuck at 0% was removed in favour of this (#189).
    await act(async () => {
      await triggerRun();
    });

    const marks = mockSetRunStartedAt.mock.calls.map(([at]) => at);
    expect(marks).toHaveLength(2);
    expect(typeof marks[0]).toBe("number");
    expect(marks[0]).toBeGreaterThan(0);
    expect(marks[1]).toBeNull();
  });

  it("clears the busy state whatever the outcome, so the button comes back", async () => {
    await act(async () => {
      await triggerRun();
    });
    expect(mockSetSimProgress).toHaveBeenLastCalledWith(null);

    mockRequestRun.mockResolvedValue({
      ok: false,
      kind: "failed",
      summary: "The solver exited with status 1. See the Output panel.",
    });
    await act(async () => {
      await triggerRun();
    });
    expect(mockSetSimProgress).toHaveBeenLastCalledWith(null);
  });

  it("a run that found an error says so, even though it exited cleanly", async () => {
    // The exit status cannot be what decides this: a run can exit 0 having
    // found a rating exceeded. `worstSeverity` over the event log is what
    // does.
    mockRequestRun.mockResolvedValue({
      ...completed,
      worstSeverity: "error",
      eventsTotal: 3,
      events: [
        {
          rule: "i_max",
          target: "D1",
          severity: "error",
          time: 1.5e-6,
          value: 12.3,
          limit: 10,
          unit: "A",
          detail: "",
        },
      ],
    });
    await act(async () => {
      await triggerRun();
    });
    expect(mockSetProblems).toHaveBeenCalledWith(
      expect.arrayContaining([expect.objectContaining({ id: "run-event:0", severity: "error" })]),
    );
    expect(mockOpenDiagnostics).toHaveBeenCalledWith("core.problems");
  });

  it("a run that found nothing clears the last run's findings", async () => {
    await act(async () => {
      await triggerRun();
    });
    // `publishRunEvents([])` with nothing before and nothing now is a no-op by
    // design, so what is asserted is that no stale `run-event:` entry is left.
    for (const [problems] of mockSetProblems.mock.calls) {
      expect(problems.some((p: { id: string }) => p.id.startsWith("run-event:"))).toBe(false);
    }
  });

  it("Ctrl+Shift+T asks the host to stop the solver, not the socket to close", async () => {
    await act(async () => {
      void triggerRun();
      triggerCancel();
    });
    expect(mockCancelRun).toHaveBeenCalled();
  });
});

describe("RunButton", () => {
  it("reflects idle status with run label", () => {
    render(React.createElement(RunButton, { status: "idle", onRun: () => {}, onCancel: () => {} }));
    expect(document.body.textContent).toMatch(/run|simulate/i);
  });

  it("reflects busy status with stop/cancel label", () => {
    render(React.createElement(RunButton, { status: "busy", onRun: () => {}, onCancel: () => {} }));
    expect(document.body.textContent).toMatch(/stop|cancel/i);
  });

  it("reflects error status visually", () => {
    const { container } = render(
      React.createElement(RunButton, { status: "error", onRun: () => {}, onCancel: () => {} }),
    );
    expect(
      container.querySelector("[data-status='error'], .error, [aria-label*='error' i]") ||
        document.body.textContent?.match(/error/i),
    ).toBeTruthy();
  });
});

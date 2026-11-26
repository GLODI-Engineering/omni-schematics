/**
 * What Run does with an analysis whose timing it cannot read (#244).
 *
 * `§5.1`/`§5.3` make an expression or a reference a legal value for `t_end` and
 * `t_step`, and the engine's `loadDocument` accepts such a document without a
 * word (#199 — it does not evaluate them either). So the editor is handed a
 * `t_end` of `"{T_sim}"`, and what it used to do with it was substitute the
 * sim-settings panel's own `tEnd` and run: a window the document does not
 * declare, with nothing saying so.
 *
 * These tests assert the two things that matter — the host is **not** asked to
 * run, and the message names the field — because the failure mode is a run that
 * happens, not an exception.
 */

import { act } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { triggerRunAnalysis } from "./run";

const mockRequestRun = vi.hoisted(() => vi.fn());
vi.mock("./run-host", () => ({
  requestRun: mockRequestRun,
  cancelRun: vi.fn(),
  runInFlight: () => null,
}));

const mockSetProblems = vi.fn();
const mockAppendOutput = vi.fn();
const mockOpenDiagnostics = vi.fn();

vi.mock("../engine/engine", () => ({
  initEngine: vi.fn().mockResolvedValue({}),
  compileSchematic: vi.fn(() => ({
    netlist: "* mocked\nr1 n1 0 1\n",
    notes: [],
    provenance: null,
  })),
  resetEngineForTests: () => {},
  engineVersion: () => "0.0.0-test",
}));

/** The `simulation` block under test, replaced per case. */
let simulation: unknown = null;

vi.mock("../store", () => ({
  useGraphStore: {
    getState: () => ({
      document: {
        model: {
          name: "sheet",
          blocks: [{ id: "a", params: {} }],
          wires: [],
          params: [{ name: "T_sim", value: 0.002 }],
          simulation,
        },
      },
    }),
  },
  useIpcStore: {
    getState: () => ({
      status: "idle",
      problems: [],
      setProblems: mockSetProblems,
      setActiveEditorTab: vi.fn(),
      appendOutput: mockAppendOutput,
      setRunStartedAt: vi.fn(),
      setLastNetlist: vi.fn(),
      importedNetlist: null,
    }),
  },
  useLibraryStore: { getState: () => ({ activeSimulator: "all" }) },
  useUiStore: { getState: () => ({ focusBottomTab: mockOpenDiagnostics }) },
}));

/** Every message Run pushed into the Problems panel, flattened. */
function reportedMessages(): string {
  return mockSetProblems.mock.calls
    .flatMap((call) => (Array.isArray(call[0]) ? call[0] : []))
    .map((problem: { message?: string }) => problem.message ?? "")
    .join("\n");
}

const tran = (fields: Record<string, unknown>) => ({
  default_analysis: "tran",
  analyses: [{ id: "tran", type: "TRAN", t_start: 0, t_end: 0.005, t_step: 1e-7, ...fields }],
});

describe("an analysis whose timing the editor cannot read", () => {
  beforeEach(() => {
    mockRequestRun.mockReset().mockResolvedValue({
      ok: true as const,
      resultPath: "/w/r/result.gsim_sim_result",
      samplesPath: "/w/r/run.gsim_samples",
      samplesBytes: 1,
      rows: 1,
      signals: ["V(out)"],
      worstSeverity: null,
      events: [],
      eventsTotal: 0,
    });
    mockSetProblems.mockReset();
    mockAppendOutput.mockReset();
    mockOpenDiagnostics.mockReset();
    simulation = null;
  });

  it("a `t_end` written as an expression stops the run instead of borrowing the settings panel's", async () => {
    simulation = tran({ t_end: "{T_sim}" });
    await act(async () => {
      await triggerRunAnalysis("tran");
    });
    // The whole bug: this used to be called, with tEnd = the store's 10 ms.
    expect(mockRequestRun).not.toHaveBeenCalled();
    expect(reportedMessages()).toContain("t_end");
    expect(reportedMessages()).toContain("{T_sim}");
  });

  it("a `t_end` written as a bare param reference is refused the same way", async () => {
    simulation = tran({ t_end: "T_sim" });
    await act(async () => {
      await triggerRunAnalysis("tran");
    });
    expect(mockRequestRun).not.toHaveBeenCalled();
    expect(reportedMessages()).toContain("t_end");
  });

  it("a `t_step` that is not a number is refused too, and named", async () => {
    simulation = tran({ t_step: "{T_sim / 100}" });
    await act(async () => {
      await triggerRunAnalysis("tran");
    });
    expect(mockRequestRun).not.toHaveBeenCalled();
    expect(reportedMessages()).toContain("t_step");
  });

  it("an analysis that does declare numbers runs, with exactly those numbers", async () => {
    simulation = tran({ t_end: 0.002, t_step: 2e-8 });
    await act(async () => {
      await triggerRunAnalysis("tran");
    });
    expect(mockRequestRun).toHaveBeenCalledTimes(1);
    expect(mockRequestRun.mock.calls[0][0]).toMatchObject({ tEnd: 0.002, tStep: 2e-8 });
  });

  it("a document with no `simulation` block still falls back to the settings store", async () => {
    // The case the fallback was written for: a genuine absence, not a value
    // that could not be read. `stepForDocument`'s refinement (#193) stays.
    simulation = null;
    await act(async () => {
      await triggerRunAnalysis("tran");
    });
    expect(mockRequestRun).toHaveBeenCalledTimes(1);
    const request = mockRequestRun.mock.calls[0][0];
    expect(typeof request.tEnd).toBe("number");
    expect(typeof request.tStep).toBe("number");
  });
});

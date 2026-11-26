import { beforeEach, describe, expect, it, vi } from "vitest";

import { useGraphStore, useIpcStore, useUiStore } from "../store";
import { useToastStore } from "../store/toast";
import { hasAnythingToSimulate, triggerRun } from "./run";

// The compiler is in the editor now (#158), so Run goes through it before it
// reaches the host. These tests are about the run flow, not about compiling: a
// real WebAssembly instantiation in jsdom would be slower, and the sheets they
// build are stand-ins with no block types for the engine to recognise.
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

// The host is where the solver runs (#159). What it is handed, and what it
// answers, is the contract these tests hold.
const mockRequestRun = vi.hoisted(() => vi.fn());
const mockCancelRun = vi.hoisted(() => vi.fn());
vi.mock("./run-host", () => ({
  requestRun: mockRequestRun,
  cancelRun: mockCancelRun,
  runInFlight: () => null,
}));

/**
 * Clicking Run used to be able to do nothing visible at all — twice over.
 * The kernel-disconnected path returned bare, with its reason written only
 * to the Output panel, which need not be open; and an empty schematic was
 * never checked, so that click also did nothing, for a different reason the
 * user had no way to tell apart.
 */
beforeEach(() => {
  useToastStore.setState({ toasts: [] });
  useIpcStore.setState({ importedNetlist: null, problems: [], output: [] });
  mockRequestRun.mockReset();
  mockCancelRun.mockReset();
});

function setBlocks(count: number) {
  const doc = useGraphStore.getState().document;
  useGraphStore.setState({
    document: {
      ...doc,
      model: {
        ...doc.model,
        blocks: Array.from({ length: count }, (_, i) => ({ id: `b${i}` })),
      },
    },
  } as never);
}

describe("hasAnythingToSimulate", () => {
  it("is false for a sheet with no blocks", () => {
    setBlocks(0);
    expect(hasAnythingToSimulate()).toBe(false);
  });

  it("is true once a component is on the sheet", () => {
    setBlocks(1);
    expect(hasAnythingToSimulate()).toBe(true);
  });
});

describe("triggerRun on an empty sheet", () => {
  it("says so instead of doing nothing", async () => {
    setBlocks(0);
    await triggerRun();
    const messages = useToastStore.getState().toasts.map((t) => t.message);
    expect(messages.some((m) => /empty/i.test(m))).toBe(true);
  });

  it("does not compile, and does not reach the host, for an empty sheet", async () => {
    setBlocks(0);
    const spy = vi.spyOn(useIpcStore.getState(), "appendOutput");
    await triggerRun();
    expect(spy).not.toHaveBeenCalled();
    expect(mockRequestRun).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});

describe("a run the host refuses", () => {
  /**
   * The reported bug: *"I click on the simulation button at the top and nothing is happening"*.
   *
   * The backend was in fact answering in about a millisecond, with a precise reason. The front
   * end wrote it to the Output panel and the Problems list and did nothing else, and both of
   * those live in the bottom panel, which starts hidden and is not mounted in every shell. So a
   * failed run was indistinguishable from a button that did not work.
   *
   * The precise reason is a better one now: a `SolverNotFound` carries every place the host
   * looked for the binary and the `cargo` line that builds one.
   */
  const failure = {
    ok: false as const,
    kind: "solver-not-found" as const,
    summary: "Cannot find the general-simulator binary",
    detail:
      "Cannot find the general-simulator binary. Looked at:\n" +
      "  omniSchematics.generalSimulatorPath: /nope\n" +
      "  PATH: no general-simulator on any of its entries\n\n" +
      "To build it: clone GLODI-Engineering/general-simulator and run\n" +
      "  cargo build --release -p general-simulator-cli",
  };

  beforeEach(() => {
    useIpcStore.setState({ status: "idle", problems: [] });
    useUiStore.setState({ bottomPanelVisible: false });
    setBlocks(2);
    mockRequestRun.mockResolvedValue(failure);
  });

  it("says a run failed, where the user is looking", async () => {
    await triggerRun();

    const messages = useToastStore.getState().toasts.map((t) => t.message);
    expect(messages.some((m) => /Simulation failed/i.test(m))).toBe(true);
    // The first line only — the real message is a paragraph naming five places
    // and a build command, and a toast is the wrong place to read one.
    expect(messages.some((m) => m.includes("cargo build"))).toBe(false);
    expect(messages.some((m) => m.includes("Cannot find the general-simulator binary"))).toBe(true);
  });

  it("keeps everywhere it looked somewhere it can be read", async () => {
    await triggerRun();

    const problems = useIpcStore.getState().problems;
    expect(problems).toHaveLength(1);
    expect(problems[0]?.severity).toBe("error");
    expect(problems[0]?.message).toContain("omniSchematics.generalSimulatorPath: /nope");
    expect(problems[0]?.message).toContain("cargo build --release -p general-simulator-cli");
  });

  it("opens the panel holding it", async () => {
    await triggerRun();

    // The panel starts hidden; a failure that writes into it without opening it is the bug.
    expect(useUiStore.getState().bottomPanelVisible).toBe(true);
    expect(useUiStore.getState().activeBottomTabId).toBe("core.problems");
  });

  it("clears the busy state, so the Run button comes back", async () => {
    await triggerRun();
    expect(useIpcStore.getState().runStartedAt).toBe(null);
  });
});

describe("an analysis this solver cannot run", () => {
  beforeEach(() => {
    setBlocks(2);
    useIpcStore.setState({ problems: [] });
  });

  /** Run with `analysisType` set to `type`, then put the store back. */
  const runAs = async (type: string): Promise<void> => {
    const settings = await import("../store/sim-settings");
    const previous = settings.useSimSettingsStore.getState().settings;
    settings.useSimSettingsStore.setState({
      settings: { ...previous, analysisType: type },
    } as never);
    try {
      await triggerRun();
    } finally {
      settings.useSimSettingsStore.setState({ settings: previous } as never);
    }
  };

  it("refuses an AC sweep by name, rather than running it as a transient", async () => {
    // The engine is a piecewise-linear time-domain solver. An AC sweep sent as
    // a transient run would answer a question nobody asked.
    await runAs("AC");
    expect(mockRequestRun).not.toHaveBeenCalled();
    expect(useIpcStore.getState().problems[0]?.message).toMatch(/no AC sweep/);
  });

  it("refuses a DC sweep, and says why it is not merely a flag away", async () => {
    await runAs("DC");
    expect(mockRequestRun).not.toHaveBeenCalled();
    expect(useIpcStore.getState().problems[0]?.message).toMatch(/no DC sweep over a source/);
  });
});

describe("an operating point", () => {
  beforeEach(() => {
    setBlocks(2);
    useIpcStore.setState({ problems: [] });
    // A routed run reaches the host, so this block needs a host that answers.
    // The refusing block above does not: nothing gets that far.
    mockRequestRun.mockResolvedValue({
      ok: true,
      runId: "run-op",
      manifestPath: "/tmp/op/result.gsim_sim_result",
      samplesPath: "/tmp/op/run.gsim_samples",
      signals: [],
      events: [],
    });
  });

  const runAs = async (type: string): Promise<void> => {
    const settings = await import("../store/sim-settings");
    const previous = settings.useSimSettingsStore.getState().settings;
    settings.useSimSettingsStore.setState({
      settings: { ...previous, analysisType: type },
    } as never);
    try {
      await triggerRun();
    } finally {
      settings.useSimSettingsStore.setState({ settings: previous } as never);
    }
  };

  it("is run rather than refused: the engine has solved one all along", async () => {
    // #184: three of the four analyses had no route, but OP was never a missing
    // capability -- `--mode dc` is an operating point. It was a routing gap.
    await runAs("OP");
    expect(mockRequestRun).toHaveBeenCalled();
    expect(useIpcStore.getState().problems).toEqual([]);
  });

  it("asks for `dc`, and sends no window with it", async () => {
    await runAs("OP");
    const request = mockRequestRun.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(request.mode).toBe("dc");
    expect(request.analysis).toBe("OP");
    // A single solve has no window; sending one would put `--tfinal` on a
    // command line that ignores it.
    expect(request.tEnd).toBeUndefined();
    expect(request.tStep).toBeUndefined();
  });

  it("still sends a window for a transient, so the routing did not flatten both", async () => {
    await runAs("TRAN");
    const request = mockRequestRun.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(request.mode).toBe("transient");
    expect(request.analysis).toBe("TRAN");
    expect(typeof request.tEnd).toBe("number");
    expect(typeof request.tStep).toBe("number");
  });
});

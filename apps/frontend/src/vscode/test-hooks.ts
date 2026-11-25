/**
 * Integration-harness probes, installed only when the extension host sets
 * `__GSIM_INIT__.testMode` (it does that solely under
 * `@vscode/test-electron`, gated on the `GSIM_INTEGRATION_TEST` env var).
 *
 * These let an integration test reach into a *real* webview — real Chromium,
 * real bundle, real React tree, real zustand stores — and assert on concrete
 * state rather than on the absence of errors in a log. Every probe travels the
 * production `postMessage` path through `GsimHost`, so the harness exercises
 * the same fan-out the product uses.
 */
import { getActiveDragBlock, setActiveDragBlock } from "../canvas/dnd";
import { serialize } from "../file/serializer";
import { getWebviewInit, postToHost, requestSource } from "../ipc/vscode-host";
import {
  containerBytesFetched,
  containerLastWindowBytes,
  requestContainerWindow,
} from "../results/container-plot";
import { type RunOutputLine, reportRunOutput } from "../shell/run-output";
import { useGraphStore, useIpcStore, useLibraryStore } from "../store";
import { useSimSettingsStore } from "../store/sim-settings";
import { useToastStore } from "../store/toast";
import { useWaveformStore } from "../store/waveform";

type Probe = (args: Record<string, unknown>) => unknown;

function el(selector: string): Element | null {
  return document.querySelector(selector);
}

/**
 * Dispatch a real `drop` DragEvent on the canvas, with an *empty*
 * `DataTransfer` — exactly the situation a cross-webview drag produces, where
 * `getData()` yields nothing and the payload must come from the extension
 * host's `gsim/dragState` broadcast.
 */
function dispatchCanvasDrop(args: Record<string, unknown>): unknown {
  const target = el(".canvas-flow") as HTMLElement | null;
  if (!target) {
    throw new Error("canvas-flow element not present");
  }
  const rect = target.getBoundingClientRect();
  const clientX = typeof args.clientX === "number" ? args.clientX : rect.left + 120;
  const clientY = typeof args.clientY === "number" ? args.clientY : rect.top + 120;

  const before = useGraphStore.getState().document.model.blocks.length;
  const event = new DragEvent("drop", {
    bubbles: true,
    cancelable: true,
    clientX,
    clientY,
    dataTransfer: new DataTransfer(),
  });
  target.dispatchEvent(event);
  const after = useGraphStore.getState().document.model.blocks.length;

  return {
    before,
    after,
    inserted: after - before,
    lastBlockType: useGraphStore.getState().document.model.blocks.at(-1)?.type ?? null,
    canvasRect: { width: rect.width, height: rect.height },
  };
}

/**
 * Drag a component out of the *toolbar* and drop it on the canvas, inside
 * this one webview.
 *
 * Distinct from `dispatchCanvasDrop`, which models the cross-webview case
 * with an empty DataTransfer and the payload arriving through the host. Here
 * source and target are in the same document, so the whole gesture —
 * `dragstart`, `dragover`, `drop` — shares one DataTransfer, which is what a
 * hand produces and what the toolbar had no handler for until #3.
 */
function dispatchToolbarDrag(args: Record<string, unknown>): unknown {
  const button = el(".schematic-toolbar__component") as HTMLElement | null;
  const target = el(".canvas-flow") as HTMLElement | null;
  if (!button) throw new Error("no toolbar component button present");
  if (!target) throw new Error("canvas-flow element not present");

  const rect = target.getBoundingClientRect();
  const clientX = typeof args.clientX === "number" ? args.clientX : rect.left + 200;
  const clientY = typeof args.clientY === "number" ? args.clientY : rect.top + 160;

  const before = useGraphStore.getState().document.model.blocks.length;
  const transfer = new DataTransfer();

  button.dispatchEvent(
    new DragEvent("dragstart", { bubbles: true, cancelable: true, dataTransfer: transfer }),
  );
  const draggedAfterStart = getActiveDragBlock();

  target.dispatchEvent(
    new DragEvent("dragover", {
      bubbles: true,
      cancelable: true,
      clientX,
      clientY,
      dataTransfer: transfer,
    }),
  );
  target.dispatchEvent(
    new DragEvent("drop", {
      bubbles: true,
      cancelable: true,
      clientX,
      clientY,
      dataTransfer: transfer,
    }),
  );

  const after = useGraphStore.getState().document.model.blocks.length;
  return {
    before,
    after,
    inserted: after - before,
    lastBlockType: useGraphStore.getState().document.model.blocks.at(-1)?.type ?? null,
    // Proof the fix is in this build at all, rather than the drag merely
    // failing for some other reason.
    draggableAttr: button.getAttribute("draggable"),
    draggedAfterStart,
  };
}

/**
 * Ask the extension host for a workspace file, the way the inspector does
 * when it offers to read a scripted block's ports from its source.
 *
 * Exists so the host half of that round trip can be tested at all: the
 * browser suite has no extension host, so without this the file read, the
 * workspace confinement and the reply are covered by nothing.
 */
async function readSourceProbe(args: Record<string, unknown>): Promise<unknown> {
  const path = typeof args.path === "string" ? args.path : "";
  const text = await requestSource(path, 10_000);
  return { ok: text !== null, length: text?.length ?? 0, text: text?.slice(0, 400) ?? null };
}

/**
 * What the waveform viewer is actually showing, read off the live charts.
 *
 * `__gensim_charts` is the map of mounted uPlot instances — the real ones,
 * drawing into a real canvas in a real Chromium. Reading `chart.data` is the
 * one way to assert that the points the container gave up reached the plot,
 * rather than that a store was written to. Peaks are reported per series
 * because losing one is the failure that matters in power electronics (#157):
 * a transient one sample wide is the thing that destroys the device.
 */
function waveformReport(): unknown {
  const store = useWaveformStore.getState();
  const charts = (globalThis as { __gensim_charts?: Map<string, { data: unknown[] }> })
    .__gensim_charts;

  const traces: {
    axesId: string;
    series: number;
    points: number;
    peaks: { min: number; max: number }[];
  }[] = [];
  for (const [axesId, chart] of charts ?? []) {
    const data = chart.data as (Float64Array | number[])[];
    const peaks = data.slice(1).map((series) => {
      let min = Number.POSITIVE_INFINITY;
      let max = Number.NEGATIVE_INFINITY;
      for (let i = 0; i < series.length; i++) {
        const value = series[i] as number;
        if (!Number.isFinite(value)) continue;
        if (value < min) min = value;
        if (value > max) max = value;
      }
      return { min, max };
    });
    traces.push({
      axesId,
      series: Math.max(0, data.length - 1),
      points: (data[0] as { length: number } | undefined)?.length ?? 0,
      peaks,
    });
  }

  return {
    simId: store.currentSimId,
    figures: store.figures.size,
    axes: store.axes.size,
    cached: [...store.signalCache.entries()].map(([key, signal]) => ({
      key,
      samples: signal.values.length,
      unit: signal.unit,
      quantity: signal.quantity,
    })),
    // Cumulative, and the per-window cost beside it: a session's every read
    // added up will exceed a short container, while one window never does.
    bytesFetched: containerBytesFetched(store.currentSimId ?? ""),
    lastWindowBytes: containerLastWindowBytes(store.currentSimId ?? ""),
    traces,
  };
}

const PROBES: Record<string, Probe> = {
  /**
   * What the viewer is drawing, from the live charts (#157).
   *
   * Only a real webview has a uPlot instance with data in it, so this is the
   * one place "the run plotted" can be asserted rather than inferred from a
   * store write.
   */
  waveform: () => waveformReport(),

  /**
   * Zoom one axes to a fraction of the run's extent and report what that cost.
   *
   * The claim the container format makes, measured: a narrower window fetches
   * fewer bytes than the whole extent does, because which ranges a window
   * needs is decided from the stripe directory and index arithmetic rather
   * than by reading the file.
   */
  zoomWaveform: async (args: Record<string, unknown>) => {
    const fraction = typeof args.fraction === "number" ? args.fraction : 0.1;
    const maxPoints = typeof args.maxPoints === "number" ? args.maxPoints : 3000;
    const store = useWaveformStore.getState();
    const simId = store.currentSimId ?? "";

    const refs = [...store.axes.values()].flatMap((axes) => axes.signals);
    const signal =
      refs.length > 0 ? store.signalCache.get(`${simId}::${refs[0]?.signalName}`) : undefined;
    const time = signal?.time;
    if (!time || time.length < 2) {
      throw new Error("no cached signal to take an extent from");
    }
    const from = time[0] as number;
    const to = time[time.length - 1] as number;
    const span = (to - from) * fraction;

    const before = containerBytesFetched(simId);
    const fetched = await requestContainerWindow(refs, [from, from + span], maxPoints);
    return {
      window: [from, from + span],
      extent: [from, to],
      fraction,
      maxPoints,
      bytesFetched: fetched,
      totalBefore: before,
      totalAfter: containerBytesFetched(simId),
      report: waveformReport(),
    };
  },

  /** The whole extent again, at the same budget, for the comparison above. */
  fullWaveform: async (args: Record<string, unknown>) => {
    const maxPoints = typeof args.maxPoints === "number" ? args.maxPoints : 3000;
    const store = useWaveformStore.getState();
    const simId = store.currentSimId ?? "";
    const refs = [...store.axes.values()].flatMap((axes) => axes.signals);
    const fetched = await requestContainerWindow(refs, null, maxPoints);
    return {
      maxPoints,
      bytesFetched: fetched,
      total: containerBytesFetched(simId),
      report: waveformReport(),
    };
  },

  /**
   * Emit labelled run output, so the webview -> host -> Output panel path can
   * be tested end to end (#139).
   *
   * Exists because nothing else can reach it: the browser suite has no
   * extension host, and VS Code offers no API to read an output channel back,
   * so without driving the real path from inside a real webview this feature
   * would be covered only by unit tests of its two halves.
   */
  emitRunOutput: (args: Record<string, unknown>) => {
    const lines = Array.isArray(args.lines) ? (args.lines as RunOutputLine[]) : [];
    reportRunOutput(lines);
    return { sent: lines.length };
  },

  /**
   * Press Run, for real, and report what the editor was left saying (#159).
   *
   * The production path, nothing stubbed: the engine compiles this webview's
   * document to a netlist in WebAssembly, `gsim/runSimulation` crosses the
   * real webview boundary, the extension host resolves the
   * `general-simulator` binary and spawns it, and the reply comes back on
   * `gsim/runResult`. Only a real VS Code has that boundary and only a real
   * host can spawn a process, so this is the one place the whole of Run is
   * exercised at once.
   *
   * What comes back is what a user would see: the toasts, the Output tab's
   * lines and the Problems entries. The files the run left on disk are
   * asserted by the test, from the workspace, which is the half a webview
   * cannot see.
   */
  run: async (args: Record<string, unknown>) => {
    useToastStore.setState({ toasts: [] });
    // A longer, finer run when the test asks for one. The container's stripes
    // are a fixed number of rows, so a 1,000-sample run is a *single* stripe
    // and every window of it reads that one stripe -- true, and useless for
    // asserting that a narrower window costs less. `triggerRun` takes t_end
    // and t_step from this store, so setting it here is the same rung the
    // Simulation panel sets.
    if (typeof args.tEnd === "number" && typeof args.tStep === "number") {
      useSimSettingsStore
        .getState()
        .updateSettings({ tEnd: args.tEnd, tStep: args.tStep, analysisType: "TRAN" });
    }
    const { triggerRun } = await import("../shell/run");
    await triggerRun();
    return {
      toasts: useToastStore.getState().toasts.map((toast) => toast.message),
      output: useIpcStore.getState().output,
      problems: useIpcStore
        .getState()
        .problems.map((problem) => ({ severity: problem.severity, message: problem.message })),
      netlist: useIpcStore.getState().lastNetlist,
    };
  },

  /** Proof the React app actually mounted and painted inside this webview. */
  mounted: () => {
    const root = document.getElementById("root");
    return {
      role: getWebviewInit()?.role ?? null,
      rootExists: root !== null,
      childElementCount: root?.childElementCount ?? 0,
      textLength: (root?.textContent ?? "").length,
      hasCanvas: el(".canvas-flow") !== null,
      hasLibrary: el(".library-activity") !== null,
      hasLibraryItems: document.querySelectorAll(".library-item").length,
      hasWaveform: el(".waveform-tab") !== null || el(".waveform-empty") !== null,
      hasMainToolbar: el(".main-toolbar") !== null,
    };
  },

  /** Number of catalog entries the webview loaded from the manifest. */
  catalogSize: () => Object.keys(useLibraryStore.getState().catalog).length,

  /** Read the module-level drag tracker that the host bridge writes into. */
  dragState: () => getActiveDragBlock(),

  /**
   * Drive the *production* drag-source path: this is exactly what
   * `SidebarItem.onDragStart` calls, so it posts a real `gsim/dragStart` to
   * the extension host.
   */
  simulateDragStart: (args) => {
    const blockName = String(args.blockName ?? "");
    setActiveDragBlock(blockName, args.label ? String(args.label) : undefined);
    return getActiveDragBlock();
  },

  simulateDragEnd: () => {
    setActiveDragBlock(null);
    return getActiveDragBlock();
  },

  dispatchCanvasDrop,
  dispatchToolbarDrag,
  readSource: readSourceProbe,

  /**
   * Click a real MainToolbar button by its accessible name, so the whole
   * production path runs: React onClick -> App.handleAction ->
   * handleHostFileAction -> postToHost. Used to prove the in-app Save button
   * really funnels into VS Code's own save rather than the storage adapter.
   */
  clickToolbarButton: (args) => {
    const label = String(args.label ?? "");
    const button = [...document.querySelectorAll<HTMLButtonElement>(".main-toolbar button")].find(
      (candidate) => candidate.getAttribute("aria-label") === label,
    );
    if (!button) {
      throw new Error(`no .main-toolbar button labelled "${label}"`);
    }
    button.click();
    return { clicked: label };
  },

  blockCount: () => useGraphStore.getState().document.model.blocks.length,

  documentName: () => useGraphStore.getState().document.model.name,

  documentText: () => serialize(useGraphStore.getState().document),

  /** Mutate the graph so the custom editor's dirty-state wiring is exercised. */
  renameModel: (args) => {
    const graph = useGraphStore.getState();
    const current = graph.document;
    graph.loadDocument({
      ...current,
      model: { ...current.model, name: String(args.name ?? "renamed") },
    });
    return graph.document.model.name;
  },
};

export function installTestHooks(): void {
  if (!getWebviewInit()?.testMode) {
    return;
  }
  globalThis.addEventListener("message", (event: MessageEvent) => {
    const data = event.data as
      | { type?: string; requestId?: string; op?: string; args?: Record<string, unknown> }
      | undefined;
    if (!data || data.type !== "gsim/test/exec" || typeof data.requestId !== "string") {
      return;
    }
    const requestId = data.requestId;
    try {
      const probe = PROBES[String(data.op)];
      if (!probe) {
        throw new Error(`unknown probe: ${String(data.op)}`);
      }
      // Awaited, because a probe may be async — asking the extension host
      // for a file is. Posting the Promise itself fails at the boundary
      // with "[object Promise] could not be cloned", which reads as a
      // broken probe rather than a missing `await`.
      void Promise.resolve(probe(data.args ?? {}))
        .then((result) => {
          postToHost({ type: "gsim/test/report", requestId, ok: true, result });
        })
        .catch((error: unknown) => {
          postToHost({
            type: "gsim/test/report",
            requestId,
            ok: false,
            result: String(error instanceof Error ? error.message : error),
          });
        });
    } catch (error) {
      postToHost({
        type: "gsim/test/report",
        requestId,
        ok: false,
        result: String(error),
      });
    }
  });
}

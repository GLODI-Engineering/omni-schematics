import { create } from "zustand";

import type { DcOpEntry, SimulationManifest, WaveformSlice } from "../ipc/types";

export type KernelStatus = "disconnected" | "connecting" | "idle" | "busy" | "running" | "error";

export interface PendingRequest {
  action: string;
  startedAt: number;
}

export interface ProblemEntry {
  id: string;
  severity: "error" | "warning" | "info";
  message: string;
}

export interface IpcStoreState {
  status: KernelStatus;
  pendingIds: Map<string, PendingRequest>;
  lastManifest: SimulationManifest | null;
  waveformSlice: WaveformSlice | null;
  dcOpTable: DcOpEntry[] | null;
  output: string[];
  problems: ProblemEntry[];
  activeEditorTabId: string;
  /**
   * The backend's own progress fraction, when something reports one.
   *
   * Nothing does, for a solver run. It was the kernel's heartbeat estimate,
   * and since #159 a run goes to the extension host and the solver writes its
   * container directly -- `general-simulator` prints nothing parseable as
   * progress, so there is no fraction to report (#189). The kernel client
   * still sets this from a `frac` frame, and that path goes with #162.
   *
   * Do not use it to drive a meter. A meter stuck at 0% for the length of a
   * run reads as a hung solver, which is worse than showing no meter.
   */
  simProgress: number | null;
  simMessage: string | null;
  /**
   * When the run in flight started, as `Date.now()`, or null when none is.
   *
   * Wall-clock, and deliberately not simulated time: simulated progress is
   * the number a user wants and nothing can supply it, while elapsed time is
   * something this process genuinely knows. It is also the busy marker a run
   * sets on its way out of `triggerRun`.
   */
  runStartedAt: number | null;
  /** The exact netlist text last sent to the backend (schematic-generated or imported). */
  lastNetlist: string | null;
  /**
   * When set, triggerRun() sends this text directly instead of generating a
   * netlist from the schematic. Set by File > Import SPICE netlist…; cleared
   * from the Netlist tab.
   */
  importedNetlist: string | null;
  setStatus: (status: KernelStatus) => void;
  setPending: (id: string, request: PendingRequest) => void;
  clearPending: (id: string) => void;
  setLastManifest: (manifest: SimulationManifest | null) => void;
  /**
   * FE-154: called as soon as the first waveform_chunk binary frame for a
   * signal arrives — i.e. while the simulation is still running, well
   * before the final simulate_result (and its authoritative manifest)
   * shows up. Lets the SignalBrowser sidebar list signals live as they
   * start streaming instead of staying empty for the whole run. Harmless
   * if called after the real manifest already landed (dedup by name).
   */
  registerLiveSignal: (simId: string, signalName: string) => void;
  setWaveformSlice: (slice: WaveformSlice | null) => void;
  setDcOpTable: (table: DcOpEntry[] | null) => void;
  appendOutput: (line: string) => void;
  setProblems: (problems: ProblemEntry[]) => void;
  setActiveEditorTab: (id: string) => void;
  setSimProgress: (frac: number | null, message?: string | null) => void;
  setRunStartedAt: (at: number | null) => void;
  setLastNetlist: (netlist: string | null) => void;
  setImportedNetlist: (netlist: string | null) => void;
  /**
   * Called from file/file-ops.ts on New/Open/Open-by-id. Simulation state
   * (progress, manifest, netlist, problems) belongs to whichever model
   * produced it — opening a different model must not leave the Run button
   * stuck showing "Stop" for a run against a model that's no longer even
   * loaded, nor show stale results/errors from the model just left behind.
   * Only clears a stuck "busy" (there's no in-flight request left to
   * finish once the model backing it is gone); leaves a genuine
   * disconnected/connecting/error kernel-connection status alone, since
   * that reflects the backend connection, not the loaded model.
   */
  resetForNewModel: () => void;
}

export const useIpcStore = create<IpcStoreState>((set, get) => ({
  status: "disconnected",
  pendingIds: new Map<string, PendingRequest>(),
  lastManifest: null,
  waveformSlice: null,
  dcOpTable: null,
  output: [],
  problems: [],
  activeEditorTabId: "core.schematic",
  simProgress: null,
  simMessage: null,
  runStartedAt: null,
  lastNetlist: null,
  importedNetlist: null,
  setStatus: (status) => {
    const previous = get().status;
    const manifest = get().lastManifest;
    if (status === "idle" && previous !== "idle" && manifest !== null) {
      set({ status, activeEditorTabId: "core.waveform" });
    } else {
      set({ status });
    }
  },
  setPending: (id, request) => {
    set((state) => {
      const pendingIds = new Map(state.pendingIds);
      pendingIds.set(id, request);
      return { pendingIds };
    });
  },
  clearPending: (id) => {
    set((state) => {
      const pendingIds = new Map(state.pendingIds);
      pendingIds.delete(id);
      return { pendingIds };
    });
  },
  setLastManifest: (lastManifest) => {
    set({ lastManifest });
  },
  registerLiveSignal: (simId, signalName) => {
    set((state) => {
      const current = state.lastManifest;
      if (current && current.sim_id === simId) {
        if (current.signals.includes(signalName)) return {};
        return { lastManifest: { ...current, signals: [...current.signals, signalName] } };
      }
      // First signal of a new run — start a provisional manifest.
      // t_start/t_end are unknown until the final simulate_result arrives
      // and setLastManifest() replaces this with the authoritative one.
      return { lastManifest: { sim_id: simId, signals: [signalName], t_start: 0, t_end: 0 } };
    });
  },
  setWaveformSlice: (waveformSlice) => {
    set({ waveformSlice });
  },
  setDcOpTable: (dcOpTable) => {
    set({ dcOpTable });
  },
  appendOutput: (line) => {
    set((state) => ({ output: [...state.output, line] }));
  },
  setProblems: (problems) => {
    set({ problems });
  },
  setActiveEditorTab: (id) => {
    set({ activeEditorTabId: id });
  },
  setSimProgress: (frac, message) => {
    set({ simProgress: frac, simMessage: message ?? null });
  },
  setRunStartedAt: (runStartedAt) => {
    set({ runStartedAt });
  },
  setLastNetlist: (lastNetlist) => {
    set({ lastNetlist });
  },
  setImportedNetlist: (importedNetlist) => {
    set({ importedNetlist });
  },
  resetForNewModel: () => {
    set((state) => ({
      status: state.status === "busy" ? "idle" : state.status,
      simProgress: null,
      simMessage: null,
      lastManifest: null,
      lastNetlist: null,
      importedNetlist: null,
      dcOpTable: null,
      problems: [],
    }));
  },
}));

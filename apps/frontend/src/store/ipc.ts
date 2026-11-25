import { create } from "zustand";

import type { DcOpEntry, SimulationManifest, WaveformSlice } from "../ipc/types";

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
  pendingIds: Map<string, PendingRequest>;
  lastManifest: SimulationManifest | null;
  waveformSlice: WaveformSlice | null;
  dcOpTable: DcOpEntry[] | null;
  output: string[];
  problems: ProblemEntry[];
  activeEditorTabId: string;
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
  setPending: (id: string, request: PendingRequest) => void;
  clearPending: (id: string) => void;
  setLastManifest: (manifest: SimulationManifest | null) => void;
  setWaveformSlice: (slice: WaveformSlice | null) => void;
  setDcOpTable: (table: DcOpEntry[] | null) => void;
  appendOutput: (line: string) => void;
  setProblems: (problems: ProblemEntry[]) => void;
  setActiveEditorTab: (id: string) => void;
  setRunStartedAt: (at: number | null) => void;
  setLastNetlist: (netlist: string | null) => void;
  setImportedNetlist: (netlist: string | null) => void;
  /**
   * Called from file/file-ops.ts on New/Open/Open-by-id. Simulation state
   * (the run in flight, the manifest, the netlist, the problems) belongs to
   * whichever model produced it — opening a different model must not leave
   * the Run button stuck showing "Stop" for a run against a model that is no
   * longer even loaded, nor show stale results or errors from the model just
   * left behind.
   *
   * `runStartedAt` is the stuck-busy marker it clears. It used to clear a
   * `status` of `"busy"` as well, and leave a kernel's own
   * disconnected/connecting/error state alone; there is no kernel to have one
   * (#162), and a run in flight is the only busy there is.
   */
  resetForNewModel: () => void;
}

export const useIpcStore = create<IpcStoreState>((set) => ({
  pendingIds: new Map<string, PendingRequest>(),
  lastManifest: null,
  waveformSlice: null,
  dcOpTable: null,
  output: [],
  problems: [],
  activeEditorTabId: "core.schematic",
  runStartedAt: null,
  lastNetlist: null,
  importedNetlist: null,
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
    set({
      runStartedAt: null,
      lastManifest: null,
      lastNetlist: null,
      importedNetlist: null,
      dcOpTable: null,
      problems: [],
    });
  },
}));

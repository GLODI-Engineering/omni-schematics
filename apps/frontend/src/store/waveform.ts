import { create } from "zustand";

import type { SignalDetail } from "../ipc/types";
import { fileSourceBlockIds } from "../waveform/measured";
import type { MeasurementKey } from "../waveform/measurements";
import type {
  Axes,
  AxesMode,
  CouplingGroup,
  Figure,
  SignalRef,
  WaveformSignal,
} from "../waveform/types";
import { useGraphStore } from "./graph";

// Stable palette for signal colors, cycled via index.
const _COLOR_PALETTE = [
  "#3b82f6",
  "#ef4444",
  "#22c55e",
  "#f59e0b",
  "#8b5cf6",
  "#06b6d4",
  "#f97316",
  "#ec4899",
  "#14b8a6",
  "#a855f7",
];

function _pickColor(index: number): string {
  return _COLOR_PALETTE[index % _COLOR_PALETTE.length] ?? "#3b82f6";
}

/**
 * How many past runs to keep by default.
 *
 * Each one is a full copy of every signal, so this is memory, not a
 * preference: four runs of a 25,000-step, 11-signal sweep is about 9 MB.
 * Enough to see a trend across a few parameter tweaks; small enough not to
 * be the reason a long sweep runs out of room.
 */
export const DEFAULT_HISTORY_LIMIT = 4;

function _uuid(): string {
  return crypto.randomUUID();
}

function _signalCacheKey(simId: string, signalName: string): string {
  return `${simId}::${signalName}`;
}

/**
 * The ids of the blocks in the open document that replay a file.
 *
 * Read through `getState()` inside the call, not at module scope: the store is
 * consulted at the moment a run's metadata arrives, which is the document that
 * ran.
 */
function _fileSourceIds(): Set<string> {
  return fileSourceBlockIds(useGraphStore.getState().document.model.blocks);
}

export interface WaveformState {
  figures: Map<string, Figure>;
  axes: Map<string, Axes>;
  /**
   * The axes the signal browser's checkboxes act on.
   *
   * Something has to answer "add it where?", and an implicit notion of
   * focus answers it differently depending on where the pointer last was.
   * This is explicit: the browser shows which axes it is targeting and lets
   * it be changed, and clicking an axes retargets it.
   */
  activeAxesId: string | null;

  /**
   * Past runs, newest first, not including the one on screen.
   *
   * Re-running a changed component and seeing what moved is the single most
   * common thing anyone does with a simulator, and it was impossible here:
   * every run replaced the last, so a comparison meant exporting both and
   * opening them in something else. The samples are already in the cache —
   * keeping the previous run's sim ids is all that was missing.
   */
  runHistory: string[];
  /** The run currently on screen, if any. */
  currentSimId: string | null;
  /** How many past runs to keep. Beyond this the oldest is dropped. */
  historyLimit: number;
  couplingGroups: Map<string, CouplingGroup>;
  signalCache: Map<string, WaveformSignal>;

  // Figure actions
  createFigure: (name: string, rows: number, cols: number) => string;
  deleteFigure: (id: string) => void;
  renameFigure: (id: string, name: string) => void;
  /** Resize a figure's grid, dropping any axes whose (row, col) falls outside the new bounds. */
  resizeFigure: (id: string, rows: number, cols: number) => void;
  /** FE-167: set (or clear, with null) which axes is maximized to fill the figure. */
  setMaximizedAxes: (figureId: string, axesId: string | null) => void;

  // Axes actions
  createAxes: (figureId: string, row: number, col: number, mode?: AxesMode) => string;
  deleteAxes: (id: string) => void;

  // Signal actions
  addSignalToAxes: (axesId: string, simId: string, signalName: string) => void;
  removeSignalFromAxes: (axesId: string, simId: string, signalName: string) => void;
  /** FE-161: update one signal's display color on an axes. No-op if the (simId, signalName) pair isn't on that axes. */
  setSignalColor: (axesId: string, simId: string, signalName: string, color: string) => void;
  /**
   * Set one signal's display-only multiplier on an axes (see SignalRef.gain).
   * A gain of 1, or a non-finite or zero value, clears it.
   */
  setSignalGain: (axesId: string, simId: string, signalName: string, gain: number) => void;
  /** Replace all signals on the given axes atomically (clears old, adds new). */
  resetAxesSignals: (axesId: string, signals: Array<{ simId: string; signalName: string }>) => void;
  /** FE-164: empty an axes' signals and reset its zoom/cursor state, leaving id/figureId/row/col/mode/couplingGroupId untouched. */
  clearAxes: (axesId: string) => void;
  cacheSignal: (simId: string, name: string, data: WaveformSignal) => void;
  /**
   * Take what the run's manifest says about its signals.
   *
   * Two things were wrong without this. A signal arriving without metadata is
   * cached carrying `analysis: "transient"`, `quantity: "dimensionless"` and
   * no unit, so an AC run's traces kept transient labels. And nothing recorded
   * which block produced a trace, which is the only honest way to know that
   * one of them is a measurement rather than a result.
   */
  applySignalMetadata: (simId: string, details: SignalDetail[]) => void;

  // Coupling group actions
  createCouplingGroup: (name: string, lockX: boolean, lockY: boolean) => string;
  assignAxesToGroup: (axesId: string, groupId: string) => void;
  /**
   * FE-169: ensure every axes in the figure that isn't already in a
   * *different*, explicit (user-made) coupling group is X-coupled via a
   * single auto-created per-figure group. No-op for a figure with fewer
   * than 2 axes (nothing to couple) or that doesn't exist.
   */
  ensureFigureXCoupling: (figureId: string) => void;
  deleteCouplingGroup: (id: string) => void;

  /** Point the signal browser at an axes. Null when it no longer exists. */
  setActiveAxes: (axesId: string | null) => void;

  /**
   * Record that a new run is replacing the current one, moving the outgoing
   * run into the history and evicting anything past `historyLimit`.
   */
  beginRun: (simId: string) => void;
  /** Keep more or fewer past runs. Shrinking evicts the oldest immediately. */
  setHistoryLimit: (limit: number) => void;
  /** How many past runs an axes draws behind the current one. */
  setAxesHistoryDepth: (axesId: string, depth: number) => void;

  /** Which measurements the bar above this axes shows, in order. */
  setAxesMeasurements: (axesId: string, measurements: MeasurementKey[]) => void;
  setAxesMeasuredSignals: (axesId: string, signalKeys: string[]) => void;
  setAxesCollapsed: (axesId: string, collapsed: boolean) => void;
  /** Resize a figure's grid tracks. Pass null for a dimension to leave it alone. */
  setFigureTrackSizes: (
    figureId: string,
    sizes: { rows?: number[] | null; cols?: number[] | null },
  ) => void;

  // Zoom / cursor actions
  setAxesZoom: (axesId: string, xMin: number, xMax: number) => void;
  /** FE-166: set the y-range independently of x (used by "Fit Y"). */
  setAxesYZoom: (axesId: string, yMin: number, yMax: number) => void;
  /** FE-165: "A"/"B" set the vertical (time) cursors; "AH"/"BH" set the horizontal (value, primary spine) cursors. */
  setAxesCursor: (axesId: string, cursor: "A" | "B" | "AH" | "BH", value: number) => void;
  setAxesPanMode: (axesId: string, panMode: boolean) => void;
  propagateZoom: (axesId: string, xMin: number, xMax: number, yMin: number, yMax: number) => void;
}

/** The cache with every signal belonging to `simIds` removed. */
function _withoutRuns(
  cache: Map<string, WaveformSignal>,
  simIds: string[],
): Map<string, WaveformSignal> {
  if (simIds.length === 0) return cache;
  const dropped = new Set(simIds);
  const next = new Map(cache);
  for (const [key, signal] of cache) {
    if (dropped.has(signal.simId)) next.delete(key);
  }
  return next;
}

export const useWaveformStore = create<WaveformState>((set, get) => ({
  figures: new Map(),
  axes: new Map(),
  activeAxesId: null,
  runHistory: [],
  currentSimId: null,
  historyLimit: DEFAULT_HISTORY_LIMIT,
  couplingGroups: new Map(),
  signalCache: new Map(),

  createFigure: (name, rows, cols) => {
    const id = _uuid();
    const figure: Figure = { id, name, rows, cols, axesIds: [] };
    set((state) => {
      const figures = new Map(state.figures);
      figures.set(id, figure);
      return { figures };
    });
    return id;
  },

  deleteFigure: (id) => {
    set((state) => {
      const figure = state.figures.get(id);
      if (!figure) return {};
      const figures = new Map(state.figures);
      figures.delete(id);
      const axes = new Map(state.axes);
      for (const axesId of figure.axesIds) {
        axes.delete(axesId);
      }
      return { figures, axes };
    });
  },

  renameFigure: (id, name) => {
    set((state) => {
      const figure = state.figures.get(id);
      if (!figure) return {};
      const figures = new Map(state.figures);
      figures.set(id, { ...figure, name });
      return { figures };
    });
  },

  resizeFigure: (id, rows, cols) => {
    set((state) => {
      const figure = state.figures.get(id);
      if (!figure) return {};

      const axes = new Map(state.axes);
      const survivingAxesIds: string[] = [];
      for (const axesId of figure.axesIds) {
        const ax = state.axes.get(axesId);
        if (ax && ax.row < rows && ax.col < cols) {
          survivingAxesIds.push(axesId);
        } else {
          axes.delete(axesId);
        }
      }

      const figures = new Map(state.figures);
      figures.set(id, { ...figure, rows, cols, axesIds: survivingAxesIds });
      return { figures, axes };
    });
  },

  setMaximizedAxes: (figureId, axesId) => {
    set((state) => {
      const figure = state.figures.get(figureId);
      if (!figure) return {};
      const figures = new Map(state.figures);
      figures.set(figureId, { ...figure, maximizedAxesId: axesId ?? undefined });
      return { figures };
    });
  },

  createAxes: (figureId, row, col, mode = "time") => {
    const id = _uuid();
    const axesEntry: Axes = { id, figureId, row, col, signals: [], mode };
    set((state) => {
      const axes = new Map(state.axes);
      axes.set(id, axesEntry);
      const figures = new Map(state.figures);
      const figure = figures.get(figureId);
      if (figure) {
        figures.set(figureId, { ...figure, axesIds: [...figure.axesIds, id] });
      }
      return { axes, figures };
    });
    // FE-169: a figure that just gained its 2nd+ axes gets its axes
    // X-coupled by default (a fresh multi-axes figure shouldn't require a
    // manual step to link zoom across its axes).
    get().ensureFigureXCoupling(figureId);
    // The signal browser needs somewhere to put a ticked signal from the
    // moment there is anywhere at all.
    if (get().activeAxesId === null) get().setActiveAxes(id);
    return id;
  },

  deleteAxes: (id) => {
    set((state) => {
      const axesEntry = state.axes.get(id);
      if (!axesEntry) return {};
      const axes = new Map(state.axes);
      axes.delete(id);
      const activeAxesId =
        state.activeAxesId === id ? (axes.keys().next().value ?? null) : state.activeAxesId;
      const figures = new Map(state.figures);
      const figure = figures.get(axesEntry.figureId);
      if (figure) {
        figures.set(axesEntry.figureId, {
          ...figure,
          axesIds: figure.axesIds.filter((aid) => aid !== id),
        });
      }
      return { axes, figures, activeAxesId };
    });
  },

  addSignalToAxes: (axesId, simId, signalName) => {
    const { axes } = get();
    const axesEntry = axes.get(axesId);
    if (!axesEntry) return;

    const colorIndex = axesEntry.signals.length;
    const ref: SignalRef = { simId, signalName, color: _pickColor(colorIndex) };

    set((state) => {
      const axesMap = new Map(state.axes);
      const entry = axesMap.get(axesId);
      if (!entry) return {};
      axesMap.set(axesId, { ...entry, signals: [...entry.signals, ref] });
      return { axes: axesMap };
    });

    // Nothing is fetched here. A signal reaches this store before an axes can
    // name it: the viewer reads windows of the run's `.gsim_samples` container
    // and caches what it read (#157), and this used to call a `fetchSignal`
    // that asked the kernel sidecar for `manifest.json` and a `.npy` over HTTP
    // -- routes the sidecar stopped serving, and then stopped existing (#194,
    // #162). Its `catch` was silent by design, so a cache miss here would have
    // drawn an empty trace rather than said anything.
  },

  removeSignalFromAxes: (axesId, simId, signalName) => {
    set((state) => {
      const axesMap = new Map(state.axes);
      const entry = axesMap.get(axesId);
      if (!entry) return {};
      axesMap.set(axesId, {
        ...entry,
        signals: entry.signals.filter((s) => !(s.simId === simId && s.signalName === signalName)),
      });
      return { axes: axesMap };
    });
  },

  setSignalColor: (axesId, simId, signalName, color) => {
    set((state) => {
      const axesMap = new Map(state.axes);
      const entry = axesMap.get(axesId);
      if (!entry) return {};
      const idx = entry.signals.findIndex((s) => s.simId === simId && s.signalName === signalName);
      if (idx === -1) return {};
      const signals = [...entry.signals];
      signals[idx] = { ...(signals[idx] as SignalRef), color };
      axesMap.set(axesId, { ...entry, signals });
      return { axes: axesMap };
    });
  },

  setSignalGain: (axesId, simId, signalName, gain) => {
    set((state) => {
      const axesMap = new Map(state.axes);
      const entry = axesMap.get(axesId);
      if (!entry) return {};
      const idx = entry.signals.findIndex((s) => s.simId === simId && s.signalName === signalName);
      if (idx === -1) return {};
      const signals = [...entry.signals];
      const current = signals[idx] as SignalRef;
      // A gain of 0 would flatten the trace onto the axis and read as "this
      // signal is zero", which is the one thing a display aid must never
      // say. Non-finite is the same mistake typed differently.
      const clean = Number.isFinite(gain) && gain !== 0 ? gain : 1;
      signals[idx] = clean === 1 ? { ...current, gain: undefined } : { ...current, gain: clean };
      axesMap.set(axesId, { ...entry, signals });
      return { axes: axesMap };
    });
  },

  beginRun: (simId) => {
    set((state) => {
      if (state.currentSimId === simId) return {};
      const history = state.currentSimId
        ? [state.currentSimId, ...state.runHistory.filter((id) => id !== state.currentSimId)]
        : [...state.runHistory];
      const kept = history.slice(0, Math.max(0, state.historyLimit));
      const evicted = history.slice(Math.max(0, state.historyLimit));
      return {
        currentSimId: simId,
        runHistory: kept,
        signalCache: _withoutRuns(state.signalCache, evicted),
      };
    });
  },

  setHistoryLimit: (limit) => {
    set((state) => {
      const clean = Math.max(0, Math.floor(limit));
      const kept = state.runHistory.slice(0, clean);
      const evicted = state.runHistory.slice(clean);
      return {
        historyLimit: clean,
        runHistory: kept,
        signalCache: _withoutRuns(state.signalCache, evicted),
      };
    });
  },

  setAxesHistoryDepth: (axesId, depth) => {
    set((state) => {
      const axesMap = new Map(state.axes);
      const entry = axesMap.get(axesId);
      if (!entry) return {};
      axesMap.set(axesId, { ...entry, historyDepth: Math.max(0, Math.floor(depth)) });
      return { axes: axesMap };
    });
  },

  setActiveAxes: (axesId) => {
    set((state) => (state.activeAxesId === axesId ? {} : { activeAxesId: axesId }));
  },

  setAxesMeasurements: (axesId, measurements) => {
    set((state) => {
      const axesMap = new Map(state.axes);
      const entry = axesMap.get(axesId);
      if (!entry) return {};
      axesMap.set(axesId, { ...entry, measurements });
      return { axes: axesMap };
    });
  },
  setAxesMeasuredSignals: (axesId, signalKeys) => {
    set((state) => {
      const axesMap = new Map(state.axes);
      const entry = axesMap.get(axesId);
      if (!entry) return {};
      axesMap.set(axesId, { ...entry, measuredSignals: signalKeys });
      return { axes: axesMap };
    });
  },
  setAxesCollapsed: (axesId, collapsed) => {
    set((state) => {
      const axesMap = new Map(state.axes);
      const entry = axesMap.get(axesId);
      if (!entry) return {};
      axesMap.set(axesId, { ...entry, collapsed });
      return { axes: axesMap };
    });
  },
  setFigureTrackSizes: (figureId, sizes) => {
    set((state) => {
      const figures = new Map(state.figures);
      const figure = figures.get(figureId);
      if (!figure) return {};
      figures.set(figureId, {
        ...figure,
        ...(sizes.rows ? { rowSizes: sizes.rows } : {}),
        ...(sizes.cols ? { colSizes: sizes.cols } : {}),
      });
      return { figures };
    });
  },

  resetAxesSignals: (axesId, signals) => {
    set((state) => {
      const axesMap = new Map(state.axes);
      const entry = axesMap.get(axesId);
      if (!entry) return {};
      const refs: SignalRef[] = signals.map(({ simId, signalName }, i) => ({
        simId,
        signalName,
        color: _pickColor(i),
      }));
      axesMap.set(axesId, { ...entry, signals: refs });
      return { axes: axesMap };
    });
    // No fetch for an uncached signal, for the reason `addSignalToAxes` gives.
  },

  clearAxes: (axesId) => {
    set((state) => {
      const axesMap = new Map(state.axes);
      const entry = axesMap.get(axesId);
      if (!entry) return {};
      axesMap.set(axesId, {
        ...entry,
        signals: [],
        xMin: undefined,
        xMax: undefined,
        yMin: undefined,
        yMax: undefined,
        cursorA: undefined,
        cursorB: undefined,
        cursorAH: undefined,
        cursorBH: undefined,
      });
      return { axes: axesMap };
    });
  },

  cacheSignal: (simId, name, data) => {
    const key = _signalCacheKey(simId, name);
    set((state) => {
      const signalCache = new Map(state.signalCache);
      signalCache.set(key, data);
      return { signalCache };
    });
  },

  applySignalMetadata: (simId, details) => {
    if (details.length === 0) return;
    // The document that produced this run. Asked once, here, rather than at
    // draw time: see `WaveformSignal.measured`.
    const captures = _fileSourceIds();
    set((state) => {
      let changed = false;
      const signalCache = new Map(state.signalCache);
      for (const detail of details) {
        const key = _signalCacheKey(simId, detail.name);
        const signal = signalCache.get(key);
        // Only signals already cached: this corrects what is there and never
        // invents an entry with no samples, which every consumer would then
        // have to treat as a signal that exists but cannot be drawn.
        if (!signal) continue;
        signalCache.set(key, {
          ...signal,
          analysis: detail.analysis ?? signal.analysis,
          quantity: detail.quantity ?? signal.quantity,
          unit: detail.unit ?? signal.unit,
          domain: detail.domain ?? signal.domain,
          ...(detail.block === undefined ? {} : { blockId: detail.block }),
          ...(detail.port === undefined ? {} : { portId: detail.port }),
          measured: detail.block !== undefined && captures.has(detail.block),
        });
        changed = true;
      }
      return changed ? { signalCache } : {};
    });
  },

  createCouplingGroup: (name, lockX, lockY) => {
    const id = _uuid();
    const group: CouplingGroup = { id, name, axesIds: [], lockX, lockY };
    set((state) => {
      const couplingGroups = new Map(state.couplingGroups);
      couplingGroups.set(id, group);
      return { couplingGroups };
    });
    return id;
  },

  assignAxesToGroup: (axesId, groupId) => {
    set((state) => {
      const axesMap = new Map(state.axes);
      const entry = axesMap.get(axesId);
      if (!entry) return {};

      // Remove from previous group if any.
      const couplingGroups = new Map(state.couplingGroups);
      if (entry.couplingGroupId) {
        const prev = couplingGroups.get(entry.couplingGroupId);
        if (prev) {
          couplingGroups.set(entry.couplingGroupId, {
            ...prev,
            axesIds: prev.axesIds.filter((aid) => aid !== axesId),
          });
        }
      }

      axesMap.set(axesId, { ...entry, couplingGroupId: groupId });

      const group = couplingGroups.get(groupId);
      if (group && !group.axesIds.includes(axesId)) {
        couplingGroups.set(groupId, { ...group, axesIds: [...group.axesIds, axesId] });
      }

      return { axes: axesMap, couplingGroups };
    });
  },

  ensureFigureXCoupling: (figureId) => {
    const figure = get().figures.get(figureId);
    if (!figure || figure.axesIds.length < 2) return;

    let groupId = figure.autoXCouplingGroupId;
    if (!groupId || !get().couplingGroups.has(groupId)) {
      groupId = get().createCouplingGroup(`${figure.name} (auto X)`, true, false);
      const createdGroupId = groupId;
      set((state) => {
        const figures = new Map(state.figures);
        const fig = figures.get(figureId);
        if (!fig) return {};
        figures.set(figureId, { ...fig, autoXCouplingGroupId: createdGroupId });
        return { figures };
      });
    }

    for (const axesId of figure.axesIds) {
      const ax = get().axes.get(axesId);
      if (!ax) continue;
      // Leave alone if already in a *different*, explicit (user-made) group.
      if (ax.couplingGroupId && ax.couplingGroupId !== groupId) continue;
      if (ax.couplingGroupId === groupId) continue;
      get().assignAxesToGroup(axesId, groupId);
    }
  },

  deleteCouplingGroup: (id) => {
    set((state) => {
      const couplingGroups = new Map(state.couplingGroups);
      couplingGroups.delete(id);
      // Clear couplingGroupId from all axes that belonged to this group.
      const axesMap = new Map(state.axes);
      for (const [axesId, entry] of axesMap) {
        if (entry.couplingGroupId === id) {
          axesMap.set(axesId, { ...entry, couplingGroupId: undefined });
        }
      }
      return { axes: axesMap, couplingGroups };
    });
  },

  setAxesZoom: (axesId, xMin, xMax) => {
    set((state) => {
      const axesMap = new Map(state.axes);
      const entry = axesMap.get(axesId);
      if (!entry) return {};
      axesMap.set(axesId, { ...entry, xMin, xMax });
      return { axes: axesMap };
    });
  },

  setAxesYZoom: (axesId, yMin, yMax) => {
    set((state) => {
      const axesMap = new Map(state.axes);
      const entry = axesMap.get(axesId);
      if (!entry) return {};
      axesMap.set(axesId, { ...entry, yMin, yMax });
      return { axes: axesMap };
    });
  },

  setAxesCursor: (axesId, cursor, value) => {
    set((state) => {
      const axesMap = new Map(state.axes);
      const entry = axesMap.get(axesId);
      if (!entry) return {};
      const field = {
        A: "cursorA",
        B: "cursorB",
        AH: "cursorAH",
        BH: "cursorBH",
      }[cursor] as "cursorA" | "cursorB" | "cursorAH" | "cursorBH";
      axesMap.set(axesId, { ...entry, [field]: value });
      return { axes: axesMap };
    });
  },

  setAxesPanMode: (axesId, panMode) => {
    set((state) => {
      const axesMap = new Map(state.axes);
      const entry = axesMap.get(axesId);
      if (!entry) return {};
      axesMap.set(axesId, { ...entry, panMode });
      return { axes: axesMap };
    });
  },

  propagateZoom: (axesId, xMin, xMax, yMin, yMax) => {
    set((state) => {
      const sourceEntry = state.axes.get(axesId);
      if (!sourceEntry) return {};

      const axesMap = new Map(state.axes);
      // Always record the source axes' own zoom values, even when it isn't in
      // a coupling group — otherwise a plain drag-zoom on a standalone axes
      // never reaches the store, leaving the toolbar's Zoom In/Out/Fit and
      // cursor math working off stale (undefined) bounds.
      axesMap.set(axesId, { ...sourceEntry, xMin, xMax, yMin, yMax });

      // Propagate to sibling axes in the group, if any.
      const group = sourceEntry.couplingGroupId
        ? state.couplingGroups.get(sourceEntry.couplingGroupId)
        : undefined;
      if (group) {
        for (const siblingId of group.axesIds) {
          if (siblingId === axesId) continue;
          const sibling = axesMap.get(siblingId);
          if (!sibling) continue;
          axesMap.set(siblingId, {
            ...sibling,
            ...(group.lockX ? { xMin, xMax } : {}),
            ...(group.lockY ? { yMin, yMax } : {}),
          });
        }
      }

      return { axes: axesMap };
    });
  },
}));

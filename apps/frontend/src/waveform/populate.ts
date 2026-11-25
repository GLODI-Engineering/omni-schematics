/**
 * Laying a finished run's signals out across a figure's axes.
 *
 * Lifted out of `shell/run.ts` by #159, which took the kernel socket out of
 * the run path: a run's samples now live in a `.gsim_samples` container the
 * solver wrote, and reading one is #163's job rather than the run path's. The
 * layout arithmetic is unchanged and is kept whole — it is the part with the
 * reported failures behind it (FE-146, FE-158), it is tested, and it is what
 * #163 will call when the viewer can read the container.
 */
import type { SignalDetail } from "../ipc/types";
import { useWaveformStore } from "../store/waveform";

// FE-158: cap how many signals share one axes. Dumping every signal from a
// many-signal run onto a single axes (the pre-FE-158 behavior) put up to
// 24 signals — each up to 300k+ points in a real run — on one uPlot
// instance, which combined with the render path fixed in FE-159 was the
// root cause of the reported freeze/crash when the user later viewed that
// figure.
const MAX_SIGNALS_PER_AXES = 8;

/**
 * Best-effort SPICE-convention quantity guess from a signal's name alone
 * (v(...) / i(...) / p(...)), used only to decide which axes a signal
 * lands on. The *authoritative* quantity comes from each signal's own
 * metadata, resolved asynchronously per-signal by fetchSignal() — too late
 * to drive this synchronous layout decision without pre-fetching every
 * signal's data before laying out axes at all, which is a larger change
 * than this fix warrants (see FE-158 in progress.frontend.yaml).
 */
export function quantityHeuristic(signalName: string): string {
  const lower = signalName.toLowerCase();
  if (lower.startsWith("v(")) return "voltage";
  if (lower.startsWith("i(")) return "current";
  if (lower.startsWith("p(")) return "power";
  return "signal";
}

/** Group signal names by heuristic quantity, then chunk each group to MAX_SIGNALS_PER_AXES. */
export function groupSignalsIntoAxes(signalNames: string[]): string[][] {
  const groups = new Map<string, string[]>();
  for (const name of signalNames) {
    const quantity = quantityHeuristic(name);
    const bucket = groups.get(quantity);
    if (bucket) {
      bucket.push(name);
    } else {
      groups.set(quantity, [name]);
    }
  }

  const axesGroups: string[][] = [];
  for (const names of groups.values()) {
    for (let i = 0; i < names.length; i += MAX_SIGNALS_PER_AXES) {
      axesGroups.push(names.slice(i, i + MAX_SIGNALS_PER_AXES));
    }
  }
  return axesGroups;
}

/**
 * After a successful simulation, ensure the P22 waveform viewer has a figure
 * ready, then distribute the returned signals across a grid of axes within
 * it — grouped by heuristic quantity and capped at MAX_SIGNALS_PER_AXES per
 * axes (FE-158) — instead of piling every signal onto a single axes.
 *
 * Strategy:
 *   - Use the first existing figure; create one named after the sim if none exists.
 *   - Group signal names (_groupSignalsIntoAxes) and grow/shrink the figure's
 *     grid (row-major) to fit the resulting axes groups.
 *   - Reuse an existing axes already at a given (row, col) when one is still
 *     needed there (keeps axes identity — and any user zoom/coupling state
 *     on it — stable across re-runs with the same layout); create new axes
 *     for grid positions that need one; delete leftover axes from a larger
 *     previous layout that the new one no longer uses.
 *   - Fire-and-forget HTTP fetches for each signal; Axes re-renders when data lands.
 *
 * Runs for *every* completed simulation, including one whose manifest
 * reports zero signals (e.g. an imported netlist with no nodes the backend
 * recognizes as probe-worthy) — skipping the reset in that case used to
 * leave whatever the previous run's axes were still displaying on screen,
 * with nothing indicating those traces were stale instead of belonging to
 * the run that had just completed (FE-146). Only bails out early when there
 * is no existing figure AND nothing to plot — no point creating an empty one.
 */
export function populateWaveformViewer(
  manifest: { sim_id: string; signals: string[]; details?: SignalDetail[] } | null | undefined,
): void {
  if (!manifest) return;

  const store = useWaveformStore.getState();
  const simId = manifest.sim_id;

  // What the run says about its own signals, before anything is drawn. A
  // signal that streamed live is in the cache already, carrying the
  // placeholder metadata a chunk frame could supply; this is the only moment
  // the real analysis, unit and producing block are in hand.
  if (manifest.details && manifest.details.length > 0) {
    store.applySignalMetadata(simId, manifest.details);
  }

  // Move the outgoing run into the history before its axes are repopulated.
  // Its samples stay in the cache under their own sim id, so an axes set to
  // show past runs can draw it behind the new one.
  store.beginRun(simId);

  if (store.figures.size === 0 && manifest.signals.length === 0) return;

  // Resolve or create the target figure.
  let figureId: string;
  if (store.figures.size === 0) {
    figureId = store.createFigure("Simulation", 1, 1);
  } else {
    figureId = store.figures.keys().next().value as string;
  }

  const axesGroups = groupSignalsIntoAxes(manifest.signals);
  // A zero-signal run still needs one (empty) axes so FE-146's stale-trace
  // clearing keeps working — resetAxesSignals([]) below empties it.
  if (axesGroups.length === 0) axesGroups.push([]);

  const cols = Math.max(1, Math.ceil(Math.sqrt(axesGroups.length)));
  const rows = Math.max(1, Math.ceil(axesGroups.length / cols));

  // Snapshot which axes already occupy which (row, col) in this figure
  // before resizing/repopulating, so positions that are still needed in the
  // new layout can reuse their existing axes id instead of being recreated.
  const figureBefore = useWaveformStore.getState().figures.get(figureId);
  const existingByPos = new Map<string, string>();
  if (figureBefore) {
    for (const axesId of figureBefore.axesIds) {
      const ax = useWaveformStore.getState().axes.get(axesId);
      if (ax) existingByPos.set(`${ax.row},${ax.col}`, axesId);
    }
  }

  // Grow/shrink the grid — drops any axes that fall outside the new bounds.
  useWaveformStore.getState().resizeFigure(figureId, rows, cols);

  const usedPositions = new Set<string>();
  axesGroups.forEach((signalNames, idx) => {
    const row = Math.floor(idx / cols);
    const col = idx % cols;
    const posKey = `${row},${col}`;
    usedPositions.add(posKey);

    const reusableId = existingByPos.get(posKey);
    const axesId =
      reusableId && useWaveformStore.getState().axes.has(reusableId)
        ? reusableId
        : useWaveformStore.getState().createAxes(figureId, row, col);

    useWaveformStore.getState().resetAxesSignals(
      axesId,
      signalNames.map((signalName) => ({ simId, signalName })),
    );
  });

  // Clean up leftover axes from a previous, larger layout at positions the
  // new layout no longer uses (still within the resized bounds, so
  // resizeFigure didn't already drop them).
  for (const [posKey, axesId] of existingByPos) {
    if (!usedPositions.has(posKey) && useWaveformStore.getState().axes.has(axesId)) {
      useWaveformStore.getState().deleteAxes(axesId);
    }
  }
}

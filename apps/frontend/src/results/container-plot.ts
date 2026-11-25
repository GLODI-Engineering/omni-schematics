/**
 * Putting a `.gsim_samples` container on the screen, and keeping it there as
 * the view moves.
 *
 * The last step of #157. `results/samples-source.ts` can read a window of a
 * container; this is what decides *which* window, puts the points where the
 * chart looks for them, and asks for a new one when the user zooms.
 *
 * ## What "a plot appears immediately" means here, precisely
 *
 * Opening the container costs three small reads whose locations are
 * arithmetic, and the prologue they bring back answers the signal names, their
 * units, the row count and the sweep extent. So the figure, its axes, their
 * spine labels and their x range are on screen **before any sample is
 * fetched** — which is the thing a multi-gigabyte container makes worth doing,
 * because the alternative is a blank panel for as long as the first read
 * takes.
 *
 * What is deliberately *not* done is filling those axes with invented samples
 * to make a trace appear sooner. A chart drawn from values nothing computed is
 * FE-146's complaint wearing a different hat: an empty plot presented as a
 * result. The traces arrive with the first window, which is tens of kilobytes
 * whatever the run's length.
 *
 * ## Why the source is kept per run and not per chart
 *
 * An open container is a size, a prologue and a `SamplesFile` holding them —
 * tens of kilobytes, whatever the file's length. Every axes showing that run
 * reads through the same one, so the prologue is fetched once per run rather
 * than once per chart, and the registry below is what makes a zoom on the
 * fourth axes of a figure cost one plan and one fetch.
 */

import type { SignalDetail } from "../ipc/types";
import { useWaveformStore } from "../store/waveform";
import { populateWaveformViewer } from "../waveform/populate";
import type { SignalRef, WaveformSignal } from "../waveform/types";
import type { SamplesReadTarget } from "./samples-host";
import { ContainerSource, type SamplesSignal, hostFetcher } from "./samples-source";

/** Open containers, by the sim id their signals are cached under. */
const sources = new Map<string, ContainerSource>();

/** The last window asked of each run, so a redraw does not refetch it. */
const lastWindow = new Map<string, string>();

/**
 * What the last window of each run cost to fetch.
 *
 * Kept separately from `bytesFetched`, which is cumulative over the session.
 * The two answer different questions and only one of them is the format's
 * claim: a *window* is a small read whatever the file's length, while the
 * total of every window a user ever scrubbed through will of course exceed
 * the file eventually. On a container short enough to be a single stripe the
 * difference is stark — two reads of it pass the file's own size — so which
 * number is being quoted has to be unambiguous.
 */
const lastWindowBytes = new Map<string, number>();

/** The container backing `simId`, if the viewer has one open. */
export function containerFor(simId: string): ContainerSource | undefined {
  return sources.get(simId);
}

/** Bytes fetched for `simId` since it was opened, every read added up. */
export function containerBytesFetched(simId: string): number {
  return sources.get(simId)?.bytesFetched ?? 0;
}

/** What the most recent window of `simId` cost — the format's own claim. */
export function containerLastWindowBytes(simId: string): number {
  return lastWindowBytes.get(simId) ?? 0;
}

/**
 * How many runs' containers stay open.
 *
 * One open container is a size, a prologue and a `SamplesFile` — tens of
 * kilobytes whatever the file's length — but a session is an unbounded number
 * of runs, and an unbounded number of those is a leak however small each one
 * is. The store keeps `DEFAULT_HISTORY_LIMIT` past runs for overlays, so one
 * more than that is every run anything can still draw.
 */
const MAX_OPEN_SOURCES = 5;

/** Close the containers of runs older than anything an axes can still draw. */
function evictOldSources(): void {
  while (sources.size > MAX_OPEN_SOURCES) {
    // Insertion order: `Map` iterates oldest first, and `plotContainer`
    // deletes before it sets, so a re-opened run counts as new.
    const oldest = sources.keys().next().value;
    if (oldest === undefined) return;
    sources.get(oldest)?.close();
    sources.delete(oldest);
    lastWindow.delete(oldest);
    lastWindowBytes.delete(oldest);
  }
}

/** Forget every open container. For tests, and for a viewer being torn down. */
export function closeContainers(): void {
  for (const source of sources.values()) {
    source.close();
  }
  sources.clear();
  lastWindow.clear();
  lastWindowBytes.clear();
}

/**
 * What opening one left on screen, for the Output panel and for a test to
 * assert on. Every number in it is measured rather than assumed.
 */
export interface ContainerPlotReport {
  simId: string;
  /** Bytes the container occupies. */
  size: number;
  rows: number;
  signals: string[];
  extent: [number, number] | null;
  /** Points per trace after reduction — what the chart was given. */
  points: number;
  /** Bytes fetched to get there, the prologue included. */
  bytesFetched: number;
}

/**
 * The quantity a signal is, from its name.
 *
 * ## Why the container's own field is usually no help
 *
 * `general-simulator 0.7.0` writes `quantity: "dimensionless"` and `unit: ""`
 * for every vector, which is honest — a netlist has no units, which is what
 * `samples-index.ts` says about the same footer and what #185 is open about.
 * But `"dimensionless"` is not a neutral value downstream:
 * `axes-config.ts`'s `buildSpines` *skips* a signal whose quantity is
 * `"dimensionless"`, so taking the field at face value gives a chart with no
 * y axis at all. Found by the integration suite, against a real run, which is
 * the only place it shows.
 *
 * So `"dimensionless"` and `""` are both read as "the writer did not know",
 * and the name decides — the same `v(`/`i(`/`p(` reading `populate.ts` uses to
 * group signals onto axes, so a trace lands on the axes whose spine it is
 * labelled with. A container that one day carries a real quantity wins over
 * the guess.
 */
function quantityOf(signal: SamplesSignal): string {
  if (signal.quantity && signal.quantity !== "dimensionless") return signal.quantity;
  const lower = signal.name.toLowerCase();
  if (lower.startsWith("v(")) return "voltage";
  if (lower.startsWith("i(")) return "current";
  if (lower.startsWith("p(")) return "power";
  // Not "dimensionless": a gate drive or a control signal has no unit but
  // still needs an axis to be drawn against.
  return "signal";
}

/** The SI unit for a guessed quantity, so a spine is labelled rather than bare. */
function unitOf(signal: SamplesSignal): string {
  if (signal.unit) return signal.unit;
  switch (quantityOf(signal)) {
    case "voltage":
      return "V";
    case "current":
      return "A";
    case "power":
      return "W";
    default:
      return "";
  }
}

function detailsOf(signals: SamplesSignal[]): SignalDetail[] {
  return signals.map((signal) => ({
    name: signal.name,
    analysis: signal.analysis || "transient",
    quantity: quantityOf(signal),
    unit: unitOf(signal),
    domain: "time",
  }));
}

/**
 * Points per trace for the first read of a container.
 *
 * `Axes` re-asks at its own width-derived budget once it is mounted — two
 * points per pixel, which is the most a min/max envelope can show. This is
 * only the first read, and it is generous on purpose: a figure wider than
 * 1500 pixels is common on a second monitor, and reading 3,000 points of a
 * container is tens of kilobytes whatever the run's length.
 */
export const FIRST_WINDOW_POINTS = 3000;

/**
 * Draw the container a finished run wrote.
 *
 * The run's reply carries everything needed to find it: `samplesPath` is
 * absolute, because the host wrote it. So no `.gsim_sim_result` is parsed —
 * the document would only repeat what the reply already said — and the run's
 * own directory name is the sim id its signals are cached under, so a re-run
 * leaves the previous run's samples under their own id for an overlay to draw.
 */
export function plotRunContainer(result: {
  resultPath: string;
  samplesPath: string;
}): Promise<ContainerPlotReport> {
  return plotContainer({
    simId: runIdOf(result.resultPath),
    target: { path: result.samplesPath },
    maxPoints: FIRST_WINDOW_POINTS,
  });
}

/** The run directory's name, which is the run's id. */
export function runIdOf(resultPath: string): string {
  const parts = resultPath.split(/[\\/]/).filter((part) => part.length > 0);
  return parts[parts.length - 2] ?? resultPath;
}

/**
 * Open the container and draw it.
 *
 * `simId` is what the signals are cached under and what an axes refers to. The
 * run's own id is the natural choice: a result is one run, and keeping the
 * previous run's samples under their own id is what lets an axes draw it
 * behind the new one.
 */
export async function plotContainer(options: {
  simId: string;
  target: SamplesReadTarget;
  /** Points per trace. The chart's own budget when it has one. */
  maxPoints: number;
}): Promise<ContainerPlotReport> {
  const { simId, target, maxPoints } = options;

  const source = await ContainerSource.open(hostFetcher(target));
  sources.get(simId)?.close();
  // Deleted before it is set, so re-opening a run moves it to the newest end
  // of the insertion order `evictOldSources` reads.
  sources.delete(simId);
  sources.set(simId, source);
  lastWindow.delete(simId);
  evictOldSources();

  const names = source.names();

  // Labels and layout first, from the prologue alone: the axes exist, carry
  // their units and sit at the run's own extent before a sample is asked for.
  populateWaveformViewer({ sim_id: simId, signals: names, details: detailsOf(source.signals) });
  if (source.extent) {
    const [from, to] = source.extent;
    const state = useWaveformStore.getState();
    for (const [axesId, axes] of state.axes) {
      // Only the axes this run was just laid out across: another figure may be
      // showing a different run, and moving its view would be a surprise.
      if (axes.signals.some((ref) => ref.simId === simId)) {
        useWaveformStore.getState().setAxesZoom(axesId, from, to);
      }
    }
  }

  const points = await loadWindow(simId, names, source.extent, maxPoints);
  return {
    simId,
    size: source.size,
    rows: source.rows,
    signals: names,
    extent: source.extent,
    points,
    bytesFetched: source.bytesFetched,
  };
}

/**
 * Fetch one window of `names` and put it in the cache.
 *
 * Returns how many points per trace landed. The window is the whole extent
 * when `window` is null, which is what an opened result shows first.
 */
async function loadWindow(
  simId: string,
  names: string[],
  window: [number, number] | null,
  maxPoints: number,
): Promise<number> {
  const source = sources.get(simId);
  if (!source || names.length === 0) return 0;

  const slice = await source.window(names, window, maxPoints);
  lastWindowBytes.set(simId, slice.bytesFetched);
  const store = useWaveformStore.getState();
  const byName = new Map(source.signals.map((signal) => [signal.name, signal]));

  names.forEach((name, index) => {
    const meta = byName.get(name);
    const signal: WaveformSignal = {
      simId,
      name,
      analysis: meta?.analysis || "transient",
      quantity: meta ? quantityOf(meta) : "signal",
      unit: meta ? unitOf(meta) : "",
      domain: "time",
      time: slice.sweep,
      values: slice.columns[index] ?? new Float64Array(slice.sweep.length),
    };
    // Replaced, not merged: this *is* the samples for the window on screen, so
    // a previous window's points must not be left beside it. `cacheSignal`
    // overwrites the entry, which is what the viewer reads on its next draw.
    store.cacheSignal(simId, name, signal);
  });
  return slice.sweep.length;
}

/**
 * Ask for the window these refs are now showing, if a container backs them.
 *
 * Called from the chart's own refine, which is already debounced — see
 * `Axes.tsx`'s `REFINE_DELAY_MS`, and the bargain it describes: rescaling the
 * points in hand is free and looks right immediately, and the sharper version
 * lands once the gesture stops. Re-planning on every frame of a wheel zoom
 * would ask the host for a fetch per frame.
 *
 * Returns the bytes fetched, or 0 when nothing needed fetching — the same
 * window at the same budget is not asked for twice, which is a *request*
 * dedupe and not a sample cache. Caching samples would break the property the
 * two-pass read rests on: both passes must ask for identical ranges, which
 * holds only because the decision reads no sample value.
 */
export async function requestContainerWindow(
  refs: SignalRef[],
  window: [number, number] | null,
  maxPoints: number,
): Promise<number> {
  const simId = refs.find((ref) => sources.has(ref.simId))?.simId;
  if (simId === undefined) return 0;
  const source = sources.get(simId);
  if (!source) return 0;

  // Every signal the container holds, not only the ones on this axes: a figure
  // splits one run across several axes, and one plan covering the run costs
  // one round trip where one plan per axes costs four.
  const names = source.names();
  const key = JSON.stringify([window, maxPoints, names]);
  if (lastWindow.get(simId) === key) return 0;
  lastWindow.set(simId, key);

  const before = source.bytesFetched;
  try {
    await loadWindow(simId, names, window, maxPoints);
  } catch (error) {
    // A refused or failed read leaves the previous window on screen, which is
    // the right answer: the trace the user was looking at is still the trace
    // the run produced. The key is cleared so the next gesture tries again.
    lastWindow.delete(simId);
    throw error;
  }
  return source.bytesFetched - before;
}

/**
 * The axes-layout arithmetic, tested where it lives.
 *
 * These assertions were `shell/run.test.tsx`'s, driven through `triggerRun`
 * with a mocked kernel `execute` that answered with a manifest. #159 took the
 * kernel out of the run path and the manifest with it — a run's samples are in
 * a `.gsim_samples` container now, and reading one is #163 — so the layout
 * moved to `waveform/populate.ts` and is exercised directly rather than
 * through a backend that no longer exists.
 *
 * Both reported failures behind it (FE-146's stale traces, FE-158's
 * twenty-four signals on one axes) are kept, because the arithmetic is
 * unchanged.
 */
import { beforeEach, describe, expect, it } from "vitest";

import { useWaveformStore } from "../store/waveform";
import { groupSignalsIntoAxes, populateWaveformViewer, quantityHeuristic } from "./populate";

beforeEach(() => {
  useWaveformStore.setState(useWaveformStore.getInitialState());
});

const figure = () => {
  const id = [...useWaveformStore.getState().figures.keys()][0] as string;
  return { id, value: useWaveformStore.getState().figures.get(id) };
};

const axesOf = (figureId: string) =>
  (useWaveformStore.getState().figures.get(figureId)?.axesIds ?? []).map((id) =>
    useWaveformStore.getState().axes.get(id),
  );

describe("quantityHeuristic", () => {
  it("reads the SPICE prefix and nothing else", () => {
    // Deliberately a guess from the name alone: the authoritative quantity
    // comes from each signal's own metadata, which arrives too late to drive
    // a synchronous layout decision.
    expect(quantityHeuristic("v(out)")).toBe("voltage");
    expect(quantityHeuristic("I(L1)")).toBe("current");
    expect(quantityHeuristic("p(r1)")).toBe("power");
    expect(quantityHeuristic("gate_drive")).toBe("signal");
  });
});

describe("groupSignalsIntoAxes", () => {
  it("groups by quantity, then chunks at eight", () => {
    const names = [
      ...Array.from({ length: 20 }, (_, i) => `v(n${i})`),
      ...Array.from({ length: 4 }, (_, i) => `i(r${i})`),
    ];
    const groups = groupSignalsIntoAxes(names);
    expect(groups.map((group) => group.length)).toEqual([8, 8, 4, 4]);
  });
});

describe("populateWaveformViewer", () => {
  it("FE-158: distributes a many-signal run across multiple axes", () => {
    const signals = [
      ...Array.from({ length: 20 }, (_, i) => `v(n${i})`),
      ...Array.from({ length: 4 }, (_, i) => `i(r${i})`),
    ];
    populateWaveformViewer({ sim_id: "s1", signals });

    const { id } = figure();
    const axesList = axesOf(id);
    // 20 voltages -> 3 axes (8+8+4), 4 currents -> 1 axes: 4 axes total.
    expect(axesList.length).toBe(4);
    for (const axes of axesList) {
      expect(axes?.signals.length).toBeLessThanOrEqual(8);
    }
    const plotted = axesList.flatMap((axes) => axes?.signals.map((s) => s.signalName) ?? []);
    expect(plotted.sort()).toEqual([...signals].sort());
  });

  it("FE-158: a small single-quantity run still lands on exactly one axes", () => {
    populateWaveformViewer({ sim_id: "s1", signals: ["v(a)", "v(b)", "v(c)"] });
    const { id, value } = figure();
    expect(value?.axesIds.length).toBe(1);
    expect(axesOf(id)[0]?.signals.map((s) => s.signalName)).toEqual(["v(a)", "v(b)", "v(c)"]);
  });

  it("FE-158: re-running the same layout reuses the axes id, so zoom survives", () => {
    populateWaveformViewer({ sim_id: "s1", signals: ["v(a)"] });
    const first = figure().value?.axesIds[0];
    populateWaveformViewer({ sim_id: "s2", signals: ["v(a)"] });
    expect(figure().value?.axesIds[0]).toBe(first);
  });

  it("FE-146: a zero-signal run clears the previous run's traces", () => {
    populateWaveformViewer({ sim_id: "s1", signals: ["y"] });
    const axesId = figure().value?.axesIds[0] as string;
    expect(useWaveformStore.getState().axes.get(axesId)?.signals).toEqual([
      expect.objectContaining({ simId: "s1", signalName: "y" }),
    ]);

    populateWaveformViewer({ sim_id: "s2", signals: [] });
    // Leaving s1's traces on screen would show them as if they belonged to the
    // run that had just finished.
    expect(useWaveformStore.getState().axes.get(axesId)?.signals).toEqual([]);
  });

  it("does nothing at all without a manifest", () => {
    populateWaveformViewer(null);
    expect(useWaveformStore.getState().figures.size).toBe(0);
  });
});

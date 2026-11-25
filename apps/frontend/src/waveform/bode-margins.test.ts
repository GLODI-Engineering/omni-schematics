import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

import { type BodeMargins, computeBodeMargins } from "./bode-margins";

/**
 * The fixture is the Python implementation's own output, captured by running
 * `simulator.postprocess.bode_margins.compute_bode_margins` on each case at
 * the moment this was ported.
 *
 * That is the point: these are not this file's idea of what a Bode margin is,
 * they are what the measurement panel showed before the arithmetic moved out
 * of Python. A port that is merely *correct* is not good enough — it has to
 * agree, or a number a user has been reading for months silently changes.
 */
interface ParityCase {
  freqHz: number[];
  magDb: number[];
  phaseDeg: number[];
  expected: Record<keyof BodeMargins, number | null>;
}

const fixture: Record<string, ParityCase> = JSON.parse(
  fs.readFileSync(path.join(__dirname, "__fixtures__", "bode-margins-parity.json"), "utf8"),
);

const fields: (keyof BodeMargins)[] = [
  "gainMarginDb",
  "phaseMarginDeg",
  "delayMarginS",
  "gainCrossoverHz",
  "phaseCrossoverHz",
  "bandwidth3dbHz",
];

describe("computeBodeMargins matches the Python it replaces", () => {
  for (const [name, c] of Object.entries(fixture)) {
    it(name, () => {
      const got = computeBodeMargins(c.freqHz, c.magDb, c.phaseDeg);
      for (const field of fields) {
        const want = c.expected[field];
        if (want === null) {
          expect(got[field], `${name}.${field}`).toBeNull();
        } else {
          // Relative, because the values span delay margins of ~1e-3 s and
          // frequencies of ~1e5 Hz; an absolute epsilon would be vacuous at
          // one end and impossible at the other.
          expect(got[field], `${name}.${field}`).not.toBeNull();
          expect(got[field] as number).toBeCloseTo(want, 9);
          const scale = Math.max(Math.abs(want), 1e-12);
          expect(Math.abs((got[field] as number) - want) / scale).toBeLessThan(1e-12);
        }
      }
    });
  }

  it("covers every case the fixture holds", () => {
    // A fixture silently losing a case would make this suite pass by testing
    // less, which is the one way a parity check fails without going red.
    expect(Object.keys(fixture).sort()).toEqual([
      "flat_on_threshold",
      "linear_crossings",
      "no_phase_crossover",
      "rc_lowpass",
      "single_point",
      "starts_below_unity",
      "two_points",
    ]);
  });
});

describe("the two subtleties a careless rewrite drops", () => {
  it("does not call a segment lying on the threshold a crossing", () => {
    // Magnitude runs flat along 0 dB from 1 Hz to 100 Hz and only then falls.
    // A trace that sits on 0 dB for two decades has not crossed it, and
    // reporting the first flat sample as the gain crossover would measure the
    // phase margin at 1 Hz instead of at 100 Hz -- a wrong answer that looks
    // entirely plausible.
    const margins = computeBodeMargins([1, 10, 100, 1000], [0, 0, 0, -20], [-5, -20, -90, -170]);
    expect(margins.gainCrossoverHz).toBe(100);
    expect(margins.phaseMarginDeg).toBe(90);
  });

  it("takes the -3 dB reference from 0 dB when the sweep starts attenuated", () => {
    // Reference is max(magDb[0], 0). A sweep starting at -20 dB measures its
    // bandwidth relative to unity, not relative to its own attenuated start --
    // otherwise a -20 dB plateau would report a bandwidth where it reaches
    // -23 dB, which is not a bandwidth.
    const margins = computeBodeMargins([1, 10, 100], [-20, -24, -40], [-5, -10, -20]);
    expect(margins.bandwidth3dbHz).toBeNull();
  });
});

describe("inputs it refuses or cannot answer", () => {
  it("refuses arrays of different lengths, naming all three", () => {
    expect(() => computeBodeMargins([1, 2], [0], [0, 0])).toThrow(/got 2, 1 and 2/);
  });

  it("answers nothing for a sweep of one point", () => {
    // Nothing can cross anything between a sample and itself.
    const margins = computeBodeMargins([1], [0], [-180]);
    for (const field of fields) {
      expect(margins[field]).toBeNull();
    }
  });

  it("answers nothing for an empty sweep", () => {
    const margins = computeBodeMargins([], [], []);
    for (const field of fields) {
      expect(margins[field]).toBeNull();
    }
  });

  it("gives no delay margin at a zero-hertz gain crossover", () => {
    // Guarded because the delay margin divides by the crossover frequency.
    const margins = computeBodeMargins([0, 10], [0, -20], [-90, -120]);
    expect(margins.gainCrossoverHz).toBe(0);
    expect(margins.delayMarginS).toBeNull();
  });
});

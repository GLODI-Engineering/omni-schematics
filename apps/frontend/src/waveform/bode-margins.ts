/**
 * Bode stability margins, from a frequency sweep.
 *
 * A port of `packages/simulator/src/simulator/postprocess/bode_margins.py`,
 * kept faithful on purpose: the numbers the measurement panel shows must not
 * change because the arithmetic moved out of Python. The two subtleties below
 * are where a careless rewrite would quietly disagree.
 *
 * Nothing here is wired up yet. It is a prerequisite for deleting the Python,
 * not a feature: #162 removes `postprocess/`, and that cannot happen while
 * this is the only implementation of it.
 */

/** Every field is null when its metric cannot be determined. */
export interface BodeMargins {
  gainMarginDb: number | null;
  phaseMarginDeg: number | null;
  delayMarginS: number | null;
  gainCrossoverHz: number | null;
  phaseCrossoverHz: number | null;
  bandwidth3dbHz: number | null;
}

const none = (): BodeMargins => ({
  gainMarginDb: null,
  phaseMarginDeg: null,
  delayMarginS: null,
  gainCrossoverHz: null,
  phaseCrossoverHz: null,
  bandwidth3dbHz: null,
});

/**
 * The x where y first crosses `threshold`, linearly interpolated.
 *
 * Left to right, first crossing wins. A segment whose *both* ends sit exactly
 * on the threshold is not a crossing: a trace that runs flat along 0 dB for a
 * decade has not crossed it, and treating the first such sample as a crossover
 * would report a gain crossover at the start of the flat region and a phase
 * margin measured there. That is the `!(d0 === 0 && d1 === 0)` term, and it is
 * the easiest part of this to drop by accident.
 */
function interpolateCrossing(
  x: ArrayLike<number>,
  y: ArrayLike<number>,
  threshold: number,
): number | null {
  for (let i = 0; i < y.length - 1; i += 1) {
    // `as number` on each read, which is this project's existing convention
    // under `noUncheckedIndexedAccess` (see `axes-config.ts`). The loop bound
    // makes `i` and `i + 1` in range, and the alternative -- a branch per read
    // for an index that cannot be out of range -- would be four unreachable
    // lines inside the hot loop.
    const d0 = (y[i] as number) - threshold;
    const d1 = (y[i + 1] as number) - threshold;
    if (d0 * d1 <= 0 && !(d0 === 0 && d1 === 0)) {
      const span = d1 - d0;
      if (span === 0) {
        return x[i] as number;
      }
      const x0 = x[i] as number;
      return x0 + (-d0 / span) * ((x[i + 1] as number) - x0);
    }
  }
  return null;
}

/**
 * `numpy.interp`, including its clamping.
 *
 * Outside the sweep it returns the nearest end value rather than
 * extrapolating. That matters here: a crossing found by
 * {@link interpolateCrossing} is always inside the sweep, so the clamp never
 * fires in practice -- but matching it keeps this a port rather than a
 * reimplementation, and an extrapolating version would turn a sweep that
 * barely reaches its crossover into a wild phase margin instead of a
 * plausible one.
 */
function interpolateAt(at: number, x: ArrayLike<number>, y: ArrayLike<number>): number {
  if (at <= (x[0] as number)) {
    return y[0] as number;
  }
  const last = x.length - 1;
  if (at >= (x[last] as number)) {
    return y[last] as number;
  }
  for (let i = 0; i < last; i += 1) {
    const x0 = x[i] as number;
    const x1 = x[i + 1] as number;
    if (at >= x0 && at <= x1) {
      const span = x1 - x0;
      const y0 = y[i] as number;
      if (span === 0) {
        return y0;
      }
      return y0 + ((at - x0) / span) * ((y[i + 1] as number) - y0);
    }
  }
  return y[last] as number;
}

/**
 * The six margins.
 *
 * @param freqHz Frequency axis in Hz, positive and increasing.
 * @param magDb Magnitude in dB.
 * @param phaseDeg Phase in degrees, wrapped or unwrapped.
 * @throws if the three arrays are not the same length.
 */
export function computeBodeMargins(
  freqHz: ArrayLike<number>,
  magDb: ArrayLike<number>,
  phaseDeg: ArrayLike<number>,
): BodeMargins {
  if (freqHz.length !== magDb.length || freqHz.length !== phaseDeg.length) {
    throw new Error(
      `freq, mag_db and phase_deg must be the same length; got ${freqHz.length}, ${magDb.length} and ${phaseDeg.length}`,
    );
  }
  // One point is not a sweep: nothing can cross anything between a single
  // sample and itself, so every metric is honestly unknown.
  if (freqHz.length < 2) {
    return none();
  }

  const gainCrossoverHz = interpolateCrossing(freqHz, magDb, 0);
  const phaseMarginDeg =
    gainCrossoverHz === null ? null : interpolateAt(gainCrossoverHz, freqHz, phaseDeg) + 180;

  const phaseCrossoverHz = interpolateCrossing(freqHz, phaseDeg, -180);
  const gainMarginDb =
    phaseCrossoverHz === null ? null : -interpolateAt(phaseCrossoverHz, freqHz, magDb);

  const delayMarginS =
    phaseMarginDeg !== null && gainCrossoverHz !== null && gainCrossoverHz > 0
      ? phaseMarginDeg / (360 * gainCrossoverHz)
      : null;

  // The reference is the DC level or 0 dB, whichever is higher, so that a
  // sweep starting below unity gain still reports a -3 dB point relative to
  // unity rather than relative to its own attenuated start.
  const referenceDb = Math.max(magDb[0] as number, 0);
  const bandwidth3dbHz = interpolateCrossing(freqHz, magDb, referenceDb - 3);

  return {
    gainMarginDb,
    phaseMarginDeg,
    delayMarginS,
    gainCrossoverHz,
    phaseCrossoverHz,
    bandwidth3dbHz,
  };
}

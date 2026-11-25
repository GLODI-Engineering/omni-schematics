/**
 * A time step for a document that does not say what to run.
 *
 * ## Why a fallback needs to think
 *
 * A document with a `simulation` block is authoritative and nothing here is
 * consulted — every example carries one, declaring 50 to 100 samples per
 * switching period. A document *without* one falls back to the sim-settings
 * store, whose defaults are `tEnd = 10 ms` and `tStep = 10 µs`.
 *
 * Those defaults are fine for a filter and wrong for everything this editor is
 * for. A 100 kHz converter has a 10 µs period, so a 10 µs step samples it once
 * per period, always at the same phase, and the switch reads as permanently
 * off: the result is a flat line that looks like a converged run of a dead
 * circuit (#193).
 *
 * The document knows better than the default does. Its own blocks declare
 * `per` or `freq`, so the shortest switching period in the sheet is there to
 * be read, and a step derived from it beats a constant.
 */

/** Samples per switching period a derived step aims for. */
export const SAMPLES_PER_PERIOD = 50;

interface BlockLike {
  params?: Record<string, unknown> | null;
}

interface DocumentLike {
  model: { blocks?: BlockLike[] | null };
}

/**
 * The shortest switching period any block in the sheet declares, in seconds,
 * or null when nothing does.
 *
 * Reads `per`/`period` directly and inverts `freq`, because the block library
 * spells it both ways -- `pulsewave` takes `per`, `pwm` takes `freq`. A
 * non-positive or non-finite value is ignored rather than inverted into an
 * absurd period.
 */
export function shortestDeclaredPeriod(document: DocumentLike): number | null {
  let shortest: number | null = null;
  const consider = (seconds: number) => {
    if (!Number.isFinite(seconds) || seconds <= 0) {
      return;
    }
    if (shortest === null || seconds < shortest) {
      shortest = seconds;
    }
  };

  for (const block of document.model.blocks ?? []) {
    const params = block.params ?? {};
    for (const [key, value] of Object.entries(params)) {
      if (typeof value !== "number") {
        continue;
      }
      if (key === "per" || key === "period") {
        consider(value);
      } else if (key === "freq" || key === "frequency") {
        consider(value > 0 ? 1 / value : Number.NaN);
      }
    }
  }
  return shortest;
}

/**
 * A step for this document, given the store's own.
 *
 * Never coarser than the store's value: a user who asked for a fine step gets
 * it. Only ever finer, and only when the sheet declares something that the
 * store's step would alias.
 */
export function stepForDocument(document: DocumentLike, storeStep: number): number {
  const period = shortestDeclaredPeriod(document);
  if (period === null) {
    return storeStep;
  }
  const derived = period / SAMPLES_PER_PERIOD;
  return derived < storeStep ? derived : storeStep;
}

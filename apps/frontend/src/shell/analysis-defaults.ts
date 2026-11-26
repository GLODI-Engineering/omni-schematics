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

// ---------------------------------------------------------------------------
// Timing the document declares, when it declares it readably
// ---------------------------------------------------------------------------

/** The fields of an `Analysis` this module reads, as they arrive from JSON. */
export interface AnalysisLike {
  id?: unknown;
  t_end?: unknown;
  t_step?: unknown;
}

/** What a run needs from an analysis, or why it cannot have it. */
export type AnalysisTiming =
  | { ok: true; tEnd: number; tStep: number }
  | { ok: false; reason: string };

/**
 * The window and step a `TRAN` analysis declares — or a refusal naming what
 * could not be read.
 *
 * ## Why this refuses rather than falling back
 *
 * It used to fall back, in one line per field, to the sim-settings store:
 *
 * ```ts
 * tEnd: typeof analysis.t_end === "number" ? analysis.t_end : settings.tEnd,
 * ```
 *
 * The comment on it said the fallbacks were "for a malformed document". That
 * was true when it was written and is not true now. The format's §5.1 and
 * §5.3 make an expression or a bare param reference a legal value for any
 * numeric field of an analysis directive — `"t_end": "{T_sim}"` is a
 * well-formed document, and the engine's `loadDocument` accepts it without a
 * word because it does not evaluate §5.2 either (#199). So the one case the
 * fallback was never meant to cover became the main case it covered, and the
 * way it covered it was to run for 10 ms because the settings panel says
 * 10 ms, while the sheet said 2 ms, with nothing in the output saying which
 * number won.
 *
 * `t_step` is the worse of the two. A sheet declaring 100 ns that silently
 * ran at the store's 10 us samples a 100 kHz converter once per switching
 * period, always at the same phase -- the flat line that reads as a converged
 * run of a dead circuit, which is #193's whole subject.
 *
 * Either way, substituting a *different* number and running is the wrong
 * answer: a result whose window is not the one the sheet declares means
 * something other than what it says. Refusing names the field, so the user can
 * write a number — the only form that works today — rather than reading a
 * plausible waveform of the wrong run.
 *
 * The fallback is still right for the case it was written for, which is a
 * document with no `simulation` block at all: a v1 sheet, or one drawn from
 * nothing. That is a genuine absence, not a value being misread, and the
 * caller handles it.
 */
export function timingForAnalysis(analysis: AnalysisLike): AnalysisTiming {
  const readable = (value: unknown): value is number =>
    typeof value === "number" && Number.isFinite(value);
  const unreadable = (["t_end", "t_step"] as const).filter((field) => !readable(analysis[field]));

  if (unreadable.length > 0) {
    const where =
      typeof analysis.id === "string" && analysis.id.length > 0
        ? `analysis '${analysis.id}'`
        : "this analysis";
    const named = unreadable
      .map((field) => `${field} = ${JSON.stringify(analysis[field] ?? null)}`)
      .join(" and ");
    return {
      ok: false,
      reason:
        `${where} declares ${named}, which is not a number. The engine does not ` +
        "evaluate a param expression or reference here yet (#199), so this run would " +
        "have used the Simulation settings panel's own value instead of the one the " +
        "sheet declares. Write the number.",
    };
  }
  return { ok: true, tEnd: analysis.t_end as number, tStep: analysis.t_step as number };
}

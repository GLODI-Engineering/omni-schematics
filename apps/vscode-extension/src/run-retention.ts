/**
 * #186 — old runs stop accumulating, without a result vanishing under anyone.
 *
 * Every Run writes `.gsim/runs/<run id>/` and nothing ever removed one. That is deliberate as
 * far as it goes: a run is reproducible from exactly those four files, the container may be
 * gigabytes and must not be held in memory, and opening last week's result is the point of the
 * format. But the buck example's 10 ms run is 38 KB while a 20 ms switching run at a 5 ns step
 * is hundreds of megabytes per signal, so a day of iterating fills a disk and the only hint is
 * a `.gsim` directory quietly growing.
 *
 * The rule is a count, not a size. A size budget is what actually matters and it needs a `stat`
 * of every container on every run, which is a directory walk over gigabytes to decide whether
 * to delete anything — so the cheap rule ships and the honest description says what it is.
 *
 * Two things this must never do, and both are about not losing a result someone wanted:
 *
 *   - **Prune after a run succeeds, never before.** Pruning first would let a run that then
 *     fails take the last good result with it, which is the one moment a user most wants the
 *     previous one.
 *   - **Never prune the run just written.** It is the newest, so the ordering already protects
 *     it, but the guarantee is worth stating rather than inferring.
 */

/** A run id is `run-<ISO 8601 with colons and dots replaced>`, so it sorts chronologically. */
const RUN_ID = /^run-\d{4}-\d{2}-\d{2}T[\d-]+Z$/;

export interface PruneDecision {
  /** Oldest first, so a partial failure still removes the least useful ones. */
  remove: string[];
  /** What was kept, newest first. Reported, so the user can see the rule working. */
  keep: string[];
}

/**
 * Which run directories to remove so that at most `keep` remain.
 *
 * `keep <= 0` means keep everything: a user who sets 0 is asking for the old behaviour, and
 * reading it as "delete them all" would destroy every result they have on the next run.
 *
 * Anything that is not a run id is left alone entirely. A `.gsim/runs/` directory is the
 * extension's, but "mine" is not a licence to delete a file whose name it does not recognise.
 */
export function runsToPrune(entries: readonly string[], keep: number): PruneDecision {
  const runs = entries.filter((name) => RUN_ID.test(name)).sort();
  if (keep <= 0 || runs.length <= keep) {
    return { remove: [], keep: [...runs].reverse() };
  }
  const cut = runs.length - keep;
  return { remove: runs.slice(0, cut), keep: runs.slice(cut).reverse() };
}

/** One line for the Output channel, or nothing when nothing was removed. */
export function describePrune(decision: PruneDecision, keep: number): string | undefined {
  if (decision.remove.length === 0) return undefined;
  const n = decision.remove.length;
  return (
    `removed ${n} old run${n === 1 ? "" : "s"} from .gsim/runs/, keeping the newest ${keep} ` +
    `(omniSchematics.keepRuns). Oldest removed: ${decision.remove[0]}`
  );
}

/**
 * Show what a run *found* in the Problems panel.
 *
 * The engine reports a rating exceeded, a dead time too short, a volt-second
 * balance drifting, as one record per line beside the waveform. Until #182
 * nothing read that file; until #159 nothing asked the solver to write it at
 * all, so every finding of every run was discarded into a temporary directory
 * that went away with the run (#68).
 *
 * These are not compile failures and not solver failures — a run that reports
 * them usually exits 0 — so they are their own producer here, namespaced the
 * way `compiler-notes.ts` and `port-validation.ts` are: publishing replaces
 * only this module's entries and leaves a compile's notes and a run's
 * validation errors alone.
 */

import type { RunEventSummary } from "@gensim/webview-protocol";

import { useIpcStore } from "../store";

/** Problems this module owns; everything else in the panel is left alone. */
const OWNED = /^run-event:/;

type Severity = "error" | "warning" | "info";

/**
 * The engine's severities onto the panel's three.
 *
 * `fatal` has nowhere else to go: the panel has no fifth level, and showing a
 * fatal as a warning would be the one mistranslation that matters.
 */
function severityFor(raw: string): Severity {
  return raw === "error" || raw === "fatal" ? "error" : raw === "warning" ? "warning" : "info";
}

/** One line, naming the rule, what it watched, and by how much it was missed. */
export function describeRunEvent(event: RunEventSummary): string {
  const unit = event.unit ? ` ${event.unit}` : "";
  const where = event.target ? ` on ${event.target}` : "";
  const why = event.detail ? ` — ${event.detail}` : "";
  return (
    `${event.rule}${where}: ${event.value}${unit} against a limit of ${event.limit}${unit} ` +
    `at t = ${event.time} s${why}`
  );
}

export function runEventProblems(
  events: readonly RunEventSummary[],
  options: { total?: number } = {},
): Array<{ id: string; severity: Severity; message: string }> {
  const problems = events.map((event, index) => ({
    id: `run-event:${index}`,
    severity: severityFor(event.severity),
    message: describeRunEvent(event),
  }));
  const total = options.total ?? events.length;
  if (total > events.length) {
    // A truncated list presented as complete is worse than a short one, which
    // is the same reason `event-log.ts` counts its unreadable lines rather
    // than dropping them.
    problems.push({
      id: "run-event:more",
      severity: "info",
      message: `and ${total - events.length} more event(s) — see the Output panel and the run's events.jsonl`,
    });
  }
  return problems;
}

/**
 * Replace this module's entries with `events`.
 *
 * Called on every finished run, including one that found nothing — that is
 * what clears the previous run's findings, so a rating exceeded never outlives
 * the edit that fixed it.
 */
export function publishRunEvents(
  events: readonly RunEventSummary[],
  options: { total?: number } = {},
): void {
  const ipc = useIpcStore.getState();
  const others = ipc.problems.filter((problem) => !OWNED.test(problem.id));
  const mine = runEventProblems(events, options);
  if (others.length === ipc.problems.length && mine.length === 0) return;
  ipc.setProblems([...others, ...mine]);
}

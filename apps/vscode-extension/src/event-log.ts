/**
 * The engine's rule-event stream, read back from the JSONL file it writes.
 *
 * Ported from `simulator/postprocess/event_log.py`, which is deleted (#162),
 * so this is the reader. `general-simulator` reports what a run *found* -- a rating
 * exceeded, a dead time too short, a volt-second balance drifting -- as one
 * JSON object per line beside the waveform, and the record shapes are its own
 * `book/dev-guide/src/output-contract.md` §L3.
 *
 * Two decisions from that contract are load-bearing here, and are why this is
 * a module rather than three lines in the runner:
 *
 * **Discriminate on `record`, never on which fields are present.** Every line
 * carries `"record": "event"` or `"record": "summary"` as its first field
 * precisely so a reader does not have to guess from a missing `duration`.
 *
 * **`time` is not `stepTime`.** `time` is interpolated to where the quantity
 * actually crossed the limit; `stepTime` is the solver's own step boundary. A
 * displayer puts its marker at `time` and seeks to `step`. Both travel so the
 * consumer never re-derives either.
 *
 * A malformed line is counted and skipped rather than thrown: a diagnostic
 * channel must not be able to fail a run that otherwise succeeded.
 */

/** Severities weakest first -- the engine's own `gsim_rules::Severity` order. */
export const SEVERITY_ORDER = ["info", "warning", "error", "fatal"] as const;

export type Severity = (typeof SEVERITY_ORDER)[number];

/** One `"record": "event"` line: an edge of a violation, or an instant finding. */
export interface RuleEvent {
  rule: string;
  target: string;
  /** `"enter" | "leave" | "instant"`, as the engine spelled it. */
  kind: string;
  severity: string;
  /** What was *done*, which is not always what the rule asked for. */
  action: string;
  /** Interpolated crossing time — where a marker goes. */
  time: number;
  /** The solver step it was noticed in — where a seek goes. */
  step: number;
  /** That step's own boundary time, before interpolation. */
  stepTime: number;
  value: number;
  limit: number;
  unit: string;
  /** On a `leave` only: the interval that just ended. */
  duration: number | null;
  peak: number | null;
  peakTime: number | null;
  /** The run ended with the condition still true, so `duration` is a lower bound. */
  truncated: boolean;
  /** Which components are responsible, when a rule spans several. */
  detail: string;
}

/**
 * One `"record": "summary"` line: how a rule fared over the whole run.
 *
 * `entries === 0` is not "passed". `missingSamples` above zero means the rule
 * was partly or wholly blind, and `filtered` above zero means a hold time is
 * hiding something. The contract is explicit that a quiet rule, a blind rule
 * and a suppressed rule are three different states, so all three counts
 * travel.
 */
export interface RuleSummary {
  rule: string;
  target: string;
  entries: number;
  filtered: number;
  suppressed: number;
  instants: number;
  missingSamples: number;
  totalTime: number;
  worstValue: number | null;
  worstTime: number | null;
  shortestDeadtime: number | null;
  severity: string;
}

/** Everything one run reported, in the order the engine wrote it. */
export interface EventLog {
  events: RuleEvent[];
  summaries: RuleSummary[];
  /**
   * Lines that could not be read. A count rather than a silent drop, so a
   * consumer can say "3 records were unreadable" instead of presenting a short
   * list as complete.
   */
  unreadableLines: number;
}

export const emptyEventLog = (): EventLog => ({
  events: [],
  summaries: [],
  unreadableLines: 0,
});

export const isEmpty = (log: EventLog): boolean =>
  log.events.length === 0 && log.summaries.length === 0;

/** The highest severity any event reached, or null when nothing was reported. */
export function worstSeverity(log: EventLog): Severity | null {
  let worst = -1;
  for (const event of log.events) {
    const rank = (SEVERITY_ORDER as readonly string[]).indexOf(event.severity);
    if (rank > worst) {
      worst = rank;
    }
  }
  return worst < 0 ? null : (SEVERITY_ORDER[worst] as Severity);
}

/**
 * Python's truthiness, for the types JSON can carry.
 *
 * `truncated` is read as `bool(record.get("truncated", False))` on the Python
 * side, so a non-empty string is true there. JavaScript agrees for null,
 * booleans, numbers and strings — and disagrees for containers, where `[]` and
 * `{}` are truthy in JS and falsy in Python. Spelling it out keeps the port
 * exact on a field the contract says is a bool but the reader is deliberately
 * lenient about.
 */
function pythonTruthy(raw: unknown): boolean {
  if (raw === null || raw === undefined) {
    return false;
  }
  if (typeof raw === "boolean") {
    return raw;
  }
  if (typeof raw === "number") {
    return raw !== 0;
  }
  if (typeof raw === "string") {
    return raw.length > 0;
  }
  if (Array.isArray(raw)) {
    return raw.length > 0;
  }
  if (typeof raw === "object") {
    return Object.keys(raw as object).length > 0;
  }
  return Boolean(raw);
}

/**
 * A JSON value as a number, or `fallback`.
 *
 * Lenient on purpose: a record whose `value` arrived as a string is still a
 * record worth showing, and a reader of a diagnostic stream that throws on one
 * odd field is worse than one that carries a default. A boolean is rejected
 * rather than coerced, because Python's `float(True)` is 1.0 and silently
 * turning `true` into a measured 1 would be worse than a default.
 */
function asNumber(raw: unknown, fallback = 0): number {
  if (typeof raw === "boolean") {
    return fallback;
  }
  if (typeof raw === "number") {
    return Number.isNaN(raw) ? fallback : raw;
  }
  if (typeof raw === "string") {
    // `Number("")` is 0 and `float("")` raises, so empty must fall back.
    if (raw.trim() === "") {
      return fallback;
    }
    const parsed = Number(raw);
    return Number.isNaN(parsed) ? fallback : parsed;
  }
  return fallback;
}

/**
 * Like {@link asNumber}, but null means the field was absent — which is
 * information.
 *
 * A `duration` of null is "this is an enter, the interval is not over"; a
 * `duration` of 0 is a measured zero. Collapsing the two loses a distinction
 * the contract draws.
 */
function asOptionalNumber(raw: unknown): number | null {
  if (raw === null || raw === undefined || typeof raw === "boolean") {
    return null;
  }
  if (typeof raw === "number") {
    return Number.isNaN(raw) ? null : raw;
  }
  if (typeof raw === "string") {
    if (raw.trim() === "") {
      return null;
    }
    const parsed = Number(raw);
    return Number.isNaN(parsed) ? null : parsed;
  }
  return null;
}

/** `int(float(raw))`: parse as a number, then truncate toward zero. */
function asInt(raw: unknown, fallback = 0): number {
  const value = asNumber(raw, Number.NaN);
  return Number.isNaN(value) ? fallback : Math.trunc(value);
}

const asText = (raw: unknown, fallback = ""): string =>
  raw === undefined || raw === null ? fallback : String(raw);

export interface ParseOptions {
  /** Named in warnings, so a reader can say which file a bad line was in. */
  source?: string;
  onWarning?: (message: string) => void;
}

/**
 * Parses the JSONL body of an event log.
 *
 * An unknown `record` value is skipped exactly as a malformed line is: a later
 * engine may add a third shape, and a reader from this version must not fail
 * on it.
 */
export function parseEventLogText(text: string, options: ParseOptions = {}): EventLog {
  const source = options.source ?? "<text>";
  const warn = options.onWarning ?? (() => {});
  const log = emptyEventLog();

  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i += 1) {
    const line = (lines[i] as string).trim();
    const number = i + 1;
    if (line === "") {
      continue;
    }

    let record: unknown;
    try {
      record = JSON.parse(line);
    } catch {
      log.unreadableLines += 1;
      warn(`${source}:${number} is not JSON, skipped: ${line.slice(0, 120)}`);
      continue;
    }
    // An array is JSON and is not a record. Checked before any field access so
    // that `["record"]` cannot be mistaken for one.
    if (typeof record !== "object" || record === null || Array.isArray(record)) {
      log.unreadableLines += 1;
      warn(`${source}:${number} is not a JSON object, skipped`);
      continue;
    }
    const fields = record as Record<string, unknown>;

    switch (fields.record) {
      case "event":
        log.events.push({
          rule: asText(fields.rule),
          target: asText(fields.target),
          kind: asText(fields.kind),
          severity: asText(fields.severity),
          action: asText(fields.action),
          time: asNumber(fields.time),
          step: asInt(fields.step),
          stepTime: asNumber(fields.step_time),
          value: asNumber(fields.value),
          limit: asNumber(fields.limit),
          unit: asText(fields.unit),
          duration: asOptionalNumber(fields.duration),
          peak: asOptionalNumber(fields.peak),
          peakTime: asOptionalNumber(fields.peak_time),
          truncated: pythonTruthy(fields.truncated),
          detail: asText(fields.detail),
        });
        break;
      case "summary":
        log.summaries.push({
          rule: asText(fields.rule),
          target: asText(fields.target),
          entries: asInt(fields.entries),
          filtered: asInt(fields.filtered),
          suppressed: asInt(fields.suppressed),
          instants: asInt(fields.instants),
          missingSamples: asInt(fields.missing_samples),
          totalTime: asNumber(fields.total_time),
          worstValue: asOptionalNumber(fields.worst_value),
          worstTime: asOptionalNumber(fields.worst_time),
          shortestDeadtime: asOptionalNumber(fields.shortest_deadtime),
          severity: asText(fields.severity),
        });
        break;
      default:
        log.unreadableLines += 1;
        warn(
          `${source}:${number} has record=${JSON.stringify(fields.record)}, which this reader does not know; skipped`,
        );
    }
  }
  return log;
}

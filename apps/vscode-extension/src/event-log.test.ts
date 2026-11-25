import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

import {
  SEVERITY_ORDER,
  emptyEventLog,
  isEmpty,
  parseEventLogText,
  worstSeverity,
} from "./event-log";

/**
 * The fixture is the Python reader's own output, captured by running
 * `simulator.postprocess.event_log.parse_event_log_text` on each body.
 *
 * These are a diagnostic channel's contents: a rating exceeded, a dead time
 * too short. If the port disagrees with the Python about one of them, a finding
 * a user has been shown changes meaning or disappears, which is the one kind of
 * difference that must not pass quietly.
 */
interface ParityCase {
  text: string;
  expected: {
    events: Record<string, unknown>[];
    summaries: Record<string, unknown>[];
    unreadableLines: number;
    worstSeverity: string | null;
    isEmpty: boolean;
  };
}

const fixture: Record<string, ParityCase> = JSON.parse(
  fs.readFileSync(path.join(__dirname, "__fixtures__", "event-log-parity.json"), "utf8"),
);

describe("parseEventLogText matches the Python it replaces", () => {
  /**
   * The one place this port deliberately disagrees, applied to the fixture so
   * that the fixture stays a verbatim record of what Python produced.
   *
   * Python reads a text field as `str(record.get("unit", ""))`. When the key is
   * *present* and holds JSON `null` the default never applies, so `str(None)`
   * yields the literal three-character string `"None"` -- and a measurement
   * panel then shows a quantity whose unit is "None". That is a bug, not a
   * contract, and porting it forward would put it in new code on purpose. An
   * explicit null means "no unit", so this port reads it as empty.
   *
   * Narrowed to exactly the fields and the value it affects, so that any other
   * disagreement still fails.
   */
  const withoutTheKnownDivergence = (records: Record<string, unknown>[]) =>
    records.map((record) => {
      const fixed = { ...record };
      for (const field of ["unit", "detail", "target", "kind", "action", "severity", "rule"]) {
        if (fixed[field] === "None") {
          fixed[field] = "";
        }
      }
      return fixed;
    });

  for (const [name, c] of Object.entries(fixture)) {
    it(name, () => {
      const log = parseEventLogText(c.text, { source: "fixture" });
      expect(log.events).toEqual(withoutTheKnownDivergence(c.expected.events));
      expect(log.summaries).toEqual(withoutTheKnownDivergence(c.expected.summaries));
      expect(log.unreadableLines).toBe(c.expected.unreadableLines);
      expect(worstSeverity(log)).toBe(c.expected.worstSeverity);
      expect(isEmpty(log)).toBe(c.expected.isEmpty);
    });
  }

  it("covers every case the fixture holds", () => {
    expect(Object.keys(fixture).sort()).toEqual([
      "a_normal_run",
      "empty",
      "lines_that_cannot_be_read",
      "odd_field_types",
      "three_kinds_of_quiet",
      "worst_severity_picks_the_highest",
    ]);
  });
});

describe("the contract's load-bearing distinctions", () => {
  it("discriminates on `record`, not on which fields are present", () => {
    // A line with every field of an event but no `record` is not an event.
    // The contract puts `record` first precisely so a reader never guesses
    // from a missing `duration`.
    const log = parseEventLogText(
      JSON.stringify({
        rule: "i_max",
        target: "D1",
        kind: "enter",
        severity: "error",
        time: 1,
        step: 1,
      }),
    );
    expect(log.events).toEqual([]);
    expect(log.unreadableLines).toBe(1);
  });

  it("keeps `time` and `stepTime` apart", () => {
    // `time` is interpolated to the crossing; `stepTime` is the solver's step
    // boundary. A displayer marks at one and seeks at the other, so collapsing
    // them would put every marker on a step edge.
    const log = parseEventLogText(
      JSON.stringify({
        record: "event",
        rule: "r",
        target: "t",
        kind: "enter",
        severity: "warning",
        action: "report",
        time: 1.5e-6,
        step: 42,
        step_time: 1.6e-6,
        value: 1,
        limit: 0,
      }),
    );
    expect(log.events[0]?.time).toBe(1.5e-6);
    expect(log.events[0]?.stepTime).toBe(1.6e-6);
    expect(log.events[0]?.step).toBe(42);
  });

  it("tells an absent duration from a measured zero", () => {
    // null is "this is an enter, the interval is not over". 0 is a measured
    // zero. One distinction, two very different findings.
    const absent = parseEventLogText(
      JSON.stringify({ record: "event", rule: "r", target: "t", kind: "enter" }),
    );
    const zero = parseEventLogText(
      JSON.stringify({ record: "event", rule: "r", target: "t", kind: "leave", duration: 0 }),
    );
    expect(absent.events[0]?.duration).toBeNull();
    expect(zero.events[0]?.duration).toBe(0);
  });

  it("skips an unknown record shape instead of failing on it", () => {
    // A later engine may add a third shape, and a reader from this version
    // must not refuse the whole file over it.
    const log = parseEventLogText(
      [
        JSON.stringify({ record: "telemetry", what: "a future shape" }),
        JSON.stringify({ record: "summary", rule: "r", entries: 1 }),
      ].join("\n"),
    );
    expect(log.summaries).toHaveLength(1);
    expect(log.unreadableLines).toBe(1);
  });

  it("counts unreadable lines rather than dropping them silently", () => {
    // So a consumer can say "3 records were unreadable" instead of presenting
    // a short list as complete.
    const warnings: string[] = [];
    const log = parseEventLogText("{oops\nalso not json\n[]", {
      source: "run.events.jsonl",
      onWarning: (m) => warnings.push(m),
    });
    expect(log.unreadableLines).toBe(3);
    expect(warnings).toHaveLength(3);
    expect(warnings[0]).toContain("run.events.jsonl:1");
  });
});

describe('a null text field means no value, not the word "None"', () => {
  it("reads an explicit null unit as empty", () => {
    // The Python this replaces produced the literal string "None" here, via
    // `str(record.get("unit", ""))` on a key that is present and null -- so
    // the default never applied. A unit of "None" is not a unit, and the
    // measurement panel would have shown it. Deliberately not ported.
    const log = parseEventLogText(
      JSON.stringify({
        record: "event",
        rule: "r",
        target: "t",
        kind: "enter",
        unit: null,
        detail: null,
      }),
    );
    expect(log.events[0]?.unit).toBe("");
    expect(log.events[0]?.detail).toBe("");
  });

  it("still carries a unit that is really there", () => {
    const log = parseEventLogText(
      JSON.stringify({ record: "event", rule: "r", unit: "A", detail: "D1,L1" }),
    );
    expect(log.events[0]?.unit).toBe("A");
    expect(log.events[0]?.detail).toBe("D1,L1");
  });
});

describe("Python truthiness on `truncated`", () => {
  // The Python reads it as `bool(record.get("truncated", False))`, and the two
  // languages disagree about containers: `[]` and `{}` are truthy in
  // JavaScript and falsy in Python. A `truncated` flag flipped the wrong way
  // turns a lower-bound duration into a measured one.
  const truncatedFor = (value: unknown) =>
    parseEventLogText(
      JSON.stringify({ record: "event", rule: "r", target: "t", kind: "leave", truncated: value }),
    ).events[0]?.truncated;

  it("agrees with Python where the languages agree", () => {
    expect(truncatedFor(true)).toBe(true);
    expect(truncatedFor(false)).toBe(false);
    expect(truncatedFor("no")).toBe(true);
    expect(truncatedFor("")).toBe(false);
    expect(truncatedFor(1)).toBe(true);
    expect(truncatedFor(0)).toBe(false);
    expect(truncatedFor(null)).toBe(false);
  });

  it("follows Python where they disagree", () => {
    expect(truncatedFor([])).toBe(false);
    expect(truncatedFor({})).toBe(false);
    expect(truncatedFor([0])).toBe(true);
    expect(truncatedFor({ a: 1 })).toBe(true);
  });

  it("is false when the field is absent", () => {
    expect(truncatedFor(undefined)).toBe(false);
  });
});

describe("lenient numbers", () => {
  const eventWith = (fields: Record<string, unknown>) =>
    parseEventLogText(JSON.stringify({ record: "event", rule: "r", ...fields })).events[0];

  it("reads a number that arrived as a string", () => {
    // A record whose `value` came through as text is still a record worth
    // showing.
    expect(eventWith({ value: "1e3" })?.value).toBe(1000);
  });

  it("falls back rather than coercing a boolean", () => {
    // Python's `float(True)` is 1.0, and silently turning `true` into a
    // measured 1 A would be worse than a default.
    expect(eventWith({ value: true })?.value).toBe(0);
    expect(eventWith({ duration: true })?.duration).toBeNull();
  });

  it("falls back on text that is not a number, and on a container", () => {
    expect(eventWith({ limit: "not a number" })?.limit).toBe(0);
    expect(eventWith({ limit: [1] })?.limit).toBe(0);
  });

  it("truncates a step toward zero, as `int(float(...))` does", () => {
    expect(eventWith({ step: "3.7" })?.step).toBe(3);
    expect(eventWith({ step: -3.7 })?.step).toBe(-3);
  });
});

describe("worstSeverity", () => {
  it("is null when nothing was reported", () => {
    expect(worstSeverity(emptyEventLog())).toBeNull();
  });

  it("ignores a severity the engine's own order does not contain", () => {
    // Ranking an unknown string would put it somewhere arbitrary; the order
    // is `gsim_rules::Severity`'s, so anything outside it is not comparable.
    const log = parseEventLogText(
      [
        JSON.stringify({ record: "event", rule: "a", severity: "nonsense" }),
        JSON.stringify({ record: "event", rule: "b", severity: "info" }),
      ].join("\n"),
    );
    expect(worstSeverity(log)).toBe("info");
  });

  it("orders the engine's severities weakest first", () => {
    expect([...SEVERITY_ORDER]).toEqual(["info", "warning", "error", "fatal"]);
  });
});

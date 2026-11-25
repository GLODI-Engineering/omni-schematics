/**
 * #159 / #68: what a run *found*, in the Problems panel.
 *
 * The invariant that matters is the one `compiler-notes.test.ts` holds for its
 * own producer: publishing replaces this module's entries and leaves everyone
 * else's alone. Two producers that each own the whole list silently delete
 * each other's findings, and nothing about the panel shows which one did.
 */
import { beforeEach, describe, expect, it } from "vitest";

import { useIpcStore } from "../store";
import { describeRunEvent, publishRunEvents, runEventProblems } from "./run-events";

const event = (over: Partial<Parameters<typeof describeRunEvent>[0]> = {}) => ({
  rule: "i_max",
  target: "D1",
  severity: "warning",
  time: 1.5e-6,
  value: 12.3,
  limit: 10,
  unit: "A",
  detail: "",
  ...over,
});

beforeEach(() => {
  useIpcStore.setState({ problems: [] });
});

describe("runEventProblems", () => {
  it("maps the engine's severities onto the panel's three", () => {
    // `fatal` has nowhere else to go, and showing one as a warning would be
    // the one mistranslation that matters.
    const problems = runEventProblems([
      event({ severity: "info" }),
      event({ severity: "warning" }),
      event({ severity: "error" }),
      event({ severity: "fatal" }),
    ]);
    expect(problems.map((problem) => problem.severity)).toEqual([
      "info",
      "warning",
      "error",
      "error",
    ]);
  });

  it("says how many it is not showing, rather than looking complete", () => {
    const problems = runEventProblems([event()], { total: 250 });
    expect(problems).toHaveLength(2);
    expect(problems[1]?.message).toMatch(/249 more event/);
  });

  it("adds nothing when it is showing everything", () => {
    expect(runEventProblems([event()], { total: 1 })).toHaveLength(1);
  });
});

describe("describeRunEvent", () => {
  it("names the rule, the target, both numbers and the unit", () => {
    expect(describeRunEvent(event({ detail: "D1,L1" }))).toBe(
      "i_max on D1: 12.3 A against a limit of 10 A at t = 0.0000015 s — D1,L1",
    );
  });

  it("leaves out what the event does not carry", () => {
    expect(describeRunEvent(event({ target: "", unit: "", detail: "" }))).toBe(
      "i_max: 12.3 against a limit of 10 at t = 0.0000015 s",
    );
  });
});

describe("publishRunEvents", () => {
  it("leaves another producer's problems alone", () => {
    useIpcStore.setState({
      problems: [
        { id: "compiler-note:0", severity: "info", message: "added a DC reference to n3" },
        { id: "port-validation:x", severity: "error", message: "no such port" },
      ],
    });
    publishRunEvents([event({ severity: "error" })]);
    const ids = useIpcStore.getState().problems.map((problem) => problem.id);
    expect(ids).toEqual(["compiler-note:0", "port-validation:x", "run-event:0"]);
  });

  it("clears the previous run's findings", () => {
    publishRunEvents([event(), event()]);
    expect(useIpcStore.getState().problems).toHaveLength(2);
    // What stops a rating exceeded outliving the edit that fixed it.
    publishRunEvents([]);
    expect(useIpcStore.getState().problems).toHaveLength(0);
  });

  it("writes nothing at all for a clean sheet and a quiet run", () => {
    let writes = 0;
    const unsubscribe = useIpcStore.subscribe(() => {
      writes += 1;
    });
    publishRunEvents([]);
    unsubscribe();
    expect(writes).toBe(0);
  });
});

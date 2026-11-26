import { describe, expect, it } from "vitest";

import { describePrune, runsToPrune } from "./run-retention";

const run = (stamp: string) => `run-2026-11-26T${stamp}Z`;
const a = run("01-00-00-000");
const b = run("02-00-00-000");
const c = run("03-00-00-000");
const d = run("04-00-00-000");

describe("#186: old runs stop accumulating", () => {
  it("removes the oldest, keeping the newest N", () => {
    const decision = runsToPrune([c, a, d, b], 2);
    expect(decision.remove).toEqual([a, b]);
    expect(decision.keep).toEqual([d, c]);
  });

  it("removes oldest first, so a partial failure drops the least useful", () => {
    expect(runsToPrune([d, c, b, a], 1).remove).toEqual([a, b, c]);
  });

  it("never removes the run just written, which is always the newest", () => {
    const decision = runsToPrune([a, b, c, d], 1);
    expect(decision.remove).not.toContain(d);
    expect(decision.keep).toEqual([d]);
  });

  it("keeps everything at or under the limit", () => {
    expect(runsToPrune([a, b], 2).remove).toEqual([]);
    expect(runsToPrune([a], 5).remove).toEqual([]);
    expect(runsToPrune([], 5).remove).toEqual([]);
  });

  it("treats zero and negative as keep everything, not as delete everything", () => {
    // A user setting 0 is asking for the old behaviour. Reading it as "none may remain" would
    // destroy every result they have on the next run, which is the opposite of what they asked.
    expect(runsToPrune([a, b, c], 0).remove).toEqual([]);
    expect(runsToPrune([a, b, c], -1).remove).toEqual([]);
  });

  it("leaves anything that is not a run directory alone", () => {
    // `.gsim/runs/` is the extension's, but that is not a licence to delete a name it does not
    // recognise -- a user's own notes beside their results, for instance.
    const decision = runsToPrune([a, b, c, "notes.md", "keep-this", ".DS_Store"], 1);
    expect(decision.remove).toEqual([a, b]);
    expect(decision.remove).not.toContain("notes.md");
    expect(decision.keep).not.toContain("keep-this");
  });

  it("says what it removed, and nothing when it removed nothing", () => {
    expect(describePrune(runsToPrune([a, b, c], 1), 1)).toContain("removed 2 old runs");
    expect(describePrune(runsToPrune([a, b, c], 1), 1)).toContain(a);
    expect(describePrune(runsToPrune([a], 5), 5)).toBeUndefined();
  });
});

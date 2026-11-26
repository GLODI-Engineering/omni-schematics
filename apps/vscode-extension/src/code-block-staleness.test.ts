/**
 * #235 — a library older than its source must not run quietly.
 *
 * The filesystem is injected, so these are assertions about the *verdict* rather than about
 * `fs.statSync`. `run-simulation.test.ts` carries the end-to-end arm: a real compiled library, a
 * real source touched after it, and a real run refused.
 */
import { describe, expect, it } from "vitest";

import {
  type Clockwork,
  type CodeBlockForCheck,
  checkCodeBlockFreshness,
} from "./code-block-staleness";

/** A filesystem of `path -> mtime`, with everything else absent. */
function world(files: Record<string, number>): Clockwork {
  return {
    modifiedAt: (absolute) => (absolute in files ? (files[absolute] as number) : null),
    // The tests write absolute-looking paths already, so resolution is identity here; the real
    // one resolves against the directory the solver runs in.
    resolve: (relative) => relative,
  };
}

const cBlock = (over: Partial<CodeBlockForCheck> = {}): CodeBlockForCheck => ({
  blockId: "G1",
  language: "c",
  artifact: "/sheet/libctrl.so",
  sourceCandidates: ["/sheet/blocks/ctrl.c", "/sheet/ctrl.c"],
  inferredSource: true,
  ...over,
});

describe("checkCodeBlockFreshness", () => {
  it("blocks a run whose source is newer than its library", () => {
    const verdict = checkCodeBlockFreshness(
      [cBlock()],
      world({ "/sheet/libctrl.so": 1_000, "/sheet/blocks/ctrl.c": 2_000 }),
      "refuse",
    );
    expect(verdict.blocking).toHaveLength(1);
    const finding = verdict.blocking[0];
    expect(finding?.kind).toBe("stale");
    // The block, the source and the library -- "a code block is stale" does not say which, and
    // a sheet has several.
    expect(finding?.message).toContain("G1");
    expect(finding?.message).toContain("/sheet/blocks/ctrl.c");
    expect(finding?.message).toContain("/sheet/libctrl.so");
    // And what to do about it.
    expect(finding?.message).toMatch(/rebuild/i);
  });

  it("lets a library newer than its source through, silently", () => {
    const verdict = checkCodeBlockFreshness(
      [cBlock()],
      world({ "/sheet/libctrl.so": 2_000, "/sheet/blocks/ctrl.c": 1_000 }),
      "refuse",
    );
    expect(verdict.blocking).toEqual([]);
    expect(verdict.advisory).toEqual([]);
  });

  it("takes the first candidate that exists, not the first candidate", () => {
    // `blocks/ctrl.c` is the better candidate and is absent; the sheet's own `ctrl.c` is there.
    const verdict = checkCodeBlockFreshness(
      [cBlock()],
      world({ "/sheet/libctrl.so": 1_000, "/sheet/ctrl.c": 2_000 }),
      "refuse",
    );
    expect(verdict.blocking[0]?.source).toBe("/sheet/ctrl.c");
  });

  it("says it could not find a source rather than implying the library is fresh", () => {
    const verdict = checkCodeBlockFreshness(
      [cBlock()],
      world({ "/sheet/libctrl.so": 1_000 }),
      "refuse",
    );
    expect(verdict.blocking).toEqual([]);
    expect(verdict.advisory).toHaveLength(1);
    expect(verdict.advisory[0]?.kind).toBe("no-source");
    expect(verdict.advisory[0]?.message).toMatch(/could not find the source/i);
    // And that the candidate list was a guess, because it is: #222 exists so that the document
    // can state the link instead.
    expect(verdict.advisory[0]?.message).toMatch(/convention/i);
  });

  it("does not claim a guess when the document stated the link", () => {
    const verdict = checkCodeBlockFreshness(
      [cBlock({ inferredSource: false })],
      world({ "/sheet/libctrl.so": 1_000 }),
      "refuse",
    );
    expect(verdict.advisory[0]?.message).not.toMatch(/convention/i);
  });

  it("mentions a library that is not there at all, without refusing for it", () => {
    // The engine refuses this itself, with the loader's own reason. Saying it here adds the one
    // thing the loader cannot: which source it should have been built from.
    const verdict = checkCodeBlockFreshness(
      [cBlock()],
      world({ "/sheet/blocks/ctrl.c": 2_000 }),
      "refuse",
    );
    expect(verdict.blocking).toEqual([]);
    expect(verdict.advisory[0]?.kind).toBe("no-artifact");
    expect(verdict.advisory[0]?.message).toContain("/sheet/blocks/ctrl.c");
  });

  it("warns instead of blocking when asked to", () => {
    const verdict = checkCodeBlockFreshness(
      [cBlock()],
      world({ "/sheet/libctrl.so": 1_000, "/sheet/blocks/ctrl.c": 2_000 }),
      "warn",
    );
    expect(verdict.blocking).toEqual([]);
    expect(verdict.advisory[0]?.kind).toBe("stale");
  });

  it("says nothing at all when asked to ignore", () => {
    const verdict = checkCodeBlockFreshness(
      [cBlock()],
      world({ "/sheet/libctrl.so": 1_000, "/sheet/blocks/ctrl.c": 2_000 }),
      "ignore",
    );
    expect(verdict).toEqual({ blocking: [], advisory: [] });
  });

  it("ignores the four languages whose parameter is the file the engine reads", () => {
    // A Python or Octave block names the source itself, so there is no second artifact for the
    // source to get ahead of -- editing the `.py` and pressing Run already runs the edit.
    for (const language of ["python", "octave"] as const) {
      const verdict = checkCodeBlockFreshness(
        [cBlock({ language, artifact: undefined })],
        world({ "/sheet/blocks/ctrl.c": 2_000 }),
        "refuse",
      );
      expect(verdict, language).toEqual({ blocking: [], advisory: [] });
    }
  });

  it("ignores a cscript block whose library is not set yet", () => {
    // What a freshly dropped block carries before the user fills it in.
    const verdict = checkCodeBlockFreshness(
      [cBlock({ artifact: "" })],
      world({ "/sheet/blocks/ctrl.c": 2_000 }),
      "refuse",
    );
    expect(verdict).toEqual({ blocking: [], advisory: [] });
  });

  it("reports every stale block, not the first", () => {
    const verdict = checkCodeBlockFreshness(
      [
        cBlock(),
        cBlock({
          blockId: "G2",
          artifact: "/sheet/libmod.so",
          sourceCandidates: ["/sheet/blocks/mod.c"],
        }),
      ],
      world({
        "/sheet/libctrl.so": 1_000,
        "/sheet/blocks/ctrl.c": 2_000,
        "/sheet/libmod.so": 1_000,
        "/sheet/blocks/mod.c": 2_000,
      }),
      "refuse",
    );
    expect(verdict.blocking.map((finding) => finding.blockId)).toEqual(["G1", "G2"]);
  });

  it("treats an equal timestamp as fresh", () => {
    // A build that finishes in the same millisecond as the edit is a build *of* the edit, and
    // refusing it would make a fast rebuild loop unusable.
    const verdict = checkCodeBlockFreshness(
      [cBlock()],
      world({ "/sheet/libctrl.so": 2_000, "/sheet/blocks/ctrl.c": 2_000 }),
      "refuse",
    );
    expect(verdict).toEqual({ blocking: [], advisory: [] });
  });
});

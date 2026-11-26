/**
 * #235 — what the run request tells the host about the sheet's code blocks.
 *
 * The host cannot work this out for itself: a `cscript` block's parameter is `lib`, a compiled
 * library, and the source is not named in the document at all. Only this side holds both the
 * block and this editor's convention for finding its source.
 */
import { describe, expect, it } from "vitest";

import { type BlockLike, runCodeBlocksFor } from "./run-code-blocks";

const block = (over: Partial<BlockLike>): BlockLike => ({
  id: "G1",
  type: "extensibility.cscript",
  params: {},
  ...over,
});

describe("runCodeBlocksFor", () => {
  it("says nothing about a sheet of passives", () => {
    expect(
      runCodeBlocksFor([
        block({ id: "R1", type: "physical-electrical.passive.resistor" }),
        block({ id: "C1", type: "physical-electrical.passive.capacitor" }),
      ]),
    ).toEqual([]);
  });

  it("carries a cscript block's library and the candidates for its source", () => {
    const [entry] = runCodeBlocksFor([block({ params: { lib: "build/ctrl.so" } })]);
    expect(entry?.blockId).toBe("G1");
    expect(entry?.language).toBe("c");
    expect(entry?.artifact).toBe("build/ctrl.so");
    // Best first, and the host takes the first that exists.
    expect(entry?.sourceCandidates[0]).toBe("blocks/ctrl.c");
    expect(entry?.sourceCandidates).toContain("build/ctrl.c");
    // The distinction that lets the host's message be honest: this is a convention, not
    // something the document states (#222).
    expect(entry?.inferredSource).toBe(true);
  });

  it("gives the other four no artifact, because their parameter is the source", () => {
    for (const [type, language] of [
      ["extensibility.pyblock", "python"],
      ["extensibility.pyfunc", "python"],
      ["extensibility.octfunc", "octave"],
    ] as const) {
      const [entry] = runCodeBlocksFor([
        block({ type, params: { path: "blocks/ctrl.py", function: "ctrl" } }),
      ]);
      expect(entry?.language, type).toBe(language);
      expect(entry?.artifact, type).toBeUndefined();
      expect(entry?.inferredSource, type).toBe(false);
    }
  });

  it("omits an artifact for a cscript block whose library is not set yet", () => {
    // What a freshly dropped block carries. There is nothing for a source to be newer than.
    const [entry] = runCodeBlocksFor([block({ params: { lib: "" } })]);
    expect(entry?.artifact).toBeUndefined();
  });

  it("walks into subsystems, because a block inside one compiles into the same netlist", () => {
    const entries = runCodeBlocksFor([
      block({ id: "TOP", params: { lib: "build/top.so" } }),
      {
        id: "SUB",
        type: "hierarchy.subsystem.virtual",
        params: {},
        subsystem: {
          blocks: [
            block({ id: "INNER", params: { lib: "build/inner.so" } }),
            {
              id: "SUB2",
              type: "hierarchy.subsystem.virtual",
              params: {},
              subsystem: { blocks: [block({ id: "DEEPER", params: { lib: "build/deep.so" } })] },
            },
          ],
        },
      },
    ]);
    expect(entries.map((entry) => entry.blockId)).toEqual(["TOP", "INNER", "DEEPER"]);
  });

  it("copes with a block carrying no params at all", () => {
    const entries = runCodeBlocksFor([{ id: "G1", type: "extensibility.cscript" }]);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.artifact).toBeUndefined();
  });

  it("copes with no blocks", () => {
    expect(runCodeBlocksFor(undefined)).toEqual([]);
    expect(runCodeBlocksFor([])).toEqual([]);
  });
});

/**
 * §20: a sheet says how its code blocks are built, and this editor's own validator accepts it.
 *
 * The gap these close is narrow and was real. `Model` and `Block` are
 * `additionalProperties: false`, so before §20 a document carrying `code_build`, `source` or
 * `build` was **rejected here** while `gsim-core` accepted and compiled it — the two halves of
 * one format disagreeing about what a valid document is, which is the asymmetry
 * `engine-agreement.test.ts` exists to pin down.
 *
 * What the schema deliberately leaves to a loader, because it cannot see the rest of the
 * document: whether a define's `from` names a parameter that exists (§20.4 — the refusal),
 * whether a block's `build` names a step, and whether a step's `kind` is one this version
 * implements. That last one must *parse* here, so that a reader older than the sheet does not
 * delete the user's build on save (§20.5).
 */
import { describe, expect, it } from "vitest";

import { validateGsimSchDocument } from "../generated/validators/gsim-sch.js";

function sheet(plan: unknown, blockExtras: Record<string, unknown> = {}) {
  const model: Record<string, unknown> = {
    id: "m1",
    name: "Build",
    grid: 10,
    params: [{ name: "L_f", value: 2.8e-6 }],
    blocks: [
      {
        id: "CTRL",
        type: "extensibility.cscript",
        paradigm: "signal-flow",
        domain: "signal",
        fidelity: "ideal",
        position: [100, 0],
        rotation: 0,
        mirror: "none",
        params: { lib: "runs/case3/ctrl" },
        ic: {},
        ...blockExtras,
      },
    ],
    wires: [],
    lines: [],
    nets: [],
    simulation: {},
    metadata: {},
  };
  if (plan !== undefined) model.code_build = plan;
  return { schema_version: 2, model };
}

const PLAN = {
  includes: ["code", "code/generated"],
  defines: [
    { name: "L_F", from: "L_f" },
    { name: "N_PHASES", literal: 3 },
    { name: "DEBUG_LOG", from: "debug_log", optional: true },
  ],
  libs: ["m"],
  steps: [
    {
      id: "ctrl",
      kind: "shared-library",
      lang: "c",
      sources: ["code/cscript_ctrl.c", "code/control_law.c"],
    },
  ],
};

describe("§20 code_build", () => {
  it("accepts a sheet whose plan and block say how a C block is built", () => {
    const ok = validateGsimSchDocument(
      sheet(PLAN, { source: "code/cscript_ctrl.c", build: "ctrl" }),
    );
    expect(validateGsimSchDocument.errors ?? []).toEqual([]);
    expect(ok).toBe(true);
  });

  it("still accepts a sheet with no plan, which is every document written before §20", () => {
    expect(validateGsimSchDocument(sheet(undefined))).toBe(true);
  });

  it("accepts a step kind this version does not implement, so a save cannot delete it", () => {
    const ok = validateGsimSchDocument(
      sheet({
        steps: [
          {
            id: "table",
            kind: "host-program",
            sources: ["code/gen_table.c"],
            run: { stdout: "code/generated/table.h" },
          },
        ],
      }),
    );
    expect(validateGsimSchDocument.errors ?? []).toEqual([]);
    expect(ok).toBe(true);
  });

  it("rejects a define name that could become something other than a macro name", () => {
    expect(
      validateGsimSchDocument(sheet({ defines: [{ name: "-o /tmp/x", literal: 1 }], steps: [] })),
    ).toBe(false);
  });

  // §20.2b: a table is a legitimate constant — it travels in the generated header rather than
  // on the compile line, and the author does not choose that. The shape of the value does.
  it("accepts a structured literal, and a structured parameter it can be bound to", () => {
    expect(
      validateGsimSchDocument(sheet({ defines: [{ name: "LUT", literal: [1, 2] }], steps: [] })),
    ).toBe(true);
    expect(
      validateGsimSchDocument(
        sheet({
          defines: [
            {
              name: "M",
              literal: [
                [1, 2],
                [3, 4],
              ],
            },
          ],
          steps: [],
        }),
      ),
    ).toBe(true);
    const withTable = sheet(PLAN) as {
      model: { params: { name: string; value: unknown }[] };
    };
    withTable.model.params.push({ name: "vq_table", value: [0, 0.25, 0.5, 0.75, 1] });
    expect(validateGsimSchDocument(withTable)).toBe(true);
  });

  it("rejects a literal, and a parameter, holding something with no spelling on either side", () => {
    expect(
      validateGsimSchDocument(sheet({ defines: [{ name: "X", literal: { a: 1 } }], steps: [] })),
    ).toBe(false);
    expect(
      validateGsimSchDocument(sheet({ defines: [{ name: "X", literal: [1, null] }], steps: [] })),
    ).toBe(false);
  });

  // A `CodeDefine` is closed on purpose: a misspelt `optionall: true` that round-tripped would
  // read to a human as a deliberate declaration (§20.4) while meaning nothing to any reader.
  it("rejects a define carrying a field nobody defined, rather than keeping it", () => {
    expect(
      validateGsimSchDocument(
        sheet({ defines: [{ name: "X", from: "L_f", optionall: true }], steps: [] }),
      ),
    ).toBe(false);
  });

  it("rejects a step with no id, and one with no kind", () => {
    expect(validateGsimSchDocument(sheet({ steps: [{ kind: "shared-library" }] }))).toBe(false);
    expect(validateGsimSchDocument(sheet({ steps: [{ id: "ctrl" }] }))).toBe(false);
  });

  it("rejects a lang outside c and c++", () => {
    expect(
      validateGsimSchDocument(
        sheet({ steps: [{ id: "ctrl", kind: "shared-library", lang: "rust" }] }),
      ),
    ).toBe(false);
  });

  it("rejects an empty source path, and an empty source on a block", () => {
    expect(
      validateGsimSchDocument(
        sheet({ steps: [{ id: "ctrl", kind: "shared-library", sources: [""] }] }),
      ),
    ).toBe(false);
    expect(validateGsimSchDocument(sheet(PLAN, { source: "" }))).toBe(false);
  });
});

import { describe, expect, it } from "vitest";

// The generated validator, so the document is checked against the schema
// itself rather than against this test's idea of it. If the schema gains a
// required field, this goes red here instead of in the viewer.
// @ts-expect-error -- generated JavaScript, no declarations emitted for it
import { validateGsimSimResultDocument } from "../../frontend/src/generated/validators/gsim-sim-result.js";

import { buildManifest, serializeManifest } from "./result-manifest";

const request = {
  runId: "run-1",
  analysis: "tran",
  source: "buck_converter.gsim_sch",
  samplesPath: "/work/results/run-1/data.gsim_samples",
  manifestPath: "/work/results/run-1/result.gsim_sim_result",
  sweep: { name: "t", unit: "s", domain: "time" },
  signals: [
    { name: "V(out)", unit: "V", quantity: "voltage" },
    { name: "I(L1)", unit: "A", quantity: "current" },
  ],
  created: "2026-11-25T12:00:00.000Z",
};

describe("buildManifest", () => {
  it("produces a document the schema accepts", () => {
    const manifest = buildManifest(request);
    const valid = validateGsimSimResultDocument(manifest);
    expect(validateGsimSimResultDocument.errors ?? []).toEqual([]);
    expect(valid).toBe(true);
  });

  it("points at the samples file relative to itself, so a result can be moved", () => {
    // The schema's rule, and the reason a result directory can be copied
    // whole without rewriting anything inside it.
    expect(buildManifest(request).data).toEqual({
      kind: "samples",
      path: "data.gsim_samples",
      pyramid: true,
    });
  });

  it("keeps a relative path POSIX-style even when built on Windows", () => {
    // `path.relative` yields backslashes there, and a result written on
    // Windows has to open on a machine that is not.
    const manifest = buildManifest({
      ...request,
      samplesPath: "/work/results/run-1/samples/data.gsim_samples",
    });
    expect(manifest.data.path).toBe("samples/data.gsim_samples");
    expect(manifest.data.path).not.toContain("\\\\");
  });

  it("carries the units the container has none of", () => {
    // A netlist has no units, so the solver writes none. This document is
    // where they come from, and the reader takes them from here.
    const manifest = buildManifest(request);
    expect(manifest.sweep).toEqual({ name: "t", unit: "s", domain: "time" });
    expect(manifest.signals).toEqual([
      { name: "V(out)", unit: "V", quantity: "voltage" },
      { name: "I(L1)", unit: "A", quantity: "current" },
    ]);
  });

  it("omits what it does not know rather than inventing it", () => {
    // An empty unit is honest for a netlist column; an absent `quantity` must
    // not become the string "undefined" or a guess like "voltage".
    const manifest = buildManifest({
      ...request,
      source: undefined,
      signals: [{ name: "PWM1", unit: "" }],
    });
    expect(manifest.signals[0]).toEqual({ name: "PWM1", unit: "" });
    expect("quantity" in manifest.signals[0]).toBe(false);
    expect("source" in manifest.run).toBe(false);
    expect(validateGsimSimResultDocument(manifest)).toBe(true);
  });

  it("stamps a creation time, and lets one be given", () => {
    expect(buildManifest(request).run.created).toBe("2026-11-25T12:00:00.000Z");
    const now = buildManifest({ ...request, created: undefined }).run.created;
    expect(Number.isNaN(Date.parse(now))).toBe(false);
  });
});

describe("serializeManifest", () => {
  it("is indented and newline-terminated, so it reads and diffs", () => {
    const text = serializeManifest(buildManifest(request));
    expect(text.endsWith("\n")).toBe(true);
    expect(text).toContain('\n  "schema_version": 2,');
    expect(JSON.parse(text).run.id).toBe("run-1");
  });
});

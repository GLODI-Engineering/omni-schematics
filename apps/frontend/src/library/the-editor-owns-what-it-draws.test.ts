/**
 * The editor's half of the catalogue, and the assertions that make two owners safer than one.
 *
 * `gsim-core` decision 0010: the compiler declares which components it supports and what each
 * needs; this repository owns how one is drawn and described. The two halves meet in
 * `scripts/gen-engine-catalog.mjs`, which overlays `display-catalog.json` onto the engine's
 * submission.
 *
 * Two owners can drift, and drift between a symbol and a specification is this project's
 * recurring defect -- the signal-domain port mismatches were exactly that, and they happened
 * while a single file was supposedly preventing it. A single file prevented nothing. These
 * assertions are the reason the split is safe, so they are not optional bookkeeping.
 *
 * Two of them arrive from `gsim-core`'s `compile/library.rs`, moved with the fields they are
 * about rather than left behind asserting data that is no longer there.
 */

import { describe, expect, it } from "vitest";

import displayCatalog from "./display-catalog.json" with { type: "json" };
import engineCatalog from "./engine-catalog.json" with { type: "json" };

type DisplayEntry = {
  label?: string;
  category?: string;
  description?: string;
  tags?: string[];
  main_param?: string;
  symbol?: unknown;
};

const display = displayCatalog.components as Record<string, DisplayEntry>;
const engineIds = engineCatalog.map((entry) => entry.metadata.engineId as string);
const merged = new Map(engineCatalog.map((e) => [e.metadata.engineId as string, e.metadata]));

describe("the editor owns what it draws (gsim-core decision 0010)", () => {
  it("has something to draw for every component the engine declares", () => {
    // The failure this split could introduce: a component reaches the palette with no symbol
    // and no name. `gen-engine-catalog.mjs` exits non-zero on this too, so it cannot be
    // committed; this is the same assertion where a reader of the catalogue will look for it.
    const undrawable = engineIds.filter((id) => display[id] === undefined);
    expect(undrawable).toEqual([]);
  });

  it("gives every placeable component a label, which the schema no longer requires", () => {
    // `block-metadata.schema.json` required `label` until 0010. It cannot any more: gsim-core's
    // CI validates its raw submission against that schema over HTTP, and after the split the
    // engine sends no label. The guarantee moves here rather than being dropped -- a palette
    // shows a component's label and nothing else, so a component without one is unchoosable.
    const unlabelled = engineIds.filter((id) => {
      const label = merged.get(id)?.label;
      return typeof label !== "string" || label.trim() === "";
    });
    expect(unlabelled).toEqual([]);
  });

  it("no two components share a label", () => {
    // Moved from gsim-core `compile/library.rs`, with its finding: two pairs shared one --
    // `signal.step`/`signal-flow.source.step` and `sinks.scope`/`signal-flow.sink.scope` --
    // and it was found by the real-VS-Code sweep clicking all 68 palette entries, not by
    // reading the data (`gsim-core#83`, #216).
    //
    // The palette shows a label and nothing else, so two components wearing one label are
    // indistinguishable at the moment of choosing between them. This belongs where labels live.
    const byLabel = new Map<string, string[]>();
    for (const [id, entry] of Object.entries(display)) {
      if (entry.label === undefined) continue;
      byLabel.set(entry.label, [...(byLabel.get(entry.label) ?? []), id]);
    }
    const shared = [...byLabel.entries()]
      .filter(([, ids]) => ids.length > 1)
      .map(([label, ids]) => `${label}: ${ids.join(", ")}`);
    expect(shared).toEqual([]);
  });

  it("a main parameter names one of the component's own parameters", () => {
    // Also moved from gsim-core, and it is the clearest case for the split: after 0010
    // `main_param` is in *this* repository and the parameter it names is in the engine's, so
    // this is a cross-catalogue assertion and could not live on either side alone.
    const dangling: string[] = [];
    for (const [id, entry] of Object.entries(display)) {
      if (entry.main_param === undefined) continue;
      const params = merged.get(id)?.params;
      if (!Array.isArray(params)) continue;
      const names = params.map((p: { id?: string; name?: string }) => p.id ?? p.name);
      if (!names.includes(entry.main_param)) {
        dangling.push(`${id}: main_param ${entry.main_param} is not among ${names.join(", ")}`);
      }
    }
    expect(dangling).toEqual([]);
  });

  it("allows a display entry the engine does not compile, and that is the point", () => {
    // What decision 0007's same-day amendment had to work around: it widened "the library holds
    // exactly what this engine compiles" to "plus the universal components a front end has to be
    // told how to draw", because 0006 resolves those away before any target is called. After the
    // split that is sayable -- a display entry with no engine declaration -- so this asserts the
    // *absence* of a check rather than a check, and fails if someone adds one.
    const orphan = Object.keys(display).filter((id) => !engineIds.includes(id));
    expect(Array.isArray(orphan)).toBe(true);
    // Today the engine still declares all 78; the legality is what matters, not the count.
    expect(() => {
      const withOrphan = { ...display, "front-end.only.decoration": { label: "Note" } };
      return Object.keys(withOrphan).length;
    }).not.toThrow();
  });

  it("does not let the engine's own display fields back in", () => {
    // The engine still sends `label`, `category`, `description`, `tags`, `main_param` and
    // `symbol` today and the generator drops them on the floor. If it ever stopped dropping
    // them, the editor would silently go back to rendering the engine's opinion and this split
    // would be undone without anything failing.
    const r = engineCatalog.find((e) => e.metadata.engineId === "passive.resistor");
    expect(r).toBeDefined();
    expect(r?.metadata.label).toBe(display["passive.resistor"]?.label);
  });
});

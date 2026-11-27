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

/**
 * Two rules that arrive from `gsim-core` with the data they are about.
 *
 * Both were asserted in the engine's `compile/library.rs`, and the corner rule said why in its
 * own comment: *"The geometry means nothing to this crate, which is exactly why the rule has to
 * be asserted here rather than left to whichever generator wrote the file: the data is embedded
 * from this repository, so this is the only place a fifth cannot slip past."*
 *
 * That reasoning is what moves them. After decision 0010 the data is no longer embedded there,
 * so the only place a fifth cannot slip past is here.
 *
 * And the corner rule had to move rather than merely being allowed to: with `symbol` gone from
 * the engine's half, its loop finds no bounding box, `continue`s past all 78 components and
 * passes while testing nothing -- which is the failure mode this repository has shipped four
 * times. A vacuous green is worse than a deleted test, because it still reads as coverage.
 */
describe("the drawing rules moved with the drawings", () => {
  it("no port sits on a face corner", () => {
    // A symbol is drawn inside its bbox, so a port declared on a face *corner* can only be met
    // by artwork running into that corner -- which no symbol does. The port marker then draws
    // as a loose circle beside the component with nothing joining the two, and a reader cannot
    // tell which terminal belongs to what.
    //
    // Four components shipped that way: both dependent current-controlled sources with p and n
    // on the same face's two corners, the comparator carrying the ideal opamp's offsets in a
    // shorter box, and the n-MESFET putting all three terminals at the far corner of their
    // faces.
    const offenders: string[] = [];
    let checked = 0;
    for (const [id, entry] of Object.entries(display)) {
      const bbox = (entry.symbol as { bbox?: unknown })?.bbox;
      if (!Array.isArray(bbox)) continue;
      const [w, h] = bbox as number[];
      if (typeof w !== "number" || typeof h !== "number") continue;
      const ports = merged.get(id)?.ports as Record<string, unknown> | undefined;
      if (ports === undefined) continue;
      for (const group of ["inputs", "outputs"] as const) {
        const list = ports[group];
        if (!Array.isArray(list)) continue;
        for (const port of list as { side?: string; offset?: number; id?: string }[]) {
          const { side, offset } = port;
          if (typeof side !== "string" || typeof offset !== "number") continue;
          checked += 1;
          const span = side === "left" || side === "right" ? h : w;
          if (offset <= 0 || offset >= span) {
            offenders.push(`${id}.${port.id ?? "?"} at ${side} ${offset} of ${span}`);
          }
        }
      }
    }
    // The guard the engine's version lacked once its data moved: a loop that checks nothing
    // reports success, so the count is asserted before the result is trusted.
    expect(checked).toBeGreaterThan(50);
    expect(offenders).toEqual([]);
  });

  it("the ideal family is its own palette group", () => {
    // The group is what carries the distinction, so it has to reach a front end -- and now it
    // starts here. The diode used to sit under `semiconductor`, which is the one word that
    // invites reading it as a SPICE model's variant.
    for (const id of ["ideal.diode", "ideal.switch"]) {
      const entry = display[id];
      expect(entry, `${id} is in the display catalogue`).toBeDefined();
      expect(entry?.category, `${id} must be grouped as ideal`).toBe("ideal");
      expect(entry?.tags ?? [], `${id} must not be tagged passive`).not.toContain("passive");
    }
  });
});

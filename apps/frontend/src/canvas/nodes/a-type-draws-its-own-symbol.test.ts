/**
 * A catalogue type must not borrow another type's artwork through an alias.
 *
 * `BlockSymbol` resolves artwork with
 * `getSchematicSymbol(metadata.name, metadataType, ...metadataAliases)` -- the type's own
 * name first, then every alias. An alias is search text ("this is like a voltage-controlled
 * switch"), so an alias can perfectly well be *another real type* that has its own, quite
 * different artwork. When the type's own name has no registry key, the walk continues into
 * the aliases and silently draws the wrong device.
 *
 * That is not hypothetical. `component-symbols.tsx` carries a comment about exactly this
 * happening to the ideal switch, which rendered as a 4-port voltage-controlled switch.
 * It then happened a second time: gsim-core#60 renamed `passive.switch.ideal` to
 * `ideal.switch`, and because `physical-electrical.switch.generic` is among that type's
 * aliases *and* has its own registry key, dropping the old key would have drawn the generic
 * switch instead. The whole suite -- 1410 tests -- passed with the new keys missing.
 *
 * So this is the guard. Every compilable catalogue type whose artwork is reached only
 * through an alias is listed in BORROWS_BY_ALIAS below, which is the record of a decision;
 * anything new that starts borrowing fails here instead of drawing the wrong thing.
 */
import { describe, expect, it } from "vitest";
import { loadCatalogFromManifest } from "../../library/catalog";
import engineCatalog from "../../library/engine-catalog.json";
import { getSchematicSymbol } from "./component-symbols";

type Entry = { filePath?: string; metadata?: Record<string, unknown> };

const entries = (engineCatalog as unknown as Entry[]).filter(
  (e): e is Entry & { metadata: Record<string, unknown> } => Boolean(e?.metadata),
);

/**
 * Types drawn from artwork registered under one of their aliases rather than their own
 * name. Each is a deliberate share: the alias is a legacy spelling of the same device, not
 * a different one. Adding to this list means confirming -- by looking at the drawing -- that
 * the borrowed symbol is the right device.
 */
const BORROWS_BY_ALIAS = new Set<string>([
  // Both are drawn by `transformerDrawing`, reached through their
  // `physical_electrical.passive.*` aliases -- the same two-coil device under its older
  // spelling, not a different one. Found by this test the first time it ran.
  "passive.transformer",
  "passive.mutual_inductor",
]);

describe("a catalogue type draws its own symbol", () => {
  it("resolves artwork from the type's own name, not from an alias", () => {
    const borrowing: string[] = [];
    for (const entry of entries) {
      const name = entry.metadata.name;
      if (typeof name !== "string") continue;
      const aliases = (entry.metadata.aliases as unknown[] | undefined) ?? [];
      const aliasKeys = aliases.filter((a): a is string => typeof a === "string");

      const full = getSchematicSymbol(name, ...aliasKeys);
      if (!full) continue; // no artwork at all: a labelled box, which is a different concern
      const byName = getSchematicSymbol(name);
      if (!byName) borrowing.push(name);
    }
    expect(
      borrowing.filter((n) => !BORROWS_BY_ALIAS.has(n)),
      "these types are drawn with artwork registered under an alias, which may be a " +
        "different device; give the type its own registry key, or add it to " +
        "BORROWS_BY_ALIAS once you have looked at the drawing",
    ).toEqual([]);
  });

  it("draws the two types gsim-core#60 renamed", () => {
    for (const name of ["ideal.switch", "ideal.diode"]) {
      expect(getSchematicSymbol(name), `${name} has no artwork of its own`).toBeDefined();
    }
  });

  it("still draws a sheet saved under the pre-rename names", () => {
    for (const name of ["passive.switch.ideal", "passive.diode.ideal"]) {
      expect(getSchematicSymbol(name), `${name} no longer resolves`).toBeDefined();
    }
  });

  // Artwork is only half of opening an old sheet: the catalogue has to find the component
  // for the type string the sheet was saved with. `docs/articles/assets/llc-converter.gsim_sch`
  // names both old ids and is left spelling them on purpose, as the fixture for this.
  it("resolves a pre-rename type string to the renamed component", () => {
    const catalog = loadCatalogFromManifest();
    for (const [saved, renamed] of [
      ["passive.switch.ideal", "ideal.switch"],
      ["passive.diode.ideal", "ideal.diode"],
    ]) {
      expect(catalog[saved], `a sheet saved as ${saved} finds nothing`).toBeDefined();
      expect(catalog[saved]?.name).toBe(renamed);
    }
  });
});

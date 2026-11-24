/**
 * #146 — every committed example opens through the editor's own loader.
 *
 * Not a hypothetical. All five examples in `examples/` failed `deserialize()`
 * until this test was written, each in two ways at once:
 *
 *   /model/blocks/8/paradigm: must be equal to constant
 *   /model/wires/0: must have required property 'net'
 *
 * The first because `examples/_builder.py` copied the paradigm out of
 * `gsim_py.catalog()`, which reports `routing.ground` as `physical-network`,
 * while the schema keys paradigm off the type prefix and requires `^routing\.`
 * to say `routing`. The second because `gsim-core`'s serialiser skipped
 * `Wire.net` when no net was named, and the schema requires the key with
 * `string | null` (GLODI-Engineering/gsim-core#73).
 *
 * Nothing caught either. `scripts/check-examples.mjs` read the documents with
 * `JSON.parse`, asked the catalogue about the block types and asked the engine to
 * compile them — all of which passed — and reported "5 example(s) OK". The engine
 * is content with a document the editor rejects, so a gate that only consults the
 * engine cannot see this class of fault at all.
 *
 * And the user saw none of it: `schematic-main.tsx` catches the parse failure,
 * posts it to a log channel that is closed by default, and renders the empty
 * default model — so the toast says "Nothing to simulate — the schematic is
 * empty. Add a component first", advice which if followed overwrites the file.
 *
 * This test exists because `deserialize` is the real door. The arm added to
 * `check-examples.mjs` uses the same generated validator and catches the same
 * faults, which covers the gate; this covers the function, including the
 * canonicalisation step `deserialize` performs after validating and the schema
 * arm therefore does not exercise.
 */

import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { deserialize } from "./deserializer";

const EXAMPLES = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "..",
  "examples",
);

const files = readdirSync(EXAMPLES)
  .filter((name) => name.endsWith(".gsim_sch"))
  .sort();

describe("every committed example opens in the editor", () => {
  it("finds the examples at all", () => {
    // Guards the path above. A test that silently iterates an empty list is
    // worse than no test: it reports success for work it never did, which is
    // the failure mode this whole file is about.
    expect(files.length).toBeGreaterThan(0);
  });

  it.each(files)("%s deserialises", (name) => {
    const text = readFileSync(join(EXAMPLES, name), "utf8");
    const document = deserialize(text);

    // Shape assertions rather than just "it did not throw": a document that
    // validates but arrives with no blocks would render the same blank canvas
    // the user reported, for a different reason.
    expect(document.model.blocks.length).toBeGreaterThan(0);
    expect(document.model.wires.length).toBeGreaterThan(0);
  });

  it.each(files)("%s names a net on every wire, or null", (name) => {
    const text = readFileSync(join(EXAMPLES, name), "utf8");
    const document = deserialize(text);
    for (const wire of document.model.wires) {
      // `toHaveProperty`, not a truthiness check: `null` is the legal value for
      // an unnamed net and the one almost every wire here carries. An absent key
      // is the defect, and `wire.net === undefined` would pass a truthiness test
      // just as happily.
      expect(wire).toHaveProperty("net");
    }
  });

  it.each(files)("%s gives every routing block the routing paradigm", (name) => {
    const text = readFileSync(join(EXAMPLES, name), "utf8");
    const document = deserialize(text);
    const routing = document.model.blocks.filter((block) => block.type.startsWith("routing."));
    expect(routing.length).toBeGreaterThan(0);
    for (const block of routing) {
      expect(block.paradigm).toBe("routing");
    }
  });
});

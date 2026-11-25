/**
 * A .gsim_sch document containing spice-subckt.instance blocks must validate,
 * round-trip byte-for-byte, and keep its wire endpoints pointing at the
 * instance's real (SubcktDef-declared) port ids.
 *
 * Regression guard for two schema bugs: `Block` was `additionalProperties:
 * false` with no `subckt_ref` property (so any real gsim-core document failed
 * validation before it could render), and `SubcktDef` had no way to carry a
 * .gsim_sch-native `blocks`/`wires` body.
 *
 * Retargeted from the dead `persistence/` loader and writer onto
 * `file/deserializer.ts` and `file/serializer.ts`, the pair the editor runs
 * (#174). One assertion had to get more specific as a result, and it is the
 * interesting one: this fixture spells two of its block types the old way, and
 * the live loader resolves an alias to the canonical name on the way in
 * (`canonical-types.ts`). So the round-trip is *not* value-identical here, by
 * design — the netlist emitter accepts canonical names only, and a document
 * that kept its aliases would render perfectly and then fail to compile with a
 * message naming a type the user never typed. The test below asserts that
 * resolution happens and that nothing else moves.
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import Ajv from "ajv/dist/2020";
import { describe, expect, it } from "vitest";

import { resolveBlockMetadata } from "../canvas/subckt-metadata";
import { deserialize } from "./deserializer";
import { serialize } from "./serializer";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE_PATH = resolve(__dirname, "../../../../tests/fixtures/gsim_sch/subckt.gsim_sch");
const SCHEMA_PATH = resolve(
  __dirname,
  "../../../../packages/schemas/definitions/model/gsim_sch.schema.json",
);

const TEXT = readFileSync(FIXTURE_PATH, "utf-8");

/** The two types this fixture spells as pre-#143 aliases, and what they resolve to. */
const ALIASES: Record<string, string> = {
  "physical-electrical.source.voltage_dc": "source.voltage.dc",
  "physical-electrical.passive.resistor": "passive.resistor",
};

function loadOrThrow() {
  return deserialize(TEXT);
}

describe("spice-subckt document round-trip", () => {
  it("a document with subckt_ref blocks and subckt_defs validates against the schema", () => {
    const schema = JSON.parse(readFileSync(SCHEMA_PATH, "utf-8"));
    const ajv = new Ajv({ strict: false, allErrors: true });
    const validate = ajv.compile(schema);
    const ok = validate(JSON.parse(TEXT));
    if (!ok) {
      throw new Error(JSON.stringify(validate.errors, null, 2));
    }
    expect(ok).toBe(true);
  });

  it("load + save preserves subckt_ref, subckt_defs and every wire endpoint", () => {
    const reparsed = JSON.parse(serialize(loadOrThrow()));
    const expected = JSON.parse(TEXT);
    // The one intended difference: an alias becomes the canonical name the
    // netlist emitter will accept. Applied to the expectation rather than
    // excused, so that a *second* difference still fails this test.
    for (const block of expected.model.blocks) {
      if (block.type in ALIASES) block.type = ALIASES[block.type];
    }
    expect(reparsed).toEqual(expected);
  });

  it("resolves this fixture's aliased types, which is why the above is not value-identical", () => {
    const loaded = loadOrThrow();
    const types = loaded.model.blocks.map((block) => block.type);
    for (const [alias, canonical] of Object.entries(ALIASES)) {
      expect(JSON.parse(TEXT).model.blocks.map((b: { type: string }) => b.type)).toContain(alias);
      expect(types).toContain(canonical);
      expect(types).not.toContain(alias);
    }
  });

  it("a wire endpoint on a subckt port survives a save/reload cycle", () => {
    const reloaded = deserialize(serialize(loadOrThrow()));

    const wire = reloaded.model.wires.find((candidate) => candidate.id === "w_v1_x1");
    expect(wire?.to).toEqual({ block: "X1", port: "inp" });
    const outWire = reloaded.model.wires.find((candidate) => candidate.id === "w_x1_r1");
    expect(outWire?.from).toEqual({ block: "X1", port: "out" });

    // …and that endpoint still resolves to a real port on the reloaded doc.
    const instance = reloaded.model.blocks.find((candidate) => candidate.id === "X1");
    expect(instance?.subckt_ref).toBe("opamp_def");
    if (!instance) throw new Error("instance X1 missing after reload");
    const metadata = resolveBlockMetadata(instance, {}, reloaded.model.subckt_defs);
    const portIds = [...(metadata?.ports.inputs ?? []), ...(metadata?.ports.outputs ?? [])].map(
      (port) => port.id,
    );
    expect(portIds).toContain("inp");
    expect(portIds).toContain("out");
  });

  it("distinguishes the netlist-only def from the one with a native body", () => {
    const doc = loadOrThrow();
    const defs = doc.model.subckt_defs ?? [];
    const opamp = defs.find((def) => def.id === "opamp_def");
    const leaf = defs.find((def) => def.id === "rc_leaf");
    expect(opamp?.blocks).toBeUndefined();
    expect(leaf?.blocks).toHaveLength(2);

    // The one with content previews it (a translucent cover primitive is
    // emitted); the netlist-only one gets the plain "subcircuit" box.
    const withContent = resolveBlockMetadata(
      { paradigm: "spice-subckt", type: "spice-subckt.instance", subckt_ref: "rc_leaf" },
      {},
      defs,
    );
    const plain = resolveBlockMetadata(
      { paradigm: "spice-subckt", type: "spice-subckt.instance", subckt_ref: "opamp_def" },
      {},
      defs,
    );
    expect(
      (withContent?.symbol.primitives ?? []).some(
        (p) => p.type === "rectf" && String(p.color).startsWith("rgba("),
      ),
    ).toBe(true);
    expect((plain?.symbol.primitives ?? []).some((p) => p.type === "rectf")).toBe(false);
  });
});

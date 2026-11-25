/**
 * Where the editor's document reader and the engine's agree, and where they do
 * not — asserted, so that a change on either side has to come here first.
 *
 * ## Why this file exists instead of a deletion
 *
 * #174 asked whether `file/deserializer.ts` could simply call the engine's
 * `loadDocument`, the way #158 made the compile path call the engine's
 * `compile`. It cannot, and the reason is not performance or taste: the two
 * functions do not answer the same question.
 *
 * `loadDocument` is a compiler's front door. It deserialises into `gsim-core`'s
 * own structs, which is a *shape* check — `serde` rejects what it cannot fit and
 * accepts everything else. The editor validates against
 * `packages/schemas/definitions/model/gsim_sch.schema.json`, which is the
 * document *contract*: it requires fields the engine is content to default, and
 * it forbids keys the engine ignores. On the corpus below the engine accepts
 * five kinds of document the editor rejects and rejects none the editor accepts.
 * Swapping one for the other would not consolidate two implementations; it would
 * silently drop the stricter of two different checks, which is most of what #146
 * put in place.
 *
 * Two further asymmetries, both load-bearing:
 *
 *   - **Alias resolution.** `canonical-types.ts` rewrites a block's type to the
 *     canonical spelling because the netlist emitter accepts no other. The
 *     engine's `loadDocument` leaves an alias exactly as written, so a document
 *     that went through it alone would render correctly and fail to compile.
 *   - **Error messages.** The editor's reason string is shown to the user, in
 *     the banner #146 added. `/model/blocks/0: must have required property
 *     'domain'` points at the thing to fix; the engine's `missing field
 *     `domain` at line 1 column 270` points at a byte offset in text the editor
 *     no longer has after a single canvas edit. `docs/decisions/002` §Finding 7
 *     recorded this and asked for the JSON path to be preserved; it still is.
 *
 * ## What is therefore gated here
 *
 * The thing #143 and #153 actually cost was not duplicated code — it was two
 * implementations disagreeing *without anyone finding out*. So the duplication
 * that remains is held to agreement instead:
 *
 *   1. on every document the editor accepts, the two readers produce the same
 *      document — semantically, field for field (the drift alarm);
 *   2. the engine accepts everything the editor accepts (so the editor can
 *      never hand the compiler something it will refuse to read);
 *   3. the divergences are exactly the recorded list, in the recorded
 *      direction.
 *
 * Arm 3 is the one that makes this more than a comment. If the engine gains the
 * document schema, a case moves from `engine accepts` to `both reject` and this
 * file goes red — which is the signal that `deserializer.ts` can finally
 * delegate. If the editor's schema is loosened instead, the same case fails from
 * the other side, and someone has to say out loud that they meant to undo #146.
 */

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { beforeAll, describe, expect, it } from "vitest";

import type { Engine } from "@gensim/gsim-wasm/compile";
import { initEngine, resetEngineForTests } from "../engine/engine";
import { deserialize } from "./deserializer";
import { serialize } from "./serializer";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const EXAMPLES = join(REPO_ROOT, "examples");
const FIXTURES = join(REPO_ROOT, "tests", "fixtures", "gsim_sch");
const WASM = join(REPO_ROOT, "packages", "gsim-wasm", "pkg", "gsim_wasm_bg.wasm");

const EXAMPLE_NAMES = [
  "boost_converter",
  "buck_converter",
  "llc_converter",
  "pfc_boost",
  "psfb_converter",
];

let engine: Engine & {
  loadDocument: (json: string) => string;
  saveDocument: (modelJson: string) => string;
};

beforeAll(async () => {
  resetEngineForTests();
  // The bytes are read here rather than fetched: see `engine/engine.test.ts`,
  // which explains why a `wasm-pack --target web` bundle needs this under jsdom.
  engine = (await initEngine(new Uint8Array(readFileSync(WASM)))) as typeof engine;
}, 30_000);

/**
 * Four document features the engine's writer does not model, and drops.
 *
 * Found by this file, on the two fixtures — the five examples are flat and
 * exercise none of them. Each one is a field the editor writes, the engine's
 * `saveDocument` omits, and a user would therefore lose if the editor saved
 * through the engine. They are not formatting differences; they are the content
 * of the feature.
 *
 * `docs/decisions/002` §Finding 4.1 predicted the first: `gsim-core` "knows
 * `Paradigm::Hierarchy` exists but has no flattening pass", and subsystem
 * authoring was recorded as out of its scope. The other three are the same
 * shape — the engine is a compiler, and a compiler has no reason to carry a
 * subcircuit's SPICE text or a subsystem's boundary ports back out again.
 *
 * This list is why `file/serializer.ts` still exists. See #200.
 */
const ENGINE_DOES_NOT_MODEL = [
  { pointer: "model.blocks[].subsystem", what: "an entire nested subsystem model (spec §11)" },
  { pointer: "model.subckt_defs[].body", what: "a netlist-only .SUBCKT's SPICE text" },
  { pointer: "model.ports", what: "a subsystem's boundary ports (spec §11.3)" },
  { pointer: "model.parent_param_aliases", what: "parent-param aliases (spec §11.5)" },
];

/**
 * A document reduced to what the engine models, so the two writers can be
 * compared on the ground they share.
 *
 * Besides the four features above, `null` and `[]` are folded into absence on
 * *both* sides. The engine omits `"label": null` and writes `"subckt_defs": []`
 * where the editor does the reverse, and neither is a disagreement about the
 * document — it is the usual Rust/JSON question of whether an empty thing is
 * written down. Folding it symmetrically keeps this test about meaning.
 */
function project(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(project);
  if (!value || typeof value !== "object") return value;
  const record = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(record).sort()) {
    if (key === "subsystem" || key === "body" || key === "ports") continue;
    if (key === "parent_param_aliases") continue;
    const entry = record[key];
    if (entry === null || entry === undefined) continue;
    if (Array.isArray(entry) && entry.length === 0) continue;
    if (entry && typeof entry === "object" && Object.keys(entry).length === 0) continue;
    out[key] = project(entry);
  }
  return out;
}

/** Deep-compare two documents as data, with key order and formatting removed. */
function asData(text: string): string {
  return JSON.stringify(sortKeys(JSON.parse(text)));
}

/** …and compared only on what the engine claims to model. */
function asSharedData(text: string): string {
  return JSON.stringify(project(JSON.parse(text)));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(record)
        .sort()
        .map((key) => [key, sortKeys(record[key])]),
    );
  }
  return value;
}

/** The engine's own round-trip: text in, canonical document text out. */
function engineRoundTrip(text: string): string {
  const document = JSON.parse(engine.loadDocument(text)) as { model: unknown };
  return engine.saveDocument(JSON.stringify(document.model));
}

/** Does a reader accept this document? The reason, when it does not. */
function accepts(read: () => unknown): { ok: true } | { ok: false; reason: string } {
  try {
    read();
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * A copy of `record` with one key genuinely absent.
 *
 * Not `delete` and not `Reflect.deleteProperty` — the second only launders the
 * first past `performance/noDelete` while doing the same thing to the object's
 * shape. Rebuilding without the key is what the rule is asking for, and it is
 * also the more precise statement of what these cases need: a field that is
 * *missing*, not `null` and not `undefined`, because missing is the distinction
 * the schema draws and therefore the one each reader has to be put to.
 */
function omitting(record: Record<string, unknown>, key: string): Record<string, unknown> {
  return Object.fromEntries(Object.entries(record).filter(([name]) => name !== key));
}

const corpus = [
  // The five shipped examples are flat: no subsystem, no `.SUBCKT`, no boundary
  // ports. The engine models all of them completely, so they are held to full
  // identity below rather than to the projection.
  ...EXAMPLE_NAMES.map((name) => ({
    label: `examples/${name}.gsim_sch`,
    text: readFileSync(join(EXAMPLES, `${name}.gsim_sch`), "utf8"),
    whole: true,
  })),
  // The fixtures exist to carry the features the examples do not, which is why
  // they are in this corpus and why they are the two that found #200.
  ...["comprehensive", "subckt"].map((name) => ({
    label: `tests/fixtures/gsim_sch/${name}.gsim_sch`,
    text: readFileSync(join(FIXTURES, `${name}.gsim_sch`), "utf8"),
    whole: false,
  })),
];

describe("the editor's reader and the engine's agree on what a document means", () => {
  for (const { label, text, whole } of corpus) {
    // Arm 1. Both writers, one meaning, on the ground they share. The editor's
    // round-trip resolves type aliases and the engine's does not, so the
    // comparison is made on the engine's reading of what the editor wrote —
    // which is precisely the document that will reach `compile`, and the only
    // one whose meaning matters.
    it(`${label}: the engine reads back what the editor writes, field for field`, () => {
      const written = serialize(deserialize(text));
      expect(asSharedData(engineRoundTrip(written))).toBe(asSharedData(written));
    });

    if (whole) {
      // The stronger statement, available for a document using no feature the
      // engine omits: not a field moves, not one is dropped. If an example ever
      // grows a subsystem, this fails and sends it to the projection above —
      // which is the right outcome, because at that point the example is
      // carrying something the engine would destroy.
      it(`${label}: …and loses nothing at all, being flat`, () => {
        const written = serialize(deserialize(text));
        expect(asData(engineRoundTrip(written))).toBe(asData(written));
      });
    }

    // Arm 2. One direction of acceptance, which is the direction that can hurt
    // a user: the editor opening a file, the user pressing Run, and the engine
    // refusing to read what the editor just handed it.
    it(`${label}: the engine accepts what the editor accepts`, () => {
      expect(accepts(() => deserialize(text)).ok).toBe(true);
      expect(accepts(() => engine.loadDocument(serialize(deserialize(text)))).ok).toBe(true);
    });
  }
});

/**
 * Arm 3. The recorded divergences.
 *
 * `engine` and `editor` are what each reader does with the mutation applied to
 * a known-good example. Every row is a document one reader would take and the
 * other would not, and every row is `engine: "accept"` — there is no mutation
 * in either direction where the engine is the stricter of the two, which is the
 * whole argument against delegating to it.
 */
const DIVERGENCES: Array<{
  what: string;
  mutate: (document: Record<string, never>) => void;
  engine: "accept" | "reject";
  editor: "accept" | "reject";
  editorPointer?: string;
}> = [
  {
    what: "a wire with no `net` (required by the schema, defaulted by the engine)",
    mutate: (d) => {
      const wires = (d as { model: { wires: Array<Record<string, unknown>> } }).model.wires;
      wires[0] = omitting(wires[0], "net");
    },
    engine: "accept",
    editor: "reject",
    editorPointer: "/model/wires/0",
  },
  {
    what: "a block with no `fidelity`",
    mutate: (d) => {
      const blocks = (d as { model: { blocks: Array<Record<string, unknown>> } }).model.blocks;
      blocks[0] = omitting(blocks[0], "fidelity");
    },
    engine: "accept",
    editor: "reject",
    editorPointer: "/model/blocks/0",
  },
  {
    what: "a block with no `ic`",
    mutate: (d) => {
      const blocks = (d as { model: { blocks: Array<Record<string, unknown>> } }).model.blocks;
      blocks[0] = omitting(blocks[0], "ic");
    },
    engine: "accept",
    editor: "reject",
    editorPointer: "/model/blocks/0",
  },
  {
    what: "a block with no `mirror`",
    mutate: (d) => {
      const blocks = (d as { model: { blocks: Array<Record<string, unknown>> } }).model.blocks;
      blocks[0] = omitting(blocks[0], "mirror");
    },
    engine: "accept",
    editor: "reject",
    editorPointer: "/model/blocks/0",
  },
  {
    what: "an unknown key at the top level",
    mutate: (d) => {
      (d as Record<string, unknown>).embedded_notes = "hello";
    },
    engine: "accept",
    editor: "reject",
    editorPointer: "/",
  },
  {
    what: "an unknown key inside a block",
    mutate: (d) => {
      (d as { model: { blocks: Array<Record<string, unknown>> } }).model.blocks[0].z_order = 3;
    },
    engine: "accept",
    editor: "reject",
    editorPointer: "/model/blocks/0",
  },
];

/** Mutations both readers refuse, so the agreement is not vacuous. */
const AGREED_REJECTIONS: Array<{ what: string; mutate: (d: Record<string, never>) => void }> = [
  {
    what: "a block with no `domain`",
    mutate: (d) => {
      const blocks = (d as { model: { blocks: Array<Record<string, unknown>> } }).model.blocks;
      blocks[0] = omitting(blocks[0], "domain");
    },
  },
  {
    what: "`schema_version: 1`",
    mutate: (d) => {
      (d as Record<string, unknown>).schema_version = 1;
    },
  },
  {
    what: "a float position coordinate",
    mutate: (d) => {
      (d as { model: { blocks: Array<{ position: number[] }> } }).model.blocks[0].position = [
        0.5, 140,
      ];
    },
  },
];

describe("the recorded divergences, and their direction", () => {
  const BASE = readFileSync(join(EXAMPLES, "buck_converter.gsim_sch"), "utf8");
  const mutated = (mutate: (d: Record<string, never>) => void): string => {
    const document = JSON.parse(BASE);
    mutate(document);
    return JSON.stringify(document);
  };

  for (const row of DIVERGENCES) {
    it(`${row.what}: engine ${row.engine}s, editor ${row.editor}s`, () => {
      const text = mutated(row.mutate);
      const byEngine = accepts(() => engine.loadDocument(text));
      const byEditor = accepts(() => deserialize(text));
      expect(byEngine.ok).toBe(row.engine === "accept");
      expect(byEditor.ok).toBe(row.editor === "accept");

      // The editor's reason is what the #146 banner shows the user, so it has
      // to name the place in the document and not an offset into bytes the
      // editor will not have after the first canvas edit.
      if (!byEditor.ok && row.editorPointer) {
        expect(byEditor.reason).toContain(row.editorPointer);
        expect(byEditor.reason).not.toMatch(/line \d+ column \d+/);
      }
    });
  }

  for (const row of AGREED_REJECTIONS) {
    it(`${row.what}: both readers reject it`, () => {
      const text = mutated(row.mutate);
      expect(accepts(() => engine.loadDocument(text)).ok).toBe(false);
      expect(accepts(() => deserialize(text)).ok).toBe(false);
    });
  }

  it("the engine is never the stricter of the two: no recorded row has it rejecting alone", () => {
    expect(DIVERGENCES.filter((row) => row.engine === "reject")).toEqual([]);
  });
});

/**
 * The losses, each asserted to still happen.
 *
 * This is the half of #200 that belongs in a gate rather than an issue. Every
 * case below is a field the editor writes and the engine's writer drops, so
 * every case is a reason `file/serializer.ts` cannot be replaced by
 * `saveDocument`. When the engine learns one of them, the matching test fails
 * with "the engine now preserves this" — and that failure is the only thing
 * that will tell us the answer to #174 has changed.
 */
describe("what the engine's writer drops, and must not be trusted with", () => {
  const BASE = JSON.parse(readFileSync(join(EXAMPLES, "buck_converter.gsim_sch"), "utf8"));

  /** The engine's round-trip of `base` with `mutate` applied. */
  const through = (mutate: (document: Record<string, never>) => void): Record<string, never> => {
    const document = JSON.parse(JSON.stringify(BASE));
    mutate(document);
    return JSON.parse(engineRoundTrip(JSON.stringify(document)));
  };

  it("records every known loss, so the list and the assertions cannot drift apart", () => {
    expect(ENGINE_DOES_NOT_MODEL.map((entry) => entry.pointer)).toEqual([
      "model.blocks[].subsystem",
      "model.subckt_defs[].body",
      "model.ports",
      "model.parent_param_aliases",
    ]);
  });

  it("a nested subsystem body: the whole inner model is gone", () => {
    const inner = {
      id: "inner",
      name: "Inner",
      grid: 10,
      params: [],
      blocks: [
        {
          id: "gi",
          type: "control.gain",
          paradigm: "signal-flow",
          domain: "signal",
          fidelity: "n_a",
          position: [0, 0],
          rotation: 0,
          mirror: "none",
          params: { k: 2 },
          ic: {},
        },
      ],
      wires: [],
      lines: [],
      nets: [],
      ports: [],
      parent_param_aliases: [],
      simulation: {},
      metadata: {},
    };
    const out = through((document) => {
      (
        document as { model: { blocks: Array<Record<string, unknown>> } }
      ).model.blocks[0].subsystem = inner;
    });
    expect(out.model.blocks[0]).not.toHaveProperty("subsystem");
  });

  it("a netlist-only .SUBCKT: its SPICE text is gone", () => {
    const out = through((document) => {
      (document as { model: Record<string, unknown> }).model.subckt_defs = [
        {
          id: "od",
          name: "OPAMP",
          body: "E1 out 0 inp inn 1e5",
          ports: [
            { id: "inp", kind: "physical-electrical" },
            { id: "out", kind: "physical-electrical" },
          ],
        },
      ];
    });
    expect(out.model.subckt_defs[0]).not.toHaveProperty("body");
    expect(JSON.stringify(out)).not.toContain("E1 out 0 inp inn 1e5");
  });

  it("a subsystem's boundary ports: gone", () => {
    const out = through((document) => {
      (document as { model: Record<string, unknown> }).model.ports = [
        { id: "p1", direction: "in", kind: "signal" },
      ];
    });
    expect(out.model).not.toHaveProperty("ports");
  });

  it("parent-param aliases: gone", () => {
    const out = through((document) => {
      (document as { model: Record<string, unknown> }).model.parent_param_aliases = [
        { inner: "x", outer: "y" },
      ];
    });
    expect(out.model).not.toHaveProperty("parent_param_aliases");
  });

  // The control for all four: fields the engine does carry, so that the tests
  // above are evidence about these specific features and not about a writer
  // that drops everything it is given.
  it("…while annotations, nets, labels and `role` survive it intact", () => {
    const out = through((document) => {
      const model = (
        document as {
          model: { lines: unknown[]; nets: unknown[]; wires: Array<Record<string, unknown>> };
        }
      ).model;
      model.lines = [{ id: "a1", kind: "text", position: [0, 0], text: "hello" }];
      model.nets = [{ name: "n1", kind: "signal", scope: "local", is_reference: false }];
      model.wires[0].label = "my wire";
      (document as { model: Record<string, unknown> }).model.role = "library";
    });
    expect(out.model.lines).toEqual([{ id: "a1", kind: "text", position: [0, 0], text: "hello" }]);
    expect(out.model.nets).toEqual([
      { name: "n1", kind: "signal", scope: "local", is_reference: false },
    ]);
    expect(out.model.wires[0].label).toBe("my wire");
    expect(out.model.role).toBe("library");
  });
});

describe("alias resolution is the editor's, not the engine's", () => {
  it("the engine leaves an aliased block type as written; the editor canonicalises it", () => {
    const document = JSON.parse(readFileSync(join(EXAMPLES, "buck_converter.gsim_sch"), "utf8"));
    document.model.blocks[0].type = "physical-electrical.source.voltage_dc";
    const text = JSON.stringify(document);

    const byEngine = JSON.parse(engine.loadDocument(text));
    expect(byEngine.model.blocks[0].type).toBe("physical-electrical.source.voltage_dc");

    // …and that is the spelling the netlist emitter refuses, which is why
    // `canonical-types.ts` runs on the editor's side of the door.
    expect(deserialize(text).model.blocks[0].type).toBe("source.voltage.dc");
  });
});

describe("§5.2 param expressions are the editor's alone", () => {
  it("the engine emits an expression into the netlist verbatim rather than evaluating it", () => {
    const document = JSON.parse(readFileSync(join(EXAMPLES, "buck_converter.gsim_sch"), "utf8"));
    const resistor = document.model.blocks.find((block: { id: string }) => block.id === "rload");
    expect(resistor).toBeDefined();
    resistor.params.R = "{3 + 4}";

    const compiled = JSON.parse(
      (engine as unknown as { compile: (model: string, target: string) => string }).compile(
        JSON.stringify(document.model),
        "general-simulator",
      ),
    );
    // Not `7`. The engine has no §5.2 evaluator — `document/model.rs` says the
    // syntax is not evaluated by the crate — so the text travels through to the
    // deck. `params/param_expression.ts` is therefore not a second copy of
    // anything, and deleting it would delete the only implementation. See #199.
    expect(compiled.netlist).toContain("{3 + 4}");
    expect(compiled.netlist).not.toMatch(/^rload\s+\S+\s+\S+\s+7$/m);
  });
});

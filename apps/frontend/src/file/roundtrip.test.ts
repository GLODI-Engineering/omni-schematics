/**
 * The `.gsim_sch` round-trip, asserted against the loader and writer the editor
 * actually runs.
 *
 * It used to assert it against `persistence/gsim_sch_loader.ts` and
 * `gsim_sch_saver.ts` — a reader and writer of this format that no production
 * code path ever imported (#174). So the properties below held, for 159 lines
 * of TypeScript that never saw a user's file, while `file/deserializer.ts` and
 * `file/serializer.ts` — the pair every real open and every real save goes
 * through — were covered by neither. The dead pair is deleted and these point
 * at the live one.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import Ajv from "ajv/dist/2020";
import { describe, expect, it } from "vitest";

import { deserialize } from "./deserializer";
import { serialize } from "./serializer";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE_PATH = resolve(
  __dirname,
  "../../../../tests/fixtures/gsim_sch/comprehensive.gsim_sch",
);
const SCHEMA_PATH = resolve(
  __dirname,
  "../../../../packages/schemas/definitions/model/gsim_sch.schema.json",
);

function readFixture() {
  return readFileSync(FIXTURE_PATH, "utf-8");
}

describe("FE-63: .gsim_sch roundtrip", () => {
  it("test_fixture_validity: comprehensive.gsim_sch exists and validates against schema", () => {
    expect(existsSync(FIXTURE_PATH)).toBe(true);
    const text = readFixture();
    const doc = JSON.parse(text);

    const schema = JSON.parse(readFileSync(SCHEMA_PATH, "utf-8"));
    const ajv = new Ajv({ strict: false, allErrors: true });
    const validate = ajv.compile(schema);
    expect(validate(doc)).toBe(true);
  });

  it("test_roundtrip_semantic: load + save preserves document semantics", () => {
    const text = readFixture();
    const reparsed = JSON.parse(serialize(deserialize(text)));
    const original = JSON.parse(text);
    expect(reparsed).toEqual(original);
  });

  // The property that protects a user's file across repeated saves. A save is
  // not a one-shot: the host writes, the webview is handed its own bytes back on
  // the next `gsim/setDocument`, and reads them again. A round-trip that moved
  // the document even slightly on each pass would walk it somewhere else one
  // save at a time, and no single comparison would show it.
  it("is idempotent: a second round-trip changes nothing, byte for byte", () => {
    const once = serialize(deserialize(readFixture()));
    expect(serialize(deserialize(once))).toBe(once);
  });

  it("test_fixture_features: fixture contains required FE-63 features", () => {
    const doc = JSON.parse(readFixture());
    const blocks = doc?.model?.blocks ?? [];
    const lines = doc?.model?.lines ?? [];
    const analyses = doc?.model?.simulation?.analyses ?? [];

    const hasSignal = blocks.some((b: { type?: string }) => String(b.type).startsWith("signal."));
    const hasControl = blocks.some((b: { type?: string }) => String(b.type).startsWith("control."));
    const hasConverter = blocks.some((b: { type?: string }) =>
      String(b.type).startsWith("converter."),
    );
    const hasHierarchy = blocks.some((b: { type?: string }) =>
      String(b.type).startsWith("hierarchy."),
    );
    const hasGoto = blocks.some((b: { type?: string }) => b.type === "routing.goto");
    const hasFrom = blocks.some((b: { type?: string }) => b.type === "routing.from");
    const hasText = lines.some((l: { kind?: string }) => l.kind === "text");

    expect(hasSignal).toBe(true);
    expect(hasControl).toBe(true);
    expect(hasConverter).toBe(true);
    expect(hasHierarchy).toBe(true);
    expect(hasGoto && hasFrom).toBe(true);
    expect(hasText).toBe(true);
    expect(analyses.length).toBeGreaterThanOrEqual(2);
  });
});

describe("model.role (spec §4.1)", () => {
  function compileSchema() {
    const schema = JSON.parse(readFileSync(SCHEMA_PATH, "utf-8"));
    return new Ajv({ strict: false, allErrors: true }).compile(schema);
  }

  it("defaults to schematic: the fixture carries no role and none is invented on save", () => {
    const original = JSON.parse(readFixture());
    expect(original.model.role).toBeUndefined();

    expect("role" in JSON.parse(serialize(deserialize(readFixture()))).model).toBe(false);
  });

  it('round-trips role: "library" through load + save', () => {
    const doc = JSON.parse(readFixture());
    doc.model.role = "library";
    expect(compileSchema()(doc)).toBe(true);

    const loaded = deserialize(JSON.stringify(doc));
    expect(loaded.model.role).toBe("library");
    expect(JSON.parse(serialize(loaded)).model.role).toBe("library");
  });

  it("rejects an unknown role value", () => {
    const doc = JSON.parse(readFixture());
    doc.model.role = "gallery";
    const validate = compileSchema();

    expect(validate(doc)).toBe(false);
    expect(JSON.stringify(validate.errors)).toContain("role");
  });

  it("rejects role on a nested subsystem model", () => {
    const doc = JSON.parse(readFixture());
    const host = doc.model.blocks.find((b: { subsystem?: unknown }) => b.subsystem);
    expect(host).toBeDefined();
    host.subsystem.role = "library";

    expect(compileSchema()(doc)).toBe(false);
  });
});

/**
 * #201 — the file is the user's and lives in their repository, so a save has to be readable
 * as a diff.
 */
describe("#201: a saved sheet reads as a diff", () => {
  it("writes one line per field, not the whole document on one line", () => {
    const text = serialize(deserialize(readFixture()));
    const lines = text.split("\n");

    // The precise regression: `JSON.stringify` with no indent put a 19 KB sheet on a single
    // line, so `git diff` could say that it changed and never what changed in it.
    expect(lines.length).toBeGreaterThan(20);
    expect(Math.max(...lines.map((line) => line.length))).toBeLessThan(200);
  });

  it("ends with a newline, as every other writer of this format does", () => {
    // `examples/_builder.py` writes `json.dumps(..., indent=2) + "\n"`. A file without a final
    // newline makes every tool that appends one show a spurious last-line change.
    expect(serialize(deserialize(readFixture())).endsWith("\n")).toBe(true);
  });

  it("is byte-stable across a second save, so opening a sheet does not dirty it", () => {
    const once = serialize(deserialize(readFixture()));
    const twice = serialize(deserialize(once));
    expect(twice).toBe(once);
  });

  it("indents with two spaces, matching the generator and the engine", () => {
    const text = serialize(deserialize(readFixture()));
    const indented = text.split("\n").filter((line) => line.startsWith(" "));
    expect(indented.length).toBeGreaterThan(10);
    for (const line of indented) {
      const depth = line.length - line.trimStart().length;
      expect(depth % 2).toBe(0);
    }
  });
});

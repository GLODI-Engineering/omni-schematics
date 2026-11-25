/**
 * #211 — what "New Schematic" writes has to be a document, not a zero-byte file.
 *
 * The shape is held against `gsim_sch.schema.json` itself rather than against a
 * list copied out of it, so a member added to the schema fails here instead of
 * at the moment a user opens the file they just created. The extension host has
 * no JSON-schema validator (it ships with `--no-dependencies`), so this reads
 * the required members and checks for each; the whole round trip through the
 * editor's own validator is asserted by the integration suite, in real VS Code.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { NEW_SCHEMATIC_BASENAME, modelNameFor, newSchematicDocument } from "./new-schematic";

const SCHEMA = JSON.parse(
  readFileSync(
    join(
      __dirname,
      "..",
      "..",
      "..",
      "packages",
      "schemas",
      "definitions",
      "model",
      "gsim_sch.schema.json",
    ),
    "utf8",
  ),
) as {
  required: string[];
  $defs: { Model: { required: string[]; additionalProperties: boolean } };
};

describe("newSchematicDocument", () => {
  it("is JSON, which the zero-byte file it replaces was not", () => {
    expect(() => JSON.parse(newSchematicDocument("buck"))).not.toThrow();
  });

  it("carries every member the document schema requires", () => {
    const document = JSON.parse(newSchematicDocument("buck")) as Record<string, unknown>;
    for (const key of SCHEMA.required) {
      expect(Object.keys(document), `top level is missing ${key}`).toContain(key);
    }
    expect(document.schema_version).toBe(2);
  });

  it("carries every member the model schema requires, and nothing it forbids", () => {
    const { model } = JSON.parse(newSchematicDocument("buck")) as {
      model: Record<string, unknown>;
    };
    for (const key of SCHEMA.$defs.Model.required) {
      expect(Object.keys(model), `model is missing ${key}`).toContain(key);
    }
    // `additionalProperties: false` — an extra member is a validation failure,
    // not a harmless one.
    expect(SCHEMA.$defs.Model.additionalProperties).toBe(false);
    const allowed = new Set([...SCHEMA.$defs.Model.required, "role", "subckt_defs"]);
    for (const key of Object.keys(model)) {
      expect(allowed, `model carries an unexpected ${key}`).toContain(key);
    }
  });

  it("is empty: a new sheet, not a template with something already on it", () => {
    const { model } = JSON.parse(newSchematicDocument("buck")) as {
      model: { blocks: unknown[]; wires: unknown[]; nets: unknown[] };
    };
    expect(model.blocks).toEqual([]);
    expect(model.wires).toEqual([]);
    expect(model.nets).toEqual([]);
  });

  it("names the model after the file, and gives it a usable id", () => {
    const { model } = JSON.parse(newSchematicDocument("Half Bridge")) as {
      model: { id: string; name: string };
    };
    expect(model.name).toBe("Half Bridge");
    expect(model.id).toBe("model-half-bridge");
  });

  it("is readable, because it is the first file a new user opens", () => {
    const text = newSchematicDocument("buck");
    expect(text.split("\n").length).toBeGreaterThan(5);
    expect(text.endsWith("\n")).toBe(true);
  });
});

describe("modelNameFor", () => {
  it("takes the stem of a path", () => {
    expect(modelNameFor("/home/u/designs/boost.gsim_sch")).toBe("boost");
    expect(modelNameFor("boost.gsim_sch")).toBe("boost");
  });

  it("falls back rather than naming a model the empty string", () => {
    expect(modelNameFor(".gsim_sch")).toBe("Untitled model");
  });

  it("defaults the save dialog to something with the right extension", () => {
    expect(NEW_SCHEMATIC_BASENAME.endsWith(".gsim_sch")).toBe(true);
  });
});

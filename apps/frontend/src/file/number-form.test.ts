/**
 * The declaration lookup, and the gate that stops it going quietly incomplete.
 *
 * A *wrong* declaration here is worse than none: a real-valued parameter called
 * integral loses its meaning for every Python reader of the document, and an
 * integral one called real turns a count into `3.0`. The two kinds of mistake
 * are tested separately below, and so is the third — a number the table has no
 * entry for at all, which must come out `undefined` rather than guessed.
 *
 * `every place the format admits a real number is declared` is the one that
 * cannot be written by hand: it reads `gsim_sch.schema.json` and insists the
 * table account for every site it finds. A field added to the schema therefore
 * arrives here as a failing test rather than as an undeclared number nobody
 * looked at.
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import type { ModelDocument } from "../model/types";
import { DOCUMENT_SITES, numberFormAt, siteKeyFor } from "./number-form";

const SCHEMA_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../../packages/schemas/definitions/model/gsim_sch.schema.json",
);

/** A document just real enough to carry the paths under test. */
function documentWith(partial: Record<string, unknown>): ModelDocument {
  return {
    schema_version: 2,
    model: {
      id: "m",
      name: "m",
      grid: 20,
      params: [],
      blocks: [],
      wires: [],
      lines: [],
      nets: [],
      simulation: {},
      ...partial,
    },
  } as unknown as ModelDocument;
}

function block(type: string, params: Record<string, unknown>, fidelity = "ideal") {
  return {
    id: "b",
    type,
    paradigm: "physical-network",
    domain: "physical-electrical",
    fidelity,
    position: [0, 0],
    rotation: 0,
    mirror: "none",
    params,
    ic: {},
  };
}

describe("a component declares its own parameters", () => {
  it("calls a parameter the engine declares `number` real", () => {
    const document = documentWith({ blocks: [block("source.voltage.dc", { V: 48 })] });
    expect(numberFormAt(["model", "blocks", 0, "params", "V"], document)).toBe("real");
  });

  it("calls a parameter the engine declares `integer` integral", () => {
    const document = documentWith({ blocks: [block("control.product", { n_inputs: 2 })] });
    expect(numberFormAt(["model", "blocks", 0, "params", "n_inputs"], document)).toBe("integer");
  });

  it("resolves a component named by an alias, as a saved sheet may name it", () => {
    const document = documentWith({
      blocks: [block("physical-electrical.source.voltage_dc", { V: 48 })],
    });
    expect(numberFormAt(["model", "blocks", 0, "params", "V"], document)).toBe("real");
  });

  it("says nothing about a `matrix` parameter's elements", () => {
    // The type names the container. A state matrix is real, but the catalogue
    // does not say so, and assuming it would be the mistake this file is about.
    const document = documentWith({ blocks: [block("control.state_space", { a: [[0]] })] });
    expect(numberFormAt(["model", "blocks", 0, "params", "a"], document)).toBeUndefined();
    expect(numberFormAt(["model", "blocks", 0, "params", "a", 0, 0], document)).toBeUndefined();
  });

  it("says nothing about a parameter the component does not declare", () => {
    const document = documentWith({ blocks: [block("source.voltage.dc", { nonsense: 1 })] });
    expect(numberFormAt(["model", "blocks", 0, "params", "nonsense"], document)).toBeUndefined();
  });

  it("says nothing about a component the catalogue has never heard of", () => {
    const document = documentWith({ blocks: [block("vendor.widget", { V: 1 })] });
    expect(numberFormAt(["model", "blocks", 0, "params", "V"], document)).toBeUndefined();
  });

  it("answers the same inside a subsystem, at any depth", () => {
    const inner = {
      ...block("source.voltage.dc", { V: 48 }),
      id: "deep",
    };
    const document = documentWith({
      blocks: [
        {
          ...block("hierarchy.subsystem", {}),
          subsystem: { blocks: [inner] },
        },
      ],
    });
    expect(
      numberFormAt(["model", "blocks", 0, "subsystem", "blocks", 0, "params", "V"], document),
    ).toBe("real");
  });

  it("leaves a .SUBCKT instance's parameters alone", () => {
    // Declared in SPICE text this editor does not parse, so there is nothing
    // here to read -- and `SubcktInstance` carries no `fidelity`, which is what
    // keeps it out of the block arm.
    const document = documentWith({
      subckt_defs: [
        {
          id: "d",
          name: "d",
          ports: [],
          body: "",
          instances: [{ id: "x1", def_ref: "d", connections: [], params: { W: 1 } }],
        },
      ],
    });
    const path = ["model", "subckt_defs", 0, "instances", 0, "params", "W"];
    expect(siteKeyFor(path, document)).toBe("SubcktInstance.params");
    expect(numberFormAt(path, document)).toBeUndefined();
  });
});

describe("the document's own numbers", () => {
  const withAnalysis = (analysis: Record<string, unknown>) =>
    documentWith({ simulation: { analyses: [analysis] } });

  it("calls a transient window real", () => {
    const document = withAnalysis({ id: "tran", type: "TRAN", t_start: 0, t_end: 1, t_step: 1e-7 });
    for (const field of ["t_start", "t_end", "t_step"]) {
      expect(numberFormAt(["model", "simulation", "analyses", 0, field], document)).toBe("real");
    }
  });

  it("calls an AC sweep's point count integral and its frequencies real", () => {
    const document = withAnalysis({
      id: "ac",
      type: "AC",
      sweep: "DEC",
      n_points: 10,
      f_start: 1,
      f_end: 1e6,
    });
    expect(numberFormAt(["model", "simulation", "analyses", 0, "n_points"], document)).toBe(
      "integer",
    );
    expect(numberFormAt(["model", "simulation", "analyses", 0, "f_start"], document)).toBe("real");
  });

  it("calls a solver tolerance real", () => {
    const document = documentWith({ simulation: { solver: { abstol: 1e-12 } } });
    expect(numberFormAt(["model", "simulation", "solver", "abstol"], document)).toBe("real");
  });

  it("says nothing about a model-level parameter's value", () => {
    const document = documentWith({ params: [{ name: "Rload", value: 5 }] });
    const path = ["model", "params", 0, "value"];
    expect(siteKeyFor(path, document)).toBe("ParamEntry.value");
    expect(numberFormAt(path, document)).toBeUndefined();
  });

  it("counts a sweep's points but does not type what is being swept", () => {
    const document = withAnalysis({
      id: "tran",
      type: "TRAN",
      t_end: 1,
      t_step: 1,
      sweeps: [{ param: "Rload", lin: { start: 1, stop: 10, n: 5 } }],
    });
    const base = ["model", "simulation", "analyses", 0, "sweeps", 0, "lin"];
    expect(numberFormAt([...base, "n"], document)).toBe("integer");
    expect(numberFormAt([...base, "start"], document)).toBeUndefined();
  });

  it("says nothing about an initial condition on a block variable", () => {
    const document = documentWith({
      simulation: { initial_conditions: [{ kind: "block", block: "c1", var: "v", value: 0 }] },
    });
    const path = ["model", "simulation", "initial_conditions", 0, "value"];
    expect(siteKeyFor(path, document)).toBe("ICEntryBlock.value");
    expect(numberFormAt(path, document)).toBeUndefined();
  });

  it("calls an initial condition on a node real, because it is a voltage", () => {
    const document = documentWith({
      simulation: { initial_conditions: [{ kind: "node", name: "out", value: 0 }] },
    });
    expect(numberFormAt(["model", "simulation", "initial_conditions", 0, "value"], document)).toBe(
      "real",
    );
  });

  it("says nothing about a path it does not recognise", () => {
    const document = documentWith({});
    expect(siteKeyFor(["model", "grid"], document)).toBeUndefined();
    expect(numberFormAt(["model", "grid"], document)).toBeUndefined();
  });
});

describe("every place the format admits a real number is declared", () => {
  /**
   * The sites `gsim_sch.schema.json` says can hold a real number, keyed the way
   * `DOCUMENT_SITES` keys them.
   *
   * Sites the schema already types `integer` are left out: `integer` is itself
   * a declaration and there is nothing for this table to add. `ParamValue`'s
   * own definition is skipped because it is the thing being referenced, not a
   * place in a document.
   *
   * A key is the definition's name plus the *field* names on the way down.
   * Everything the schema uses to structure a field rather than to name one --
   * `properties`, `items`, `oneOf` and the array index under it -- is dropped,
   * so one field spelled as a `oneOf` of several types is one site and not
   * three. `StructuredValue`'s numbers sit two `oneOf`s deep and collapse onto
   * the definition itself, which is right: it *is* the array of numbers.
   */
  function schemaSites(): string[] {
    const schema = JSON.parse(readFileSync(SCHEMA_PATH, "utf8"));
    const structural = new Set([
      "properties",
      "additionalProperties",
      "items",
      "prefixItems",
      "oneOf",
      "anyOf",
      "allOf",
      "then",
      "else",
      "$defs",
    ]);
    const found = new Set<string>();

    const walk = (node: unknown, definition: string, within: string[]): void => {
      if (node === null || typeof node !== "object") return;
      const record = node as Record<string, unknown>;
      if (record.$ref === "#/$defs/ParamValue" || record.type === "number") {
        found.add([definition, ...within].join("."));
        return;
      }
      for (const [key, value] of Object.entries(record)) {
        const named = !structural.has(key) && !/^\d+$/.test(key);
        walk(value, definition, named ? [...within, key] : within);
      }
    };

    for (const [name, definition] of Object.entries(schema.$defs as Record<string, unknown>)) {
      if (name === "ParamValue") continue;
      walk(definition, name, []);
    }
    return [...found].sort();
  }

  it("finds the schema at all, and more than a handful of sites in it", () => {
    expect(schemaSites().length).toBeGreaterThan(15);
  });

  it("declares exactly the sites the schema has, and no others", () => {
    expect(Object.keys(DOCUMENT_SITES).sort()).toEqual(schemaSites());
  });

  it("gives a reason for every site it declines to type", () => {
    for (const [site, declaration] of Object.entries(DOCUMENT_SITES)) {
      expect(declaration.why.length, `${site} has no reason`).toBeGreaterThan(10);
    }
  });
});

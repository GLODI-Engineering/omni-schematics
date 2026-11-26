/**
 * #268 — opening a shipped example and saving it must not turn a float into an
 * integer.
 *
 * ## Why this is not cosmetic
 *
 * `48` and `48.0` parse to the same double in every one of this format's three
 * writers, so nothing simulates differently. What differs is what a *Python*
 * reader sees:
 *
 *     json.loads('48')   -> int
 *     json.loads('48.0') -> float
 *
 * Rust and JavaScript widen both to an `f64`/`number` and cannot tell them
 * apart afterwards; Python cannot un-see it. So an editor that writes `48`
 * where the generator wrote `48.0` has changed a real-valued parameter into an
 * integer *in the file*, for `gsim-tools`, for `examples/build_*.py`, and for
 * anything a user writes to script a sheet.
 *
 * ## What this measures, and why it is a literal comparison
 *
 * `JSON.parse` destroys the evidence — both literals arrive as the number 48 —
 * so neither text may be parsed with it. `literalForms` walks the two texts
 * with a scanner that keeps each number's *source text*, keyed by its position
 * in the document, and the comparison is between those texts.
 *
 * The first assertion is the property #268 asks for: at every position, the
 * saved literal is a real-form literal exactly where the committed one is.
 *
 * The second is the numeric residue. Both assertions are keyed by position, so
 * neither is confounded by the *other* reason `expect(saved).toBe(committed)` is
 * not written instead: this writer sorts a document's keys and the other two
 * write them in the schema's order, which puts the first byte difference in
 * every example at byte 5 and has nothing to do with numbers (see
 * `./serializer.ts`).
 *
 * The residue itself is that Python, Rust and JavaScript each spell the *same*
 * double differently —
 *
 *     1e-9   Python `1e-09`   Rust `1e-9`      JavaScript `1e-9`
 *     1e-5   Python `1e-05`   Rust `0.00001`   JavaScript `0.00001`
 *     4.000000000000001e-6
 *            Python `4.000000000000001e-06`
 *            Rust   `4.000000000000001e-6`
 *            JS     `0.000004000000000000001`
 *
 * — which is 72 of the 110 differences measured on these five documents
 * against the 38 this change removes. That is a choice of canonical number
 * *text* for the format, not a question about float-ness, and it is nobody's
 * to make in passing. Until it is made, this test pins the residue to that one
 * class: a difference of any other kind fails here.
 */

import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { deserialize } from "./deserializer";
import { serialize } from "./serializer";

const EXAMPLES = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../examples");

const files = readdirSync(EXAMPLES)
  .filter((name) => name.endsWith(".gsim_sch"))
  .sort();

/**
 * Every JSON number in `text`, as the source spells it, keyed by its path.
 *
 * Hand-written rather than `JSON.parse` with a reviver: a reviver is handed the
 * parsed value, which is the one thing that cannot answer this question. The
 * scanner is the minimum that reads this format — objects, arrays, strings with
 * escapes, numbers, and the three literals — and it throws on anything else, so
 * it cannot quietly skip a region of the document.
 */
function literalForms(text: string): Map<string, string> {
  const out = new Map<string, string>();
  let at = 0;

  const skipSpace = () => {
    while (at < text.length && /\s/.test(text[at])) at += 1;
  };
  const expect_ = (character: string) => {
    if (text[at] !== character) {
      throw new Error(`expected ${character} at ${at}, found ${JSON.stringify(text[at])}`);
    }
    at += 1;
  };
  const readString = (): string => {
    expect_('"');
    let value = "";
    while (text[at] !== '"') {
      if (text[at] === "\\") {
        value += text.slice(at, at + 2);
        at += 2;
      } else {
        value += text[at];
        at += 1;
      }
    }
    at += 1;
    return value;
  };
  const readValue = (path: string): void => {
    skipSpace();
    const character = text[at];
    if (character === "{") {
      at += 1;
      skipSpace();
      if (text[at] === "}") {
        at += 1;
        return;
      }
      for (;;) {
        skipSpace();
        const key = readString();
        skipSpace();
        expect_(":");
        readValue(`${path}/${key}`);
        skipSpace();
        if (text[at] === ",") {
          at += 1;
          continue;
        }
        expect_("}");
        return;
      }
    }
    if (character === "[") {
      at += 1;
      skipSpace();
      if (text[at] === "]") {
        at += 1;
        return;
      }
      for (let index = 0; ; index += 1) {
        readValue(`${path}[${index}]`);
        skipSpace();
        if (text[at] === ",") {
          at += 1;
          continue;
        }
        expect_("]");
        return;
      }
    }
    if (character === '"') {
      readString();
      return;
    }
    for (const word of ["true", "false", "null"]) {
      if (text.startsWith(word, at)) {
        at += word.length;
        return;
      }
    }
    const number = /^-?\d+(\.\d+)?([eE][-+]?\d+)?/.exec(text.slice(at));
    if (!number) {
      throw new Error(`not a JSON value at ${at}: ${JSON.stringify(text.slice(at, at + 20))}`);
    }
    out.set(path, number[0]);
    at += number[0].length;
  };

  readValue("");
  skipSpace();
  if (at !== text.length) {
    throw new Error(`trailing text at ${at}`);
  }
  return out;
}

/** Whether a literal says "real": it carries a fraction or an exponent. */
const isReal = (literal: string) => /[.eE]/.test(literal);

describe("a saved sheet keeps every float a float (#268)", () => {
  it("finds the examples at all", () => {
    // The gate this file replaces reported five examples OK while reading none.
    expect(files.length).toBe(5);
  });

  it("reads its own scanner's output back as the document", () => {
    // `literalForms` is the measuring instrument, so it is measured first: a
    // scanner that silently stopped early would make every assertion below
    // vacuous for the part of the document it never reached.
    const text = readFileSync(join(EXAMPLES, files[0]), "utf8");
    const forms = literalForms(text);
    expect(forms.get("/model/grid")).toBe("20");
    expect(forms.size).toBeGreaterThan(40);
    for (const [path, literal] of forms) {
      expect(Number.isFinite(Number(literal)), `${path} = ${literal}`).toBe(true);
    }
  });

  it.each(files)("%s: no number changes between integer and real form", (name) => {
    const committed = readFileSync(join(EXAMPLES, name), "utf8");
    const saved = serialize(deserialize(committed));

    const before = literalForms(committed);
    const after = literalForms(saved);
    expect([...after.keys()].sort()).toEqual([...before.keys()].sort());

    const changed: string[] = [];
    for (const [path, literal] of before) {
      const written = after.get(path) as string;
      if (isReal(literal) !== isReal(written)) {
        changed.push(`${path}: ${literal} -> ${written}`);
      }
    }
    expect(changed).toEqual([]);
  });

  it.each(files)("%s: what still differs is only how an exponent is spelled", (name) => {
    const committed = readFileSync(join(EXAMPLES, name), "utf8");
    const saved = serialize(deserialize(committed));

    const before = literalForms(committed);
    const after = literalForms(saved);

    const unexplained: string[] = [];
    for (const [path, literal] of before) {
      const written = after.get(path) as string;
      if (literal === written) continue;
      // Same value, same form, different spelling -- `1e-09` against `1e-9`.
      // Anything else is a difference this change was supposed to have removed.
      if (Number(literal) === Number(written) && isReal(literal) && isReal(written)) continue;
      unexplained.push(`${path}: ${literal} -> ${written}`);
    }
    expect(unexplained).toEqual([]);
  });
});

/**
 * A document written before any of this still opens, and saving it repairs what
 * the declaration can speak for.
 *
 * Three properties, and the third is the one that keeps this honest. A sheet
 * saved by yesterday's editor carries `"V": 48` for a real-valued parameter,
 * because yesterday's editor had no way to write anything else. It must open
 * unchanged (nothing requires a declaration to *read* a document), it must come
 * back out in the form the catalogue declares, and a number nothing declares
 * must survive untouched rather than be guessed at.
 */
describe("a document written before the declaration existed", () => {
  const documentWith = (blocks: unknown[], simulation: unknown = {}) =>
    ({
      schema_version: 2,
      model: {
        id: "m",
        name: "m",
        grid: 20,
        params: [],
        blocks,
        wires: [],
        lines: [],
        nets: [],
        simulation,
        metadata: {},
      },
    }) as unknown as Parameters<typeof serialize>[0];

  const block = (type: string, params: Record<string, unknown>) => ({
    id: "b",
    type,
    paradigm: "physical-network",
    domain: "physical-electrical",
    fidelity: "ideal",
    position: [0, 0],
    rotation: 0,
    mirror: "none",
    params,
    ic: {},
  });

  it("opens, with no declaration required to read it", () => {
    const text = serialize(documentWith([block("source.voltage.dc", { V: 48 })]));
    expect(deserialize(text).model.blocks[0].params.V).toBe(48);
  });

  it("comes back out in the form its component declares", () => {
    const text = serialize(documentWith([block("source.voltage.dc", { V: 48 })]));
    expect(text).toContain('"V": 48.0');
  });

  it("leaves a number nothing declares exactly as it arrived", () => {
    // `nonsense` is not a parameter of this component and `Rload` is a
    // model-level parameter the document carries no type for. Both stay as they
    // are: the alternative is guessing, in a file that is somebody's work.
    const text = serialize(
      documentWith([block("source.voltage.dc", { V: 48, nonsense: 7 })], {
        analyses: [{ id: "op", type: "OP" }],
      }),
    );
    expect(text).toContain('"nonsense": 7');
    expect(text).not.toContain('"nonsense": 7.0');
  });

  it("is idempotent: saving the repaired document again changes nothing", () => {
    const once = serialize(documentWith([block("source.voltage.dc", { V: 48 })]));
    expect(serialize(deserialize(once))).toBe(once);
  });
});

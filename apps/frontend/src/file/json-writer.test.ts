/**
 * The writer must be `JSON.stringify(value, null, 2)` in every byte it was not
 * written to change.
 *
 * It replaced `JSON.stringify` in `./serializer.ts`, on a file that is a user's
 * and lives in their repository. A disagreement about how an empty object, an
 * escaped character or an array hole is written would arrive as a diff on lines
 * that have nothing to do with #268 — and it would arrive silently, because a
 * document round-trips through `JSON.parse` identically either way.
 *
 * So the reference implementation is the assertion. Every case below is checked
 * against `JSON.stringify` itself, with nothing declared real; only the last
 * group asserts the one difference the writer exists for.
 */

import { describe, expect, it } from "vitest";

import { type NumberFormAt, writeJson } from "./json-writer";

const NOTHING_IS_REAL: NumberFormAt = () => undefined;

const SAME_AS_STRINGIFY: Array<[string, unknown]> = [
  ["null", null],
  ["true", true],
  ["false", false],
  ["an integer", 42],
  ["a negative integer", -42],
  ["a fraction", 0.1],
  ["negative zero", -0],
  ["a tiny double", 1e-9],
  ["a huge double", 1e30],
  ["the smallest normal", 2.2250738585072014e-308],
  ["the largest double", 1.7976931348623157e308],
  ["a seventeen-digit double", 0.011067758972493853],
  ["an empty string", ""],
  ["a plain string", "hello"],
  ["a string needing escapes", 'a "quoted" \\ back\\slash'],
  ["a string with control characters", "tab\there\nnewline\u0001"],
  ["a string with a lone surrogate", "\ud800"],
  ["a non-ASCII string", "kg·m² — ohms Ω"],
  ["an empty array", []],
  ["an empty object", {}],
  ["an array of scalars", [1, 2.5, "three", null, true]],
  ["a nested array", [[1, 2], [], [[3]]]],
  ["an array with a hole", [1, undefined, 3]],
  ["an array with a function", [1, () => 2, 3]],
  ["an object with an undefined value", { a: 1, b: undefined, c: 3 }],
  ["an object with a function value", { a: 1, b: () => 2 }],
  ["an object whose every value is dropped", { a: undefined }],
  ["a key needing escapes", { 'a "b"\\': 1 }],
  ["a deep mixture", { a: [{ b: {} }, { c: [] }], d: { e: [1, [2, [3]]] } }],
  ["NaN", { a: Number.NaN }],
  ["Infinity", { a: Number.POSITIVE_INFINITY, b: Number.NEGATIVE_INFINITY }],
];

describe("writeJson is JSON.stringify with two spaces", () => {
  it.each(SAME_AS_STRINGIFY)("%s", (_label, value) => {
    expect(writeJson(value, NOTHING_IS_REAL)).toBe(JSON.stringify(value, null, 2));
  });

  it("refuses a root with no JSON form, where JSON.stringify returns undefined", () => {
    // Writing the text "undefined" into somebody's `.gsim_sch` is the one
    // outcome worse than failing, and `JSON.stringify` returning `undefined`
    // here is what would have produced it.
    expect(JSON.stringify(undefined, null, 2)).toBeUndefined();
    expect(() => writeJson(undefined, NOTHING_IS_REAL)).toThrow(/no JSON form/);
  });
});

describe("writeJson writes a declared real with a decimal point", () => {
  const everythingIsReal: NumberFormAt = () => "real";

  it("adds .0 to an integral value, and only to that", () => {
    const value = { a: 48, b: 0, c: -100, d: 0.5, e: 1e-9 };
    expect(writeJson(value, everythingIsReal)).toBe(
      [
        "{",
        '  "a": 48.0,',
        '  "b": 0.0,',
        '  "c": -100.0,',
        '  "d": 0.5,',
        '  "e": 1e-9',
        "}",
      ].join("\n"),
    );
  });

  it("leaves a value already written with an exponent alone", () => {
    // `String(1e30)` is `1e+30`, which every parser including Python's already
    // reads as a float. `1e+30.0` is not JSON.
    expect(writeJson([1e30, 1e21], everythingIsReal)).toBe("[\n  1e+30,\n  1e+21\n]");
  });

  it("writes an integral value as an integer when the declaration says integer", () => {
    const asInteger: NumberFormAt = () => "integer";
    expect(writeJson({ n: 3, m: 3.0 }, asInteger)).toBe('{\n  "n": 3,\n  "m": 3\n}');
  });

  it("is asked about every number, with the path it sits at", () => {
    const asked: string[] = [];
    const record: NumberFormAt = (path) => {
      asked.push(path.join("/"));
      return undefined;
    };
    writeJson({ a: 1, b: [2, { c: 3 }], d: "4" }, record);
    expect(asked).toEqual(["a", "b/0", "b/1/c"]);
  });

  it("does not let a non-finite value become a declared real", () => {
    // `null` is not a number, so there is no `.0` to add. Asserted because
    // `Number.isInteger(NaN)` is false by luck rather than by intent here.
    expect(writeJson({ a: Number.NaN }, everythingIsReal)).toBe('{\n  "a": null\n}');
  });
});

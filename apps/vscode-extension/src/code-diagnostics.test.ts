/**
 * #237 — where a code block's failure lands, and when it is taken away again.
 *
 * The collection is a stand-in, because VS Code offers no way to read a `DiagnosticCollection`
 * back; what is asserted is the *placement*, which is the whole of the decision.
 */
import { describe, expect, it } from "vitest";

import {
  type Collection,
  DIAGNOSTIC_SOURCE,
  type DiagnosticLike,
  type Failure,
  type Placement,
  forgetFile,
  publishFailures,
} from "./code-diagnostics";

/** Records every call, so lifecycle can be asserted as well as content. */
function recorder(): Collection<string> & {
  readonly calls: string[];
  readonly entries: Map<string, DiagnosticLike[]>;
} {
  const calls: string[] = [];
  const entries = new Map<string, DiagnosticLike[]>();
  return {
    calls,
    entries,
    set: (uri, diagnostics) => {
      calls.push(`set ${uri}`);
      entries.set(uri, diagnostics);
    },
    delete: (uri) => {
      calls.push(`delete ${uri}`);
      entries.delete(uri);
    },
    clear: () => {
      calls.push("clear");
      entries.clear();
    },
    dispose: () => calls.push("dispose"),
  };
}

/**
 * No default for `schematic`, deliberately: with one, `placement(undefined)` silently gets the
 * default back, and the "no schematic to fall back to" test passes while testing the opposite
 * of what it says. It did exactly that once.
 */
const placement = (schematic: string | undefined): Placement<string> => ({
  resolve: (file) => (file.startsWith("/") ? `file://${file}` : `file:///project/${file}`),
  schematic,
  key: (uri) => uri,
});

const SHEET = "file:///project/sheet.gsim_sch";
const withSheet = () => placement(SHEET);

const located: Failure = {
  message: "Octave(Runtime): Octave raised in /project/dbl.m: 'q' undefined near line 3, column 13",
  location: { file: "/project/dbl.m", line: 3, column: 13 },
  origin: "solver",
};

const unlocated: Failure = {
  message:
    "CScriptArityMismatch: block `G1`'s C-script library declares 2 input(s) and 1 output(s)",
  origin: "solver",
  block: "G1",
};

describe("publishFailures", () => {
  it("puts a located failure on its own file, at the line and column the tool reported", () => {
    const collection = recorder();
    publishFailures(collection, withSheet(), [located]);
    const diagnostics = collection.entries.get("file:///project/dbl.m");
    expect(diagnostics).toHaveLength(1);
    // VS Code counts from 0 and every tool here counts from 1.
    expect(diagnostics?.[0]?.line).toBe(2);
    expect(diagnostics?.[0]?.character).toBe(12);
    expect(diagnostics?.[0]?.source).toBe(DIAGNOSTIC_SOURCE);
  });

  /**
   * The rule #237 is most about: a failure with no location goes on the schematic rather than
   * nowhere.
   *
   * A missing library, a missing `output` function, an arity disagreement — the commonest class
   * — are facts about the *document*, and a diagnostic on the `.gsim_sch` is clickable too.
   */
  it("puts a failure with no location on the schematic", () => {
    const collection = recorder();
    publishFailures(collection, withSheet(), [unlocated]);
    expect(collection.entries.get(SHEET)).toHaveLength(1);
  });

  it("groups several failures in one file into one set call", () => {
    const collection = recorder();
    publishFailures(collection, withSheet(), [
      located,
      { ...located, location: { file: "/project/dbl.m", line: 7 } },
    ]);
    // Two diagnostics, one `set` -- `set` replaces, so two calls would leave one of them.
    expect(collection.entries.get("file:///project/dbl.m")).toHaveLength(2);
    expect(collection.calls.filter((call) => call === "set file:///project/dbl.m")).toHaveLength(1);
  });

  it("clears before it sets, so a fixed error does not survive as a squiggle", () => {
    const collection = recorder();
    publishFailures(collection, withSheet(), [located]);
    collection.calls.length = 0;
    publishFailures(collection, withSheet(), []);
    expect(collection.calls).toEqual(["clear"]);
    expect(collection.entries.size).toBe(0);
  });

  it("carries the traceback into the message, because the exception is in it", () => {
    const collection = recorder();
    publishFailures(collection, withSheet(), [
      {
        message: "PyBlock(Exception): Python block ./ctrl.py raised in `output`",
        detail: "  File \"./ctrl.py\", line 10, in output\nNameError: name 'z' is not defined",
        location: { file: "ctrl.py", line: 10 },
        origin: "solver",
      },
    ]);
    const diagnostic = collection.entries.get("file:///project/ctrl.py")?.[0];
    expect(diagnostic?.message).toContain("NameError");
    expect(diagnostic?.message).toContain("raised in");
  });

  it("marks a compiler warning as a warning and an error as an error", () => {
    const collection = recorder();
    publishFailures(collection, withSheet(), [
      {
        message: "warning: unused variable 'q'",
        location: { file: "ctrl.c", line: 9, column: 1 },
        origin: "compiler",
      },
      {
        message: "error: use of undeclared identifier 'k'",
        location: { file: "ctrl.c", line: 7, column: 14 },
        origin: "compiler",
      },
    ]);
    const diagnostics = collection.entries.get("file:///project/ctrl.c");
    expect(diagnostics?.map((diagnostic) => diagnostic.severity)).toEqual(["warning", "error"]);
  });

  it("drops nothing it can place, and places nothing it cannot", () => {
    // An unsaved sheet or an imported netlist has no URI to fall back to. The output channel
    // still has the failure; this must not invent a file for it.
    const collection = recorder();
    const published = publishFailures(collection, placement(undefined), [unlocated]);
    expect(published.size).toBe(0);
    expect(collection.calls).toEqual(["clear"]);
  });

  it("never reports a negative line or column, whatever a tool claims", () => {
    // A tool that reported line 0 would otherwise wrap to the last line of the file, which is a
    // diagnostic pointing at innocent code.
    const collection = recorder();
    publishFailures(collection, withSheet(), [
      {
        message: "error: odd",
        location: { file: "ctrl.c", line: 0, column: 0 },
        origin: "compiler",
      },
    ]);
    const diagnostic = collection.entries.get("file:///project/ctrl.c")?.[0];
    expect(diagnostic?.line).toBe(0);
    expect(diagnostic?.character).toBe(0);
  });
});

describe("forgetFile", () => {
  it("takes a file's diagnostics away", () => {
    // Called when the file is edited: the moment the source changes the line numbers are stale,
    // and a diagnostic on the wrong line is a false accusation.
    const collection = recorder();
    publishFailures(collection, withSheet(), [located]);
    forgetFile(collection, "file:///project/dbl.m");
    expect(collection.entries.has("file:///project/dbl.m")).toBe(false);
  });
});

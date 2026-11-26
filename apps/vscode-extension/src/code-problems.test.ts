/**
 * #237 — the half that imports `vscode`, exercised end to end against real engine output.
 *
 * `code-diagnostics.test.ts` asserts the placement decision and `code-block-failure.test.ts`
 * the grammars. This asserts that the three fit together: real solver output in, a clickable
 * entry on the right file and line out, and the lifecycle that keeps a fixed error from
 * surviving as a squiggle.
 */
import { describe, expect, it } from "vitest";

import { CodeProblems } from "./code-problems";
import { type Diagnostic, createRecordingDiagnosticCollection } from "./test-support/vscode-stub";

/** The two slices of `vscode` `CodeProblems` touches, recording what it was handed. */
function host() {
  const collection = createRecordingDiagnosticCollection("Omni Schematics");
  let changed:
    | ((event: { document: { uri: unknown }; contentChanges: unknown[] }) => void)
    | undefined;
  return {
    collection,
    languages: { createDiagnosticCollection: () => collection },
    workspace: {
      onDidChangeTextDocument: (listener: typeof changed) => {
        changed = listener;
        return { dispose: () => {} };
      },
    },
    edit(uri: unknown) {
      changed?.({ document: { uri }, contentChanges: [{}] });
    },
    touchWithoutChanging(uri: unknown) {
      changed?.({ document: { uri }, contentChanges: [] });
    },
  };
}

const SHEET = {
  fsPath: "/project/sheet.gsim_sch",
  toString: () => "file:///project/sheet.gsim_sch",
};

// Real output, from `general-simulator` built at the head of the branch that made these errors
// sayable. Written as the array of lines a run's output arrives as.
const PYTHON_TRACEBACK = [
  "error: PyBlock(Exception): Python block ./ctrl_bad.py raised in `output`: Traceback (most recent call last):",
  '  File "./ctrl_bad.py", line 10, in output',
  "    return 2.0 * u + undefined_name",
  "                     ^^^^^^^^^^^^^^",
  "NameError: name 'undefined_name' is not defined",
];

const OCTAVE_RUNTIME = [
  "error: Octave(Runtime): Octave raised in /project/case/dbl_bad.m: 'nosuchvariable' undefined near line 3, column 13",
];

const MISSING_LIBRARY = [
  "error: CScript(Load): failed to load C-script library ./gain.so: dlopen failed: ./gain.so: cannot open shared object file: No such file or directory",
];

describe("CodeProblems", () => {
  it("puts an Octave failure on its own file and line, clickable", () => {
    const vs = host();
    const problems = new CodeProblems(vs.languages as never, vs.workspace as never);
    const count = problems.report(
      { workingDirectory: "/project/case", schematic: SHEET as never },
      OCTAVE_RUNTIME,
    );
    expect(count).toBe(1);
    const diagnostics = vs.collection.entries.get("file:///project/case/dbl_bad.m") as
      | Diagnostic[]
      | undefined;
    expect(diagnostics).toHaveLength(1);
    // 1-based from the tool, 0-based in the editor.
    expect(diagnostics?.[0]?.range.start.line).toBe(2);
    expect(diagnostics?.[0]?.range.start.character).toBe(12);
    expect(diagnostics?.[0]?.source).toBe("Omni Schematics");
  });

  it("resolves a relative path against the directory the solver ran in", () => {
    // `./ctrl_bad.py` is relative to the schematic's own folder, which is where the solver was
    // spawned (#234) -- not to the workspace root and not to this process's cwd.
    const vs = host();
    const problems = new CodeProblems(vs.languages as never, vs.workspace as never);
    problems.report(
      { workingDirectory: "/project/case", schematic: SHEET as never },
      PYTHON_TRACEBACK,
    );
    const diagnostics = vs.collection.entries.get("file:///project/case/ctrl_bad.py") as
      | Diagnostic[]
      | undefined;
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics?.[0]?.range.start.line).toBe(9);
    // The exception, which is on the traceback's last line rather than in the engine's own
    // sentence -- and is the whole reason anyone opens the entry.
    expect(diagnostics?.[0]?.message).toContain("NameError");
  });

  it("puts a failure with no file on the schematic rather than nowhere", () => {
    const vs = host();
    const problems = new CodeProblems(vs.languages as never, vs.workspace as never);
    const count = problems.report(
      { workingDirectory: "/project/case", schematic: SHEET as never },
      MISSING_LIBRARY,
    );
    expect(count).toBe(1);
    expect(vs.collection.entries.get("file:///project/sheet.gsim_sch")).toHaveLength(1);
  });

  it("reports a compiler diagnostic and a solver error in the same collection", () => {
    const vs = host();
    const problems = new CodeProblems(vs.languages as never, vs.workspace as never);
    const count = problems.report(
      { workingDirectory: "/project/case", schematic: SHEET as never },
      ["ctrl.c:7:14: error: use of undeclared identifier 'k'", ...OCTAVE_RUNTIME],
    );
    expect(count).toBe(2);
    expect(vs.collection.entries.get("file:///project/case/ctrl.c")).toHaveLength(1);
    expect(vs.collection.entries.get("file:///project/case/dbl_bad.m")).toHaveLength(1);
  });

  it("clears on a new run, so a fixed error does not survive as a squiggle", () => {
    const vs = host();
    const problems = new CodeProblems(vs.languages as never, vs.workspace as never);
    problems.report(
      { workingDirectory: "/project/case", schematic: SHEET as never },
      OCTAVE_RUNTIME,
    );
    problems.beginRun();
    expect(vs.collection.entries.size).toBe(0);
    // And a second report with nothing wrong leaves the panel empty rather than keeping the old.
    problems.report({ workingDirectory: "/project/case", schematic: SHEET as never }, ["t,V(n1)"]);
    expect(vs.collection.entries.size).toBe(0);
  });

  it("forgets a file's diagnostics when that file is edited", () => {
    const vs = host();
    const problems = new CodeProblems(vs.languages as never, vs.workspace as never);
    problems.report(
      { workingDirectory: "/project/case", schematic: SHEET as never },
      OCTAVE_RUNTIME,
    );
    const uri = { toString: () => "file:///project/case/dbl_bad.m" };
    vs.edit(uri);
    expect(vs.collection.entries.has("file:///project/case/dbl_bad.m")).toBe(false);
  });

  it("leaves them alone for an event that changed nothing", () => {
    // `onDidChangeTextDocument` fires for a dirty-flag change too. Clearing on those would make
    // a diagnostic vanish for no reason the user can see.
    const vs = host();
    const problems = new CodeProblems(vs.languages as never, vs.workspace as never);
    problems.report(
      { workingDirectory: "/project/case", schematic: SHEET as never },
      OCTAVE_RUNTIME,
    );
    vs.touchWithoutChanging({ toString: () => "file:///project/case/dbl_bad.m" });
    expect(vs.collection.entries.has("file:///project/case/dbl_bad.m")).toBe(true);
  });

  it("drops the collection and its subscription when disposed", () => {
    const vs = host();
    const problems = new CodeProblems(vs.languages as never, vs.workspace as never);
    problems.dispose();
    expect(vs.collection.calls).toContain("dispose");
  });

  it("steals no focus, which is the half the Problems panel cannot be trusted to do", () => {
    // Asserted against the module's own source, because the failure mode is someone adding a
    // `showTextDocument` later to be helpful: the canvas must stay where the user left it.
    //
    // Comments are stripped first. The module's own doc comment *names* those calls in order to
    // say it does not make them, and a check that matched the prose would be a check that can
    // only be satisfied by deleting the explanation.
    const source = (
      require("node:fs").readFileSync(
        require("node:path").join(__dirname, "code-problems.ts"),
        "utf8",
      ) as string
    )
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/[^\n]*/g, "");
    expect(source).not.toContain("showTextDocument");
    expect(source).not.toContain("revealRange");
    expect(source).not.toContain("executeCommand");
  });
});

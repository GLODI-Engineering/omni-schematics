/**
 * #237 — reading a code block's failure out of what the solver and the compiler printed.
 *
 * **Every fixture here is real output**, captured from `general-simulator` built at the head of
 * the branch that made these errors sayable (`general-simulator#121`/`#122`/`#123`) and from
 * this machine's own `cc`. That is not thoroughness for its own sake: the issue's examples were
 * written before those engine changes landed, and writing the parser against them would have
 * produced a parser for text the engine no longer prints.
 *
 * One of the grammars below was got wrong by doing exactly that, and the comment on it says so.
 */
import { describe, expect, it } from "vitest";

import { readCompilerDiagnostics, readSolverFailures } from "./code-block-failure";

describe("readSolverFailures", () => {
  it("finds nothing in the output of a run that worked", () => {
    expect(
      readSolverFailures([
        "found at /usr/local/bin/general-simulator (from PATH)",
        "working directory /project/case (the schematic's own folder)",
        "t,V(n1),V(n2),I(V1),VPROBE,G1",
      ]),
    ).toEqual([]);
  });

  /**
   * A Python runtime exception: the frames are on the lines *after* the error, and the **last**
   * one is where it was raised.
   */
  it("takes the innermost frame of a Python traceback", () => {
    const [failure] = readSolverFailures([
      "error: PyBlock(Exception): Python block ./ctrl_bad.py raised in `output`: Traceback (most recent call last):",
      '  File "./ctrl_bad.py", line 10, in output',
      "    return 2.0 * u + undefined_name",
      "                     ^^^^^^^^^^^^^^",
      "NameError: name 'undefined_name' is not defined",
    ]);
    expect(failure?.location).toEqual({ file: "./ctrl_bad.py", line: 10 });
    expect(failure?.origin).toBe("solver");
    // The exception is on the *last* line of the traceback, not in the engine's own sentence,
    // so it lands in `detail`. A Problems entry showing only `… raised in `output`: Traceback
    // (most recent call last):` names no exception at all, which is why the heading is trimmed
    // off the message and the frames are kept.
    expect(failure?.message).not.toMatch(/Traceback/);
    expect(failure?.detail).toContain("NameError");
    expect(failure?.detail).toContain('File "./ctrl_bad.py", line 10, in output');
  });

  it("takes the last frame, not the first, when a traceback has several", () => {
    const [failure] = readSolverFailures([
      "error: PyBlock(Exception): Python block ./ctrl.py raised in `output`: Traceback (most recent call last):",
      '  File "./ctrl.py", line 14, in output',
      "    return law(u)",
      '  File "./law.py", line 3, in law',
      "    return 1.0 / 0.0",
      "ZeroDivisionError: float division by zero",
    ]);
    // Frames run outermost first; the user's line is the deepest one.
    expect(failure?.location).toEqual({ file: "./law.py", line: 3 });
  });

  /**
   * The case a parser written from the issue's examples gets wrong.
   *
   * A `SyntaxError` has no traceback into the file that did not compile, so CPython's own
   * `File "...", line N` arrives **inside** the engine's sentence rather than on its own line. A
   * pattern anchored to the start of a line finds the runtime case above and silently misses
   * this one — which is the half that already half-worked before `general-simulator#122`, and so
   * exactly the half a test written from one example would have covered.
   */
  it("finds the line of a Python SyntaxError, which is inside the engine's own sentence", () => {
    const [failure] = readSolverFailures([
      'error: PyBlock(Load): failed to load Python block ./ctrl_syn.py:   File "./ctrl_syn.py", line 1',
      "    def start(:",
      "              ^",
      "SyntaxError: invalid syntax",
    ]);
    expect(failure?.location).toEqual({ file: "./ctrl_syn.py", line: 1 });
  });

  it("reads an Octave error's file, line and column off the one line it is all on", () => {
    const [failure] = readSolverFailures([
      "error: Octave(Runtime): Octave raised in /project/case/dbl_bad.m: 'nosuchvariable' undefined near line 3, column 13",
    ]);
    expect(failure?.location).toEqual({
      file: "/project/case/dbl_bad.m",
      line: 3,
      column: 13,
    });
  });

  it("reads an Octave path with a drive letter in it", () => {
    // The lazy match stops at the first `": "`, and a Windows drive colon is never followed by
    // a space -- so it cannot end the match early. Asserted rather than reasoned about.
    const [failure] = readSolverFailures([
      "error: Octave(Runtime): Octave raised in C:\\project\\dbl.m: 'x' undefined near line 7, column 2",
    ]);
    expect(failure?.location?.file).toBe("C:\\project\\dbl.m");
    expect(failure?.location?.line).toBe(7);
  });

  /**
   * The commonest class, and the one #237 is most about: a failure with **no** location.
   *
   * A missing library, a missing function, an arity disagreement — these are facts about the
   * document, not about a line in a source file. They come back with no location so the caller
   * can attach them to the `.gsim_sch`, which is clickable too. "Never nothing" is the rule.
   */
  it("returns a located-nowhere failure for the document-level errors", () => {
    const failures = readSolverFailures([
      "error: CScript(Load): failed to load C-script library ./gain.so: dlopen failed: ./gain.so: cannot open shared object file: No such file or directory",
      "error: CScriptArityMismatch: block `G1`'s C-script library declares 2 input(s) and 1 output(s) through `cscript_arity`, but the netlist wires 3 input(s) and 1 output(s) to it",
      "error: PythonSupportNotCompiledIn: block `G1` is a Python block, and this build of general-simulator cannot run one",
    ]);
    expect(failures).toHaveLength(3);
    for (const failure of failures) {
      expect(failure.location, failure.message).toBeUndefined();
    }
    // And the block name, where the engine quoted one, so the caller can mark it on the canvas.
    expect(failures[1]?.block).toBe("G1");
    expect(failures[2]?.block).toBe("G1");
    expect(failures[0]?.block).toBeUndefined();
  });

  it("keeps several failures apart, each with its own location", () => {
    const failures = readSolverFailures([
      "error: Octave(Runtime): Octave raised in /a/x.m: 'q' undefined near line 2, column 4",
      "error: PyBlock(Exception): Python block ./y.py raised in `output`: Traceback (most recent call last):",
      '  File "./y.py", line 9, in output',
      "NameError: name 'z' is not defined",
    ]);
    expect(failures.map((failure) => failure.location?.file)).toEqual(["/a/x.m", "./y.py"]);
  });

  it("does not mistake a compiler diagnostic for an engine error", () => {
    // gcc's form has the position *before* the word `error`, so it must not start a failure
    // here -- `readCompilerDiagnostics` owns it, and counting it twice would put two Problems
    // entries on one mistake.
    expect(readSolverFailures(["ctrl.c:7:14: error: use of undeclared identifier 'k'"])).toEqual(
      [],
    );
  });
});

describe("readCompilerDiagnostics", () => {
  it("reads gcc's file, line and column", () => {
    // Real `cc` output from this machine.
    const [diagnostic] = readCompilerDiagnostics([
      "/tmp/badc.c: In function ‘f’:",
      "/tmp/badc.c:1:20: error: ‘k’ undeclared (first use in this function)",
      "    1 | int f(void){return k;}",
      "      |                    ^",
    ]);
    expect(diagnostic?.location).toEqual({ file: "/tmp/badc.c", line: 1, column: 20 });
    expect(diagnostic?.message).toContain("undeclared");
    expect(diagnostic?.origin).toBe("compiler");
  });

  it("reads clang's form, which carries a column too", () => {
    const [diagnostic] = readCompilerDiagnostics([
      "ctrl.c:7:14: error: use of undeclared identifier 'k'",
    ]);
    expect(diagnostic?.location).toEqual({ file: "ctrl.c", line: 7, column: 14 });
  });

  it("reads MSVC's parenthesised form", () => {
    const [diagnostic] = readCompilerDiagnostics([
      "ctrl.c(7,14): error C2065: 'k': undeclared identifier",
      "ctrl.c(9): warning C4101: 'unused': unreferenced local variable",
    ]);
    expect(diagnostic?.location).toEqual({ file: "ctrl.c", line: 7, column: 14 });
    const [, warning] = readCompilerDiagnostics([
      "ctrl.c(7,14): error C2065: 'k': undeclared identifier",
      "ctrl.c(9): warning C4101: 'unused': unreferenced local variable",
    ]);
    // A column-less MSVC diagnostic is still placeable, on the line.
    expect(warning?.location).toEqual({ file: "ctrl.c", line: 9 });
  });

  it("drops note lines, which are continuations rather than mistakes", () => {
    // One entry per note turns a single mistake into five, which is how a Problems panel stops
    // being read.
    const diagnostics = readCompilerDiagnostics([
      "ctrl.c:7:14: error: no matching function for call to 'law'",
      "law.h:3:5: note: candidate function not viable",
      "ctrl.c:9:1: warning: unused variable 'q'",
    ]);
    expect(diagnostics).toHaveLength(2);
    expect(diagnostics.map((diagnostic) => diagnostic.message[0])).toEqual(["e", "w"]);
  });

  it("finds nothing in a build that said nothing", () => {
    expect(readCompilerDiagnostics([])).toEqual([]);
    expect(readCompilerDiagnostics(["cc -shared -fPIC -o libctrl.so ctrl.c -lm"])).toEqual([]);
  });

  it("keeps a Windows absolute path intact despite its drive colon", () => {
    const [diagnostic] = readCompilerDiagnostics([
      "C:\\project\\ctrl.c(7,14): error C2065: 'k': undeclared identifier",
    ]);
    expect(diagnostic?.location?.file).toBe("C:\\project\\ctrl.c");
  });
});

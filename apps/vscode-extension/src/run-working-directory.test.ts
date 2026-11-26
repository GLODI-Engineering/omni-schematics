/**
 * #234 — reading a compiled netlist for the paths that depend on the working directory.
 *
 * `run-simulation.test.ts` asserts the decision end to end, including against a real solver and
 * a real compiled block. This file is about the netlist scan underneath it, which is where the
 * edge cases are: a quoted path with a space in it (this machine's own paths have one), a
 * Windows absolute path read on Linux, a comment line, a `cscript` block whose parameter is
 * `lib` rather than `path`.
 */
import { describe, expect, it } from "vitest";

import { codeBlocksIn, workingDirectoryFor } from "./run-working-directory";

const RC = [
  "* A textbook RC low-pass.",
  "V1 n1 0 SIN(0 1 1k)",
  "R1 n1 n2 1k",
  "C1 n2 0 1u",
  "VPROBE kind=phys2sig node=n2",
].join("\n");

describe("codeBlocksIn", () => {
  it("finds nothing in a sheet of passives", () => {
    expect(codeBlocksIn(RC)).toEqual([]);
  });

  it("reads a cscript block's `lib`, not a `path` it does not have", () => {
    const [block] = codeBlocksIn(`${RC}\nG1 kind=cscript lib=./ctrl.so in=VPROBE outputs=y\n`);
    expect(block).toEqual({
      block: "G1",
      kind: "cscript",
      parameter: "lib",
      value: "./ctrl.so",
      relative: true,
    });
  });

  it("reads each of the four `path`-carrying kinds", () => {
    for (const kind of ["pyblock", "pyfunc", "octfunc", "octblock"] as const) {
      const [block] = codeBlocksIn(`${RC}\nG1 kind=${kind} path=blocks/ctrl in=VPROBE\n`);
      expect(block?.kind, kind).toBe(kind);
      expect(block?.parameter, kind).toBe("path");
      expect(block?.value, kind).toBe("blocks/ctrl");
      expect(block?.relative, kind).toBe(true);
    }
  });

  it("keeps the spaces in a quoted path, because this machine's own paths have one", () => {
    const [block] = codeBlocksIn(
      `${RC}\nG1 kind=pyblock path="a lib dir/ctrl.py" in=VPROBE outputs=y\n`,
    );
    expect(block?.value).toBe("a lib dir/ctrl.py");
    expect(block?.relative).toBe(true);
  });

  it("knows an absolute path does not depend on the working directory", () => {
    for (const absolute of ["/project/ctrl.py", "C:/project/ctrl.py", "C:\\project\\ctrl.py"]) {
      const [block] = codeBlocksIn(`${RC}\nG1 kind=pyblock path=${absolute} in=VPROBE\n`);
      expect(block?.relative, absolute).toBe(false);
    }
  });

  it("ignores comments and dot-commands", () => {
    const netlist = [
      "* G1 kind=pyblock path=./not-real.py -- a comment, not a block",
      ".include other.cir",
      "R1 a b 1k",
    ].join("\n");
    expect(codeBlocksIn(netlist)).toEqual([]);
  });

  it("finds every block on a sheet, not only the first", () => {
    const netlist = [
      RC,
      "G1 kind=pyblock path=./a.py in=VPROBE outputs=y",
      "G2 kind=octfunc path=/abs/b.m function=b in=VPROBE outputs=z",
      "G3 kind=cscript lib=./c.so in=VPROBE outputs=w",
    ].join("\n");
    const found = codeBlocksIn(netlist);
    expect(found.map((block) => block.block)).toEqual(["G1", "G2", "G3"]);
    expect(found.map((block) => block.relative)).toEqual([true, false, true]);
  });

  it("treats a block with no path at all as nothing to resolve", () => {
    // An empty `lib=` is what a freshly dropped `cscript` block carries before the user fills
    // it in. There is no path to resolve, so it must not refuse an unsaved sheet.
    const [block] = codeBlocksIn(`${RC}\nG1 kind=cscript lib= in=VPROBE outputs=y\n`);
    expect(block?.value).toBe("");
    expect(block?.relative).toBe(false);
  });
});

describe("workingDirectoryFor", () => {
  it("takes the schematic's folder whenever there is one", () => {
    const decision = workingDirectoryFor({
      netlist: RC,
      schematicFolder: "/project/case",
      runDirectory: "/project/.gsim/runs/r1",
    });
    expect(decision.ok).toBe(true);
    if (!decision.ok) return;
    expect(decision.cwd).toBe("/project/case");
    // Not only when a code block is present: every relative path a netlist carries is written
    // relative to the sheet, and one rule is easier to reason about than a rule that changes
    // with the contents of the sheet.
    expect(decision.note).toContain("/project/case");
  });

  it("falls back to the run directory for an unsaved sheet with nothing to resolve", () => {
    const decision = workingDirectoryFor({
      netlist: RC,
      schematicFolder: undefined,
      runDirectory: "/tmp/runs/r1",
    });
    expect(decision.ok).toBe(true);
    if (!decision.ok) return;
    expect(decision.cwd).toBe("/tmp/runs/r1");
  });

  it("refuses an unsaved sheet whose block names a relative path, naming the block", () => {
    const decision = workingDirectoryFor({
      netlist: `${RC}\nG1 kind=cscript lib=./ctrl.so in=VPROBE outputs=y\n`,
      schematicFolder: undefined,
      runDirectory: "/tmp/runs/r1",
    });
    expect(decision.ok).toBe(false);
    if (decision.ok) return;
    expect(decision.summary).toBe("Save the schematic before running a code block");
    expect(decision.detail).toContain("G1");
    expect(decision.detail).toContain("lib=./ctrl.so");
  });

  it("names every unresolvable block, not just one", () => {
    const decision = workingDirectoryFor({
      netlist: [
        RC,
        "G1 kind=pyblock path=./a.py in=VPROBE outputs=y",
        "G2 kind=octfunc path=./b.m function=b in=VPROBE outputs=z",
      ].join("\n"),
      schematicFolder: undefined,
      runDirectory: "/tmp/runs/r1",
    });
    expect(decision.ok).toBe(false);
    if (decision.ok) return;
    expect(decision.detail).toContain("G1");
    expect(decision.detail).toContain("G2");
  });

  it("lets an unsaved sheet through when every block is absolute", () => {
    const decision = workingDirectoryFor({
      netlist: `${RC}\nG1 kind=pyblock path=/abs/ctrl.py in=VPROBE outputs=y\n`,
      schematicFolder: undefined,
      runDirectory: "/tmp/runs/r1",
    });
    expect(decision.ok).toBe(true);
  });

  it("treats an empty folder string as no folder", () => {
    // `folderOf` returns a URI whose `fsPath` can be empty for an `untitled:` document, and an
    // empty `cwd` is not a directory -- `spawn` would reject it.
    const decision = workingDirectoryFor({
      netlist: RC,
      schematicFolder: "",
      runDirectory: "/tmp/runs/r1",
    });
    expect(decision.ok).toBe(true);
    if (!decision.ok) return;
    expect(decision.cwd).toBe("/tmp/runs/r1");
  });
});

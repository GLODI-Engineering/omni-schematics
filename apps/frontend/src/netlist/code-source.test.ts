/**
 * #212 — which file a scripted block's double-click opens, and what goes in it
 * when there is nothing there.
 *
 * The round trips below are the point of the file. Each stub is read back by
 * `code-ports.ts` — the parser the Inspector already uses to tell the user what
 * ports a source declares — and has to yield the ports the block carries.
 * Without that, a freshly created file is one the editor immediately reports as
 * disagreeing with its own block, which is a worse first impression than no
 * file at all.
 */
import { describe, expect, it } from "vitest";

import { derivePortsFor } from "./code-ports";
import {
  type ScriptedBlock,
  isScriptedBlockType,
  scriptedSourceFor,
  sourceStub,
} from "./code-source";

const block = (type: string, params: Record<string, unknown> = {}): ScriptedBlock => ({
  id: "ctrl",
  type,
  params: { input_names: ["u1", "u2"], output_names: ["y1"], ...params },
});

describe("isScriptedBlockType", () => {
  it("knows the five extensibility blocks and nothing else", () => {
    for (const type of [
      "extensibility.cscript",
      "extensibility.pyblock",
      "extensibility.pyfunc",
      "extensibility.octblock",
      "extensibility.octfunc",
    ]) {
      expect(isScriptedBlockType(type), type).toBe(true);
    }
    expect(isScriptedBlockType("physical-electrical.passive.resistor")).toBe(false);
    expect(isScriptedBlockType("hierarchy.subsystem.virtual")).toBe(false);
  });
});

describe("scriptedSourceFor", () => {
  it("opens what a path-carrying block points at", () => {
    const source = scriptedSourceFor(block("extensibility.pyfunc", { path: "blocks/ctrl.py" }));
    expect(source?.candidates).toEqual(["blocks/ctrl.py"]);
    expect(source?.inferred).toBe(false);
  });

  it("opens the function file inside an octblock's directory, not the directory", () => {
    // `octblock`'s `path` is a folder holding `<function>_start.m` and
    // `<function>.m`; opening the folder in a text editor opens nothing.
    const source = scriptedSourceFor(
      block("extensibility.octblock", { path: "blocks/ctrl", function: "ctrl" }),
    );
    expect(source?.candidates).toEqual(["blocks/ctrl/ctrl.m"]);
  });

  it("offers nothing for a block whose path is still empty", () => {
    // The answer to "this block has no source" is the Inspector's Path field,
    // not a file the user never asked for.
    expect(scriptedSourceFor(block("extensibility.pyfunc", { path: "" }))).toBeNull();
    expect(scriptedSourceFor(block("extensibility.pyblock", {}))).toBeNull();
  });

  it("is not a scripted block at all when the type is something else", () => {
    expect(scriptedSourceFor(block("physical-electrical.passive.resistor"))).toBeNull();
  });

  /**
   * The case the brief's own description gets wrong, and the reason this
   * returns a list: `extensibility.cscript` takes `lib`, a compiled
   * `.so`/`.dylib`/`.dll`. The engine loads a binary and never compiles
   * anything, so a cscript block names no source and the source has to be
   * found by convention.
   */
  it("follows a convention for cscript, whose parameter is a compiled library", () => {
    const source = scriptedSourceFor(block("extensibility.cscript", { lib: "build/ctrl.so" }));
    expect(source?.inferred).toBe(true);
    expect(source?.candidates).toContain("blocks/ctrl.c");
    expect(source?.candidates).toContain("build/ctrl.c");
    expect(source?.candidates).toContain("ctrl.c");
    expect(source?.candidates).toContain("blocks/ctrl.cpp");
    // What a "create it?" offer would write.
    expect(source?.create).toBe("blocks/ctrl.c");
    expect(source?.create).toBe(source?.candidates[0]);
  });

  it("falls back to the block's own name when cscript has no library yet", () => {
    const source = scriptedSourceFor(block("extensibility.cscript", { lib: "" }));
    expect(source?.create).toBe("blocks/ctrl.c");
  });

  it("never offers to *create* a file outside the project, whatever the parameter says", () => {
    // Whether a path may be opened is the host's call and only the host's —
    // it is the side that can see the workspace. But the file this would
    // offer to write is composed here, and it must land in the project
    // however hostile the document's parameter is.
    const source = scriptedSourceFor(block("extensibility.cscript", { lib: "../../etc/passwd" }));
    expect(source?.create).toBe("blocks/passwd.c");
    expect(source?.create.split("/")).not.toContain("..");
  });
});

describe("sourceStub", () => {
  it("writes C whose declared arity is the block's own, as the engine checks it", () => {
    const b = block("extensibility.cscript", { lib: "build/ctrl.so" });
    const stub = sourceStub(b);
    expect(stub).toContain("int cscript_arity(int *in_len, int *out_len)");

    const parsed = derivePortsFor(b.type, stub);
    expect(parsed.inputs).toHaveLength(2);
    expect(parsed.outputs).toHaveLength(1);
    expect(parsed.note).toContain("cscript_arity");
  });

  it("writes a pyfunc whose signature is the block's input names, by position", () => {
    const b = block("extensibility.pyfunc", { path: "blocks/ctrl.py", function: "ctrl" });
    const parsed = derivePortsFor(b.type, sourceStub(b), "ctrl");
    expect(parsed.inputs).toEqual(["u1", "u2"]);
    expect(parsed.outputs).toHaveLength(1);
  });

  it("writes Octave declaring both sides by name, which is the complete case", () => {
    const b = block("extensibility.octfunc", { path: "ctrl.m", function: "ctrl" });
    const parsed = derivePortsFor(b.type, sourceStub(b), "ctrl");
    expect(parsed.inputs).toEqual(["u1", "u2"]);
    expect(parsed.outputs).toEqual(["y1"]);
  });

  /**
   * `pyblock`'s contract is `output(state, t, dt, inputs)` with `inputs` a
   * positional list, so the signature cannot carry port names and the parser
   * correctly declines to invent them. The stub still unpacks them by name in
   * the body, which is the part a person reads.
   */
  it("writes a pyblock with the real port names in the unpacking line", () => {
    const stub = sourceStub(block("extensibility.pyblock", { path: "blocks/ctrl.py" }));
    expect(stub).toContain("def start():");
    expect(stub).toContain("def output(state, t, dt, inputs):");
    expect(stub).toContain("u1, u2 = inputs");
  });

  it("unpacks a single input without producing a syntax error", () => {
    const stub = sourceStub(
      block("extensibility.pyblock", { path: "p.py", input_names: ["u"], output_names: ["y"] }),
    );
    // `u = inputs` would bind the list; `u, = inputs` unpacks it.
    expect(stub).toContain("u, = inputs");
  });

  it("falls back to named ports rather than emitting an empty signature", () => {
    const stub = sourceStub(
      block("extensibility.octfunc", {
        path: "ctrl.m",
        function: "ctrl",
        input_names: [],
        output_names: [],
      }),
    );
    expect(stub).toContain("function [y1] = ctrl(u1)");
  });
});

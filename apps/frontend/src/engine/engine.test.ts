/**
 * The editor's own compiler, compiling the editor's own examples.
 *
 * `scripts/check-examples.mjs` already holds every example to its recorded
 * netlist, byte for byte — but it does so from a bare Node script. This asserts
 * the same thing from inside the frontend's module graph: that
 * `@gensim/gsim-wasm` resolves through Vite, instantiates, and produces the
 * netlist the gate expects. A packaging mistake that leaves the webview unable
 * to reach the engine fails here rather than at someone's first click on Run.
 *
 * ## Why the bytes are read here instead of letting the loader fetch
 *
 * The bundle is `wasm-pack --target web` output: its loader fetches a URL,
 * which is right in a webview and wrong under jsdom, where `?url` resolves to
 * an `/@fs/...` path that `fetch` refuses. `initEngine` takes an optional
 * source for exactly this, and this file is its only caller — the webview never
 * passes one.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { beforeAll, describe, expect, it } from "vitest";

import type { Engine } from "@gensim/gsim-wasm/compile";
import { compileSchematic, initEngine, resetEngineForTests } from "./engine";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
const EXAMPLES = join(REPO_ROOT, "examples");
const EXPECTED = join(EXAMPLES, "expected-netlists");
const WASM = join(REPO_ROOT, "packages", "gsim-wasm", "pkg", "gsim_wasm_bg.wasm");

const NAMES = ["buck_converter", "boost_converter", "llc_converter", "pfc_boost", "psfb_converter"];

let engine: Engine;

beforeAll(async () => {
  resetEngineForTests();
  const bytes = readFileSync(WASM);
  engine = await initEngine(new Uint8Array(bytes));
}, 30_000);

describe("the engine in the editor", () => {
  it("reports the version the committed bundle was built from", () => {
    const provenance = JSON.parse(
      readFileSync(join(REPO_ROOT, "packages", "gsim-wasm", "provenance.json"), "utf8"),
    );
    expect(engine.version()).toBe(provenance.engine.version);
  });

  it("exports compile, loadDocument, catalog and capabilities", () => {
    for (const name of ["compile", "loadDocument", "catalog", "capabilities"] as const) {
      expect(typeof engine[name]).toBe("function");
    }
  });

  it.each(NAMES)("compiles %s to its recorded netlist, byte for byte", (name) => {
    const document = readFileSync(join(EXAMPLES, `${name}.gsim_sch`), "utf8");
    const { netlist, notes } = compileSchematic(engine, JSON.parse(document));

    expect(netlist).toBe(readFileSync(join(EXPECTED, `${name}.net`), "utf8"));
    expect(notes.map((note) => `${note}\n`).join("")).toBe(
      readFileSync(join(EXPECTED, `${name}.notes.txt`), "utf8"),
    );
  });

  it("compiles the bare model the store holds, not only a whole document", () => {
    // What Run actually passes: `useGraphStore.getState().document.model`,
    // deliberately the inner model. It has to reach the same netlist as the
    // document around it, or the gate above would be checking a route the
    // product does not take -- which is the whole of #143.
    const document = JSON.parse(readFileSync(join(EXAMPLES, "buck_converter.gsim_sch"), "utf8"));
    const fromModel = compileSchematic(engine, document.model);

    expect(fromModel.netlist).toBe(readFileSync(join(EXPECTED, "buck_converter.net"), "utf8"));
  });

  it("throws the engine's own message for a document it cannot compile", () => {
    // A real example with one block's type replaced, so the error comes from
    // the netlist emitter rather than from schema validation -- `unknown-type`
    // naming the block and the type, which is what Run puts in the Problems
    // panel. The whole reason the compile moved into the editor is that this
    // sentence now reaches the user without a kernel in between.
    const document = JSON.parse(readFileSync(join(EXAMPLES, "buck_converter.gsim_sch"), "utf8"));
    document.model.blocks[0].type = "passive.not_a_real_type";

    expect(() => compileSchematic(engine, document)).toThrow(/not_a_real_type/);
  });

  it("rejects a document the schema does not accept, before compiling it", () => {
    // `loadDocument` first, `compile` second -- so a malformed document is
    // named as malformed instead of producing a confusing compile error. The
    // route is `packages/gsim-wasm/compile.js`, shared with the gates.
    expect(() =>
      compileSchematic(engine, { id: "m", name: "m", blocks: [{ id: "b1" }] }),
    ).toThrow();
  });
});

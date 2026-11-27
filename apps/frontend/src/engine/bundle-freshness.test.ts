/**
 * The committed engine is held to the engine's *code*, not to its latest commit (#280).
 *
 * `packages/gsim-wasm/pkg/` is a 1.8 MB binary in the source tree, and the thing that keeps it
 * from becoming a fork of the engine nobody noticed is `check-gsim-wasm-fresh.mjs`. That gate
 * used to ask "is the pinned commit `gsim-core`'s default-branch HEAD?", which is a proxy for
 * the question it means — "is this bundle built from the engine's current code?" — and the proxy
 * over-fires on every commit that is not engine code. It reddened this repository three times on
 * 2026-11-26, once for a **decision record**.
 *
 * The cost was not noise. Clearing it means rebuilding and committing a 1.8 MB binary, so a gate
 * that is red for reasons unrelated to the change in front of you is a gate people learn to
 * merge past. It blocked #284, which touches no engine code at all.
 *
 * So the rules below are asserted against **real `gsim-core` history** — five commits whose
 * trees are recorded in `__fixtures__/engine-trees`, one per line as a git blob hash and a path,
 * which is what `git ls-tree` gives the build script and what the GitHub tree API gives the
 * gate. #280 asked for three things to be true, and each has a test here:
 *
 *   a gsim-core merge with no engine code leaves this green
 *   a merge that touches engine code reds it
 *   a bundle built from stale or uncommitted sources still fails
 */

import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  ENGINE_CODE_PATHS,
  changedPaths,
  engineCodeFingerprint,
  isEngineCode,
} from "../../../../scripts/build-gsim-wasm.mjs";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "__fixtures__/engine-trees");

/** One recorded `gsim-core` tree as `[{path, sha}]`, the shape both producers hand over. */
function tree(commit: string): { path: string; sha: string }[] {
  return readFileSync(join(FIXTURES, `${commit}.txt`), "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => {
      const [sha, ...rest] = line.split(" ");
      return { sha: sha as string, path: rest.join(" ") };
    });
}

const digestOf = (commit: string) => engineCodeFingerprint(tree(commit)).digest;

describe("which engine files the bundle is built from", () => {
  it("counts the crate, the engine's source, the embedded catalogue and the manifests", () => {
    expect([...ENGINE_CODE_PATHS]).toEqual([
      "crates/gsim-wasm/",
      "crates/gsim-core/src/",
      "crates/gsim-core/data/",
      "crates/gsim-core/Cargo.toml",
      "Cargo.toml",
    ]);
  });

  it("counts data/component-library.json, which #280 asked about by name", () => {
    // It is `include_str!`-ed into the crate, so a catalogue change does change what the bundle
    // does. This is the one inclusion that is not obvious from the word "code".
    expect(isEngineCode("crates/gsim-core/data/component-library.json")).toBe(true);
  });

  it("does not count what cannot reach the binary", () => {
    for (const path of [
      "docs/decisions/0010-who-owns-the-catalogue.md",
      "docs/journal/2026-11.md",
      "examples/nested_subckt_ladder.cir",
      "crates/gsim-core/tests/the_ideal_devices_are_not_passive.rs",
      "crates/gsim-py/src/lib.rs",
      "README.md",
      ".github/workflows/ci.yml",
    ]) {
      expect(isEngineCode(path), path).toBe(false);
    }
  });

  it("selects a real number of files out of a real tree", () => {
    // Before any digest is believed. A fingerprint over an empty selection is a digest that
    // matches another digest over an empty selection, which is a gate passing because it looked
    // at no files — the shape this repository has shipped four times.
    const fingerprint = engineCodeFingerprint(tree("6f8d1b0"));
    expect(fingerprint.paths).toBe(38);
    expect(tree("6f8d1b0").length).toBeGreaterThan(fingerprint.paths);
  });

  it("refuses to fingerprint nothing", () => {
    expect(() => engineCodeFingerprint([{ path: "docs/only.md", sha: "0".repeat(40) }])).toThrow(
      /would make this gate pass while checking nothing/,
    );
  });

  it("keeps a fixture for every commit the rules below name", () => {
    const recorded = readdirSync(FIXTURES)
      .filter((name) => name.endsWith(".txt"))
      .map((name) => name.replace(/\.txt$/, ""))
      .sort();
    expect(recorded).toEqual(["2b1cc2a", "3df5e09", "4e30fd6", "6f8d1b0", "872efda"]);
  });
});

describe("a gsim-core merge that moves no engine code", () => {
  it("leaves the decision record that reddened this CI green", () => {
    // `872efda` is `docs(decisions): 0010, who owns the catalogue` — 156 lines of Markdown, one
    // file, no engine code. It moved HEAD, so the old gate went red and the bundle had to be
    // rebuilt and recommitted to clear it. This is #280's first "done when".
    expect(digestOf("872efda")).toBe(digestOf("2b1cc2a"));
  });

  it("leaves a netlist regeneration green", () => {
    // `2b1cc2a` is `fix(examples): regenerate the netlists the version bump changed` — seven
    // `.cir` files under `examples/`, which the bundle cannot read.
    expect(digestOf("2b1cc2a")).toBe(digestOf("4e30fd6"));
  });

  it("says so for all three in one line, so the chain is visible", () => {
    const chain = ["4e30fd6", "2b1cc2a", "872efda"].map(digestOf);
    expect(new Set(chain).size).toBe(1);
  });
});

describe("a gsim-core merge that does move engine code", () => {
  it("reds on the catalogue split, and names the files", () => {
    // `6f8d1b0` is `feat(library)!: the catalogue declares specifications, not drawings` — it
    // took 1,467 lines out of the embedded component library and four fields out of a Rust
    // struct. #280's second "done when".
    expect(digestOf("6f8d1b0")).not.toBe(digestOf("3df5e09"));
    const moved = changedPaths(
      engineCodeFingerprint(tree("3df5e09")).blobs,
      engineCodeFingerprint(tree("6f8d1b0")).blobs,
    );
    expect(moved).toEqual([
      "changed: crates/gsim-core/data/component-library.json",
      "changed: crates/gsim-core/src/compile/library.rs",
    ]);
    // And not the test file the same commit touched, which the bundle does not compile.
    expect(moved.join("\n")).not.toContain("tests/the_ideal_devices_are_not_passive.rs");
  });

  it("reds on a version bump, because the version reaches a netlist", () => {
    // `3df5e09` is `chore(release): 0.7.1`. Every emitted deck carries
    // `generated by gsim-core <version>`, so a release chore does change the bundle's output
    // even when no logic moved — which is why `Cargo.toml` is in the selection.
    expect(digestOf("3df5e09")).not.toBe(digestOf("872efda"));
    const moved = changedPaths(
      engineCodeFingerprint(tree("872efda")).blobs,
      engineCodeFingerprint(tree("3df5e09")).blobs,
    );
    expect(moved.join("\n")).toContain("crates/gsim-core/Cargo.toml");
  });

  it("names added and removed files, not only changed ones", () => {
    const before = engineCodeFingerprint(tree("6f8d1b0")).blobs;
    const after = before
      .filter((blob) => !blob.path.endsWith("data/component-library.json"))
      .concat({ path: "crates/gsim-core/src/compile/rating.rs", sha: "f".repeat(40) });
    expect(changedPaths(before, after)).toEqual([
      "added:   crates/gsim-core/src/compile/rating.rs",
      "removed: crates/gsim-core/data/component-library.json",
    ]);
  });
});

describe("the bundle in this repository", () => {
  const provenance = JSON.parse(
    readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), "../../../../packages/gsim-wasm/provenance.json"),
      "utf8",
    ),
  );

  it("records a fingerprint the gate can compare, over the paths it now uses", () => {
    // A digest over a different selection is not comparable with this one, so the selection is
    // part of what is recorded and the gate refuses a mismatch rather than comparing two
    // different questions.
    expect(provenance.engine.code_fingerprint.digest).toMatch(/^[0-9a-f]{64}$/);
    expect(provenance.engine.code_fingerprint.paths).toBe(38);
    expect(provenance.engine.code_fingerprint.inputs).toEqual([...ENGINE_CODE_PATHS]);
  });

  it("was not built from a checkout with uncommitted engine changes", () => {
    // #280's third "done when", and the one a content comparison could otherwise be gamed by: a
    // fingerprint is read out of git, so uncommitted work in the engine checkout is invisible to
    // it. The build script records what it saw; the gate refuses a bundle marked dirty.
    expect(provenance.engine.code_fingerprint.dirty).toBeUndefined();
  });

  it("is a fingerprint of the commit it names", () => {
    // Asserted here against the recorded tree when the pinned commit happens to be one of the
    // fixtures; the gate asserts it against the engine's own tree on every CI run, which is the
    // version that cannot be satisfied by editing a file in this repository.
    const pinned = provenance.engine.commit.slice(0, 7);
    const known = readdirSync(FIXTURES).includes(`${pinned}.txt`);
    if (known) expect(provenance.engine.code_fingerprint.digest).toBe(digestOf(pinned));
    else expect(provenance.engine.commit).toMatch(/^[0-9a-f]{40}$/);
  });
});

#!/usr/bin/env node
/**
 * Build the decimator to WebAssembly and commit the result.
 *
 * `crates/waveform-store` is the one implementation of "give me this window
 * of these signals, at most this many points" — natively for a server, and
 * here, as WebAssembly, for the viewer. This script is what makes the second
 * half of that sentence true: before it, the crate was imported by nothing
 * and the browser ran a hand-maintained TypeScript copy of its envelope
 * (#157).
 *
 * ## Why it follows `build-gsim-wasm.mjs` rather than inventing a pattern
 *
 * #158 settled this for the engine: the bundle is **committed**, binary and
 * all, because the alternative is a Rust toolchain plus `wasm-pack` on the
 * way to every `pnpm --filter @gensim/frontend build` — in the `frontend`
 * job, the `vscode-extension` job, the `e2e` job, a contributor's first
 * checkout, and the watch loop of anyone editing a React component. It is
 * the same trade `apps/vscode-extension/media/frontend` already makes and it
 * carries the same risk: a generated artefact in the tree can quietly stop
 * matching its source. `scripts/check-waveform-wasm-fresh.mjs` is what holds
 * it, and it is not optional.
 *
 * ## The one way this differs from the engine's bundle
 *
 * The engine lives in another repository, so its gate has to ask "is
 * `gsim-core`'s default branch still the commit this was built from?" over
 * the network. This crate is **in this repository**, which makes that arm
 * both unnecessary and weaker than what is available: the gate can hash the
 * crate's own sources and rebuild from them. So `provenance.json` records a
 * digest of `Cargo.toml`, `Cargo.lock` and every file under `src/`, and a
 * change to any of them makes the committed bundle stale in the same commit
 * that caused it — not a day later when a remote branch moves.
 *
 * Usage:
 *   node scripts/build-waveform-wasm.mjs                 # into the package
 *   node scripts/build-waveform-wasm.mjs --out /tmp/pkg   # somewhere else
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from "node:fs";
import { writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..");

/** The crate built here. In this repository, which is the whole difference. */
export const CRATE_DIR = join(REPO_ROOT, "crates", "waveform-store");
/** Where the committed bundle lives. */
export const BUNDLE_DIR = join(REPO_ROOT, "packages", "waveform-wasm");

/**
 * The files `wasm-pack --target web` emits that this repository keeps.
 *
 * `README.md`, `package.json` and `.gitignore` are also emitted and are
 * deliberately not kept: the first is the crate's, and the other two are this
 * package's own and are hand-written (see `packages/waveform-wasm/`).
 */
export const KEPT_FILES = [
  "waveform_store.js",
  "waveform_store.d.ts",
  "waveform_store_bg.wasm",
  "waveform_store_bg.wasm.d.ts",
];

/**
 * The surface the viewer cannot work without.
 *
 * Named so that a build which dropped one fails with that word in the
 * message instead of a count. `plan`/`slice` are methods rather than free
 * functions, so they are checked inside the class declaration.
 */
export const REQUIRED_EXPORTS = ["FetchedRanges", "SamplesFile", "WaveformStore", "minmaxEnvelope"];

/**
 * Size is a user-visible cost, not a build statistic: the `.wasm` ships
 * inside the .vsix and the webview fetches it when a result is opened.
 *
 * Unlike the engine's, these live in the crate's own `[profile.release]` —
 * the manifest being built belongs to this repository, so there is a file to
 * put them in and the bundle stays reproducible from its own sources.
 */

export function sha256(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

/**
 * Every file the build reads, as `path -> sha256`.
 *
 * `Cargo.lock` is in here on purpose, and the reason changed with #204. It
 * used to be that `gsim-samples` came from a git URL, which made the lock the
 * *only* record of which `gsim-samples` the committed bundle contained: the
 * manifest named a repository and nothing else, so two builds months apart
 * read the same `Cargo.toml` and linked different code.
 *
 * `gsim-samples` is a registry dependency now, so the manifest does say
 * something — but it says `"0.1"`, a range. The lock is still the record of
 * *which* version in that range was actually built, and of its checksum. A
 * `cargo update` that moves it inside the range leaves `Cargo.toml` untouched,
 * and without the lock in this digest the gate would call the old bundle fresh
 * while the viewer decimated with a `.gsim_samples` reader the crate's own
 * `cargo test` no longer exercises. That is the failure this guards; what
 * narrowed is only how far it can drift unnoticed, from any commit of a
 * repository to a patch release of one crate.
 */
export function crateSources(crateDir = CRATE_DIR) {
  const files = {};
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
      a.name < b.name ? -1 : 1,
    )) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile()) files[relative(crateDir, path).split(sep).join("/")] = sha256(path);
    }
  };
  for (const name of ["Cargo.toml", "Cargo.lock"]) {
    const path = join(crateDir, name);
    if (existsSync(path)) files[name] = sha256(path);
  }
  walk(join(crateDir, "src"));
  return files;
}

/** One digest over {@link crateSources}, so the gate compares a single string. */
export function sourceDigest(sources) {
  const hash = createHash("sha256");
  for (const [path, digest] of Object.entries(sources).sort(([a], [b]) => (a < b ? -1 : 1))) {
    hash.update(`${path}\0${digest}\0`);
  }
  return hash.digest("hex");
}

/**
 * The names the bundle exports, read out of the generated `.d.ts`.
 *
 * Both functions and classes, because this crate's surface is mostly
 * classes — `SamplesFile` and `FetchedRanges` are the two the viewer holds.
 * Read from the generated declarations rather than from `wasm.rs` so that
 * this is a fact about the artefact: a build that dropped an export says so
 * here, where a regex over the source would still report the full list.
 */
export function exportedSymbols(dtsPath) {
  const text = readFileSync(dtsPath, "utf8");
  const names = new Set();
  for (const match of text.matchAll(/^export function ([A-Za-z_$][\w$]*)\s*\(/gm)) {
    names.add(match[1]);
  }
  for (const match of text.matchAll(/^export class ([A-Za-z_$][\w$]*)/gm)) {
    names.add(match[1]);
  }
  // wasm-bindgen's own loader entry points, not crate surface.
  for (const glue of ["initSync", "__wbg_init"]) {
    names.delete(glue);
  }
  return [...names].sort();
}

function crateVersion(crateDir) {
  const manifest = readFileSync(join(crateDir, "Cargo.toml"), "utf8");
  return manifest.match(/^version\s*=\s*"([^"]+)"/m)?.[1] ?? "unknown";
}

function arg(name, fallback = null) {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

export function buildBundle({ crateDir = CRATE_DIR, out = BUNDLE_DIR } = {}) {
  if (!existsSync(join(crateDir, "Cargo.toml"))) {
    throw new Error(`${crateDir} has no Cargo.toml`);
  }
  const version = crateVersion(crateDir);
  const sources = crateSources(crateDir);
  console.log(`building gs-waveform-store ${version} from ${relative(REPO_ROOT, crateDir)}`);

  const pkg = join(crateDir, "pkg");
  rmSync(pkg, { recursive: true, force: true });
  execFileSync(
    "wasm-pack",
    ["build", "--target", "web", "--release", "--out-dir", "pkg", "--out-name", "waveform_store"],
    { cwd: crateDir, stdio: "inherit" },
  );

  const outPkg = join(out, "pkg");
  rmSync(outPkg, { recursive: true, force: true });
  mkdirSync(outPkg, { recursive: true });
  for (const name of KEPT_FILES) {
    const from = join(pkg, name);
    if (!existsSync(from)) {
      throw new Error(`wasm-pack did not emit ${name}; it emitted ${readdirSync(pkg).join(", ")}`);
    }
    cpSync(from, join(outPkg, name));
  }
  // The crate's own `pkg/` is a build directory, not an artefact: leaving it
  // behind would make `cargo fmt`/`clippy` walk a generated tree and would
  // show up as untracked noise in the crate.
  rmSync(pkg, { recursive: true, force: true });

  const files = {};
  for (const name of KEPT_FILES) {
    const path = join(outPkg, name);
    files[`pkg/${name}`] = { bytes: statSync(path).size, sha256: sha256(path) };
  }

  const exports = exportedSymbols(join(outPkg, "waveform_store.d.ts"));
  const missing = REQUIRED_EXPORTS.filter((name) => !exports.includes(name));
  if (missing.length > 0) {
    throw new Error(`the build dropped ${missing.join(", ")}, which the viewer reads through`);
  }

  const provenance = {
    // Read by scripts/check-waveform-wasm-fresh.mjs. Generated — do not hand-edit.
    note:
      "Generated by scripts/build-waveform-wasm.mjs. The bundle under pkg/ is built from " +
      "crates/waveform-store in this repository; scripts/check-waveform-wasm-fresh.mjs holds " +
      "it to the sources digested below. Cargo.lock is among them because it records which " +
      "gsim-samples version and checksum this bundle was actually built against, which the " +
      "manifest's semver range does not.",
    crate: {
      path: relative(REPO_ROOT, crateDir).split(sep).join("/"),
      name: "gs-waveform-store",
      version,
      source_digest: sourceDigest(sources),
      sources,
    },
    built_with: {
      "wasm-pack": execFileSync("wasm-pack", ["--version"], { encoding: "utf8" }).trim(),
      target: "web",
      profile: "release",
    },
    exports,
    files,
  };
  writeFileSync(join(out, "provenance.json"), `${JSON.stringify(provenance, null, 2)}\n`);

  const wasmBytes = files["pkg/waveform_store_bg.wasm"].bytes;
  console.log(
    `\n${out}\n  ${exports.length} exports: ${exports.join(", ")}\n` +
      `  waveform_store_bg.wasm — ${wasmBytes} bytes (${(wasmBytes / 1024).toFixed(0)} KiB)`,
  );
  return provenance;
}

// `pathToFileURL`, not `file://` + the path. A path that needs URL escaping --
// a space, or a non-ASCII character -- never compares equal to `import.meta.url`
// spelled by hand, so this guard was false and running the script did nothing
// at all: no output, exit 0, no bundle. CI checks out to a plain ASCII path and
// so never saw it.
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    buildBundle({
      crateDir: arg("--crate") ? resolve(arg("--crate")) : CRATE_DIR,
      out: arg("--out") ? resolve(arg("--out")) : BUNDLE_DIR,
    });
  } catch (error) {
    console.error(`build-waveform-wasm: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}

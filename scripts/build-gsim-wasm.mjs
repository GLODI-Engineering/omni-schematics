#!/usr/bin/env node
/**
 * Build the engine to WebAssembly and commit the result.
 *
 * The editor's compiler is `gsim-core`'s own `crates/gsim-wasm`. It is built
 * here, from a named commit of the engine's repository, into
 * `packages/gsim-wasm/pkg/` — which is **committed**, binary and all.
 *
 * ## Why the bundle is committed rather than built on demand
 *
 * The alternative is a Rust toolchain plus `wasm-pack` on the way to every
 * `pnpm --filter @gensim/frontend build`: in the `frontend` job, the
 * `vscode-extension` job, the `e2e` job, a contributor's first checkout, and
 * the watch loop of anyone editing a React component. The engine changes a
 * few times a month; the frontend is built hundreds of times a day. Paying a
 * four-minute Rust build for every one of those buys nothing.
 *
 * It is the same trade `apps/vscode-extension/media/frontend` already makes,
 * and it carries the same risk: a generated artefact in the tree can quietly
 * stop matching its source. That is what `scripts/check-gsim-wasm-fresh.mjs`
 * is for, and it is not optional — a committed binary with no gate on it is
 * a fork of the engine that nobody has noticed yet.
 *
 * ## What is pinned, and where
 *
 * `packages/gsim-wasm/provenance.json` records the engine commit the bundle
 * was built from, the crate version, every exported function name, a SHA-256
 * of each emitted file, and a digest over the *content* of the engine files it
 * was built from (`ENGINE_CODE_PATHS`). `check-gsim-wasm-fresh.mjs` compares
 * that digest against the engine's current code, so the bundle cannot fall
 * behind the engine without CI saying so — and a `gsim-core` merge that moves
 * no engine code does not red this repository, which it used to (#280).
 *
 * Usage:
 *   node scripts/build-gsim-wasm.mjs                  # from the engine's default branch
 *   node scripts/build-gsim-wasm.mjs --rev <sha>      # from one commit
 *   node scripts/build-gsim-wasm.mjs --source ../gsim-core   # from a local checkout
 *   node scripts/build-gsim-wasm.mjs --out /tmp/pkg-probe    # somewhere other than the package
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
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..");

export const ENGINE_REPO = "https://github.com/GLODI-Engineering/gsim-core.git";
/** The crate inside the engine's repository that carries the `#[wasm_bindgen]` exports. */
export const ENGINE_CRATE = "crates/gsim-wasm";
/** Where the committed bundle lives. */
export const BUNDLE_DIR = join(REPO_ROOT, "packages", "gsim-wasm");

/**
 * The files `wasm-pack --target web` emits that this repository keeps.
 *
 * `README.md`, `package.json` and `.gitignore` are also emitted and are
 * deliberately not kept: the first is the engine's, and the other two are
 * this package's own and are hand-written (see `packages/gsim-wasm/`).
 */
export const KEPT_FILES = [
  "gsim_wasm.js",
  "gsim_wasm.d.ts",
  "gsim_wasm_bg.wasm",
  "gsim_wasm_bg.wasm.d.ts",
];

/**
 * Size is a user-visible cost here, not a build statistic: the `.wasm` ships
 * inside the .vsix and the webview fetches it on every Run.
 *
 * Set through the environment rather than in a `[profile.release]` section
 * because the manifest being built belongs to the engine, not to this
 * repository — there is no file here to put them in, and editing the engine's
 * would make the bundle unreproducible from its own commit.
 */
const SIZE_PROFILE = {
  CARGO_PROFILE_RELEASE_OPT_LEVEL: "s",
  CARGO_PROFILE_RELEASE_LTO: "true",
  CARGO_PROFILE_RELEASE_CODEGEN_UNITS: "1",
  // `panic = "abort"` is deliberately *not* set. The engine's contract is that
  // a caller sees a real JS `Error` carrying the compiler's own message and
  // never an opaque trap; aborting throws that message away for a few KB.
};

export function sha256(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

/**
 * The engine paths the bundle is actually built from.
 *
 * The question the freshness gate wants to ask is *"is this bundle built from the engine's
 * current code?"*, and it used to ask "is the pinned commit the engine's HEAD?" instead. Those
 * are different questions, and the second one over-fires: on 2026-11-26 it reddened this
 * repository's CI three times, once for a **decision record** (#280). A gate that is red for
 * reasons unrelated to the change in front of you teaches people to merge past it, and this one
 * is cleared by rebuilding and committing a 1.9 MB binary, so the cheap response was to stop
 * reading it.
 *
 * So the comparison is over content under these prefixes:
 *
 *   crates/gsim-wasm/           the binding crate, source and manifest
 *   crates/gsim-core/src/       the engine
 *   crates/gsim-core/data/      the component library -- *embedded* into the crate with
 *                               include_str!, so a catalogue change does change what the
 *                               bundle does. #280 asked for this one explicitly.
 *   crates/gsim-core/Cargo.toml the crate version, which reaches a netlist: every emitted
 *                               deck carries `generated by gsim-core <version>`
 *   Cargo.toml                  the workspace's edition and shared package metadata
 *
 * And not: `docs/`, `examples/`, `crates/gsim-core/tests/`, `crates/gsim-py/`, the journal,
 * the README, CI config. None of them can change a byte of the bundle.
 *
 * What this does **not** buy: a change confined to `#[cfg(test)] mod tests` inside an engine
 * source file still counts as that file changing, because the unit here is the file. The gate
 * goes from firing on every engine commit to firing on every commit that touches a file the
 * bundle is built from -- which is the honest claim, and it is most of the win.
 *
 * `gsim-core` commits a no `Cargo.lock` (the workspace is a library), so there is no lockfile
 * to fingerprint and `wasm-bindgen = "0.2"` floats. That is a pre-existing property of the
 * engine's build, recorded here rather than discovered later: two builds of one commit can
 * differ, which is also why no arm compares `.wasm` bytes.
 */
export const ENGINE_CODE_PATHS = Object.freeze([
  "crates/gsim-wasm/",
  "crates/gsim-core/src/",
  "crates/gsim-core/data/",
  "crates/gsim-core/Cargo.toml",
  "Cargo.toml",
]);

/** Is `path` one of the engine's bundle inputs? A trailing slash means a prefix. */
export function isEngineCode(path) {
  return ENGINE_CODE_PATHS.some((p) => (p.endsWith("/") ? path.startsWith(p) : path === p));
}

/**
 * One digest over the content of every engine-code blob, as `{digest, paths, blobs}`.
 *
 * `blobs` is `[{path, sha}]`, where `sha` is git's own blob hash -- which is a hash of the
 * file's content, so the same digest from two commits means the engine code is byte-identical
 * between them, whatever else moved. That is what lets a docs merge leave this green.
 *
 * It is computed from `git ls-tree` locally at build time and from the GitHub tree API at check
 * time, and those agree because both report git blob hashes rather than hashing anything
 * themselves.
 *
 * Throws on an empty selection. A fingerprint over nothing is a digest that happily matches
 * another digest over nothing, which would be a gate that passes because it looked at no files
 * -- the exact failure this repository has shipped four times.
 */
export function engineCodeFingerprint(blobs) {
  const engine = blobs
    .filter((blob) => isEngineCode(blob.path))
    .map((blob) => ({ path: blob.path, sha: blob.sha }))
    .sort((a, b) => (a.path < b.path ? -1 : 1));
  if (engine.length === 0) {
    throw new Error(
      `no path matched ${ENGINE_CODE_PATHS.join(", ")} among ${blobs.length} blob(s); ` +
        "a fingerprint over nothing would make this gate pass while checking nothing",
    );
  }
  const text = engine.map((blob) => `${blob.sha} ${blob.path}`).join("\n");
  return {
    digest: createHash("sha256").update(text).digest("hex"),
    paths: engine.length,
    blobs: engine,
  };
}

/**
 * Which engine-code paths differ between two blob lists, as readable lines.
 *
 * What the gate prints instead of two commit shas. "changed:
 * crates/gsim-core/data/component-library.json" tells someone what moved and whether they
 * believe it should have; two forty-character hashes tell them to rebuild and hope.
 */
export function changedPaths(before, after) {
  const was = new Map(before.map((blob) => [blob.path, blob.sha]));
  const is = new Map(after.map((blob) => [blob.path, blob.sha]));
  const lines = [];
  for (const [path, sha] of is) {
    if (!was.has(path)) lines.push(`added:   ${path}`);
    else if (was.get(path) !== sha) lines.push(`changed: ${path}`);
  }
  for (const path of was.keys()) {
    if (!is.has(path)) lines.push(`removed: ${path}`);
  }
  return lines.sort();
}

/** Every blob in `commit`'s tree, from a local checkout. */
export function treeBlobs(enginePath, commit) {
  const out = git(["ls-tree", "-r", "--format=%(objectname) %(path)", commit], enginePath);
  return out
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => {
      const [sha, ...rest] = line.split(" ");
      return { sha, path: rest.join(" ") };
    });
}

/**
 * The function names the bundle exports, read out of the generated `.d.ts`.
 *
 * Read from the generated declarations rather than from the engine's source so
 * that this is a fact about the artefact: a build that dropped an export says
 * so here, where a regex over `src/lib.rs` would still report the full list.
 */
export function exportedFunctions(dtsPath) {
  const text = readFileSync(dtsPath, "utf8");
  const names = new Set();
  for (const match of text.matchAll(/^export function ([A-Za-z_$][\w$]*)\s*\(/gm)) {
    names.add(match[1]);
  }
  // wasm-bindgen's own loader entry points, not engine surface.
  for (const glue of ["initSync", "__wbg_init"]) {
    names.delete(glue);
  }
  return [...names].sort();
}

function git(args, cwd) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

/** The engine's default-branch HEAD, without cloning it. */
export function engineDefaultBranchHead() {
  const out = execFileSync("git", ["ls-remote", ENGINE_REPO, "HEAD"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  const sha = out.trim().split(/\s+/)[0];
  if (!/^[0-9a-f]{40}$/.test(sha ?? "")) {
    throw new Error(`git ls-remote gave no HEAD sha for ${ENGINE_REPO}: ${out.trim()}`);
  }
  return sha;
}

function arg(name, fallback = null) {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

/**
 * A checkout of the engine at `rev`, and the commit it resolved to.
 *
 * A local `--source` is used as-is at whatever it has checked out: that is the
 * engine developer's loop (change the engine, rebuild the bundle, open the
 * editor), and silently checking something else out under them would be worse
 * than honest.
 */
function engineCheckout({ source, rev, workDir }) {
  if (source) {
    const path = resolve(source);
    if (!existsSync(join(path, ENGINE_CRATE, "Cargo.toml"))) {
      throw new Error(`--source ${path} has no ${ENGINE_CRATE}/Cargo.toml`);
    }
    return { path, commit: git(["rev-parse", "HEAD"], path), local: true };
  }

  mkdirSync(workDir, { recursive: true });
  const path = join(workDir, "gsim-core");
  if (!existsSync(join(path, ".git"))) {
    rmSync(path, { recursive: true, force: true });
    console.log(`cloning ${ENGINE_REPO} …`);
    execFileSync("git", ["clone", "--quiet", ENGINE_REPO, path], { stdio: "inherit" });
  }
  execFileSync("git", ["fetch", "--quiet", "origin"], { cwd: path, stdio: "inherit" });
  const target = rev ?? engineDefaultBranchHead();
  execFileSync("git", ["checkout", "--quiet", "--detach", target], { cwd: path, stdio: "inherit" });
  return { path, commit: git(["rev-parse", "HEAD"], path), local: false };
}

function crateVersion(enginePath) {
  const manifest = readFileSync(join(enginePath, ENGINE_CRATE, "Cargo.toml"), "utf8");
  return manifest.match(/^version\s*=\s*"([^"]+)"/m)?.[1] ?? "unknown";
}

export function buildBundle({ source = null, rev = null, out = BUNDLE_DIR, workDir } = {}) {
  const engine = engineCheckout({
    source,
    rev,
    workDir: workDir ?? join(tmpdir(), "omni-schematics-gsim-wasm"),
  });
  const version = crateVersion(engine.path);
  console.log(`building ${ENGINE_CRATE} ${version} from ${engine.commit}`);

  const pkg = join(engine.path, ENGINE_CRATE, "pkg");
  rmSync(pkg, { recursive: true, force: true });
  execFileSync(
    "wasm-pack",
    ["build", "--target", "web", "--release", "--out-dir", "pkg", "--out-name", "gsim_wasm"],
    {
      cwd: join(engine.path, ENGINE_CRATE),
      stdio: "inherit",
      env: { ...process.env, ...SIZE_PROFILE },
    },
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

  const files = {};
  for (const name of KEPT_FILES) {
    const path = join(outPkg, name);
    files[`pkg/${name}`] = { bytes: statSync(path).size, sha256: sha256(path) };
  }

  const fingerprint = engineCodeFingerprint(treeBlobs(engine.path, engine.commit));
  // Only the engine-code paths: a dirty `docs/` in the engine developer's checkout changes
  // nothing about the bundle and should not brand it.
  const dirty = git(["status", "--porcelain", "--", ...ENGINE_CODE_PATHS], engine.path)
    .split("\n")
    .map((line) => line.slice(3).trim())
    .filter((path) => path !== "" && isEngineCode(path))
    .sort();
  if (dirty.length > 0) {
    console.log(
      `\nwarning: ${dirty.length} engine file(s) in ${engine.path} differ from ${engine.commit.slice(0, 12)}:\n` +
        `  ${dirty.join("\n  ")}\n` +
        "The bundle is built from what is on disk; its fingerprint can only describe the commit.\n" +
        "check-gsim-wasm-fresh.mjs will refuse it. Commit the engine change first.",
    );
  }

  const provenance = {
    // Read by scripts/check-gsim-wasm-fresh.mjs. Generated — do not hand-edit.
    note:
      "Generated by scripts/build-gsim-wasm.mjs. The bundle under pkg/ is built from " +
      "gsim-core's own crates/gsim-wasm at the commit below; scripts/check-gsim-wasm-fresh.mjs " +
      "holds it to that.",
    engine: {
      repository: ENGINE_REPO,
      crate: ENGINE_CRATE,
      version,
      commit: engine.commit,
      ...(engine.local ? { built_from_local_checkout: true } : {}),
      // What the gate compares, instead of comparing the commit against HEAD. See
      // ENGINE_CODE_PATHS: a digest over the content of the engine files this bundle is built
      // from, so a `gsim-core` merge that moves no engine code leaves this repository green.
      //
      // `dirty` is the answer to #280's second question -- "a looser gate can be gamed by a
      // dirty build". A fingerprint is read out of git, so uncommitted work in the engine
      // checkout is invisible to it; the build says so here rather than letting the digest
      // imply something it cannot see. The gate refuses a bundle marked dirty.
      code_fingerprint: {
        digest: fingerprint.digest,
        paths: fingerprint.paths,
        inputs: [...ENGINE_CODE_PATHS],
        ...(dirty.length > 0 ? { dirty } : {}),
      },
    },
    built_with: {
      "wasm-pack": execFileSync("wasm-pack", ["--version"], { encoding: "utf8" }).trim(),
      target: "web",
      profile: { release: true, ...SIZE_PROFILE },
    },
    exports: exportedFunctions(join(outPkg, "gsim_wasm.d.ts")),
    files,
  };
  writeFileSync(join(out, "provenance.json"), `${JSON.stringify(provenance, null, 2)}\n`);

  const wasmBytes = files["pkg/gsim_wasm_bg.wasm"].bytes;
  console.log(
    `\n${out}\n  ${provenance.exports.length} exported functions\n` +
      `  gsim_wasm_bg.wasm — ${wasmBytes} bytes (${(wasmBytes / 1024).toFixed(0)} KiB)`,
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
      source: arg("--source"),
      rev: arg("--rev"),
      out: arg("--out") ? resolve(arg("--out")) : BUNDLE_DIR,
      workDir: arg("--work-dir") ? resolve(arg("--work-dir")) : undefined,
    });
  } catch (error) {
    console.error(`build-gsim-wasm: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}

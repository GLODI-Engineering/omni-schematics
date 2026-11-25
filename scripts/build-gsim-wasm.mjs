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
 * was built from, the crate version, every exported function name, and a
 * SHA-256 of each emitted file. `check-gsim-wasm-fresh.mjs` compares that
 * commit against the engine's default branch — the same question
 * `engine-catalogue-drift` asks of the catalogue — so the bundle cannot fall
 * behind the engine without CI saying so.
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
import { fileURLToPath } from "node:url";

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

if (import.meta.url === `file://${process.argv[1]}`) {
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

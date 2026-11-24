#!/usr/bin/env node
/**
 * Build the Python environment that `omniSchematics.kernelPython` points at.
 *
 * The editor names an environment; it does not build one (#141). That leaves a
 * gap this script fills: the instruction "point the setting at a venv that has
 * the kernel in it" is only reasonable if assembling such a venv is one
 * command. So this is the one command, and CI runs the same one before the
 * integration suite, which is what stops the instructions from drifting away
 * from what actually works.
 *
 *   node scripts/make-kernel-venv.mjs --out ~/.omni-schematics/kernel-venv
 *
 * What goes in:
 *   - the seven Python workspace packages of this repo, from source;
 *   - their scientific dependencies, resolved by pip from PyPI;
 *   - a `gsim_py` wheel, if one is given or found (the compiler; a maturin
 *     build belonging to gsim-core);
 *   - `gsim-tools`, if a checkout is given or found beside this one. Public,
 *     but published to no index, so a checkout or a release wheel it is.
 *
 * The last two are optional on purpose: the kernel starts without them, and
 * then a run answers `SolverUnavailable` naming what is missing instead of the
 * whole editor refusing to open a schematic.
 */
import { execFileSync, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const REPO = path.resolve(import.meta.dirname, "..");

/** The uv workspace members, which are also exactly what the kernel imports. */
const PACKAGES = [
  "packages/kernel-core",
  "packages/schemas",
  "packages/components",
  "packages/synthesis",
  "packages/gsim-model",
  "packages/simulator",
  "apps/kernel-sidecar",
];

function parseArgs(argv) {
  const out = {
    out: path.join(os.homedir(), ".omni-schematics", "kernel-venv"),
    python: process.env.PYTHON ?? "python3",
    gsimPy: null,
    gsimTools: null,
    force: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      const value = argv[i + 1];
      if (value === undefined) throw new Error(`${arg} needs a value`);
      i += 1;
      return value;
    };
    if (arg === "--out") out.out = path.resolve(next());
    else if (arg === "--python") out.python = next();
    else if (arg === "--gsim-py") out.gsimPy = path.resolve(next());
    else if (arg === "--gsim-tools") out.gsimTools = path.resolve(next());
    else if (arg === "--force") out.force = true;
    else if (arg === "--help" || arg === "-h") out.help = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  return out;
}

/**
 * Newest `gsim_py` wheel built for this interpreter's tag, or null.
 *
 * The tag matters: a sibling gsim-core often has wheels for several Python
 * versions in `target/wheels`, and installing the wrong one fails with a
 * message about an unsupported platform that reads like a broken wheel.
 */
function findGsimPyWheel(venvPython) {
  const dir = path.join(REPO, "..", "gsim-core", "target", "wheels");
  if (!fs.existsSync(dir)) return null;
  const tag = execFileSync(
    venvPython,
    ["-c", "import sys;print(f'cp{sys.version_info[0]}{sys.version_info[1]}')"],
    { encoding: "utf8" },
  ).trim();
  const wheels = fs
    .readdirSync(dir)
    .filter((name) => name.startsWith("gsim_py-") && name.includes(tag) && name.endsWith(".whl"))
    .sort();
  return wheels.length > 0 ? path.join(dir, wheels[wheels.length - 1]) : null;
}

function run(command, args, label) {
  process.stdout.write(`\n[make-kernel-venv] ${label}\n`);
  const result = spawnSync(command, args, { stdio: "inherit" });
  if (result.status !== 0) {
    throw new Error(`${label} failed (exit ${result.status ?? "signal"})`);
  }
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(
      [
        "Build the Python environment for omniSchematics.kernelPython.",
        "",
        "  --out <dir>          where to create it (default ~/.omni-schematics/kernel-venv)",
        "  --python <exe>       base interpreter (default python3)",
        "  --gsim-py <wheel>    gsim_py wheel to install (default: newest matching one in ../gsim-core/target/wheels)",
        "  --gsim-tools <dir>   gsim-tools checkout to install (default: ../gsim-tools if present)",
        "  --force              recreate the environment if it already exists",
        "",
      ].join("\n"),
    );
    return;
  }

  if (fs.existsSync(options.out)) {
    if (!options.force) {
      throw new Error(`${options.out} already exists. Pass --force to recreate it.`);
    }
    fs.rmSync(options.out, { recursive: true, force: true });
  }

  run(options.python, ["-m", "venv", options.out], `creating the environment in ${options.out}`);
  const venvPython = path.join(
    options.out,
    process.platform === "win32" ? "Scripts/python.exe" : "bin/python",
  );
  run(venvPython, ["-m", "pip", "install", "--quiet", "--upgrade", "pip"], "upgrading pip");

  // All seven paths in one install: pip satisfies the packages' dependencies on
  // each other from the command line, so none of them is looked for on PyPI --
  // where `components` and `schemas` are somebody else's packages entirely.
  run(
    venvPython,
    ["-m", "pip", "install", ...PACKAGES.map((member) => path.join(REPO, member))],
    "installing the kernel packages and their dependencies",
  );

  const wheel = options.gsimPy ?? findGsimPyWheel(venvPython);
  if (wheel) {
    run(
      venvPython,
      ["-m", "pip", "install", "--force-reinstall", wheel],
      `installing ${path.basename(wheel)}`,
    );
  } else {
    process.stdout.write(
      "\n[make-kernel-venv] no gsim_py wheel found — compiling a schematic will say so.\n" +
        "  Build one with: cd ../gsim-core && maturin build --release -m crates/gsim-py/Cargo.toml\n",
    );
  }

  const toolsDefault = path.join(REPO, "..", "gsim-tools");
  const tools = options.gsimTools ?? (fs.existsSync(toolsDefault) ? toolsDefault : null);
  if (tools) {
    run(venvPython, ["-m", "pip", "install", tools], `installing gsim-tools from ${tools}`);
  }

  // Start it. A venv that imports but cannot reach KERNEL_READY is the failure
  // worth catching here rather than from a Run click that does nothing.
  process.stdout.write("\n[make-kernel-venv] starting the kernel to check the environment\n");
  const probe = spawnSync(
    venvPython,
    ["-m", "kernel_sidecar", "--port", "0", "--token", "selftest", "--connect-timeout", "5"],
    { encoding: "utf8", timeout: 120_000 },
  );
  const output = `${probe.stdout ?? ""}${probe.stderr ?? ""}`;
  const ready = output.match(/KERNEL_READY .*/);
  if (!ready) {
    process.stdout.write(output);
    throw new Error("the kernel never reached KERNEL_READY from this environment");
  }
  process.stdout.write(`[make-kernel-venv] ${ready[0]}\n`);

  process.stdout.write(
    [
      "",
      "Done. Put this in your VS Code settings:",
      "",
      `  "omniSchematics.kernelPython": ${JSON.stringify(options.out)}`,
      "",
    ].join("\n"),
  );
}

try {
  main();
} catch (error) {
  process.stderr.write(
    `\n[make-kernel-venv] ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exit(1);
}

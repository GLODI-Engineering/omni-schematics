/**
 * Finding the `general-simulator` binary.
 *
 * ## Why this is in the extension now
 *
 * It used to be `packages/simulator/src/simulator/solvers/path_discovery.py`,
 * reached by starting a Python sidecar, handing it a path, and having it look.
 * The ordering that forced was bad enough that the `generalSimulatorPath`
 * setting had to apologise for it in its own description: the path "is handed
 * to the simulation kernel **after** the kernel has started, so it cannot
 * start one by itself: if `omniSchematics.kernelPython` is unset, the kernel
 * never starts and nothing here is ever read."
 *
 * With the extension doing the looking there is no kernel to start first, so
 * the setting means what it says.
 *
 * ## The chain, and why it is this order
 *
 * Explicit argument, then the setting, then the environment, then `PATH`,
 * then a sibling checkout. Each step is more of a guess than the one before,
 * so a user who said exactly what they wanted is never overridden by
 * something found lying around. The sibling checkout is last and is there for
 * the case this project is most often in: the editor and the solver cloned
 * next to each other, the solver built with `cargo build --release`.
 */

import * as fs from "node:fs";
import * as path from "node:path";

import { solverEnvVar } from "./kernel-environment";

/** Where a resolved binary came from, so a log line can say. */
export type SolverSource =
  | "the path passed in"
  | "the omniSchematics.generalSimulatorPath setting"
  | "the environment"
  | "PATH"
  | "a sibling general-simulator checkout";

export interface ResolvedSolver {
  binary: string;
  source: SolverSource;
}

export interface SolverLookup {
  /** `--out`-style explicit override, highest precedence. */
  explicit?: string;
  /** `omniSchematics.generalSimulatorPath`. */
  configured?: string;
  env?: NodeJS.ProcessEnv;
  /** The open folder, for the sibling-checkout guess. */
  workspaceRoot?: string;
  /** Injected for tests; defaults to a real stat. */
  isExecutableFile?: (candidate: string) => boolean;
  /** Injected for tests; defaults to splitting `PATH`. */
  pathDirectories?: () => string[];
  platform?: NodeJS.Platform;
}

/**
 * Everything that was looked at, in the order it was looked at.
 *
 * Carried on the error rather than logged, because "not found" is useless on
 * its own: the user's next question is always "where did you look", and the
 * answer tells them which of the five things to set.
 */
export class SolverNotFound extends Error {
  readonly searched: string[];

  constructor(searched: string[], platform: NodeJS.Platform) {
    const envVar = solverEnvVar("general-simulator");
    super(
      [
        "Cannot find the general-simulator binary. Looked at:",
        ...searched.map((where) => `  ${where}`),
        "",
        "Set omniSchematics.generalSimulatorPath to the binary, or put it on PATH,",
        `or export ${envVar}.`,
        "",
        "To build it: clone GLODI-Engineering/general-simulator and run",
        "  cargo build --release -p general-simulator-cli",
        `which leaves the binary at target/release/general-simulator${
          platform === "win32" ? ".exe" : ""
        }.`,
      ].join("\n"),
    );
    this.name = "SolverNotFound";
    this.searched = searched;
  }
}

const executableName = (platform: NodeJS.Platform) =>
  platform === "win32" ? "general-simulator.exe" : "general-simulator";

function defaultIsExecutableFile(candidate: string): boolean {
  try {
    const stat = fs.statSync(candidate);
    if (!stat.isFile()) {
      return false;
    }
  } catch {
    return false;
  }
  try {
    // On Windows `X_OK` is meaningless and `accessSync` succeeds for any
    // readable file, which is the behaviour wanted there anyway: the
    // extension is not the right place to parse PE headers.
    fs.accessSync(candidate, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * The binary, or a {@link SolverNotFound} naming everywhere that was tried.
 */
export function resolveSolver(lookup: SolverLookup = {}): ResolvedSolver {
  const platform = lookup.platform ?? process.platform;
  const env = lookup.env ?? process.env;
  const isExecutableFile = lookup.isExecutableFile ?? defaultIsExecutableFile;
  const delimiter = platform === "win32" ? ";" : ":";
  // The flavour of path arithmetic follows the platform being resolved for,
  // not the one this process happens to run on. `path.join` follows the host,
  // which is right in production and makes the Windows behaviour untestable
  // anywhere else -- and untested path handling on the platform where the
  // separator is unusual is exactly the wrong thing to leave unexercised.
  const paths = platform === "win32" ? path.win32 : path.posix;
  const pathDirectories =
    lookup.pathDirectories ??
    (() => (env.PATH ?? "").split(delimiter).filter((entry) => entry.length > 0));

  const searched: string[] = [];
  const exe = executableName(platform);

  const tryFile = (candidate: string | undefined, label: string): string | undefined => {
    const trimmed = candidate?.trim();
    if (!trimmed) {
      return undefined;
    }
    searched.push(`${label}: ${trimmed}`);
    return isExecutableFile(trimmed) ? trimmed : undefined;
  };

  const explicit = tryFile(lookup.explicit, "the path passed in");
  if (explicit) {
    return { binary: explicit, source: "the path passed in" };
  }

  const configured = tryFile(lookup.configured, "omniSchematics.generalSimulatorPath");
  if (configured) {
    return { binary: configured, source: "the omniSchematics.generalSimulatorPath setting" };
  }

  // The underscored spelling first, then the hyphenated one. A hyphen cannot
  // appear in a shell identifier, so the underscored form is the only one a
  // user can actually export; the other is kept for anything that already
  // sets it programmatically.
  for (const name of [solverEnvVar("general-simulator"), "GENSIM_GENERAL-SIMULATOR_PATH"]) {
    const fromEnv = tryFile(env[name], name);
    if (fromEnv) {
      return { binary: fromEnv, source: "the environment" };
    }
  }

  for (const directory of pathDirectories()) {
    const candidate = paths.join(directory, exe);
    if (isExecutableFile(candidate)) {
      searched.push(`PATH: ${candidate}`);
      return { binary: candidate, source: "PATH" };
    }
  }
  searched.push(`PATH: no ${exe} on any of its entries`);

  if (lookup.workspaceRoot) {
    // Beside the workspace, which is how this project is usually laid out:
    // the editor and the solver cloned next to each other.
    const sibling = paths.join(
      paths.dirname(lookup.workspaceRoot),
      "general-simulator",
      "target",
      "release",
      exe,
    );
    const found = tryFile(sibling, "a sibling general-simulator checkout");
    if (found) {
      return { binary: found, source: "a sibling general-simulator checkout" };
    }
  }

  throw new SolverNotFound(searched, platform);
}

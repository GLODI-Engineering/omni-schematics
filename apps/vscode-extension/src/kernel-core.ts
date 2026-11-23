/**
 * Pure, VS Code-free half of the kernel-sidecar process manager.
 *
 * What it does:
 *   - build the command that starts the sidecar from an interpreter the user
 *     named (`omniSchematics.kernelPython`),
 *   - read the child's stdout until a `KERNEL_READY port=… token=… protocol=…`
 *     line,
 *   - honour the `GENSIM_KERNEL_PORT` / `GENSIM_KERNEL_TOKEN` overrides used by
 *     CI and dev-without-auto-spawn.
 *
 * It used to do a fourth thing: walk up from the open folder looking for a
 * `pyproject.toml` and launch the kernel with `uv run --project <root>`. #141
 * deleted that. The editor names an environment and does not build one, so
 * there is nothing here to discover -- which is why the file no longer touches
 * the filesystem except to check that a configured path exists.
 *
 * Everything here is dependency-free so it can be unit tested without a
 * running VS Code instance.
 */
import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

export interface KernelConfig {
  port: number;
  token: string;
  /**
   * The IPC protocol version the sidecar reports (#134).
   *
   * Absent when the sidecar predates the handshake carrying one, which is
   * itself the signal that a prepared environment is too old to trust.
   */
  protocol?: number;
}

/**
 * The IPC protocol version this extension speaks.
 *
 * Introduced with #134, which lets a user point the extension at a Python
 * environment they prepared themselves rather than one the extension builds.
 * That removes `uv` and the checkout -- and introduces one new
 * way to fail: an environment prepared for a different version of the editor.
 * Pinning the *protocol* rather than any package version is deliberate; package
 * versions drift for reasons that do not change the wire contract, and a check
 * that fires on those would be noise.
 *
 * Bump this, and `KERNEL_PROTOCOL_VERSION` in
 * `apps/kernel-sidecar/src/kernel_sidecar/server.py`, together and only when
 * the IPC contract changes incompatibly.
 */
export const KERNEL_PROTOCOL_VERSION = 1;

/** Whether a sidecar reporting `protocol` can talk to this extension. */
export function isProtocolCompatible(protocol: number | undefined): boolean {
  return protocol === KERNEL_PROTOCOL_VERSION;
}

export interface SpawnPlan {
  command: string;
  args: string[];
  cwd: string;
}

/**
 * 32 hex chars, matching the Rust token shape. The Rust implementation derived
 * the value from the clock and pid; a CSPRNG is strictly better and the token
 * is only ever compared for equality by the sidecar.
 */
export function generateToken(): string {
  return randomBytes(16).toString("hex");
}

/**
 * Resolve `omniSchematics.kernelPython` to an interpreter that exists.
 *
 * Accepts either a virtualenv directory or a path to an interpreter, because
 * both are things a user naturally has to hand, and guessing wrong costs them
 * a confusing failure. Returns null for "not configured" *and* for "configured
 * but not there", which the caller distinguishes by whether the setting was
 * empty -- that is what lets the failure name which of the two happened.
 *
 * `exists` is injectable so tests need no tree on disk.
 */
export function resolveKernelPython(
  configured: string,
  exists: (candidate: string) => boolean = fs.existsSync,
): string | null {
  const trimmed = configured.trim();
  if (!trimmed) {
    return null;
  }

  // A direct path to an interpreter.
  if (exists(trimmed)) {
    // A venv directory also "exists"; prefer an interpreter inside it when
    // there is one, and otherwise treat the path as the interpreter itself.
    const inside = interpreterInsideVenv(trimmed, exists);
    return inside ?? trimmed;
  }

  return interpreterInsideVenv(trimmed, exists);
}

/**
 * The interpreter inside a venv directory, in the order worth trying.
 *
 * `Scripts\python.exe` is the Windows layout -- a venv there has no `bin/` at
 * all -- and Windows is the machine of record for this feature.
 */
function interpreterInsideVenv(dir: string, exists: (candidate: string) => boolean): string | null {
  const candidates = [
    path.join(dir, "bin", "python"),
    path.join(dir, "bin", "python3"),
    path.join(dir, "Scripts", "python.exe"),
  ];
  for (const candidate of candidates) {
    if (exists(candidate)) {
      return candidate;
    }
  }
  return null;
}

/**
 * The command that starts the sidecar from a prepared environment (#134, #141).
 *
 * There is nothing to resolve: the interpreter already has `kernel_sidecar` and
 * its dependencies installed, which is the entire point. `--port 0` lets the OS
 * pick and `--connect-timeout 0` means never self-exit, both inherited from the
 * Tauri shell's `spawn_kernel()`. `cwd` is somewhere to resolve relative paths
 * from, not a place anything is looked up -- the sidecar's own `--workdir`
 * governs where results land.
 *
 * This was `buildPreparedSpawnPlan` while a second, `uv`-based plan existed
 * beside it. It is the only plan now, so it carries the plain name.
 */
export function buildSpawnPlan(interpreter: string, token: string, cwd: string): SpawnPlan {
  return {
    command: interpreter,
    args: ["-m", "kernel_sidecar", "--port", "0", "--token", token, "--connect-timeout", "0"],
    cwd,
  };
}

/**
 * Parse a `KERNEL_READY port=<n> token=<hex> [protocol=<n>]` handshake line.
 * Returns null for any other line.
 */
export function parseKernelReady(line: string): KernelConfig | null {
  const rest = line.startsWith("KERNEL_READY ") ? line.slice("KERNEL_READY ".length) : null;
  if (rest === null) {
    return null;
  }
  let port: number | null = null;
  let token: string | null = null;
  let protocol: number | undefined;
  for (const part of rest.split(/\s+/)) {
    if (part.startsWith("port=")) {
      const parsed = Number.parseInt(part.slice("port=".length), 10);
      if (Number.isInteger(parsed) && parsed > 0 && parsed <= 65535) {
        port = parsed;
      }
    } else if (part.startsWith("token=")) {
      token = part.slice("token=".length);
    } else if (part.startsWith("protocol=")) {
      const parsed = Number.parseInt(part.slice("protocol=".length), 10);
      if (Number.isInteger(parsed)) {
        protocol = parsed;
      }
    }
  }
  if (port === null || token === null) {
    return null;
  }
  // Omitted rather than set to undefined, so a sidecar that reports no version
  // is distinguishable from one that reports a bad one.
  return protocol === undefined ? { port, token } : { port, token, protocol };
}

/**
 * Manual override for CI / dev-without-auto-spawn, matching the
 * `GENSIM_KERNEL_PORT` + `GENSIM_KERNEL_TOKEN` pair honoured by the Tauri shell.
 * Both must be present.
 */
export function kernelConfigFromEnv(env: NodeJS.ProcessEnv = process.env): KernelConfig | null {
  const rawPort = env.GENSIM_KERNEL_PORT;
  const token = env.GENSIM_KERNEL_TOKEN;
  if (!rawPort || !token) {
    return null;
  }
  const port = Number.parseInt(rawPort, 10);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    return null;
  }
  return { port, token };
}

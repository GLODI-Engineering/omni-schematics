import * as fs from "node:fs";
import * as path from "node:path";

import { describe, expect, it } from "vitest";

import {
  KERNEL_PROTOCOL_VERSION,
  buildSpawnPlan,
  generateToken,
  isProtocolCompatible,
  kernelConfigFromEnv,
  parseKernelReady,
  resolveKernelPython,
} from "./kernel-core";

describe("kernel-core: KERNEL_READY handshake", () => {
  it("parses the port and token the sidecar prints", () => {
    expect(parseKernelReady("KERNEL_READY port=51234 token=deadbeef")).toEqual({
      port: 51234,
      token: "deadbeef",
    });
  });

  it("tolerates extra fields and extra whitespace", () => {
    expect(parseKernelReady("KERNEL_READY  pid=99  port=1  token=t  extra=x")).toEqual({
      port: 1,
      token: "t",
    });
  });

  it("returns null for unrelated stdout lines", () => {
    expect(parseKernelReady("INFO starting up")).toBeNull();
    expect(parseKernelReady("")).toBeNull();
  });

  it("returns null when either half is missing or out of range", () => {
    expect(parseKernelReady("KERNEL_READY port=51234")).toBeNull();
    expect(parseKernelReady("KERNEL_READY token=abc")).toBeNull();
    expect(parseKernelReady("KERNEL_READY port=0 token=abc")).toBeNull();
    expect(parseKernelReady("KERNEL_READY port=70000 token=abc")).toBeNull();
  });
});

describe("kernel-core: env override", () => {
  it("honours the GENSIM_KERNEL_* pair", () => {
    expect(kernelConfigFromEnv({ GENSIM_KERNEL_PORT: "9001", GENSIM_KERNEL_TOKEN: "t" })).toEqual({
      port: 9001,
      token: "t",
    });
  });

  it("requires both halves", () => {
    expect(kernelConfigFromEnv({ GENSIM_KERNEL_PORT: "9001" })).toBeNull();
    expect(kernelConfigFromEnv({ GENSIM_KERNEL_TOKEN: "t" })).toBeNull();
    expect(kernelConfigFromEnv({})).toBeNull();
  });

  it("rejects a non-numeric port", () => {
    expect(
      kernelConfigFromEnv({ GENSIM_KERNEL_PORT: "nope", GENSIM_KERNEL_TOKEN: "t" }),
    ).toBeNull();
  });
});

describe("kernel-core: token", () => {
  it("produces the 32 hex chars the sidecar expects", () => {
    const token = generateToken();
    expect(token).toMatch(/^[0-9a-f]{32}$/);
    expect(generateToken()).not.toBe(token);
  });
});

// ---------------------------------------------------------------------------
// #134: a prepared environment, named rather than built.
// ---------------------------------------------------------------------------

describe("kernel-core: resolveKernelPython", () => {
  // The owner's point, and the reason this exists: `uv sync` never produced a
  // kernel that could simulate anyway. `gsim-tools` is in a private sibling
  // repo and `gsim_py` is a maturin build, so both are hand-installed after a
  // sync -- and a sync prunes them again. Naming a finished environment states
  // the dependency that was always there, and #141 dropped the clone, `uv` and
  // `workspaceRoot` with it.

  it("accepts a venv directory and finds its interpreter (POSIX layout)", () => {
    const present = new Set(["/envs/gsim/bin/python"]);
    expect(resolveKernelPython("/envs/gsim", (p) => present.has(p))).toBe("/envs/gsim/bin/python");
  });

  it("accepts a venv directory and finds its interpreter (Windows layout)", () => {
    // The target machine of record is Windows, where a venv has no bin/ at
    // all. `path.join` chooses the separator for the platform the editor is
    // running on, so this asserts the segments rather than a literal string --
    // the alternative passes on one OS and fails on the other for no reason
    // that concerns the code under test.
    const resolved = resolveKernelPython("C:/envs/gsim", (candidate) =>
      /Scripts[\\/]python\.exe$/.test(candidate),
    );
    expect(resolved).not.toBeNull();
    expect(resolved).toMatch(/^C:[\\/]envs[\\/]gsim[\\/]Scripts[\\/]python\.exe$/);
  });

  it("falls back to bin/python3 when bin/python is absent", () => {
    const present = new Set(["/envs/gsim/bin/python3"]);
    expect(resolveKernelPython("/envs/gsim", (p) => present.has(p))).toBe("/envs/gsim/bin/python3");
  });

  it("accepts a direct path to an interpreter", () => {
    const present = new Set(["/usr/local/bin/python3.12"]);
    expect(resolveKernelPython("/usr/local/bin/python3.12", (p) => present.has(p))).toBe(
      "/usr/local/bin/python3.12",
    );
  });

  it("trims surrounding whitespace, which a pasted path often carries", () => {
    const present = new Set(["/envs/gsim/bin/python"]);
    expect(resolveKernelPython("  /envs/gsim  ", (p) => present.has(p))).toBe(
      "/envs/gsim/bin/python",
    );
  });

  it("returns null for an empty setting, which the host reports as unset (#141)", () => {
    expect(resolveKernelPython("", () => true)).toBeNull();
    expect(resolveKernelPython("   ", () => true)).toBeNull();
  });

  it("returns null when nothing is there, rather than a path that cannot be spawned", () => {
    // Distinguishing "not configured" from "configured and wrong" is what lets
    // the host say which of the two happened (#130).
    expect(resolveKernelPython("/envs/typo", () => false)).toBeNull();
  });
});

describe("kernel-core: buildSpawnPlan", () => {
  it("runs the interpreter directly, with no uv and no --project", () => {
    const plan = buildSpawnPlan("/envs/gsim/bin/python", "deadbeef", "/work");
    expect(plan.command).toBe("/envs/gsim/bin/python");
    expect(plan.args).toEqual([
      "-m",
      "kernel_sidecar",
      "--port",
      "0",
      "--token",
      "deadbeef",
      "--connect-timeout",
      "0",
    ]);
    expect(plan.cwd).toBe("/work");
    // The whole point: no workspace root is involved anywhere.
    expect(plan.args).not.toContain("--project");
    expect(plan.command).not.toBe("uv");
  });
});

describe("kernel-core: protocol version in the handshake", () => {
  // Invented here because nothing versioned the IPC contract before. A package
  // version is the wrong thing to pin -- those drift legitimately. What must
  // agree is the protocol, so that is what the handshake carries.

  it("parses the protocol version when the sidecar reports one", () => {
    expect(parseKernelReady("KERNEL_READY port=5150 token=abc protocol=1")).toEqual({
      port: 5150,
      token: "abc",
      protocol: 1,
    });
  });

  it("still parses a handshake from a sidecar that reports no version", () => {
    // An older prepared venv. It parses, and the host decides what to do about
    // the missing version -- parsing is not the place to reject it.
    expect(parseKernelReady("KERNEL_READY port=5150 token=abc")).toEqual({
      port: 5150,
      token: "abc",
    });
  });

  it("accepts the version the sidecar in this repo actually emits", () => {
    const parsed = parseKernelReady(
      `KERNEL_READY port=1 token=t protocol=${KERNEL_PROTOCOL_VERSION}`,
    );
    expect(parsed?.protocol).toBe(KERNEL_PROTOCOL_VERSION);
  });
});

describe("kernel-core: isProtocolCompatible", () => {
  it("accepts the version this extension speaks", () => {
    expect(isProtocolCompatible(KERNEL_PROTOCOL_VERSION)).toBe(true);
  });

  it("rejects a different version, so a stale venv fails clearly", () => {
    expect(isProtocolCompatible(KERNEL_PROTOCOL_VERSION + 1)).toBe(false);
    expect(isProtocolCompatible(KERNEL_PROTOCOL_VERSION - 1)).toBe(false);
  });

  it("rejects a sidecar that reports no version at all", () => {
    // A venv prepared before the handshake carried one. That is exactly the
    // confusing failure this check exists to turn into a clear one.
    expect(isProtocolCompatible(undefined)).toBe(false);
  });
});

describe("kernel-core: the protocol version does not drift from the sidecar's", () => {
  /**
   * Two constants, in two languages, that must agree -- the exact shape this
   * repo already guards with keymap-drift, schema-drift and
   * engine-catalogue-drift. A handshake check that silently compares a stale
   * pair is worse than no check: it would reject every correctly prepared
   * environment, or accept every wrong one.
   */
  it("matches KERNEL_PROTOCOL_VERSION in kernel_sidecar/server.py", () => {
    const serverPy = path.resolve(__dirname, "../../kernel-sidecar/src/kernel_sidecar/server.py");
    const source = fs.readFileSync(serverPy, "utf8");
    const match = source.match(/^KERNEL_PROTOCOL_VERSION\s*=\s*(\d+)$/m);

    expect(match, `no KERNEL_PROTOCOL_VERSION found in ${serverPy}`).not.toBeNull();
    expect(Number.parseInt(match?.[1] ?? "-1", 10)).toBe(KERNEL_PROTOCOL_VERSION);
  });

  it("is the version the sidecar's handshake line actually prints", () => {
    // Guards the format too, not just the number: the host parses `protocol=`
    // out of that f-string, so a rename there breaks the check silently.
    const serverPy = path.resolve(__dirname, "../../kernel-sidecar/src/kernel_sidecar/server.py");
    const source = fs.readFileSync(serverPy, "utf8");
    expect(source).toMatch(/KERNEL_READY port=\{bound_port\} token=\{token\} /);
    expect(source).toMatch(/protocol=\{KERNEL_PROTOCOL_VERSION\}/);
  });
});

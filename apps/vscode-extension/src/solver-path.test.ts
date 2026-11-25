import { describe, expect, it } from "vitest";

import { SolverNotFound, resolveSolver } from "./solver-path";

/** Only the paths named here exist, and all of them are executable. */
const only =
  (...existing: string[]) =>
  (candidate: string) =>
    existing.includes(candidate);

describe("resolveSolver", () => {
  it("prefers what the user said over anything it can find", () => {
    // The chain is ordered by how much of a guess each step is, so a user who
    // named a binary is never overridden by one lying on PATH.
    const resolved = resolveSolver({
      explicit: "/explicit/general-simulator",
      configured: "/configured/general-simulator",
      env: { GENSIM_GENERAL_SIMULATOR_PATH: "/env/general-simulator", PATH: "/bin" },
      isExecutableFile: only(
        "/explicit/general-simulator",
        "/configured/general-simulator",
        "/env/general-simulator",
        "/bin/general-simulator",
      ),
      platform: "linux",
    });
    expect(resolved).toEqual({
      binary: "/explicit/general-simulator",
      source: "the path passed in",
    });
  });

  it("falls to the setting, then the environment, then PATH", () => {
    const base = {
      env: { GENSIM_GENERAL_SIMULATOR_PATH: "/env/general-simulator", PATH: "/one:/two" },
      platform: "linux" as const,
    };
    expect(
      resolveSolver({
        ...base,
        configured: "/configured/general-simulator",
        isExecutableFile: only("/configured/general-simulator", "/env/general-simulator"),
      }).source,
    ).toBe("the omniSchematics.generalSimulatorPath setting");

    expect(
      resolveSolver({ ...base, isExecutableFile: only("/env/general-simulator") }).source,
    ).toBe("the environment");

    expect(
      resolveSolver({
        ...base,
        env: { PATH: "/one:/two" },
        isExecutableFile: only("/two/general-simulator"),
      }).source,
    ).toBe("PATH");
  });

  it("accepts the hyphenated environment variable too", () => {
    // A hyphen cannot appear in a shell identifier, so nobody can `export`
    // this spelling -- but something setting it programmatically already
    // might, and silently ignoring it would be a very confusing afternoon.
    const resolved = resolveSolver({
      env: { "GENSIM_GENERAL-SIMULATOR_PATH": "/legacy/general-simulator", PATH: "" },
      isExecutableFile: only("/legacy/general-simulator"),
      platform: "linux",
    });
    expect(resolved.binary).toBe("/legacy/general-simulator");
  });

  it("looks beside the workspace last, where this project is usually cloned", () => {
    const resolved = resolveSolver({
      env: { PATH: "" },
      workspaceRoot: "/work/omni-schematics",
      isExecutableFile: only("/work/general-simulator/target/release/general-simulator"),
      platform: "linux",
    });
    expect(resolved.source).toBe("a sibling general-simulator checkout");
  });

  it("looks for general-simulator.exe on Windows", () => {
    const resolved = resolveSolver({
      env: { PATH: "C:\\tools" },
      isExecutableFile: only("C:\\tools\\general-simulator.exe"),
      platform: "win32",
    });
    expect(resolved.source).toBe("PATH");
  });

  it("names everywhere it looked, because that is the next question", () => {
    let error: unknown;
    try {
      resolveSolver({
        configured: "/configured/general-simulator",
        env: { GENSIM_GENERAL_SIMULATOR_PATH: "/env/general-simulator", PATH: "/one" },
        workspaceRoot: "/work/omni-schematics",
        isExecutableFile: () => false,
        platform: "linux",
      });
    } catch (thrown) {
      error = thrown;
    }
    expect(error).toBeInstanceOf(SolverNotFound);
    const found = error as SolverNotFound;
    expect(found.searched).toEqual([
      "omniSchematics.generalSimulatorPath: /configured/general-simulator",
      "GENSIM_GENERAL_SIMULATOR_PATH: /env/general-simulator",
      "PATH: no general-simulator on any of its entries",
      "a sibling general-simulator checkout: /work/general-simulator/target/release/general-simulator",
    ]);
    // And it says what to do, including how to get a binary at all.
    expect(found.message).toContain("omniSchematics.generalSimulatorPath");
    expect(found.message).toContain("cargo build --release -p general-simulator-cli");
    // The download first, and the sibling repositories named with the build:
    // a bare clone of general-simulator does not build, because its workspace
    // depends on three repositories by path, so cargo stops at "failed to load
    // manifest for dependency" before compiling anything. Sending a stuck user
    // there as the first suggestion is sending them to a second failure.
    expect(found.message).toContain("/general-simulator/releases");
    expect(found.message.indexOf("/releases")).toBeLessThan(found.message.indexOf("cargo build"));
    for (const sibling of ["gs-waveform-measurements", "general-mna", "spice-lsp"]) {
      expect(found.message).toContain(sibling);
    }
  });

  it("ignores a setting that is blank or whitespace", () => {
    // An unset VS Code setting reads as "", and treating that as a path made
    // the error say it had looked at nothing.
    let error: unknown;
    try {
      resolveSolver({
        configured: "   ",
        env: { PATH: "" },
        isExecutableFile: () => false,
        platform: "linux",
      });
    } catch (thrown) {
      error = thrown;
    }
    expect((error as SolverNotFound).searched).toEqual([
      "PATH: no general-simulator on any of its entries",
    ]);
  });
});

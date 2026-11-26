/**
 * #238 — what the preflight reports, and the one case a `PATH` lookup gets wrong.
 *
 * The whole point of the compiler probe is the difference between "not found" and "found and
 * cannot link", so most of this file is about that distinction. The last suite runs the real
 * system compiler, so the probe is exercised against a real toolchain and a real path with a
 * space in it rather than only against a stand-in.
 */
import * as cp from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  type ProbeIo,
  chooseCompiler,
  languagesNeeded,
  preflight,
  probeCompiler,
  readEngineCapabilities,
} from "./toolchain-probe";

/**
 * A world where each program behaves as told. `undefined` means "not on PATH".
 *
 * `produced` answers from whether the program was told to succeed, which is what makes the
 * "started, exited 0, produced nothing" case expressible — the case a `PATH` lookup cannot see.
 */
function world(
  programs: Record<string, { code: number | null; stderr?: string; stdout?: string } | undefined>,
  options: { platform?: NodeJS.Platform } = {},
): ProbeIo & { scratches: string[] } {
  const scratches: string[] = [];
  const produced = new Set<string>();
  return {
    scratches,
    platform: options.platform ?? "linux",
    run: (program, args, cwd) => {
      const behaviour = programs[program];
      if (behaviour === undefined) {
        return { started: false, code: null, stderr: "spawn ENOENT", stdout: "" };
      }
      if (behaviour.code === 0) {
        // The output name is whatever `-o`/the MSVC convention says.
        const dashO = args.indexOf("-o");
        produced.add(`${cwd}/${dashO === -1 ? "probe.dll" : args[dashO + 1]}`);
      }
      return {
        started: true,
        code: behaviour.code,
        stderr: behaviour.stderr ?? "",
        stdout: behaviour.stdout ?? "",
      };
    },
    scratch: () => {
      const directory = `/tmp/probe ${scratches.length}`;
      scratches.push(directory);
      return directory;
    },
    discard: () => {},
    write: () => {},
    produced: (directory, name) => produced.has(`${directory}/${name}`),
  };
}

describe("languagesNeeded", () => {
  it("names only the languages the sheet uses, in a fixed order", () => {
    expect(languagesNeeded([{ language: "octave" }, { language: "c" }])).toEqual(["c", "octave"]);
    expect(languagesNeeded([])).toEqual([]);
    expect(languagesNeeded(undefined)).toEqual([]);
  });

  it("does not repeat a language a sheet uses twice", () => {
    expect(languagesNeeded([{ language: "c" }, { language: "c" }])).toEqual(["c"]);
  });
});

describe("probeCompiler", () => {
  it("takes the first candidate that actually builds, and stops there", () => {
    const io = world({ clang: undefined, cc: { code: 0 }, gcc: { code: 0 } });
    const report = probeCompiler(io);
    expect(report.usable).toBe("cc");
    expect(report.attempts.map((attempt) => attempt.program)).toEqual(["clang", "cc"]);
    expect(report.attempts[0]?.outcome).toBe("absent");
  });

  /**
   * The case this probe exists for.
   *
   * A `PATH` lookup finds `cl.exe` on any machine with Visual Studio installed and reports
   * success. It then fails at link time with something unreadable, because `cl.exe` needs a
   * developer environment (`INCLUDE`, `LIB`, `LIBPATH`) that an ordinary editor process does
   * not have. That is the *likely* failure on a Windows laptop, not "no compiler found", and a
   * probe that cannot tell them apart turns the vendoring question into a guess.
   */
  it("distinguishes 'found and cannot link' from 'not found', and says what it said", () => {
    const io = world(
      {
        "cl.exe": {
          code: 2,
          stdout: "probe.c\nLINK : fatal error LNK1104: cannot open file 'LIBCMT.lib'",
        },
      },
      { platform: "win32" },
    );
    const report = probeCompiler(io);
    expect(report.usable).toBeUndefined();
    const msvc = report.attempts.find((attempt) => attempt.program === "cl.exe");
    expect(msvc?.outcome).toBe("cannot-build");
    expect(msvc?.detail).toContain("LNK1104");
    // And the three that are simply absent are reported as absent, not as broken.
    expect(
      report.attempts.filter((attempt) => attempt.outcome === "absent").map((a) => a.program),
    ).toEqual(["clang", "gcc", "cc"]);
  });

  it("calls a zero exit with no library 'cannot build', not 'works'", () => {
    // The shape of a wrapper script that exits 0 and does nothing -- which a `PATH` lookup and
    // an exit-status check would both call success.
    const io = world({ clang: { code: 0 } });
    // Override `produced` to say the file is not there despite the zero exit.
    const probe = { ...io, produced: () => false };
    const report = probeCompiler(probe);
    expect(report.usable).toBeUndefined();
    expect(report.attempts[0]?.outcome).toBe("cannot-build");
    expect(report.attempts[0]?.detail).toMatch(/wrote no diagnostic/);
  });

  it("asks for a DLL on Windows, a dylib on macOS and an so elsewhere", () => {
    const seen: { program: string; args: string[] }[] = [];
    const record = (platform: NodeJS.Platform) => {
      const io = world({ clang: { code: 0 } }, { platform });
      probeCompiler({
        ...io,
        run: (program, args, cwd) => {
          seen.push({ program, args });
          return io.run(program, args, cwd);
        },
      });
    };
    record("win32");
    record("darwin");
    record("linux");
    expect(seen[0]?.args).toContain("probe.dll");
    expect(seen[1]?.args).toContain("probe.dylib");
    expect(seen[2]?.args).toContain("probe.so");
    // `-fPIC` on every one of them: a shared library without it links on x86-64 Linux by
    // accident and fails elsewhere, which is the same class of mistake as a wrong ABI.
    for (const attempt of seen) {
      expect(attempt.args, attempt.program).toContain("-fPIC");
    }
  });

  it("removes its scratch directory even when every candidate fails", () => {
    const discarded: string[] = [];
    const io = world({});
    probeCompiler({ ...io, discard: (directory) => discarded.push(directory) });
    // Three candidates on Linux, three directories, all discarded -- a probe must not leave an
    // artifact a later staleness check could mistake for a user's own.
    expect(discarded).toHaveLength(3);
    expect(discarded).toEqual(io.scratches);
  });

  it("reports a thrown scratch-directory failure instead of throwing", () => {
    const io = world({ clang: { code: 0 } });
    const report = probeCompiler({
      ...io,
      write: () => {
        throw new Error("read-only file system");
      },
    });
    expect(report.usable).toBeUndefined();
    expect(report.attempts[0]?.detail).toContain("read-only file system");
  });
});

describe("readEngineCapabilities", () => {
  it("parses key=value lines", () => {
    const io = {
      run: () => ({
        started: true,
        code: 0,
        stdout: "program=general-simulator\nversion=0.9.0\npython=yes\noctave=subprocess\n",
        stderr: "",
      }),
    };
    expect(readEngineCapabilities(io, "gs")).toEqual({
      tooOldToAsk: false,
      python: true,
      version: "0.9.0",
    });
  });

  it("calls an engine that does not know the flag too old, not Python-less", () => {
    // The distinction matters: "older than the flag" and "cannot run Python" are different
    // facts, and only one of them is actionable. Inventing a negative here is how a front end
    // tells a user to rebuild an engine that was already fine.
    const io = {
      run: () => ({
        started: true,
        code: 1,
        stdout: "",
        stderr: "error: unrecognized argument '--capabilities'",
      }),
    };
    expect(readEngineCapabilities(io, "gs")).toEqual({ tooOldToAsk: true });
  });

  it("calls an answer without a python key too old as well", () => {
    const io = {
      run: () => ({ started: true, code: 0, stdout: "version=0.9.0\n", stderr: "" }),
    };
    expect(readEngineCapabilities(io, "gs")).toEqual({ tooOldToAsk: true, version: "0.9.0" });
  });
});

describe("preflight", () => {
  const noCompiler = () => ({ attempts: [{ program: "clang", outcome: "absent" as const }] });
  const goodCompiler = () => ({
    usable: "clang",
    attempts: [{ program: "clang", outcome: "works" as const }],
  });
  const pythonEngine = () => ({ tooOldToAsk: false, python: true });
  const octaveThere = () => ({ started: true });

  it("says nothing for a sheet with no code blocks", () => {
    expect(
      preflight({
        languages: [],
        cNeedsBuilding: false,
        compiler: () => {
          throw new Error("must not probe for a sheet that needs nothing");
        },
        engine: () => {
          throw new Error("must not ask the engine");
        },
        octave: () => {
          throw new Error("must not look for octave");
        },
      }),
    ).toEqual([]);
  });

  it("does not need a compiler for a C block whose library is already fresh", () => {
    // Refusing this would be a regression on every machine without a toolchain, and most runs
    // of a finished project are this case.
    expect(
      preflight({
        languages: ["c"],
        cNeedsBuilding: false,
        compiler: () => {
          throw new Error("must not probe when nothing needs building");
        },
        engine: pythonEngine,
        octave: octaveThere,
      }),
    ).toEqual([]);
  });

  it("refuses a build with no compiler, saying what it looked for and what to install", () => {
    const [finding] = preflight({
      languages: ["c"],
      cNeedsBuilding: true,
      compiler: noCompiler,
      engine: pythonEngine,
      octave: octaveThere,
    });
    expect(finding?.blocking).toBe(true);
    expect(finding?.message).toContain("clang: not found");
    expect(finding?.message).toMatch(/install one of them/i);
    // And the Windows trap named, because that is the one that looks like success.
    expect(finding?.message).toContain("cl.exe");
  });

  it("refuses a Python block against an engine built without Python, naming the build line", () => {
    const [finding] = preflight({
      languages: ["python"],
      cNeedsBuilding: false,
      compiler: goodCompiler,
      engine: () => ({ tooOldToAsk: false, python: false }),
      octave: octaveThere,
    });
    expect(finding?.blocking).toBe(true);
    expect(finding?.message).toContain("--features python");
    // The trap: `pythonPath` looks like the setting for this and is not.
    expect(finding?.message).toContain("omniSchematics.pythonPath");
  });

  it("warns rather than refuses when the engine is too old to be asked", () => {
    const [finding] = preflight({
      languages: ["python"],
      cNeedsBuilding: false,
      compiler: goodCompiler,
      engine: () => ({ tooOldToAsk: true }),
      octave: octaveThere,
    });
    expect(finding?.blocking).toBe(false);
    expect(finding?.message).toMatch(/too old to say/i);
  });

  it("refuses an Octave block with no octave-cli, naming the setting", () => {
    const [finding] = preflight({
      languages: ["octave"],
      cNeedsBuilding: false,
      compiler: goodCompiler,
      engine: pythonEngine,
      octave: () => ({ started: false, detail: "spawn ENOENT" }),
    });
    expect(finding?.blocking).toBe(true);
    expect(finding?.message).toContain("omniSchematics.octaveCliPath");
    expect(finding?.message).toContain("spawn ENOENT");
  });

  it("reports every language a sheet is short of, not the first", () => {
    const findings = preflight({
      languages: ["c", "python", "octave"],
      cNeedsBuilding: true,
      compiler: noCompiler,
      engine: () => ({ tooOldToAsk: false, python: false }),
      octave: () => ({ started: false }),
    });
    expect(findings.map((finding) => finding.language)).toEqual(["c", "python", "octave"]);
  });

  it("mentions no interpreter of its own anywhere, which is the one thing it must not grow", () => {
    // The editor has no Python and must never acquire one: a Python *block* runs in the
    // solver's process with the solver's embedded interpreter. This asserts the module's text,
    // because the failure mode is someone "helpfully" adding a `python3 --version` probe.
    const source = fs.readFileSync(path.join(__dirname, "toolchain-probe.ts"), "utf8");
    expect(source).not.toMatch(/spawn\(['"`]python/);
    expect(source).not.toMatch(/['"`]python3['"`]/);
    expect(source).not.toMatch(/require\(['"`]python/);
  });
});

// ---------------------------------------------------------------------------
// The real toolchain. The stand-in above cannot prove that the flags work.
// ---------------------------------------------------------------------------

const realScratch: string[] = [];
afterEach(() => {
  for (const directory of realScratch.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

function realIo(): ProbeIo {
  return {
    platform: process.platform,
    // Spawned as an argv with no shell: this machine's project path has a space *and* an
    // accent, and both survive exactly as long as nothing re-splits the command.
    run: (program, args, cwd) => {
      const result = cp.spawnSync(program, args, { cwd, encoding: "utf8" });
      return {
        started: result.error === undefined,
        code: result.status,
        stderr: result.stderr ?? "",
        stdout: result.stdout ?? "",
      };
    },
    scratch: () => {
      // A space in the name, deliberately. A probe that only works on clean paths would pass
      // on a CI runner and fail where the owner works.
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "gsim probe "));
      realScratch.push(root);
      return root;
    },
    discard: (directory) => fs.rmSync(directory, { recursive: true, force: true }),
    write: (directory, name, contents) => fs.writeFileSync(path.join(directory, name), contents),
    produced: (directory, name) => fs.existsSync(path.join(directory, name)),
  };
}

describe("the real compiler on this machine", () => {
  const anyCompiler = ["clang", "cc", "gcc"].some(
    (program) => cp.spawnSync(program, ["--version"], { stdio: "ignore" }).status === 0,
  );
  const guarded = anyCompiler ? it : it.skip;

  guarded(
    "builds a shared library in a directory whose name contains a space",
    () => {
      const report = probeCompiler(realIo());
      expect(report.usable, JSON.stringify(report.attempts, null, 2)).toBeDefined();
      const worked = report.attempts.find((attempt) => attempt.outcome === "works");
      expect(worked?.program).toBe(report.usable);
    },
    60_000,
  );
});

describe("the real engine on this machine", () => {
  const binary = process.env.GSIM_GENERAL_SIMULATOR_PATH;
  const guarded = binary && fs.existsSync(binary) ? it : it.skip;

  guarded("answers --capabilities, or is reported as too old to ask", () => {
    const capabilities = readEngineCapabilities(realIo(), binary as string);
    if (capabilities.tooOldToAsk) {
      // An engine older than general-simulator#135. Reported, not guessed at.
      expect(capabilities.python).toBeUndefined();
      return;
    }
    expect(typeof capabilities.python).toBe("boolean");
    expect(capabilities.version).toMatch(/^\d+\.\d+\.\d+/);
  });
});

/**
 * Whose compiler gets used, which the owner settled: the editor ships none, and its job is to
 * let you say where yours is.
 */
describe("you name your own compiler", () => {
  it("prefers the machine's setting, then discovery", () => {
    expect(chooseCompiler({ setting: "/opt/mingw/bin/gcc" })).toEqual({
      program: "/opt/mingw/bin/gcc",
      source: "setting",
    });
    expect(chooseCompiler({})).toEqual({ source: "discovered" });
  });

  it("treats blank and whitespace as unset, so an empty setting does not name a compiler", () => {
    expect(chooseCompiler({ setting: "   " })).toEqual({ source: "discovered" });
    expect(chooseCompiler({ setting: "" })).toEqual({ source: "discovered" });
  });

  it("tries a named compiler alone, and does not quietly use another that works", () => {
    // `clang` would build here. The user asked for `gcc-14`, which is absent. Falling back
    // would hand them a library built with flags they did not choose, from a compiler they
    // did not name -- and nothing on the sheet would record which one produced it.
    const io = world({ "gcc-14": undefined, clang: { code: 0 } });
    const report = probeCompiler(io, { program: "gcc-14", source: "setting" });

    expect(report.usable).toBeUndefined();
    expect(report.attempts.map((attempt) => attempt.program)).toEqual(["gcc-14"]);
    expect(report.source).toBe("setting");
  });

  it("reports a named compiler that starts and cannot build, which is the Windows case", () => {
    const io = world(
      { "cl.exe": { code: 2, stderr: "LINK : fatal error LNK1104" } },
      { platform: "win32" },
    );
    const report = probeCompiler(io, { program: "cl.exe", source: "setting" });

    expect(report.usable).toBeUndefined();
    expect(report.attempts[0]?.outcome).toBe("cannot-build");
    expect(report.attempts[0]?.detail).toContain("LNK1104");
  });

  it("gives a named MSVC its own flags even when it is spelled as a path", () => {
    // Matched on the file name: a setting points at an installation, not at a bare `cl.exe`,
    // and `-shared -fPIC` handed to MSVC fails in a way nobody would connect to this.
    const seen: string[][] = [];
    const io = world({ "C:/BuildTools/cl.exe": { code: 0 } }, { platform: "win32" });
    const spy: ProbeIo = {
      ...io,
      run: (program, args, cwd) => {
        seen.push(args);
        return io.run(program, args, cwd);
      },
    };
    probeCompiler(spy, { program: "C:/BuildTools/cl.exe", source: "setting" });

    expect(seen[0]).toContain("/LD");
    expect(seen[0]).not.toContain("-shared");
  });

  it("still discovers one when nothing is named", () => {
    const io = world({ clang: undefined, cc: { code: 0 } });
    const report = probeCompiler(io, chooseCompiler({}));

    expect(report.usable).toBe("cc");
    expect(report.source).toBe("discovered");
  });
});

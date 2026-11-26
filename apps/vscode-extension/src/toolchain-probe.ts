/**
 * Whether this machine can do what the sheet needs, asked before the run that needs it (#238).
 *
 * A sheet with a code block needs something installed that a sheet of resistors does not, and
 * it needs a *different* thing per language. Before this, the user found out from a failed run,
 * in a message that did not say what to install:
 *
 * | what is missing | what the user was shown |
 * | --- | --- |
 * | no C compiler | nothing — the run used whatever `.so` was on disk, or `CScript(Load { … "dlopen failed" })` |
 * | the engine has no Python support | `PythonSupportNotCompiledIn { block_name: "G1" }` |
 * | `octave-cli` not on `PATH` | `Octave(NotFound { message: "No such file or directory (os error 2)" })` |
 *
 * ## Who needs what, because it is not the same per language
 *
 * - **C** needs a **compiler** on the machine that runs the build, and nothing at run time
 *   beyond what the block links. The extension has no compiler and must find the user's.
 * - **Python** needs **no build**. It needs the *engine* to have been built with
 *   `--features python`, and whatever the block imports installed for the interpreter the
 *   engine embeds — which is fixed at the engine's link time and is **not** the interpreter the
 *   user selected in VS Code. `omniSchematics.pythonPath` adds module directories and says so;
 *   it does not and cannot choose an interpreter.
 * - **Octave** needs `octave-cli` on the `PATH` the solver process inherits. `octave-ffi` spawns
 *   it as a subprocess, so the engine needs nothing at build time.
 *
 * **The trap, stated so nobody walks into it:** the *editor* has no Python and must never
 * acquire one. The sidecar was removed in 0.9.0 and `solver-path.ts`'s header records why. A
 * Python *block* is executed by the **solver**, in the solver's process, with the solver's
 * embedded interpreter. Detecting that the *solver* can run Python is a question to ask the
 * solver — `general-simulator --capabilities`, `general-simulator#135` — and not a reason to go
 * looking for an interpreter. Nothing in this module spawns, imports or looks for one.
 *
 * ## Why the compiler probe builds something
 *
 * A `PATH` lookup finds `cl.exe` on any machine with Visual Studio installed and reports
 * success — and then the build fails at link time with something unreadable, because `cl.exe`
 * needs a developer environment (`INCLUDE`, `LIB`, `LIBPATH`) that an ordinary VS Code process
 * does not have. That is the *likely* failure on a Windows laptop, not the easy "no compiler
 * found" one, and a probe that cannot tell them apart turns the vendoring question into a guess.
 *
 * So each candidate is asked to **build a two-line shared library in a temporary directory**,
 * and the report says what happened. The answer a reader gets is "clang absent, `cl.exe` present
 * but cannot link a DLL from this shell" rather than a bare absence.
 *
 * Two details that are not incidental:
 *
 * - **Spawned as an argv, never through a shell.** This machine's own project path contains a
 *   space *and* an accent (`Github Works/Électronique`), and both survive provided no shell
 *   re-splits the command. The probe's own scratch directory is deliberately given a name with
 *   a space in it, so a check that only works on clean paths cannot pass here.
 * - **The temporary directory is removed afterwards**, including on failure, so a probe never
 *   leaves an artifact that a later staleness check could mistake for a user's own.
 */

/** Each language a sheet can need, in the order a message should mention them. */
export const CODE_LANGUAGES = ["c", "python", "octave"] as const;
export type CodeLanguage = (typeof CODE_LANGUAGES)[number];

/** What a run needs, derived from the blocks the sheet carries. */
export function languagesNeeded(
  blocks: readonly { language: CodeLanguage }[] | undefined,
): CodeLanguage[] {
  const present = new Set((blocks ?? []).map((block) => block.language));
  return CODE_LANGUAGES.filter((language) => present.has(language));
}

/** One compiler candidate's fate. */
export interface CompilerAttempt {
  /** The program as it was invoked, e.g. `clang` or `cl.exe`. */
  program: string;
  /**
   * `absent` — the program could not be started at all (not on `PATH`).
   * `cannot-build` — it started and failed to produce a shared library.
   * `works` — it produced one.
   */
  outcome: "absent" | "cannot-build" | "works";
  /** What it said, trimmed, when it said something. The diagnosis for `cannot-build`. */
  detail?: string;
}

export interface CompilerReport {
  /** The first candidate that actually built a library, if any. */
  usable?: string;
  /** Every candidate, in the order tried. A report, not a log. */
  attempts: CompilerAttempt[];
}

/** The outside world, injected so every branch below is testable without one. */
export interface ProbeIo {
  /**
   * Run a program with these arguments in this directory, with **no shell**, and report what
   * happened. `started: false` means the program could not be launched at all.
   */
  run: (
    program: string,
    args: string[],
    cwd: string,
  ) => { started: boolean; code: number | null; stderr: string; stdout: string };
  /** Create a scratch directory and return it. The caller removes it. */
  scratch: () => string;
  /** Remove it, and never throw: a probe that fails to tidy up must not fail the run. */
  discard: (directory: string) => void;
  /** Write a file inside the scratch directory. */
  write: (directory: string, name: string, contents: string) => void;
  /** Whether a file exists inside the scratch directory. */
  produced: (directory: string, name: string) => boolean;
  platform: NodeJS.Platform;
}

/** The smallest thing that is a real shared library and exercises nothing else. */
const PROBE_SOURCE = "int gsim_probe(int x) { return x + 1; }\n";

/**
 * The candidates, in the order #238 settles on: clang first, then `cc`/`gcc`, then MSVC.
 *
 * clang first because it keeps one flag set across all three platforms, which is worth more
 * than matching whatever a given machine happens to have. `cl.exe` last and only on Windows,
 * because its flags are nothing like `cc -shared -fPIC` and it needs an environment this
 * process does not have — see the probe's own doc comment.
 */
function candidates(platform: NodeJS.Platform): string[] {
  return platform === "win32" ? ["clang", "gcc", "cc", "cl.exe"] : ["clang", "cc", "gcc"];
}

/** The flags and the output name for one candidate on one platform. */
function buildCommand(
  program: string,
  platform: NodeJS.Platform,
): { args: string[]; output: string } {
  if (program === "cl.exe") {
    // MSVC: `/LD` is a DLL, `/nologo` keeps the banner out of the report, and the output name
    // comes from the source unless `/Fe` says otherwise.
    return { args: ["/nologo", "/LD", "probe.c"], output: "probe.dll" };
  }
  const output =
    platform === "win32" ? "probe.dll" : platform === "darwin" ? "probe.dylib" : "probe.so";
  // `-fPIC` on every Unix: a shared library without it links on x86-64 Linux by accident and
  // fails on other targets, which is the same class of mistake as a wrong ABI declaration.
  return { args: ["-shared", "-fPIC", "-O0", "-o", output, "probe.c"], output };
}

/**
 * The first compiler that can actually build a shared library, and what every candidate did.
 *
 * Never throws: a probe that fails is a report, not an exception. A run refused because of a
 * missing compiler should say what it looked for; a run refused because the *probe* broke would
 * be a worse outcome than not probing at all.
 */
export function probeCompiler(io: ProbeIo): CompilerReport {
  const attempts: CompilerAttempt[] = [];
  for (const program of candidates(io.platform)) {
    const { args, output } = buildCommand(program, io.platform);
    let directory: string | undefined;
    try {
      directory = io.scratch();
      io.write(directory, "probe.c", PROBE_SOURCE);
      const result = io.run(program, args, directory);
      if (!result.started) {
        attempts.push({
          program,
          outcome: "absent",
          ...(result.stderr.trim() === "" ? {} : { detail: result.stderr.trim() }),
        });
        continue;
      }
      if (result.code === 0 && io.produced(directory, output)) {
        attempts.push({ program, outcome: "works" });
        return { usable: program, attempts };
      }
      // Started and did not produce a library. This is the case a `PATH` lookup calls success.
      const said = [result.stderr, result.stdout]
        .map((stream) => stream.trim())
        .filter((stream) => stream !== "")
        .join("\n");
      attempts.push({
        program,
        outcome: "cannot-build",
        detail:
          said === ""
            ? `exited ${result.code === null ? "without a status" : String(result.code)} and wrote no diagnostic`
            : said,
      });
    } catch (error) {
      attempts.push({
        program,
        outcome: "cannot-build",
        detail: error instanceof Error ? error.message : String(error),
      });
    } finally {
      if (directory !== undefined) {
        io.discard(directory);
      }
    }
  }
  return { attempts };
}

/** What the engine said about itself, from `general-simulator --capabilities`. */
export interface EngineCapabilities {
  /**
   * `true`/`false` when the engine answered, `undefined` when it is too old to be asked —
   * which must not be reported as "cannot run Python", because it may well be able to.
   */
  python?: boolean;
  version?: string;
  /** True when the binary did not recognise `--capabilities` at all. */
  tooOldToAsk: boolean;
}

/**
 * Ask the engine what it can run.
 *
 * `key=value` lines, by contract (`general-simulator#135`), so this is a parse and not a regex
 * over prose. An engine that does not recognise the flag writes a usage error to stderr and is
 * reported as `tooOldToAsk` — the honest answer, because "this engine is older than the flag"
 * and "this engine cannot run Python" are different facts and only one of them is actionable.
 */
export function readEngineCapabilities(
  io: Pick<ProbeIo, "run">,
  binary: string,
): EngineCapabilities {
  const result = io.run(binary, ["--capabilities"], ".");
  if (!result.started || result.code !== 0) {
    return { tooOldToAsk: true };
  }
  const fields = new Map<string, string>();
  for (const raw of result.stdout.split(/\r?\n/)) {
    const line = raw.trim();
    const split = line.indexOf("=");
    if (line === "" || split <= 0) {
      continue;
    }
    fields.set(line.slice(0, split), line.slice(split + 1));
  }
  const python = fields.get("python");
  if (python === undefined) {
    // It answered, but not the question. Treated as too old rather than as a "no": inventing a
    // negative from a missing key is how a front end ends up telling a user to rebuild an
    // engine that was already fine.
    return {
      tooOldToAsk: true,
      ...(fields.has("version") ? { version: fields.get("version") } : {}),
    };
  }
  return {
    tooOldToAsk: false,
    python: python === "yes",
    ...(fields.has("version") ? { version: fields.get("version") } : {}),
  };
}

export interface PreflightInput {
  /** The languages this sheet needs, from `languagesNeeded`. */
  languages: readonly CodeLanguage[];
  /**
   * Whether a C block needs building at all. The compiler is only required when something has
   * to be compiled — a sheet whose libraries are all newer than their sources needs none, and
   * refusing it would be a regression on every machine without a toolchain.
   */
  cNeedsBuilding: boolean;
  compiler: () => CompilerReport;
  engine: () => EngineCapabilities;
  /** Whether `octave-cli` can be started. A spawn, not a `PATH` scan: a name on `PATH` that
   * cannot execute is the same failure as one that is not there. */
  octave: () => { started: boolean; detail?: string };
}

export interface PreflightFinding {
  language: CodeLanguage;
  /** Blocking findings stop the run; advisory ones are said and the run proceeds. */
  blocking: boolean;
  /** One paragraph: what is missing, what was looked for, and what to do about it. */
  message: string;
}

/**
 * What this machine cannot do for this sheet.
 *
 * Only the languages the sheet actually uses are checked, and the C compiler only when
 * something needs building — the cost of a probe is a process spawn, and a sheet of resistors
 * should pay nothing.
 */
export function preflight(input: PreflightInput): PreflightFinding[] {
  const findings: PreflightFinding[] = [];

  if (input.languages.includes("c") && input.cNeedsBuilding) {
    const report = input.compiler();
    if (report.usable === undefined) {
      const looked = report.attempts
        .map((attempt) => {
          if (attempt.outcome === "absent") {
            return `  ${attempt.program}: not found`;
          }
          return `  ${attempt.program}: found, but could not build a shared library — ${
            attempt.detail ?? "no diagnostic"
          }`;
        })
        .join("\n");
      findings.push({
        language: "c",
        blocking: true,
        message:
          "This sheet has a C block whose library needs rebuilding, and no compiler here can " +
          `build one. Each candidate was asked to build a two-line shared library:\n${looked}\n` +
          "Install one of them — clang keeps a single flag set across Linux, macOS and Windows " +
          "— and make sure it is on the PATH this editor was started with. On Windows, cl.exe " +
          "needs a Visual Studio developer environment that an ordinary editor process does " +
          "not inherit, so a cl.exe that is 'found' is not necessarily one that can link.",
      });
    }
  }

  if (input.languages.includes("python")) {
    const capabilities = input.engine();
    if (capabilities.tooOldToAsk) {
      findings.push({
        language: "python",
        blocking: false,
        message:
          "This sheet has a Python block, and this engine is too old to say whether it can run " +
          "one (it does not recognise --capabilities). If the run fails with " +
          "PythonSupportNotCompiledIn, build an engine that can with " +
          "`cargo build --release -p general-simulator-cli --features python`.",
      });
    } else if (capabilities.python === false) {
      findings.push({
        language: "python",
        blocking: true,
        message:
          "This sheet has a Python block, and this engine cannot run one: it was built without " +
          "the optional `python` feature. The published releases are deliberately built that " +
          "way, because linking against one specific libpython would make them a worse " +
          "download. Build one that can with `cargo build --release -p general-simulator-cli " +
          "--features python`, which needs a discoverable Python with its shared library, and " +
          "point omniSchematics.generalSimulatorPath at it.\n" +
          "Note that omniSchematics.pythonPath does not help here: it adds module directories " +
          "for the interpreter the engine embeds, and cannot choose an interpreter.",
      });
    }
  }

  if (input.languages.includes("octave")) {
    const octave = input.octave();
    if (!octave.started) {
      findings.push({
        language: "octave",
        blocking: true,
        message:
          "This sheet has an Octave block and octave-cli could not be started" +
          (octave.detail === undefined ? "" : ` (${octave.detail})`) +
          ". Install Octave, or set omniSchematics.octaveCliPath to the directory holding " +
          "octave-cli — the engine spawns it as a subprocess and looks for it on PATH and " +
          "nowhere else.",
      });
    }
  }

  return findings;
}

/**
 * The whole run sequence, against real child processes and the real file
 * system.
 *
 * Nothing here is mocked except the solver's own numerics, and that only in
 * the arms that are not about them: a stand-in that copies a container the
 * *real* solver wrote (`__fixtures__/rc-divider.gsim_samples`) is enough to
 * exercise the footer read, the manifest write and the schema validation, and
 * it runs where no binary exists — which is every CI runner.
 *
 * The last suite runs the real `general-simulator` when there is one, and
 * skips with a printed reason when there is not. That arm is the one that
 * proves the claim in #159, and it is reproducible by anyone with a binary:
 *
 *     GSIM_GENERAL_SIMULATOR_PATH=/path/to/general-simulator \
 *       pnpm --filter ./apps/vscode-extension test
 */
import * as cp from "node:child_process";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import type { RunOutputLine } from "@gensim/webview-protocol";
import { afterEach, describe, expect, it } from "vitest";

// The generated validator, so a result document written here is checked
// against the schema itself rather than against this test's idea of it.
// @ts-expect-error -- generated JavaScript, no declarations emitted for it
import { validateGsimSimResultDocument } from "../../frontend/src/generated/validators/gsim-sim-result.js";

import {
  EVENTS_FILE,
  NETLIST_FILE,
  RESULT_FILE,
  SAMPLES_FILE,
  describeEvent,
  runSimulation,
} from "./run-simulation";
import { SolverNotFound } from "./solver-path";

const FIXTURES = path.join(__dirname, "__fixtures__");
const CONTAINER = path.join(FIXTURES, "rc-divider.gsim_samples");
const NETLIST = fs.readFileSync(path.join(FIXTURES, "rc-divider.cir"), "utf8");

const request = {
  mode: "transient" as const,
  netlist: NETLIST,
  tEnd: 2e-5,
  tStep: 1e-6,
  analysis: "TRAN",
  source: "rc-divider.gsim_sch",
};

const scratch: string[] = [];
function runDirectory(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gsim-run-test-"));
  scratch.push(dir);
  return path.join(dir, "run-1");
}

afterEach(() => {
  for (const dir of scratch.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

const collect = () => {
  const lines: RunOutputLine[] = [];
  return { lines, onOutput: (batch: RunOutputLine[]) => lines.push(...batch) };
};

const texts = (lines: RunOutputLine[]) => lines.map((line) => line.text);

/**
 * A stand-in solver: a real child process, started with real arguments, that
 * copies a real container to the `--out` path the arguments name.
 *
 * `node -e` rather than a fake `ChildProcess`, for the reason
 * `solver-run.test.ts` gives: the parts that break need a pipe.
 */
function fakeSolver(
  options: {
    stdout?: string;
    stderr?: string;
    exit?: number;
    container?: string | null;
    events?: string;
  } = {},
) {
  const script = `
    const fs = require("node:fs");
    const args = process.argv.slice(1);
    const out = args[args.indexOf("--out") + 1];
    const events = args.includes("--events") ? args[args.indexOf("--events") + 1] : null;
    if (${JSON.stringify(options.stdout ?? "")}) process.stdout.write(${JSON.stringify(options.stdout ?? "")});
    if (${JSON.stringify(options.stderr ?? "")}) process.stderr.write(${JSON.stringify(options.stderr ?? "")});
    const container = ${JSON.stringify(options.container === undefined ? CONTAINER : options.container)};
    if (container) fs.copyFileSync(container, out);
    if (events && ${JSON.stringify(options.events ?? "")}) fs.writeFileSync(events, ${JSON.stringify(options.events ?? "")});
    process.exit(${options.exit ?? 0});
  `;
  return (_binary: string, args: string[]) =>
    spawn(process.execPath, ["-e", script, "--", ...args]);
}

const found = { binary: "/fake/general-simulator", source: "PATH" as const };

describe("a run that works", () => {
  it("writes the four files of a run into its own directory", async () => {
    const directory = runDirectory();
    const result = await runSimulation(request, {
      runDirectory: directory,
      resolve: () => found,
      spawn: fakeSolver({ events: '{"record":"summary","rule":"i_max","target":"D1"}\n' }),
      onOutput: collect().onOutput,
      now: () => new Date("2026-11-25T12:00:00.000Z"),
    });

    expect(result.ok).toBe(true);
    // The netlist is written to a file, not piped: the solver takes its deck
    // as a positional path, and the file is what makes a failed run
    // reproducible by hand.
    expect(fs.readFileSync(path.join(directory, NETLIST_FILE), "utf8")).toBe(NETLIST);
    for (const file of [SAMPLES_FILE, EVENTS_FILE, RESULT_FILE]) {
      expect(fs.existsSync(path.join(directory, file)), file).toBe(true);
    }
  });

  it("writes a result document the schema accepts, naming the real signals", async () => {
    const directory = runDirectory();
    const result = await runSimulation(request, {
      runDirectory: directory,
      resolve: () => found,
      spawn: fakeSolver(),
      onOutput: collect().onOutput,
      now: () => new Date("2026-11-25T12:00:00.000Z"),
    });

    if (!result.ok) throw new Error(result.summary);
    const document = JSON.parse(fs.readFileSync(result.resultPath, "utf8"));
    expect(validateGsimSimResultDocument.errors ?? []).toEqual([]);
    expect(validateGsimSimResultDocument(document)).toBe(true);
    // The names come from the container's footer, because nothing upstream of
    // it knows them: the webview compiled a netlist, and the solver decided
    // what that netlist exposes and what to call it.
    expect(document.signals.map((signal: { name: string }) => signal.name)).toEqual([
      "V(n_in)",
      "V(n_out)",
      "I(v1)",
    ]);
    expect(document.data).toEqual({
      kind: "samples",
      path: SAMPLES_FILE,
      pyramid: true,
    });
    expect(document.run).toEqual({
      id: "run-1",
      analysis: "TRAN",
      source: "rc-divider.gsim_sch",
      created: "2026-11-25T12:00:00.000Z",
    });
    expect(result.rows).toBe(20);
    expect(result.samplesBytes).toBe(fs.statSync(CONTAINER).size);
  });

  it("keeps stdout and stderr apart, which is what the sidecar could not", async () => {
    // #139 step 3. The sidecar merged the two pipes, so a solver diagnostic
    // arrived interleaved with everything else and nothing downstream could
    // label it.
    const sink = collect();
    await runSimulation(request, {
      runDirectory: runDirectory(),
      resolve: () => found,
      spawn: fakeSolver({ stdout: "solving\n2000 steps\n", stderr: "a note about node n_out\n" }),
      onOutput: sink.onOutput,
    });

    expect(sink.lines).toEqual(
      expect.arrayContaining([
        { source: "solver", severity: "info", text: "solving" },
        { source: "solver", severity: "info", text: "2000 steps" },
        { source: "solver", severity: "warning", text: "a note about node n_out" },
      ]),
    );
  });

  it("prints the exact command line before running it", async () => {
    // A run that fails is far easier to explain when the user can paste the
    // line into a terminal — and it is why `transientArgs` is its own
    // function.
    const sink = collect();
    await runSimulation(request, {
      runDirectory: runDirectory(),
      resolve: () => found,
      spawn: fakeSolver(),
      onOutput: sink.onOutput,
    });
    expect(texts(sink.lines)).toEqual(
      expect.arrayContaining([
        expect.stringContaining("/fake/general-simulator"),
        expect.stringContaining("--format samples"),
      ]),
    );
  });
});

describe("what a run found", () => {
  const events = [
    '{"record":"event","rule":"i_max","target":"D1","kind":"enter","severity":"warning","action":"report","time":1.5e-6,"step":42,"step_time":1.6e-6,"value":12.3,"limit":10,"unit":"A","detail":"D1,L1"}',
    '{"record":"event","rule":"deadtime","target":"lega","kind":"instant","severity":"error","action":"report","time":5e-6,"step":130,"step_time":5e-6,"value":2e-9,"limit":5e-8,"unit":"s"}',
    '{"record":"summary","rule":"i_max","target":"D1","entries":1,"severity":"warning"}',
  ].join("\n");

  it("reports the worst severity, which the exit status does not carry", async () => {
    // A run can exit 0 having found a rating exceeded, so the exit status
    // cannot be what decides whether the user is told "finished" or "finished
    // with errors".
    const result = await runSimulation(request, {
      runDirectory: runDirectory(),
      resolve: () => found,
      spawn: fakeSolver({ events, exit: 0 }),
      onOutput: collect().onOutput,
    });
    if (!result.ok) throw new Error(result.summary);
    expect(result.worstSeverity).toBe("error");
    expect(result.eventsTotal).toBe(2);
    expect(result.events[0]).toEqual({
      rule: "i_max",
      target: "D1",
      severity: "warning",
      time: 1.5e-6,
      value: 12.3,
      limit: 10,
      unit: "A",
      detail: "D1,L1",
    });
  });

  it("treats a rule's own exit status as a result, not as a failure", async () => {
    // `--fail-on` makes the process exit 2 when a rule reaches a severity, and
    // a rule that ends the run exits 3. Both leave a complete container and a
    // complete log, and reporting only "the solver exited with status 2" would
    // hide the finding that caused it.
    for (const exit of [2, 3]) {
      const result = await runSimulation(request, {
        runDirectory: runDirectory(),
        resolve: () => found,
        spawn: fakeSolver({ events, exit }),
        onOutput: collect().onOutput,
      });
      expect(result.ok, `exit ${exit}`).toBe(true);
      if (result.ok) expect(result.worstSeverity).toBe("error");
    }
  });

  it("treats any other non-zero status as a failure, container or not", async () => {
    // Exit 4 is a non-finite state: there may well be a file, and its numbers
    // are not to be trusted.
    const result = await runSimulation(request, {
      runDirectory: runDirectory(),
      resolve: () => found,
      spawn: fakeSolver({ exit: 4, stderr: "state is not finite at t=1e-6\n" }),
      onOutput: collect().onOutput,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.kind).toBe("failed");
      expect(result.summary).toMatch(/status 4/);
    }
  });

  it("a run with no rules declared is an empty log, not a missing file", async () => {
    // The solver writes the event file "only for a netlist that declares
    // rules", so every rule-free deck would otherwise fail at the last step of
    // a successful run.
    const result = await runSimulation(request, {
      runDirectory: runDirectory(),
      resolve: () => found,
      spawn: fakeSolver({ events: "" }),
      onOutput: collect().onOutput,
    });
    if (!result.ok) throw new Error(result.summary);
    expect(result.worstSeverity).toBe(null);
    expect(result.eventsTotal).toBe(0);
  });

  it("caps what travels but never the count", async () => {
    const many = Array.from(
      { length: 250 },
      (_, i) =>
        `{"record":"event","rule":"i_max","target":"D1","severity":"warning","time":${i}e-9,"value":1,"limit":0}`,
    ).join("\n");
    const result = await runSimulation(request, {
      runDirectory: runDirectory(),
      resolve: () => found,
      spawn: fakeSolver({ events: many }),
      onOutput: collect().onOutput,
    });
    if (!result.ok) throw new Error(result.summary);
    expect(result.events.length).toBe(200);
    expect(result.eventsTotal).toBe(250);
  });
});

describe("a run that does not work", () => {
  it("surfaces everywhere the solver was looked for, not just 'not found'", async () => {
    // The whole value of `SolverNotFound` is its list: the user's next
    // question is always "where did you look", and the answer tells them which
    // of the five things to set.
    const sink = collect();
    const result = await runSimulation(request, {
      runDirectory: runDirectory(),
      resolve: () => {
        throw new SolverNotFound(
          ["omniSchematics.generalSimulatorPath: /nope", "PATH: no general-simulator"],
          "linux",
        );
      },
      spawn: () => {
        throw new Error("must not be reached");
      },
      onOutput: sink.onOutput,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.kind).toBe("solver-not-found");
    expect(result.detail).toMatch(/omniSchematics.generalSimulatorPath: \/nope/);
    expect(result.detail).toMatch(/cargo build --release -p general-simulator-cli/);
    // And every line of it in the panel, not just the first.
    expect(texts(sink.lines)).toEqual(
      expect.arrayContaining([
        expect.stringContaining("PATH: no general-simulator"),
        expect.stringContaining("cargo build --release"),
      ]),
    );
  });

  it("reports a solver that exits cleanly and writes nothing", async () => {
    const result = await runSimulation(request, {
      runDirectory: runDirectory(),
      resolve: () => found,
      spawn: fakeSolver({ container: null }),
      onOutput: collect().onOutput,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.kind).toBe("no-result");
      expect(result.detail).toMatch(/ENOENT|no such file/i);
    }
  });

  it("reports a container the run was killed partway through as truncated", async () => {
    // The file a timeout or a Stop leaves behind. It has to be told apart from
    // a complete one, because its missing footer is not corruption.
    const truncated = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "gsim-trunc-")), "part");
    const whole = fs.readFileSync(CONTAINER);
    fs.writeFileSync(truncated, whole.subarray(0, whole.length - 40));
    const result = await runSimulation(request, {
      runDirectory: runDirectory(),
      resolve: () => found,
      spawn: fakeSolver({ container: truncated }),
      onOutput: collect().onOutput,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.kind).toBe("no-result");
      expect(result.detail).toMatch(/truncated/);
    }
  });

  it("reports a spawn that never starts", async () => {
    const result = await runSimulation(request, {
      runDirectory: runDirectory(),
      resolve: () => found,
      spawn: () => spawn(path.join(os.tmpdir(), "not-a-binary-at-all")),
      onOutput: collect().onOutput,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.kind).toBe("could-not-start");
  });

  it("stops when the child is signalled, and says so", async () => {
    // What Stop does: the host holds the child now, so cancelling a run means
    // signalling the process rather than closing a socket and leaving it
    // running.
    const result = await runSimulation(request, {
      runDirectory: runDirectory(),
      resolve: () => found,
      spawn: () => spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"]),
      onChild: (child) => setTimeout(() => child.kill("SIGTERM"), 50),
      onOutput: collect().onOutput,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.summary).toMatch(/SIGTERM|status/);
  });

  it("times out rather than waiting for ever", async () => {
    const result = await runSimulation(request, {
      runDirectory: runDirectory(),
      resolve: () => found,
      spawn: () => spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"]),
      onOutput: collect().onOutput,
      timeoutMs: 150,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.kind).toBe("timed-out");
      expect(result.summary).toMatch(/still running after 150 ms/);
    }
  });
});

describe("describeEvent", () => {
  it("reads as a sentence, with the unit on both numbers", () => {
    expect(
      describeEvent({
        rule: "i_max",
        target: "D1",
        severity: "warning",
        time: 1.5e-6,
        value: 12.3,
        limit: 10,
        unit: "A",
        detail: "D1,L1",
      }),
    ).toBe("i_max on D1: 12.3 A against a limit of 10 A at t=0.0000015 s (D1,L1)");
  });
});

// ---------------------------------------------------------------------------
// The real solver. Skipped, loudly, when there is none.
// ---------------------------------------------------------------------------
function realSolver(): string | null {
  const configured = process.env.GSIM_GENERAL_SIMULATOR_PATH;
  if (configured && fs.existsSync(configured)) return configured;
  return null;
}

describe("the real general-simulator", () => {
  const binary = realSolver();
  const guarded = binary ? it : it.skip;

  guarded(
    "compiles nothing, runs the deck, and leaves a result the schema accepts",
    async () => {
      const directory = runDirectory();
      const sink = collect();
      const result = await runSimulation(request, {
        runDirectory: directory,
        resolve: () => ({ binary: binary as string, source: "the path passed in" }),
        spawn: (b, args) => spawn(b, args, { cwd: directory }),
        onOutput: sink.onOutput,
      });

      if (!result.ok) throw new Error(`${result.summary}\n${result.detail ?? ""}`);
      expect(result.signals).toEqual(["V(n_in)", "V(n_out)", "I(v1)"]);
      expect(result.rows).toBe(20);
      expect(result.samplesBytes).toBeGreaterThan(900);
      const document = JSON.parse(fs.readFileSync(result.resultPath, "utf8"));
      expect(validateGsimSimResultDocument(document)).toBe(true);
    },
    60_000,
  );
});

// ---------------------------------------------------------------------------
// #234 — where the solver is spawned, which is where a relative lib=/path=
// resolves.
// ---------------------------------------------------------------------------

describe("the working directory a run is spawned in", () => {
  it("is the schematic's own folder, not the run directory", async () => {
    const directory = runDirectory();
    const sheetFolder = fs.mkdtempSync(path.join(os.tmpdir(), "gsim-sheet-"));
    scratch.push(sheetFolder);
    let seen: string | undefined;
    const result = await runSimulation(request, {
      runDirectory: directory,
      schematicFolder: sheetFolder,
      resolve: () => found,
      spawn: (b, args, cwd) => {
        seen = cwd;
        return fakeSolver()(b, args);
      },
      onOutput: collect().onOutput,
    });

    expect(result.ok).toBe(true);
    expect(seen).toBe(sheetFolder);
  });

  it("says which directory it used, so a reader can reproduce the run by hand", async () => {
    const directory = runDirectory();
    const sheetFolder = fs.mkdtempSync(path.join(os.tmpdir(), "gsim-sheet-"));
    scratch.push(sheetFolder);
    const sink = collect();
    await runSimulation(request, {
      runDirectory: directory,
      schematicFolder: sheetFolder,
      resolve: () => found,
      spawn: (b, args) => fakeSolver()(b, args),
      onOutput: sink.onOutput,
    });

    // The command line is logged verbatim already; without the directory it
    // was logged from, a line whose netlist carries `lib=./ctrl.so` cannot be
    // pasted into a terminal and reproduced.
    expect(texts(sink.lines).some((text) => text.includes(sheetFolder))).toBe(true);
  });

  it("falls back to the run directory for a sheet that has never been saved", async () => {
    const directory = runDirectory();
    let seen: string | undefined;
    const result = await runSimulation(request, {
      runDirectory: directory,
      schematicFolder: undefined,
      resolve: () => found,
      spawn: (b, args, cwd) => {
        seen = cwd;
        return fakeSolver()(b, args);
      },
      onOutput: collect().onOutput,
    });

    // A sheet of resistors has nothing to resolve, so this must keep working.
    expect(result.ok).toBe(true);
    expect(seen).toBe(directory);
  });

  it("refuses an unsaved sheet whose code block names a relative path", async () => {
    const directory = runDirectory();
    const sink = collect();
    const result = await runSimulation(
      {
        ...request,
        source: undefined,
        netlist: `${NETLIST}G1 kind=pyblock path=./ctrl.py in=VPROBE outputs=y\n`,
      },
      {
        runDirectory: directory,
        schematicFolder: undefined,
        resolve: () => found,
        spawn: () => {
          throw new Error("the solver must not be spawned for a run that cannot resolve its paths");
        },
        onOutput: sink.onOutput,
      },
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.summary).toMatch(/save the schematic/i);
    // The block and its path, because "a code block" does not say which one.
    expect(`${result.detail}`).toContain("G1");
    expect(`${result.detail}`).toContain("./ctrl.py");
  });

  it("lets an unsaved sheet whose code block is absolute through", async () => {
    const directory = runDirectory();
    const result = await runSimulation(
      {
        ...request,
        source: undefined,
        netlist: `${NETLIST}G1 kind=pyblock path=/tmp/ctrl.py in=VPROBE outputs=y\n`,
      },
      {
        runDirectory: directory,
        schematicFolder: undefined,
        resolve: () => found,
        spawn: (b, args) => fakeSolver()(b, args),
        onOutput: collect().onOutput,
      },
    );
    expect(result.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// #234 end to end: a sheet saved beside its own C block runs, and the block's
// output is in the result.
//
// A `cscript` block rather than Python or Octave, because this is the one of
// the three that needs nothing of the engine build and nothing installed
// beyond a C compiler -- which every runner that builds this repository's Rust
// crate already has. Skipped, loudly, without a solver or a compiler.
// ---------------------------------------------------------------------------
function systemCompiler(): string | null {
  for (const candidate of ["cc", "gcc", "clang"]) {
    const probe = cp.spawnSync(candidate, ["--version"], { stdio: "ignore" });
    if (probe.status === 0) return candidate;
  }
  return null;
}

describe("a sheet saved beside its own code block", () => {
  const binary = realSolver();
  const compiler = systemCompiler();
  const guarded = binary && compiler ? it : it.skip;

  guarded(
    "runs, and the block's output is in the result",
    async () => {
      // A space *and* an accent in the folder name, deliberately: this machine's own project
      // path is `Github Works/Électronique`, and a check that only passes on an ASCII path
      // would be green here and red where the owner works. Both survive provided the child is
      // spawned with an argv rather than through a shell -- which `host.ts` does, and which is
      // what this exercises.
      const scratchRoot = fs.mkdtempSync(path.join(os.tmpdir(), "gsim-code-block-"));
      scratch.push(scratchRoot);
      const sheetFolder = path.join(scratchRoot, "Sheet Électronique");
      fs.mkdirSync(sheetFolder);
      // `cscript_arity` so the engine checks the shape before the first step,
      // and the engine's real ABI -- there is no `t` in it.
      fs.writeFileSync(
        path.join(sheetFolder, "gain.c"),
        [
          "int cscript_arity(int *in_len, int *out_len) {",
          "    *in_len = 1; *out_len = 1; return 0;",
          "}",
          "void *cscript_start(void) { return 0; }",
          "void cscript_output(void *state, const double *in, int in_len, double dt,",
          "                    double *out, int out_len) {",
          "    (void)state; (void)in_len; (void)dt; (void)out_len;",
          "    out[0] = 2.0 * in[0];",
          "}",
          "",
        ].join("\n"),
      );
      const built = cp.spawnSync(
        compiler as string,
        ["-shared", "-fPIC", "-O0", "-o", "libgain.so", "gain.c"],
        { cwd: sheetFolder, encoding: "utf8" },
      );
      expect(built.status, built.stderr).toBe(0);

      // `lib=./libgain.so` -- relative, which is what every real sheet writes
      // and is the whole subject of #234.
      const deck = [
        "* A textbook RC low-pass whose capacitor voltage feeds one code block.",
        "V1 n1 0 SIN(0 1 1k)",
        "R1 n1 n2 1k",
        "C1 n2 0 1u",
        "VPROBE kind=phys2sig node=n2",
        "G1 kind=cscript lib=./libgain.so in=VPROBE outputs=y",
        "",
      ].join("\n");

      const directory = runDirectory();
      const sink = collect();
      const result = await runSimulation(
        {
          mode: "transient" as const,
          netlist: deck,
          tEnd: 1e-4,
          tStep: 1e-5,
          analysis: "TRAN",
          source: "sheet.gsim_sch",
        },
        {
          runDirectory: directory,
          schematicFolder: sheetFolder,
          resolve: () => ({ binary: binary as string, source: "the path passed in" }),
          spawn: (b, args, cwd) => spawn(b, args, { cwd }),
          onOutput: sink.onOutput,
        },
      );

      if (!result.ok) {
        throw new Error(
          `${result.summary}\n${result.detail ?? ""}\n${texts(sink.lines).join("\n")}`,
        );
      }
      // Not "it exited 0": the block's own output column has to be in the
      // result, which is what proves the library was found and called.
      expect(result.signals).toContain("G1");
      // And the run's own four files still land in the run directory, which is
      // the half of #234 that `cwd` used to be doing.
      for (const file of [NETLIST_FILE, SAMPLES_FILE, RESULT_FILE]) {
        expect(fs.existsSync(path.join(directory, file)), file).toBe(true);
      }
    },
    120_000,
  );
});

// ---------------------------------------------------------------------------
// #235 — a library built from code the user has since changed must not run
// quietly. The silent wrong result, reproduced with a real compiled library.
// ---------------------------------------------------------------------------

describe("a code block whose library is older than its source", () => {
  const binary = realSolver();
  const compiler = systemCompiler();
  const guarded = binary && compiler ? it : it.skip;

  /** A sheet folder with `gain.c` compiled to `libgain.so`, and the deck that uses it. */
  function sheetWithCompiledBlock(gain: number): { folder: string; deck: string } {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "gsim-stale-"));
    scratch.push(root);
    const folder = path.join(root, "Sheet Électronique");
    fs.mkdirSync(folder);
    fs.writeFileSync(
      path.join(folder, "gain.c"),
      [
        "int cscript_arity(int *in_len, int *out_len) {",
        "    *in_len = 1; *out_len = 1; return 0;",
        "}",
        "void *cscript_start(void) { return 0; }",
        "void cscript_output(void *state, const double *in, int in_len, double dt,",
        "                    double *out, int out_len) {",
        "    (void)state; (void)in_len; (void)dt; (void)out_len;",
        `    out[0] = ${gain}.0 * in[0];`,
        "}",
        "",
      ].join("\n"),
    );
    const built = cp.spawnSync(
      compiler as string,
      ["-shared", "-fPIC", "-O0", "-o", "libgain.so", "gain.c"],
      { cwd: folder, encoding: "utf8" },
    );
    expect(built.status, built.stderr).toBe(0);
    const deck = [
      "* A textbook RC low-pass whose capacitor voltage feeds one code block.",
      "V1 n1 0 SIN(0 1 1k)",
      "R1 n1 n2 1k",
      "C1 n2 0 1u",
      "VPROBE kind=phys2sig node=n2",
      "G1 kind=cscript lib=./libgain.so in=VPROBE outputs=y",
      "",
    ].join("\n");
    return { folder, deck };
  }

  // Paths relative to the sheet, which the host resolves against the directory it spawns the
  // solver in -- so this needs no folder of its own.
  const blockList = () => [
    {
      blockId: "G1",
      language: "c" as const,
      artifact: "./libgain.so",
      // What `code-source.ts`'s convention offers, best first. Only the last exists here, which
      // is also what makes this a real exercise of the candidate walk.
      sourceCandidates: ["blocks/gain.c", "gain.c", "src/gain.c"],
      inferredSource: true,
    },
  ];

  const requestFor = (deck: string) => ({
    mode: "transient" as const,
    netlist: deck,
    tEnd: 1e-4,
    tStep: 1e-5,
    analysis: "TRAN",
    source: "sheet.gsim_sch",
    codeBlocks: blockList(),
  });

  guarded(
    "is refused, naming the block, the source and the library",
    async () => {
      const { folder, deck } = sheetWithCompiledBlock(2);
      // The edit, without a rebuild. `utimesSync` rather than a sleep: the point is the
      // ordering of the two timestamps, and waiting for a clock tick makes the test slow and
      // flaky for no extra truth.
      fs.writeFileSync(
        path.join(folder, "gain.c"),
        fs.readFileSync(path.join(folder, "gain.c"), "utf8").replace("2.0 *", "10.0 *"),
      );
      const now = Date.now() / 1000;
      fs.utimesSync(path.join(folder, "libgain.so"), now - 60, now - 60);
      fs.utimesSync(path.join(folder, "gain.c"), now, now);

      const sink = collect();
      const result = await runSimulation(requestFor(deck), {
        runDirectory: runDirectory(),
        schematicFolder: folder,
        resolve: () => ({ binary: binary as string, source: "the path passed in" }),
        spawn: (b, args, cwd) => spawn(b, args, { cwd }),
        onOutput: sink.onOutput,
      });

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.summary).toMatch(/older than its source/i);
      const said = texts(sink.lines).join("\n");
      expect(said).toContain("G1");
      expect(said).toContain("gain.c");
      expect(said).toContain("libgain.so");
      expect(said).toMatch(/rebuild/i);
    },
    120_000,
  );

  guarded(
    "produces the stale answer when the check is switched off, which is the defect",
    async () => {
      // The measurement #235 is about, kept as an assertion so the thing being prevented stays
      // demonstrable: with `ignore`, the run completes against a library built from `2.0 *`
      // while the source says `10.0 *`, and reports success.
      const { folder, deck } = sheetWithCompiledBlock(2);
      fs.writeFileSync(
        path.join(folder, "gain.c"),
        fs.readFileSync(path.join(folder, "gain.c"), "utf8").replace("2.0 *", "10.0 *"),
      );
      const now = Date.now() / 1000;
      fs.utimesSync(path.join(folder, "libgain.so"), now - 60, now - 60);
      fs.utimesSync(path.join(folder, "gain.c"), now, now);

      const result = await runSimulation(requestFor(deck), {
        runDirectory: runDirectory(),
        schematicFolder: folder,
        staleCodeBlock: "ignore",
        resolve: () => ({ binary: binary as string, source: "the path passed in" }),
        spawn: (b, args, cwd) => spawn(b, args, { cwd }),
        onOutput: collect().onOutput,
      });

      if (!result.ok) throw new Error(`${result.summary}\n${result.detail ?? ""}`);
      expect(result.signals).toContain("G1");
    },
    120_000,
  );

  guarded(
    "runs when the library is newer than its source",
    async () => {
      const { folder, deck } = sheetWithCompiledBlock(2);
      const now = Date.now() / 1000;
      fs.utimesSync(path.join(folder, "gain.c"), now - 60, now - 60);
      fs.utimesSync(path.join(folder, "libgain.so"), now, now);

      const result = await runSimulation(requestFor(deck), {
        runDirectory: runDirectory(),
        schematicFolder: folder,
        resolve: () => ({ binary: binary as string, source: "the path passed in" }),
        spawn: (b, args, cwd) => spawn(b, args, { cwd }),
        onOutput: collect().onOutput,
      });

      if (!result.ok) throw new Error(`${result.summary}\n${result.detail ?? ""}`);
      expect(result.signals).toContain("G1");
    },
    120_000,
  );

  it("says it could not find a source, rather than nothing, when the convention misses", async () => {
    // No solver needed: the check runs before the spawn, and this arm never reaches it.
    const directory = runDirectory();
    const sheetFolder = fs.mkdtempSync(path.join(os.tmpdir(), "gsim-nosource-"));
    scratch.push(sheetFolder);
    fs.writeFileSync(path.join(sheetFolder, "libgain.so"), "not really a library");
    const sink = collect();
    const result = await runSimulation(
      {
        ...request,
        codeBlocks: [
          {
            blockId: "G1",
            language: "c" as const,
            artifact: "./libgain.so",
            sourceCandidates: ["blocks/gain.c", "gain.c"],
            inferredSource: true,
          },
        ],
      },
      {
        runDirectory: directory,
        schematicFolder: sheetFolder,
        resolve: () => found,
        spawn: (b, args) => fakeSolver()(b, args),
        onOutput: sink.onOutput,
      },
    );

    // Not a refusal: the library may well be correct, and the editor's candidate list is a
    // convention. But the run must not imply it checked.
    expect(result.ok).toBe(true);
    const said = texts(sink.lines).join("\n");
    expect(said).toMatch(/could not find the source/i);
    expect(said).toMatch(/convention/i);
  });
});

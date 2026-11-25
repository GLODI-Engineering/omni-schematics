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

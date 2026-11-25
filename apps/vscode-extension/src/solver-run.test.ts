import { spawn } from "node:child_process";
import { describe, expect, it } from "vitest";

import { type SolverLine, describeOutcome, runTransient, transientArgs } from "./solver-run";

const request = {
  netlistPath: "/tmp/deck.cir",
  samplesPath: "/tmp/run.gsim_samples",
  tEnd: 0.02,
  tStep: 5e-9,
};

/**
 * Runs real child processes rather than a fake `ChildProcess`.
 *
 * A fake would assert that this module wires up the events it wires up, which
 * is what it looks like it does. The parts that actually break are the ones a
 * fake cannot reach: a line arriving split across two chunks, a last line with
 * no newline after it, a kill landing between `close` and the timeout. Those
 * need a pipe.
 */
const node = (script: string) => (_binary: string, _args: string[]) =>
  spawn(process.execPath, ["-e", script]);

const collect = () => {
  const lines: SolverLine[] = [];
  return { lines, onLine: (line: SolverLine) => lines.push(line) };
};

describe("transientArgs", () => {
  it("asks the solver for the container, not for CSV", () => {
    // `--format samples` is the whole reason nothing in this process holds a
    // sample: the solver writes the container and hands back a path.
    expect(transientArgs(request)).toEqual([
      "/tmp/deck.cir",
      "--mode",
      "transient",
      "--tfinal",
      "0.02",
      "--dt",
      "5e-9",
      "--format",
      "samples",
      "--out",
      "/tmp/run.gsim_samples",
    ]);
  });
});

describe("transientArgs and the event stream", () => {
  it("asks for the event stream when a path is given", () => {
    // Without `--events` the engine writes its findings into a temporary
    // directory that goes away with the run, so every rating exceeded and
    // every short dead time was discarded.
    expect(transientArgs({ ...request, eventsPath: "/tmp/run.events.jsonl" })).toEqual([
      ...transientArgs(request),
      "--events",
      "/tmp/run.events.jsonl",
    ]);
  });

  it("omits the flag entirely when no path is given", () => {
    // Not an empty `--events ""`, which the solver would take as a filename.
    expect(transientArgs(request)).not.toContain("--events");
  });
});

describe("runTransient", () => {
  it("reports where the samples went when the solver succeeds", async () => {
    const { onLine } = collect();
    const outcome = await runTransient({
      binary: "general-simulator",
      request,
      onLine,
      spawn: node("process.exit(0)"),
    });
    expect(outcome).toEqual({ kind: "completed", samplesPath: "/tmp/run.gsim_samples" });
  });

  it("reports the exit status when it fails", async () => {
    const { onLine } = collect();
    const outcome = await runTransient({
      binary: "general-simulator",
      request,
      onLine,
      spawn: node("process.exit(3)"),
    });
    expect(outcome).toEqual({ kind: "failed", code: 3, signal: null });
  });

  it("keeps stdout and stderr apart", async () => {
    // The sidecar merged them, so a solver diagnostic arrived interleaved with
    // everything else and the Output panel could not label it.
    const { lines, onLine } = collect();
    await runTransient({
      binary: "general-simulator",
      request,
      onLine,
      spawn: node(
        "console.log('t,V(out)'); console.error('warning: no reference net'); console.log('0,0')",
      ),
    });
    // Asserted per stream, not as one ordered list: stdout and stderr are
    // separate pipes and nothing promises how two of them interleave. The
    // contract is that a line arrives whole and labelled with where it came
    // from -- and that stderr is not swallowed, which is what regressed before.
    const of = (stream: "stdout" | "stderr") =>
      lines.filter((line) => line.stream === stream).map((line) => line.text);
    expect(of("stdout")).toEqual(["t,V(out)", "0,0"]);
    expect(of("stderr")).toEqual(["warning: no reference net"]);
  });

  it("reassembles a line that arrives in pieces", async () => {
    // A chunk boundary falls wherever the pipe buffer filled, which is never
    // where a line ends. Half a line in the Output panel reads as corruption.
    const { lines, onLine } = collect();
    await runTransient({
      binary: "general-simulator",
      request,
      onLine,
      spawn: node(
        "process.stdout.write('one-'); setTimeout(() => process.stdout.write('line\\n'), 20)",
      ),
    });
    expect(lines).toEqual([{ stream: "stdout", text: "one-line" }]);
  });

  it("delivers a final line that has no newline after it", async () => {
    const { lines, onLine } = collect();
    await runTransient({
      binary: "general-simulator",
      request,
      onLine,
      spawn: node("process.stdout.write('no trailing newline')"),
    });
    expect(lines).toEqual([{ stream: "stdout", text: "no trailing newline" }]);
  });

  it("stops a run that overruns, and says how long it waited", async () => {
    const { onLine } = collect();
    const outcome = await runTransient({
      binary: "general-simulator",
      request: { ...request, timeoutMs: 120 },
      onLine,
      spawn: node("setTimeout(() => {}, 60_000)"),
    });
    expect(outcome).toEqual({ kind: "timed-out", afterMs: 120 });
  });

  it("does not time out a run that finished in time", async () => {
    const { onLine } = collect();
    const outcome = await runTransient({
      binary: "general-simulator",
      request: { ...request, timeoutMs: 10_000 },
      onLine,
      spawn: node("process.exit(0)"),
    });
    expect(outcome.kind).toBe("completed");
  });

  it("says the solver could not be started rather than throwing", async () => {
    // Every way a run can end is a value here: all of them are things the user
    // needs told, and a rejection would only be caught and turned back into one.
    const { onLine } = collect();
    const outcome = await runTransient({
      binary: "/nonexistent/general-simulator",
      request,
      onLine,
      spawn: (binary, args) => spawn(binary, args),
    });
    expect(outcome.kind).toBe("could-not-start");
  });
});

describe("describeOutcome", () => {
  it("points at the Output panel for a failure, where the solver's own words are", () => {
    expect(describeOutcome({ kind: "failed", code: 2, signal: null })).toBe(
      "The solver exited with status 2. See the Output panel.",
    );
    expect(describeOutcome({ kind: "failed", code: null, signal: "SIGSEGV" })).toContain("SIGSEGV");
    expect(describeOutcome({ kind: "timed-out", afterMs: 500 })).toContain("500 ms");
    expect(describeOutcome({ kind: "could-not-start", reason: "ENOENT" })).toContain("ENOENT");
  });
});

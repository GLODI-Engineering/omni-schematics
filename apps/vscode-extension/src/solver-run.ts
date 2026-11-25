/**
 * Running `general-simulator` and reporting what it said.
 *
 * This replaced `simulator/solvers/` -- 794 lines of Python whose whole job was
 * to find a binary, start it, read what it printed, and time it out. The
 * extension already does exactly that for a child process elsewhere, one level
 * up, so doing it here costs a module rather than an interpreter. That package
 * is deleted (#162).
 *
 * ## stdout and stderr stay apart
 *
 * The sidecar merged them, so a solver diagnostic arrived interleaved with
 * whatever else was on the wire and the Output panel could not label it. They
 * are separate channels here, which is what #139 asked for and is free once
 * the spawn is local.
 *
 * ## Why `--format samples`
 *
 * The solver writes the result container directly, so nothing in this process
 * ever holds a sample. A ten-gigabyte run is a path handed to the viewer, not
 * a payload crossing an IPC boundary. It is also why there is no CSV parser
 * here: the old path went solver -> CSV -> Python -> HDF5, and two of those
 * three steps existed only to move numbers between formats.
 */

import type { ChildProcess } from "node:child_process";

/** A line the solver printed, and which stream it came from. */
export interface SolverLine {
  stream: "stdout" | "stderr";
  text: string;
}

export interface TransientRequest {
  /** The netlist, already compiled. This module does not compile anything. */
  netlistPath: string;
  /** Where the solver should write its `.gsim_samples` container. */
  samplesPath: string;
  /**
   * Where the solver should write its rule-event stream, read back by
   * `event-log.ts`.
   *
   * Asked for explicitly because without `--events` the engine writes the file
   * into a temporary directory that is deleted with the run, so every finding
   * of every run was discarded (#68). A run with no rules declared writes no
   * file at all, which is an empty log rather than an error.
   */
  eventsPath?: string;
  tEnd: number;
  tStep: number;
  /** Abandon the run after this long. `undefined` waits indefinitely. */
  timeoutMs?: number;
}

export type SolverOutcome =
  | { kind: "completed"; samplesPath: string }
  | { kind: "failed"; code: number | null; signal: NodeJS.Signals | null }
  | { kind: "timed-out"; afterMs: number }
  | { kind: "could-not-start"; reason: string };

/**
 * The command line for a transient run.
 *
 * Separate from running it so the arguments can be asserted without a binary
 * and shown to the user verbatim -- a run that fails is much easier to
 * explain when the exact command is in the Output panel.
 */
export function transientArgs(request: TransientRequest): string[] {
  const args = [
    request.netlistPath,
    "--mode",
    "transient",
    "--tfinal",
    String(request.tEnd),
    "--dt",
    String(request.tStep),
    "--format",
    "samples",
    "--out",
    request.samplesPath,
  ];
  if (request.eventsPath !== undefined) {
    args.push("--events", request.eventsPath);
  }
  return args;
}

export interface RunOptions {
  binary: string;
  request: TransientRequest;
  onLine: (line: SolverLine) => void;
  /** Injected so the whole module is testable without a solver. */
  spawn: (binary: string, args: string[]) => ChildProcess;
}

/**
 * Runs the solver to completion, a timeout, or a failure to start.
 *
 * Never rejects: every way a run can end is a value, because all four are
 * things the user needs told rather than exceptions to propagate. A rejected
 * promise here would just be caught and turned back into one of these.
 */
export function runTransient(options: RunOptions): Promise<SolverOutcome> {
  const { binary, request, onLine, spawn } = options;
  const args = transientArgs(request);

  return new Promise<SolverOutcome>((resolve) => {
    let child: ChildProcess;
    try {
      child = spawn(binary, args);
    } catch (error) {
      resolve({
        kind: "could-not-start",
        reason: error instanceof Error ? error.message : String(error),
      });
      return;
    }

    let settled = false;
    const settle = (outcome: SolverOutcome) => {
      if (settled) {
        return;
      }
      settled = true;
      if (timer !== undefined) {
        clearTimeout(timer);
      }
      resolve(outcome);
    };

    let timer: ReturnType<typeof setTimeout> | undefined;
    if (request.timeoutMs !== undefined) {
      timer = setTimeout(() => {
        // SIGTERM rather than SIGKILL: the solver writes its container's
        // footer last, so a run killed politely still leaves a file whose
        // trailing magic is missing, which the reader reports as truncated
        // rather than as rubbish.
        child.kill("SIGTERM");
        settle({ kind: "timed-out", afterMs: request.timeoutMs as number });
      }, request.timeoutMs);
    }

    const pump = (stream: "stdout" | "stderr") => {
      const source = stream === "stdout" ? child.stdout : child.stderr;
      if (!source) {
        return;
      }
      let pending = "";
      source.setEncoding("utf8");
      source.on("data", (chunk: string) => {
        pending += chunk;
        // Split on newlines and keep the remainder: a chunk boundary falls
        // wherever the pipe buffer happened to fill, which is never where a
        // line ends, and a half-line in the Output panel reads as corruption.
        const lines = pending.split("\n");
        pending = lines.pop() ?? "";
        for (const text of lines) {
          onLine({ stream, text });
        }
      });
      source.on("end", () => {
        if (pending.length > 0) {
          onLine({ stream, text: pending });
          pending = "";
        }
      });
    };
    pump("stdout");
    pump("stderr");

    child.on("error", (error) => {
      settle({ kind: "could-not-start", reason: error.message });
    });

    child.on("close", (code, signal) => {
      if (code === 0) {
        settle({ kind: "completed", samplesPath: request.samplesPath });
      } else {
        settle({ kind: "failed", code, signal });
      }
    });
  });
}

/** What to show a user for an outcome, without the Output panel's detail. */
export function describeOutcome(outcome: SolverOutcome): string {
  switch (outcome.kind) {
    case "completed":
      return "Simulation finished.";
    case "failed":
      return outcome.signal
        ? `The solver was killed by ${outcome.signal}. See the Output panel.`
        : `The solver exited with status ${outcome.code}. See the Output panel.`;
    case "timed-out":
      return `The solver was still running after ${outcome.afterMs} ms and was stopped.`;
    case "could-not-start":
      return `The solver could not be started: ${outcome.reason}`;
  }
}

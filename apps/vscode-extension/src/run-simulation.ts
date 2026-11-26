/**
 * One run, from a netlist to a `.gsim_sim_result` — the step that takes Python
 * out of running a simulation (#159).
 *
 * Everything here was already in this directory as a tested piece with no
 * caller: `solver-path.ts` finds the binary, `solver-run.ts` runs it,
 * `event-log.ts` reads what it found, `result-manifest.ts` writes the document.
 * This is the order they go in, and it is deliberately the only module that
 * knows that order.
 *
 * ## Why it takes its world as arguments
 *
 * Nothing here imports `vscode`. The host passes in a directory, a spawn, a
 * resolve and a sink for output, so the whole sequence runs under vitest
 * against the real solver binary and the real file system — which is the only
 * test of this that means anything. `host.ts` is the adapter: settings in,
 * `vscode.Uri` out.
 *
 * ## What it does not do
 *
 * It does not compile. The netlist arrives already compiled, as a string, and
 * that is the decision recorded on #175: the engine runs where it is already
 * loaded, in the webview, because `vsce package --no-dependencies` ships no
 * `node_modules` for a second copy to be imported from.
 *
 * It does not read a sample, either. `--format samples` has the solver write
 * the container itself, this reads only its footer for the names a manifest
 * needs, and the viewer reads windows out of it (#163). A ten-gigabyte run is
 * a path handed on, never a payload.
 */

import type { ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import type {
  RunEventSummary,
  RunOutputLine,
  RunRequest,
  RunResult,
} from "@gensim/webview-protocol";

import { type EventLog, emptyEventLog, parseEventLogText, worstSeverity } from "./event-log";
import { buildManifest, serializeManifest } from "./result-manifest";
import { type SamplesIndex, readSamplesIndex } from "./samples-index";
import { type ResolvedSolver, SolverNotFound } from "./solver-path";
import { type SolverOutcome, describeOutcome, runTransient, transientArgs } from "./solver-run";

/** The files one run owns, all inside its own directory. */
export const NETLIST_FILE = "netlist.cir";
export const SAMPLES_FILE = "run.gsim_samples";
export const EVENTS_FILE = "events.jsonl";
export const RESULT_FILE = "result.gsim_sim_result";

/**
 * Events sent to the webview per run.
 *
 * A rule on a switching converter can fire on every cycle, so a long run's log
 * is tens of thousands of records. They cross a structured-clone boundary and
 * land in a list a human reads, and neither survives that many. The cap is on
 * what travels; `eventsTotal` always carries the real number, so a truncated
 * list is never presented as complete.
 */
export const MAX_EVENTS_REPORTED = 200;

/**
 * Exit statuses that mean a rule fired, not that the run failed.
 *
 * From the solver's own `--fail-on` documentation: `2` is "a rule reached the
 * severity that makes this process exit non-zero" and `3` is "a rule ended the
 * run". Both leave a complete container and a complete event log, and both are
 * results the user wants to see — being told only "the solver exited with
 * status 2" would hide the finding that caused it. Anything else is a failure,
 * including `4` (a non-finite state), where the numbers are not to be trusted.
 */
const RULE_EXIT_CODES = new Set([2, 3]);

export interface RunDependencies {
  /** Where this run's four files go. Created if it does not exist. */
  runDirectory: string;
  /** The binary, or a throw carrying everywhere it was looked for. */
  resolve: () => ResolvedSolver;
  /** How the solver is started. The host bakes the settings' environment in. */
  spawn: (binary: string, args: string[]) => ChildProcess;
  /** Lines for the Output panel, as they arrive. */
  onOutput: (lines: RunOutputLine[]) => void;
  /** Called once with the child, so Stop can signal it. */
  onChild?: (child: ChildProcess) => void;
  /** Abandon the run after this long. `undefined` waits indefinitely. */
  timeoutMs?: number;
  /** Injected in tests; defaults to the real container reader. */
  readIndex?: (file: string) => SamplesIndex;
  /** Injected in tests, so a whole document can be asserted. */
  now?: () => Date;
}

const line = (
  severity: RunOutputLine["severity"],
  text: string,
  source: RunOutputLine["source"] = "solver",
): RunOutputLine => ({ source, severity, text });

/**
 * Everything the solver printed, labelled by the stream it came from.
 *
 * stdout is `info` and stderr is `warning`, which is the only honest mapping
 * available: the two are separate pipes and that is all this process knows
 * about them. Telling a `cscript` compiler diagnostic apart from a solver
 * complaint by *content* is #139 step 4 and needs the diagnostics parsed into
 * a `DiagnosticCollection`; guessing from the text here would be worse than
 * being visibly unfinished. What #139 step 3 asked for — that the two streams
 * stop arriving interleaved as one opaque blob, as the sidecar merged them —
 * is what this gives, and it came free with the local spawn.
 */
const forStream = (stream: "stdout" | "stderr", text: string): RunOutputLine =>
  line(stream === "stderr" ? "warning" : "info", text);

/** A rule event as the Problems panel shows it. */
export function summariseEvent(event: {
  rule: string;
  target: string;
  severity: string;
  time: number;
  value: number;
  limit: number;
  unit: string;
  detail: string;
}): RunEventSummary {
  return {
    rule: event.rule,
    target: event.target,
    severity: event.severity,
    time: event.time,
    value: event.value,
    limit: event.limit,
    unit: event.unit,
    detail: event.detail,
  };
}

/** One readable line for an event, for the Output channel. */
export function describeEvent(event: RunEventSummary): string {
  const unit = event.unit ? ` ${event.unit}` : "";
  const where = event.target ? ` on ${event.target}` : "";
  const why = event.detail ? ` (${event.detail})` : "";
  return (
    `${event.rule}${where}: ${event.value}${unit} against a limit of ` +
    `${event.limit}${unit} at t=${event.time} s${why}`
  );
}

/**
 * Read the event log the run was told to write, if it wrote one.
 *
 * An absent file is an empty log, not an error: the solver writes it "only for
 * a netlist that declares rules", so every deck without rules would otherwise
 * fail at the last step of a successful run. A file that is there and
 * unreadable *is* reported, as a warning, because a diagnostic channel must
 * not be able to fail a run that otherwise succeeded.
 */
export function readEventLog(file: string, onOutput: (lines: RunOutputLine[]) => void): EventLog {
  if (!fs.existsSync(file)) {
    return emptyEventLog();
  }
  try {
    return parseEventLogText(fs.readFileSync(file, "utf8"), {
      source: path.basename(file),
      onWarning: (message) => onOutput([line("warning", message)]),
    });
  } catch (error) {
    onOutput([
      line(
        "warning",
        `could not read the event log at ${file}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      ),
    ]);
    return emptyEventLog();
  }
}

/**
 * Run one analysis and write its result document.
 *
 * Returns an outcome and never rejects, for the reason `solver-run.ts` gives
 * for its own four values: all of them are things the user needs told, and a
 * rejection here would only be caught and turned back into one of them. The
 * one thing this guarantees is that it answers.
 */
export async function runSimulation(
  request: RunRequest,
  deps: RunDependencies,
): Promise<RunResult> {
  const { runDirectory, onOutput } = deps;

  let solver: ResolvedSolver;
  try {
    solver = deps.resolve();
  } catch (error) {
    if (error instanceof SolverNotFound) {
      // Every line of it, into the panel. The message is a list of the five
      // places it looked and the `cargo` line that builds a binary, and it is
      // the whole value of the error: flattened to "not found" it tells the
      // user nothing they did not already know.
      onOutput(error.message.split("\n").map((text) => line("error", text)));
      return {
        ok: false,
        kind: "solver-not-found",
        summary: "Cannot find the general-simulator binary",
        detail: error.message,
      };
    }
    const detail = error instanceof Error ? error.message : String(error);
    onOutput([line("error", `could not resolve the solver: ${detail}`)]);
    return { ok: false, kind: "could-not-start", summary: "Could not resolve the solver", detail };
  }

  const netlistPath = path.join(runDirectory, NETLIST_FILE);
  const samplesPath = path.join(runDirectory, SAMPLES_FILE);
  const eventsPath = path.join(runDirectory, EVENTS_FILE);
  const manifestPath = path.join(runDirectory, RESULT_FILE);

  try {
    fs.mkdirSync(runDirectory, { recursive: true });
    // Written to a file rather than piped to stdin: the solver takes its deck
    // as a positional path, the file is what makes a failed run reproducible
    // by hand, and `--events-text` and `kind=measure`'s `.log` are named after
    // this file's stem, so they land in this directory too.
    fs.writeFileSync(
      netlistPath,
      request.netlist.endsWith("\n") ? request.netlist : `${request.netlist}\n`,
    );
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    onOutput([line("error", `could not write the run directory ${runDirectory}: ${detail}`)]);
    return {
      ok: false,
      kind: "could-not-start",
      summary: "Could not write this run's files",
      detail,
    };
  }

  const transient = {
    netlistPath,
    samplesPath,
    eventsPath,
    mode: request.mode,
    tEnd: request.tEnd,
    tStep: request.tStep,
    timeoutMs: deps.timeoutMs,
  };
  // The exact command, verbatim, before it runs. A run that fails is far
  // easier to explain when the user can paste the line into a terminal, and it
  // is the reason `transientArgs` is a separate function at all.
  onOutput([
    line("info", `found at ${solver.binary} (from ${solver.source})`),
    line("info", [solver.binary, ...transientArgs(transient)].join(" ")),
  ]);

  const outcome: SolverOutcome = await runTransient({
    binary: solver.binary,
    request: transient,
    onLine: ({ stream, text }) => onOutput([forStream(stream, text)]),
    spawn: (binary, args) => {
      const child = deps.spawn(binary, args);
      deps.onChild?.(child);
      return child;
    },
  });

  const ruleExit =
    outcome.kind === "failed" && outcome.code !== null && RULE_EXIT_CODES.has(outcome.code);
  if (outcome.kind !== "completed" && !ruleExit) {
    const summary = describeOutcome(outcome);
    onOutput([line("error", summary)]);
    return {
      ok: false,
      // The three remaining outcomes are the three failure kinds by the same
      // names, so this is a widening rather than a translation.
      kind: outcome.kind,
      summary,
      detail:
        outcome.kind === "failed" && outcome.signal ? `killed by ${outcome.signal}` : undefined,
    };
  }
  if (ruleExit && outcome.kind === "failed") {
    // Said, not swallowed: the run produced a result and a rule is why it
    // exited non-zero, and the user should see both facts.
    onOutput([
      line(
        "warning",
        `the solver exited with status ${outcome.code}, which is a rule firing — ` +
          "the result below is complete",
      ),
    ]);
  }

  let index: SamplesIndex;
  try {
    index = (deps.readIndex ?? readSamplesIndex)(samplesPath);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    onOutput([line("error", `the solver exited cleanly but its result cannot be read: ${detail}`)]);
    return {
      ok: false,
      kind: "no-result",
      summary: "The solver produced no readable result",
      detail,
    };
  }

  const log = readEventLog(eventsPath, onOutput);
  const events = log.events.map(summariseEvent);
  for (const event of events.slice(0, MAX_EVENTS_REPORTED)) {
    onOutput([
      line(
        event.severity === "error" || event.severity === "fatal"
          ? "error"
          : event.severity === "warning"
            ? "warning"
            : "info",
        describeEvent(event),
      ),
    ]);
  }
  if (log.unreadableLines > 0) {
    onOutput([line("warning", `${log.unreadableLines} event record(s) could not be read`)]);
  }

  const manifest = buildManifest({
    runId: path.basename(runDirectory),
    analysis: request.analysis,
    source: request.source,
    samplesPath,
    manifestPath,
    // `s` and `time` are not a guess: a transient run's sweep is simulated
    // seconds, which is the mode this process asked for. The signals' units
    // are whatever the container says, which is "" — a netlist carries none,
    // so the solver writes none, and inventing volts from a `V(` prefix would
    // be a guess about a name the engine chose.
    sweep: { name: index.sweep.name || "t", unit: index.sweep.unit || "s", domain: "time" },
    signals: index.signals.map((signal) => ({
      name: signal.name,
      unit: signal.unit,
      ...(signal.quantity ? { quantity: signal.quantity } : {}),
    })),
    created: (deps.now ?? (() => new Date()))().toISOString(),
  });

  try {
    fs.writeFileSync(manifestPath, serializeManifest(manifest));
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    onOutput([line("error", `could not write ${manifestPath}: ${detail}`)]);
    return {
      ok: false,
      kind: "no-result",
      summary: "The run finished but its result document could not be written",
      detail,
    };
  }

  const samplesBytes = fs.statSync(samplesPath).size;
  onOutput([
    line(
      "info",
      `wrote ${manifestPath} — ${index.signals.length} signal(s), ${index.rows} samples each, ` +
        `${samplesBytes} bytes of container`,
    ),
  ]);

  return {
    ok: true,
    resultPath: manifestPath,
    samplesPath,
    samplesBytes,
    rows: index.rows,
    signals: index.signals.map((signal) => signal.name),
    worstSeverity: worstSeverity(log),
    events: events.slice(0, MAX_EVENTS_REPORTED),
    eventsTotal: events.length,
  };
}

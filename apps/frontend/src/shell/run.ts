/**
 * The Run button, end to end.
 *
 * ## Where a run happens now (#159)
 *
 * The editor compiles, the extension host runs the solver. Both halves are
 * local: `../engine/engine.ts` is `gsim-core` built to WebAssembly, and
 * `run-host.ts` posts the netlist to a host that resolves the
 * `general-simulator` binary, spawns it and writes the result document beside
 * the container it produced. Nothing in the path is a Python process, which is
 * the whole of the milestone this belongs to.
 *
 * What used to be here: a WebSocket to a kernel sidecar whose job was to find
 * that same binary, spawn it, read what it printed and time it out — 794 lines
 * of Python around a process the extension host was already placed to start.
 * `apps/kernel-sidecar/` and the socket client are still in the tree; deleting
 * them is #162, and the waveform store still reaches for the socket to fetch a
 * signal's samples until #163 teaches it to read the container.
 *
 * ## Why a click must always answer
 *
 * Run used to begin by connecting to the kernel and returning bare if that
 * failed, with the reason going to the Output panel — which starts hidden, so
 * from the outside clicking Run did nothing at all (#130). An empty schematic
 * was not checked anywhere, so that click did nothing either, for a different
 * reason the user could not tell apart. Every path through this file ends in a
 * toast, and the host answers every request it is sent, including with "I
 * cannot find the solver, and here is everywhere I looked".
 */
import { compileSchematic, initEngine } from "../engine/engine";
import { getWebviewInit, postToHost } from "../ipc/vscode-host";
import { detectAnalysisTypeFromNetlist } from "../netlist/generate";
import { publishCompilerNotes } from "../problems/compiler-notes";
import { publishRunEvents } from "../problems/run-events";
import { plotRunContainer } from "../results/container-plot";
import { useGraphStore, useIpcStore, useUiStore } from "../store";
import { useSimSettingsStore } from "../store/sim-settings";
import { useToastStore } from "../store/toast";
import { stepForDocument } from "./analysis-defaults";
import type { RunRequest, RunResult } from "./run-host";
import { cancelRun, requestRun } from "./run-host";
import { type RunOutputSource, reportRunLine, reportRunOutput } from "./run-output";

/**
 * Turn the sheet into netlist text, here, with the engine.
 *
 * #158. This used to be a field on the `simulate` payload: the editor posted
 * `model` and the kernel compiled it, through a Python reimplementation of
 * work `gsim-core` already did in Rust. The editor now holds the engine itself
 * (`../engine/engine.ts`), so the thing that goes over the wire is a netlist —
 * and the compile the editor performs is literally the compile `gsim_tools`
 * performs, rather than a second program that agrees with it until it does
 * not.
 *
 * Three consequences worth stating, because each was a reported failure:
 *
 *   - a document that does not compile says so **before** the host is
 *     involved, with the engine's own message (`floating-port`,
 *     `unknown-type`), instead of arriving as a `CompileError` from a process
 *     that may not even have the compiler installed (#147);
 *   - the compiler's notes — the DC references it adds for nodes nothing else
 *     ties down — are in hand at compile time rather than riding back on a
 *     result, so they are shown whether or not the solve succeeds;
 *   - the netlist is in the Output panel for every run, not only for an
 *     imported one.
 *
 * Returns `null` when the document does not compile, having already reported
 * why. The caller stops.
 */
async function netlistForRun(): Promise<string | null> {
  const model = useGraphStore.getState().document.model;
  const ipc = useIpcStore.getState();

  let engine: Awaited<ReturnType<typeof initEngine>>;
  try {
    engine = await initEngine();
  } catch (error) {
    // A webview whose CSP forbids WebAssembly, or a .vsix packaged without the
    // module. Named as its own failure because the fix is nothing to do with
    // the document or the solver.
    reportRunFailure(
      "The schematic compiler did not load",
      error instanceof Error ? error.message : String(error),
      "compile",
    );
    return null;
  }

  try {
    const { netlist, notes } = compileSchematic(engine, model);
    publishCompilerNotes(notes);
    ipc.appendOutput("── Netlist ────────────────────────────────────────");
    for (const line of netlist.split("\n")) {
      ipc.appendOutput(line);
    }
    ipc.appendOutput("");
    ipc.setLastNetlist(netlist);
    reportRunOutput([
      {
        source: "compile",
        severity: "info",
        text: `compiled ${netlist.split("\n").filter((line) => line.trim()).length} netlist lines`,
      },
      ...notes.map((text) => ({ source: "compile" as const, severity: "info" as const, text })),
    ]);
    return netlist;
  } catch (error) {
    // The engine's own message, which names the block and the port. Reported
    // as a compile failure rather than a solver one: nothing was solved.
    publishCompilerNotes([]);
    reportRunFailure(
      "The schematic did not compile",
      error instanceof Error ? error.message : String(error),
      "compile",
    );
    return null;
  }
}

/**
 * The document this webview is editing, for the result to name.
 *
 * The URI, not the model's display name: `run.source` in a `.gsim_sim_result`
 * is specified as the workspace-relative path of the `.gsim_sch` it came from,
 * and the host is the only side that knows where the workspace root is.
 */
function documentUri(): string | undefined {
  return getWebviewInit()?.documentUri;
}

function directNetlistFromMetadata(): string | null {
  const metadata = useGraphStore.getState().document.model.metadata as Record<string, unknown>;
  const netlist = metadata?.spice_netlist;
  return typeof netlist === "string" && netlist.trim().length > 0 ? netlist : null;
}

function hasValidationErrors(): boolean {
  const document = useGraphStore.getState().document;
  return document.model.wires.some((wire) => wire.from.block === wire.to.block);
}

/** True when the sheet holds at least one block for a netlist to describe. */
export function hasAnythingToSimulate(): boolean {
  const model = useGraphStore.getState().document.model;
  return (model.blocks?.length ?? 0) > 0;
}

/**
 * The analysis the editor is asking for, and whether this solver can run it.
 *
 * `general-simulator --mode` takes `dc` or `transient` and that is the whole
 * of its analysis surface: there is no AC sweep, no DC sweep over a source,
 * and `solver-run.ts` builds a transient command line. The editor's analysis
 * dropdown still offers AC, DC and OP, because the sidecar used to hand those
 * to ngspice or Xyce.
 *
 * So a non-transient analysis is refused here, by name, rather than being sent
 * as a transient run that would answer a question nobody asked. That is a
 * narrowing against the sidecar and it is #184.
 */
function transientOrRefuse(analysisType: string): { ok: true } | { ok: false; reason: string } {
  const normalised = analysisType.toUpperCase();
  if (normalised === "TRAN" || normalised === "TRANSIENT") {
    return { ok: true };
  }
  return {
    ok: false,
    reason:
      `This analysis is ${normalised}, and the general-simulator binary the editor runs ` +
      "takes --mode dc or --mode transient only — it has no AC sweep, no DC sweep over a " +
      "source, and no operating-point output. Set the analysis to transient, or run the " +
      "deck yourself with a solver that has one.",
  };
}

/**
 * Tell the user a run failed, somewhere they will actually see it.
 *
 * A failed simulation used to write "Backend error: …" to the Output panel and add a Problems
 * entry, and nothing else. Both of those live in the bottom panel, which starts hidden and is
 * not mounted in every shell at all — so a run that failed looked exactly like a run that
 * never started. Reported as: *"I click on the simulation button at the top and nothing is
 * happening"*, when the backend had in fact answered in a millisecond with a precise reason.
 *
 * The toast is the part that does not depend on a panel being mounted or open. The full text
 * still goes to Output and Problems, because a solver's answer is often many lines and a toast
 * is the wrong place to read them.
 */
function reportRunFailure(
  summary: string,
  details?: string,
  source: RunOutputSource = "solver",
): void {
  const full = details && details !== summary ? `${summary}: ${details}` : summary;
  useIpcStore.getState().appendOutput(`Backend error: ${full}`);
  // Into the VS Code Output panel too (#139), where it is visible without the
  // webview's own bottom panel being open -- which, by default, it is not.
  reportRunLine(source, "error", full);
  useIpcStore.getState().setProblems([{ id: "solver-1", severity: "error", message: full }]);
  useUiStore.getState().focusBottomTab("core.problems");
  // First line only: a SolverNotFound answer is a whole paragraph of build instructions,
  // and the toast's job is to say that the run failed and roughly why, not to carry all of it.
  const firstLine = full.split("\n")[0] ?? full;
  useToastStore
    .getState()
    .pushToast(
      `Simulation failed — ${firstLine}${firstLine.length < full.length ? " (see Problems)" : ""}`,
      8000,
    );
}

/**
 * Draw the container a finished run wrote (#157), where it can be seen.
 *
 * ## Which webview plots
 *
 * Inside VS Code the schematic webview hosts exactly one surface — the
 * schematic — and the viewer is a *separate* panel with its own store (see
 * `App.tsx`, which pins `surfaceId` for that reason). So a schematic webview
 * that read the container would fetch its bytes, reduce them and draw a chart
 * nobody can reach. It asks for the panel instead; the host broadcasts
 * `gsim/runResult` to every webview and replays it to a panel that opens
 * afterwards, so `vscode/waveform-main.tsx` is what reads the container there.
 *
 * Outside VS Code — the browser harness, the desktop shell — the waveform tab
 * is in this same shell, so this is the only thing that can plot and it does.
 *
 * A failure to read the container is reported and nothing else: the run itself
 * succeeded, the result is on disk and its path has already been printed, so
 * telling the user the simulation failed would be false.
 */
async function plotRunResult(result: Extract<RunResult, { ok: true }>): Promise<void> {
  const ipc = useIpcStore.getState();

  if (getWebviewInit()?.role === "schematic") {
    postToHost({ type: "gsim/showWaveforms" });
    ipc.appendOutput("Opening the waveform viewer…");
    return;
  }

  try {
    const report = await plotRunContainer(result);
    ipc.appendOutput(samplesReadLine(report));
    useIpcStore.getState().setActiveEditorTab("core.waveform");
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    ipc.appendOutput(`Could not read the result's samples: ${detail}`);
    reportRunLine("solver", "error", `could not read ${result.samplesPath}: ${detail}`);
    useToastStore
      .getState()
      .pushToast(`The run finished, but its samples could not be read — ${detail}`, 8000);
  }
}

/** What the read cost, which is the claim the container format is making. */
export function samplesReadLine(report: {
  signals: string[];
  points: number;
  bytesFetched: number;
  size: number;
}): string {
  const ratio = report.size > 0 ? (100 * report.bytesFetched) / report.size : 0;
  return (
    `Plotted ${report.signals.length} signals at ${report.points} points — ` +
    `${report.bytesFetched} of ${report.size} bytes read (${ratio.toFixed(1)}%)`
  );
}

/**
 * Send one request to the host and report whatever comes back.
 *
 * The only place a run's outcome is turned into words, so `triggerRun` and
 * `triggerRunAnalysis` cannot drift apart in what they tell the user — which
 * they had, one of them reporting a failed run as an empty plot.
 */
async function runOnHost(request: RunRequest): Promise<void> {
  const ipc = useIpcStore.getState();
  ipc.appendOutput("── Running the solver… ────────────────────────────");
  ipc.setSimProgress(0, "Starting simulation…");
  ipc.setRunStartedAt(Date.now());
  // The webview's own Output tab, which exists again (#170) and is the only
  // one a browser-hosted shell has.
  useUiStore.getState().focusBottomTab("core.output");

  const result: RunResult = await requestRun(request);
  useIpcStore.getState().setSimProgress(null);
  useIpcStore.getState().setRunStartedAt(null);

  if (!result.ok) {
    reportRunFailure(result.summary, result.detail);
    return;
  }

  // Findings before the verdict: a run can exit 0 having found a rating
  // exceeded, and `worstSeverity` — not the exit status — is what decides
  // which of the two sentences below the user gets.
  publishRunEvents(result.events, { total: result.eventsTotal });

  const store = useIpcStore.getState();
  for (const text of [
    `── Simulation complete (${result.signals.length} signals, ${result.rows} samples each) ──`,
    `Result: ${result.resultPath}`,
    `Samples: ${result.samplesPath} (${result.samplesBytes} bytes)`,
  ]) {
    store.appendOutput(text);
  }
  reportRunLine("solver", "info", `result written to ${result.resultPath}`);

  // The container, on screen (#157). A completed run used to stop here: the
  // samples were in a file the webview could not open, so the result said
  // where it was and nothing drew it.
  await plotRunResult(result);

  const bad = result.worstSeverity === "error" || result.worstSeverity === "fatal";
  const findings =
    result.eventsTotal === 0 ? "" : ` — ${result.eventsTotal} finding(s), see Problems`;
  useToastStore
    .getState()
    .pushToast(
      bad
        ? `Simulation finished with errors${findings}`
        : `Simulation finished: ${result.signals.length} signals, ${result.rows} samples${findings}`,
      bad ? 8000 : 5000,
    );
  if (bad) {
    useUiStore.getState().focusBottomTab("core.problems");
  }
}

/**
 * Trigger a simulation run using the default analysis (or fall back to v1
 * settings).
 */
export async function triggerRun(): Promise<void> {
  const importedNetlist = useIpcStore.getState().importedNetlist;

  // Checked before anything is started: there is no point spawning a solver to
  // simulate nothing, and "the schematic is empty" is a better answer than
  // whatever a solver says about a netlist with no components in it.
  if (!importedNetlist && !hasAnythingToSimulate()) {
    useToastStore
      .getState()
      .pushToast("Nothing to simulate — the schematic is empty. Add a component first.");
    reportRunLine("editor", "warning", "Nothing to simulate — the schematic is empty.");
    return;
  }

  if (!importedNetlist && hasValidationErrors()) {
    useUiStore.getState().focusBottomTab("core.problems");
    useIpcStore
      .getState()
      .setProblems([{ id: "validation-1", severity: "error", message: "Incompatible port types" }]);
    return;
  }

  const settings = useSimSettingsStore.getState().settings;
  const ipc = useIpcStore.getState();
  let netlist: string;
  let analysis: string;

  // Compiled before the solver is touched, and this ordering is the point of
  // #158. The compiler is in the editor now, so a document that cannot
  // compile is answered by the editor — instantly, with the engine's own
  // message — rather than by starting a process, sending the document to it
  // and waiting to be told that the process has no compiler installed (#147's
  // failure, and the longest route to the shortest answer).
  if (importedNetlist) {
    // File > Import SPICE netlist… — send the file verbatim.
    //
    // One thing changed here with #159 and it is worth being plain about: the
    // sidecar ran an imported deck through ngspice or Xyce, which honour the
    // deck's own .TRAN/.AC/.DC cards. `general-simulator` takes its analysis
    // from the command line, so those cards are *not* read and the editor's
    // t_end/t_step govern the run. A deck whose language this engine does not
    // speak is answered by the engine's own parse error.
    ipc.appendOutput("── SPICE Netlist ──────────────────────────────────");
    ipc.appendOutput(`(imported netlist, ${importedNetlist.split("\n").length} lines)`);
    for (const line of importedNetlist.split("\n")) {
      ipc.appendOutput(line);
    }
    ipc.appendOutput("");
    ipc.setLastNetlist(importedNetlist);
    netlist = importedNetlist;
    analysis = detectAnalysisTypeFromNetlist(importedNetlist);
  } else {
    // The ordinary case: compile here, with the engine, and send the netlist.
    // Not this file's own older `generateNetlist()` — a separate, ngspice-only
    // writer that predates the general-simulator catalogue and reports every
    // general-simulator block type as "UNSUPPORTED" — but `gsim-core` itself,
    // compiled to WebAssembly (#158).
    const compiled = await netlistForRun();
    if (compiled === null) {
      return;
    }
    netlist = compiled;
    analysis = settings.analysisType;
  }

  const supported = transientOrRefuse(analysis);
  if (!supported.ok) {
    reportRunFailure("This solver cannot run that analysis", supported.reason);
    return;
  }

  await runOnHost({
    mode: "transient",
    netlist,
    tEnd: settings.tEnd,
    tStep: settings.tStep,
    analysis: "TRAN",
    source: documentUri(),
  });
}

/**
 * Trigger a simulation run for a specific analysis id.
 * The Run dropdown in TopBar uses this.
 */
export async function triggerRunAnalysis(analysisId: string): Promise<void> {
  if (!useIpcStore.getState().importedNetlist && !hasAnythingToSimulate()) {
    useToastStore
      .getState()
      .pushToast("Nothing to simulate — the schematic is empty. Add a component first.");
    reportRunLine("editor", "warning", "Nothing to simulate — the schematic is empty.");
    return;
  }

  if (hasValidationErrors()) {
    useUiStore.getState().focusBottomTab("core.problems");
    useIpcStore
      .getState()
      .setProblems([{ id: "validation-1", severity: "error", message: "Incompatible port types" }]);
    return;
  }

  // Compiled before the solver, same as `triggerRun` and for the same reason.
  // `metadata.spice_netlist` still wins when it is there: a document carrying
  // one is an imported deck, and there is nothing for the engine to compile.
  const directNetlist = directNetlistFromMetadata();
  const netlist = directNetlist ?? (await netlistForRun());
  if (netlist === null) {
    return;
  }

  const analysis = namedAnalysis(analysisId);
  const supported = transientOrRefuse(analysis.type);
  if (!supported.ok) {
    reportRunFailure("This solver cannot run that analysis", supported.reason);
    return;
  }

  await runOnHost({
    mode: "transient",
    netlist,
    tEnd: analysis.tEnd,
    tStep: analysis.tStep,
    analysis: "TRAN",
    source: documentUri(),
  });
}

/**
 * The analysis to run, by id, falling back the way the payload builder did.
 *
 * Priority, unchanged: the named analysis, then the document's default (or its
 * first), then the legacy sim-settings store that a v1 document has instead of
 * a `simulation` block.
 */
function namedAnalysis(analysisId?: string): { type: string; tEnd: number; tStep: number } {
  const simulation = useGraphStore.getState().document.model.simulation;
  const analyses = simulation?.analyses ?? [];
  const settings = useSimSettingsStore.getState().settings;

  if (analyses.length > 0) {
    const targetId = analysisId ?? simulation?.default_analysis ?? analyses[0]?.id;
    const analysis = analyses.find((entry) => entry.id === targetId) ?? analyses[0];
    if (analysis) {
      return {
        type: String(analysis.type ?? "TRAN"),
        // A transient analysis carries both; anything else is refused before
        // these are read, so the fallbacks are for a malformed document rather
        // than for another analysis type.
        tEnd: typeof analysis.t_end === "number" ? analysis.t_end : settings.tEnd,
        tStep: typeof analysis.t_step === "number" ? analysis.t_step : settings.tStep,
      };
    }
  }
  // No `simulation` block: a v1 document, or a sheet drawn from nothing. The
  // store's step is 10 us, which samples a 100 kHz converter once per period
  // and plots a flat line -- so the sheet's own declared switching period
  // refines it when there is one (#193).
  return {
    type: settings.analysisType,
    tEnd: settings.tEnd,
    tStep: stepForDocument(useGraphStore.getState().document, settings.tStep),
  };
}

/**
 * Stop the run in flight.
 *
 * The host signals the solver process. This used to close the kernel socket,
 * which left the solver running as the sidecar's own child.
 */
export function triggerCancel(): void {
  cancelRun();
}

export const run = triggerRun;
export const cancel = triggerCancel;

/**
 * Shared extension-host state: the kernel sidecar, the live webview registry,
 * and the cross-webview drag broker.
 *
 * ## Why a broker at all
 *
 * In the standalone app the block library and the schematic canvas share one
 * DOM, so `canvas/dnd.ts` could keep the dragged block in a module variable.
 * Under VS Code they are two *isolated webview iframes* (a `WebviewView` in the
 * Activity Bar and a `WebviewPanel` owned by the custom editor).
 *
 * VS Code has no webview drop-MIME API — `dropMimeTypes`/`dragMimeTypes` exist
 * only on `TreeDragAndDropController` (tree views) and `DocumentDropEditProvider`
 * (text editors); `WebviewOptions` has no such field in any shipped version of
 * `@types/vscode` (checked against 1.136). What *does* work is that Chromium
 * still routes the native drag's `dragover`/`drop` events to whichever iframe
 * the cursor is over — but `dataTransfer.getData()` for a custom MIME type is
 * not readable across that origin boundary.
 *
 * So the drag is split: the **native drag carries the pointer**, and the
 * **extension host carries the payload**. The library webview posts
 * `gsim/dragStart` on `dragstart`; the host broadcasts `gsim/dragState` to
 * every other webview; the schematic webview's drop handler falls back to that
 * value when `getData()` comes back empty (see `resolveDroppedBlock`).
 */
import { type ChildProcess, spawn as spawnChild } from "node:child_process";
import * as os from "node:os";
import path from "node:path";

import * as vscode from "vscode";

import { KernelSidecar } from "./kernel";
import { buildKernelEnvironment } from "./kernel-environment";
import {
  type HostBoundMessage,
  type RunRequest,
  type RunResult,
  type SamplesReadRequest,
  type SamplesReadResult,
  type WebviewBoundMessage,
  type WebviewRole,
  isHostBoundMessage,
} from "./protocol";
import { type LevelledChannel, createRunOutputChannel, writeRunOutput } from "./run-output";
import { runSimulation } from "./run-simulation";
import { SamplesReadError, readSamplesRanges } from "./samples-read";
import { resolveSolver } from "./solver-path";
import {
  SYMBOLS_DIR,
  SymbolLibraryError,
  loadSymbols,
  saveSymbol,
  symbolWorkspace,
} from "./symbolLibrary";

interface RegisteredWebview {
  role: WebviewRole;
  webview: vscode.Webview;
}

/** Beside `.gsim/symbols/`, so a workspace has one directory to know about. */
export const RUNS_DIR = ".gsim/runs";

/**
 * A run's identity, and its directory's name.
 *
 * The timestamp, with the characters a file name cannot carry replaced: it
 * sorts, it says when, and it is the `run.id` of the result document, which
 * the schema describes as what "ties a result back to a log line".
 */
export function runIdFor(when: Date): string {
  return `run-${when.toISOString().replaceAll(":", "-").replace(".", "-")}`;
}

/**
 * The document a run came from, as the result schema wants it: "workspace-relative
 * path of the .gsim_sch this came from".
 *
 * The webview sends a URI, because that is what it has, and only this side
 * knows where the workspace root is. An unparseable value is dropped rather
 * than written through: `source` is optional, and a result naming garbage is
 * worse than one naming nothing.
 */
export function relativeSource(uri: string | undefined): string | undefined {
  if (!uri) {
    return undefined;
  }
  try {
    return vscode.workspace.asRelativePath(vscode.Uri.parse(uri, true), false);
  } catch {
    return undefined;
  }
}

export class GsimHost implements vscode.Disposable {
  readonly kernel: KernelSidecar;
  private readonly webviews = new Set<RegisteredWebview>();
  private readonly disposables: vscode.Disposable[] = [];

  /** sim id of the most recent finished simulation, for the waveform panel. */
  lastSimId: string | null = null;

  /**
   * The last run that produced a result, kept so a waveform panel opened
   * *after* it can still plot it (#157).
   *
   * A run happens in the schematic webview; the viewer is a different webview
   * and may not exist yet when the result lands. `gsim/runResult` is
   * broadcast to every webview, so a panel that is already open plots
   * immediately — and one that opens a second later gets this on its
   * `gsim/ready`, the same way `lastSimId` is replayed just below.
   */
  lastRunResult: { requestId: string; result: RunResult } | null = null;

  /**
   * Solver processes in flight, by the request id the webview is waiting on.
   *
   * Held so Stop can signal one. Not a queue: two Run clicks start two
   * solvers, each in its own directory, and the second is not a reason to
   * refuse or to cancel the first.
   */
  private readonly runningChildren = new Map<string, ChildProcess>();

  private readonly onShowWaveformsEmitter = new vscode.EventEmitter<void>();
  readonly onShowWaveforms = this.onShowWaveformsEmitter.event;

  /** Roles whose webview has reported `gsim/ready` (i.e. React actually mounted). */
  readonly readyRoles = new Set<WebviewRole>();

  private readonly onDidWebviewReadyEmitter = new vscode.EventEmitter<WebviewRole>();
  readonly onDidWebviewReady = this.onDidWebviewReadyEmitter.event;

  /** Every inbound webview message, for the integration harness to observe. */
  private readonly onDidReceiveEmitter = new vscode.EventEmitter<{
    role: WebviewRole;
    message: HostBoundMessage;
  }>();
  readonly onDidReceive = this.onDidReceiveEmitter.event;

  constructor(
    readonly log: vscode.OutputChannel,
    /**
     * Where a run's own output goes (#139). Injected rather than created here
     * so a test can hand in a recording channel: VS Code offers no way to read
     * a real one back.
     */
    readonly runOutput: LevelledChannel = createRunOutputChannel(vscode.window),
  ) {
    this.kernel = new KernelSidecar(log);
    this.disposables.push(
      this.kernel,
      this.onShowWaveformsEmitter,
      this.onDidWebviewReadyEmitter,
      this.onDidReceiveEmitter,
      this.kernel.onDidChange((config) => {
        this.broadcast(
          config
            ? { type: "gsim/kernelConfig", kernel: config }
            : // `reason` is what makes a failed Run click explainable rather
              // than merely failed (#130).
              { type: "gsim/kernelStopped", reason: this.kernel.lastFailure ?? undefined },
        );
      }),
    );
  }

  register(role: WebviewRole, webview: vscode.Webview): vscode.Disposable {
    const entry: RegisteredWebview = { role, webview };
    this.webviews.add(entry);
    return new vscode.Disposable(() => {
      this.webviews.delete(entry);
      this.readyRoles.delete(role);
    });
  }

  /** First live webview for a role, if any. */
  webviewFor(role: WebviewRole): vscode.Webview | null {
    for (const entry of this.webviews) {
      if (entry.role === role) {
        return entry.webview;
      }
    }
    return null;
  }

  broadcast(
    message: WebviewBoundMessage,
    options: { exclude?: vscode.Webview; role?: WebviewRole } = {},
  ): void {
    for (const entry of this.webviews) {
      if (options.exclude && entry.webview === options.exclude) continue;
      if (options.role && entry.role !== options.role) continue;
      void entry.webview.postMessage(message);
    }
  }

  /**
   * Handles the messages that are the same for every surface. Returns true if
   * the message was consumed, so callers can fall through to their own
   * surface-specific handling (document lifecycle, etc.).
   */
  /**
   * Write an authored component to the workspace and tell every webview.
   *
   * The catalog merge in the authoring webview is optimistic — the component
   * appears in the library immediately — so this reports only the outcome,
   * and a failure has to be visible or the user believes a component is saved
   * that is not.
   */
  /**
   * Hand the webview a scripted block's source, so it can show what ports
   * the code looks like it expects.
   *
   * Confined to the workspace folder on purpose. The path comes from a
   * block parameter, which is to say from a document that may have been
   * opened from anywhere, so an unchecked read is an invitation to walk
   * out of the project with `../../..`. Resolution is done by the host
   * rather than trusted from the message.
   */
  private async readSource(requestId: string, requested: string): Promise<void> {
    const reply = (payload: { text?: string; error?: string }) =>
      this.broadcast({ type: "gsim/sourceContent", requestId, ...payload });

    const workspace = symbolWorkspace();
    if (!workspace) {
      reply({ error: "No workspace folder is open, so there is nothing to read from." });
      return;
    }

    const target = vscode.Uri.joinPath(workspace, requested);
    const root = workspace.fsPath.endsWith(path.sep)
      ? workspace.fsPath
      : `${workspace.fsPath}${path.sep}`;
    if (!target.fsPath.startsWith(root)) {
      this.log.appendLine(`[source] refused to read outside the workspace: ${requested}`);
      reply({ error: "That path is outside the workspace folder." });
      return;
    }

    try {
      const bytes = await vscode.workspace.fs.readFile(target);
      reply({ text: new TextDecoder().decode(bytes) });
    } catch (error) {
      reply({ error: `Could not read ${requested}: ${String(error)}` });
    }
  }

  private async persistSymbol(name: string, metadata: unknown): Promise<void> {
    const workspace = symbolWorkspace();
    if (!workspace) {
      const reason =
        "no workspace folder is open, so there is nowhere to save it. " +
        "Open the folder your design lives in and save again.";
      this.log.appendLine(`[symbols] refused to save ${name}: ${reason}`);
      this.broadcast({ type: "gsim/symbolSaveFailed", name, reason });
      void vscode.window.showErrorMessage(`Could not save component "${name}": ${reason}`);
      return;
    }

    try {
      const file = await saveSymbol(workspace, name, metadata);
      this.log.appendLine(`[symbols] saved ${name} -> ${file.fsPath}`);
      this.broadcast({ type: "gsim/symbolSaved", name, path: file.fsPath });
      await this.publishSymbols();
    } catch (error) {
      const reason =
        error instanceof SymbolLibraryError || error instanceof Error
          ? error.message
          : String(error);
      this.log.appendLine(`[symbols] failed to save ${name}: ${reason}`);
      this.broadcast({ type: "gsim/symbolSaveFailed", name, reason });
      void vscode.window.showErrorMessage(`Could not save component "${name}": ${reason}`);
    }
  }

  /**
   * Hand the webview byte ranges of a sample container (#157).
   *
   * The whole of the host's half of plotting a completed run. The webview's
   * WebAssembly worked out which bytes a window needs — from the stripe
   * directory, with no sample value taking part — and this reads them. It does
   * no arithmetic of its own, deliberately: the layout is known in one place
   * and that place is `crates/waveform-store`, which is the same reason
   * `samples-read.ts` exists as a plain positioned read.
   *
   * Confined to this window's workspace folders, the fallback run directory
   * and the directory of the result that named the container. A path arrives
   * from a document and a document may have been opened from anywhere, so the
   * host adjudicates it rather than trusting it — the same rule `readSource`
   * follows above, for the same reason.
   */
  private readSamples(requestId: string, request: SamplesReadRequest): void {
    const reply = (result: SamplesReadResult) =>
      this.broadcast({ type: "gsim/samplesBytes", requestId, result });

    const roots = [
      ...(vscode.workspace.workspaceFolders ?? []).map((folder) => folder.uri.fsPath),
      // Where `runDirectory` puts a run when no folder is open. Such a run is
      // a scratch experiment and still has to be plottable.
      path.join(os.tmpdir(), "omni-schematics-runs"),
    ];

    try {
      const { size, chunks } = readSamplesRanges(request, { roots });
      reply({
        ok: true,
        size,
        chunks: chunks.map((chunk) => ({
          offset: chunk.offset,
          base64: chunk.bytes.toString("base64"),
        })),
      });
    } catch (error) {
      const summary =
        error instanceof SamplesReadError || error instanceof Error ? error.message : String(error);
      this.log.appendLine(`[samples] refused ${request.path}: ${summary}`);
      reply({ ok: false, summary });
    }
  }

  /**
   * Where a run's four files go: `.gsim/runs/<run id>/` in the open folder.
   *
   * Beside `.gsim/symbols/`, which is already this extension's corner of a
   * workspace, so one directory is all a user has to know about or gitignore.
   * A window with no folder open falls back to the system temp directory —
   * such a run is a scratch experiment by definition, and refusing to run
   * because nothing is saved anywhere would be a worse answer than a result
   * in `/tmp` whose path is printed.
   */
  runDirectory(runId: string): string {
    const workspace = symbolWorkspace();
    return workspace
      ? path.join(workspace.fsPath, RUNS_DIR, runId)
      : path.join(os.tmpdir(), "omni-schematics-runs", runId);
  }

  /**
   * Run a netlist the webview compiled, and answer where the result landed.
   *
   * The whole of #159 arrives here. Everything this calls was already in this
   * directory, tested and wired to nothing: the only new decisions are which
   * directory a run owns, what the child process is told about its
   * environment, and that the reply always goes back on the channel the
   * webview is waiting on.
   */
  private async runSimulationRequest(requestId: string, request: RunRequest): Promise<void> {
    const runId = runIdFor(new Date());
    const directory = this.runDirectory(runId);
    const settings = vscode.workspace.getConfiguration("omniSchematics");
    const workspaceRoot = symbolWorkspace()?.fsPath;
    // 0 means wait indefinitely, which is a usable answer now that Stop
    // signals the child: before #159 a cancel only closed the kernel socket
    // and left the solver running, so the editor needed a deadline of its own.
    const timeoutSeconds = settings.get<number>("solverTimeoutSeconds", 600);

    const emit = (lines: Parameters<typeof writeRunOutput>[1]) =>
      writeRunOutput(this.runOutput, lines);

    emit([{ source: "solver", severity: "info", text: `── run ${runId} ──` }]);

    let result: RunResult;
    try {
      result = await runSimulation(
        { ...request, source: relativeSource(request.source) },
        {
          runDirectory: directory,
          resolve: () =>
            resolveSolver({
              configured: settings.get<string>("generalSimulatorPath"),
              workspaceRoot,
            }),
          // The settings' environment, the same one the kernel's children got:
          // `octaveCliPath` is a directory on PATH because `octave-ffi` looks
          // there and nowhere else, `pythonPath` reaches `pyblock`, and
          // `environment` is the escape hatch. The solver used to inherit this
          // from the sidecar that spawned it; it inherits it from here now.
          spawn: (binary, args) =>
            spawnChild(binary, args, {
              cwd: directory,
              env: buildKernelEnvironment({
                base: process.env,
                settings: {
                  generalSimulatorPath: settings.get<string>("generalSimulatorPath"),
                  octaveCliPath: settings.get<string>("octaveCliPath"),
                  pythonPath: settings.get<string[]>("pythonPath"),
                  environment: settings.get<Record<string, string>>("environment"),
                },
                workspaceRoot,
              }),
              stdio: ["ignore", "pipe", "pipe"],
            }),
          onChild: (child) => this.runningChildren.set(requestId, child),
          onOutput: emit,
          timeoutMs: timeoutSeconds > 0 ? timeoutSeconds * 1000 : undefined,
        },
      );
    } catch (error) {
      // Nothing in `runSimulation` rejects by design, so this is a bug rather
      // than an outcome -- and a bug must still answer, or the Run button
      // spins forever.
      const detail = error instanceof Error ? error.message : String(error);
      this.log.appendLine(`[run] ${requestId} threw: ${detail}`);
      emit([
        { source: "solver", severity: "error", text: `the run failed unexpectedly: ${detail}` },
      ]);
      result = {
        ok: false,
        kind: "could-not-start",
        summary: "The run failed unexpectedly",
        detail,
      };
    } finally {
      this.runningChildren.delete(requestId);
    }

    if (result.ok) {
      this.lastRunResult = { requestId, result };
    }

    if (!result.ok) {
      // The panel, revealed. A `solver-not-found` is five lines naming where
      // it looked and the command that builds a binary; written to a channel
      // that is closed by default it would be invisible, which is the shape of
      // #130 and #170 both.
      this.runOutput.show?.(true);
    }
    this.broadcast({ type: "gsim/runResult", requestId, result });
  }

  /**
   * Signal the child of a run in flight.
   *
   * `SIGTERM`, not `SIGKILL`, for the reason `solver-run.ts` gives: the
   * container's footer is written last, so a politely stopped run leaves a
   * file whose trailing magic is missing, which `samples-index.ts` reports as
   * truncated rather than as rubbish.
   */
  private cancelRun(requestId: string): void {
    const child = this.runningChildren.get(requestId);
    if (!child) {
      this.log.appendLine(`[run] nothing to cancel for ${requestId}`);
      return;
    }
    this.log.appendLine(`[run] stopping ${requestId}`);
    writeRunOutput(this.runOutput, [
      { source: "solver", severity: "warning", text: "stopped at the user's request" },
    ]);
    child.kill("SIGTERM");
  }

  /** Read the workspace's components and push them to every webview. */
  async publishSymbols(): Promise<void> {
    const symbols = await this.readSymbols();
    this.broadcast({ type: "gsim/userSymbols", metadata: symbols });
  }

  /**
   * Components currently on disk. Also used to seed a webview's init payload,
   * so the library has them before React mounts instead of popping in after.
   */
  async readSymbols(): Promise<unknown[]> {
    const workspace = symbolWorkspace();
    if (!workspace) {
      return [];
    }
    const { metadata, failures } = await loadSymbols(workspace);
    for (const failure of failures) {
      // Reported, never silently skipped: a component that vanishes with no
      // explanation is worse than one that is visibly broken.
      this.log.appendLine(`[symbols] ignoring ${SYMBOLS_DIR}/${failure.file}: ${failure.reason}`);
    }
    if (failures.length > 0) {
      void vscode.window.showWarningMessage(
        `${failures.length} component file(s) in ${SYMBOLS_DIR} could not be read. ` +
          "See General Simulator: Show Kernel Log.",
      );
    }
    return metadata;
  }

  handleCommonMessage(source: vscode.Webview, raw: unknown): boolean {
    if (!isHostBoundMessage(raw)) {
      return false;
    }
    const message = raw as HostBoundMessage;

    const sourceRole = this.roleOf(source);
    if (sourceRole) {
      this.onDidReceiveEmitter.fire({ role: sourceRole, message });
    }

    switch (message.type) {
      case "gsim/restartKernel":
        void this.kernel.restart();
        return true;

      // --- user-authored components --------------------------------------
      case "gsim/saveSymbol":
        void this.persistSymbol(message.name, message.metadata);
        return true;

      case "gsim/readSource":
        void this.readSource(message.requestId, message.path);
        return true;

      case "gsim/readSamples":
        this.readSamples(message.requestId, message.request);
        return true;

      // --- in-app File buttons -> the workbench's own commands -----------
      // The webview's toolbar defers here instead of driving its own storage
      // adapter, because inside a Custom Editor VS Code owns the document
      // lifecycle. Dirty state is already live (every graph mutation posts
      // gsim/documentChanged, which fires onDidChangeCustomDocument), so
      // "Save" only has to trigger the same save the tab's own affordance
      // would. These target the *active* editor: the click that produced the
      // message necessarily came from the focused webview, and only the
      // schematic surface renders the File toolbar at all.
      case "gsim/newSchematic":
        void vscode.commands.executeCommand("omniSchematics.newSchematic");
        return true;
      case "gsim/openSchematic":
        void vscode.commands.executeCommand("omniSchematics.openSchematic");
        return true;
      case "gsim/saveDocument":
        void vscode.commands.executeCommand(
          message.as ? "workbench.action.files.saveAs" : "workbench.action.files.save",
        );
        return true;
      case "gsim/closeDocument":
        void vscode.commands.executeCommand("workbench.action.closeActiveEditor");
        return true;

      // --- cross-webview drag bridge -------------------------------------
      case "gsim/dragStart":
        this.broadcast(
          { type: "gsim/dragState", blockName: message.blockName, label: message.label },
          { exclude: source },
        );
        return true;
      case "gsim/dragEnd":
        this.broadcast({ type: "gsim/dragState", blockName: null }, { exclude: source });
        return true;

      // --- click-to-insert from the library sidebar ----------------------
      case "gsim/insertBlock":
        this.broadcast(
          { type: "gsim/insertBlock", blockName: message.blockName },
          { exclude: source, role: "schematic" },
        );
        return true;

      // --- running a simulation (#159) -----------------------------------
      // The webview compiled the netlist; this runs the solver on it. The
      // reply is broadcast rather than sent to `source`, for the same reason
      // every other answer here is: a Run started from the schematic should
      // still land if that webview was replaced while the solver was running.
      case "gsim/runSimulation":
        void this.runSimulationRequest(message.requestId, message.request);
        return true;
      case "gsim/cancelRun":
        this.cancelRun(message.requestId);
        return true;

      case "gsim/simulationFinished":
        this.lastSimId = message.simId;
        this.broadcast({ type: "gsim/showSimulation", simId: message.simId }, { role: "waveform" });
        return true;

      case "gsim/showWaveforms":
        this.onShowWaveformsEmitter.fire();
        return true;

      case "gsim/log":
        this.log.appendLine(`[webview:${message.level}] ${message.message}`);
        return true;

      // #146. Also written to the log, because that is where someone debugging
      // looks -- but the notification is the point. The previous behaviour routed
      // this through `gsim/log` alone, so a schematic that failed to load left no
      // trace the user would ever see, and the editor's own "the schematic is
      // empty, add a component first" toast actively misled them: adding a block
      // and saving would have replaced their file with the empty one.
      case "gsim/documentUnreadable":
        this.log.appendLine(`[webview:error] document unreadable: ${message.reason}`);
        void vscode.window
          .showErrorMessage(
            "This schematic could not be read, so the editor is showing an empty canvas. " +
              `Your file has not been changed. ${message.reason}`,
            "Show Log",
          )
          .then((choice) => {
            if (choice === "Show Log") {
              this.log.show(true);
            }
          });
        return true;

      // #139. A separate channel from `this.log`: that one is the kernel
      // process's own diary -- what was spawned, its stderr, the handshake --
      // and a run's output is what the user asked for. Mixing a solver's
      // results into a lifecycle log makes both harder to read.
      case "gsim/output":
        writeRunOutput(this.runOutput, message.lines);
        return true;

      case "gsim/ready":
        this.readyRoles.add(message.role);
        this.onDidWebviewReadyEmitter.fire(message.role);
        // Late-arriving webviews need the current kernel config immediately.
        if (this.kernel.current) {
          void source.postMessage({ type: "gsim/kernelConfig", kernel: this.kernel.current });
        }
        if (message.role === "waveform" && this.lastSimId) {
          void source.postMessage({ type: "gsim/showSimulation", simId: this.lastSimId });
        }
        // A viewer opened after a run still has a run to show (#157). The
        // result names the container it wrote, and the container is
        // self-describing, so this is the whole of what the panel needs.
        if (message.role === "waveform" && this.lastRunResult) {
          void source.postMessage({ type: "gsim/runResult", ...this.lastRunResult });
        }
        return true;

      // Replies to integration probes are consumed by whoever awaits them via
      // onDidReceive; nothing in the product reacts to them.
      case "gsim/test/report":
        return true;

      default:
        return false;
    }
  }

  private roleOf(webview: vscode.Webview): WebviewRole | null {
    for (const entry of this.webviews) {
      if (entry.webview === webview) {
        return entry.role;
      }
    }
    return null;
  }

  dispose(): void {
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
    this.webviews.clear();
  }
}

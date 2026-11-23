/**
 * Kernel-sidecar process lifecycle, owned by the extension host.
 *
 * This is the Node-side replacement for what
 * `apps/desktop/src-tauri/src/main.rs` does in Rust: the host spawns the
 * sidecar, learns its port + token from the `KERNEL_READY` handshake on
 * stdout, hands that to every webview, and tears the child down on shutdown.
 */
import { type ChildProcess, spawn } from "node:child_process";
import * as path from "node:path";
import * as readline from "node:readline";
import * as vscode from "vscode";

import { buildKernelEnvironment } from "./kernel-environment";

import {
  KERNEL_PROTOCOL_VERSION,
  type KernelConfig,
  type SpawnPlan,
  buildPreparedSpawnPlan,
  buildSpawnPlan,
  generateToken,
  isProtocolCompatible,
  kernelConfigFromEnv,
  parseKernelReady,
  resolveKernelPython,
  resolveWorkspaceRoot,
} from "./kernel-core";

export type { KernelConfig };

/** Grace period before SIGKILL when shutting the sidecar down. */
const SHUTDOWN_GRACE_MS = 2_000;

export class KernelSidecar implements vscode.Disposable {
  private child: ChildProcess | null = null;
  private config: KernelConfig | null = null;
  private starting: Promise<KernelConfig | null> | null = null;
  private failure: string | null = null;

  private readonly onDidChangeEmitter = new vscode.EventEmitter<KernelConfig | null>();
  /** Fires with the new config on (re)start, and with `null` when the sidecar stops. */
  readonly onDidChange = this.onDidChangeEmitter.event;

  constructor(private readonly log: vscode.OutputChannel) {}

  get current(): KernelConfig | null {
    return this.config;
  }

  /**
   * Why the last start attempt failed, or null if none has.
   *
   * #130: the three ways a start can fail used to be recorded only in the
   * output channel, which is closed by default. The webview needs the reason
   * too, so `gsim/kernelStopped` can carry it and the Run click can say what
   * is wrong instead of just that something is.
   */
  get lastFailure(): string | null {
    return this.failure;
  }

  /**
   * The single exit for a start attempt that cannot produce a config.
   *
   * Every `return null` in `doStart()` goes through here, because the webview
   * learns the kernel's fate from `onDidChange` and nowhere else: a path that
   * returns without firing leaves the webview's wait pending forever, and the
   * Run button silently does nothing. That was #130.
   */
  private failStart(reason: string): null {
    this.failure = reason;
    this.log.appendLine(`[kernel] ${reason}`);
    this.config = null;
    this.onDidChangeEmitter.fire(null);
    // The output channel is closed by default, so the diagnosis has to reach
    // somewhere the user is actually looking.
    void vscode.window.showErrorMessage(`Simulation kernel did not start. ${reason}`);
    return null;
  }

  /** Idempotent: concurrent callers share one in-flight start. */
  async start(): Promise<KernelConfig | null> {
    if (this.config) {
      return this.config;
    }
    if (this.starting) {
      return this.starting;
    }
    this.starting = this.doStart().finally(() => {
      this.starting = null;
    });
    return this.starting;
  }

  async restart(): Promise<KernelConfig | null> {
    this.log.appendLine("[kernel] restart requested");
    await this.stop();
    return this.start();
  }

  async stop(): Promise<void> {
    const child = this.child;
    this.child = null;
    this.config = null;
    this.onDidChangeEmitter.fire(null);
    if (!child || child.exitCode !== null || child.killed) {
      return;
    }
    await new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(() => {
        this.log.appendLine("[kernel] SIGTERM timed out — sending SIGKILL");
        try {
          child.kill("SIGKILL");
        } catch {
          /* already gone */
        }
        resolve();
      }, SHUTDOWN_GRACE_MS);
      child.once("exit", done);
      try {
        child.kill("SIGTERM");
      } catch {
        done();
      }
    });
    this.log.appendLine("[kernel] stopped");
  }

  private async doStart(): Promise<KernelConfig | null> {
    // Manual override (CI / dev-without-auto-spawn), same contract as Tauri.
    const fromEnv = kernelConfigFromEnv();
    if (fromEnv) {
      this.log.appendLine(`[kernel] using GENSIM_KERNEL_* override on port ${fromEnv.port}`);
      this.failure = null;
      this.config = fromEnv;
      this.onDidChangeEmitter.fire(fromEnv);
      return fromEnv;
    }

    const settings = vscode.workspace.getConfiguration("omniSchematics");
    const configuredRoot = (settings.get<string>("workspaceRoot") ?? "").trim();
    const runner = (settings.get<string>("pythonRunner") ?? "uv").trim() || "uv";

    // #134: a prepared environment, named rather than built. This comes first
    // because when it is set there is nothing to discover -- the interpreter
    // already has `kernel_sidecar` and its dependencies in it, so `uv`, the
    // checkout and `workspaceRoot` are all irrelevant.
    //
    // Worth stating why this is the better shape rather than a shortcut: `uv
    // sync` never produced a kernel that could simulate. `gsim-tools` is in a
    // private sibling repo and `gsim_py` is a maturin build, so both are
    // hand-installed afterwards -- and a sync prunes them again. The
    // environment was always the user's to assemble; this stops pretending
    // otherwise.
    const configuredPython = (settings.get<string>("kernelPython") ?? "").trim();
    if (configuredPython) {
      const interpreter = resolveKernelPython(configuredPython);
      if (!interpreter) {
        return this.failStart(
          `omniSchematics.kernelPython is set to "${configuredPython}", but there is no ` +
            "interpreter there. Give either a virtualenv directory or a path to a Python " +
            "executable.",
        );
      }
      const workdir =
        vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? path.dirname(interpreter);
      return this.launch(buildPreparedSpawnPlan(interpreter, generateToken(), workdir), settings, {
        workspaceRoot: workdir,
      });
    }

    const candidates = configuredRoot
      ? [configuredRoot]
      : (vscode.workspace.workspaceFolders ?? []).map((folder) => folder.uri.fsPath);

    const workspaceRoot = resolveWorkspaceRoot(candidates);
    if (!workspaceRoot) {
      // The message used to say "general-simulator checkout", which sends the
      // reader to the wrong repository: `general-simulator` is a pure Rust
      // workspace with no pyproject.toml in it. The directory wanted here is a
      // checkout of *this* repo, which is where the Python `kernel_sidecar`
      // package lives. Reported by a user who had correctly set
      // `generalSimulatorPath` and could not see why Run still did nothing.
      const where = configuredRoot
        ? `omniSchematics.workspaceRoot is set to "${configuredRoot}", which has no pyproject.toml in it or above it.`
        : "No folder is open that contains a pyproject.toml.";
      return this.failStart(
        `${where} That file marks a checkout of omni-schematics itself, which is where the ` +
          "kernel_sidecar Python package lives — not the general-simulator repository. " +
          "Set omniSchematics.workspaceRoot to an omni-schematics checkout (and run `uv sync` in it).",
      );
    }

    return this.launch(buildSpawnPlan(workspaceRoot, generateToken(), runner), settings, {
      workspaceRoot,
    });
  }

  /**
   * Spawn a plan and wait for its handshake.
   *
   * Shared by both ways of getting a kernel: the `uv` workspace a developer
   * works in, and the prepared environment a user names (#134). Everything
   * from here down is identical between them -- which is the argument for the
   * split being a spawn-plan decision and nothing more.
   */
  private async launch(
    plan: SpawnPlan,
    settings: { get<T>(key: string): T | undefined },
    context: { workspaceRoot: string },
  ): Promise<KernelConfig | null> {
    const workspaceRoot = context.workspaceRoot;
    const kernelEnv = buildKernelEnvironment({
      base: process.env,
      workspaceRoot,
      settings: {
        generalSimulatorPath: settings.get<string>("generalSimulatorPath"),
        octaveCliPath: settings.get<string>("octaveCliPath"),
        pythonPath: settings.get<string[]>("pythonPath"),
        environment: settings.get<Record<string, string>>("environment"),
      },
    });

    this.log.appendLine(`[kernel] spawning: ${plan.command} ${plan.args.join(" ")}`);
    // Names only. A value can be an absolute path a user would rather not have
    // in a log they paste into an issue.
    const configured = Object.keys(kernelEnv).filter(
      (key) => key.startsWith("GENSIM_") || key === "PYTHONPATH",
    );
    if (configured.length > 0) {
      this.log.appendLine(`[kernel] environment from settings: ${configured.sort().join(", ")}`);
    }

    let child: ChildProcess;
    try {
      child = spawn(plan.command, plan.args, {
        cwd: plan.cwd,
        stdio: ["ignore", "pipe", "pipe"],
        // Previously omitted, so the kernel inherited whatever the editor
        // happened to have and no setting could reach the solver it starts.
        env: kernelEnv,
      });
    } catch (error) {
      return this.failStart(
        `Could not launch "${plan.command}": ${String(error)}. ` +
          "Install it, or set omniSchematics.pythonRunner to a runner that is on PATH.",
      );
    }
    this.child = child;

    child.stderr?.on("data", (chunk: Buffer) => {
      this.log.append(`[kernel:stderr] ${chunk.toString()}`);
    });
    // `spawn` does not throw for a missing executable -- it emits `error`
    // asynchronously, so the try/catch above cannot see it. Without this, a
    // machine with no `uv` took a path that logged and then waited for a
    // KERNEL_READY that could never come (#130).
    let spawnError: Error | null = null;
    // Read through an accessor: TypeScript's control-flow analysis does not
    // follow the assignment inside the callback below, so a direct read of
    // `spawnError` narrows to `null` and the branch that uses it becomes
    // unreachable in the type system.
    const lastSpawnError = (): Error | null => spawnError;
    child.on("error", (error) => {
      spawnError = error;
      this.log.appendLine(`[kernel] process error: ${error.message}`);
    });
    child.on("exit", (code, signal) => {
      this.log.appendLine(`[kernel] exited (code=${code} signal=${signal})`);
      if (this.child === child) {
        this.child = null;
        this.config = null;
        this.onDidChangeEmitter.fire(null);
      }
    });

    const ready = await this.awaitReady(child);
    if (!ready) {
      const failed = lastSpawnError();
      return this.failStart(
        failed
          ? `Could not launch "${plan.command}": ${failed.message}. ` +
              "Install it, or set omniSchematics.pythonRunner to a runner that is on PATH."
          : "The kernel started but never signalled KERNEL_READY. " +
              `Check the General Simulator output channel, and that \`uv sync\` has been run in ${workspaceRoot}.`,
      );
    }
    // #134: a prepared environment is version-independent of the editor, so a
    // venv built for one release can be pointed at a later one. That is a new
    // failure mode created by the feature, and an incompatible sidecar fails in
    // ways that look like bugs in the editor -- so refuse it here, naming both
    // numbers, rather than letting it half-work.
    if (!isProtocolCompatible(ready.protocol)) {
      this.discardChild(child);
      const reported =
        ready.protocol === undefined
          ? "reports no protocol version, so it predates this check"
          : `speaks protocol ${ready.protocol}`;
      return this.failStart(
        `The kernel at "${plan.command}" ${reported}, and this editor speaks ` +
          `protocol ${KERNEL_PROTOCOL_VERSION}. Reinstall the kernel packages into that ` +
          "environment to match this version of the extension.",
      );
    }

    this.log.appendLine(`[kernel] ready on port ${ready.port}`);
    this.failure = null;
    this.config = ready;
    this.onDidChangeEmitter.fire(ready);
    return ready;
  }

  /**
   * Abandon a child we are not going to use.
   *
   * `this.child` is cleared *before* the kill, so the `exit` handler's
   * `this.child === child` guard is false and it does not fire
   * `onDidChange(null)` -- `failStart()` is about to fire exactly one event and
   * two would be a lie about what happened.
   */
  private discardChild(child: ChildProcess): void {
    if (this.child === child) {
      this.child = null;
    }
    try {
      child.kill("SIGTERM");
    } catch {
      // Already gone; nothing to do.
    }
  }

  /** Resolves on the KERNEL_READY handshake line, or null if the child dies first. */
  private awaitReady(child: ChildProcess): Promise<KernelConfig | null> {
    return new Promise((resolve) => {
      if (!child.stdout) {
        resolve(null);
        return;
      }
      const rl = readline.createInterface({ input: child.stdout });
      let settled = false;
      const finish = (value: KernelConfig | null) => {
        if (settled) return;
        settled = true;
        rl.close();
        resolve(value);
      };
      rl.on("line", (line) => {
        const parsed = parseKernelReady(line);
        if (parsed) {
          finish(parsed);
        } else if (line.trim()) {
          this.log.appendLine(`[kernel:stdout] ${line}`);
        }
      });
      child.once("exit", () => finish(null));
      child.once("error", () => finish(null));
    });
  }

  dispose(): void {
    void this.stop();
    this.onDidChangeEmitter.dispose();
  }
}

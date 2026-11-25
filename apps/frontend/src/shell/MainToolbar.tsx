import { useEffect, useRef, useState } from "react";
import { AnalysisPanel } from "../simulation/AnalysisPanel";
import { useIpcStore } from "../store";
import { useSimSettingsStore } from "../store/sim-settings";
import { ActiveTabToolbar } from "./ActiveTabToolbar";
import {
  Btn,
  FilePlusIcon,
  FolderOpenIcon,
  PlayIcon,
  SaveIcon,
  Sep,
  ShapesIcon,
  StopIcon,
  attachHorizontalWheelScroll,
} from "./ToolbarControls";
import { triggerCancel, triggerRun } from "./run";

// ── Time formatting ───────────────────────────────────────────────────────────

function formatSimTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return "0s";
  if (seconds >= 1) return `${+seconds.toPrecision(3)}s`;
  if (seconds >= 1e-3) return `${+(seconds * 1e3).toPrecision(3)}ms`;
  if (seconds >= 1e-6) return `${+(seconds * 1e6).toPrecision(3)}µs`;
  return `${+(seconds * 1e9).toPrecision(3)}ns`;
}

/**
 * The single, always-visible toolbar row: File actions and Run/Stop +
 * simulation status first, followed by whichever tab-specific segment
 * ActiveTabToolbar.tsx renders for the active editor tab (e.g.
 * canvas/SchematicToolbar.tsx's zoom/clipboard/components/transforms for
 * the Schematic tab) — all in this one row, exactly where the toolbar has
 * always lived (directly below TopBar, above the sidebars/canvas). Tabs
 * with no registered toolbar (Waveforms, Netlist) just get the File/Run
 * segment.
 */
export interface MainToolbarProps {
  onAction: (actionId: string) => void;
}

export function MainToolbar({ onAction }: MainToolbarProps) {
  const status = useIpcStore((state) => state.status);
  const runStartedAt = useIpcStore((state) => state.runStartedAt);
  const tEnd = useSimSettingsStore((state) => state.settings.tEnd);

  const [simDialogOpen, setSimDialogOpen] = useState(false);

  const toolbarRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => attachHorizontalWheelScroll(toolbarRef.current), []);

  const busy = status === "busy" || runStartedAt !== null;

  // Wall-clock elapsed, ticking while a run is in flight.
  //
  // This used to be the *simulated* time, which is the number a user actually
  // wants, read from the furthest sample the kernel had streamed back. Since
  // #159 a run goes to the extension host and the solver writes its container
  // directly, so nothing streams and there was nothing to read: the display
  // sat at `0 s / 10 ms` and the meter beside it at 0% for the whole run,
  // however long it took. A frozen meter reads as a hung solver, which is a
  // worse answer than no meter (#189).
  //
  // So: no meter, and the one number this process genuinely knows. Simulated
  // progress comes back if the engine ever prints it -- see
  // GLODI-Engineering/general-simulator#114.
  const [elapsedMs, setElapsedMs] = useState(0);
  useEffect(() => {
    if (runStartedAt === null) {
      setElapsedMs(0);
      return;
    }
    // Set once immediately so the first paint is not a blank, then every
    // 200 ms: fast enough to look alive, slow enough not to re-render a
    // toolbar five times a second for a number whose last digit is tenths.
    setElapsedMs(Date.now() - runStartedAt);
    const timer = setInterval(() => setElapsedMs(Date.now() - runStartedAt), 200);
    return () => clearInterval(timer);
  }, [runStartedAt]);

  return (
    <div
      ref={toolbarRef}
      className="gs-toolbar main-toolbar"
      role="toolbar"
      aria-label="Main toolbar"
    >
      {/* ── File ── */}
      <Btn title="New  Ctrl+N" label="New" onClick={() => onAction("file.new")}>
        <FilePlusIcon />
      </Btn>
      <Btn title="Open  Ctrl+O" label="Open" onClick={() => onAction("file.open")}>
        <FolderOpenIcon />
      </Btn>
      <Btn title="Save  Ctrl+S" label="Save" onClick={() => onAction("file.save")}>
        <SaveIcon />
      </Btn>
      <Btn title="New Symbol" label="Symbol" onClick={() => onAction("symbol.new")}>
        <ShapesIcon />
      </Btn>

      <Sep />

      {/* ── Simulation ── */}
      <Btn
        title={busy ? "Stop simulation  F5" : "Run simulation  F5"}
        label={busy ? "Stop" : "Run"}
        active={busy}
        danger={busy}
        onClick={() => (busy ? triggerCancel() : void triggerRun())}
      >
        {busy ? <StopIcon /> : <PlayIcon />}
      </Btn>
      {busy ? (
        <div className="main-toolbar__sim-status" aria-live="polite">
          <div className="main-toolbar__sim-status-row">
            <span className="main-toolbar__spinner" />
          </div>
          <span
            className="main-toolbar__sim-times"
            title={`Running — elapsed. Simulating ${formatSimTime(tEnd)}.`}
          >
            {formatElapsed(elapsedMs)}
          </span>
        </div>
      ) : (
        <button
          type="button"
          className="main-toolbar__sim-time"
          title="Analyses and initial conditions"
          aria-label="Simulation"
          onClick={() => setSimDialogOpen(true)}
        >
          Simulation
        </button>
      )}

      {simDialogOpen ? (
        <div className="sim-settings-backdrop" onMouseDown={() => setSimDialogOpen(false)}>
          <div className="sim-settings-dialog" onMouseDown={(event) => event.stopPropagation()}>
            <AnalysisPanel onClose={() => setSimDialogOpen(false)} />
          </div>
        </div>
      ) : null}

      <ActiveTabToolbar onAction={onAction} />
    </div>
  );
}

export default MainToolbar;

/**
 * Wall-clock elapsed, for a run in flight.
 *
 * Tenths below ten seconds, because that is where a run finishing feels
 * instant and a tenth is the difference a user notices; whole seconds up to a
 * minute; then `m:ss`, which is how anyone reads a wait that long.
 */
export function formatElapsed(ms: number): string {
  const seconds = Math.max(0, ms) / 1000;
  if (seconds < 10) {
    return `${seconds.toFixed(1)} s`;
  }
  if (seconds < 60) {
    return `${Math.floor(seconds)} s`;
  }
  const minutes = Math.floor(seconds / 60);
  const rest = Math.floor(seconds % 60);
  return `${minutes}:${String(rest).padStart(2, "0")}`;
}

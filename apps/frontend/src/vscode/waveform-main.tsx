/**
 * Entry point for the waveform/results webview panel.
 *
 * This is a *panel* opened by the `General Simulator: Show Waveforms` command,
 * not a file-backed Custom Editor, because simulation results are not a
 * user-facing document: `packages/simulator/postprocess/result_writer.py`
 * writes them to `<sidecar workdir>/results/<sim_id>/` — an app-private cache
 * under `$XDG_DATA_HOME/general-simulator/`, outside the workspace, keyed by an
 * in-memory sim id, and readable only through the running kernel sidecar's
 * token-gated HTTP slice server. There is nothing in the Explorer to
 * double-click, and VS Code's dirty/save/revert lifecycle would be a lie for
 * read-only derived data.
 */
import React from "react";
import ReactDOM from "react-dom/client";

import { initKernelFromVsCode } from "../ipc/transport";
import { onHostMessage, postToHost } from "../ipc/vscode-host";
import { followVsCodeTheme } from "../ipc/vscode-theme";
import { plotRunContainer } from "../results/container-plot";
import { ErrorBoundary } from "../shell/ErrorBoundary";
import { useIpcStore } from "../store";
import { WaveformTab } from "../waveform/WaveformTab";
import { installWaveformRenderHook } from "../waveform/render-hook";
import { installTestHooks } from "./test-hooks";

import "../styles/app.css";

function boot(): void {
  followVsCodeTheme();
  initKernelFromVsCode();

  onHostMessage((message) => {
    /**
     * A run finished, so plot its container (#157).
     *
     * This panel is where a run becomes a picture inside VS Code. The run is
     * triggered in the *schematic* webview, which hosts only the schematic and
     * has a store of its own, so it asks for this panel instead of drawing
     * where nothing can be seen. `gsim/runResult` is broadcast to every
     * webview and the host replays the last one to a panel that opens
     * afterwards, so both orderings land here.
     *
     * Nothing is parsed out of the `.gsim_sim_result`: the reply names the
     * container, and the container is self-describing — its prologue carries
     * the signal names, their count and the sweep extent, which is what
     * labels the axes before a sample is fetched.
     */
    if (message.type === "gsim/runResult" && message.result.ok) {
      const result = message.result;
      void plotRunContainer(result).catch((error: unknown) => {
        postToHost({
          type: "gsim/log",
          level: "error",
          message:
            `Could not read ${result.samplesPath}: ` +
            `${error instanceof Error ? error.message : String(error)}`,
        });
      });
      return;
    }

    if (message.type === "gsim/showSimulation") {
      const current = useIpcStore.getState().lastManifest;
      if (current?.sim_id !== message.simId) {
        useIpcStore.getState().setLastManifest({
          sim_id: message.simId,
          signals: [],
          t_start: 0,
          t_end: 0,
        });
      }
    }
  });

  installTestHooks();
  installWaveformRenderHook();

  const root = document.getElementById("root");
  if (!root) throw new Error("#root element missing");

  ReactDOM.createRoot(root).render(
    <React.StrictMode>
      <ErrorBoundary label="the waveform viewer">
        <WaveformTab />
      </ErrorBoundary>
    </React.StrictMode>,
  );

  postToHost({ type: "gsim/ready", role: "waveform" });
}

boot();

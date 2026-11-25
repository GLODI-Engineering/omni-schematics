/**
 * Entry point for the `.gsim_sim_result` Custom Editor's webview.
 *
 * The waveform *panel* (`waveform-main.tsx`) shows whatever the running
 * kernel last produced, keyed by an in-memory sim id. This shows a file: a
 * result that was saved, can be committed, attached to a review, reopened
 * next week, or compared against one from another branch — with no kernel
 * running at all. Same viewer, different source of truth, which is why this
 * is a second entry rather than a mode of the first.
 */
import React from "react";
import ReactDOM from "react-dom/client";

import { getWebviewInit, onHostMessage, postToHost } from "../ipc/vscode-host";
import { followVsCodeTheme } from "../ipc/vscode-theme";
import { FIRST_WINDOW_POINTS, plotContainer } from "../results/container-plot";
import { GsimSimResultError, readGsimSimResult } from "../results/document";
import { applyResult } from "../results/load";
import { ErrorBoundary } from "../shell/ErrorBoundary";
import { WaveformTab } from "../waveform/WaveformTab";

import "../styles/app.css";

function showLoadError(root: HTMLElement, message: string): void {
  const pre = document.createElement("pre");
  pre.className = "results-load-error";
  pre.setAttribute("role", "alert");
  pre.textContent = message;
  root.replaceChildren(pre);
}

function load(text: string, root: HTMLElement, render: () => void): void {
  try {
    const parsed = readGsimSimResult(text);
    if (parsed.kind === "samples") {
      // The samples are in a `.gsim_samples` beside this document, and this
      // webview cannot open a file. So the figure layout the document carries
      // goes up first and `plotContainer` reads windows of the container
      // through the extension host (#157) — the axes are labelled from its
      // prologue and the traces land with the first window.
      //
      // The path is resolved by the host against this document's URI, which is
      // the only side that knows where the document is on disk.
      applyResult({
        run: parsed.external.run,
        sweep: new Float64Array(0),
        sweepDomain: "time",
        signals: [],
        layout: parsed.external.layout,
      });
      render();
      void plotContainer({
        simId: parsed.external.run.id,
        target: {
          path: parsed.external.samplesPath,
          relativeTo: getWebviewInit()?.documentUri ?? "",
        },
        maxPoints: FIRST_WINDOW_POINTS,
      }).catch((error: unknown) => {
        const message =
          `This result's samples are in "${parsed.external.samplesPath}", ` +
          `which could not be read.\n\n${error instanceof Error ? error.message : String(error)}`;
        showLoadError(root, message);
        postToHost({ type: "gsim/log", level: "error", message });
      });
      return;
    }
    applyResult(parsed.result);
    render();
  } catch (error) {
    // A results file is often machine-written, so the useful thing to show
    // is which field is wrong — not a blank chart, and not a stack trace.
    const message =
      error instanceof GsimSimResultError
        ? `This file could not be read as a simulation result.\n\n${error.message}`
        : `Unexpected error reading this simulation result.\n\n${String(error)}`;
    showLoadError(root, message);
    postToHost({ type: "gsim/log", level: "error", message });
  }
}

function boot(): void {
  followVsCodeTheme();
  const root = document.getElementById("root");
  if (!root) throw new Error("#root element missing");

  let reactRoot: ReactDOM.Root | null = null;
  const render = () => {
    if (!reactRoot) {
      root.replaceChildren();
      reactRoot = ReactDOM.createRoot(root);
    }
    reactRoot.render(
      <React.StrictMode>
        <ErrorBoundary label="the simulation result viewer">
          <WaveformTab />
        </ErrorBoundary>
      </React.StrictMode>,
    );
  };

  // Revert, and edits made to the file outside this editor, arrive the same
  // way the schematic's do.
  onHostMessage((message) => {
    if (message.type === "gsim/setDocument") {
      reactRoot?.unmount();
      reactRoot = null;
      load(message.text, root, render);
    }
  });

  const initial = getWebviewInit()?.documentText ?? "";
  load(initial, root, render);

  postToHost({ type: "gsim/ready", role: "results" });
}

boot();

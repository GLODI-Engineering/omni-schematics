/**
 * Waveform / results viewer.
 *
 * ## Why a panel, when `.gsim_sim_result` has a Custom Editor of its own
 *
 * There is one, `resultsEditor.ts`, and it is the right thing for a result a
 * user opens by hand. This panel is for the run that *just finished*: it is
 * triggered in the schematic webview, which hosts only the schematic, so a
 * finished run needs somewhere to appear without the user going to find a
 * file first.
 *
 * It is also not one file. A run writes `.gsim/runs/<run id>/` beside the
 * schematic (#159) and the picture is made from two of the files in there —
 * the `.gsim_samples` container and the `.gsim_sim_result` that indexes it —
 * so a document lifecycle (dirty / save / revert) over "the result" would be
 * a lie for read-only derived data. Hence a singleton webview panel, opened by
 * `General Simulator: Show Waveforms`, attached to whichever schematic editor
 * last finished a simulation.
 *
 * This comment used to argue the stronger case, that there was nothing to
 * register an editor *on*: results were written to a directory of
 * `manifest.json` + `.npy` files under `$XDG_DATA_HOME`, outside the
 * workspace, readable only through a running sidecar's token-gated HTTP
 * server. None of that is true any more — the files are in the workspace, the
 * container is self-describing, and the sidecar is gone (#162).
 */
import * as vscode from "vscode";

import type { GsimHost } from "./host";
import { renderWebview } from "./webview-content";

const PANEL_VIEW_TYPE = "omniSchematics.waveforms";

export class WaveformPanel implements vscode.Disposable {
  private panel: vscode.WebviewPanel | null = null;
  private registration: vscode.Disposable | null = null;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly host: GsimHost,
  ) {}

  async show(): Promise<void> {
    if (this.panel) {
      this.panel.reveal(vscode.ViewColumn.Beside, true);
      if (this.host.lastSimId) {
        await this.panel.webview.postMessage({
          type: "gsim/showSimulation",
          simId: this.host.lastSimId,
        });
      }
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      PANEL_VIEW_TYPE,
      "Waveforms",
      { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
      { enableScripts: true, retainContextWhenHidden: true },
    );
    this.panel = panel;
    this.registration = this.host.register("waveform", panel.webview);

    panel.webview.onDidReceiveMessage((message) => {
      this.host.handleCommonMessage(panel.webview, message);
    });

    panel.onDidDispose(() => {
      this.registration?.dispose();
      this.registration = null;
      this.panel = null;
    });

    await renderWebview(this.extensionUri, panel.webview, { role: "waveform" }, this.host.log);
  }

  dispose(): void {
    this.registration?.dispose();
    this.panel?.dispose();
  }
}

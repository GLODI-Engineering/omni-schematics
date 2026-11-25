/**
 * Omni Schematics — the VS Code extension's entry point.
 *
 * Activation wires up two things:
 *
 * 1. the Block Library `WebviewView` in the Activity Bar container, and
 * 2. the `*.gsim_sch` Custom Editor Provider hosting the schematic canvas,
 *    and the read-only `*.gsim_sim_result` one hosting the waveform viewer,
 *
 * plus the `General Simulator: Show Waveforms` panel command.
 *
 * It used to wire up a third: a Python child process, started on activation,
 * that a run was sent to. There is no child process to start (#162) — the
 * extension spawns the solver itself when Run is pressed (#159) — so nothing
 * here runs before the user asks for something.
 */
import * as vscode from "vscode";

import { openExample } from "./examples";
import { GsimHost } from "./host";
import { LIBRARY_VIEW_ID, LibraryViewProvider } from "./libraryView";
import { mirrorToConsole } from "./log";
import {
  NEW_SCHEMATIC_BASENAME,
  SCHEMATIC_EXTENSION,
  modelNameFor,
  newSchematicDocument,
} from "./new-schematic";
import { RESULTS_VIEW_TYPE, ResultsEditorProvider } from "./resultsEditor";
import { createRecordingRunOutput, createRunOutputChannel } from "./run-output";
import { SCHEMATIC_VIEW_TYPE, SchematicEditorProvider } from "./schematicEditor";
import { symbolWatchPattern } from "./symbolLibrary";
import { type GsimTestApi, createTestApi } from "./test-api";
import { isIntegrationTest } from "./test-mode";
import { WaveformPanel } from "./waveformPanel";

export async function activate(context: vscode.ExtensionContext): Promise<GsimTestApi | undefined> {
  const channel = vscode.window.createOutputChannel("General Simulator");
  context.subscriptions.push(channel);
  const log = mirrorToConsole(channel);

  // In integration mode the host is given a recording channel instead of a real
  // one, because VS Code offers no way to read an output channel back and the
  // webview -> host -> panel path (#139) would otherwise be untestable end to
  // end. Outside integration mode this is the real LogOutputChannel.
  const host = new GsimHost(
    log,
    isIntegrationTest() ? createRecordingRunOutput() : createRunOutputChannel(vscode.window),
  );
  context.subscriptions.push(host);

  const waveforms = new WaveformPanel(context.extensionUri, host);
  context.subscriptions.push(waveforms);
  context.subscriptions.push(host.onShowWaveforms(() => void waveforms.show()));

  // User components are files, so they can change without going through the
  // editor: a script writes one, a colleague's branch adds one, the user
  // edits the JSON by hand. Watch the folder and re-publish, rather than
  // treating the running catalog as the source of truth.
  for (const folder of vscode.workspace.workspaceFolders ?? []) {
    const watcher = vscode.workspace.createFileSystemWatcher(symbolWatchPattern(folder));
    const republish = () => void host.publishSymbols();
    context.subscriptions.push(
      watcher,
      watcher.onDidCreate(republish),
      watcher.onDidChange(republish),
      watcher.onDidDelete(republish),
    );
  }

  const schematicProvider = new SchematicEditorProvider(context.extensionUri, host);
  context.subscriptions.push(schematicProvider);
  context.subscriptions.push(
    vscode.window.registerCustomEditorProvider(SCHEMATIC_VIEW_TYPE, schematicProvider, {
      // The canvas holds a lot of live state; rebuilding it on every tab
      // switch would be visibly slow.
      webviewOptions: { retainContextWhenHidden: true },
      supportsMultipleEditorsPerDocument: false,
    }),
  );

  const resultsProvider = new ResultsEditorProvider(context.extensionUri, host);
  context.subscriptions.push(resultsProvider);
  context.subscriptions.push(
    vscode.window.registerCustomEditorProvider(RESULTS_VIEW_TYPE, resultsProvider, {
      // A result holds every sample of every signal; re-decoding and
      // re-plotting them on each tab switch is visibly slow.
      webviewOptions: { retainContextWhenHidden: true },
      supportsMultipleEditorsPerDocument: false,
    }),
  );

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      LIBRARY_VIEW_ID,
      new LibraryViewProvider(context.extensionUri, host),
      { webviewOptions: { retainContextWhenHidden: true } },
    ),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("omniSchematics.showWaveforms", () => waveforms.show()),
    vscode.commands.registerCommand("omniSchematics.showLog", () => log.show()),
    /**
     * Open one of the bundled examples (#131).
     *
     * A copy is opened, never the shipped file: editing inside the extension's own
     * directory means losing that work on the next update, which replaces it.
     */
    vscode.commands.registerCommand("omniSchematics.openExample", () =>
      openExample(context.extensionUri),
    ),
    /**
     * Hand a keyboard shortcut VS Code claimed to the schematic.
     *
     * A webview only receives a keystroke the workbench did not take first, so the 28 chords
     * VS Code binds at the workbench level never reached the canvas — `Ctrl+R` opened its
     * recent-files list rather than rotating the selection. `package.json` contributes those
     * chords, generated from the schematic's own keymap by `scripts/gen-keybindings.mjs`, each
     * guarded by `activeCustomEditorId` and the `overrideVsCodeKeybindings` setting. This
     * relays the chord in.
     *
     * Broadcast to the schematic role rather than to one webview: the keybinding only fires
     * with a schematic active, and the webview synthesises a real keydown, so a background
     * schematic tab drops it at the same focus check a physical keystroke would meet.
     */
    vscode.commands.registerCommand("omniSchematics.forwardChord", (args: unknown) => {
      const chord =
        args && typeof args === "object" && typeof (args as { chord?: unknown }).chord === "string"
          ? (args as { chord: string }).chord
          : null;
      if (!chord) {
        // Reachable only from the command palette or a hand-written keybinding with no `args`.
        // There is no chord to forward, and guessing one would fire an arbitrary action.
        log.appendLine("forwardChord: ignored, no chord in args");
        return;
      }
      host.broadcast({ type: "gsim/forwardedChord", chord }, { role: "schematic" });
    }),
    /**
     * Create a schematic and open it in the canvas.
     *
     * The first thing a new user touches, and until #211 the only way to reach
     * it was to know its name in the command palette: it was contributed to
     * `commandPalette` and nowhere else, so "click the extension and there is
     * no way to create a new file" was an accurate description of the product.
     * It is contributed to `file/newFile`, the Block Library's title bar and
     * the Explorer context menu now.
     *
     * `target` is what those entry points hand over. A `.gsim_sch` URI is
     * created directly, which is also the door the integration suite uses — a
     * modal Save dialog cannot be driven from a test, and this path being
     * untestable is how the zero-byte file below went unnoticed. A folder (the
     * Explorer's selection) seeds the dialog instead of being written to.
     */
    vscode.commands.registerCommand("omniSchematics.newSchematic", async (target?: unknown) => {
      const hint = target instanceof vscode.Uri ? target : undefined;
      const direct = hint?.path.endsWith(SCHEMATIC_EXTENSION) ? hint : undefined;

      const uri = direct ?? (await askWhereToPutIt(hint));
      if (!uri) return;

      // Never clobber. `showSaveDialog` asks before it returns an existing
      // path, but the direct form above has no dialog in front of it, and a
      // command that silently replaces a schematic with an empty one is the
      // worst thing on this code path.
      if (!(await exists(uri))) {
        await vscode.workspace.fs.writeFile(
          uri,
          new TextEncoder().encode(newSchematicDocument(modelNameFor(uri.path))),
        );
      }
      await vscode.commands.executeCommand("vscode.openWith", uri, SCHEMATIC_VIEW_TYPE);
    }),
    vscode.commands.registerCommand("omniSchematics.openSchematic", async () => {
      const picked = await vscode.window.showOpenDialog({
        canSelectMany: false,
        filters: { "General Simulator schematic": ["gsim_sch"] },
        openLabel: "Open schematic",
      });
      const target = picked?.[0];
      if (!target) return;
      await vscode.commands.executeCommand("vscode.openWith", target, SCHEMATIC_VIEW_TYPE);
    }),
  );

  // Only the @vscode/test-electron harness gets a handle on the live host.
  return isIntegrationTest() ? createTestApi(host) : undefined;
}

/** True when something is already at this path. */
async function exists(uri: vscode.Uri): Promise<boolean> {
  try {
    await vscode.workspace.fs.stat(uri);
    return true;
  } catch {
    return false;
  }
}

/**
 * The Save dialog, opened somewhere the user will recognise.
 *
 * It used to open with no `defaultUri` at all, which puts it in whatever
 * directory the OS last remembered and offers no file name — so the first
 * step of using this editor was typing a path and remembering the extension.
 * The order is: where the user clicked, then the folder of the schematic they
 * are looking at, then the workspace root.
 */
async function askWhereToPutIt(hint?: vscode.Uri): Promise<vscode.Uri | undefined> {
  const directory =
    hint ?? folderOfActiveSchematic() ?? vscode.workspace.workspaceFolders?.[0]?.uri ?? undefined;

  return vscode.window.showSaveDialog({
    ...(directory ? { defaultUri: vscode.Uri.joinPath(directory, NEW_SCHEMATIC_BASENAME) } : {}),
    filters: { "Omni Schematics schematic": ["gsim_sch"] },
    title: "New schematic",
    saveLabel: "Create schematic",
  });
}

function folderOfActiveSchematic(): vscode.Uri | undefined {
  const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input as
    | { uri?: vscode.Uri }
    | undefined;
  const uri = input?.uri;
  if (!uri || !uri.path.endsWith(SCHEMATIC_EXTENSION)) return undefined;
  return vscode.Uri.joinPath(uri, "..");
}

export function deactivate(): void {
  // Everything is registered in `context.subscriptions`, and VS Code disposes
  // it. There is no child process started at activation left to tear down.
}

/**
 * Integration suite — runs inside a real VS Code extension host launched by
 * `@vscode/test-electron`.
 *
 * What each layer here actually exercises (be precise about this when reading
 * a green run):
 *
 * - **Real**: extension activation, contribution registration, the Custom
 *   Editor Provider resolving a `.gsim_sch`, the sidebar `WebviewView`
 *   resolving, the Vite bundle loading under the injected CSP inside a real
 *   Chromium webview, React mounting and rendering real DOM, the zustand
 *   stores populating, `Webview.postMessage` in both directions, and the whole
 *   `GsimHost` fan-out.
 * - **Real, at the DOM-event layer**: the canvas drop handler runs against a
 *   genuine `DragEvent` with a genuine empty `DataTransfer`, dispatched on the
 *   real `.canvas-flow` element, and inserts a real block into the graph.
 * - **NOT covered**: the browser's own pointer/hit-testing that decides *which
 *   iframe* receives `dragover`/`drop` during a physical mouse drag between
 *   two webviews. No VS Code extension API can synthesise an OS-level drag
 *   across webview boundaries. That single step still needs a human.
 */
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";

import * as vscode from "vscode";

import type { GsimTestApi } from "../../test-api";
import { EXTENSION_ID as TEST_API_EXTENSION_ID, getTestApi } from "../../test-api";

// Imported, not re-declared: see test-api.ts.
const EXTENSION_ID = TEST_API_EXTENSION_ID;
const SCHEMATIC_VIEW_TYPE = "omniSchematics.schematic";

interface MountReport {
  role: string;
  rootExists: boolean;
  childElementCount: number;
  textLength: number;
  hasCanvas: boolean;
  hasLibrary: boolean;
  hasLibraryItems: number;
  hasWaveform: boolean;
  hasMainToolbar: boolean;
}

interface DropReport {
  before: number;
  after: number;
  inserted: number;
  lastBlockType: string | null;
  canvasRect: { width: number; height: number };
}

function workspaceDir(): string {
  const dir = process.env.GSIM_TEST_WORKSPACE;
  assert.ok(dir, "GSIM_TEST_WORKSPACE must be set by the launcher");
  return dir;
}

function schematicUri(): vscode.Uri {
  return vscode.Uri.file(path.join(workspaceDir(), "sample.gsim_sch"));
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

let api: GsimTestApi;

suite("Omni Schematics — VS Code integration", () => {
  suiteSetup(async () => {
    api = await getTestApi();
  });

  // -------------------------------------------------------------------------
  test("the extension activates and registers its contributions", async () => {
    const extension = vscode.extensions.getExtension(EXTENSION_ID);
    assert.ok(extension, "extension is present");
    assert.equal(extension.isActive, true, "extension is active");

    const commands = await vscode.commands.getCommands(true);
    for (const id of [
      "omniSchematics.showWaveforms",
      "omniSchematics.showLog",
      "omniSchematics.newSchematic",
      "omniSchematics.openSchematic",
    ]) {
      assert.ok(commands.includes(id), `command ${id} is registered`);
    }

    const contributes = extension.packageJSON.contributes;
    assert.equal(contributes.customEditors[0].viewType, SCHEMATIC_VIEW_TYPE);
    assert.equal(contributes.customEditors[0].selector[0].filenamePattern, "*.gsim_sch");
    assert.equal(contributes.views.omniSchematics[0].id, "omniSchematics.library");
    assert.equal(contributes.views.omniSchematics[0].type, "webview");
  });
  // -------------------------------------------------------------------------
  suite("library sidebar webview", () => {
    suiteSetup(async () => {
      await vscode.commands.executeCommand("omniSchematics.library.focus");
      await api.waitForWebview("library");
    });

    test("renders the real React library, not a placeholder", async () => {
      const report = await api.probe<MountReport>("library", "mounted");
      assert.equal(report.role, "library");
      assert.equal(report.rootExists, true, "#root exists");
      assert.ok(report.childElementCount > 0, "React rendered into #root");
      assert.equal(report.hasLibrary, true, ".library-activity is in the DOM");
      assert.ok(report.textLength > 50, `library rendered text (${report.textLength} chars)`);
    });

    test("loads the block catalog and renders draggable items", async () => {
      const catalogSize = await api.probe<number>("library", "catalogSize");
      assert.ok(catalogSize > 0, `catalog loaded (${catalogSize} entries)`);

      const report = await api.probe<MountReport>("library", "mounted");
      assert.ok(report.hasLibraryItems > 0, `rendered ${report.hasLibraryItems} .library-item`);
    });
  });

  // -------------------------------------------------------------------------
  suite("schematic custom editor", () => {
    suiteSetup(async () => {
      await vscode.commands.executeCommand("vscode.openWith", schematicUri(), SCHEMATIC_VIEW_TYPE);
      await api.waitForWebview("schematic");
    });

    test("opens .gsim_sch in the custom editor and mounts the canvas", async () => {
      const report = await api.probe<MountReport>("schematic", "mounted");
      assert.equal(report.role, "schematic");
      assert.ok(report.childElementCount > 0, "React rendered into #root");
      assert.equal(report.hasCanvas, true, ".canvas-flow is in the DOM");
      assert.equal(report.hasMainToolbar, true, ".main-toolbar is in the DOM");
    });

    test("the custom editor is the active editor for the file", () => {
      const tab = vscode.window.tabGroups.activeTabGroup.activeTab;
      assert.ok(tab, "a tab is active");
      const input = tab.input as { viewType?: string; uri?: vscode.Uri };
      assert.equal(input.viewType, SCHEMATIC_VIEW_TYPE);
      assert.equal(input.uri?.fsPath, schematicUri().fsPath);
    });

    test("editing in the webview marks the VS Code tab dirty, and save writes the file", async () => {
      const changed = api.nextMessage("schematic", "gsim/documentChanged");
      await api.probe("schematic", "renameModel", { name: "IntegrationRenamed" });
      await changed;

      // VS Code needs a beat to reflect onDidChangeCustomDocument on the tab.
      for (let i = 0; i < 40 && !vscode.window.tabGroups.activeTabGroup.activeTab?.isDirty; i++) {
        await sleep(100);
      }
      assert.equal(
        vscode.window.tabGroups.activeTabGroup.activeTab?.isDirty,
        true,
        "tab went dirty via onDidChangeCustomDocument",
      );

      const saved = await vscode.commands.executeCommand("workbench.action.files.save");
      void saved;
      for (let i = 0; i < 40 && vscode.window.tabGroups.activeTabGroup.activeTab?.isDirty; i++) {
        await sleep(100);
      }
      assert.equal(
        vscode.window.tabGroups.activeTabGroup.activeTab?.isDirty,
        false,
        "tab is clean after save",
      );

      const onDisk = fs.readFileSync(schematicUri().fsPath, "utf8");
      assert.ok(onDisk.length > 0, "saveCustomDocument wrote bytes to disk");
      assert.ok(
        onDisk.includes("IntegrationRenamed"),
        "the file contains the edit made inside the webview",
      );
    });

    test("the in-app Save button funnels into VS Code's own save, not the storage adapter", async () => {
      // Make the editor dirty through a real graph mutation first, so a save
      // that does nothing would be visible as a still-dirty tab.
      const changed = api.nextMessage("schematic", "gsim/documentChanged");
      await api.probe("schematic", "renameModel", { name: "ToolbarSavedModel" });
      await changed;

      for (let i = 0; i < 40 && !vscode.window.tabGroups.activeTabGroup.activeTab?.isDirty; i++) {
        await sleep(100);
      }
      assert.equal(
        vscode.window.tabGroups.activeTabGroup.activeTab?.isDirty,
        true,
        "tab is dirty before the toolbar Save click",
      );

      // Click the *real* toolbar button in the real webview DOM. The click
      // must reach the extension host as gsim/saveDocument — which is what
      // proves App.handleAction routed through handleHostFileAction rather
      // than through file-ops.ts + the storage adapter.
      const saveRequested = api.nextMessage("schematic", "gsim/saveDocument");
      const clicked = await api.probe<{ clicked: string }>("schematic", "clickToolbarButton", {
        label: "Save",
      });
      assert.equal(clicked.clicked, "Save");
      await saveRequested;

      for (let i = 0; i < 40 && vscode.window.tabGroups.activeTabGroup.activeTab?.isDirty; i++) {
        await sleep(100);
      }
      assert.equal(
        vscode.window.tabGroups.activeTabGroup.activeTab?.isDirty,
        false,
        "the toolbar click drove VS Code's save and cleaned the tab",
      );

      const onDisk = fs.readFileSync(schematicUri().fsPath, "utf8");
      assert.ok(
        onDisk.includes("ToolbarSavedModel"),
        "saveCustomDocument wrote the toolbar-saved edit to the real file",
      );
    });
  });

  // -------------------------------------------------------------------------
  suite("cross-webview drag bridge (message-protocol layer)", () => {
    suiteSetup(async () => {
      await vscode.commands.executeCommand("omniSchematics.library.focus");
      await api.waitForWebview("library");
      await vscode.commands.executeCommand("vscode.openWith", schematicUri(), SCHEMATIC_VIEW_TYPE);
      await api.waitForWebview("schematic");
    });

    teardown(async () => {
      await api.probe("library", "simulateDragEnd").catch(() => undefined);
      await sleep(150);
    });

    test("a drag started in the library reaches the schematic webview", async () => {
      const before = await api.probe<string | null>("schematic", "dragState");
      assert.equal(before, null, "no drag in flight to begin with");

      // Real drag-source path: this is what SidebarItem.onDragStart calls.
      await api.probe("library", "simulateDragStart", {
        blockName: "passive.resistor",
        label: "Resistor",
      });

      // Give GsimHost's fan-out a moment to reach the other webview.
      let seen: string | null = null;
      for (let i = 0; i < 50; i += 1) {
        seen = await api.probe<string | null>("schematic", "dragState");
        if (seen === "passive.resistor") break;
        await sleep(100);
      }
      assert.equal(
        seen,
        "passive.resistor",
        "the schematic webview adopted the block broadcast by the extension host",
      );
    });

    test("the library webview does not receive its own drag broadcast echoed back", async () => {
      await api.probe("library", "simulateDragStart", { blockName: "passive.capacitor" });
      await sleep(400);
      // The library's own tracker holds it because *it* set it, not because it
      // was echoed — the meaningful assertion is that the schematic got it.
      const schematic = await api.probe<string | null>("schematic", "dragState");
      assert.equal(schematic, "passive.capacitor");
    });

    /**
     * The gesture a hand makes: press on a toolbar component, drag onto the
     * sheet, release — all inside the schematic webview. Reported broken
     * after #3 was fixed and shipped, so it is pinned here, in real VS Code,
     * rather than only in a browser where it already passed.
     */
    /**
     * The host half of "read ports from source".
     *
     * The browser suite has no extension host, so without this the file
     * read, the workspace confinement and the reply are covered by nothing.
     */
    test("the host hands the webview a workspace file", async () => {
      const dir = process.env.GSIM_TEST_WORKSPACE;
      assert.ok(dir, "the test workspace path is published to the suite");
      const source = "function [y1, y2] = ctrl(u1, u2)\n  y1 = u1;\n  y2 = u2;\nend\n";
      fs.writeFileSync(path.join(dir as string, "ctrl.m"), source, "utf8");

      const got = await api.probe<{ ok: boolean; text: string | null }>("schematic", "readSource", {
        path: "ctrl.m",
      });
      assert.equal(got.ok, true, "the file was read");
      assert.ok(got.text?.includes("function [y1, y2] = ctrl"), "and it is the file we wrote");
    });

    /**
     * The path comes from a block parameter, which is to say from a document
     * that may have been opened from anywhere. An unchecked read is an
     * invitation to walk out of the project.
     */
    test("and refuses a path outside the workspace", async () => {
      const got = await api.probe<{ ok: boolean }>("schematic", "readSource", {
        path: "../../../../etc/passwd",
      });
      assert.equal(got.ok, false, "a traversal is refused rather than served");
    });

    test("dragging a component out of the toolbar drops it on the sheet", async () => {
      const startCount = await api.probe<number>("schematic", "blockCount");
      const drag = await api.probe<{
        inserted: number;
        lastBlockType: string | null;
        draggableAttr: string | null;
        draggedAfterStart: string | null;
      }>("schematic", "dispatchToolbarDrag");

      assert.equal(
        drag.draggableAttr,
        "true",
        "the toolbar button must offer a drag at all — if this fails the build predates #3",
      );
      assert.ok(
        drag.draggedAfterStart,
        "dragstart must record which block is in flight, or the drop has nothing to resolve",
      );
      assert.equal(drag.inserted, 1, "the drop must insert exactly one block");

      const endCount = await api.probe<number>("schematic", "blockCount");
      assert.equal(endCount, startCount + 1, "the graph store really grew");
    });

    test("dropping on the real canvas inserts the host-brokered block", async () => {
      const startCount = await api.probe<number>("schematic", "blockCount");

      await api.probe("library", "simulateDragStart", {
        blockName: "passive.resistor",
        label: "Resistor",
      });
      for (let i = 0; i < 50; i += 1) {
        if ((await api.probe("schematic", "dragState")) === "passive.resistor") break;
        await sleep(100);
      }

      // A genuine DragEvent with an EMPTY DataTransfer, dispatched on the real
      // .canvas-flow element — precisely the cross-webview case where
      // getData() yields nothing and the payload must come from the host.
      const drop = await api.probe<DropReport>("schematic", "dispatchCanvasDrop");

      assert.ok(drop.canvasRect.width > 0, "the canvas has real layout geometry");
      assert.equal(drop.inserted, 1, "exactly one block was inserted by the drop handler");
      assert.equal(drop.lastBlockType, "passive.resistor", "the brokered block is what landed");
      assert.equal(drop.before, startCount);

      const endCount = await api.probe<number>("schematic", "blockCount");
      assert.equal(endCount, startCount + 1, "the graph store really grew");
    });

    test("ending the drag clears the brokered payload everywhere", async () => {
      await api.probe("library", "simulateDragStart", { blockName: "passive.resistor" });
      for (let i = 0; i < 50; i += 1) {
        if ((await api.probe("schematic", "dragState")) === "passive.resistor") break;
        await sleep(100);
      }
      await api.probe("library", "simulateDragEnd");

      let seen: string | null = "passive.resistor";
      for (let i = 0; i < 50; i += 1) {
        seen = await api.probe<string | null>("schematic", "dragState");
        if (seen === null) break;
        await sleep(100);
      }
      assert.equal(seen, null, "gsim/dragEnd cleared the schematic webview's tracker");
    });

    test("a drop with nothing in flight inserts nothing", async () => {
      await api.probe("library", "simulateDragEnd");
      await sleep(300);
      const drop = await api.probe<DropReport>("schematic", "dispatchCanvasDrop");
      assert.equal(drop.inserted, 0, "no phantom insertion");
    });
  });

  // -------------------------------------------------------------------------
  suite("waveform panel", () => {
    test("the Show Waveforms command opens a webview that mounts", async () => {
      await vscode.commands.executeCommand("omniSchematics.showWaveforms");
      await api.waitForWebview("waveform");
      const report = await api.probe<MountReport>("waveform", "mounted");
      assert.equal(report.role, "waveform");
      assert.ok(report.childElementCount > 0, "React rendered into #root");
      assert.equal(report.hasWaveform, true, "the waveform surface is in the DOM");
    });
  });

  // -------------------------------------------------------------------------
  suite("run output reaches VS Code's Output panel (#139)", () => {
    /**
     * The whole point of testing this here rather than in a unit test: what
     * the webview knows about a run reaches the host only because the webview
     * forwards it. That hop is a real postMessage across a real webview
     * boundary, and only a real VS Code has one.
     *
     * What this cannot assert is colour. VS Code renders a LogOutputChannel's
     * levels itself and exposes neither the channel's contents nor its
     * rendering, so the host is handed a recording stand-in in integration
     * mode and the colour stays a visual check.
     */
    suiteSetup(async () => {
      await api.waitForWebview("schematic");
    });

    test("a labelled line emitted in the webview arrives at the host's channel", async () => {
      const before = api.runOutput().length;

      const result = await api.probe<{ sent: number }>("schematic", "emitRunOutput", {
        lines: [
          { source: "build", severity: "error", text: "blk.c:12:5: error: 'x' undeclared" },
          { source: "solver", severity: "info", text: "solved 1000 steps" },
        ],
      });
      assert.equal(result.sent, 2, "the webview reported sending both lines");

      // The forward is a postMessage; give the host a moment to receive it.
      const deadline = Date.now() + 5000;
      while (api.runOutput().length < before + 2 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }

      const written = api.runOutput().slice(before);
      assert.deepEqual(
        written,
        [
          { level: "error", text: "[build] blk.c:12:5: error: 'x' undeclared" },
          { level: "info", text: "[solver] solved 1000 steps" },
        ],
        "both lines reached the channel, each tagged with its source and level",
      );
    });

    test("a multi-line chunk becomes one entry per line", async () => {
      // Solver and compiler output arrives in chunks, not lines; an unsplit
      // chunk would land as one dated, levelled blob.
      const before = api.runOutput().length;

      await api.probe("schematic", "emitRunOutput", {
        lines: [{ source: "build", severity: "error", text: "first\nsecond\n\nthird" }],
      });

      const deadline = Date.now() + 5000;
      while (api.runOutput().length < before + 3 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }

      assert.deepEqual(api.runOutput().slice(before), [
        { level: "error", text: "[build] first" },
        { level: "error", text: "[build] second" },
        { level: "error", text: "[build] third" },
      ]);
    });
  });

  // -------------------------------------------------------------------------
  suite("Run goes all the way to a result, with no Python (#159)", () => {
    /**
     * The claim this suite exists to check, end to end, in one go:
     *
     *   the webview compiles -> posts the netlist -> the extension host
     *   resolves `general-simulator`, spawns it, streams its two streams to
     *   the Output channel, reads its event log, writes the result document
     *   -> the webview is told where it landed.
     *
     * Nothing in that sentence is a Python process, and there is no longer
     * anything in the extension that could start one (#162).
     *
     * Skipped, loudly, without a binary. `GSIM_GENERAL_SIMULATOR_PATH` names
     * one, and the launcher puts it in the workspace's own
     * `omniSchematics.generalSimulatorPath` -- the rung a user actually sets.
     */
    const solver = process.env.GSIM_GENERAL_SIMULATOR_PATH;
    const example = path.join(workspaceDir(), "buck_converter.gsim_sch");

    suiteSetup(async function suiteSetup(this: Mocha.Context) {
      if (!solver || !fs.existsSync(solver) || !fs.existsSync(example)) {
        console.log(
          "[integration] skipping the run suite: set GSIM_GENERAL_SIMULATOR_PATH to a " +
            "general-simulator binary to exercise it",
        );
        this.skip();
      }
      // One schematic webview at a time: `webviewFor("schematic")` hands back
      // the first registered, so leaving the empty `sample.gsim_sch` open
      // would have the probe drive that one instead of the example.
      await vscode.commands.executeCommand("workbench.action.closeAllEditors");
      const deadline = Date.now() + 10_000;
      while (api.readyRoles().includes("schematic") && Date.now() < deadline) {
        await sleep(100);
      }
      await vscode.commands.executeCommand(
        "vscode.openWith",
        vscode.Uri.file(example),
        SCHEMATIC_VIEW_TYPE,
      );
      await api.waitForWebview("schematic");
    });

    test("pressing Run leaves a complete result on disk", async () => {
      const before = api.runOutput().length;
      const report = await api.probe<{
        toasts: string[];
        output: string[];
        problems: { severity: string; message: string }[];
        netlist: string | null;
      }>("schematic", "run", {}, 120_000);

      // The editor compiled it, in WebAssembly, in this webview.
      assert.ok(report.netlist, "the webview compiled a netlist");
      assert.match(report.netlist as string, /^vin /m, "the netlist is the buck converter's");

      assert.ok(
        report.toasts.some((message) => /Simulation finished/.test(message)),
        `expected a finished toast, got ${JSON.stringify(report.toasts)}`,
      );

      // The run directory, found rather than assumed: its name is a timestamp.
      const runsDir = path.join(workspaceDir(), ".gsim", "runs");
      const runs = fs.readdirSync(runsDir).sort();
      assert.ok(runs.length > 0, "a run directory was created");
      const run = path.join(runsDir, runs[runs.length - 1] as string);

      const netlistOnDisk = fs.readFileSync(path.join(run, "netlist.cir"), "utf8");
      assert.equal(
        netlistOnDisk.trimEnd(),
        (report.netlist as string).trimEnd(),
        "the host ran exactly the netlist the webview compiled",
      );

      const samples = fs.statSync(path.join(run, "run.gsim_samples"));
      assert.ok(samples.size > 10_000, `the container holds samples (${samples.size} bytes)`);

      const manifest = JSON.parse(
        fs.readFileSync(path.join(run, "result.gsim_sim_result"), "utf8"),
      );
      assert.equal(manifest.schema_version, 2);
      assert.equal(manifest.data.kind, "samples");
      assert.equal(manifest.data.path, "run.gsim_samples");
      assert.equal(
        manifest.run.source,
        "buck_converter.gsim_sch",
        "the result names the document it came from, workspace-relative",
      );
      assert.ok(manifest.signals.length > 0, "the manifest names the container's signals");
      assert.deepEqual(
        manifest.sweep,
        { name: "t", unit: "s", domain: "time" },
        "a transient run's sweep is simulated seconds",
      );

      // And the solver's own output reached the VS Code channel, labelled.
      const written = api.runOutput().slice(before);
      assert.ok(
        written.some((entry) => entry.text.includes("[compile]")),
        "the compile was reported",
      );
      assert.ok(
        written.some((entry) => /\[solver\].*--format samples/.test(entry.text)),
        `the exact command line was reported, got ${JSON.stringify(written.slice(0, 8))}`,
      );
      assert.ok(
        written.some((entry) => entry.text.includes("result.gsim_sim_result")),
        "the result's path was reported",
      );
    });

    /**
     * The claim #157 exists for, measured in a real webview.
     *
     * The run above left a `.gsim_samples` container on disk. Nothing in this
     * window can decimate except the WebAssembly in a webview, and nothing
     * can read a file except the extension host, so a trace on screen here is
     * the whole two-sided mechanism working: the viewer planned the ranges,
     * `gsim/readSamples` carried them to the host, the host read exactly those
     * bytes, and `crates/waveform-store` turned them into points.
     *
     * Driven against the **waveform panel**, because that is where a run
     * becomes a picture in VS Code: the schematic webview hosts only the
     * schematic (`App.tsx` pins its surface), so it asks for this panel and
     * the host hands it the result — broadcast if it is open, replayed on its
     * `gsim/ready` if it opens afterwards.
     *
     * Read off the live uPlot instances rather than off a store, because a
     * store write is not a picture.
     */
    interface WaveformReport {
      simId: string | null;
      figures: number;
      axes: number;
      cached: { key: string; samples: number; unit: string; quantity: string }[];
      bytesFetched: number;
      lastWindowBytes: number;
      traces: {
        axesId: string;
        series: number;
        points: number;
        peaks: { min: number; max: number }[];
      }[];
    }

    /**
     * The panel's report once it is drawing, or whatever it last said.
     *
     * `notSimId` is the run it must have moved *past*: a second run leaves the
     * first run's traces on screen until its own window lands, so "a trace
     * exists" is already true and waiting on it alone would read the previous
     * run's numbers. That is how this test first passed while measuring the
     * wrong container.
     */
    async function drawnReport(
      notSimId?: string | null,
      deadlineMs = 60_000,
    ): Promise<WaveformReport> {
      const deadline = Date.now() + deadlineMs;
      const settled = (report: WaveformReport) =>
        report.traces.some((trace) => trace.points > 0) &&
        (notSimId === undefined || report.simId !== notSimId);

      let report = await api.probe<WaveformReport>("waveform", "waveform", {}, 30_000);
      while (Date.now() < deadline && !settled(report)) {
        await sleep(250);
        report = await api.probe<WaveformReport>("waveform", "waveform", {}, 30_000);
      }
      return report;
    }

    test("the container is plotted, from a fraction of its bytes", async () => {
      // The viewer, where the schematic asked for it to be.
      await vscode.commands.executeCommand("omniSchematics.showWaveforms");
      await api.waitForWebview("waveform");

      const report = await drawnReport();

      assert.ok(report.figures > 0, "the run laid out a figure");
      assert.ok(
        report.cached.length > 0,
        `the container's signals are cached, got ${report.cached.length}`,
      );
      assert.ok(
        report.cached.every((signal) => signal.samples > 0),
        `every cached signal carries samples, got ${JSON.stringify(report.cached)}`,
      );
      // Labelled from the container's prologue, not left bare. The solver
      // writes `quantity: "dimensionless"` for every vector, which
      // `axes-config.ts` *skips* when building spines -- so taking that field
      // at face value gives a chart with no y axis at all (#185).
      assert.ok(
        report.cached.some((signal) => signal.unit !== ""),
        `the signals carry units, got ${JSON.stringify(report.cached)}`,
      );
      assert.ok(
        report.cached.every((signal) => signal.quantity !== "dimensionless"),
        `no signal is left dimensionless, got ${JSON.stringify(report.cached)}`,
      );

      const drawn = report.traces.filter((trace) => trace.points > 0);
      assert.ok(
        drawn.length > 0,
        `at least one uPlot instance is drawing points, got ${JSON.stringify(report.traces)}`,
      );
      assert.ok(
        drawn.some((trace) => trace.peaks.some((peak) => peak.max > peak.min)),
        `a drawn trace varies rather than being a flat line, got ${JSON.stringify(drawn)}`,
      );

      // The whole point of the format: the bytes read are a fraction of the
      // file, and that fraction does not grow with the run's length.
      const runsDir = path.join(workspaceDir(), ".gsim", "runs");
      const runs = fs.readdirSync(runsDir).sort();
      const container = path.join(runsDir, runs[runs.length - 1] as string, "run.gsim_samples");
      const size = fs.statSync(container).size;
      assert.ok(report.bytesFetched > 0, "something was fetched");
      // Per *window*, because that is the claim: one view is a small read
      // whatever the file's length. The cumulative figure is logged beside it
      // and is deliberately not asserted -- this example is 1,000 samples,
      // which is a single stripe, so two views of it already pass the file's
      // own size. The ratio only means something on a long run, and
      // `samples-source.test.ts` plus the measurements in the pull request
      // are where that is shown.
      assert.ok(
        report.lastWindowBytes > 0 && report.lastWindowBytes <= size,
        `one window read ${report.lastWindowBytes} bytes of a ${size}-byte container`,
      );
      console.log(
        `[integration] plotted ${drawn[0]?.series ?? 0} series of ${drawn[0]?.points ?? 0} ` +
          `points; one window read ${report.lastWindowBytes} bytes of ${size} ` +
          `(${((100 * report.lastWindowBytes) / size).toFixed(1)}%), ` +
          `${report.bytesFetched} bytes over every read so far`,
      );
    });

    /**
     * A narrower window costs less than the whole extent.
     *
     * Which ranges a window reads is decided from the stripe directory and
     * index arithmetic — no sample value takes part — so this is a property of
     * the format rather than of a cache, and it is the reason a
     * multi-gigabyte result scrubs at all.
     */
    test("a window narrower than the extent fetches less than the whole extent", async () => {
      // A longer, finer run than the example asks for by default. The
      // container stores samples in stripes of a fixed number of rows, so a
      // 1,000-sample run is a *single* stripe and every window of it reads
      // that one stripe -- true, and it tells us nothing. 100,000 rows is
      // several stripes, which is where a window's cost starts to track the
      // window.
      const previous = (await api.probe<WaveformReport>("waveform", "waveform", {}, 30_000)).simId;
      await api.probe("schematic", "run", { tEnd: 1e-3, tStep: 1e-8 }, 180_000);
      const report = await drawnReport(previous);
      assert.notEqual(report.simId, previous, "the panel moved on to the longer run");
      assert.ok(
        report.cached.every((signal) => signal.samples > 0),
        "the longer run is drawn before its cost is measured",
      );

      const full = await api.probe<{ bytesFetched: number; maxPoints: number }>(
        "waveform",
        "fullWaveform",
        { maxPoints: 500 },
        60_000,
      );
      const zoomed = await api.probe<{
        bytesFetched: number;
        window: [number, number];
        extent: [number, number];
      }>("waveform", "zoomWaveform", { fraction: 0.05, maxPoints: 500 }, 60_000);

      console.log(
        `[integration] whole extent at 500 points: ${full.bytesFetched} bytes; ` +
          `5% of it: ${zoomed.bytesFetched} bytes`,
      );
      assert.ok(full.bytesFetched > 0, "the whole extent cost something to read");
      assert.ok(
        zoomed.bytesFetched < full.bytesFetched,
        `a 5% window (${zoomed.bytesFetched} bytes) must cost less than the whole extent ` +
          `(${full.bytesFetched} bytes)`,
      );
      assert.ok(
        zoomed.window[1] - zoomed.window[0] < zoomed.extent[1] - zoomed.extent[0],
        "the window really is narrower than the extent",
      );
    });
  });
});

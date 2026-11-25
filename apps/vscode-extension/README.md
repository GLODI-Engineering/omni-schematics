# General Simulator — VS Code extension

Hosts the General Simulator frontend (`apps/frontend`) inside VS Code, so
schematic capture and simulation live next to the Python / C / Octave files
that back `pyblock` / `octfunc` / `cscript` blocks, with VS Code's own language
tooling. Those are the engine's business, not this extension's: nothing here
runs an interpreter.

## What it contributes

| Contribution | Id | Surface |
| --- | --- | --- |
| Activity Bar view container | `omniSchematics` | icon + "Omni Schematics" |
| Webview view | `omniSchematics.library` | `library/LibraryActivity.tsx` (no `PrimarySideBar` wrapper — VS Code supplies the sidebar chrome) |
| Custom editor | `omniSchematics.schematic` for `*.gsim_sch` | `canvas/Canvas.tsx` + the rest of `canvas/**` in a `WebviewPanel`; real `CustomEditorProvider` save / save-as / revert / hot-exit backup |
| Command | `General Simulator: Show Waveforms` | `waveform/WaveformTab.tsx` in a webview **panel** — see `src/waveformPanel.ts` for why this is not a second custom editor |
| Command | `Omni Schematics: Show Log` | the extension's output channel |
| Command | `General Simulator: New Schematic` | creates and opens a `.gsim_sch` |

## Architecture

```
VS Code extension host (Node)
├── GsimHost               src/host.ts        webview registry, drag broker, and the run path
│   ├── solver-path.ts                        finds the general-simulator binary
│   ├── solver-run.ts                         spawns it, streams stdout and stderr apart
│   ├── event-log.ts                          reads what the run's rules found
│   ├── result-manifest.ts                    writes the .gsim_sim_result
│   └── samples-read.ts                       serves byte ranges of the container
├── LibraryViewProvider    src/libraryView.ts WebviewView in the Activity Bar
├── SchematicEditorProvider src/schematicEditor.ts CustomEditorProvider for *.gsim_sch
└── WaveformPanel          src/waveformPanel.ts   singleton results panel

webviews (Vite bundles from apps/frontend)
├── schematic.html -> src/vscode/schematic-main.tsx
├── library.html   -> src/vscode/library-main.tsx
└── waveform.html  -> src/vscode/waveform-main.tsx
```

The frontend used to talk to a `kernel-sidecar` process over a plain
`ws://127.0.0.1:<port>` WebSocket, which the extension host spawned on
activation and whose port and token it injected as
`window.__GSIM_INIT__.kernel`. There is no such process (#162) and no socket:
everything that crosses a boundary here is `postMessage`, declared once in
`packages/webview-protocol/src/index.ts`.

## Cross-webview drag and drop

The library sidebar and the schematic canvas are two isolated webview iframes,
so the single-page HTML5 DnD in `canvas/dnd.ts` cannot carry its payload across.

VS Code has **no webview drop-MIME API** — `dropMimeTypes` / `dragMimeTypes`
exist only on `TreeDragAndDropController` (tree views) and
`DocumentDropEditProvider` (text editors); `WebviewOptions` has no such field
(verified against `@types/vscode` 1.136). What *does* still work is that
Chromium routes a native drag's `dragover` / `drop` to whichever iframe the
cursor is over — but `dataTransfer.getData()` for a custom MIME type is not
readable across that origin boundary.

So the drag is split in two:

- the **native drag carries the pointer** (which webview, at what coordinates);
- the **extension host carries the payload**: the library webview posts
  `gsim/dragStart` on `dragstart`, `GsimHost` broadcasts `gsim/dragState` to
  every other webview, and the canvas's drop handler falls back to that value
  when `getData()` returns empty or throws (`resolveDroppedBlock`).

Click-to-insert takes the same route via `gsim/insertBlock`.

## Building

```sh
pnpm --filter @gensim/frontend build   # emits apps/frontend/dist/{schematic,library,waveform}.html
pnpm --filter general-simulator build  # tsc -> apps/vscode-extension/out
```

Running from a source checkout, the extension finds the frontend at
`../frontend/dist`. For packaging (`vsce package`), copy `apps/frontend/dist`
to `apps/vscode-extension/media/frontend`; both locations are probed by
`src/webview-content.ts`.

## Testing

Two layers, both wired into CI:

```sh
pnpm --filter ./apps/vscode-extension test              # vitest — pure logic
pnpm --filter @gensim/frontend build                    # required by the next line
xvfb-run -a pnpm --filter ./apps/vscode-extension test:integration
```

`test:integration` uses `@vscode/test-electron` to download and launch a real
VS Code, load this extension via `--extensionDevelopmentPath`, and run a Mocha
suite inside the extension host (`src/integration/`). It asserts on concrete
state pulled out of the *live* webviews through `gsim/test/exec` probes, which
travel the same `postMessage` path the product uses.

`GSIM_INTEGRATION_TEST=1` (set only by the launcher) is the single switch that
turns on the test API: `activate()` returns a `GsimTestApi`, webviews are
rendered with `testMode`, and `installTestHooks()` becomes active. In a real
user's VS Code all three are inert.

**What the integration suite proves:** activation and contribution
registration; the custom editor resolving a `.gsim_sch`; the sidebar webview
resolving; the Vite bundle loading under the injected CSP; React mounting and
rendering real DOM; the catalog loading; dirty-state via
`onDidChangeCustomDocument` and `saveCustomDocument` writing bytes to disk; the
full `GsimHost` drag fan-out; the canvas drop handler inserting a block from a
genuine `DragEvent` with an empty `DataTransfer`; and a run against a real
`general-simulator` binary reaching a real result, with no interpreter on the
machine.

**What it does not prove:** the browser's own pointer hit-testing that decides
which iframe receives `dragover`/`drop` during a *physical* mouse drag between
two webviews. No VS Code extension API can synthesise an OS-level drag across
webview boundaries. That one step still needs a human.

## Security note: the webview generates no code at runtime

The webview CSP is strict throughout: `default-src 'none'`, nonce'd scripts,
loopback-only `connect-src`, **no `'unsafe-eval'`**, and schematic content is
rendered by React as data, never as markup.

Keeping `'unsafe-eval'` out is a live constraint on what the frontend bundle
may contain, not a one-off cleanup. It was allowed for one release because two
things needed it, and both have since been removed:

- **Ajv** compiled its validators with `new Function` at module top level, so
  importing `apps/frontend/src/file/schema.ts` or `library/catalog-core.ts`
  blanked the webview before React mounted. The schemas are now compiled ahead
  of time by `apps/frontend/scripts/gen-validators.mjs` into ordinary ES
  modules, checked in and drift-checked on every build.
- **Parametric expressions** were evaluated with `new Function`. They now go
  through `apps/frontend/src/params/param_expression.ts`, a lexer and
  recursive-descent parser for the grammar the format spec defines (§5.2).

A dependency that generates code at runtime — a JSON-schema compiler, a
templating engine, a charting library that compiles accessors — will make the
webview render **nothing at all**, with no error visible outside the webview
itself. The fix is to precompile or replace it. Do not re-add the directive;
`src/webview-html.test.ts` asserts it is absent, and the integration suite is
what catches a bundle that has quietly reintroduced the need for it.

## Configuration

| Setting | Default | Meaning |
| --- | --- | --- |
| `omniSchematics.generalSimulatorPath` | `""` | The `general-simulator` binary. The only setting a run reads. Empty means search: `GENSIM_GENERAL_SIMULATOR_PATH`, then `PATH`, then a sibling checkout. |
| `omniSchematics.solverTimeoutSeconds` | `600` | Abandon a run still going after this long; `0` waits indefinitely. |
| `omniSchematics.octaveCliPath` | `""` | The `octave-cli` binary, for `octfunc` / `octblock` blocks. Its directory goes to the front of the solver's `PATH`. |
| `omniSchematics.pythonPath` | `[]` | Extra directories on the solver's `PYTHONPATH`, so a `pyblock` can import your own modules. Does not choose an interpreter. |
| `omniSchematics.environment` | `{}` | Extra environment variables for the solver and everything it starts. Applied last, so it wins. |
| `omniSchematics.overrideVsCodeKeybindings` | `true` | Let the schematic's chords beat VS Code's while a schematic is focused. |

Two settings are gone (#162): `omniSchematics.kernelPython`, the Python
environment the kernel ran in, and `omniSchematics.autoStartKernel`, which
started it on activation. So are `GENSIM_KERNEL_PORT` and
`GENSIM_KERNEL_TOKEN`, which attached the editor to a kernel you had started
yourself.

Nothing is started at activation any more. The extension spawns one child
process, `general-simulator`, when you press Run.

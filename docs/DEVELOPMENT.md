# Developer guide — `general-simulator`

This guide covers day-to-day development: environment setup, running
tests, CI gates, extending the system, and the agent workflow. It is
the practical counterpart to the architecture specs in `docs/specs/`.

---

## Table of contents

1. [Environment setup](#1-environment-setup)
2. [There is no Python workspace](#2-there-is-no-python-workspace)
3. [TypeScript / Node workspace](#3-typescript--node-workspace)
4. [There is no backend to develop](#4-there-is-no-backend-to-develop)
5. [Frontend development](#5-frontend-development)
6. [Schema system](#6-schema-system)
7. [Block catalog](#7-block-catalog)
8. [Testing reference](#8-testing-reference)
9. [CI gates](#9-ci-gates)
10. [Pre-commit hooks](#10-pre-commit-hooks)
11. [There is no IPC message reference](#11-there-is-no-ipc-message-reference)
12. [Type system notes](#12-type-system-notes)
13. [Agent / AI workflow](#13-agent--ai-workflow)
14. [Debugging tips](#14-debugging-tips)
15. [Common pitfalls](#15-common-pitfalls)

---

## 1. Environment setup

### Required tools

```
Node.js ≥ 20 LTS
pnpm    = 9.12.0    (enforced by packageManager field)
Rust    stable      (crates/waveform-store, and the sibling gsim-core)
```

Python is **not** on that list, and that is the point of the milestone #162
closed. Nothing in this repository is a Python package, nothing it builds needs
an interpreter, and nothing it ships spawns one. The only Python here is
`examples/build_*.py`, the generators that author the committed example
documents with `gsim-tools`; they want **CPython ≥ 3.11** in a venv of your own
and are needed only if you change an example.

Install pnpm via corepack (already bundled with Node):

```bash
corepack enable
corepack prepare pnpm@9.12.0 --activate
```

### First-time bootstrap

```bash
git clone https://github.com/GLODI-Engineering/omni-schematics && cd omni-schematics

# Everything: all packages across the pnpm workspace
pnpm install

# Install git hooks (biome, invariants, conventional commits)
pre-commit install --install-hooks

# Playwright browser binaries
npx playwright install
```

One command, where there used to be two plus a `uv sync`. If you also want to
run an example generator:

```bash
python -m venv .venv
.venv/bin/pip install 'gsim-tools @ git+https://github.com/GLODI-Engineering/gsim-tools'
.venv/bin/pip install <path-to>/gsim_py-*.whl     # to compile in-process as well
```

`scripts/check-examples.mjs` picks that interpreter up from `.venv/` or from
`GSIM_PYTHON`, and says "generator did not run" rather than failing when there
is none.

---

## 2. There is no Python workspace

There was one, rooted at `pyproject.toml` and holding four members:
`kernel-sidecar` (the IPC server process), `simulator` (solver adapters and
post-processing), `gsim-model` (`.gsim_sym` component authoring) and the Python
half of `schemas`. All four are deleted, with the root `pyproject.toml`,
`uv.lock`, `conftest.py`, `scripts/make-kernel-venv.mjs`, `scripts/build.sh`,
`scripts/dev.sh`, `tests/backend/`, `.github/workflows/backend.yml` and
`ci.yml`'s `python` job (#162).

Where each piece went, because none of it was dropped on the floor:

| What it did | Where it is now |
|---|---|
| compiled a `.gsim_sch` to a netlist | `gsim-core`, built to WebAssembly and committed in `packages/gsim-wasm` (#158) |
| found and ran the solver | `apps/vscode-extension/src/solver-path.ts` and `solver-run.ts` (#159) |
| decimated a waveform | `crates/waveform-store`, committed as WebAssembly in `packages/waveform-wasm` (#157) |
| read the solver's rule events | `apps/vscode-extension/src/event-log.ts` |
| computed Bode margins | `apps/frontend/src/waveform/bode-margins.ts` |
| served windows of samples over HTTP | nothing: the viewer reads the `.gsim_samples` container directly (#157, #163) |
| wrote `manifest.json` + `data.h5` | the solver writes the container; the host writes the `.gsim_sim_result` beside it |
| ran a Python REPL for the Workspace tab | `gsim-tools` in a venv you own (#161) |

Scripting a schematic is still Python and is still supported. It happens in
*your* environment, with `gsim-tools`, and the README's **Scripting a
schematic** section is the reference.

---

## 3. TypeScript / Node workspace

The pnpm workspace is defined in `pnpm-workspace.yaml`. Members:

| Member | Path | Purpose |
|--------|------|---------|
| `@gensim/frontend` | `apps/frontend/` | React canvas app |
| `@gensim/schemas` | `packages/schemas/` | Schema codegen target |
| `tests/schemas` | `tests/schemas/` | Schema Vitest suite |

### Scripts

```bash
# Root-level
pnpm lint:check          # Biome check (no write)
pnpm lint                # Biome check + fix
pnpm e2e                 # Playwright E2E tests
pnpm e2e:ui              # Playwright with interactive UI

# Frontend only
pnpm --filter @gensim/frontend dev        # Vite dev server
pnpm --filter @gensim/frontend build      # Production build
pnpm --filter @gensim/frontend test       # Vitest run
pnpm --filter @gensim/frontend typecheck  # tsc --noEmit
```

### Running frontend tests directly

```bash
cd apps/frontend
npx vitest run                         # all tests
npx vitest run src/store/graph.test.ts # specific file
npx vitest run src/canvas/             # all tests under a dir
npx vitest                             # watch mode
```

---

## 4. There is no backend to develop

The module map that was here described `apps/kernel-sidecar/` and
`packages/simulator/` — a WebSocket server, an IPC dispatcher, a simulate
handler, solver adapters, an IR-1/IR-2 lowering pipeline and a result writer.
None of it exists (#162); §2 above says where each part went.

A run, end to end, with nothing between the document and the engine:

```
the webview (apps/frontend/src/shell/run.ts)
  ├─ initEngine()                      → gsim-core, as WebAssembly
  ├─ compileSchematic(engine, model)   → netlist text + the compiler's notes
  └─ postToHost({ type: "gsim/runSimulation", request })
       │
       ▼
the extension host (apps/vscode-extension/src/run-simulation.ts)
  ├─ resolveSolver()                   → the general-simulator binary
  ├─ spawn it with --format samples --events, streaming both pipes
  ├─ readEventLog()                    → what the run *found*
  └─ write .gsim_sim_result beside the .gsim_samples the solver produced
       │
       ▼
the viewer (apps/frontend/src/results/, crates/waveform-store as WebAssembly)
  └─ plan the byte ranges a window needs → the host reads them → draw
```

Three processes used to be four, and the one that left was the only
interpreter.

---

## 5. Frontend development

### Module map

```
apps/frontend/src/
├── App.tsx                  Root; registers all activities, tabs, bindings
├── store/
│   ├── graph.ts             Zustand: blocks, wires, undo stack; transact()
│   ├── graph-diff.ts        Diff computation for undo frames
│   ├── ui.ts                Zustand: selection, zoom/pan, panel visibility, sizes
│   ├── inspector.ts         Zustand: bound selection, dirty edits
│   ├── ipc.ts               Zustand: kernel status, pendingIds, last manifest
│   ├── library.ts           Zustand: catalog entries, recently used
│   └── index.ts             Aggregator (useStores())
├── canvas/
│   ├── Canvas.tsx           React Flow host; derives nodes/edges from graph store
│   ├── derive-flow-state.ts graph store → React Flow props (no mutation)
│   ├── coords.ts            toScreen() / toModel(); integer round-trip guaranteed
│   ├── keymap.ts            Binding registry; conflict guard; dispatcher
│   ├── keymap-types.ts      KeyBinding, KeyContext types
│   ├── KeymapProvider.tsx   Global keydown listener
│   ├── undo.ts              Stack clear on New/Open; redo clear on mutation
│   ├── clipboard.ts         Copy/paste/cut; UUID regeneration; interior-wire filter
│   ├── grid/
│   │   ├── GridLayer.tsx    Background grid dots; thinning at low zoom
│   │   └── grid.ts          Grid dot positions
│   ├── nodes/
│   │   ├── BlockNode.tsx    Wrapper node for React Flow
│   │   ├── BlockSymbol.tsx  Data-driven SVG renderer (rect/circle/triangle/custom)
│   │   ├── Port.tsx         Port markers; domain colors
│   │   └── port-hit-test.ts Screen-space hit box; resolves block+port from cursor
│   ├── snapping/
│   │   └── snap.ts          Snap helper: port > wire > grid priority
│   ├── selection/
│   │   ├── Selection.ts     Click/marquee/Shift-click/Ctrl+A logic
│   │   ├── MarqueeLayer.tsx Live drag highlight
│   │   ├── nudge.ts         Arrow / Shift+Arrow nudge (one transact frame)
│   │   └── drag.ts          Drag-move with snap; Esc cancel; Space axis-lock
│   ├── transforms/
│   │   ├── rotate.ts        Ctrl+R / Ctrl+Shift+R; pivot policy
│   │   ├── mirror.ts        Ctrl+I; canonical mirror×rotation form
│   │   └── composition.md   Document: transform composition rules
│   └── router/
│       ├── interactive-draw.ts  Drag from port; posture toggle; split-on-body
│       ├── preview-layer.tsx    Live 2-segment preview
│       ├── cleanup.ts           Post-move re-route (deterministic, pinned bends)
│       ├── pinning.ts           Pin/unpin/drag-waypoint
│       └── compatibility.ts     Port-kind matrix; forbidden cue
├── library/
│   ├── catalog.ts           Loads metadata.yaml files; cross-field validation
│   ├── catalog-manifest.json Build-time snapshot of the catalog
│   ├── search.ts            Fuzzy ranking: recently-used → prefix → substring
│   ├── QuickInsert.tsx      Ctrl+. palette; arrow+Enter inserts at cursor
│   ├── LibraryActivity.tsx  core.library activity; collapsible category tree
│   ├── SidebarItem.tsx      Tree item with drag-to-canvas
│   └── register.ts          Registers core.library in ActivityRegistry
├── inspector/
│   ├── Inspector.tsx        Secondary side bar; 0/1/N-selection states
│   ├── focus-main-param.ts  Alt+Enter → focuses the main_param editor
│   └── editors/
│       ├── NumberInput.tsx
│       ├── VectorInput.tsx
│       ├── Dropdown.tsx
│       └── StringInput.tsx
├── explorer/
│   ├── ExplorerActivity.tsx core.explorer; recent models from StorageAdapter
│   ├── RecentModelsList.tsx
│   └── register.ts
├── search/
│   ├── SearchActivity.tsx   core.search; live substring search in model
│   ├── find-in-model.ts     Returns up to 100 results; truncates with +N more
│   └── register.ts
├── palette/
│   ├── CommandPalette.tsx   Ctrl+. command palette; auto-populated from keymap
│   └── registry-bridge.ts  Derives palette entries from keymap registry
├── file/
│   ├── StorageAdapter.ts    Interface: list/load/save/saveAs/delete/import/export
│   ├── file-ops.ts          Command layer (Ctrl+N/O/S/Shift+S/Shift+E/W)
│   ├── serializer.ts        ModelDocument → canonical JSON bytes
│   ├── deserializer.ts      bytes → ModelDocument (schema-validated)
│   ├── autosave.ts          Debounced 500ms auto-save on every transact()
│   ├── export.ts            Synthetic <a download> for Export
│   ├── import.ts            <input type=file> for Import
│   ├── round-trip.test.ts   Property: 200 random models serialize idempotently
│   ├── test-fixtures/
│   │   └── generators.ts    Random ModelDocument generator (fast-check)
│   └── adapters/
│       ├── IndexedDbAdapter.ts IndexedDB, for the webview's own secondary state
│       ├── idb-schema.ts       Object-store schema + version migrations
│       └── select-adapter.ts   Returns the one adapter there is; see its own doc comment
├── ipc/                    (the socket client, the binary frame decoder, the
│   │                        transport and the stub kernel are gone -- #162)
│   ├── types.ts             What a run says about its signals
│   ├── vscode-host.ts       postMessage to the extension host, and the init payload
│   ├── vscode-protocol.ts   The host-bound half of @gensim/webview-protocol
│   └── vscode-theme.ts      Follows VS Code's own theme variables
├── waveform/
│   ├── WaveformTab.tsx      uPlot host; auto-opens when a run finishes
│   ├── SignalLegend.tsx     Trace legend; toggle visibility
│   ├── cursor.ts            Crosshair cursor; instantaneous value readout
│   ├── decimator.ts         crates/waveform-store in WebAssembly: the one decimator
│   └── register.ts          Registers core.waveform in BottomTabRegistry
├── output/
│   ├── OutputTab.tsx        The run's own output, as the store received it
│   ├── LogView.tsx          Virtualized log; auto-scroll; per-stream filter
│   └── register.ts          Registers core.output in BottomTabRegistry
├── problems/
│   ├── ProblemsView.tsx     Shared view used in both Activity and BottomTab
│   ├── problems-store.ts    Issues list; hasErrors; badge count
│   └── register.ts          Registers core.problems × 2 (Activity + BottomTab)
└── shell/
    ├── TopBar.tsx
    ├── ActivityBar.tsx       Left icon column; active = left-edge accent
    ├── PrimarySideBar.tsx    Renders active activity component
    ├── SecondarySideBar.tsx  Inspector slot
    ├── BottomPanel.tsx       Tab strip + tab content
    ├── StatusBar.tsx         Kernel dot, zoom, validation count, cursor coords
    ├── StartupModal.tsx      Recent-models picker on web launch
    ├── RunButton.tsx         Ctrl+T; idle/busy/error states
    ├── run.ts                Simulate flow: validate → IPC → waveform
    ├── registries/
    │   ├── ActivityRegistry.ts  register(); conflict guard; ordering
    │   └── BottomTabRegistry.ts Same pattern
    └── layout.css
```

### State management

All canvas state flows through Zustand stores. React Flow is used
only as a rendering host — its internal state is never mutated
directly. The derivation path is:

```
graph store (blocks + wires)
  ↓  derive-flow-state.ts
React Flow nodes + edges props
  ↓  rendered by React Flow
SVG canvas
```

User interactions from React Flow (drag, zoom, pan) are mapped to
graph-store mutations or UI-store updates — never to React Flow's
own `setNodes` / `setEdges`.

### Undo / redo

All mutations are wrapped in `transact(name, fn)`:

```typescript
transact("move blocks", () => {
  moveBlocks(selectedIds, delta);
});
```

`transact` snapshots the affected slices before and after, pushes
a `{name, before, after}` frame to the undo stack, and clears the
redo stack. `undo()` / `redo()` replay diff frames.

One mutation = one undo frame. Nudge, drag-move, and parameter edits
each produce exactly one frame regardless of how many sub-operations
they involve.

### Keymap contexts

Bindings are context-sensitive. Active contexts are resolved from
current UI state at dispatch time:

| Context | When active |
|---------|------------|
| `global` | Always |
| `canvas` | Canvas is focused, no modal open |
| `selection` | Canvas + non-empty selection |
| `drawing-wire` | Wire draw in progress |
| `in-place-edit` | Text input focused inside canvas |
| `modal` | Any modal open |

The `/` posture-toggle binding only fires in `drawing-wire` — it
does not interfere with browser Find or other slash behaviors in
other contexts.

---

## 6. Schema system

### Sources

All schemas live in `packages/schemas/definitions/`:

```
definitions/
├── model/
│   ├── gsim.schema.json          .gsim model file format
│   ├── port-kind.schema.json     PortKind domain definitions
│   └── README.md
└── blocks/
    ├── block-metadata.schema.json  Catalog entry format
    └── README.md
```

### Constraints enforced by schema

**gsim.schema.json:**
- `Block.position`: array of exactly 2 integers (no floats)
- `Block.rotation`: enum [0, 90, 180, 270]
- `Block.mirror`: enum ["none", "x", "y"]
- `Wire.waypoints`: even-length array of integer pairs
- `ModelDocument.schema_version`: const 1
- `additionalProperties: false` throughout

**block-metadata.schema.json:**
- `name`: kebab-case pattern
- `behavior.state_count`: integer or "dynamic"
- `behavior.domain`: enum [control, signal, electrical, …]
- Ports reference port-kind via `$ref`

### Cross-field validation (enforced by loader, not schema)

The `catalog.ts` loader and `gsim_loader.py` enforce constraints
that JSON Schema cannot express:

- `default` must match the declared param `type`
- `main_param` must name an existing param
- `variadic_inputs.count_from` must name a param of compatible type
- `behavior.equation_template` must follow `<category>.<name>` pattern

### Regenerating generated types (FE-02, planned)

```bash
pnpm -F @gensim/schemas codegen
```

This regenerates `packages/schemas/generated/typescript/` and
`packages/schemas/generated/python/`. The CI drift check will fail
if the generated files are not committed after a schema change.

---

## 7. Block catalog

### Directory structure

```
packages/blocks/src/blocks/
├── signal/
│   ├── constant/
│   │   ├── metadata.yaml
│   │   └── equations.py
│   └── step/
│       ├── metadata.yaml
│       └── equations.py
└── control/
    ├── gain/
    ├── sum/
    ├── integrator/
    ├── derivative/
    ├── pid/
    ├── transfer_function/
    ├── saturation/
    └── sinks/
        └── scope/
```

### The `BlockEquations` protocol

```python
class BlockEquations(Protocol):
    def state_vars(self, params: dict[str, Any]) -> list[str]: ...
    def derivatives(
        self,
        t: float,
        state: dict[str, float],
        inputs: dict[str, float],
        params: dict[str, Any],
    ) -> dict[str, float]: ...
    def output(
        self,
        t: float,
        state: dict[str, float],
        inputs: dict[str, float],
        params: dict[str, Any],
    ) -> dict[str, float]: ...
```

`state_vars()` returns the names of the state variables; the count
must match `metadata.yaml`'s `behavior.state_count` (or the template
must be declared `dynamic`).

`derivatives()` is a pure function — no I/O, no module-level mutable
state. The simulator calls it inside `solve_ivp`'s `f(t, x)`.

### Adding a block

Use the `/new-block` skill. If hand-rolling:

1. Create the directory under `packages/blocks/src/blocks/<cat>/<name>/`.
2. Write `metadata.yaml` — validate against the block-metadata schema.
3. Write `equations.py` — implement `state_vars()`, `derivatives()`, `output()`.
4. Add tests to `packages/blocks/tests/test_equations.py`.
5. Register in the frontend catalog (currently in
   `apps/frontend/src/library/catalog-manifest.json` and
   `apps/frontend/scripts/build-catalog-manifest.ts`).

The `TemplateLoader` (BE-10) auto-discovers `equations.py` files at
runtime — no registration needed on the Python side.

---

## 8. Testing reference

### Backend tests

There are none, and there is no backend: the table that was here covered 150-odd
tests over `apps/kernel-sidecar/` and `packages/simulator/`, deleted with them
(#162). `tests/backend/e2e/` went too, and #202 is why it is not missed — its
two end-to-end tests had never once run in CI, because the job skipped them for
want of a solver binary and reported a tick. What replaced them is a real VS
Code driven by `@vscode/test-electron`, with a pinned solver release
downloaded for it and a grep over its own log so a skipped suite fails the job.

---

### Frontend tests (Vitest)

| File | Epic | Tests |
|------|------|-------|
| `store/graph.test.ts` | FE-03 | 9 |
| `store/ui.test.ts` | FE-04 | 7 |
| `store/inspector.test.ts` | FE-04 | 5 |
| `store/ipc.test.ts` | FE-04 | 7 |
| `store/library.test.ts` | FE-04 | 4 |
| `shell/shell.test.tsx` | FE-05 | 2 |
| `shell/registries/ActivityRegistry.test.ts` | FE-05 | 3 |
| `shell/registries/BottomTabRegistry.test.ts` | FE-05 | 3 |
| `canvas/keymap.test.ts` | FE-06 | 15 |
| `canvas/KeymapProvider.test.tsx` | FE-06 | 1 |
| `canvas/Canvas.test.tsx` | FE-08 | 2 |
| `canvas/grid/grid.test.ts` | FE-09 | 2 |
| `canvas/coords.test.ts` | FE-09 | 4 |
| `canvas/snapping/snap.test.ts` | FE-10 | 6 |
| `canvas/nodes/BlockSymbol.test.tsx` | FE-11 | 14 |
| `canvas/nodes/port-hit-test.test.ts` | FE-12 | 2 |
| `canvas/selection/Selection.test.tsx` | FE-13 | 3 |
| `canvas/selection/nudge.test.ts` | FE-14 | 5 |
| `canvas/selection/drag.test.tsx` | FE-15 | 3 |
| `canvas/transforms/rotate.test.ts` | FE-16 | 5 |
| `canvas/transforms/mirror.test.ts` | FE-16 | 3 |
| `canvas/clipboard.test.ts` | FE-17 | 4 |
| `canvas/undo.test.ts` | FE-18 | 2 |
| `canvas/router/interactive-draw.test.tsx` | FE-19 | 4 |
| `canvas/router/cleanup.test.ts` | FE-20 | 3 |
| `canvas/router/pinning.test.tsx` | FE-21 | 2 |
| `canvas/router/compatibility.test.ts` | FE-22 | 6 |
| `library/catalog.test.ts` | FE-23 | 6 |
| `library/QuickInsert.test.tsx` | FE-24 | 2 |
| `library/search.test.ts` | FE-24 | 4 |
| `library/LibraryActivity.test.tsx` | FE-25 | 2 |
| `explorer/ExplorerActivity.test.tsx` | FE-25b | 2 |
| `search/find-in-model.test.ts` | FE-25b | 4 |
| `search/SearchActivity.test.tsx` | FE-25b | 1 |
| `inspector/Inspector.test.tsx` | FE-26 | 2 |
| `inspector/focus-main-param.test.tsx` | FE-27 | 3 |
| `palette/CommandPalette.test.tsx` | FE-28 | 2 |
| `file/serializer.test.ts` | FE-29 | 3 |
| `file/deserializer.test.ts` | FE-29 | 3 |
| `file/file-ops.test.ts` | FE-29 | 2 |
| `file/adapters/IndexedDbAdapter.test.ts` | FE-29b | 4 |
| `file/autosave.test.ts` | FE-29b | 1 |
| `shell/StartupModal.test.tsx` | FE-29b | 1 |
| `file/export.test.ts` | FE-29b | 3 |
| `file/import.test.ts` | FE-29b | 1 |
| `file/round-trip.test.ts` | FE-30 | 2 |
| `waveform/WaveformTab.test.tsx` | FE-35 | 2 |
| `output/register.test.tsx` | #170 | 3 |
| `results/samples-source.test.ts` | #157 | 7 |
| `shell/run.test.tsx` | FE-37 | 7 |
| `shell/run-host.test.ts` | #159 | 6 |
| `problems/run-events.test.ts` | #159 | 8 |
| `waveform/populate.test.ts` | #159 | 7 |
| `shell/StatusBar.test.tsx` | FE-38 | 6 |
| `problems/ProblemsView.test.tsx` | FE-39 | 5 |
| `problems/problems-store.test.ts` | FE-39 | 4 |
| `ipc/error-map.test.ts` | FE-39 | 5 |

### Schema tests (Vitest in `tests/schemas/`)

| File | Tests | What it covers |
|------|-------|----------------|
| `test_gsim_schema.ts` | 15 | Valid/invalid .gsim fixtures; float-position rejection |
| `test_block_metadata_schema.ts` | 12 | Metadata fixtures; custom shape; state_count dynamic |
| `test_port_kind_schema.ts` | 15 | All 5 domains; 3 signal dims variants |
| `test_codegen_drift.ts` | — | Regenerates to tmpdir, diffs; planned (FE-02) |

### Playwright E2E (`tests/e2e/`)

| Spec | Scenarios | Browsers |
|------|-----------|---------|
| `smoke.spec.ts` | Quick Insert 3 blocks → wire → Ctrl+T → uPlot shows data | Chromium, Firefox, WebKit |
| `undo-redo.spec.ts` | Build model → undo to empty → redo to final; byte-equivalent | All 3 |
| `persistence.spec.ts` | Save → reload → StartupModal → open → byte-equivalent | All 3 |
| `perf.spec.ts` | canvas p95 ≤16ms; Quick Insert ≤50ms; save ≤100ms | Chromium |

#### The `gs-ui-probe` dependency

The specs drive the UI through [`gs-ui-probe`](https://github.com/GLODI-Engineering/gs-ui-probe),
which lives in its own repository so that it stays free of any knowledge of
this application. `package.json` pins it to a tag:

```json
"gs-ui-probe": "github:GLODI-Engineering/gs-ui-probe#v0.2.2"
```

It is public, so CI needs no credentials for it.

The `github:` shorthand rather than a `git+https://` URL on purpose: pnpm
resolves the shorthand to a codeload tarball over plain HTTPS, while the git
form makes it record whatever URL *your* git is configured to use — on a
machine with SSH keys that is `git@github.com:…`, which then fails on a runner
that has no key, for a public repository. The shorthand cannot pick up a
machine-specific URL.

**Locally**, a pinned tag means you get the released probe, not your working
copy. To edit the probe and see the change here without cutting a tag:

```bash
pnpm link ../gs-ui-probe      # live edits
pnpm install                  # back to the pinned tag
```

**To release a probe change**: `pnpm build` first — `dist/` is committed there,
because the package is consumed from git rather than a registry, so the build
output *is* the release. Then commit, tag, push, and bump the tag here. The tag
is what makes an e2e run reproducible.

---

## 9. CI gates

The full gate set (enforced by pre-commit and `.github/workflows/`):

```
┌─ TypeScript ──────────────────────────────────────────┐
│  pnpm lint:check               Biome lint             │
│  cd apps/frontend              typecheck              │
│    npx tsc --noEmit                                   │
│  cd apps/frontend              unit tests             │
│    npx vitest run                                     │
│  cd tests/schemas              schema tests           │
│    pnpm vitest run                                    │
└───────────────────────────────────────────────────────┘
┌─ E2E ─────────────────────────────────────────────────┐
│  npx playwright test           the webview app        │
│  xvfb-run pnpm --filter        the extension, in a    │
│    ./apps/vscode-extension     real VS Code (CI only) │
│    test:integration                                   │
└───────────────────────────────────────────────────────┘
┌─ Invariants ──────────────────────────────────────────┐
│  ./scripts/check-invariants.sh Epetra, async, smooth  │
│  check-keymap.mjs              keymap drift           │
│  codegen:check                 schema codegen drift   │
│  gen-keybindings.mjs --check   keybinding drift       │
│  check-gsim-wasm-fresh.mjs     the committed engine    │
│  check-waveform-wasm-fresh.mjs the committed decimator │
│  check-examples.mjs --check    every example compiles  │
└───────────────────────────────────────────────────────┘
```

There is no Python box. There was one — `ruff`, `mypy` and `pytest` over
`apps/` and `packages/` — and it went with the packages it checked (#162).
`release.yml` carries one more gate than `ci.yml` does: every example compiled
through the committed WebAssembly engine **with no interpreter reachable from
the step at all**, which is the successor to the nine-wheel compile gate that
0.7.0 shipped without.

An epic reaches `complete` status only when **all** gates are green
for its touched code. The `progress.*.yaml` files track status.

---

## 10. Pre-commit hooks

`.pre-commit-config.yaml` configures hooks that run on every `git commit`:

| Hook | What it checks |
|------|----------------|
| `biome-check` | TS / JS / JSON lint + format |
| `cargo-fmt` | `crates/waveform-store` formatting |
| `check-invariants` | Architectural invariants (see AGENTS.md §2) |
| `gotchas-index` | `docs/gotchas/INDEX.md` is regenerated |
| `commit-msg` | Conventional Commits format |

`ruff` and `mypy` were two more, over Python that no longer exists (#162).

**Never bypass with `--no-verify`.** If a hook fails, fix the root
cause. The hook caught a real problem.

---

## 11. There is no IPC message reference

The table that was here listed a WebSocket protocol — `handshake`, `simulate`,
`simulate_cancel` out; `kernel_status`, `simulate_progress`, `simulate_result`,
`waveform_chunk`, `waveform_done` back — spoken to a Python process over a
token-gated socket on `127.0.0.1`. There is no such process and no such socket
(#162).

What crosses a boundary now is `postMessage` between a webview and the
extension host, and it is declared in exactly one place:
**`packages/webview-protocol/src/index.ts`**. Both sides import that file, so
the union *is* the reference and cannot drift from it;
`apps/vscode-extension/src/protocol.test.ts` asserts the extension's
types-only re-export still agrees with the package.

---

## 12. Type system notes

### Python (mypy)

Gone with the Python (#162). `mypy`'s configuration lived in the root
`pyproject.toml`, which is deleted; the example generators under `examples/`
are the only Python left and are not type-checked by any gate.

**Known patterns:**

`ctypes.pythonapi` returns `Any` by default. Wrap the return in
`int(...)` to satisfy `→ int` return annotations:

```python
return int(ctypes.pythonapi.PyThreadState_SetAsyncExc(
    ctypes.c_ulong(thread_id),
    ctypes.py_object(exc_type),
))
```

`json.load(f)` returns `Any`. Use an explicit local annotation to
satisfy `no-any-return`:

```python
result: dict[str, Any] = json.load(f)
return result
```

`dict[str, Any].get(key)` returns `Any | None`. After a `None`
guard, mypy narrows to `Any`, but only if the guard is in the same
function scope. In background tasks that re-fetch from payload, add
the guard locally.

### TypeScript (tsc + Biome)

Config is `apps/frontend/tsconfig.json`. Biome config is `biome.json`.
Biome warnings (lint suggestions) do not fail CI — only errors do.

---

## 13. Agent / AI workflow

### Reading order (first time on this repo)

1. `AGENTS.md` — invariants + skill index
2. `docs/agent-rules/architecture-invariants.md` — the invariants with their
   reasoning and the script that checks each one
3. `docs/articles/simulating-an-llc-converter.md` — the product as it actually
   behaves, end to end
4. `gsim-core`'s own documentation for anything about what a schematic *is* or
   what it compiles to: this repository draws and sends, it does not decide

### Recurring workflows

| Task | Command / Skill | Notes |
|------|----------------|-------|
| Run tests + update progress | `/test-and-progress` | Reads progress file, runs tests, updates status |
| Add a block | `/new-block` | Scaffolds directory, YAML, equations.py, tests |
| Draft commit | `/commit` | Reads diff; follows Conventional Commits |
| Fix type errors | Read mypy output; fix root causes; never add stale `# type: ignore` |

### Two-agent model

Each epic has separate `implementation.owner` (coder-agent) and
`tests.owner` (tester-agent) tracks. The tester-agent:

- Runs tests, records results in progress YAML
- Does NOT fix implementation code — only writes the `blocked:` note
- Can mark `complete` only when all CI gates pass

### Progress file conventions

```yaml
status: review      # tests pass locally
status: blocked     # tests fail or environment is broken
status: complete    # tests pass AND all CI gates pass
```

A `blocked:` note must be actionable: exact file, line, error
message, counts. A `review:` note must record the date and test
counts.

---

## 14. Debugging tips

### Watching what a run did

Everything a run says is in VS Code's Output panel, in two channels: **General
Simulator** for the extension's own lifecycle (what it resolved, what it
spawned, what it refused) and the run channel for the solver's own stdout and
stderr, kept apart and labelled. `Omni Schematics: Show Log` opens the first.

The exact command line is printed before every run, so a failure can be
reproduced by pasting it into a terminal — which is the fastest way to tell an
editor problem from an engine one.

### Testing one message by hand

The snippet that was here opened a WebSocket to `127.0.0.1`, sent a
`handshake` and then a `simulate`, and printed the frames that came back. There
is no socket and no server (#162).

The equivalent is two steps, each runnable on its own, which is most of the
reason the path was moved:

```bash
# 1. the compile, with no editor: the committed WebAssembly engine, five examples
node scripts/check-examples.mjs

# 2. the run, with no editor: exactly what the host spawns
general-simulator netlist.cir --mode transient --tfinal 2m --dt 20n \
  --format samples --out run.gsim_samples --events events.jsonl
```

Step 2's argument list is `solver-run.ts`'s `transientArgs`, and the host
prints it verbatim before every run.

### Frontend stub mode

```bash
pnpm --filter @gensim/frontend dev
```

The dev server needs nothing running beside it. `VITE_IPC_TRANSPORT=stub`
used to select a stub kernel that answered with canned data, which was how
UI-only work avoided starting a Python process; there is no process to avoid
(#162), and the browser harness simply has no run path — pressing Run outside
VS Code reports that there is no host to run on.

### Running a single Playwright test

```bash
npx playwright test tests/e2e/smoke.spec.ts --project=chromium --headed
```

Add `--debug` for Playwright inspector.

---

## 15. Common pitfalls

| Pitfall | Symptom | Fix |
|---------|---------|-----|
| Float coordinate in model | Serialiser throws `TypeError` | Use `Math.round()` before writing position |
| Mutating React Flow state directly | Canvas desyncs from graph store silently | Always go through graph-store mutations |
| Adding `type: ignore` for `import-untyped` with `--ignore-missing-imports` | Immediate "unused type: ignore" mypy error | The flag already silences import errors; remove the comment |
| `json.load()` as `→ dict` | `no-any-return` error | Assign to explicit `result: dict[str, Any]` first |
| Missing None guard after `payload.get(key)` in a background task | `Any | None` passed where concrete type expected | Add a local None guard even if the outer function checked it |
| `pnpm vitest run` vs `npx vitest run` | `pnpm vitest` goes through `pnpm exec` → same thing; `npx vitest` works directly | Both work; `npx` is in the project allowlist |
| Renaming a block type identifier | All saved `.gsim` files are silently broken | Treat block `type` strings as a public, append-only API |
| Adding a chord without updating `keyboard-map.md` | FE-07 drift check fails CI | Edit markdown first, then code |

# Omni Schematics

Schematic capture, component authoring and circuit/system simulation, inside
VS Code.

You draw a schematic in a VS Code tab, press Run, and read the waveforms in a
panel beside your code.

The engine it runs is
[`general-simulator`](https://github.com/GLODI-Engineering/general-simulator)
— a Rust simulator for power electronics and mixed circuit/block-diagram
systems, with no user interface of its own. **That is what Omni Schematics
runs, not what it is.** The editor is named apart from its engine on purpose.
What it asks of a backend is narrow — compile this sheet, run this netlist,
and say which components you can compile — and the engine answers that last
question itself rather than being described by a table kept here. Driving a
second engine would be real work rather than a configuration flag; the name is
there so that on the day it happens, nothing has to be renamed.

> **Status: pre-release.** The extension is not yet on the Marketplace. See
> [Roadmap](#roadmap) for what is still missing.

---

## Why in VS Code

Power-electronics models are not only schematics. A converter model carries
control code, measurement scripts, generated netlists, device datasheets and
notes. In a standalone CAD tool those live somewhere else; here they are
files in the same workspace, under the same version control, with the same
editor and the same language servers.

So the schematic is a VS Code custom editor for `*.gsim_sch`, the block
library is a view in the Activity Bar, waveforms are a panel, and the solver
is a child process the extension spawns when you press Run.

## What it does today

| Capability | Where |
| --- | --- |
| Schematic editor for `*.gsim_sch` — select / wire / label / annotate / pan tools, orthogonal auto-routing with obstacle avoidance, rotation, mirroring, undo | `apps/frontend/src/canvas/` |
| Block library (287 entries) with symbol previews and a per-simulator filter | `apps/frontend/src/library/` |
| Symbol editor — draw a custom component from primitives, place its ports, save it to the library | `apps/frontend/src/symbol-editor/` |
| Parameter inspector, including Level-1 device models taken from ngspice 46's own model set and a raw `.MODEL` fallback for BSIM/PSP/HICUM-class compact models | `apps/frontend/src/inspector/` |
| Waveform viewer — multi-axes figures, cursors, per-signal colour, decimation, PDF export | `apps/frontend/src/waveform/` |
| Compiling a sheet to a netlist — `gsim-core` itself, built to WebAssembly, in the webview | `apps/frontend/src/engine/`, `packages/gsim-wasm/` |
| Reading a run's samples — one decimator, in Rust, built to WebAssembly, called by the viewer | `crates/waveform-store/`, `packages/waveform-wasm/` |
| Hierarchy: subsystems, `.SUBCKT` definitions and instances, Goto/From routing | `apps/frontend/src/canvas/` |

Signal-flow and physical-electrical blocks coexist in one sheet: a control
loop can drive a converter leg in the same document.

## Architecture

```
VS Code extension host (Node)
├── GsimHost                webview registry, drag broker, and the run path
│   ├── solver-path.ts      finds the general-simulator binary
│   ├── solver-run.ts       spawns it, streams stdout and stderr apart
│   ├── event-log.ts        reads what the run's rules found
│   └── result-manifest.ts  writes the .gsim_sim_result beside the container
├── LibraryViewProvider     WebviewView in the Activity Bar
├── SchematicEditorProvider CustomEditorProvider for *.gsim_sch
└── WaveformPanel           singleton results panel

webviews (Vite bundles from apps/frontend)
├── schematic.html   the canvas, inspector and symbol editor
├── library.html     the block library
└── waveform.html    the results viewer
    └── gsim-core as WebAssembly   compiles the sheet to a netlist

general-simulator (a binary) solves the netlist, writes a .gsim_samples container
    └── crates/waveform-store as WebAssembly   reads windows of it back
```

**Two processes, and neither is an interpreter.** There used to be a third: a
Python kernel sidecar the extension spawned on activation and a run was sent
to. It is deleted (#162), with the seven packages a user had to install to
build its environment.

### Run needs no Python

Pressing Run compiles the sheet in the webview, posts the netlist text to the
extension host, and the host runs `general-simulator --format samples --events`
on it and writes the result document beside the container the solver produced
(#159). The netlist travels one way, already compiled, as a string: nothing is
passed back into the webview to ask what a block means.

What that replaced was 794 lines of Python whose whole job was to find that same
binary, start it, read what it printed and time it out — reached by starting an
interpreter, handing it a path and having it look. The extension was already
doing exactly that for the kernel process itself, one level up; that kernel is
gone too (#162).

`omniSchematics.generalSimulatorPath` is therefore the only setting a run reads,
and it is read on the first Run of a session. The solver's stdout and stderr
reach VS Code's own Output panel as separate, labelled streams while the run is
going (#139).

And a completed run plots itself (#157): the solver's `.gsim_samples` container
is read by `crates/waveform-store`, built to WebAssembly, which works out which
byte ranges a window needs and reduces them to what the chart can show. The run
also writes a complete, self-describing `.gsim_sim_result` beside it, which has
its own read-only editor.

### The compiler is in the editor

`gsim-core` is the engine: one Rust implementation of what a document means,
what each block compiles to, and what netlist comes out. The editor used to
post the whole document to a Python kernel and let it compile there — through
roughly 1,600 lines that reimplemented the engine's expression evaluator,
Goto/From resolution, subcircuit flattening and document I/O in a second
language. The two drifted twice that anyone noticed, and each time the symptom
was a sheet that looked correct in the palette and would not compile.

The engine's own `crates/gsim-wasm` is built to WebAssembly and committed in
[`packages/gsim-wasm`](./packages/gsim-wasm), so the editor compiles with the
engine and the extension host is handed netlist text.
`scripts/check-gsim-wasm-fresh.mjs` keeps the committed bundle honest, and
`examples/expected-netlists/` holds every example to the netlist it compiled to
before the change — byte for byte.

The host does **not** hold a second copy of the engine, and that is a decision
rather than an omission ([#175](https://github.com/GLODI-Engineering/omni-schematics/issues/175)):
`vsce package --no-dependencies` ships no `node_modules`, so a value import of
`@gensim/gsim-wasm/node` from the host would resolve on a developer's machine
and throw `Cannot find module` on everyone else's, with no build, test or
typecheck here catching it. The engine runs where it is already loaded, and the
host does what a webview cannot: resolve a binary, spawn it, read and write
files, own an Output channel.

### The decimator is in the viewer, and the bytes come from the host

A run writes a `.gsim_samples` container: signal-major, fixed-stride, with a
min/max pyramid over it, so a window of any run is a small read whatever the
run's length. Drawing one needs two things that live on opposite sides of the
webview boundary — WebAssembly, which only the webview can run, and a file,
which only the extension host can open.

So the webview plans and the host fetches. `crates/waveform-store`, committed
as WebAssembly in [`packages/waveform-wasm`](./packages/waveform-wasm), works
out which byte ranges a window needs from the stripe directory alone; the
webview asks for them over `gsim/readSamples`; the host answers with exactly
those bytes; the same crate reduces them to what the plot can show. No sample
value takes part in deciding which bytes to read, which is what lets the
reader ask twice — once recording, once for real — and get the same answer.

That is also the only decimator left. There were three — a Rust crate imported
by nothing, a hand-maintained TypeScript copy of it in the viewer, and two
Python implementations behind a slice server — and a trace could change shape
depending on which one drew it
([#157](https://github.com/GLODI-Engineering/omni-schematics/issues/157)).
`scripts/check-waveform-wasm-fresh.mjs` holds the committed bundle to the
crate's own sources, and the frontend's whole test suite runs its reduction
assertions through that bundle.

The same packaging constraint as above decides the split: the host cannot load
the decimator either, because `vsce package --no-dependencies` ships no
`node_modules`. It reads bytes at offsets and does no arithmetic of its own.

### One host, on purpose

This editor previously tried to be a web app, a Tauri desktop app and a VS
Code extension from one codebase. It is now only an extension — see
[`AGENTS.md`](./AGENTS.md) invariant 0. The browser entry point that remains
(`apps/frontend/index.html`) is a development and Playwright harness, not a
shipped surface, and is excluded from the `.vsix`.

## Install and try it

```sh
pnpm install
pnpm package               # builds the webviews + extension, writes omni-schematics.vsix
code --install-extension omni-schematics.vsix
```

### Installing the `.vsix` on a machine you do not develop on

The `.vsix` is the editor. It carries no engine, so on a fresh machine give it
one — and since #159 that is the only setting a simulation reads:

```jsonc
// settings.json
"omniSchematics.generalSimulatorPath": "/path/to/general-simulator"
```

That is enough to **open, edit and run**. With it empty the extension looks on
`PATH`, in `GENSIM_GENERAL_SIMULATOR_PATH` and in a sibling `general-simulator`
checkout, and a Run click that finds nothing names every place it looked and
how to get a binary.

The quickest way to get one is a
[release build](https://github.com/GLODI-Engineering/general-simulator/releases).
Building from source needs `general-simulator` **and** the three repositories
its workspace depends on by path — `gs-waveform-measurements`, `general-mna`
and `spice-lsp` — cloned next to each other; with only the first, `cargo build`
stops at `failed to load manifest for dependency` before compiling anything.

**There is nothing else to install.** No Python, no wheels, no virtual
environment, no `omniSchematics.kernelPython`. The editor used to need a
simulation kernel — a Python process the extension spawned, built from seven
packages a user downloaded from the release and `pip install`ed into a venv of
their own — and that whole arrangement is deleted (#162): the editor compiles
with `gsim-core` in WebAssembly (#158), the extension spawns the solver itself
(#159), and the viewer reads the container the solver wrote (#157).

So the install is: the `.vsix`, and a path to a solver binary. A machine with
no Python on it at all opens every example, runs one, and gets a waveform.

Scripting a schematic is still Python, and still supported — in an environment
you own rather than one the editor dictates. See
[Scripting a schematic](#scripting-a-schematic).

### The example schematics

Five textbook converters ship inside the `.vsix`. **Omni Schematics: Open
Example Schematic…** in the command palette opens a copy of one into your
workspace — a copy, so that editing it cannot damage the installation and your
changes survive the next update.

| example | what it is | in | out |
| --- | --- | --- | --- |
| `buck_converter` | switch, freewheel diode, LC filter | 48 V | ~19 V at 40 % duty |
| `boost_converter` | inductor on the input, diode to the output | 12 V | ~24 V at 50 % duty |
| `pfc_boost` | full-bridge rectifier feeding a boost stage | 230 V RMS, 50 Hz | 400 V bus |
| `llc_converter` | half bridge, series `Lr`/`Cr`, parallel `Lm`, transformer, secondary bridge | 400 V | ~48 V |
| `psfb_converter` | four switches, transformer, output `LC` filter | 400 V | ~48 V |

All five switch at 100 kHz and run **open loop**: the gate drives are fixed
pulse trains, not a regulator. They are here to show the topology and to give
you something that runs on the first click, not to serve as reference designs.

`scripts/check-examples.mjs --check` holds them to that, in CI. For each one it
asserts the document parses, every block type is a canonical name the engine
declares and can compile, the editor's own loader accepts it, it still matches
the `build_*.py` script that generated it — and that it compiles **to the
netlist in `examples/expected-netlists/`, byte for byte**, through the same
WebAssembly engine the editor uses. Those expectations were captured from the
Python compiler before #158 replaced it, so "the same netlist as before" is
checked rather than claimed.

### Working on this repository

Then **open this repository as your VS Code workspace folder** and open
`examples/buck_converter.gsim_sch`. It opens in the schematic editor, with
the block library in the Activity Bar.

Working on this repo needs exactly what a user needs, and there is no developer
shortcut — a shortcut is how the user-facing path stays broken without anyone
noticing. What a user needs is a solver binary. There used to be a second step
here, `node scripts/make-kernel-venv.mjs`, building the Python environment the
kernel ran in; both the script and the kernel are gone (#162).

`Omni Schematics: Show Log` in the command palette shows exactly what was
spawned, which is the first place to look when a run does nothing.

The engine binary is not bundled. Point the extension at your own build with
`omniSchematics.generalSimulatorPath`, or set `GENSIM_GENERAL_SIMULATOR_PATH`
in the environment the extension inherits. Nothing else needs a path: the
engine is the only simulator this editor runs.

### Developing on it

<kbd>F5</kbd> launches an Extension Development Host against the checkout.
For canvas work the browser harness is far faster, since it has HMR and can
be driven by Playwright:

```sh
pnpm dev:webviews          # http://localhost:5173
```

## Scripting a schematic

The editor is for drawing, running and reading. To **build or measure a
schematic programmatically** — sweep a parameter, generate a family of sheets,
assert a measurement in a test — you do it in a Python environment you own,
with [`gsim-tools`](https://github.com/GLODI-Engineering/gsim-tools):

```sh
python -m venv .venv
.venv/bin/pip install 'gsim-tools @ git+https://github.com/GLODI-Engineering/gsim-tools'
.venv/bin/pip install <path-to>/gsim_py-*.whl     # only needed to build or compile a schematic
export GSIM_SIMULATOR=<general-simulator>/target/release/general-simulator
```

`gsim_tools.schematic` builds and compiles documents, `gsim_tools.results` runs
the engine and reads what comes back, and `gsim_tools.measure` is a Python port
of the same measurement crate the engine's own `kind=measure` blocks use —
cross-validated against it, so a number you compute here and a number the
engine reports agree.

A whole run, against a sheet the editor saved:

```python
from gsim_tools import measure, results
from gsim_tools.schematic import Schematic

# The .gsim_sch the editor saved. compile() is the same compiler the editor
# shows you in its Netlist tab, because both call gsim-core.
sheet = Schematic.load("examples/buck_converter.gsim_sch")
run = results.run_netlist_text(sheet.compile(), mode="transient", tfinal=5e-3, dt=1e-7)

# Steady state only: this buck's output LC rings for about 2.2 ms after startup.
steady = measure.Window(from_=3e-3)
v_out = run.trace.samples("V(n_cout_p)")
gate = run.trace.samples("gate")

print(f"V_out  {measure.mean(v_out, steady):.2f} V")
print(f"ripple {measure.peak_to_peak(v_out, steady) * 1e3:.0f} mV")
print(f"duty   {measure.duty_cycle(gate, steady, on=2.5, off=2.5) * 100:.0f} %")
print(f"f_sw   {measure.freq(gate, steady, on=2.5, off=2.5) / 1e3:.0f} kHz")
```

```
V_out  18.85 V
ripple 375 mV
duty   41 %
f_sw   100 kHz
```

`run.trace.names` lists what a run produced. Nets are named after an endpoint
unless you name them, so `connect(..., net="out")` in a generator is what makes
`V(out)` exist instead of `V(n_cout_p)`.

Building a sheet from scratch rather than loading one is the same library:
`examples/build_buck_converter.py` is a complete, CI-checked example of it, and
every example schematic in this repository is generated that way.

### Why not in the editor

Until #161 the Python kernel ran a REPL for a **Workspace** bottom tab: a
persistent namespace with `numpy`, `scipy`, `matplotlib.pyplot`, `pandas` and
`sympy` pre-imported, a variable list, and captured plots. It is gone, and
nothing replaced it inside the editor.

A venv you control is simply a better scripting environment than a REPL
embedded in a webview: your own interpreter, your own package set, a notebook if
you want one, a debugger, a test runner, and an editor for the script that is
the editor you are already in. Those four scientific packages were in the
kernel's install for the REPL and nothing else — no part of drawing, compiling
or simulating a schematic imported them — so they left with it.

## Settings

Everything the extension needs to find lives under **General Simulator** in VS Code's settings
(`Ctrl+,`, then search `omniSchematics`). Every path may be left empty, in which case it is
searched for. There are five, and two fewer than there were:
`omniSchematics.kernelPython` and `omniSchematics.autoStartKernel` went with the
kernel they configured (#162).

| Setting | What it is for |
| --- | --- |
| `omniSchematics.generalSimulatorPath` | The `general-simulator` binary — the engine that runs a simulation, and the only setting a run reads. Download a [release build](https://github.com/GLODI-Engineering/general-simulator/releases) or build one from source (see above). |
| `omniSchematics.octaveCliPath` | The `octave-cli` binary, for `octfunc` / `octblock` code blocks. |
| `omniSchematics.pythonPath` | Extra directories on `PYTHONPATH`, so a `pyblock` / `pyfunc` block can import your own modules. Relative entries resolve against the workspace folder. |
| `omniSchematics.environment` | Extra environment variables for the solver and everything it starts. The escape hatch for anything without its own setting. |
| `omniSchematics.solverTimeoutSeconds` | Abandon a run still going after this long; `0` waits indefinitely. Stop signals the solver process either way. |

### How a binary is actually found

`apps/vscode-extension/src/solver-path.ts` resolves the solver, ordered by how
much of a guess each step is, so a user who named a binary is never overridden
by one lying around:

1. an explicit path passed in,
2. `omniSchematics.generalSimulatorPath` — **the setting**,
3. `GENSIM_GENERAL_SIMULATOR_PATH` in the environment,
4. `PATH`,
5. a sibling `general-simulator` checkout beside the workspace, built with
   `cargo build --release`,
6. otherwise `SolverNotFound`, carrying every place it looked and how to build
   a binary at all.

Setting `omniSchematics.generalSimulatorPath` and exporting
`GENSIM_GENERAL_SIMULATOR_PATH` before starting the editor both work; the
setting wins. Octave and `pythonPath` still reach the solver as environment,
which the extension builds for the spawn.

Two of these are not quite like the others:

- **Octave** has no path setting in the engine: it spawns `octave-cli` from `PATH` and nothing
  else. So `octaveCliPath` puts that binary's directory at the front of the `PATH` the
  simulation inherits.
- **`pythonPath`** does not choose an interpreter. The engine embeds the one it was built
  against; this only adds places for a block's `import` to look.

The log (`Omni Schematics: Show Log`) names the environment variables a run was
given, without their values, so you can tell a setting arrived without a path
appearing in a log you might paste into an issue.

## Testing

```sh
pnpm test                                     # vitest, both workspaces
pnpm typecheck
pnpm e2e                                      # Playwright, dev harness
xvfb-run -a pnpm test:extension:integration   # real VS Code via @vscode/test-electron
```

The integration suite launches an actual VS Code, loads the extension, and
asserts on state pulled out of the live webviews — activation, the custom
editor resolving a `.gsim_sch`, the bundle loading under the webview CSP,
React mounting, dirty-state and save writing bytes, the cross-webview drag
fan-out, and a real run against a real solver binary reaching a real result.

Rendering quality is checked by rendering and looking, not by assertion — no
test notices that two labels overlap. See
[`docs/specs/schematic-rendering-spec.md`](docs/specs/schematic-rendering-spec.md):

```sh
node scripts/render-schematic.mjs --doc examples/buck_converter.gsim_sch
```

## Roadmap

Honest about what is not done:

- **Rendering quality.** Much improved — the geometry is now grid-exact,
  terminals carry reference designators and values, pin-name clutter is gone
  and junction dots are correct. Still open: labels anchor to the symbol's
  bounding box rather than to its ink, so a value can sit further from a thin
  glyph than it should; and the dot grid competes with the drawing. Tracked
  as a correctness property, not a nicety —
  [`docs/specs/schematic-rendering-spec.md`](docs/specs/schematic-rendering-spec.md)
  and issue #1.
- **Custom components do not persist.** The symbol editor writes into the
  in-memory catalog only; a saved symbol is lost on reload, and it carries a
  symbol but no simulation behaviour. `.gsim_sym` file I/O exists on the
  Python side (`packages/gsim-model/src/gsim_model/gsim_sym.py`) and needs
  wiring to the editor.
- **Marketplace release.** Not yet published.

## Related repositories

| Repository | What it is |
| --- | --- |
| [general-simulator](https://github.com/GLODI-Engineering/general-simulator) | The engine: LCP device resolution for piecewise-linear circuits, with native control blocks |
| [general-mna](https://github.com/GLODI-Engineering/general-mna) | Modified nodal analysis: descriptor-DAE assembly, hierarchy flattening |
| [gs-waveform-measurements](https://github.com/GLODI-Engineering/gs-waveform-measurements) | Post-simulation measurements on non-uniform time series |
| [spice-lsp](https://github.com/GLODI-Engineering/spice-lsp) | SPICE netlist parsing and language tooling |

## Licence

[AGPL-3.0-or-later](./LICENSE), matching the rest of the toolchain.
Third-party notices: [`THIRD_PARTY_NOTICES.md`](./THIRD_PARTY_NOTICES.md).

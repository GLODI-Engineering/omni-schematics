# General Simulator GUI for VS Code

Schematic capture, component authoring and circuit/system simulation, inside
VS Code.

[`general-simulator`](https://github.com/GLODI-Engineering/general-simulator)
is the engine — a Rust simulator for power electronics and mixed
circuit/block-diagram systems, with no user interface. **This repository is
its GUI.** You draw a schematic in a VS Code tab, press Run, and read the
waveforms in a panel beside your code.

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
library is a view in the Activity Bar, waveforms are a panel, and the
simulation kernel is a child process the extension owns.

## What it does today

| Capability | Where |
| --- | --- |
| Schematic editor for `*.gsim_sch` — select / wire / label / annotate / pan tools, orthogonal auto-routing with obstacle avoidance, rotation, mirroring, undo | `apps/frontend/src/canvas/` |
| Block library (287 entries) with symbol previews and a per-simulator filter | `apps/frontend/src/library/` |
| Symbol editor — draw a custom component from primitives, place its ports, save it to the library | `apps/frontend/src/symbol-editor/` |
| Parameter inspector, including Level-1 device models taken from ngspice 46's own model set and a raw `.MODEL` fallback for BSIM/PSP/HICUM-class compact models | `apps/frontend/src/inspector/` |
| Waveform viewer — multi-axes figures, cursors, per-signal colour, decimation, PDF export | `apps/frontend/src/waveform/` |
| Netlist preview and emission, in the engine's own dual grammar | `apps/frontend/src/netlist/`, `packages/simulator/` |
| Hierarchy: subsystems, `.SUBCKT` definitions and instances, Goto/From routing | `apps/frontend/src/canvas/`, `packages/gsim-model/` |

Signal-flow and physical-electrical blocks coexist in one sheet: a control
loop can drive a converter leg in the same document.

## Architecture

```
VS Code extension host (Node)
├── KernelSidecar           spawns the Python kernel, parses KERNEL_READY
├── GsimHost                webview registry + cross-webview drag broker
├── LibraryViewProvider     WebviewView in the Activity Bar
├── SchematicEditorProvider CustomEditorProvider for *.gsim_sch
└── WaveformPanel           singleton results panel

webviews (Vite bundles from apps/frontend)
├── schematic.html   the canvas, inspector and symbol editor
├── library.html     the block library
└── waveform.html    the results viewer

kernel sidecar (Python)      compiles the document and runs the solver
```

The webviews talk to the sidecar over a loopback WebSocket. The extension
host owns the process and tells the webviews which port and token to use.

### One host, on purpose

This GUI previously tried to be a web app, a Tauri desktop app and a VS Code
extension from one codebase. It is now only an extension — see
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

The `.vsix` is the editor. It carries no simulation kernel and no engine, so on
a fresh machine nothing can run until you give it both. Two settings do that,
and they are the only two that matter — the editor does not care how either was
built, and it will not build or look for one itself:

```jsonc
// settings.json
"omniSchematics.kernelPython": "/path/to/gsim-venv",
"omniSchematics.generalSimulatorPath": "/path/to/general-simulator"
```

`kernelPython` is **required**. There is no `uv`, no checkout discovery and no
fallback: with that setting empty, a Run click says so and names the command
below. That is the whole arrangement, deliberately (#141).

Preparing that environment once, from a checkout of this repo:

```sh
node scripts/make-kernel-venv.mjs            # ~/.omni-schematics/kernel-venv
```

It installs the seven kernel packages and their dependencies, adds `gsim_py` and
`gsim-tools` if it finds them beside this checkout, starts the kernel to check
the result, and prints the path to paste into the setting. `--out <dir>` puts it
somewhere else and `--python <exe>` picks the base interpreter.

Without a checkout, the same thing by hand from a release's wheels:

```sh
python -m venv gsim-venv
gsim-venv/bin/pip install <wheels>/*.whl   # the seven kernel packages
```

`numpy`, `scipy`, `sympy`, `websockets` and `h5py` are declared by those wheels,
so pip resolves them — you do not list them yourself. Verified: a venv holding
nothing but the seven wheels starts the kernel and prints its `KERNEL_READY`
line.

`matplotlib` and `pandas` used to be on that list, and are not any more: they
were there for the in-editor Python REPL, which is gone (#161). Scripting lives
in your own environment now — see [Scripting a schematic](#scripting-a-schematic).

The wheels are attached to every release; `uv build --all-packages --out-dir dist`
builds them from a checkout.

That is enough for the editor to **open and edit** schematics. To **simulate**,
the environment also needs the two packages that cannot come from a public
index:

```sh
gsim-venv/bin/pip install <path-to>/gsim_py-*.whl    # maturin build of gsim-core/crates/gsim-py
gsim-venv/bin/pip install -e <sibling-repos-root>/gsim-tools
```

Without them the kernel starts and a run answers `SolverUnavailable` naming the
missing build step, rather than failing obscurely.

On Windows the interpreter is `gsim-venv\Scripts\python.exe`; either the
directory or the executable is accepted.

The kernel announces a protocol version in its handshake, and the extension
refuses an environment that does not match its own — so if you upgrade the
extension and the kernel stops starting, the message tells you to reinstall
those packages, rather than failing somewhere less obvious.

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
declares and can compile, the document compiles with the real compiler, and it
still matches the `build_*.py` script that generated it.

### Working on this repository

Then **open this repository as your VS Code workspace folder** and open
`examples/buck_converter.gsim_sch`. It opens in the schematic editor, with
the block library in the Activity Bar.

Working on this repo needs the same `omniSchematics.kernelPython` a user needs
— there is no developer shortcut, because a shortcut is how the user-facing path
stays broken without anyone noticing:

```sh
node scripts/make-kernel-venv.mjs
```

Then paste the path it prints into `omniSchematics.kernelPython`. Rerun it with
`--force` after changing anything under `packages/` or `apps/kernel-sidecar`.

`General Simulator: Show Kernel Log` in the command palette shows exactly what
was spawned, which is the first place to look when a run does nothing.

The engine binary is not bundled. Point the extension at your own build with
`omniSchematics.generalSimulatorPath`, or set `GENSIM_GENERAL_SIMULATOR_PATH`
in the environment the kernel inherits. Nothing else needs a path: the engine
is the only simulator this editor runs.

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

Until #161 the kernel ran a Python REPL for a **Workspace** bottom tab: a
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
searched for — with one exception: `omniSchematics.kernelPython` has nowhere to be searched
for and must be set.

| Setting | What it is for |
| --- | --- |
| `omniSchematics.generalSimulatorPath` | The `general-simulator` binary — the engine that runs a simulation. Build it with `cargo build --release -p general-simulator-cli` and point here at `target/release/general-simulator`. |
| `omniSchematics.octaveCliPath` | The `octave-cli` binary, for `octfunc` / `octblock` code blocks. |
| `omniSchematics.pythonPath` | Extra directories on `PYTHONPATH`, so a `pyblock` / `pyfunc` block can import your own modules. Relative entries resolve against the workspace folder. |
| `omniSchematics.environment` | Extra environment variables for the kernel and everything it starts. The escape hatch for anything without its own setting. |
| `omniSchematics.kernelPython` | **Required.** The Python environment the simulation kernel runs in. Nothing simulates until it is set; `scripts/make-kernel-venv.mjs` builds one. |
| `omniSchematics.autoStartKernel` | Start the kernel when the extension activates. |

### How a binary is actually found

A setting is one rung of a chain the backend already had, and not the first:

1. an explicit path on the simulate request,
2. the app settings file (`~/.local/share/general-simulator/settings.json`),
3. the environment — **this is the rung these settings write**,
4. `PATH`,
5. otherwise `SolverNotFoundError`, listing every place it looked.

So a setting overrides `PATH` and is overridden by the settings file. Setting
`omniSchematics.generalSimulatorPath` is equivalent to exporting
`GENSIM_GENERAL_SIMULATOR_PATH` before starting the editor, and you can do either.

Two of these are not quite like the others:

- **Octave** has no path setting in the engine: it spawns `octave-cli` from `PATH` and nothing
  else. So `octaveCliPath` puts that binary's directory at the front of the `PATH` the
  simulation inherits.
- **`pythonPath`** does not choose an interpreter. The engine embeds the one it was built
  against; this only adds places for a block's `import` to look.

The kernel log (`General Simulator: Show Kernel Log`) lists the variable *names* it was given
on start-up, so you can tell a setting arrived without a path appearing in a log you might
paste into an issue.

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
fan-out, and the kernel handshake.

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

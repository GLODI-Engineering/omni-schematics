# Changelog

## 2026-11-26 — Omni Schematics (0.9.2)

**A code block builds into the run, or tells you exactly why not** — and three
things that used to give a confident wrong answer now refuse instead.

### Install it

1. `omni-schematics-0.9.2.vsix` from this release.
2. A `general-simulator` binary, **v0.9.0 or newer**, from
   [its releases](https://github.com/GLODI-Engineering/general-simulator/releases).
3. `"omniSchematics.generalSimulatorPath": "/path/to/general-simulator"`

The editor compiles with its own committed copy of the engine, built from
[gsim-core v0.6.3](https://github.com/GLODI-Engineering/gsim-core/releases/tag/v0.6.3)
— you do not install that, it is inside the `.vsix`. This file names exactly
one gsim-core release and the release workflow checks it against what the
bundle was built from, so **this link moves with every engine bump**.

### A C, Python or Octave block is part of the run now

Double-clicking a scripted block opens its source in a VS Code editor beside
the schematic, which is the reason for being in VS Code at all. From this
release the rest of the path works too:

- **The solver runs in the schematic's own directory**, so a relative `lib=`
  or `path=` resolves the way the sheet says. It used to run in
  `.gsim/runs/<id>/`, where none of a sheet's relative paths mean anything.
- **A library older than its source does not run silently.** Editing the `.c`
  and pressing Run used to simulate the *old* compiled library and report
  success — a result with no error in it and the wrong code behind it.
- **A compiler error, a Python traceback or an Octave error is a clickable
  Problems entry**, with the file and the line, so one click puts the cursor on
  it. The parser was written against the engine's real output rather than an
  example, which caught that a Python `SyntaxError` arrives *inside* the
  engine's own sentence while a runtime traceback is on the lines after it.
- **The run says what this machine cannot do before it starts**, instead of
  failing in the middle with a message from a tool you did not know it needed.

### Fixed — the C stub declared a function the engine never calls

The scaffold the editor writes for a new C block declared a `cscript_output`
whose signature disagreed with the engine's. On Linux it worked by register
coincidence; **on Windows x64 it crashes or reads garbage**. The engine now
publishes `gsim_cscript.h`, so nobody retypes the ABI — which is what made the
mismatch possible in the first place — and a CI job reads the engine's own
declaration and compares.

### Fixed — a sheet's declared analysis was ignored

Pressing Run read a settings store that **nothing in the user interface
writes**, while the Simulation panel writes analyses to the document. So a
sheet asking for a 20 ms window at 5 ns got the store's defaults, with nothing
saying its own declaration had been passed over.

The sharpest case: a sheet declaring `t_step: "{T_sim / 100}"` ran at the
panel's step instead — **100× coarser**. At 10 µs a 100 kHz converter is
sampled once per switching period, always at the same phase, so the switch
reads as permanently off and the plot is the flat line of a converged run of a
dead circuit. An analysis whose timing the editor cannot read now stops the
run and says so, from both the Run button and the dropdown.

### The editor can ask for an operating point

`--mode dc` **is** an operating point and the engine has always solved one; the
editor simply never asked. OP now routes to it, with no window on a command
line that has no use for one. Measured end to end: a 10 V source across two
1 kΩ resistors writes 612 bytes rather than the 38,103 a transient of the same
sheet writes, and solves to 5 V at the midpoint and −5 mA through the source.

AC and DC-sweep are still refused by name, now with a reason that says why
each is not a flag away: the engine is a piecewise-linear time-domain solver,
so an AC sweep is a different analysis rather than a different output format.

A switching converter has **no** DC operating point, and the engine says so
rather than inventing one: *"every gate is block-driven (gate=block), which
needs --mode transient"*.

### A port says what it carries

gsim-core 0.6.3 gave every signal port a dimension signature — 44 components
gained one, 48 of 53 now have one against 4 before. Five were deliberately left
without, with the reason in the engine's own code: a state-space block's width
is `rows(c)` and the signature language has no way to say "that matrix's row
count". `[1]` on all of them would have been true today and was rejected,
because a wrong dimension displayed confidently is worse than none.

### Known

The dimension overlay still does not render in the browser end-to-end test.
The signatures were necessary and are not sufficient: the blocks insert, the
wires are made, and the toggle produces nothing. Recorded with the measurement
on #117.

## 2026-11-26 — Omni Schematics (0.9.1)

**The editor looks and behaves like part of VS Code, and two silent bugs are
gone.** 0.9.0 removed Python; this is the release that makes what is left
pleasant to use, and it exists because the owner installed it, used it, and
said what was wrong.

### Install it

Unchanged from 0.9.0: the `.vsix` below, a `general-simulator` binary (**v0.8.0
or newer**), and

```jsonc
"omniSchematics.generalSimulatorPath": "/path/to/general-simulator"
```

The editor compiles with its own committed copy of the engine, built from
gsim-core **v0.6.2** (link moved to the current release, see 0.9.2)
— you do not install that, it is inside the `.vsix`. This file names exactly one
gsim-core release and the release workflow checks it against what the bundle was
actually built from, so **this link moves with every engine bump**.

### Fixed — a sheet you saved once was a copy from then on

Build a model, press **Ctrl+S once**, close the tab, reopen it from the startup
list — and every edit after that went to a **duplicate**. The first save had no
reference to save *to*, so it went through "save as", which rewrote the model's
id and appended " Copy" before writing. The window kept the original name, so
nothing on screen said anything had happened.

It hid because the symptom cancels itself: a *second* Ctrl+S writes the real
document back under the copy's key, repairing the name inside the record but
not the key. Save twice and there is nothing to see. The document is now
written through untouched, and the adapter — which had no unit test at all —
has five, each watched failing against the old code first.

### Fixed — a causal signal was reported as a voltage

In the engine, a `physical-signal` wire was compiled into a **circuit node**,
because the test for "is this acausal?" was a string prefix and
`"physical-signal"` starts with `"physical-"`. Four other places in the same
crate already treated it as causal, one of them with a comment explaining that
it deliberately avoided this very predicate.

So a sensor-to-actuator connection became a node, the solver correctly reported
that node's voltage, and **a reading of 0.42 arrived on a plot as 0.42 volts**.
No error, no warning, a plausible number wearing the wrong unit. The guard that
should have caught it only ever tested the kind `"signal"` — never the causal
kind the predicate got wrong. Fixed in gsim-core 0.6.2, with the guard widened.

### Fixed — on an AZERTY keyboard the command palette had no shortcut

`palette.command-azerty` was declared in the keymap and handled nowhere: one
occurrence in the repository, its own declaration. The dispatcher resolved the
chord, waited out its timeout, fired the fallback, and the switch dropped it.
On a layout where `.` needs Shift, `Ctrl+.` cannot be typed at all, so there
was no way in. The keymap gates were green throughout — they check that an id
is *registered*, never that it is *handled*.

### The Block Library is dense, legible and follows your theme

Rows **56 px → 24 px**, entries visible without scrolling **9 → 31**, and the
list is **1,944 px** instead of 4,472. Every tile now draws inside its own box:
before, **68 of 68** drew outside it, because artwork meant for a 120×264
canvas symbol was being squeezed into a fixed 56×40 tile with the aspect ratio
thrown away — `hierarchy.inport` squashed 3.6× sideways, `logic.flip_flop`
collapsed to about 18 px wide. That, not the artwork, is what read as "ports
mismatch".

Colours come from VS Code's own variables, so the panel is no longer a white
island in a dark editor. And three pairs of entries that were indistinguishable
now say which is which: **Step** `signal.step` against **Step**
`signal_flow.source.step`, and likewise for the inductors and scopes. One of
those collisions turned out to be ours — a grouping rule was renaming a
four-terminal coupled pair "Inductor".

### The toolbar fits

**54 px → 30 px**, buttons 44 → 24, labels became tooltips, and what does not
fit moves into a `⋯` menu instead of being cut off mid-glyph behind a
scrollbar. Measured at three pane widths: at 1205 px everything fits; at 706 px
nine controls move into the menu; at 466 px seventeen do — and **Run stays
visible in all three**.

### New Schematic is reachable, and no longer writes an empty file

The command existed and was reachable only by typing its name in the command
palette. It is now in **File ▸ New File…**, on the Block Library's title bar,
in the Explorer context menu and the editor title bar.

It also wrote a **zero-byte file**, which was harmless until you used
**File ▸ Revert** on one: the revert path had no empty check, parsing `""`
threw, the document was recorded unreadable, and from then on **every save was
a silent no-op**. It writes a real document now, and an empty file is read as
an empty schematic rather than a parse failure.

### A scripted block opens its own source

Double-click a C, Python or Octave block and its source opens in a VS Code
editor beside the schematic — with the language services that are the reason
for being in VS Code at all. There is an **Open file** button in the Inspector
too, and if the file does not exist the editor offers to create it from a stub
carrying the right entry-point signature.

Worth knowing: a `cscript` block declares a compiled **`lib`**, not a source
path, so the `.c` is found by convention (`blocks/<stem>.c`, then beside the
library, then the sheet's folder, then `src/`). The Inspector says so rather
than implying the path was declared. A consequence of the same discovery: the
Inspector's "Read ports from source" panel required a `path` parameter, so for
a C block it had **never once appeared**.

### The tests now drive the real editor

A new suite under `tests/vscode-ui/` runs **VS Code itself** with the extension
loaded: it clicks all **68** catalogue entries into an empty sheet, then walks
one person's path — insert, place without overlapping, drag, wire, save — and
presses Run against a real solver, checking the container on disk and the
signals in the viewer. It records video.

This exists because every defect in this release was found by a person using
the editor, and none of them could have been seen by the tests we had: the rest
of the suite runs the webview in a plain browser, which is wide, uses its own
fonts, and has none of VS Code's injected CSS variables.

Three perf budgets were also measuring the wrong thing — the clock sat in the
test runner, around CDP round trips, so the numbers were mostly driver latency.
**No budget was relaxed**; all three now read the figures the app already
published about itself. One of them never loaded the model it claimed to time:
the reload discarded the fixture, so a 200 ms budget was being held against a
cold boot of an *empty* document, which is why it drifted from 226 ms to 687 ms
on a retry of identical code.

### Known

The canvas sheet is still light while the rest of the editor follows your
theme: the webview writes `data-theme="light"` over VS Code's own, from a
stored preference nothing has written yet (#221). Fixing the precedence alone
would give a half-dark editor — the stylesheet still carries 387 literal
colours — so it is being done as a deliberate pass rather than a flag flip.

One end-to-end spec remains red, and it is an engine data gap rather than an
editor fault: the dimension overlay needs a port signature on every block in
the path, and only 4 of 78 catalogue entries have one (gsim-core#64).

## 2026-11-25 — Omni Schematics (0.9.0)

**The editor needs no Python.** Two downloads, one setting, and a schematic you
can draw, compile, simulate and plot — with no interpreter on the machine.

### Install it

1. `omni-schematics-0.9.0.vsix` from this release. **Extensions → … → Install
   from VSIX**.
2. A `general-simulator` binary — the engine that does the numerical work.
   Download it from
   [general-simulator's releases](https://github.com/GLODI-Engineering/general-simulator/releases)
   (v0.8.0 or newer; a source build needs three sibling checkouts, so prefer
   the release).
3. Point the editor at it:

```jsonc
"omniSchematics.generalSimulatorPath": "/path/to/general-simulator"
```

That is the whole list. No Python, no virtual environment, no wheels, no
version pin. For comparison: 0.7.0 asked for nine Python packages and shipped
seven of them; 0.8.0 shipped all nine and still needed a hand-built venv and
CPython 3.12 or 3.13 specifically.

**Scripting a schematic has not gone away — it has moved out of the editor.**
Install [`gsim-tools`](https://github.com/GLODI-Engineering/gsim-tools) and a
[`gsim_py`](https://crates.io/crates/gsim-py) wheel into an environment of your
own and build or measure documents there, with your own numpy and your own
notebook. That is what those packages were written for, and it is a better
place for it than a REPL inside a webview.

### The editor installs as one `.vsix` — **breaking**

**A machine with no Python on it opens every example, runs one, and gets a
waveform.** That is the whole of the milestone this closes, and it is now true
by construction rather than by luck: there is nothing left in this repository
that could start an interpreter (#162).

Deleted, with everything built to ship it:

- `apps/kernel-sidecar/` — the Python process the extension spawned on
  activation and sent a run to.
- `packages/simulator`, `packages/gsim-model`, and the Python half of
  `packages/schemas`. The schema *definitions* and the TypeScript they generate
  stay; the Pydantic models went with the kernel that imported them.
- The WebSocket layer, both ends: `server.py`, `ipc/`, `binary_frame.py`,
  `handshake.py`, and the frontend's `ipc/client.ts`, `transport.ts`,
  `binary-frame.ts`, `waveform-chunk-frame.ts`, `error-map.ts` and `stub/`.
- The root `pyproject.toml`, `uv.lock`, `conftest.py`,
  `requirements-venv-freeze.txt`, `scripts/make-kernel-venv.mjs`,
  `scripts/build.sh`, `scripts/dev.sh` and `tests/backend/`.
- `ci.yml`'s `python` job and the whole of `.github/workflows/backend.yml`.
- `release.yml`'s `wheels` job: no wheels are built, none are attached, and the
  release carries one file.

**Two settings are gone.** `omniSchematics.kernelPython` and
`omniSchematics.autoStartKernel`, with the `Restart Simulation Kernel` command,
the kernel-start path, and every "the kernel did not start" diagnostic —
**including the one about a missing `pyproject.toml`**, which is the message
this milestone was opened over. `General Simulator: Show Kernel Log` is now
`Omni Schematics: Show Log`; it was never about a kernel.

`omniSchematics.generalSimulatorPath` is the only setting a run reads, and
`GENSIM_KERNEL_PORT` / `GENSIM_KERNEL_TOKEN` are no longer read at all.

**What the install is now.** Install the `.vsix`. Point
`omniSchematics.generalSimulatorPath` at a `general-simulator` binary. That is
the whole list. 0.7.0 needed nine Python packages and shipped seven; 0.8.0
worked but needed all nine and a hand-built venv. The question does not apply.

**The release has a gate again, and a stronger one.** The nine-wheel compile
gate — which existed because 0.7.0 shipped a kernel that started and could not
compile — is replaced rather than dropped. `release.yml` now compiles every
`examples/*.gsim_sch` through the committed WebAssembly engine, counts them
against the tree so a run over zero examples cannot pass, and runs with a PATH
holding `node` and nothing else, failing outright if `python`, `python3` or
`uv` can be reached from it. Watched failing three ways before being trusted.

Also gone, because their only writer was the kernel client: `simProgress` and
`simMessage` in the webview's store (nothing has reported a fraction since
#159, and a meter stuck at 0% reads as a hung solver), `registerLiveSignal`,
the live-chunk streaming path, `fetchSignal` — which still fetched waveforms
over an HTTP route the sidecar stopped serving in #157, and whose silent
`catch` would have drawn an empty trace rather than said anything (#194) — and
the kernel-connection `status` the Run button coloured itself from. A run in
flight is `runStartedAt`, and only that.

`kernel-environment.ts` is `solver-environment.ts`. It always described the
solver's environment; the sidecar was merely what used to pass it on.

### The install pins no Python version, because h5py is gone

`h5py` was the hardest wheel in this install, and it is not declared anywhere
in the repository any more (#156). With it go
`simulator/postprocess/hdf5_store.py`, the last `data.h5` any part of this
repository could write, and the last copy of Python decimation — the private
pyramid builder inside that module.

**What it means for an install.** The 0.8.0 notes below say *use CPython 3.12
or 3.13*, and the only reason was h5py: its wheels covered 3.10–3.14, so an
interpreter outside that range sent `pip` looking for `hdf5.dll` on Windows and
the install failed in a way nothing in the message explained. That reason has
expired, so the pin goes with it.

**The real range is any CPython from 3.11, with no ceiling.** 3.11 was the floor
every `pyproject.toml` in this repository declared, and nothing above it was
excluded: `numpy`, `scipy`, `sympy`, `networkx`, `jsonschema` and `websockets`
all ship wheels well past it. One ceiling was left and it was not the kernel's —
a `gsim_py` wheel is a compiled extension, with wheels for 3.11–3.15, so *if*
you install it to script a document, that is your range. The editor needs it for
nothing (#158).

Read this as the answer to a question the install no longer asks. The section
above deletes those packages, and with them the last reason the editor cared
what interpreter a machine had. Any CPython from 3.11 is what *scripting* a
document wants.

**An existing result directory holding a `data.h5` does not open, and did not
before this.** Nothing in the repository could read one: every HDF5 binding
links a C library, a webview has nothing to link it to, so the reader over
`data.h5` was never finished — which is why the writer is being deleted rather
than ported. `.gsim_sim_result` documents whose `data.kind` is `"hdf5"` are
refused by name, with that reason. The samples of a run made from this version
on are the solver's `.gsim_samples` container (#163), read by
`crates/waveform-store` (#157).

`result_writer.write` now writes `manifest.json` and nothing else. It has not
been on the path of a run since #159, and #162 deletes it with the rest of the
sidecar.

### A completed run plots itself — one decimator, in Rust

Pressing Run now ends in a waveform. The solver writes a `.gsim_samples`
container, the viewer reads windows of it, and the chart is drawn from the
bytes those windows needed and no others (#157).

**How, given that neither side can do it alone.** A webview can run
WebAssembly and cannot open a file; the extension host can open a file and
cannot load the WebAssembly, because `vsce package --no-dependencies` ships no
`node_modules` (#175). So `crates/waveform-store` — committed as WebAssembly in
`packages/waveform-wasm` — works out which byte ranges a window needs from the
container's stripe directory, the webview asks for them over the new
`gsim/readSamples`, the host answers with exactly those bytes, and the same
crate reduces them to what the plot can show. No sample value takes part in
deciding which bytes to read, which is what lets the reader ask twice and get
the same answer both times.

**What that buys.** On a 148 MB, 4,000,000-sample, 7-signal run: opening the
container costs 5,152 bytes and already answers the signal names, their count
and the sweep extent, so the axes are labelled before a sample is fetched. The
whole extent at 3,000 points costs 3.0% of the file; a tenth of it costs 0.35%;
one signal of seven costs a seventh of what all of them cost, because the
container is signal-major. A one-sample spike in a 200,000-row run survives a
500x reduction exactly, and the decimated extremes of a switching node over
4,000,000 samples equal its full-resolution extremes at 10,000x.

**A `.gsim_sim_result` whose `data.kind` is `"samples"` opens.** The results
editor used to refuse one — `codec.ts` said the document "stores data
externally" and gave up. It now reads the container beside it, with the path
resolved by the extension host against the document, confined to the
workspace folders and that document's own directory, and bounded so a bad
length cannot ask the host to allocate a gigabyte. An HDF5-backed result is
still refused, now with the reason: every HDF5 binding links a C library and a
webview has nothing to link it to.

**Three decimators are gone.** `apps/frontend/src/waveform/axes-config.ts`
carried a hand-maintained TypeScript copy of `minmax_envelope`, kept in step by
a comment saying so and a `_roundHalfEven` written to match Python's banker's
rounding bucket for bucket; it now calls the crate. `lod-client.ts` and
`prefetch.ts`, imported by nothing, are deleted, as are
`simulator/postprocess/decimation.py` and the whole of
`kernel_sidecar/waveform/` — so the sidecar no longer serves binary LOD frames
or `.npy` slices, and `server.py` has no HTTP surface at all. The last piece of
Python decimation was a private helper inside `hdf5_store.py`, which built that
legacy writer's pyramid; #156 deleted both, so there is none left.

**Where the plot appears.** Inside VS Code the schematic webview hosts only the
schematic, so a finished run opens the waveform panel and the panel reads the
container. The host replays the last result to a panel opened afterwards, so
either ordering works. Outside VS Code the viewer is a tab in the same shell
and draws there directly.

### Running a simulation needs no Python — **breaking**

The extension runs `general-simulator` itself. Pressing Run compiles the sheet
in the webview, posts the netlist text to the extension host, and the host
resolves the binary, spawns it with `--format samples --events`, streams its
stdout and stderr to VS Code's Output panel as they arrive, reads the rule
events it reported, and writes a `.gsim_sim_result` beside the `.gsim_samples`
container the solver produced (#159).

**What changes for an install.** `omniSchematics.generalSimulatorPath` is the
only setting a run reads. `omniSchematics.kernelPython` is no longer required
for anything in a simulation — a machine with no Python at all now opens an
example and runs it. The kernel is still started when that setting is set, for
the status indicator and to read a signal out of a run it already holds; #162
deletes the sidecar entirely.

The `generalSimulatorPath` setting also stops apologising for itself. Its
description used to say the path "is handed to the simulation kernel **after**
the kernel has started, so it cannot start one by itself: if
`omniSchematics.kernelPython` is unset, the kernel never starts and nothing
here is ever read." There is no kernel to start first, so it is read on the
first Run of a session and means what it says.

**What changes while you work.**

- A Run that cannot find the binary names every place it looked and the `cargo`
  line that builds one, in the Output panel, which is revealed rather than left
  closed.
- The solver's stdout and stderr arrive as two labelled streams instead of one
  merged blob — #139 step 3, free once the spawn is local.
- The exact command line is printed before the run, so a failure can be
  reproduced by pasting it into a terminal.
- What the run *found* — a rating exceeded, a dead time too short — reaches the
  Problems panel, and the worst severity among those events, not the exit
  status, decides whether you are told "finished" or "finished with errors". A
  run can exit 0 having found an error. Nothing read that file before #182, and
  before #159 nothing even asked the solver to write it, so every finding of
  every run was discarded into a temporary directory (#68).
- Stop signals the solver process. It used to close the kernel socket and leave
  the solver running as the sidecar's child.
- Each run writes `.gsim/runs/<run id>/` beside the schematic: the netlist, the
  container, the event log and the result document. Nothing removes an old one
  yet (#186).

**Two narrowings, named rather than glossed.**

- **A completed run does not plot itself.** The samples are in the container and
  teaching the waveform store to read one is #163. The run says where it wrote
  the result, and that file is complete and self-describing.
- **Only transient analyses run.** `general-simulator --mode` takes `dc` or
  `transient`; the editor's dropdown also offers AC, DC sweep and OP, which the
  sidecar used to hand to ngspice or Xyce. A non-transient analysis is now
  refused by name rather than run as something else (#184).

Also fixed here because the run path walks straight into it: pressing Run used
to open the bottom panel onto `core.output`, an id **nothing registered**, so
the panel rendered empty — tab strip included, leaving no way to click across to
Problems (#170). There is a real Output tab again.

`omniSchematics.solverTimeoutSeconds` is new: abandon a run still going after
that long, `0` to wait indefinitely.

One correction found while wiring CI to a real binary: every instruction in
this repository for getting a solver — the setting's description, the README,
and the message a failed Run prints — said "clone
GLODI-Engineering/general-simulator and `cargo build`". That does not work. Its
workspace depends on three sibling repositories by path
(`gs-waveform-measurements`, `general-mna`, `spice-lsp`), so cargo stops at
`failed to load manifest for dependency` before compiling anything. All three
places now point at a release build first and name the siblings with the
source build.

### The editor compiles its own schematic — **breaking**

Pressing Run used to send the whole document to the Python kernel, which
compiled it there. The kernel is handed netlist text now: `gsim-core`'s own
`crates/gsim-wasm` is built to WebAssembly and ships inside the `.vsix`, so the
editor compiles with the engine itself (#158).

**What changes for an install.** The kernel environment no longer needs a
`gsim_py` wheel or `gsim-tools`. Those two were how it compiled a schematic, and
they are what the 0.7.0 and 0.8.0 notes told you to download alongside the seven
kernel wheels; the seven are now enough. Keep them in that environment only if
you also want to script a document from Python, which still uses them and is
unchanged.

**What changes while you work.** A document that does not compile says so
immediately, with the engine's own message — `floating-port` naming the wire,
`unknown-type` naming the block — before any kernel is started, instead of
arriving as a `CompileError` from a process that may not have had a compiler at
all. The compiler's notes, including the DC references it adds for nodes nothing
else ties down, appear whether or not the solve succeeds. The netlist goes to
the Output panel for every run, not only for an imported one.

**Why.** There were two compilers. About 1,600 lines of Python reimplemented
the engine's expression evaluator, Goto/From resolution, subcircuit flattening
and document I/O, and the two drifted twice that anyone noticed — once leaving
every example reporting `floating-port` at Run time while the gate said five
examples were fine, once letting a release gate and these install instructions
name different engine versions. There is one now, and
`examples/expected-netlists/` holds every shipped example to the netlist the
Python compiler last produced, byte for byte.

Gone with it: `simulator.compiler`'s `param_expression`, `goto_from_resolve`,
`gsim_sch_flatten`, `gsim_sch_loader`, `gsim_sch_writer`, `gsim_py_netlist`,
`compile_input` and `gsim_loader`, and `gsim_model`'s Python document model.
`gsim_model`'s `.gsim_sym` component authoring stays.

### The install is four downloads, not nine

Three of the seven wheels this repository published contained no Python at all.
Every `.py` file in `components` (5 files), `synthesis` (6 files) and
`kernel-core` (1 file) was an empty `__init__.py` — 0 lines of code between the
twelve of them — and nothing in the tree imported any of the three. They were
directory skeletons for netlist emission and a component library that were
planned in Python and then landed in Rust instead, which is the whole point of
the engine being Rust.

They were not inert while they sat there. They declared dependencies of their
own (`components` → sympy, pyyaml; `synthesis` → components, sympy, jinja2;
`kernel-core` → websockets, numpy), `simulator` required `components`,
`kernel-sidecar` required `kernel-core`, and the release gate asserted that all
seven wheels were built. So an install was three downloads and three pip
resolutions longer than the kernel needed, for nothing.

All three are deleted, with every declaration that named them:

```sh
python -m venv gsim-venv
gsim-venv/bin/pip install <all four wheels, in one command>
```

Four wheels from this repository — `schemas`, `gsim_model`, `simulator`,
`kernel_sidecar` — and that is the whole list. Six became four when the editor
took the compiler: `gsim_tools` and a `gsim_py` matching your platform and
Python version were the two the kernel compiled with, and they are not needed
to open, edit or simulate a schematic any more. Install them anyway if you want
to script a document from Python.

Still one command, for a smaller reason than before. `components` and `schemas`
are both names owned by other people on PyPI, and installing the set one wheel
at a time let pip resolve a sibling's requirement from the index and fetch a
stranger's package. Deleting `components` retires one of those two collisions;
`schemas` is the last one, so the single `pip install` stays.

Nothing a user can see changes, and nothing imports differently — which is the
evidence that the three packages were as empty as they look.

Also gone: the `no-piecewise-templates` architectural invariant, whose grep
pointed at `packages/components/src/components/templates`. A grep over a
directory that does not exist cannot fail, so it was a check reporting a tick it
had not earned. The rule it encoded is the engine's to hold now, and
`docs/agent-rules/architecture-invariants.md#smooth-models` says so where the
section used to be.

## 2026-11-24 — Omni Schematics (0.8.0)

**0.7.0 could not open any example, and could not simulate on any machine.** Both
are fixed. If you installed 0.7.0, replace it.

A minor bump rather than a patch, because one change is genuinely breaking: see
*Ports are spelled the way the engine spells them* below.

### Install it

Nine downloads now, not seven. The two that were missing are the reason a 0.7.0
install started the kernel and then failed every run.

* `omni-schematics-0.8.0.vsix` — the editor. **Extensions → … → Install from VSIX**.
* seven `.whl` files on this release — the kernel packages.
* [`gsim_tools-0.1.0-py3-none-any.whl`](https://github.com/GLODI-Engineering/gsim-tools/releases/tag/v0.1.0)
  — pure Python, works on any platform and any CPython from 3.11.
* a `gsim_py` **0.6.0** wheel (the release link is deliberately plain text here:
  only the current engine is linked, see 0.9.1) matching your platform *and* your Python version — it is a compiled
  extension, so `cp312` and `cp313` are different files.

```sh
python -m venv gsim-venv
gsim-venv/bin/pip install <all nine wheels, in one command>
```

One command on purpose: two of these packages are named `components` and
`schemas`, which belong to other people on PyPI. Installed one at a time, pip
resolves a sibling's requirement from the index and quietly fetches a stranger's
package instead of the file sitting next to it.

Then in settings:

```jsonc
"omniSchematics.kernelPython": "/path/to/gsim-venv",
"omniSchematics.generalSimulatorPath": "/path/to/general-simulator"
```

**Use CPython 3.12 or 3.13.** `gsim_py` has wheels for 3.11–3.15 and `h5py` for
3.10–3.14; 3.12 and 3.13 are where every piece has one. If `pip` ever goes looking
for `hdf5.dll`, that is the symptom of a Python outside h5py's wheel range, a
32-bit interpreter, or a pip too old to read the tags — HDF5 itself never needs
installing, because h5py's Windows wheels carry it.

The 0.7.0 notes said `gsim_py` and `gsim-tools` "cannot come from a public index".
That was wrong about `gsim-tools`, which is a public MIT repository, and it is no
longer true of either: both now publish wheels on their own releases.

### Fixed — no example could be opened

Every committed example failed the editor's own validator, two ways at once:

```
/model/blocks/8/paradigm: must be equal to constant
/model/wires/0: must have required property 'net'
```

The paradigm, because the generator copied it from the engine catalogue, which
calls `routing.ground` `physical-network` while the schema requires `^routing\.`
to say `routing`. The missing `net`, because the engine's serialiser skipped the
field whenever a wire had no net name, and the schema requires it as
`string | null`.

### Fixed — a file the editor could not read was at risk of being overwritten

The parse failure went to a log channel that is closed by default, so the editor
opened on an empty canvas and offered *"Nothing to simulate — the schematic is
empty. Add a component first."* Following that advice would have marked the editor
dirty with the empty model and replaced your schematic on save.

Now: an unreadable document is handed back to the host byte for byte, so a save
cannot destroy it; nothing is sent while it is in that state; a notification says
what happened; and a banner in the editor names the fault and says the file has
not been changed.

### Ports are spelled the way the engine spells them — **breaking**

A compatibility layer renamed `p`/`n` to `p1`/`p2` on resistors, inductors and
capacitors, and `gnd` to `p` on grounds, for an engine version that no longer
exists. Against the current engine every schematic failed with
`floating-port: port 'l1.p' needs a node but no physical-network wire reaches it`.

The layer is gone. **A sheet saved with the old `p1`/`p2`/`p` spelling will no
longer compile** — rewire those endpoints to `p`, `n` and `gnd`, which is what the
palette and the catalogue have called them for some time.

### Fixed — the examples were unreadable and ran for ten seconds

`auto_arrange()` placed blocks on a 40-unit grid while a symbol occupies 120×80,
so sheets overlapped themselves: 18 colliding pairs on the buck, 87 on the
phase-shifted full bridge. Each generator now places its own blocks.

And each example carried an empty `simulation` block, so a run fell back to a
default of `t_end = 10 s` — on converters switching at 100 kHz. Every example now
carries a window sized to itself, from 5 ms on the buck to 40 ms (two line cycles)
on the PFC stage.

### The gates that should have caught all of this

Each of the above was invisible to CI, and in the same way: the check and the
product reached the same code by different routes.

* The release gate asserted the kernel reached `KERNEL_READY` — which happens with
  no compiler installed at all, because the compiler is imported on the first run.
  It now compiles every example through the call the run handler itself makes, and
  fails on 0.7.0's own wheels.
* `check-examples` read documents with `JSON.parse` and compiled them with the
  engine. The engine accepts documents the editor rejects. It now runs the editor's
  own validator, and reports every error rather than the first.
* Nothing measured layout. A test now asserts no two blocks overlap, using the
  renderer's own geometry function rather than its own arithmetic.

## 2026-11-23 — Omni Schematics (0.7.0)

### Install it

Two downloads on this release, because the `.vsix` is only half an install:

* `omni-schematics-0.7.0.vsix` — the editor. **Extensions → … → Install from VSIX**.
* seven `.whl` files — the simulation kernel.

The editor carries no simulator. Simulation runs in a Python process the extension
starts, and that process was previously expected to come from a checkout of this
repository launched with `uv`. It no longer is:

```sh
python -m venv gsim-venv
gsim-venv/bin/pip install <the seven wheels>
```

then in settings:

```jsonc
"omniSchematics.kernelPython": "/path/to/gsim-venv",
"omniSchematics.generalSimulatorPath": "/path/to/general-simulator"
```

With `kernelPython` set there is no `uv`, no clone, and `workspaceRoot` is ignored.
On Windows the interpreter is `gsim-venv\Scripts\python.exe`; either the directory or
the executable is accepted. The wheels declare `numpy`, `scipy`, `matplotlib`, `pandas`,
`sympy`, `websockets` and `h5py`, so pip resolves those for you.

To **simulate** rather than only edit, that environment also needs a `gsim_py` wheel and
`gsim-tools`, neither of which can come from a public index. Without them the kernel
still starts and a run answers `SolverUnavailable` naming the missing step.

### Fixed — Run told you nothing when it could not run

Reported as *"I'm clicking on the run button and nothing is happening"*, and that was
exact: the click hung rather than failed. Three paths gave up on starting the kernel
without telling the editor anything, and the editor's wait for that answer had no
timeout, so the promise never settled — no message, no log line, not even the button
changing state. It hung for as long as the window stayed open.

Every failed start now reports its reason, in a notification rather than only in an
output channel that is closed by default. If `kernelPython` points somewhere without an
interpreter, it says so and names the path. If the kernel is prepared for a different
version of the editor, it says that and names both versions.

The two settings most likely to be reached for in that situation now explain how they
relate. `generalSimulatorPath` is read only *after* the kernel is running, so setting it
alone cannot start one — which was the trap. `workspaceRoot` wants a checkout of this
repository, not of `general-simulator`, which has no `pyproject.toml` in it at all.

### Added — five example converters, and they run

The palette is no help with an empty sheet, and this release is the first to carry any
example: 0.6.0 contained none. **Omni Schematics: Open Example Schematic…** opens a copy
of one into your workspace.

| example | in | out |
| --- | --- | --- |
| Buck converter | 48 V | ~19 V at 40 % duty |
| Boost converter | 12 V | ~24 V at 50 % duty |
| PFC boost front end | 230 V RMS, 50 Hz | 400 V bus |
| LLC resonant converter | 400 V | ~48 V |
| Phase-shifted full bridge | 400 V | ~48 V |

All five switch at 100 kHz and run open loop — fixed pulse trains, not regulators. They
show topology and give you something that runs on the first click; they are not
reference designs.

A copy is opened rather than the shipped file, so editing one cannot damage the
installation and your changes survive the next update.

### Fixed — the one example that existed was broken, five ways

Worth stating plainly, because it is the reason the examples are now checked in CI. The
previous buck converter used a block type the engine no longer declares; two more that
are *aliases*, which resolve in the palette and are rejected by the netlist compiler; a
gate drive for a switch that no longer has those terminals; and a document the loader
could not read at all. It had also drifted from the script that generated it.

Every example is now held to four things on every change: it parses, its block types are
canonical names the engine declares and can compile, it compiles with the real compiler,
and it still matches its generator.

## 2026-11-23 — Omni Schematics (0.6.0)

### Install it

This release carries `omni-schematics-0.6.0.vsix`. Download it and use
**Extensions → … → Install from VSIX**. Previous releases carried no artifact: the
.vsix was built by hand, so installing meant cloning the repository and having pnpm,
Node and a Rust toolchain. It is now built from the tag by CI.

### Changed — the palette shows what the engine can actually simulate

The component library was cut from 240 entries to the 78 the engine can compile. The
palette used to offer components that produced a block the simulator then refused, which
is a worse experience than not offering them: the failure arrived after you had drawn
the schematic rather than before.

Most of what went had artwork and parameters and no model behind it — MOSFETs, BJTs,
thermal and mechanical devices among them. Their symbols are kept in the editor,
unreferenced, for the day a target can emit them.

**Some things you could place are gone, and this is the part to read before upgrading.**
The subsystem container (`hierarchy.subsystem.*`) and the bus creator
(`routing.bus_creator`) are no longer in the library, and neither are
`signal.constant` or the two `converter.*_signal` blocks. Inport and Outport remain.
A schematic that uses any of them has blocks the editor no longer has a definition for;
it is not yet established what that looks like when you open it, which is tracked as
GLODI-Engineering/omni-schematics#126 rather than guessed at here.

Whether subsystems and buses belong to the editor rather than to the engine's library is
an open question — GLODI-Engineering/gsim-core#61 — so their machinery is deliberately
left in place with nothing to place from the palette, rather than deleted.

### Changed — the ideal devices are their own family, with their own palette section

`passive.switch.ideal` is now **`ideal.switch`**, and `passive.diode.ideal` is
**`ideal.diode`**. They appear under a new **Ideal Devices** heading in the palette
instead of among the passives.

The old names were wrong in a way worth fixing: an ideal switch declares a drain, a
source, a gate-driven threshold and a body diode. That is an active device, and filing
it beside the resistor invited reading it as a passive component with extra parameters.

**Schematics saved with the old names still open.** Both old spellings are kept as
aliases and resolve to the renamed components, and both still draw their own symbol. If
you refer to either type by name in a Python or C script, update the name.

## 2026-11-19 — Renamed to Omni Schematics

### Changed — action required if you have custom keybindings

The editor is now **Omni Schematics**, named apart from the engine it drives
because it is built to drive others. Everything the extension contributes was
namespaced after the engine and is now namespaced after the product.

**If you bound a key to one of these commands in your own `keybindings.json`,
the binding no longer matches.** Rename the command and it works again:

| was | now |
| --- | --- |
| `generalSimulator.showWaveforms` | `omniSchematics.showWaveforms` |
| `generalSimulator.restartKernel` | `omniSchematics.restartKernel` |
| `generalSimulator.showKernelLog` | `omniSchematics.showKernelLog` |
| `generalSimulator.newSchematic` | `omniSchematics.newSchematic` |
| `generalSimulator.openSchematic` | `omniSchematics.openSchematic` |
| `generalSimulator.forwardChord` | `omniSchematics.forwardChord` |

The eight settings moved the same way — `generalSimulator.workspaceRoot` is
`omniSchematics.workspaceRoot`, and so on. **The keys themselves did not
change**: it is still `omniSchematics.generalSimulatorPath` that points at the
`general-simulator` binary, because the engine keeps its name.

The two custom editors changed view type (`generalSimulator.schematic` →
`omniSchematics.schematic`, `.simResult` likewise), so a `.gsim_sch` or
`.gsim_sim_result` you had opened with an explicit "Open With" choice will ask
again the first time.

The packaged artifact is `omni-schematics.vsix`, and the extension id is
`gensim.omni-schematics`.

## 2026-11-17 — A placed block lands on a tier that exists (0.5.0)

### Fixed

- **Dropping a PID, a sum or a sine source from the palette produced a block
  that could not compile.** `insert.ts` named the tier rather than asking the
  component for one: every non-electrical block was handed `n_a`, which means
  "not applicable" and is what a component with no real fidelity levels
  declares. Thirteen components carried an `n_a` tier *beside* a real one,
  holding the pre-migration Simulink parameter vocabulary the engine never
  reads — `amplitude`/`period`/`pulse_width`/`phase_delay` where the emitter
  wants `v1`/`v2`/`td`/`tr`/`tf`/`pw`/`per`. So the ordinary act of drawing a
  control loop and pressing Run ended in "missing required parameter". A block
  now starts on `ideal` when its component has it, else the component's first
  declared tier, and `n_a` only when the component declares none.
- **A block's parameters changed the first time its fidelity was touched**,
  even when set to the tier it already had. They came from the component-level
  list while the block was labelled with a tier, and a fidelity swap treats a
  tier's list as definitive — adding what the target declares and removing what
  it omits. They now come from the tier the block is on.
- **Transformers, opamps, BJTs, IGBTs, MOSFETs, the gyrator and the memristor
  had no pins.** 87 tiers in the engine's library declared no ports and 64 no
  parameters, while the components themselves declared both. A block at such a
  tier cannot be wired and has no artwork to hang. Fixed in the engine and
  picked up here with the regenerated catalogue (gsim-core 0.4.0).
- **Aligning a selection by keyboard did nothing at all.** The four align
  commands were bound to `Ctrl+Alt+Left`/`Right`/`Up`/`Down` while the
  dispatcher collapsed every arrow to `Arrow`, so a real press produced
  `Ctrl+Alt+Arrow`, which nothing was bound to. A chord may now name a
  direction: the specific spelling is tried first and the generic one second,
  so nudge, pan and extend-selection keep working through the direction-agnostic
  spelling they are deliberately written with.
- **Three toolbar tooltips named keys that do nothing.** "Rotate clockwise  R"
  against `Ctrl+R`, "Flip horizontal  X" against `Ctrl+I`, and Rotate CCW
  showing no shortcut though `Ctrl+Shift+R` exists. They now read the chord from
  the keymap, so a hint cannot disagree with what the dispatcher accepts.
- **A parameter written in a script was not the parameter the netlist carried.**
  Document floats were parsed one ULP low. Fixed in the engine (gsim-core
  0.4.0).

### Upgrading

A sheet saved by an earlier version carries `fidelity: "n_a"` on its
signal-flow blocks, and for thirteen component types that tier no longer exists.
Those sheets still open and still draw — the canvas resolves ports from the
component, not the tier — and a fidelity swap refuses with a plain message
rather than failing. Pick a tier on the affected blocks to compile them.

## 2026-11-09 — The engine says what it has (0.4.0)

### Added

- **The component library comes from the engine.** There were two
  descriptions of every component: a catalogue kept in this repository and
  the engine's own registry, and they disagreed — of 26 components whose
  parameters both described, 15 agreed and 10 did not, each disagreement a
  parameter the inspector offered and the compiler rejected, or the reverse.
  The engine now ships the library itself and serves it through
  `gsim_py.catalog()`; this front end generates its catalogue from that call
  and displays it. There is no second list to keep. A CI job rebuilds the
  catalogue from the engine and fails on any difference, so the two cannot
  drift apart again.

  Merging the two descriptions collapsed 26 duplicate spellings, taking the
  library from 265 components to 239, and claimed 32 registry types that
  nothing in the catalogue had ever named. Every one of the 239 now names a
  registry type or declares that it compiles nowhere; 60 compile. Which ones
  is no longer written down anywhere: `compilable` is derived from the
  registry when the catalogue is built, so it cannot disagree with what the
  compiler will actually do.

  Components the engine spells differently kept their old names as aliases,
  so a sheet saved before this release opens unchanged.

- **The schematic's keyboard shortcuts win over VS Code's.** A webview only
  receives a keystroke the workbench did not claim first, so 28 of this
  editor's chords never reached it: `Ctrl+R` opened VS Code's recent-files
  list instead of rotating the selection, and nothing on screen explained
  why. Those 28 are now contributed as keybindings conditioned on a
  schematic being the active editor, and forwarded into the webview.

  The new setting **General Simulator › Override VS Code Keybindings**
  turns this off and gives the chords back. It is on by default. It applies
  only while a schematic tab is focused — a source file, the explorer and
  the terminal are untouched either way, and the setting takes effect
  without a reload. `docs/keyboard-conflicts.md` lists all 58 collisions,
  generated from the keymap, including the 30 that need no contribution
  because they are editor-scoped and never fired over a webview anyway.

- **A search box in the library.** 239 components in a tree is not something
  to scroll. Escape clears it.

- **A wire can be dropped onto a wire.** Releasing a drag on an existing
  conductor splices a junction into it at the nearest point on the segment,
  rather than requiring a port at both ends.

### Fixed

- **A simulation that failed said nothing at all.** The backend answered in
  about a millisecond with a precise reason — `SolverUnavailable: gsim_py is
  not installed, and gsim_tools.schematic needs it` — and the Run button
  looked dead: the word `gsim_py` appeared nowhere on screen. The failure
  path wrote to the Output panel and the Problems list, both of which live
  in the bottom panel, which starts hidden and is not mounted in every
  shell. The validation path a few lines above opened it; this one never
  did.

  Every failure now reports through one helper: the full text to Output and
  Problems, the panel opened on Problems, and a toast carrying the first
  line — the toast because it does not depend on a panel existing. The Run
  dropdown had a second silent path that never checked the result status at
  all, and set an empty waveform manifest on failure, so a failed run showed
  an empty plot instead of a reason.

---

## 2026-11-06 — Rows have a floor (0.3.3)

### Fixed

- **Three axes in a short editor were squashed to nothing.** Each row took
  an equal share of whatever height was going, so three panes got about
  70 px each and, after the header, legend and measurement strip, the chart
  itself was a sliver. Rows now have a minimum height and the figure
  scrolls past it — two readable plots you scroll between beat three
  unreadable ones.

---

## 2026-11-06 — The viewer follows VS Code's theme (0.3.2)

### Fixed

- **A white chart inside a dark editor.** A webview is a separate document
  and inherits none of the workbench's styling, so nothing told the viewer
  which theme was active — it drew light regardless, a bright rectangle in
  the middle of a dark window. VS Code marks the webview body with
  `vscode-light` / `vscode-dark` / `vscode-high-contrast` and rewrites that
  class when the theme changes without a reload, so the viewer now observes
  it: right at boot, and on every switch afterwards. High contrast counts
  as dark, except its light variant, which carries both classes and would
  otherwise have read as dark.

---

## 2026-11-06 — Decimation that keeps the transient (0.3.1)

### Fixed

- **The chart kept one signal's peaks and lost the rest.** The reduction
  chose its min/max indices from the *first* signal on an axes and reused
  them for every other series, so peak preservation depended on the order
  signals were added: a switch node plotted first kept its overshoot,
  plotted second it did not, and nothing on screen said so. Replaced with a
  shared-grid min/max envelope — the time axis is bucketed so every signal
  keeps one grid, and within each bucket every signal contributes its own
  minimum and maximum. Verified on 400,000 samples of a 100 kHz switch node
  with a single-sample 96 V overshoot: reduced to ~2,700 points, the
  transient is still on the chart.
- **Zooming in never recovered detail.** The data was decimated once over
  its full extent and zoom only rescaled it, so one percent of a 250,000
  sample run left 200 points stretched across the plot. The visible window
  is now reduced instead, which costs less rather than more — the work
  follows what is on screen. Zoom far enough and the window is handed over
  exact.
- The point budget comes from the plot's width — two per pixel, the most a
  min/max reduction can distinguish — rather than a flat 20,000. On a
  measured run that is 2,728 points instead of 20,000: a 7x cut in what has
  to be stroked on every frame, which is what a constrained machine feels.

### New

- **`crates/waveform-store`** — the reduction as one Rust implementation,
  compiled natively for a server and to WebAssembly for the viewer, so both
  answer "this window of these signals, in at most this many points" the
  same way. Measured on an 11-signal, 25,000-sample result: parses in
  19 ms, full extent in 1.1 ms, a 2% window exact in 0.3 ms. Scales
  linearly to 100 M samples (763 MB per signal) at 102 ms for the full
  extent and 1.2 ms per zoom.
- `tests/properties.rs` establishes what survives a reduction: max, min and
  peak-to-peak exactly; every sample inside the drawn band, guaranteed; the
  mean within 0.03% while buckets stay finer than the waveform's period,
  and structurally wrong once they span many. Hence the rule it pins down —
  **a measurement is computed on the samples, never on the reduction the
  chart is drawn from.**

### Format

- `.gsim_sim_result` v2 separates metadata from samples: `data.kind` is
  `inline` (self-contained, as before) or `hdf5` (pointing at the file
  holding the samples and the LOD pyramid). v1 documents still open.

---

## 2026-11-06 — Results you can keep, and a viewer you can read (0.3.0)

### Waveform viewer

- **The plot fills its panel.** It was built at a fixed 800×300 whatever it
  sat in, so a maximised VS Code panel left roughly two thirds of the surface
  empty grey and a narrow one clipped the chart. It now measures its cell and
  resizes in place rather than rebuilding on every frame of a splitter drag.
- **Cursors and annotations land where their values are.** They were
  positioned with uPlot's device-pixel coordinates but laid out in CSS
  pixels, so above dpr 1 — every retina display, and VS Code at any zoom
  above 100% — each one was drawn at twice its distance from the origin and
  fell outside the plot. `overlayPx` returns what a CSS overlay needs.
- **Axes say what they show.** A rotated bare "V" became "Voltage (V)", with
  the SI prefix on the ticks. Tick labels chose precision per value, so an
  evenly spaced axis read "5.00ms 10.0ms 15.0ms"; there is now one precision
  per axis, taken from the step. A log axis labels decades instead of all
  nine minor ticks of each.
- **Stacked axes share an x origin**, so a figure can be read down a moment
  in time. An axes with one quantity has no right-hand gutter and was
  therefore wider than its neighbour by the width of a whole axis.
- **A real dark theme.** The chart was forced white under a near-black
  legend. Both halves now read one set of `--wave-*` tokens; `theme.ts`
  hands them to the canvas, which CSS cannot reach.
- **Measurements are reachable.** RMS, mean, min, max, peak-to-peak,
  frequency, period, rise and fall time, duty cycle and integral existed,
  were tested, and were mounted nowhere. They are now a strip above each
  plot — a few as columns, a row per trace, the rest one menu away, over the
  full run or between cursors A and B — computed in a worker that keeps the
  samples rather than copying them per request.
- **Per-trace display gain.** A 2 A current next to a 48 V rail is a flat
  line. Scaling it is display-only — measurements, cursors and exports read
  the real samples — and the legend shows "×10" permanently.
- **Past runs.** Up to four previous runs are kept and drawn behind the
  current one, each in its signal's colour at falling contrast and labelled
  with how old it is ("V(out) [1]"). A run on a different time base is left
  out rather than resampled.
- **The signal browser lists what is there.** It read only the live kernel's
  last manifest, so a saved result showed "No simulation results available"
  beside three populated charts. Each signal now has a checkbox, and the bar
  names the axes it adds to; a differing quantity gets its own y-axis.

### New file format

- **`.gsim_sim_result`** — a simulation result as one self-contained file:
  sweep axis, signals with units and quantities, and the layout they were
  shown in. Double-clicking it in the Explorer opens the viewer, with no
  kernel running. Until now a result lived only in the kernel's private
  cache under a session-scoped id, so it could not be committed, attached to
  a review, reopened next week, or compared against one from another branch.
  Samples are base64 little-endian doubles, so a round trip is exact.
  Spec: `docs/specs/gsim-sim-result-format-spec.md`.
- The editor is read-only: a result is derived data, so there is no phantom
  dirty dot and no Ctrl+S that rewrites a measurement. It does reload when
  the file changes on disk.

### Export

- One axes **or a whole figure**, as an **image or as data**: PNG, JPEG,
  SVG, PDF, CSV, and `.gsim_sim_result`. A figure exports as one stacked
  image rather than its first pane. Each format states what it costs before
  it is chosen — CSV drops the units and the last bits; the result file
  keeps both.

### Fixed

- `.gitignore` carried a bare `results/` under "Simulation output", which
  matches a directory of that name at any depth. It silently swallowed the
  result format's whole implementation and schema, with `git add -A`
  reporting nothing wrong.
- The three formats this extension owns now open as JSON in the text
  editor, so the raw file has highlighting and folding.

### Tooling

- `scripts/render-waveform.mjs` renders the viewer to a PNG, the way
  `render-schematic.mjs` does for the schematic: no assertion notices that a
  grid out-weighs the data.
- `scripts/stress-waveform.mjs` loads a real `.gsim_sim_result` through the
  production path and reports open time and worst-frame interval under zoom
  and pan — worst, not mean, because one 300 ms frame is what "it froze"
  means.

---

## 2026-05-31 — Canvas algorithm adoption (phase P21)

### Frontend

- **Adopted the reference editor's superior canvas algorithms (path A).** The
  standalone `schematic_editor.html` reference editor was decommissioned and its
  strong interactive geometry ported into the production React/ReactFlow canvas
  as pure, DOM-free modules: an **orthogonal auto-router with obstacle
  avoidance** (`canvas/router/ortho-route.ts`, `obstacles.ts` — FE-98); **wire
  attachment + live stretch + end-segment reroute** on block move
  (`canvas/router/attachment.ts` — FE-99); **junction-dot computation/render**
  (`canvas/edges/junctions.ts` — FE-100); **wire segment dragging** with
  orthogonal re-normalisation (`canvas/edges/segment-drag.ts` — FE-101);
  **domain-driven wire colours + connection-reject flash** mapped onto the
  existing `PortKindDomain` (`canvas/edges/wire-color.ts`, `port-compat.ts` —
  FE-102); a **catalog-driven primitive symbol renderer** (canvas + identical
  SVG) with no hardcoded component table (`canvas/nodes/primitive-renderer.ts` —
  FE-103); and **V/I probes persisted in `.gsim_sch`** under `model.metadata.probes`
  (`canvas/probes.ts` — FE-105).
- **Keymap parity guard (FE-106).** The reference editor's inline keydown handler
  was discarded; all ported actions dispatch through `canvas/keymap.ts` via the
  single `KeymapProvider`. `assertNoBareLetterRotate` forbids reintroducing the
  bare-`R` rotate; rotation stays `Ctrl+R` / `Ctrl+Shift+R` per the keyboard map.
- **Deferred symbol editor (FE-104).** The in-canvas symbol editor is specified
  in `docs/specs/symbol-editor-spec.md` (Form/Draw, FE-103 primitives,
  block-metadata output, smooth-model gating) and deferred for later implementation.
- **Removed `schematic_editor.html`** (FE-107). Decisions D1–D5 are recorded in
  `docs/specs/canvas-algorithm-adoption.md`.

---

## 2026-05-28 — SPICE component authoring polish

### Frontend

- **IEEE schematic symbols on the canvas.** `apps/frontend/src/canvas/nodes/component-symbols.tsx` adds a registry of hand-drawn SVG symbols keyed by `metadata.name`, replacing the generic rectangle/circle render with proper schematic art: zigzag resistor, parallel-plate capacitor, four-hump inductor, source circle with DC/SIN/PULSE/EXP/PWL/noise glyphs, IEEE diode (standard + Zener), ground triangle, voltage and current switches, NPN/PNP BJT, and N/P MOSFET. `BlockSymbol` consults the registry first and falls back to the previous primitive render for any block type without a hand-drawn symbol; metadata YAMLs and the schema are untouched. Primary parameter values (R, C, L, V, I) are formatted with SI prefixes (1000 → `1 kΩ`, 1e-6 → `1 µF`) and shown below the body.

- **Double-click parameter panel.** `apps/frontend/src/inspector/ComponentParamsPanel.tsx` opens a modal on double-click that surfaces every model parameter for SPICE devices grouped by category (DC, Capacitance, Transit time, Temperature, Noise, …). A `Model level` dropdown swaps the visible parameter set live; values persist by SPICE name across level switches. `device-models.ts` enumerates every parameter from the ngspice 46 reference tables (working-tools/pdf-to-md/output/ngspice-46-manual.md) for: passives (R, C, L, switches) with their instance and `.MODEL` extensions; Diode Level 1 (Shockley); JFET Level 1; MESFET Level 1 (Statz); MOSFET Levels 1/2/3/6/9 (classic SPICE) including the Level 2 (UCRIT/UEXP/VMAX/NEFF/NFS/DELTA) and Level 3 (THETA/ETA/KAPPA) deltas; BJT Level 1 (Gummel-Poon). Compact models above the classic levels — BSIM3/4, BSIM-SOI, BSIM-CMG, PSP, EKV, MVS, L_UTSOI, HICUM, VBIC, MEXTRAM, HiSIM — are listed as level options with `raw=true`, presenting a textarea for the user to paste a full `.MODEL` card body. Field-by-field editors for those compact models are deferred per device.

- **Library activity polish.** Each sidebar entry now renders a scaled-down `BlockSymbol` as a preview to the left of the label (sized 56×40, scaled to 0.6) and drops the dotted catalog name (`passive.resistor`, `physical_electrical.semiconductor.bjt_npn`). The `Block Library` title plus simulator-filter dropdown are now sticky inside the scroll container so they no longer disappear when scrolling categories. The simulator-compat lists in `simulator-compat.yaml` are trimmed: signal-flow and control blocks (`signal.constant`, `signal.step`, `control.*`, `sinks.scope`) no longer appear under ngspice or Xyce — both lists now mirror the SPICE-only enumeration in `Misc/spice-simulator-analsys/SIMULATOR-COMPONENT-SUPPORT.md`. SciPy keeps the signal-flow set since it is the control-system backend.

- **Canvas background switcher.** A `Canvas background` submenu in `View ▾` lets the user pick White, Light grey, Cream, or Dark. The selection persists in `localStorage` under `gensim.ui.canvas-bg.v1` and applies via a `data-canvas-bg` attribute on the canvas root.

### Fixes

- **`Maximum update depth exceeded` on selecting a second block of a different type.** Caused by `Canvas.tsx` mirroring ReactFlow's internal `onSelectionChange` back into the Zustand selection store after `onNodeClick` already wrote it; the round-trip re-rendered nodes, which re-fired the callback, which re-wrote selection, looping until React aborted with a white screen. `onNodeClick` is now the sole canonical writer; ReactFlow's `onSelectionChange` is a no-op. `getMetadataPortCenters` also skips ports lacking `side`/`offset` so the sidebar preview can safely render minimal test-fixture metadata.

### Validation snapshot
- Frontend Vitest: `pnpm --filter @gensim/frontend test` — 378 pass / 6 skipped (intentional `xfail`s).
- Frontend typecheck: `pnpm --filter @gensim/frontend typecheck` ✅
- Playwright crash-probe (insert 10 component types, click each in order): ✅

### Known gaps
- `tests/e2e/smoke.spec.ts` (`signal.step → control.pid → sinks.scope`) is red at HEAD because of a pre-existing block-name drift between the test and the current catalog. Not introduced by this work; tracked for a follow-up fix.

---

## 2026-05-24 — All epics complete milestone

### Highlights
- FE-63 complete: .gsim_sch roundtrip gate tests and fixture documentation finalized.
- FE-66 complete: Signal Attributes blocks wired in frontend inspectors and library integration.
- FE-07 complete: keymap drift CI check validated with full frontend gate passing.
- Backend gate stabilized: legacy float-coordinate validation restored before IR-1 and equation template registry cross-validation made robust for templates without `state_vars()`.

### Validation snapshot
- Frontend: `pnpm --filter @gensim/frontend test` ✅
- Frontend typecheck: `pnpm --filter @gensim/frontend typecheck` ✅
- Backend: `scripts/aw-test-backend.sh ALL` ✅ (`PASS`)

### Project status
- `progress.frontend.yaml`: all epics complete.
- `progress.backend.yaml`: all epics complete.
- No active Archon workflows.

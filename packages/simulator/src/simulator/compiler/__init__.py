"""simulator.compiler package.

**Nothing here compiles a schematic any more** (#158).

What used to live here: a Python reimplementation of work `gsim-core` already
did in Rust — `param_expression` against the engine's `expr/` lexer, parser and
evaluator; `goto_from_resolve` against `compile/routing.rs`;
`gsim_sch_flatten` against `document/subckt.rs`; `gsim_sch_loader` and
`gsim_sch_writer` against `load_document` and `save_document`; and
`gsim_py_netlist`/`compile_input` as the bridge the `simulate` handler called.
Roughly 1,600 lines maintaining a second opinion about what a document means,
which drifted from the first one twice that anyone noticed (#143, #153).

The editor holds the engine itself now — `gsim-core` compiled to WebAssembly,
committed in `packages/gsim-wasm` — compiles its own document and sends the
netlist. The kernel is handed netlist text and solves it.

Nothing is left in it. `simulation_extract` and `simulator/ir/` went too
(#176): they belonged to the older ir1/ngspice pipeline and were reached by
nothing but their own test -- the only mention of `ir1` outside them was a
parameter of that name in `general_simulator_solver.can_handle`, which is not
an import.

What `simulation_extract` did still matters as a *question*, and the question
lives where it belongs: a drawn schematic has no way to say what analysis to
run, which is GLODI-Engineering/gsim-tools#16. Keeping 328 lines of a retired
pipeline here was not keeping the answer, only the shape of an old one.

This package exists now as a place that is deliberately empty, so that the
next person reaching for it reads the paragraphs above instead of adding a
second compiler to it.
"""

from __future__ import annotations

__all__: list[str] = []

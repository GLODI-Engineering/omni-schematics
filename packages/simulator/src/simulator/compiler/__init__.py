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

What is left in this package is `simulation_extract`, which belongs to the
older ir1/ngspice pipeline and is reached by nothing in the product. It is left
alone here rather than deleted alongside, because it is a different cleanup
with a different question behind it.
"""

from __future__ import annotations

__all__: list[str] = []

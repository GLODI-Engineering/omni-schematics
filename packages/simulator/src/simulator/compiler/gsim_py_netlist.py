"""Compile a `.gsim_sch` document straight to a `general-simulator` netlist via `gsim-py`.

This is the *only* compile path a `simulate` request should take once a document is fully
authored with `general-simulator`-only catalogue types. The palette is scoped that way by the
engine's own capability manifest, not by any list kept in this repository. It deliberately does
not go through `gsim_loader`/`ir1_builder`/`ir2_lowering`/
`spice_netlist_writer`/`scipy_compiler` — that whole older pipeline targets ngspice/Xyce/SciPy,
a different taxonomy (`passive.resistor` vs. `resistor`, `source.voltage.dc` vs. `voltage_dc`,
...) maintained by hand in `spice_netlist_writer.BLOCK_TO_SPICE`. `gsim-core`'s own Rust compile
registry (`compile/spec.rs`) is the real, single source of truth for what a block compiles to,
shared with the frontend's own rendering/validation via the same crate — see
`general_simulator_solver.py`'s own module doc comment for the solver half of this path.

## One-time build step

`gsim_py` is a compiled PyO3 extension (`gsim-core/crates/gsim-py`), not a pure-Python package,
so it cannot be a plain `pyproject.toml` dependency the way `gsim-tools` is (a `path` dependency
would pin one platform/interpreter's wheel into the lockfile). Build it once per interpreter:

```bash
cd <sibling-repos-root>/gsim-core/crates/gsim-py
maturin build --release --interpreter <path-to-this-repo's>/.venv/bin/python3.12
uv pip install --python <path-to-this-repo's>/.venv/bin/python3.12 \\
    ../../target/wheels/gsim_py-*.whl
```

`gsim-tools` (pure Python) needs no build step, but it is **not** a declared dependency either:
it is published to no index -- a public repository, but 404 on PyPI -- so there is no version to
depend on, and an optional extra does not help because uv locks every extra. Install it the same
way, once:

```bash
uv pip install -e <sibling-repos-root>/gsim-tools
```

`uv sync` prunes whatever it did not lock, so both this and the `gsim_py` wheel above need
redoing after a sync. Use `uv sync --all-packages` — a bare `uv sync` only syncs the root
project's own dependency closure in this workspace's configuration, not every member.
"""

from __future__ import annotations

import json
from typing import Any

# Re-exported so a caller can catch one name without importing gsim_tools directly —
# gsim_tools.schematic._gsim_py() already raises exactly this (a lazy `import gsim_py`
# behind every Schematic method that needs it) with a message naming the build step.
from gsim_tools.schematic import GsimPyNotAvailable

# Everything done to a document before the compiler sees it lives there, so the
# gate in `scripts/check-examples.mjs` can run it without gsim_tools (#143).
from simulator.compiler.compile_input import (
    assert_ports_are_declared,
    prepare_document,
)

__all__ = [
    "GsimPyNotAvailable",
    "assert_ports_are_declared",
    "compile_gsim_document",
    "compile_gsim_document_full",
]


def _ensure_document_shape(gsim_doc: dict[str, Any]) -> dict[str, Any]:
    """Kept as a name; the work is `compile_input.prepare_document` (#143)."""
    return prepare_document(gsim_doc)


#: Deliberately empty, and kept as a note rather than deleted silently (#143).
#:
#: This module used to respell four types' port ids on the way in --
#: `passive.{resistor,inductor,capacitor}`'s `p`/`n` to `p1`/`p2`, and
#: `routing.ground`'s `gnd` to `p` -- to bridge a real divergence: gsim-core's
#: compile registry once spelled them one way while the frontend catalogue
#: spelled them the other, so a document drawn in the UI failed with
#: `floating-port` on every wire touching a passive.
#:
#: gsim-core changed. Its own catalogue now declares `p`/`n` and `gnd`, the same
#: as the frontend's. The two vocabularies agree, so the bridge was the only
#: thing left creating a divergence -- and it created one on every document that
#: contains a resistor, capacitor, inductor or ground, which is every document.
#: `wire4` of `examples/buck_converter.gsim_sch` arrived at the compiler pointing
#: at `l1.p1`, a port that does not exist, and the error named `l1.p`, which
#: does.
#:
#: The lesson worth keeping is about where it hid rather than about port names:
#: `scripts/check-examples.mjs` compiles with `gsim_py` directly (on the belief
#: that gsim-tools was private, so a gate needing it would run on one machine --
#: it is not, and never was: #147), which means the gate
#: and the product reached the compiler by two different routes. A transform on
#: only one of those routes is invisible to the gate by construction. Hence
#: `simulator.compiler.compile_input`, which holds both the preparation step and
#: the check -- so a transform added to the one is automatically run by the gate
#: that applies the other. Put nothing on the way in anywhere but there.


def compile_gsim_document(gsim_doc: Any, target: str = "general-simulator") -> str:
    """Compile a `.gsim_sch` document (parsed dict — either the bare model object or the
    full `{schema_version, model}` document — or the JSON text of either) to a `target`
    netlist, via `gsim-core`'s own compile registry.

    Raises `GsimPyNotAvailable` if `gsim_py` isn't built for this interpreter, or one of
    `gsim_tools`' other typed compile errors (`FloatingPortError`, `MissingParamError`,
    `UnknownTypeError`, ...) if the document itself doesn't compile — both are real,
    actionable failures the caller should surface to the user, not swallow.
    """
    netlist, _notes = compile_gsim_document_full(gsim_doc, target)
    return netlist


def compile_gsim_document_full(
    gsim_doc: Any, target: str = "general-simulator"
) -> tuple[str, list[str]]:
    """Like :func:`compile_gsim_document`, but also returns the compiler's own
    info-level notes.

    The notes are decisions the compiler made *for* the user rather than errors:
    the reference net it picked when none was declared, and the DC references it
    added for nodes nothing else ties down. The second kind matters because the
    alternative is silent — an unreferenced node does not fail the solve, it
    returns a different answer — so a caller with somewhere to show them should
    use this and not `compile_gsim_document`.
    """
    from gsim_tools.schematic import Schematic

    doc = json.loads(gsim_doc) if isinstance(gsim_doc, str) else gsim_doc
    text = json.dumps(prepare_document(doc))
    sch = Schematic.load(text)
    # gsim_tools ships no type stubs, so the real return types are Any to mypy; the
    # conversions below make this function's own declared type honest.
    result = sch.compile_full(target)
    return str(result.netlist), [str(n) for n in result.notes]

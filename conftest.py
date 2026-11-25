"""Repository-wide pytest fixtures.

The one thing that belongs here: a single place that answers "can this checkout
actually run a `general-simulator` solve?". Two pieces of that path are installed
by hand rather than locked — `gsim_tools` (public, but published to no index)
and `gsim_py` (a compiled PyO3 extension) — see the note in the root
`pyproject.toml` under `[tool.uv.sources]`. A checkout without them is a
perfectly good checkout; it just cannot take that path.

Before this existed, the tests that need that path asserted `status == "ok"` and
failed with `SolverUnavailable` wherever it was absent — which read as a broken
product rather than an absent optional component, and was invisible anyway
because CI's pytest step pointed at two empty directories (#32).

**Compiling a schematic is no longer one of the things this answers for** (#158).
The editor compiles with `gsim-core` built to WebAssembly (`packages/gsim-wasm`)
and the kernel is handed a netlist, so no Python in this repository turns a
document into one. `gsim_py` is still what an *in-process* Python test or an
example generator reaches for, and that is what the fixture below is about.
"""

from __future__ import annotations

import pytest


def _importable(module: str) -> bool:
    try:
        __import__(module)
    except ImportError:
        return False
    return True


def gsim_engine_available() -> bool:
    """True when `gsim-core`'s Python binding is importable in this interpreter.

    Needed by the example generators under `examples/` and by any test that
    wants to compile in-process. Not needed by the product.
    """
    return _importable("gsim_py")


@pytest.fixture
def requires_gsim_engine() -> None:
    """Skip unless `gsim_py` is built for this interpreter."""
    if not gsim_engine_available():
        pytest.skip(
            "gsim_py is not built for this interpreter — it is hand-installed, not locked "
            "(see the root pyproject.toml's [tool.uv.sources] note): "
            "maturin build --release --manifest-path <gsim-core>/crates/gsim-py/Cargo.toml"
        )


@pytest.fixture
def requires_general_simulator() -> None:
    """Skip unless the `general-simulator` binary is on this machine.

    What a solve needs now that compiling is not this process's job: a solver.
    A netlist is handed in as text, so a test can take one from
    `examples/expected-netlists/` and need no engine binding at all.
    """
    from simulator.solvers.general_simulator_solver import discover_general_simulator

    if discover_general_simulator() is None:
        pytest.skip(
            "the general-simulator binary was not found — build it in the sibling repo "
            "(cargo build --release -p general-simulator-cli)"
        )

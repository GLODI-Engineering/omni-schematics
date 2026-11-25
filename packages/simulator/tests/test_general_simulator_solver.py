"""`general_simulator_solver` — the solve path, given netlist text.

Compiling a document is not this package's job any more (#158): the editor does
it with `gsim-core` built to WebAssembly and hands the kernel a netlist. What is
left to test here is the solver — how it is discovered, how its exit codes and
stop rules read, and that it turns a netlist into signals.

A netlist still has to come from somewhere for the integration tests, and the
honest source is the engine's own Python binding: `gsim_py.load_document` then
`gsim_py.compile`, two calls into the same Rust the editor calls. That is a
*use* of the engine, not a second implementation of it — the thing #158 removed
was the Python layer that reimplemented the engine, not the binding.

Both `gsim_py` (a one-time `maturin build` per interpreter) and the
`general-simulator` binary (`cargo build --release -p general-simulator-cli` in
the sibling repo) are genuinely optional on a fresh checkout, the same way
ngspice/Xyce are for their own integration tests — skip rather than fail when
either is missing, matching `test_ngspice_solver.py::test_integration_rc_transient`'s
own convention.
"""

from __future__ import annotations

import pathlib

import pytest


def _gsim_py_available() -> bool:
    """Whether the engine's Python binding is built for this interpreter.

    `gsim_py` alone is enough now. It used to need `gsim_tools.schematic` too,
    because the compile these tests reached for went through `gsim_py_netlist`,
    which imported it for one exception type -- so an interpreter with the engine
    wheel and not gsim-tools failed with a bare `ModuleNotFoundError` instead of
    skipping. That bridge is gone (#158).
    """
    try:
        import gsim_py  # noqa: F401
    except ImportError:
        return False
    return True


def _netlist_from(document: dict) -> str:  # type: ignore[type-arg]
    """Compile `document` with the engine, the way `gsim-tools` does.

    `load_document` first, so a document is validated and canonicalised before
    it is compiled -- the same two calls `packages/gsim-wasm/compile.js` makes
    for the editor, against the same Rust.
    """
    import json

    import gsim_py

    loaded = json.loads(gsim_py.load_document(json.dumps(document)))
    model = loaded.get("model", loaded)
    return str(json.loads(gsim_py.compile(json.dumps(model), "general-simulator"))["netlist"])


def _bare_model_document() -> dict:  # type: ignore[type-arg]
    """A minimal circuit using two of the four types with a known catalogue/gsim-core
    port-name divergence (`passive.resistor`, `routing.ground`) — exercises
    `_retargeted_to_gsim_core` for real, not just the happy-path types that already agree.
    """
    return {
        "id": "rc-model",
        "name": "RC",
        "grid": 10,
        "blocks": [
            {
                "id": "V1",
                "type": "source.voltage.dc",
                "paradigm": "physical-network",
                "domain": "electrical",
                "fidelity": "ideal",
                "position": [0, 0],
                "rotation": 0,
                "mirror": "none",
                "params": {"V": 5.0},
                "ic": {},
            },
            {
                "id": "R1",
                "type": "passive.resistor",
                "paradigm": "physical-network",
                "domain": "electrical",
                "fidelity": "ideal",
                "position": [80, 0],
                "rotation": 0,
                "mirror": "none",
                "params": {"R": 100.0},
                "ic": {},
            },
            {
                "id": "GND",
                "type": "routing.ground",
                "paradigm": "physical-network",
                "domain": "electrical",
                "fidelity": "ideal",
                "position": [160, 40],
                "rotation": 0,
                "mirror": "none",
                "params": {},
                "ic": {},
            },
        ],
        "wires": [
            {
                "id": "w1",
                "from": {"block": "V1", "port": "p"},
                "to": {"block": "R1", "port": "p"},
                "kind": "physical-electrical",
                "waypoints": [],
                "pinned": False,
                "net": "BUS",
            },
            {
                "id": "w2",
                "from": {"block": "R1", "port": "n"},
                "to": {"block": "GND", "port": "gnd"},
                "kind": "physical-electrical",
                "waypoints": [],
                "pinned": False,
                "net": "GND",
            },
            {
                "id": "w3",
                "from": {"block": "V1", "port": "n"},
                "to": {"block": "GND", "port": "gnd"},
                "kind": "physical-electrical",
                "waypoints": [],
                "pinned": False,
                "net": "GND",
            },
        ],
        "subckt_defs": [],
        "lines": [],
        "nets": [],
        "simulation": {},
        "metadata": {},
    }


def test_a_catalogue_spelled_document_compiles() -> None:
    """A document spelling its ports the way the catalogue does compiles.

    The four types that once had a catalogue/gsim-core port-name divergence
    (`passive.{resistor,inductor,capacitor}`'s `p`/`n`, `routing.ground`'s
    `gnd`) are the ones #143 was about. There is nothing between a document and
    the compiler to respell them now -- in this test or in the product -- so
    this asserts the thing that matters: the engine accepts the spelling the
    catalogue declares.
    """
    if not _gsim_py_available():
        pytest.skip("gsim_py not built for this interpreter — see this module's own doc")

    netlist = _netlist_from(_bare_model_document())

    assert "V1" in netlist
    assert "R1" in netlist


@pytest.mark.integration
def test_integration_a_rule_that_fires_reaches_the_bundle() -> None:
    """The findings of a run arrive on the result, instead of being deleted with the temp dir.

    #68. The engine writes its event stream beside the netlist, and the netlist is written
    into a `TemporaryDirectory`, so every event of every run used to be created and removed
    inside `solve()`. This drives the real binary with a deck whose rule is certain to fire
    and asserts the events came back.
    """
    from simulator.solvers.general_simulator_solver import (
        GeneralSimulatorSolver,
        discover_general_simulator,
    )
    from simulator.solvers.protocol import SolverOptions

    binary_path = discover_general_simulator()
    if binary_path is None:
        pytest.skip(
            "general-simulator binary not found — build it in the sibling repo "
            "(cargo build --release -p general-simulator-cli)"
        )

    # A 5 V node against a rule that allows 1 V: certain to fire, every step. `above`
    # compares the signed value, so the node voltage is the honest choice -- `I(V1)` is
    # -5 mA through the source and would never exceed a positive maximum. The rule is at
    # `warning`, so the process still exits 0: this test is about the events arriving, not
    # about the exit code, which is #69.
    netlist = (
        "V1 n1 0 5\n"
        "R1 n1 0 1k\n"
        "R_over kind=rule type=above target=V(n1) max=1 unit=V severity=warning\n"
    )
    solver = GeneralSimulatorSolver(binary_path)
    result = solver.solve(
        netlist,
        sim_id="int-rule-events",
        options=SolverOptions(analysis_type="TRAN", t_start=0.0, t_end=1e-3, n_samples=50),
    )

    log = result.event_log
    assert log, "the run reported nothing at all -- the stream was not read back"
    assert log.unreadable_lines == 0
    assert any(e.rule == "R_over" for e in log.events), [e.rule for e in log.events]
    assert log.worst_severity == "warning"
    # Every rule reports, including the quiet ones: the summary is there either way.
    assert any(s.rule == "R_over" for s in log.summaries)


@pytest.mark.integration
def test_integration_a_rule_that_stops_the_run_still_returns_its_waveform() -> None:
    """#69, against the real binary: exit 3 is a result, and it names the rule.

    `action=stop` ends the run at the violation -- the step finishes and every file is
    flushed, so the waveform is valid up to the stop. The adapter used to raise here and throw
    that waveform away.
    """
    from simulator.solvers.general_simulator_solver import (
        GeneralSimulatorSolver,
        discover_general_simulator,
    )
    from simulator.solvers.protocol import RunOutcome, SolverOptions

    binary_path = discover_general_simulator()
    if binary_path is None:
        pytest.skip(
            "general-simulator binary not found — build it in the sibling repo "
            "(cargo build --release -p general-simulator-cli)"
        )

    netlist = (
        "V1 n1 0 5\n"
        "R1 n1 0 1k\n"
        "R_stop kind=rule type=above target=V(n1) max=1 unit=V severity=error action=stop\n"
    )
    solver = GeneralSimulatorSolver(binary_path)
    result = solver.solve(
        netlist,
        sim_id="int-rule-stop",
        options=SolverOptions(analysis_type="TRAN", t_start=0.0, t_end=1e-3, n_samples=50),
    )

    assert result.outcome is RunOutcome.STOPPED_BY_RULE
    assert result.n_points > 0, "the waveform up to the stop is the point of exit 3"
    assert result.stopped_by == "R_stop", result.stopped_by
    assert any(e.rule == "R_stop" for e in result.event_log.events)


@pytest.mark.integration
def test_integration_compile_and_solve_rc_transient(tmp_path: pathlib.Path) -> None:
    if not _gsim_py_available():
        pytest.skip("gsim_py not built for this interpreter — see this module's own doc")

    from simulator.solvers.general_simulator_solver import (
        GeneralSimulatorSolver,
        discover_general_simulator,
    )
    from simulator.solvers.protocol import SolverOptions

    binary_path = discover_general_simulator()
    if binary_path is None:
        pytest.skip(
            "general-simulator binary not found — build it in the sibling repo "
            "(cargo build --release -p general-simulator-cli)"
        )

    netlist = _netlist_from(_bare_model_document())
    solver = GeneralSimulatorSolver(binary_path)
    result = solver.solve(
        netlist,
        sim_id="int-rc-gsim",
        options=SolverOptions(analysis_type="TRAN", t_start=0.0, t_end=0.01, n_samples=50),
    )

    signal_names = [s.name for s in result.signals]
    assert any("V1" in n or "n1" in n.lower() for n in signal_names), (
        f"Expected a source/node voltage signal, got: {signal_names}"
    )
    assert result.n_points > 0

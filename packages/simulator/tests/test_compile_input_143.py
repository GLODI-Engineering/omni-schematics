"""#143: a wire must not be rewritten onto a port the engine does not have.

The bug these pin: `gsim_py_netlist` respelled `passive.{resistor,inductor,
capacitor}`'s `p`/`n` to `p1`/`p2` and `routing.ground`'s `gnd` to `p`, bridging
a divergence between gsim-core's compile registry and the frontend catalogue
that gsim-core has since removed by agreeing with the frontend. The respelling
then became the only disagreement, and it broke every document containing a
passive -- with an error (`floating-port: port 'l1.p'`) naming a port that was
wired correctly.

The first two tests need nothing installed, so they run in CI's `python` job.
The rest need `gsim_py`, and the last needs `gsim_tools` as well; those skip
where the thing they test is absent, and run on a developer's machine and in
`examples-still-work`.
"""

from __future__ import annotations

import json
import pathlib

import pytest

from simulator.compiler.compile_input import (
    assert_ports_are_declared,
    declared_ports_from_catalog,
)

REPO = pathlib.Path(__file__).resolve().parents[3]
EXAMPLES = REPO / "examples"
FIXTURE_MODELS = REPO / "tests" / "backend" / "fixtures" / "models"

#: The buck converter's shape, reduced to the one wire that broke.
BUCK_FRAGMENT: dict[str, object] = {
    "blocks": [
        {"id": "sw", "type": "ideal.switch"},
        {"id": "l1", "type": "passive.inductor"},
    ],
    "wires": [
        {
            "id": "wire4",
            "from": {"block": "sw", "port": "s"},
            "to": {"block": "l1", "port": "p"},
            "kind": "physical-electrical",
        }
    ],
}

DECLARED = {"ideal.switch": {"d", "g", "s"}, "passive.inductor": {"p", "n"}}


def test_a_correctly_wired_document_passes() -> None:
    assert_ports_are_declared(BUCK_FRAGMENT, DECLARED)


def test_the_respelling_that_shipped_is_caught() -> None:
    """The exact mutation #143 was: `l1.p` rewritten to `l1.p1`."""
    broken = json.loads(json.dumps(BUCK_FRAGMENT))
    broken["wires"][0]["to"]["port"] = "p1"

    with pytest.raises(ValueError) as caught:
        assert_ports_are_declared(broken, DECLARED)

    message = str(caught.value)
    # The message has to name the port that was invented and the ones that
    # exist, or it is no more useful than the `floating-port` error it replaces.
    assert "'p1'" in message
    assert "'l1'" in message
    assert "['n', 'p']" in message


def test_a_ground_respelling_is_caught_too() -> None:
    model = {
        "blocks": [
            {"id": "gnd", "type": "routing.ground"},
            {"id": "r", "type": "passive.resistor"},
        ],
        "wires": [
            {"id": "w", "from": {"block": "r", "port": "n"}, "to": {"block": "gnd", "port": "p"}}
        ],
    }
    with pytest.raises(ValueError, match="undeclared-port"):
        assert_ports_are_declared(
            model, {"routing.ground": {"gnd"}, "passive.resistor": {"p", "n"}}
        )


def test_an_unknown_type_is_skipped_rather_than_failed() -> None:
    """A subsystem, or a type this catalogue build does not know, is not an error.

    Failing here would make this a second catalogue check, and a worse one: the
    question is only whether a wire was moved onto a port that does not exist.
    """
    model = {
        "blocks": [{"id": "sub", "type": "subsystem.instance"}],
        "wires": [{"id": "w", "from": {"block": "sub", "port": "anything"}, "to": {}}],
    }
    assert_ports_are_declared(model, DECLARED)


def test_a_variadic_port_is_not_reported_as_undeclared() -> None:
    """`control.sum` has no `inputs` at all; a sheet wires `in0`, `in1`, ….

    Found by `tests/backend/fixtures/models/step_pid_integrator_scope.gsim`,
    which this check called broken when it was not. Worth a test of its own: a
    gate with a false positive is worse than no gate, because it gets switched
    off rather than fixed.
    """
    from simulator.compiler.compile_input import VARIADIC_PREFIXES, declared_ports_from_catalog

    declared = declared_ports_from_catalog(
        {
            "components": [
                {
                    "id": "control.sum",
                    "ports": {
                        "inputs": [],
                        "outputs": [{"id": "out"}],
                        "variadic_inputs": {"count_from": "signs", "template": {"id": "in"}},
                    },
                }
            ]
        }
    )
    assert VARIADIC_PREFIXES["control.sum"] == {"in"}

    model = {
        "blocks": [{"id": "s", "type": "control.sum"}],
        "wires": [
            {"id": "w0", "from": {"block": "s", "port": "in0"}, "to": {}},
            {"id": "w1", "from": {"block": "s", "port": "in11"}, "to": {}},
            {"id": "w2", "from": {"block": "s", "port": "out"}, "to": {}},
        ],
    }
    assert_ports_are_declared(model, declared)

    # The template's name alone is not a port, and neither is a non-numeric
    # suffix -- or the rule would accept anything starting with "in".
    for port in ("in", "input", "inx"):
        bad = {
            "blocks": model["blocks"],
            "wires": [{"id": "w", "from": {"block": "s", "port": port}, "to": {}}],
        }
        with pytest.raises(ValueError, match="undeclared-port"):
            assert_ports_are_declared(bad, declared)


# ---------------------------------------------------------------------------
# With the real engine catalogue.
# ---------------------------------------------------------------------------


@pytest.fixture
def declared() -> dict[str, set[str]]:
    gsim_py = pytest.importorskip("gsim_py", reason="gsim_py is a maturin build, installed by hand")
    return declared_ports_from_catalog(json.loads(gsim_py.catalog()))


def test_the_engine_declares_p_and_n_not_p1_and_p2(declared: dict[str, set[str]]) -> None:
    """The premise of the fix, asserted rather than assumed.

    If gsim-core ever goes back to `p1`/`p2`, deleting the respelling was wrong
    and this says so directly -- instead of the examples failing to compile and
    someone rediscovering the whole story.
    """
    for type_id in ("passive.resistor", "passive.inductor", "passive.capacitor"):
        assert declared[type_id] == {"p", "n"}, type_id
    assert declared["routing.ground"] == {"gnd"}


@pytest.mark.parametrize(
    "name", ["buck_converter", "boost_converter", "pfc_boost", "llc_converter", "psfb_converter"]
)
def test_every_shipped_example_wires_only_declared_ports(
    name: str, declared: dict[str, set[str]]
) -> None:
    document = json.loads((EXAMPLES / f"{name}.gsim_sch").read_text())
    assert_ports_are_declared(document["model"], declared)


@pytest.mark.parametrize("fixture", sorted(p.name for p in FIXTURE_MODELS.glob("*.gsim")))
def test_every_test_fixture_wires_only_declared_ports(
    fixture: str, declared: dict[str, set[str]]
) -> None:
    """The fixtures are documents too, and one of them was stale.

    `rc_circuit.gsim` was generated while the respelling was in force, so it
    held `r1.p1`, `c1.p2` and `gnd.p`. Nothing noticed, because the only test
    using it passes in CI by a different route: with no `gsim_py` installed the
    kernel answers `SolverUnavailable`, which is one of the two outcomes that
    test accepts.
    """
    document = json.loads((FIXTURE_MODELS / fixture).read_text())
    assert_ports_are_declared(document.get("model", document), declared)


def test_prepare_document_wraps_a_bare_model() -> None:
    """The one thing preparation still does, pinned so the next reader sees it."""
    from simulator.compiler.compile_input import SCHEMA_VERSION, prepare_document

    bare = {"id": "m", "blocks": [], "wires": []}
    prepared = prepare_document(bare)
    assert prepared == {"schema_version": SCHEMA_VERSION, "model": bare}
    assert "schema_version" not in bare, "the input must not be modified"

    already = {"schema_version": 2, "model": bare}
    assert prepare_document(already) == already


def test_prepare_document_moves_no_port() -> None:
    """The gate's premise, as a unit test that needs nothing installed.

    `scripts/check-examples.mjs` asks its question of `prepare_document`'s
    output. That is only worth anything if preparation is where any transform
    lives -- so this states the current answer directly: it moves nothing.
    """
    from simulator.compiler.compile_input import prepare_document

    model = json.loads(json.dumps(BUCK_FRAGMENT))
    model["blocks"].append({"id": "gnd", "type": "routing.ground"})
    model["wires"].append(
        {"id": "w2", "from": {"block": "l1", "port": "n"}, "to": {"block": "gnd", "port": "gnd"}}
    )

    prepared = prepare_document(model)

    assert_ports_are_declared(prepared["model"], {**DECLARED, "routing.ground": {"gnd"}})
    assert prepared["model"]["wires"] == model["wires"]


def test_the_compile_bridge_leaves_ports_alone(declared: dict[str, set[str]]) -> None:
    """The real path, for machines that have `gsim-tools`.

    This asks the question *where the compiler asks it*: on whatever text the
    bridge hands to `Schematic.load`. Re-running the transforms this test knows
    about would miss a transform added later, and a transform nobody was looking
    at is exactly how #143 shipped.
    """
    pytest.importorskip("gsim_tools", reason="gsim-tools is not installed here")
    from gsim_tools import schematic as gsim_tools_schematic

    from simulator.compiler.gsim_py_netlist import compile_gsim_document_full

    handed_over: list[dict] = []
    original = gsim_tools_schematic.Schematic.load

    def capturing_load(text: str):  # type: ignore[no-untyped-def]
        handed_over.append(json.loads(text))
        return original(text)

    gsim_tools_schematic.Schematic.load = staticmethod(capturing_load)  # type: ignore[method-assign]
    try:
        document = json.loads((EXAMPLES / "buck_converter.gsim_sch").read_text())
        try:
            compile_gsim_document_full(document)
        except Exception:
            # Whether it compiles is the next test's business. This one only
            # wants the document the compiler was given.
            pass
    finally:
        gsim_tools_schematic.Schematic.load = original  # type: ignore[method-assign]

    assert handed_over, "the bridge never called Schematic.load"
    assert_ports_are_declared(handed_over[-1]["model"], declared)


def test_a_catalogue_spelled_document_compiles(declared: dict[str, set[str]]) -> None:
    """And it reaches a netlist, which is what the user actually wanted."""
    pytest.importorskip("gsim_tools", reason="gsim-tools is not installed here")
    from simulator.compiler.gsim_py_netlist import compile_gsim_document_full

    document = json.loads((EXAMPLES / "buck_converter.gsim_sch").read_text())
    netlist, _notes = compile_gsim_document_full(document)
    assert [line for line in netlist.splitlines() if line.strip()], "compiled to nothing"

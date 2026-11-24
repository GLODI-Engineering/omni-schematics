"""Everything done to a document *before* the compiler sees it, and the check
that it was not damaged on the way.

Kept in its own module, importing nothing, for one reason: the gate that needs
it runs where `gsim_tools` is not installed. `gsim_py_netlist` imports
`gsim_tools` at module scope, so importing *that* module in CI is impossible,
and a check nobody can run is not a check — which is the whole history of #143.

The division of labour is the point. Every transform on the way in belongs in
`prepare_document` here, never inline in `gsim_py_netlist`, because this module
is the part `scripts/check-examples.mjs` can run. A transform added on the far
side of that line is invisible to the gate again, and the next #143 is free to
happen.

#143, in one line: `gsim_py_netlist` used to respell four types' port ids on the
way into the compiler, bridging a divergence between gsim-core's compile registry
and the frontend catalogue. gsim-core later changed to agree with the frontend,
and from then on the bridge was the only thing disagreeing with either. It
rewrote `l1.p` to `l1.p1`, a port that does not exist, so every document holding
a resistor, capacitor, inductor or ground failed to compile with
`floating-port` naming a port that was wired perfectly well.

What let it live was not subtlety. `scripts/check-examples.mjs` compiles with
`gsim_py` directly — on the belief that `gsim-tools` was private and a gate
needing it would run on one machine, which was never true (#147) — so the gate
and the product reached the
compiler by two different routes, and a transform on only one route is invisible
by construction. This module is the thing that looks.
"""

from __future__ import annotations

from typing import Any

__all__ = [
    "VARIADIC_PREFIXES",
    "assert_ports_are_declared",
    "declared_ports_from_catalog",
    "prepare_document",
]

#: The document schema `gsim_py.load_document` expects.
SCHEMA_VERSION = 2


def prepare_document(gsim_doc: dict[str, Any]) -> dict[str, Any]:
    """The document, in the shape the compiler is given.

    Today that means one thing: wrapping a bare model. `gsim_py.load_document`
    (via `gsim_tools.schematic.Schematic.load`) wants the full
    `{"schema_version": 2, "model": {...}}` document, while the IPC `simulate`
    payload's `model` field is the bare model -- `apps/frontend/src/shell/run.ts`
    sends `useGraphStore.getState().document.model`, deliberately the inner model
    and not the wrapping document. Doing it here rather than in every caller is
    what keeps that distinction in one place.

    It used to mean a second thing, and that is why this function exists as a
    named, testable step rather than three lines inside the bridge: see the note
    on #143 at the top of this module.

    Returns a new dict; the input is not modified.
    """
    from copy import deepcopy

    doc = deepcopy(gsim_doc)
    if "schema_version" in doc and "model" in doc:
        return doc
    return {"schema_version": SCHEMA_VERSION, "model": doc}


#: Types whose ports are generated from a template, by type key to template
#: prefixes. Module state rather than a second return value, so
#: `declared_ports_from_catalog`'s signature stays the one callers already use.
VARIADIC_PREFIXES: dict[str, set[str]] = {}


def declared_ports_from_catalog(catalog: dict[str, Any]) -> dict[str, set[str]]:
    """Map each component id in `gsim_py.catalog()` to the port ids it declares.

    The catalogue splits a component's ports into `inputs` and `outputs`, which
    is a drawing distinction: a wire endpoint names a port id and does not say
    which side it came from. So both lists are merged.

    Keyed by `id` *and* by `type` when the entry carries one, because a document
    may legitimately spell either — `routing.ground` and
    `physical-electrical.reference.ground` are the same component.

    **Variadic ports appear in neither list.** `control.sum` declares no
    `inputs` at all and carries `variadic_inputs: {count_from: "signs",
    template: {id: "in", ...}}` instead; a real sheet wires `in0`, `in1`, …. How
    many there are depends on a parameter this function never sees, so rather
    than guess, the template's id is recorded in :data:`VARIADIC_PREFIXES` and
    :func:`assert_ports_are_declared` accepts `<prefix><digits>` for that type.
    Found by a fixture, not by reasoning: without it a perfectly good
    `b-sum.in0` reads as undeclared, and a check that cries wolf gets deleted.
    """
    declared: dict[str, set[str]] = {}
    for component in catalog.get("components", []):
        ports = component.get("ports") or {}
        ids = {
            port["id"]
            for side in ("inputs", "outputs")
            for port in ports.get(side, []) or []
            if isinstance(port, dict) and "id" in port
        }
        prefixes: set[str] = set()
        for side in ("variadic_inputs", "variadic_outputs"):
            template = (ports.get(side) or {}).get("template") or {}
            if isinstance(template, dict) and template.get("id"):
                prefixes.add(str(template["id"]))
        if not ids and not prefixes:
            continue
        for key in (component.get("id"), component.get("type")):
            if key:
                declared.setdefault(str(key), set()).update(ids)
                if prefixes:
                    VARIADIC_PREFIXES.setdefault(str(key), set()).update(prefixes)
    return declared


def assert_ports_are_declared(model: dict[str, Any], declared: dict[str, set[str]]) -> None:
    """Raise `ValueError` if a wire endpoint names a port its type does not have.

    `declared` comes from :func:`declared_ports_from_catalog`. It is passed in
    rather than read here so this module imports nothing: a test can hand it a
    catalogue of two components and assert the failure directly.

    A type absent from `declared` is skipped, not failed. A document may hold a
    subsystem, or a type a given catalogue build does not know, and failing those
    here would quietly turn this into a second and worse catalogue check — the
    question being asked is only "did something rewrite a wire onto a port that
    does not exist".
    """
    types = {
        block.get("id"): block.get("type", "")
        for block in model.get("blocks", [])
        if isinstance(block, dict)
    }
    for wire in model.get("wires", []):
        if not isinstance(wire, dict):
            continue
        for end in ("from", "to"):
            endpoint = wire.get(end)
            if not isinstance(endpoint, dict):
                continue
            block_type = types.get(endpoint.get("block"), "")
            ports = declared.get(block_type)
            port = endpoint.get("port")
            if ports is None or port in ports:
                continue
            if _matches_a_variadic_template(block_type, port):
                continue
            raise ValueError(
                f"undeclared-port: wire {wire.get('id')!r} names port {port!r} on block "
                f"{endpoint.get('block')!r} of type {block_type!r}, which declares "
                f"{sorted(ports)}. Either the document is wrong, or something between "
                "it and the compiler has rewritten a wire onto a port the engine does "
                "not have (#143)."
            )


def _matches_a_variadic_template(block_type: str, port: Any) -> bool:
    """`in0` on a `control.sum`: generated from a template, not listed."""
    if not isinstance(port, str):
        return False
    for prefix in VARIADIC_PREFIXES.get(block_type, ()):
        rest = port[len(prefix) :]
        if port.startswith(prefix) and rest.isdigit():
            return True
    return False

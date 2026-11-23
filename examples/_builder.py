"""Shared helpers for authoring the example schematics.

Why this exists rather than hand-written JSON: the first version of
`build_buck_converter.py` computed every terminal coordinate by hand from the
renderer's geometry, and the result was a document that drifted out of step
with the engine without anything noticing -- it used a block type
(`passive.switch.voltage`) the engine had stopped declaring, and two more
spellings the netlist emitter rejects.

So these helpers ask the engine for everything it can answer:

* `defaults_for` reads the required parameters and their defaults out of
  `gsim_py.catalog()`, so an example states only the values that make it the
  circuit it is -- 48 V in, 100 uH -- and inherits the rest. A parameter added
  to a component upstream therefore does not break every example.
* `add` fills those defaults in and passes the paradigm and domain the engine
  declares, instead of each script repeating them.
* placement and routing come from `Schematic.auto_arrange`.

Canonical names only. An alias such as `physical-electrical.source.voltage_dc`
resolves in the catalogue and in the symbol registry, and is then **rejected by
the netlist emitter** -- which is how an example could look correct in the
palette and fail to compile.
"""

from __future__ import annotations

import functools
import json
from typing import Any

import gsim_py

#: Paradigm and domain per component, as the engine declares them. Passed on
#: every `add` because `Schematic.add` has no default for most types and raises
#: rather than guessing -- which is the right behaviour, just verbose.
_PLACEMENT_KEYS = ("paradigm", "domain")


@functools.lru_cache(maxsize=1)
def catalog() -> dict[str, dict[str, Any]]:
    """The engine's component catalogue, keyed by canonical id."""
    raw = json.loads(gsim_py.catalog())
    return {entry["id"]: entry for entry in raw["components"]}


def defaults_for(type_name: str) -> dict[str, Any]:
    """Every parameter the engine declares for a type, at its default value.

    The emitter requires all of them, not just the interesting ones: omitting
    one fails with `missing-param: block 'sw' is missing required parameter
    'body_g_breakdown'`, which is a true complaint about a document that an
    example has no business making the reader solve.
    """
    entry = catalog().get(type_name)
    if entry is None:
        raise KeyError(
            f"{type_name!r} is not in the engine catalogue. "
            "Example schematics use canonical names only, never aliases."
        )
    fidelities = entry.get("fidelities") or []
    params: dict[str, Any] = {}
    for fidelity in fidelities[:1]:
        for param in fidelity.get("params") or []:
            if "default" in param:
                params[param["id"]] = param["default"]
    return params


def placement_for(type_name: str) -> dict[str, str]:
    """The paradigm and domain the engine declares for a type."""
    entry = catalog().get(type_name)
    if entry is None:
        raise KeyError(f"{type_name!r} is not in the engine catalogue")
    return {key: entry[key] for key in _PLACEMENT_KEYS if entry.get(key)}


def add(sheet, type_name: str, block_id: str, **overrides: Any):
    """Add a block with the engine's declared defaults, overridden as given.

    Unknown parameter names are rejected here rather than silently ignored: a
    typo in an example's value would otherwise produce a circuit that compiles
    and simulates the wrong thing, which is worse than one that does not build.
    """
    params = defaults_for(type_name)
    unknown = set(overrides) - set(params)
    if unknown and params:
        raise KeyError(
            f"{type_name} has no parameter(s) {sorted(unknown)}; it declares {sorted(params)}"
        )
    params.update(overrides)
    return sheet.add(type_name, id=block_id, params=params, **placement_for(type_name))

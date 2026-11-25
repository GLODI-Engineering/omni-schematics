"""A circuit-element model either solves, or says which component is missing.

Originally BE-23/BE-28, written when this repository could target ngspice or Xyce: the
contract was "status=ok if a SPICE simulator is installed, else an error naming it".
Those backends are gone -- general-simulator is the only one -- so the surviving contract
is the useful half: the reply is either a real solve, or an error that names the missing
piece rather than being opaque.

What is sent is netlist text (#158). The kernel does not compile: the editor does,
with `gsim-core` built to WebAssembly. So this test does not need an engine binding
at all -- it takes a netlist from `examples/expected-netlists/`, which a gate holds
to the byte, and the reply is either a solve or a named missing piece.

Before that it sent a document, and before *that* the document was a literal in this
file: a schema_version 1 model that no reader accepts (there is no v1 reader, by
design), with no `paradigm` on its blocks, no `kind` on its wires, no ground, and the
catalogue's `p`/`n` port spelling for two-pin passives where the compiler wanted
`p1`/`p2` (GLODI-Engineering/gsim-core#4). Each step moved the thing under test closer
to the thing the product does.
"""

from __future__ import annotations

import asyncio
import json
import pathlib

import pytest

from tests.backend.e2e._ws_helpers import recv_json

pytestmark = pytest.mark.asyncio


REPO_ROOT = pathlib.Path(__file__).parents[3]
NETLIST = REPO_ROOT / "examples" / "expected-netlists" / "buck_converter.net"


async def test_circuit_element_result_is_ok_or_no_simulator(e2e_server: dict) -> None:
    """
    BE-28 contract: a circuit-element model either:
    a) completes successfully (status="ok") when a SPICE simulator is installed, or
    b) fails with "No SPICE simulator found" (status="error") when none is installed.

    The old "Phase 2" error message is no longer acceptable.
    """
    import websockets

    uri = e2e_server["ws_uri"]
    token = e2e_server["token"]

    async with websockets.connect(uri) as ws:
        await ws.send(json.dumps({"id": "hs", "type": "handshake", "payload": {"token": token}}))
        await ws.recv()

        await ws.send(
            json.dumps(
                {
                    "id": "circuit-sim-28",
                    "type": "simulate",
                    "payload": {
                        "netlist": NETLIST.read_text(encoding="utf-8"),
                        "options": {"t_start": 0.0, "t_end": 1e-3, "n_samples": 100},
                    },
                }
            )
        )

        deadline = asyncio.get_event_loop().time() + 15.0
        result_msg = None
        while True:
            remaining = deadline - asyncio.get_event_loop().time()
            assert remaining > 0, "Timed out waiting for simulate_result"
            msg = await recv_json(ws, timeout=min(remaining, 3.0))
            if msg["type"] == "simulate_result":
                result_msg = msg
                break

    assert result_msg is not None
    payload = result_msg["payload"]
    status = payload.get("status")

    if status == "ok":
        # A SPICE simulator was found and the simulation ran.
        assert "sim_id" in payload or "signals" in payload, (
            f"status=ok but no sim_id/signals in payload: {payload}"
        )
    elif status == "error":
        # No solver installed — the message must name which one is missing, and
        # must not mention Phase 2.
        error_text = json.dumps(payload).lower()
        assert "phase 2" not in error_text, (
            f"Error must not mention 'Phase 2' after BE-28: {error_text}"
        )
        # The assertion's point is that the reply says *which* component is
        # missing rather than being opaque, so the vocabulary follows what can
        # actually be missing. Since #158 that is one thing -- the
        # `general-simulator` binary -- because the compiler ships with the
        # editor and cannot be absent from a kernel that never had it.
        named = ("spice", "ngspice", "xyce", "simulator", "gsim")
        assert any(word in error_text for word in named), (
            f"Error message names no solver (expected one of {named}): {error_text}"
        )
    else:
        pytest.fail(f"Unexpected simulate_result status {status!r}: {payload}")

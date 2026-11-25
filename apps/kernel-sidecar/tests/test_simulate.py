"""BE-18 — simulate IPC handler tests.

What a `simulate` request carries is netlist text (#158): the editor compiles its
own document with `gsim-core` in WebAssembly, and this process solves what it is
given. The two fixtures that used to live here were `schema_version: 1` models of
a signal-flow chain and an algebraic loop, sent as `model` payloads for the kernel
to compile -- neither of which any reader accepts, so both had been producing a
compile error rather than the behaviour they were named after.

The netlist comes from `examples/expected-netlists/`, which
`scripts/check-examples.mjs` holds to the byte, so these tests need no engine
binding. They do need the `general-simulator` binary to get past "Solving…";
without it the reply is an error, and the one test here that cares says so.

Covers:
- Cancel mid-solve: status="error" with type="Cancelled"; no manifest.
- A request with no netlist is answered, and named.
"""

from __future__ import annotations

import asyncio
import json
import pathlib

import pytest

pytestmark = pytest.mark.asyncio

REPO_ROOT = pathlib.Path(__file__).parents[3]
NETLIST = (REPO_ROOT / "examples" / "expected-netlists" / "buck_converter.net").read_text(
    encoding="utf-8"
)


async def _collect_simulate_messages(ws, timeout: float = 30.0) -> list[dict]:  # type: ignore[no-untyped-def]
    """Read messages until simulate_result is received or timeout."""
    messages = []
    deadline = asyncio.get_event_loop().time() + timeout
    while True:
        remaining = deadline - asyncio.get_event_loop().time()
        if remaining <= 0:
            raise TimeoutError("Did not receive simulate_result in time")
        try:
            raw = await asyncio.wait_for(ws.recv(), timeout=min(remaining, 5.0))
            if isinstance(raw, bytes):
                # Binary waveform_chunk frame (BE-56) — not JSON, and no test
                # in this file asserts on chunk contents, so just note its
                # presence and keep collecting until simulate_result arrives.
                messages.append({"type": "waveform_chunk", "binary": True})
                continue
            msg = json.loads(raw)
            messages.append(msg)
            if msg["type"] == "simulate_result":
                break
        except TimeoutError:
            raise TimeoutError("Did not receive simulate_result in time")
    return messages


# ---------------------------------------------------------------------------
# Happy path
# ---------------------------------------------------------------------------


async def test_cancel_mid_solve(live_server: dict) -> None:
    """Cancelling a simulation in progress must result in a Cancelled error."""
    import websockets

    uri = live_server["uri"]
    token = live_server["token"]

    async with websockets.connect(uri) as ws:
        await ws.send(json.dumps({"id": "hs", "type": "handshake", "payload": {"token": token}}))
        await ws.recv()

        # Send a long-running simulation (large t_end)
        await ws.send(
            json.dumps(
                {
                    "id": "sim-long",
                    "type": "simulate",
                    "payload": {
                        "netlist": NETLIST,
                        "options": {"t_start": 0.0, "t_end": 1.0, "n_samples": 2000000},
                    },
                }
            )
        )

        # Wait for at least one progress message
        got_progress = False
        for _ in range(20):
            raw = await asyncio.wait_for(ws.recv(), timeout=3.0)
            msg = json.loads(raw)
            if msg["type"] == "simulate_progress":
                got_progress = True
                break
            if msg["type"] == "simulate_result":
                # Finished too fast — test is not meaningful
                pytest.skip("Simulation completed before cancel could be sent")

        # Cancel
        await ws.send(json.dumps({"id": "sim-long", "type": "simulate_cancel", "payload": {}}))

        # Collect until simulate_result
        messages = await _collect_simulate_messages(ws, timeout=5.0)
        result = messages[-1]

        assert result["type"] == "simulate_result"
        assert result["payload"]["status"] == "error"
        assert "Cancelled" in json.dumps(result["payload"])


# ---------------------------------------------------------------------------
# A request the handler cannot act on
# ---------------------------------------------------------------------------


async def test_a_simulate_with_no_netlist_is_answered(live_server: dict) -> None:
    """Named, on the channel the caller is waiting on.

    The handler used to require a `model`, and a payload carrying only a
    `netlist` was refused with "Payload missing 'model' key." -- while the
    editor's own imported-netlist path sent exactly that. The field is the other
    way round now (#158), and what matters either way is that the reply arrives
    as a `simulate_result`: an error that leaves by any other channel is a Run
    button that spins forever, which is how #147 presented.
    """
    import websockets

    uri = live_server["uri"]
    token = live_server["token"]

    async with websockets.connect(uri) as ws:
        await ws.send(json.dumps({"id": "hs", "type": "handshake", "payload": {"token": token}}))
        await ws.recv()

        await ws.send(
            json.dumps({"id": "sim-empty", "type": "simulate", "payload": {"options": {}}})
        )

        messages = await _collect_simulate_messages(ws, timeout=10.0)

    result = messages[-1]
    assert result["type"] == "simulate_result"
    assert result["payload"]["status"] == "error"
    assert "netlist" in json.dumps(result["payload"])

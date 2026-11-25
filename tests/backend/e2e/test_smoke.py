"""BE-23 — End-to-end smoke test.

Spins up the kernel-sidecar in-process and drives the whole simulate pipeline:
handshake, simulate, progress frames, result, manifest over HTTP, each signal
slice fetched back.

**What it sends is netlist text** (#158). It used to send the canonical
step → pid → integrator → scope `.gsim` fixture as a `model` payload and
compare the result against `reference/step_pid_integrator_scope.npz` — the
backend v1 acceptance gate. That fixture is `schema_version: 1`, which the
engine's `load_document` rejects outright, so the comparison had already
stopped happening the moment the kernel started compiling through gsim-core;
and the kernel does not compile at all now. The netlist comes from
`examples/expected-netlists/`, which is a real netlist that a gate holds to a
byte, so this test needs neither an engine binding nor a fixture of its own.

The reference comparison is not reinstated here — a new reference has to be
generated for whatever circuit replaces the v1 fixture, which is its own job.
What is asserted is the pipeline: progress arrives, the result is ok, the
manifest is fetchable, and every signal it lists can be read back as an array.
"""

from __future__ import annotations

import asyncio
import json
import pathlib
import urllib.request

import numpy as np
import pytest

from tests.backend.e2e._ws_helpers import recv_json

pytestmark = pytest.mark.asyncio

REPO_ROOT = pathlib.Path(__file__).parents[3]
NETLIST_FILE = REPO_ROOT / "examples" / "expected-netlists" / "buck_converter.net"


# ---------------------------------------------------------------------------
# Happy-path smoke
# ---------------------------------------------------------------------------


async def test_smoke_e2e(e2e_server: dict, requires_general_simulator: None) -> None:
    """
    Full pipeline:
    1. Connect + handshake.
    2. Send simulate with netlist text.
    3. Collect simulate_progress + simulate_result.
    4. Fetch manifest over HTTP.
    5. Fetch each signal slice and read it back as an array.
    """
    import websockets

    uri = e2e_server["ws_uri"]
    token = e2e_server["token"]
    http_base = e2e_server["http_base"]

    netlist = NETLIST_FILE.read_text(encoding="utf-8")

    async with websockets.connect(uri) as ws:
        # Handshake
        await ws.send(json.dumps({"id": "hs", "type": "handshake", "payload": {"token": token}}))
        hs_reply = await recv_json(ws, timeout=5.0)
        assert hs_reply["type"] == "kernel_status"
        assert hs_reply["payload"]["state"] == "idle"

        # Simulate
        await ws.send(
            json.dumps(
                {
                    "id": "smoke-sim",
                    "type": "simulate",
                    "payload": {
                        "netlist": netlist,
                        "options": {"t_start": 0.0, "t_end": 1e-3, "n_samples": 3000},
                    },
                }
            )
        )

        # Collect messages
        result_msg = None
        progress_count = 0
        deadline = asyncio.get_event_loop().time() + 30.0

        while True:
            remaining = deadline - asyncio.get_event_loop().time()
            assert remaining > 0, "Timed out waiting for simulate_result"
            msg = await recv_json(ws, timeout=min(remaining, 5.0))
            if msg["type"] == "simulate_progress":
                progress_count += 1
                frac = msg["payload"].get("frac", -1)
                assert 0.0 <= frac <= 1.0, f"Progress frac out of range: {frac}"
            elif msg["type"] == "simulate_result":
                result_msg = msg
                break

    assert result_msg is not None
    payload = result_msg["payload"]
    assert payload["status"] == "ok", f"Simulate failed: {payload}"
    assert progress_count > 0, "No simulate_progress messages received"

    sim_id = payload["sim_id"]
    signals_info = payload["signals"]
    assert len(signals_info) > 0

    # Fetch manifest
    manifest_url = f"{http_base}/results/{sim_id}/manifest.json?token={token}"
    with urllib.request.urlopen(manifest_url, timeout=10) as resp:
        manifest = json.loads(resp.read().decode("utf-8"))
    assert manifest["sim_id"] == sim_id
    assert manifest["status"] == "ok"

    # Every signal the manifest lists is fetchable and parses as an array. Not a
    # numerical gate -- see the module doc on the reference that is not here.
    for sig in manifest["signals"]:
        sig_url = f"{http_base}{sig['url']}?token={token}"
        with urllib.request.urlopen(sig_url, timeout=10) as resp:
            raw_bytes = resp.read()

        import io

        actual = np.load(io.BytesIO(raw_bytes))
        assert actual.size > 0, f"signal {sig['name']!r} came back empty"


async def test_smoke_completes_under_30s(
    e2e_server: dict, requires_general_simulator: None
) -> None:
    """The full smoke test must run in under 30 s wall time."""
    import time

    import websockets

    netlist = NETLIST_FILE.read_text(encoding="utf-8")
    uri = e2e_server["ws_uri"]
    token = e2e_server["token"]

    t0 = time.monotonic()
    async with websockets.connect(uri) as ws:
        await ws.send(json.dumps({"id": "hs", "type": "handshake", "payload": {"token": token}}))
        await ws.recv()

        await ws.send(
            json.dumps(
                {
                    "id": "perf-sim",
                    "type": "simulate",
                    "payload": {
                        "netlist": netlist,
                        "options": {"t_start": 0.0, "t_end": 1e-3, "n_samples": 3000},
                    },
                }
            )
        )

        deadline = asyncio.get_event_loop().time() + 30.0
        while True:
            remaining = deadline - asyncio.get_event_loop().time()
            assert remaining > 0, "Smoke test exceeded 30 s wall time"
            msg = await recv_json(ws, timeout=min(remaining, 5.0))
            if msg["type"] == "simulate_result":
                break

    elapsed = time.monotonic() - t0
    assert elapsed < 30.0, f"Smoke test took {elapsed:.1f}s; must be under 30s"

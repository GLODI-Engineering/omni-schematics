"""WebSocket server — main event loop (BE-02, BE-03).

Binds to 127.0.0.1 only. Accepts one connection at a time.
Prints ``KERNEL_READY port=<n> token=<hex> protocol=<n>`` to stdout after
binding.
"""

from __future__ import annotations

import asyncio
import logging
import os
import pathlib
from typing import Any

logger = logging.getLogger(__name__)

#: IPC protocol version announced in the KERNEL_READY handshake.
#:
#: Added with omni-schematics#134, which lets a user point the editor at a Python
#: environment they prepared themselves instead of one the editor builds from a
#: checkout. That decouples this package's version from the editor's, so the
#: handshake has to state what it speaks or a mismatched environment fails in
#: ways that look like editor bugs.
#:
#: It versions the *protocol*, not this package: package versions drift for
#: reasons that do not change the wire contract, and a check that fired on those
#: would be noise. Bump this and ``KERNEL_PROTOCOL_VERSION`` in
#: ``apps/vscode-extension/src/kernel-core.ts`` together, and only on an
#: incompatible change.
KERNEL_PROTOCOL_VERSION = 1

# Ruff guard: 0.0.0.0 must never appear in this file's bind call.
# (The ruff rule catches it at lint time; this comment documents the intent.)
_BIND_HOST = "127.0.0.1"


class _KernelContext:
    """Shared state passed to every IPC handler."""

    def __init__(self, token: str, workdir: str) -> None:
        self.token = token
        self.workdir = workdir
        # Active simulate cancel tokens keyed by request id.
        self.simulate_tokens: dict[str, Any] = {}
        self.simulate_tasks: dict[str, Any] = {}
        # Simulation health tracking.
        self.sim_progress: float = 0.0
        self.sim_message: str = ""
        self.sim_started_at: float | None = None


def _build_dispatcher(ctx: _KernelContext) -> Any:
    from kernel_sidecar.ipc.dispatch import Dispatcher
    from kernel_sidecar.ipc.envelope import MessageType
    from kernel_sidecar.ipc.handlers.simulate import handle_simulate, handle_simulate_cancel

    d = Dispatcher()
    d.register(MessageType.SIMULATE, handle_simulate)
    d.register(MessageType.SIMULATE_CANCEL, handle_simulate_cancel)
    return d


async def _connection_handler(
    websocket: Any,
    ctx: _KernelContext,
    dispatcher: Any,
    connected: list[bool],
) -> None:
    import websockets.exceptions

    from kernel_sidecar.ipc.envelope import Message

    # Single-connection rule: reject second client.
    if connected[0]:
        logger.warning("Rejecting second WebSocket connection (single-connection kernel).")
        await websocket.close(4000, "Single-connection kernel")
        return

    connected[0] = True
    try:
        # Handshake.
        from kernel_sidecar.ipc.handshake import verify_handshake

        logger.info("Client connected, verifying handshake…")
        ok = await verify_handshake(websocket, ctx.token)
        if not ok:
            logger.warning("Handshake failed — disconnecting client.")
            return
        logger.info("Handshake OK — entering message loop.")

        # Message loop.
        async for raw in websocket:
            if isinstance(raw, bytes):
                logger.debug("Received binary frame (unexpected in text loop)")
                continue
            try:
                msg = Message.from_json(raw)
            except Exception:
                logger.warning("Failed to parse message: %r", raw[:200])
                continue
            logger.debug("RX: type=%s id=%s", msg.type, msg.id)
            await dispatcher.dispatch(websocket, msg, ctx)

    except websockets.exceptions.ConnectionClosed as exc:
        logger.info("Connection closed: %s", exc)
    except Exception:
        logger.exception("Unexpected error in connection handler")
    finally:
        connected[0] = False


async def run_server(
    port: int = 0,
    token: str = "",
    workdir: str | None = None,
    connect_timeout: float = 0.0,
) -> None:
    """Start the WebSocket server and block until the process is killed.

    Args:
        connect_timeout: If > 0, exit cleanly if no client connects within
            this many seconds after the server starts listening.
    """
    from websockets.asyncio.server import serve as _ws_serve

    if workdir is None:
        xdg = os.environ.get("XDG_DATA_HOME")
        if xdg:
            workdir = str(pathlib.Path(xdg) / "general-simulator" / "sidecar-workdir")
        else:
            workdir = str(
                pathlib.Path.home() / ".local" / "share" / "general-simulator" / "sidecar-workdir"
            )

    ctx = _KernelContext(token=token, workdir=workdir)
    dispatcher = _build_dispatcher(ctx)
    connected: list[bool] = [False]
    # No HTTP surface. The sidecar used to intercept plain HTTP requests here
    # and serve `/results/<sim_id>/lod` and `/results/<sim_id>/<signal>.npy`
    # out of an HDF5 file, which was the only way a viewer could see a window
    # of a long run. It is not any more: the solver writes a `.gsim_samples`
    # container, the viewer reads byte ranges of it through the extension host
    # and decimates them with `crates/waveform-store` compiled to WebAssembly
    # (#157). Binary LOD frames therefore leave this file along with the three
    # Python implementations of the decimation behind them.

    async def handler(ws: Any) -> None:
        await _connection_handler(ws, ctx, dispatcher, connected)

    async with _ws_serve(handler, _BIND_HOST, port) as server:
        bound_port = server.sockets[0].getsockname()[1]
        # Print the KERNEL_READY signal for the host to parse. `protocol` lets a
        # host reject an environment prepared for a different release (#134); a
        # host that does not know the field ignores it.
        print(
            f"KERNEL_READY port={bound_port} token={token} protocol={KERNEL_PROTOCOL_VERSION}",
            flush=True,
        )
        logger.info("Kernel listening on %s:%d", _BIND_HOST, bound_port)

        if connect_timeout > 0:
            # Exit if no client connects within the timeout window.
            await asyncio.sleep(connect_timeout)
            if not connected[0]:
                logger.info("No client connected within %.1fs; exiting.", connect_timeout)
                return
            # Client connected — run until disconnected.
            while connected[0]:
                await asyncio.sleep(0.1)
        else:
            await asyncio.Future()  # Run forever.

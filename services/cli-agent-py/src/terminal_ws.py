"""WS → PTY bridge: /terminal/{terminal_id}?target=main|shell&cols=&rows=.

Wire convention MUST match the existing web client
(src/lib/components/sandbox/sandbox-terminal.svelte + the BFF's
src/lib/server/ws-terminal-proxy.ts pass-through):
  - binary frames = raw terminal bytes, both directions (xterm.js AttachAddon);
  - TEXT frames starting with \\x01 carry JSON {"type":"resize","cols":N,"rows":N}
    (bare {cols,rows} tolerated);
  - other text frames are treated as input bytes.

Auth: header ``X-Internal-Token`` must equal env INTERNAL_API_TOKEN (the BFF
proxy injects it); otherwise close 4401.

target=main attaches a herdr client to the running default session (the claude
TUI keeps running when the attach client dies — herdr just detaches);
target=shell spawns a plain ``bash -l`` PTY directly in the pod (v1: no herdr
coupling for shell tabs).

NOTE: fastapi MUST be imported at module level here. This module uses
``from __future__ import annotations`` (string annotations), and FastAPI
resolves a handler's annotations against the function's MODULE globals — a
function-local ``from fastapi import WebSocket`` leaves the string
``"WebSocket"`` unresolvable, so FastAPI silently degrades the parameter to a
required QUERY field and every handshake is rejected 403 with a 1008
validation close (found live on ryzen, 2026-06-10).
"""

from __future__ import annotations

import asyncio
import fcntl
import json
import logging
import os
import pty
import signal
import struct
import subprocess
import termios
from typing import Any

from fastapi import WebSocket, WebSocketDisconnect

from src.session_supervisor import get_supervisor

logger = logging.getLogger(__name__)

# VERIFIED (live herdr 0.6.8, 2026-06-10): a bare `herdr` invocation ATTACHES
# to the server owning the socket resolved from HERDR_SOCKET_PATH (it does not
# start a second server when one is running). Caveat from the same smoke test:
# herdr refuses to attach when it detects it is running INSIDE a herdr pane
# ("nested herdr is disabled by default") — detection rides inherited HERDR_*
# env vars, so `_pty_env` strips every HERDR_* var except HERDR_SOCKET_PATH.
HERDR_ATTACH_ARGV = ["herdr"]
SHELL_ARGV = ["bash", "-l"]


def _resize_payload(text: str) -> tuple[int, int] | None:
    """Parse a resize control frame; tolerate {cols,rows} without type."""
    raw = text[1:] if text.startswith("\x01") else text
    try:
        obj = json.loads(raw)
    except (TypeError, ValueError):
        return None
    if not isinstance(obj, dict):
        return None
    if obj.get("type") not in (None, "resize"):
        return None
    cols, rows = obj.get("cols"), obj.get("rows")
    if isinstance(cols, (int, float)) and isinstance(rows, (int, float)):
        cols_i, rows_i = int(cols), int(rows)
        if cols_i > 0 and rows_i > 0:
            return cols_i, rows_i
    return None


def _set_winsize(fd: int, cols: int, rows: int) -> None:
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))


def _pty_env(target: str) -> dict[str, str]:
    socket_path = os.environ.get("HERDR_SOCKET_PATH", "")
    config_path = os.environ.get("HERDR_CONFIG_PATH", "")
    # Strip ALL inherited HERDR_* vars: pane-injected markers trigger herdr's
    # nested-attach refusal ("nested herdr is disabled by default"). Keep only
    # the socket (which server to attach to) + config-file path.
    env = {k: v for k, v in os.environ.items() if not k.startswith("HERDR_")}
    env["TERM"] = "xterm-256color"
    if socket_path:
        env["HERDR_SOCKET_PATH"] = socket_path
    if config_path:
        env["HERDR_CONFIG_PATH"] = config_path
    return env


def spawn_pty(target: str, cols: int, rows: int) -> tuple[subprocess.Popen, int]:
    """Spawn the attach/shell process on a fresh PTY; returns (proc, master_fd)."""
    argv = SHELL_ARGV if target == "shell" else HERDR_ATTACH_ARGV
    master_fd, slave_fd = pty.openpty()
    _set_winsize(slave_fd, cols, rows)

    def _preexec() -> None:  # pragma: no cover - child process
        os.setsid()
        fcntl.ioctl(slave_fd, termios.TIOCSCTTY, 0)

    proc = subprocess.Popen(
        argv,
        stdin=slave_fd,
        stdout=slave_fd,
        stderr=slave_fd,
        env=_pty_env(target),
        cwd=os.environ.get("AGENT_LOCAL_SANDBOX_ROOT", "/sandbox"),
        preexec_fn=_preexec,
        close_fds=True,
    )
    os.close(slave_fd)
    os.set_blocking(master_fd, False)
    return proc, master_fd


def kill_attach_client(proc: subprocess.Popen) -> None:
    """Kill ONLY the attach client process group (herdr detaches; the CLI in
    the herdr pane keeps running)."""
    if proc.poll() is not None:
        return
    try:
        os.killpg(proc.pid, signal.SIGHUP)
    except (ProcessLookupError, PermissionError):
        pass
    try:
        proc.wait(timeout=2)
    except subprocess.TimeoutExpired:
        try:
            os.killpg(proc.pid, signal.SIGKILL)
        except (ProcessLookupError, PermissionError):
            pass


def register_terminal_ws(app: Any) -> None:
    """Mount the /terminal/{terminal_id} WebSocket route on the FastAPI app."""

    @app.websocket("/terminal/{terminal_id}")
    async def terminal_ws(websocket: WebSocket, terminal_id: str) -> None:
        expected = os.environ.get("INTERNAL_API_TOKEN", "")
        provided = websocket.headers.get("x-internal-token", "")
        if not expected or provided != expected:
            await websocket.close(code=4401)
            return
        params = websocket.query_params
        target = params.get("target") or "main"
        if target not in ("main", "shell"):
            target = "main"

        def _int_param(name: str, default: int) -> int:
            try:
                value = int(params.get(name) or default)
            except (TypeError, ValueError):
                return default
            return value if value > 0 else default

        cols = _int_param("cols", 80)
        rows = _int_param("rows", 24)

        await websocket.accept()
        supervisor = get_supervisor()
        try:
            proc, master_fd = spawn_pty(target, cols, rows)
        except Exception as exc:  # noqa: BLE001
            logger.warning("[terminal] spawn failed (%s): %s", target, exc)
            await websocket.close(code=1011)
            return
        if supervisor is not None:
            supervisor.note_terminal_attached()

        loop = asyncio.get_running_loop()
        output_queue: asyncio.Queue[bytes | None] = asyncio.Queue()

        def _on_pty_readable() -> None:
            try:
                data = os.read(master_fd, 65536)
            except BlockingIOError:
                return
            except OSError:
                data = b""
            output_queue.put_nowait(data or None)
            if not data:
                loop.remove_reader(master_fd)

        loop.add_reader(master_fd, _on_pty_readable)

        async def _pump_output() -> None:
            while True:
                chunk = await output_queue.get()
                if chunk is None:
                    break
                await websocket.send_bytes(chunk)

        sender = asyncio.ensure_future(_pump_output())
        try:
            while True:
                message = await websocket.receive()
                if message.get("type") == "websocket.disconnect":
                    break
                data = message.get("bytes")
                if data:
                    if supervisor is not None:
                        supervisor.note_terminal_activity()
                    os.write(master_fd, data)
                    continue
                text = message.get("text")
                if text is None:
                    continue
                if text.startswith("\x01"):
                    # Control frame: {"type":"resize","cols":N,"rows":N}
                    # ({cols,rows} without type tolerated).
                    size = _resize_payload(text)
                    if size is not None:
                        _set_winsize(master_fd, size[0], size[1])
                    continue
                if supervisor is not None:
                    supervisor.note_terminal_activity()
                os.write(master_fd, text.encode("utf-8"))
        except WebSocketDisconnect:
            pass
        except Exception as exc:  # noqa: BLE001
            logger.debug("[terminal] ws loop ended: %s", exc)
        finally:
            sender.cancel()
            try:
                loop.remove_reader(master_fd)
            except Exception:  # noqa: BLE001
                pass
            try:
                os.close(master_fd)
            except OSError:
                pass
            kill_attach_client(proc)
            if supervisor is not None:
                supervisor.note_terminal_detached()

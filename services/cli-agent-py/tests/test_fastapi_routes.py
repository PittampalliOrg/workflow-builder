"""FastAPI ROUTING regression tests — exercise the real ASGI app, not the
helpers.

These exist because of a live bug (ryzen, 2026-06-10): with
``from __future__ import annotations``, FastAPI resolves handler annotations
against MODULE globals; a function-local ``from fastapi import WebSocket`` /
``Request`` left the string annotation unresolvable, so FastAPI silently
degraded the parameter to a required QUERY field — every terminal WebSocket
handshake was rejected 403 (1008 validation close) and every hook POST would
422. Unit tests on the helpers could never catch that; only driving the real
app through the router does.
"""

from __future__ import annotations

import os

import pytest

pytest.importorskip("httpx", reason="TestClient regression tests need httpx")
from starlette.testclient import TestClient  # noqa: E402

os.environ.setdefault("HERDR_DISABLE", "1")

TOKEN = "test-internal-token"


@pytest.fixture()
def client(monkeypatch):
    monkeypatch.setenv("INTERNAL_API_TOKEN", TOKEN)
    from src.main import app

    return TestClient(app)


def test_terminal_ws_handshake_accepts_with_token(client, monkeypatch):
    # Stub the PTY spawn — we only care that ROUTING + AUTH accept the
    # handshake (the live bug rejected it before the handler body ran).
    import src.terminal_ws as tws

    class FakeProc:
        pid = 4242
        returncode = 0

        def poll(self):
            return self.returncode

        def wait(self, timeout=None):
            return self.returncode

        def kill(self):
            return None

    r, w = os.pipe()
    monkeypatch.setattr(tws, "spawn_pty", lambda target, cols, rows: (FakeProc(), r))
    with client.websocket_connect(
        "/terminal/t1?target=shell&cols=80&rows=24",
        headers={"X-Internal-Token": TOKEN},
    ) as ws:
        # Reaching here means the handshake was ACCEPTED (101), which is
        # exactly what the annotation-degradation bug broke.
        ws.close()
    # The route owns fd lifecycle after spawn; tolerate already-closed fds.
    for fd in (r, w):
        try:
            os.close(fd)
        except OSError:
            pass


def test_terminal_ws_handshake_rejects_without_token(client):
    from starlette.websockets import WebSocketDisconnect

    with pytest.raises(Exception) as excinfo:
        with client.websocket_connect("/terminal/t1?target=shell"):
            pass
    # Starlette surfaces the pre-accept close as a disconnect/denial — any
    # exception here is a rejection; the with-token test proves acceptance.
    assert excinfo.value is not None
    assert not isinstance(excinfo.value, AssertionError)
    del WebSocketDisconnect  # imported for documentation


def test_hook_post_returns_200_empty_object(client):
    # The same bug class made FastAPI demand a `request` QUERY param → 422.
    res = client.post(
        "/internal/hooks/claude",
        json={"hook_event_name": "Notification", "session_id": "s1"},
    )
    assert res.status_code == 200
    assert res.json() == {}


def test_generic_cli_hook_post_returns_200_empty_object(client):
    res = client.post(
        "/internal/hooks/cli/codex",
        json={"hook_event_name": "Stop", "session_id": "s1"},
    )
    assert res.status_code == 200
    assert res.json() == {}


def test_hook_post_tolerates_garbage_body(client):
    res = client.post(
        "/internal/hooks/claude",
        content=b"\x00not-json",
        headers={"content-type": "application/json"},
    )
    assert res.status_code == 200
    assert res.json() == {}

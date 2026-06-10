"""HerdrClient tests against a fake asyncio Unix-socket NDJSON server."""

from __future__ import annotations

import asyncio
import json

import pytest

from src.herdr_client import (
    HerdrClient,
    HerdrError,
    agent_status_of,
    pane_id_of,
    pick,
    status_detail_of,
)


class FakeHerdrServer:
    """NDJSON request/response server with scriptable handlers."""

    def __init__(self, path: str):
        self.path = path
        self.server: asyncio.AbstractServer | None = None
        self.requests: list[dict] = []
        self.drop_after_responses: int | None = None
        self._responses_sent = 0
        # method -> result dict | HerdrError-style error dict | callable
        self.handlers: dict[str, object] = {"ping": {"type": "pong"}}
        self.event_lines: list[dict] = []

    async def start(self) -> None:
        self.server = await asyncio.start_unix_server(self._on_client, path=self.path)

    async def stop(self) -> None:
        if self.server is not None:
            self.server.close()
            await self.server.wait_closed()

    async def _on_client(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter):
        try:
            while True:
                line = await reader.readline()
                if not line:
                    return
                request = json.loads(line)
                self.requests.append(request)
                method = request.get("method")
                handler = self.handlers.get(method)
                if callable(handler):
                    handler = handler(request)
                if isinstance(handler, dict) and "error" in handler:
                    response = {"id": request["id"], "error": handler["error"]}
                else:
                    response = {"id": request["id"], "result": handler or {}}
                writer.write(json.dumps(response).encode() + b"\n")
                await writer.drain()
                self._responses_sent += 1
                if method == "events.subscribe":
                    for event in self.event_lines:
                        writer.write(json.dumps(event).encode() + b"\n")
                    await writer.drain()
                if (
                    self.drop_after_responses is not None
                    and self._responses_sent >= self.drop_after_responses
                ):
                    writer.close()
                    return
        except (ConnectionResetError, asyncio.IncompleteReadError):
            return


@pytest.fixture
async def fake_server(tmp_path):
    server = FakeHerdrServer(str(tmp_path / "herdr.sock"))
    await server.start()
    yield server
    await server.stop()


async def test_request_response_roundtrip(fake_server):
    client = HerdrClient(fake_server.path)
    result = await client.ping()
    assert result == {"type": "pong"}
    assert fake_server.requests[0]["method"] == "ping"
    assert fake_server.requests[0]["id"]
    await client.close()


async def test_error_response_raises(fake_server):
    fake_server.handlers["pane.send_text"] = {
        "error": {"code": "not_found", "message": "no such pane"}
    }
    client = HerdrClient(fake_server.path)
    with pytest.raises(HerdrError) as excinfo:
        await client.pane_send_text("p1", "hello")
    assert excinfo.value.code == "not_found"
    assert "no such pane" in str(excinfo.value)
    await client.close()


async def test_reconnect_after_server_drops_connection(fake_server):
    fake_server.drop_after_responses = 1
    client = HerdrClient(fake_server.path)
    assert await client.ping() == {"type": "pong"}
    fake_server.drop_after_responses = None
    # The first connection is gone; the retry path reconnects transparently.
    assert await client.ping() == {"type": "pong"}
    await client.close()


async def test_agent_start_params_shape(fake_server):
    # VERIFIED live result shape: {type: agent_started, agent: {pane_id, ...}}.
    fake_server.handlers["agent.start"] = {
        "type": "agent_started",
        "agent": {"pane_id": "w1-1", "terminal_id": "term_1", "agent_status": "unknown"},
    }
    client = HerdrClient(fake_server.path)
    result = await client.agent_start(
        name="wfb-cli",
        argv=["claude", "--model", "claude-opus-4-8"],
        cwd="/sandbox",
        env={"FOO": "bar"},
    )
    assert pane_id_of(result) == "w1-1"
    request = fake_server.requests[-1]
    assert request["method"] == "agent.start"
    assert request["params"]["name"] == "wfb-cli"
    assert request["params"]["argv"] == ["claude", "--model", "claude-opus-4-8"]
    assert request["params"]["cwd"] == "/sandbox"
    assert request["params"]["env"] == {"FOO": "bar"}
    await client.close()


async def test_agent_get_uses_target_param(fake_server):
    fake_server.handlers["agent.get"] = {
        "type": "agent_info",
        "agent": {"pane_id": "w1-1", "agent": "claude", "agent_status": "working"},
    }
    client = HerdrClient(fake_server.path)
    result = await client.agent_get("w1-1")
    assert agent_status_of(result) == "working"
    assert fake_server.requests[-1]["params"] == {"target": "w1-1"}
    await client.close()


async def test_subscribe_events_yields_events(fake_server):
    fake_server.handlers["events.subscribe"] = {"type": "subscription_started"}
    # VERIFIED stream line shape: {"event": ..., "data": {...}}; exits use the
    # underscore name `pane_exited`.
    fake_server.event_lines = [
        {
            "event": "pane.agent_status_changed",
            "data": {"agent": "claude", "agent_status": "working", "pane_id": "p1"},
        },
        {"event": "pane_exited", "data": {"pane_id": "p1", "workspace_id": "w1"}},
    ]
    client = HerdrClient(fake_server.path)
    received = []
    async for event in client.subscribe_events():
        received.append(event)
        if len(received) == 2:
            break
    assert received[0]["event"] == "pane.agent_status_changed"
    assert received[1]["event"] == "pane_exited"
    # subscriptions is REQUIRED by the server — the default global set is sent.
    request = fake_server.requests[-1]
    sent_types = [s["type"] for s in request["params"]["subscriptions"]]
    assert "pane.exited" in sent_types and "pane.agent_detected" in sent_types
    await client.close()


def test_tolerant_result_parsing_helpers():
    assert pick({"a": 1, "b": None}, "b", "a") == 1
    assert pick(None, "a", default="x") == "x"
    assert pane_id_of({"paneId": 7}) == "7"
    assert pane_id_of({"data": {"pane_id": "p9"}}) == "p9"
    assert pane_id_of({}) is None
    assert agent_status_of({"agent_status": "Working"}) == "working"
    assert agent_status_of({"agent": {"state": "blocked"}}) == "blocked"
    assert agent_status_of({"status": "sprinting"}) is None
    assert status_detail_of({"agent": {"explain": "waiting for permission"}}) == (
        "waiting for permission"
    )

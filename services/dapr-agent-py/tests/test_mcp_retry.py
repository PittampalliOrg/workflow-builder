from __future__ import annotations

import asyncio
import os
import sys


root = os.path.join(os.path.dirname(__file__), "..")
if root not in sys.path:
    sys.path.insert(0, root)

from src.mcp_retry import connect_mcp_client_with_retries


class _FakeClient:
    def __init__(self, *, fail: bool = False, tools: list[object] | None = None) -> None:
        self.fail = fail
        self.tools = tools or []
        self.closed = False
        self.configs = None

    async def connect_from_config(self, configs):
        self.configs = configs
        if self.fail:
            raise RuntimeError("not ready")

    def get_all_tools(self):
        return self.tools

    async def close(self):
        self.closed = True


def test_connect_mcp_client_retries_failed_connect() -> None:
    clients = [_FakeClient(fail=True), _FakeClient(tools=[object()])]

    async def run():
        return await connect_mcp_client_with_retries(
            {"piece": {"url": "http://example.test/mcp"}},
            client_factory=lambda: clients.pop(0),
            max_attempts=2,
            initial_delay_seconds=0,
        )

    result = asyncio.run(run())

    assert result.tools
    assert clients == []


def test_connect_mcp_client_retries_empty_tool_surface() -> None:
    first = _FakeClient(tools=[])
    second = _FakeClient(tools=[object()])
    clients = [first, second]

    async def run():
        return await connect_mcp_client_with_retries(
            {"piece": {"url": "http://example.test/mcp"}},
            client_factory=lambda: clients.pop(0),
            max_attempts=2,
            initial_delay_seconds=0,
        )

    result = asyncio.run(run())

    assert result is second
    assert first.closed is True


def test_connect_mcp_client_allows_empty_tools_on_final_attempt() -> None:
    client = _FakeClient(tools=[])

    async def run():
        return await connect_mcp_client_with_retries(
            {"piece": {"url": "http://example.test/mcp"}},
            client_factory=lambda: client,
            max_attempts=1,
            initial_delay_seconds=0,
        )

    assert asyncio.run(run()) is client
    assert client.closed is False

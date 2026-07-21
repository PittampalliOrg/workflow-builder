from __future__ import annotations

import importlib

import src.config as config


_MCP_ENV_NAMES = (
    "PYDANTIC_AI_MCP_TIMEOUT_SECONDS",
    "PYDANTIC_AI_MCP_LIST_TIMEOUT_SECONDS",
    "PYDANTIC_AI_MCP_READ_TIMEOUT_SECONDS",
)


def _load_mcp_deadlines(monkeypatch, values: dict[str, str]) -> tuple[int, int, int]:
    with monkeypatch.context() as env:
        for name in _MCP_ENV_NAMES:
            env.delenv(name, raising=False)
        for name, value in values.items():
            env.setenv(name, value)
        loaded = importlib.reload(config)
        result = (
            loaded.MCP_CALL_TIMEOUT_SECONDS,
            loaded.MCP_LIST_TIMEOUT_SECONDS,
            loaded.MCP_READ_TIMEOUT_SECONDS,
        )
    importlib.reload(config)
    return result


def test_mcp_deadline_defaults_keep_discovery_short_and_read_inside_call(monkeypatch):
    assert _load_mcp_deadlines(monkeypatch, {}) == (30, 30, 20)


def test_mcp_deadlines_split_and_clamp_configured_read_timeout(monkeypatch):
    assert _load_mcp_deadlines(
        monkeypatch,
        {
            "PYDANTIC_AI_MCP_TIMEOUT_SECONDS": "480",
            "PYDANTIC_AI_MCP_LIST_TIMEOUT_SECONDS": "17",
            "PYDANTIC_AI_MCP_READ_TIMEOUT_SECONDS": "900",
        },
    ) == (480, 17, 479)

from __future__ import annotations

import importlib

import src.config as config


_MCP_ENV_NAMES = (
    "PYDANTIC_AI_MCP_TIMEOUT_SECONDS",
    "PYDANTIC_AI_MCP_LIST_TIMEOUT_SECONDS",
    "PYDANTIC_AI_MCP_READ_TIMEOUT_SECONDS",
)

_DURABLE_LIMIT_ENV_NAMES = (
    "PYDANTIC_AI_DURABLE_CONTEXT_MAX_BYTES",
    "PYDANTIC_AI_DURABLE_TOOL_CONTEXT_MAX_BYTES",
    "PYDANTIC_AI_DURABLE_TASK_MAX_BYTES",
    "PYDANTIC_AI_MAX_ITERATIONS",
    "PYDANTIC_AI_MAX_TOOL_CALLS_PER_RESPONSE",
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


def test_kimi_token_limits_are_bounded_by_provider_contract():
    assert config.bounded_kimi_token_limits(2_000_000, 2_000_000) == (
        1_048_576,
        1_048_575,
    )
    assert config.bounded_kimi_token_limits(-1, -1) == (2, 1)


def test_durable_history_reserves_activity_envelope_headroom():
    assert config.DURABLE_ACTIVITY_MAX_BYTES == 16 * 1024 * 1024 - 256 * 1024
    assert config.DURABLE_HISTORY_MAX_BYTES == 14 * 1024 * 1024
    assert config.DURABLE_HISTORY_KEEP_BYTES == 12 * 1024 * 1024


def test_durable_limits_cannot_be_raised_by_environment(monkeypatch):
    with monkeypatch.context() as env:
        for name in _DURABLE_LIMIT_ENV_NAMES:
            env.setenv(name, str(64 * 1024 * 1024))
        loaded = importlib.reload(config)
        assert loaded.DURABLE_TASK_MAX_BYTES == 512 * 1024
        assert loaded.DURABLE_CONTEXT_MAX_BYTES == 16 * 1024
        assert loaded.DURABLE_TOOL_CONTEXT_MAX_BYTES == 8 * 1024
        assert loaded.DEFAULT_MAX_ITERATIONS == 40
        assert loaded.MAX_ITERATIONS_PER_TURN == 40
        assert loaded.MAX_TOOL_CALLS_PER_RESPONSE == 8
        assert loaded.TOOL_DESCRIPTOR_MAX_BYTES == 256
        assert loaded.TOOL_ERROR_MAX_BYTES == 2 * 1024
        assert loaded.TERMINAL_CONTENT_MAX_BYTES == 256 * 1024
    importlib.reload(config)

"""Cross-replica persistence boundary for per-instance MCP configuration."""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any, Protocol


class StateStorePort(Protocol):
    """Minimal state-store contract required by the MCP configuration adapter."""

    def save(
        self,
        *,
        key: str,
        value: Any,
        ttl_in_seconds: int,
    ) -> Any: ...

    def load(self, *, key: str, default: Any = None) -> Any: ...


@dataclass(frozen=True)
class McpConfigState:
    configs: dict[str, dict[str, Any]]
    allowed_tools_by_server: dict[str, set[str]]


def _normalize_allowed_tools(value: object) -> set[str]:
    if not isinstance(value, (list, tuple, set, frozenset)):
        return set()
    return {str(tool).strip() for tool in value if str(tool).strip()}


def encode_mcp_config_state(
    configs: Mapping[str, Mapping[str, Any]],
    allowed_tools_by_server: Mapping[str, object],
) -> dict[str, Any]:
    """Return the JSON-safe document persisted by the state-store adapter."""
    allowed_tools: dict[str, list[str]] = {}
    for raw_server_name, raw_tools in allowed_tools_by_server.items():
        server_name = str(raw_server_name).strip()
        tools = _normalize_allowed_tools(raw_tools)
        if server_name and tools:
            allowed_tools[server_name] = sorted(tools)

    return {
        "configs": {
            str(server_name): dict(config)
            for server_name, config in configs.items()
        },
        "allowedTools": allowed_tools,
    }


def decode_mcp_config_state(value: object) -> McpConfigState | None:
    """Validate a persisted document and restore in-process set semantics."""
    if not isinstance(value, dict):
        return None
    raw_configs = value.get("configs")
    if not isinstance(raw_configs, dict) or not raw_configs:
        return None

    configs: dict[str, dict[str, Any]] = {}
    for raw_server_name, raw_config in raw_configs.items():
        if not isinstance(raw_config, dict):
            return None
        configs[str(raw_server_name)] = raw_config

    allowed_tools_by_server: dict[str, set[str]] = {}
    raw_allowed_tools = value.get("allowedTools")
    if isinstance(raw_allowed_tools, dict):
        for raw_server_name, raw_tools in raw_allowed_tools.items():
            server_name = str(raw_server_name).strip()
            tools = _normalize_allowed_tools(raw_tools)
            if server_name and tools:
                allowed_tools_by_server[server_name] = tools

    return McpConfigState(
        configs=configs,
        allowed_tools_by_server=allowed_tools_by_server,
    )


def save_mcp_config_state(
    state_store: StateStorePort,
    *,
    key: str,
    configs: Mapping[str, Mapping[str, Any]],
    allowed_tools_by_server: Mapping[str, object],
    ttl_in_seconds: int,
) -> None:
    state_store.save(
        key=key,
        value=encode_mcp_config_state(configs, allowed_tools_by_server),
        ttl_in_seconds=ttl_in_seconds,
    )


def load_mcp_config_state(
    state_store: StateStorePort,
    *,
    key: str,
) -> McpConfigState | None:
    return decode_mcp_config_state(state_store.load(key=key, default=None))

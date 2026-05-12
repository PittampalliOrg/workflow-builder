"""Translate the bootstrap MCP-servers JSON into ADK `McpToolset` instances.

Reads `ADK_AGENT_PY_BOOTSTRAP_MCP_SERVERS_JSON` (with fallback to
`DAPR_AGENT_PY_BOOTSTRAP_MCP_SERVERS_JSON` so the BFF doesn't need to rename
its env-var write during the rollout window).

Per-server provenance tagging (which server a tool came from) is NOT preserved
in v1 — ADK's `McpToolset.get_tools()` doesn't expose source-server identity
post-flatten. Future work: wrap each toolset's tools with a `server_name`
attribute we control before adding them to the `LlmAgent.tools` list.

Playwright sidecar URL rewrite (`http://localhost:3100/mcp`) happens on the
BFF side (`src/lib/server/agents/mcp-sidecar.ts`); the pod trusts whatever URL
the env var contains.
"""

from __future__ import annotations

import json
import logging
from typing import Any

from src.constants import BOOTSTRAP_MCP_SERVERS_JSON

logger = logging.getLogger(__name__)


def _import_adk_mcp() -> tuple[Any, Any, Any, Any] | None:
    """Lazy-import the ADK MCP types so the module loads even if ADK lacks
    the optional `mcp_tool` extra. Returns None when unavailable."""
    try:
        from google.adk.tools.mcp_tool import McpToolset
        from google.adk.tools.mcp_tool.mcp_session_manager import (
            StreamableHTTPConnectionParams,
            SseConnectionParams,
        )
        from mcp import StdioServerParameters

        return McpToolset, StreamableHTTPConnectionParams, SseConnectionParams, StdioServerParameters
    except Exception as exc:  # noqa: BLE001
        logger.warning("[mcp-bootstrap] ADK MCP types unavailable (%s)", exc)
        return None


def build_mcp_toolsets() -> list[Any]:
    """Build ADK `McpToolset` instances from the bootstrap env JSON.

    Returns an empty list when:
    - the env var is unset / empty
    - the JSON fails to parse
    - the ADK MCP extra is not installed

    Errors per-entry are logged and skipped rather than raising — same fail-
    soft behaviour as `services/dapr-agent-py/src/tools/__init__.py:bootstrap_mcp_tools`.
    """
    raw = BOOTSTRAP_MCP_SERVERS_JSON
    if not raw:
        return []

    try:
        entries = json.loads(raw)
    except json.JSONDecodeError as exc:
        logger.warning(
            "[mcp-bootstrap] invalid JSON in ADK_AGENT_PY_BOOTSTRAP_MCP_SERVERS_JSON: %s",
            exc,
        )
        return []
    if not isinstance(entries, list) or not entries:
        return []

    types = _import_adk_mcp()
    if types is None:
        return []
    McpToolset, StreamableParams, SseParams, StdioParams = types

    toolsets: list[Any] = []
    for entry in entries:
        if not isinstance(entry, dict):
            continue
        name = str(
            entry.get("name")
            or entry.get("server_name")
            or entry.get("serverName")
            or ""
        ).strip()
        transport = str(entry.get("transport") or "streamable_http").lower()
        if not name:
            continue

        params: Any | None = None
        try:
            if transport in ("streamable_http", "streamable-http", "http"):
                params = StreamableParams(
                    url=str(entry.get("url") or ""),
                    headers=entry.get("headers") or {},
                )
            elif transport == "sse":
                params = SseParams(
                    url=str(entry.get("url") or ""),
                    headers=entry.get("headers") or {},
                )
            elif transport == "stdio":
                params = StdioParams(
                    command=str(entry.get("command") or ""),
                    args=list(entry.get("args") or []),
                    env=entry.get("env"),
                )
            else:
                logger.warning(
                    "[mcp-bootstrap] unsupported transport %r for %s",
                    transport,
                    name,
                )
                continue
        except Exception as exc:  # noqa: BLE001
            logger.warning("[mcp-bootstrap] params build failed for %s: %s", name, exc)
            continue

        try:
            toolset = McpToolset(
                connection_params=params,
                tool_filter=entry.get("toolFilter") or entry.get("tool_filter"),
            )
            toolsets.append(toolset)
        except Exception as exc:  # noqa: BLE001
            logger.warning("[mcp-bootstrap] McpToolset construction failed for %s: %s", name, exc)
            continue

    if toolsets:
        logger.info("[mcp-bootstrap] built %d MCP toolset(s)", len(toolsets))
    return toolsets

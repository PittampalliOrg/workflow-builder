"""Map ``agentConfig.mcpServers`` onto Claude Agent SDK MCP server configs.

Phase 0 of the runtime-standardization work (DurableSessionRuntime contract).

Before this module, ``build_claude_options`` never read ``agentConfig.mcpServers``,
so an agent's declared MCP servers were SILENTLY DROPPED on claude-agent-py while
they worked on dapr-agent-py — the single worst swap-blocker (CRITICAL). The
Claude Agent SDK natively supports ``ClaudeAgentOptions.mcp_servers``; this module
translates the platform's wire shape (a list of
``{name, transport, url, command, args, headers, env, ...}``) into the SDK's
``dict[str, McpServerConfig]`` keyed by server name.

The transport normalization, server-name derivation, ``connectionExternalId``
header injection, and in-cluster URL qualification deliberately MIRROR
dapr-agent-py's ``_extract_mcp_server_configs`` (``services/dapr-agent-py/src/main.py``)
so the two runtimes resolve an identical ``mcpServers`` block the same way. The
only divergence is the output shape: dapr-agent-py emits its own
``{"transport": ...}`` dicts for ``MCPClient``; here we emit SDK
``McpStdioServerConfig`` / ``McpSSEServerConfig`` / ``McpHttpServerConfig`` dicts.

The SDK has no ``websocket`` MCP transport, so websocket servers are skipped with
a warning (dapr-agent-py supports them; this is a declared capability gap, not a
silent drop).
"""

from __future__ import annotations

import logging
import os
import re
import urllib.parse
from typing import Any, Mapping

logger = logging.getLogger(__name__)

# SDK McpServerConfig transports we can emit. ``websocket`` is intentionally
# absent — the Claude Agent SDK does not model it.
_SDK_SUPPORTED_TRANSPORTS = {"streamable_http", "sse", "stdio"}


def _normalize_mcp_server_name(value: Any) -> str:
    """Port of dapr-agent-py ``_normalize_mcp_server_name`` (main.py)."""
    text = str(value or "").strip().lower()
    text = re.sub(r"^@activepieces/piece-", "", text)
    text = re.sub(r"[^a-z0-9_-]+", "_", text)
    text = re.sub(r"_+", "_", text).strip("_")
    if not text:
        text = "mcp_server"
    if not re.match(r"^[a-z_]", text):
        text = f"mcp_{text}"
    return text[:48]


def _is_short_k8s_host(hostname: str) -> bool:
    """Port of dapr-agent-py ``_is_short_k8s_host`` (main.py)."""
    if not hostname or "." in hostname:
        return False
    if hostname in {"localhost", "127.0.0.1", "::1"}:
        return False
    return (
        all(char.islower() or char.isdigit() or char == "-" for char in hostname)
        and hostname[0].isalnum()
        and hostname[-1].isalnum()
    )


def _should_qualify_mcp_url(server: Mapping[str, Any]) -> bool:
    """Port of dapr-agent-py ``_should_qualify_mcp_url`` (main.py)."""
    source_type = str(server.get("sourceType") or server.get("source_type") or "")
    if source_type in {"nimble_piece", "nimble_shared", "hosted_workflow"}:
        return True
    registry_ref = str(server.get("registryRef") or server.get("registry_ref") or "")
    return registry_ref.startswith(("ap-", "nimble-", "shared-")) or registry_ref in {
        "mcp-gateway",
        "shared-workflow-mcp-server",
    }


def _runtime_reachable_mcp_url(server: Mapping[str, Any], url: str) -> str:
    """Port of dapr-agent-py ``_runtime_reachable_mcp_url`` (main.py).

    Qualifies a bare in-cluster service hostname (e.g. ``mcp-gateway``) to its
    FQDN so the per-session sandbox pod can reach it.
    """
    text = str(url or "").strip()
    if not text or not _should_qualify_mcp_url(server):
        return text
    parsed = urllib.parse.urlparse(text)
    if parsed.scheme not in {"http", "https", "ws", "wss"} or not parsed.hostname:
        return text
    if not _is_short_k8s_host(parsed.hostname):
        return text

    namespace = str(
        server.get("namespace")
        or os.environ.get("MCP_CONNECTION_NAMESPACE")
        or os.environ.get("WORKFLOW_BUILDER_NAMESPACE")
        or "workflow-builder"
    ).strip()
    host = f"{parsed.hostname}.{namespace}.svc.cluster.local"
    if parsed.port:
        host = f"{host}:{parsed.port}"
    qualified = urllib.parse.urlunparse(parsed._replace(netloc=host))
    logger.info("[mcp] Qualified MCP server URL for sandbox runtime: %s -> %s", text, qualified)
    return qualified


def _normalize_transport(item: Mapping[str, Any]) -> str:
    """Mirror dapr-agent-py transport normalization; default ``streamable_http``."""
    raw_transport = str(
        item.get("transport") or item.get("type") or "streamable_http"
    ).strip().lower()
    transport = raw_transport.replace("-", "_")
    if transport in {"http", "streamablehttp"}:
        transport = "streamable_http"
    elif transport in {"ws", "web_socket", "websocket"}:
        transport = "websocket"
    return transport


def _safe_headers(item: Mapping[str, Any]) -> dict[str, str]:
    headers: dict[str, str] = {}
    raw = item.get("headers")
    if isinstance(raw, Mapping):
        for key, value in raw.items():
            if str(key).strip() and value is not None:
                headers[str(key)] = str(value)
    connection_external_id = str(
        item.get("connectionExternalId") or item.get("connection_external_id") or ""
    ).strip()
    if connection_external_id and not any(
        str(key).lower() == "x-connection-external-id" for key in headers
    ):
        headers["X-Connection-External-Id"] = connection_external_id
    return headers


def _allowed_tool_patterns(server_name: str, item: Mapping[str, Any]) -> list[str]:
    """Permit the server's tools without prompting under non-bypass modes.

    Claude Code MCP tools are named ``mcp__<server>__<tool>``. Allowing
    ``mcp__<server>`` permits every tool from that server; an explicit
    ``allowedTools`` list narrows it to ``mcp__<server>__<tool>``.
    """
    raw_allowed = item.get("allowedTools") or item.get("allowed_tools")
    if isinstance(raw_allowed, list):
        tools = [str(tool).strip() for tool in raw_allowed if str(tool).strip()]
        if tools:
            return [f"mcp__{server_name}__{tool}" for tool in tools]
    return [f"mcp__{server_name}"]


def build_mcp_servers(
    agent_config: Mapping[str, Any] | None,
) -> tuple[dict[str, dict[str, Any]], list[str]]:
    """Translate ``agentConfig.mcpServers`` to SDK ``mcp_servers`` + allow-list.

    Returns ``(mcp_servers, allowed_tool_patterns)`` where ``mcp_servers`` is the
    ``dict[str, McpServerConfig]`` for ``ClaudeAgentOptions.mcp_servers`` and
    ``allowed_tool_patterns`` is the list of ``mcp__*`` patterns to add to
    ``allowed_tools`` so the tools are callable under any permission mode.
    """
    if not isinstance(agent_config, Mapping):
        return {}, []
    raw_servers = agent_config.get("mcpServers")
    if not isinstance(raw_servers, list):
        return {}, []

    servers: dict[str, dict[str, Any]] = {}
    allowed_tools: list[str] = []
    for item in raw_servers:
        if not isinstance(item, Mapping):
            continue
        transport = _normalize_transport(item)
        if transport == "websocket":
            logger.warning(
                "[mcp] Skipping websocket MCP server (unsupported by Claude Agent SDK): %s",
                item.get("name") or item.get("url") or item,
            )
            continue
        if transport not in _SDK_SUPPORTED_TRANSPORTS:
            logger.warning("[mcp] Skipping unsupported MCP transport: %s", transport)
            continue

        name_source = (
            item.get("server_name")
            or item.get("serverName")
            or item.get("name")
            or item.get("pieceName")
            or item.get("displayName")
            or item.get("url")
            or item.get("serverUrl")
            or item.get("command")
        )
        base_name = _normalize_mcp_server_name(name_source)
        server_name = base_name
        suffix = 2
        while server_name in servers:
            server_name = f"{base_name}_{suffix}"
            suffix += 1

        config: dict[str, Any]
        if transport == "stdio":
            command = str(item.get("command") or "").strip()
            if not command:
                logger.warning("[mcp] Skipping stdio MCP server without command: %s", item)
                continue
            config = {"type": "stdio", "command": command}
            if isinstance(item.get("args"), list):
                config["args"] = [str(arg) for arg in item["args"]]
            if isinstance(item.get("env"), Mapping):
                env = {
                    str(key): str(value)
                    for key, value in item["env"].items()
                    if str(key).strip() and value is not None
                }
                if env:
                    config["env"] = env
        else:
            url = str(item.get("url") or item.get("serverUrl") or "").strip()
            if not url.startswith(("http://", "https://")):
                logger.warning(
                    "[mcp] Skipping %s MCP server with invalid URL: %s", transport, item
                )
                continue
            url = _runtime_reachable_mcp_url(item, url)
            # streamable_http -> SDK "http" (Streamable HTTP); sse -> SDK "sse".
            config = {"type": "http" if transport == "streamable_http" else "sse", "url": url}
            headers = _safe_headers(item)
            if headers:
                config["headers"] = headers

        servers[server_name] = config
        allowed_tools.extend(_allowed_tool_patterns(server_name, item))

    return servers, allowed_tools

"""Map ``agentConfig.mcpServers`` onto Claude Code ``.mcp.json`` server configs.

Vendored/adapted FROM ``services/claude-agent-py/src/mcp_config.py`` (which in
turn mirrors dapr-agent-py's ``_extract_mcp_server_configs``): identical
transport normalization, server-name derivation, ``connectionExternalId``
header injection, and in-cluster URL qualification — so all runtimes resolve an
identical ``mcpServers`` block the same way.

The only divergence from claude-agent-py is the consumer: here the dicts are
written verbatim into ``/sandbox/.wfb/mcp.json`` as
``{"mcpServers": {name: {"type": "stdio"|"http"|"sse", command/args/env | url/headers}}}``
and handed to the Claude Code TUI via ``--mcp-config``; ``streamable_http``
maps to Claude Code's ``"http"`` type (Streamable HTTP).

Claude Code has no ``websocket`` MCP transport, so websocket servers are skipped
with a warning (declared capability gap, not a silent drop).
"""

from __future__ import annotations

import logging
import os
import re
import urllib.parse
from typing import Any, Mapping

logger = logging.getLogger(__name__)

# .mcp.json transports we can emit. ``websocket`` is intentionally absent.
_SUPPORTED_TRANSPORTS = {"streamable_http", "sse", "stdio"}


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
    """Qualify a bare in-cluster service hostname (e.g. ``mcp-gateway``) to its
    FQDN so the per-session sandbox pod can reach it."""
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


def build_mcp_servers(
    agent_config: Mapping[str, Any] | None,
) -> dict[str, dict[str, Any]]:
    """Translate ``agentConfig.mcpServers`` to the ``.mcp.json`` server map.

    Returns the ``dict[name, config]`` to embed as ``{"mcpServers": ...}``.
    """
    if not isinstance(agent_config, Mapping):
        return {}
    raw_servers = agent_config.get("mcpServers")
    if not isinstance(raw_servers, list):
        return {}

    servers: dict[str, dict[str, Any]] = {}
    for item in raw_servers:
        if not isinstance(item, Mapping):
            continue
        transport = _normalize_transport(item)
        if transport == "websocket":
            logger.warning(
                "[mcp] Skipping websocket MCP server (unsupported by Claude Code): %s",
                item.get("name") or item.get("url") or item,
            )
            continue
        if transport not in _SUPPORTED_TRANSPORTS:
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
            # streamable_http -> Claude Code "http" (Streamable HTTP); sse -> "sse".
            config = {"type": "http" if transport == "streamable_http" else "sse", "url": url}
            headers = _safe_headers(item)
            if headers:
                config["headers"] = headers

        servers[server_name] = config

    return servers

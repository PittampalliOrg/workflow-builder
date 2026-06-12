"""Shared MCP-server field normalization for the capability compiler.

SSOT for the helpers that were previously duplicated BYTE-FOR-BYTE in three
places:

  * ``services/dapr-agent-py/src/main.py``        (``_extract_mcp_server_configs`` + helpers)
  * ``services/claude-agent-py/src/mcp_config.py`` (``build_mcp_servers``)
  * ``services/cli-agent-py/src/mcp_config.py``    (``build_mcp_servers``)

Every helper here is lifted verbatim from those copies so the per-target
emitters in :mod:`capability_compiler.mcp` reproduce each runtime's current
output BYTE-FOR-BYTE. The transport normalizer keeps ``websocket`` recognized
(dapr-agent-py KEEPS websocket; the CLI/SDK emitters drop it) — see
:func:`normalize_transport`.

This module is vendored, byte-identical, into each Python service's build
context by ``scripts/sync-runtime-registry.mjs`` (the SSOT lives under
``services/shared/``); do not edit the vendored copies.
"""

from __future__ import annotations

import logging
import os
import re
import urllib.parse
from typing import Any, Mapping

logger = logging.getLogger(__name__)


def normalize_mcp_server_name(value: Any) -> str:
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


def is_short_k8s_host(hostname: str) -> bool:
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


def should_qualify_mcp_url(server: Mapping[str, Any]) -> bool:
    """Port of dapr-agent-py ``_should_qualify_mcp_url`` (main.py)."""
    source_type = str(server.get("sourceType") or server.get("source_type") or "")
    if source_type in {"nimble_piece", "nimble_shared", "hosted_workflow"}:
        return True
    registry_ref = str(server.get("registryRef") or server.get("registry_ref") or "")
    return registry_ref.startswith(("ap-", "nimble-", "shared-")) or registry_ref in {
        "mcp-gateway",
        "shared-workflow-mcp-server",
    }


def runtime_reachable_mcp_url(server: Mapping[str, Any], url: str) -> str:
    """Port of dapr-agent-py ``_runtime_reachable_mcp_url`` (main.py).

    Qualifies a bare in-cluster service hostname (e.g. ``mcp-gateway``) to its
    FQDN so the per-session sandbox pod can reach it.
    """
    text = str(url or "").strip()
    if not text or not should_qualify_mcp_url(server):
        return text
    parsed = urllib.parse.urlparse(text)
    if parsed.scheme not in {"http", "https", "ws", "wss"} or not parsed.hostname:
        return text
    if not is_short_k8s_host(parsed.hostname):
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


def normalize_transport(item: Mapping[str, Any]) -> str:
    """Mirror dapr-agent-py transport normalization; default ``streamable_http``.

    ``websocket`` is KEPT in the vocabulary (dapr-agent-py supports it). The
    CLI/SDK emitters drop it explicitly — this only canonicalizes the alias set
    (``ws``/``web_socket``/``websocket`` -> ``websocket``,
    ``http``/``streamablehttp`` -> ``streamable_http``).
    """
    raw_transport = str(
        item.get("transport") or item.get("type") or "streamable_http"
    ).strip().lower()
    transport = raw_transport.replace("-", "_")
    if transport in {"http", "streamablehttp"}:
        transport = "streamable_http"
    elif transport in {"ws", "web_socket", "websocket"}:
        transport = "websocket"
    return transport


def derive_name_source(item: Mapping[str, Any]) -> Any:
    """The 8-key server-name precedence shared by all three current copies."""
    return (
        item.get("server_name")
        or item.get("serverName")
        or item.get("name")
        or item.get("pieceName")
        or item.get("displayName")
        or item.get("url")
        or item.get("serverUrl")
        or item.get("command")
    )


def safe_headers(item: Mapping[str, Any]) -> dict[str, str]:
    """Port of the CLI/SDK ``_safe_headers`` (claude/cli ``mcp_config.py``).

    Builds the header map and injects the per-request
    ``X-Connection-External-Id`` reference (case-insensitive de-dup) — the
    audit-only credential-forwarding token the piece-runtime self-resolves at
    point of use. dapr-agent-py reproduces the SAME output via a different code
    path (``setdefault`` after the explicit-header copy); see
    :func:`capability_compiler.mcp.emit_dapr_agent_py`.
    """
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

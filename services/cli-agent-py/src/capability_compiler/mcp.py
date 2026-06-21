"""Per-target MCP-server emitters for the capability compiler.

Each emitter reproduces ONE current runtime's ``agentConfig.mcpServers``
translation BYTE-FOR-BYTE — they are lifted verbatim from the call sites they
replace, sharing the field helpers in :mod:`capability_compiler.normalize`:

  * :func:`emit_claude_code_cli_servers`   <- cli-agent-py ``build_mcp_servers``
  * :func:`emit_claude_agent_sdk_servers`  <- claude-agent-py ``build_mcp_servers``
  * :func:`emit_dapr_agent_py`             <- dapr-agent-py ``_extract_mcp_server_configs`` (post agentConfig-coerce)

Three DISTINCT output shapes — intentionally NOT collapsed:

  * dapr           -> ``{name: {"transport": ...}}`` + ``{name: set[raw tool names]}``; KEEPS ``websocket``.
  * claude-sdk     -> ``{name: {"type": ...}}`` + ``["mcp__<name>[__<tool>]"]`` patterns; drops ``websocket``.
  * claude-code/cli-> ``{name: {"type": ...}}``; drops ``websocket``.

The codex + agy emitters CHAIN OFF the cli ``{type, ...}`` map (not the raw
list) — see :mod:`capability_compiler` and the Phase-2 caller cutover.

Per-emitter name dedup is deliberate: the ``_<n>`` counter only advances for
servers a given target KEEPS, and dapr keeps ``websocket`` while the CLI/SDK
targets drop it — so a single shared "dedup once" pass would diverge from
today's per-runtime output. Each loop dedups over its OWN kept set.
"""

from __future__ import annotations

import logging
import os
import urllib.parse
from typing import Any, Mapping

from .normalize import (
    derive_name_source,
    normalize_mcp_server_name,
    normalize_transport,
    runtime_reachable_mcp_url,
    safe_headers,
)

logger = logging.getLogger(__name__)

# Route the agent's local @playwright/mcp traffic through cli-agent-py's in-pod
# recording proxy (playwright_mcp_proxy) so the screencast records the AGENT's
# own browser session, not a separate supervisor session (the blank-recording
# fix). Only applied for the CLI emitter — the Claude Agent SDK / dapr twins run
# in pods WITHOUT this proxy (their :3100 is a browser sidecar). Disable with
# CLI_PW_MCP_PROXY=0.
_PW_PROXY_ENABLED = os.environ.get("CLI_PW_MCP_PROXY", "1").strip().lower() not in (
    "0", "false", "no", "off",
)
_PW_PROXY_URL = os.environ.get(
    "CLI_PW_MCP_PROXY_URL", "http://127.0.0.1:8002/internal/pw-proxy/mcp"
)
_PW_LOCAL_HOSTS = {"127.0.0.1", "localhost", "0.0.0.0"}
_PW_MCP_PORT = os.environ.get("CLI_PW_MCP_HTTP_PORT", "3100")


def _redirect_local_playwright_to_proxy(url: str) -> str:
    """If ``url`` targets the in-pod @playwright/mcp (:3100), point it at the
    recording proxy instead. Best-effort; returns ``url`` unchanged otherwise."""
    if not _PW_PROXY_ENABLED:
        return url
    try:
        parsed = urllib.parse.urlparse(url)
    except Exception:  # noqa: BLE001
        return url
    if parsed.hostname in _PW_LOCAL_HOSTS and str(parsed.port or "") == str(_PW_MCP_PORT):
        logger.info(
            "[mcp] Routing local playwright MCP via in-pod recording proxy: %s -> %s",
            url, _PW_PROXY_URL,
        )
        return _PW_PROXY_URL
    return url

# ``{type, ...}`` transports the CLI / Claude Agent SDK can emit. ``websocket``
# is intentionally absent — neither models it.
_CLI_SDK_SUPPORTED_TRANSPORTS = {"streamable_http", "sse", "stdio"}

# ``{transport, ...}`` transports dapr-agent-py's MCPClient accepts.
_DAPR_ALLOWED_TRANSPORTS = {"streamable_http", "sse", "stdio", "websocket"}


def _allowed_tool_patterns(server_name: str, item: Mapping[str, Any]) -> list[str]:
    """Port of claude-agent-py ``_allowed_tool_patterns`` (mcp_config.py).

    MCP tools are named ``mcp__<server>__<tool>``. Allowing ``mcp__<server>``
    permits every tool; an explicit ``allowedTools`` list narrows it to
    ``mcp__<server>__<tool>``.
    """
    raw_allowed = item.get("allowedTools") or item.get("allowed_tools")
    if isinstance(raw_allowed, list):
        tools = [str(tool).strip() for tool in raw_allowed if str(tool).strip()]
        if tools:
            return [f"mcp__{server_name}__{tool}" for tool in tools]
    return [f"mcp__{server_name}"]


def _emit_cli_sdk_shape(
    agent_config: Mapping[str, Any] | None,
    *,
    collect_patterns: bool,
    redirect_local_playwright: bool = False,
) -> tuple[dict[str, dict[str, Any]], list[str]]:
    """Shared body of the cli + claude-sdk twins (``{type, ...}`` map).

    ``collect_patterns=False`` reproduces cli-agent-py's ``build_mcp_servers``
    (servers only); ``True`` reproduces claude-agent-py's ``build_mcp_servers``
    (servers + ``mcp__*`` allow-list). The servers map is byte-identical either
    way — patterns only affect the returned list.
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
        transport = normalize_transport(item)
        if transport == "websocket":
            logger.warning(
                "[mcp] Skipping websocket MCP server (unsupported by Claude Code/SDK): %s",
                item.get("name") or item.get("url") or item,
            )
            continue
        if transport not in _CLI_SDK_SUPPORTED_TRANSPORTS:
            logger.warning("[mcp] Skipping unsupported MCP transport: %s", transport)
            continue

        base_name = normalize_mcp_server_name(derive_name_source(item))
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
            url = runtime_reachable_mcp_url(item, url)
            if redirect_local_playwright:
                url = _redirect_local_playwright_to_proxy(url)
            # streamable_http -> "http" (Streamable HTTP); sse -> "sse".
            config = {"type": "http" if transport == "streamable_http" else "sse", "url": url}
            headers = safe_headers(item)
            if headers:
                config["headers"] = headers

        servers[server_name] = config
        if collect_patterns:
            allowed_tools.extend(_allowed_tool_patterns(server_name, item))

    return servers, allowed_tools


def emit_claude_code_cli_servers(
    agent_config: Mapping[str, Any] | None,
) -> dict[str, dict[str, Any]]:
    """Reproduce cli-agent-py ``build_mcp_servers`` — ``{name: {type, ...}}``."""
    servers, _ = _emit_cli_sdk_shape(
        agent_config, collect_patterns=False, redirect_local_playwright=True
    )
    return servers


def emit_claude_agent_sdk_servers(
    agent_config: Mapping[str, Any] | None,
) -> tuple[dict[str, dict[str, Any]], list[str]]:
    """Reproduce claude-agent-py ``build_mcp_servers`` — ``(servers, patterns)``."""
    return _emit_cli_sdk_shape(agent_config, collect_patterns=True)


def emit_dapr_agent_py(
    agent_config: Mapping[str, Any] | None,
) -> tuple[dict[str, dict[str, Any]], dict[str, set[str]]]:
    """Reproduce dapr-agent-py ``_extract_mcp_server_configs`` (post-coerce).

    Returns ``(configs, allowed_tools_by_server)`` where ``configs`` is the
    ``{name: {"transport": ...}}`` map ``MCPClient.connect_from_config``
    consumes and ``allowed_tools_by_server`` maps each server to its RAW tool
    names. KEEPS ``websocket``. The header / ``connectionExternalId`` /
    numeric / bool logic is inlined to match dapr's exact code path (the
    ``setdefault`` variant) — output-equivalent to :func:`normalize.safe_headers`.

    The caller is responsible for coercing/validating ``agentConfig`` (the
    ``_coerce_agent_config`` + invalid-JSON warning stay at the call site).
    """
    if not isinstance(agent_config, Mapping):
        return {}, {}
    raw_servers = agent_config.get("mcpServers")
    if not isinstance(raw_servers, list):
        return {}, {}

    configs: dict[str, dict[str, Any]] = {}
    allowed_tools_by_server: dict[str, set[str]] = {}
    for item in raw_servers:
        if not isinstance(item, dict):
            continue
        transport = normalize_transport(item)
        if transport not in _DAPR_ALLOWED_TRANSPORTS:
            logger.warning("[mcp] Skipping unsupported MCP transport: %s", transport)
            continue

        base_name = normalize_mcp_server_name(derive_name_source(item))
        server_name = base_name
        suffix = 2
        while server_name in configs:
            server_name = f"{base_name}_{suffix}"
            suffix += 1

        config: dict[str, Any] = {"transport": transport}
        if transport == "stdio":
            command = str(item.get("command") or "").strip()
            if not command:
                logger.warning("[mcp] Skipping stdio MCP server without command: %s", item)
                continue
            config["command"] = command
            if isinstance(item.get("args"), list):
                config["args"] = [str(arg) for arg in item["args"]]
            if isinstance(item.get("env"), dict):
                config["env"] = {
                    str(key): str(value)
                    for key, value in item["env"].items()
                    if str(key).strip() and value is not None
                }
            if isinstance(item.get("cwd"), str) and item["cwd"].strip():
                config["cwd"] = item["cwd"].strip()
        else:
            url = str(item.get("url") or item.get("serverUrl") or "").strip()
            allowed_url_prefixes = (
                ("ws://", "wss://")
                if transport == "websocket"
                else ("http://", "https://")
            )
            if not url.startswith(allowed_url_prefixes):
                logger.warning(
                    "[mcp] Skipping MCP server with invalid %s URL: %s", transport, item
                )
                continue
            config["url"] = runtime_reachable_mcp_url(item, url)
        headers = item.get("headers")
        if isinstance(headers, dict):
            safe = {
                str(key): str(value)
                for key, value in headers.items()
                if str(key).strip() and value is not None
            }
            if safe:
                config["headers"] = safe
        connection_external_id = str(
            item.get("connectionExternalId") or item.get("connection_external_id") or ""
        ).strip()
        if connection_external_id:
            config_headers = config.setdefault("headers", {})
            if not any(
                str(key).lower() == "x-connection-external-id" for key in config_headers
            ):
                config_headers["X-Connection-External-Id"] = connection_external_id
        for numeric_key in ("timeout", "sse_read_timeout"):
            value = item.get(numeric_key)
            if isinstance(value, (int, float)) and value > 0:
                config[numeric_key] = value
        if "terminate_on_close" in item and isinstance(item["terminate_on_close"], bool):
            config["terminate_on_close"] = item["terminate_on_close"]
        configs[server_name] = config
        raw_allowed_tools = item.get("allowedTools") or item.get("allowed_tools")
        if isinstance(raw_allowed_tools, list):
            allowed_tools = {
                str(tool).strip()
                for tool in raw_allowed_tools
                if str(tool).strip()
            }
            if allowed_tools:
                allowed_tools_by_server[server_name] = allowed_tools
    return configs, allowed_tools_by_server

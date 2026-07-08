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

import base64
import json
import logging
import os
from typing import Any, Mapping

from .normalize import (
    derive_name_source,
    normalize_mcp_server_name,
    normalize_transport,
    runtime_reachable_mcp_url,
    safe_headers,
)

logger = logging.getLogger(__name__)

# ``{type, ...}`` transports the CLI / Claude Agent SDK can emit. ``websocket``
# is intentionally absent — neither models it.
_CLI_SDK_SUPPORTED_TRANSPORTS = {"streamable_http", "sse", "stdio"}

# ``{transport, ...}`` transports dapr-agent-py's MCPClient accepts.
_DAPR_ALLOWED_TRANSPORTS = {"streamable_http", "sse", "stdio", "websocket"}

_STRUCTURED_OUTPUT_MCP_SERVER = "structured"
_STRUCTURED_OUTPUT_MCP_URL = (
    os.environ.get("WORKFLOW_MCP_SERVER_URL")
    or "http://workflow-mcp-server.workflow-builder.svc.cluster.local:3200/mcp"
)
_STRUCTURED_OUTPUT_MODE_HEADER = "X-Wfb-Mcp-Mode"
_STRUCTURED_OUTPUT_SCHEMA_HEADER = "X-Wfb-Structured-Output-Schema-B64"
_STRUCTURED_OUTPUT_MODE = "structured-output"


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


def _schema_supports_structured_output(schema: Any) -> bool:
    """CLI structured finalization currently supports object-shaped schemas."""
    if not isinstance(schema, dict) or not schema:
        return False
    schema_type = schema.get("type")
    if schema_type == "object":
        return True
    return schema_type is None and isinstance(schema.get("properties"), dict)


def _encode_structured_output_schema(schema: Mapping[str, Any]) -> str:
    raw = json.dumps(dict(schema), sort_keys=True, ensure_ascii=False).encode("utf-8")
    return base64.urlsafe_b64encode(raw).decode("ascii").rstrip("=")


def _emit_cli_sdk_shape(
    agent_config: Mapping[str, Any] | None,
    *,
    collect_patterns: bool,
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
            # streamable_http -> "http" (Streamable HTTP); sse -> "sse".
            config = {"type": "http" if transport == "streamable_http" else "sse", "url": url}
            headers = safe_headers(item)
            if headers:
                config["headers"] = headers

        servers[server_name] = config
        if collect_patterns:
            allowed_tools.extend(_allowed_tool_patterns(server_name, item))

    return servers, allowed_tools


def _add_structured_output_server(
    servers: dict[str, dict[str, Any]],
    agent_config: Mapping[str, Any] | None,
) -> dict[str, dict[str, Any]]:
    """Add the workflow-mcp-server StructuredOutput MCP endpoint for CLI tool mode.

    Dapr-agent-py already provides its own synthetic StructuredOutput tool. CLI
    runtimes need the same contract over their native MCP channel, so the
    platform workflow-mcp-server switches into single-tool structured-output
    mode when these headers are present.
    """
    if not isinstance(agent_config, Mapping):
        return servers
    if agent_config.get("structuredOutputMode") != "tool":
        return servers
    schema = agent_config.get("responseJsonSchema")
    if not _schema_supports_structured_output(schema):
        return servers

    name = _STRUCTURED_OUTPUT_MCP_SERVER
    suffix = 2
    while name in servers:
        name = f"{_STRUCTURED_OUTPUT_MCP_SERVER}_{suffix}"
        suffix += 1

    servers[name] = {
        "type": "http",
        "url": _STRUCTURED_OUTPUT_MCP_URL,
        "headers": {
            _STRUCTURED_OUTPUT_MODE_HEADER: _STRUCTURED_OUTPUT_MODE,
            _STRUCTURED_OUTPUT_SCHEMA_HEADER: _encode_structured_output_schema(schema),
        },
    }
    return servers


def emit_claude_code_cli_servers(
    agent_config: Mapping[str, Any] | None,
) -> dict[str, dict[str, Any]]:
    """Reproduce cli-agent-py ``build_mcp_servers`` — ``{name: {type, ...}}``."""
    servers, _ = _emit_cli_sdk_shape(agent_config, collect_patterns=False)
    return _add_structured_output_server(servers, agent_config)


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

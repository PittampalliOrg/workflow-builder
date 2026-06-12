"""Byte-for-byte golden tests for the capability-compiler MCP emitters.

Each emitter must reproduce its pre-consolidation call-site output exactly. The
oracles are FROZEN verbatim copies of the original translators — the cli +
claude-sdk ``build_mcp_servers`` twin and dapr's ``_extract_mcp_server_configs``
(post agentConfig-coerce). They are inlined (not imported) because Phase 2 of the
cutover DELETED the original ``mcp_config.py`` source files; freezing the oracle
pins TODAY's behavior permanently, independent of the live package.

Run (no cluster, no grpc):
    python -m pytest services/shared/capability_compiler/tests/test_mcp_golden.py -q
"""

from __future__ import annotations

import os
import re
import urllib.parse
from typing import Any, Mapping

import pytest

from capability_compiler.mcp import (
    emit_claude_agent_sdk_servers,
    emit_claude_code_cli_servers,
    emit_dapr_agent_py,
)

# --- oracle: verbatim cli/claude ``build_mcp_servers`` (the twin) -------------
# Frozen copy of the ORIGINAL cli-agent-py + claude-agent-py ``build_mcp_servers``
# (the two were byte-identical bar the returned ``allowed_tool_patterns`` list).
# Inlined because Phase-2 DELETED those source files — this pins TODAY's behavior
# permanently, independent of the live package. Reuses ``_dapr_norm_name`` /
# ``_dapr_reachable`` below (byte-identical to the cli/claude helpers).
def _cli_norm_transport(item: Mapping[str, Any]) -> str:
    raw = str(item.get("transport") or item.get("type") or "streamable_http").strip().lower()
    t = raw.replace("-", "_")
    if t in {"http", "streamablehttp"}:
        t = "streamable_http"
    elif t in {"ws", "web_socket", "websocket"}:
        t = "websocket"
    return t


def _cli_safe_headers(item: Mapping[str, Any]) -> dict[str, str]:
    headers: dict[str, str] = {}
    raw = item.get("headers")
    if isinstance(raw, Mapping):
        for k, v in raw.items():
            if str(k).strip() and v is not None:
                headers[str(k)] = str(v)
    cid = str(item.get("connectionExternalId") or item.get("connection_external_id") or "").strip()
    if cid and not any(str(k).lower() == "x-connection-external-id" for k in headers):
        headers["X-Connection-External-Id"] = cid
    return headers


def _cli_patterns(server_name: str, item: Mapping[str, Any]) -> list[str]:
    raw = item.get("allowedTools") or item.get("allowed_tools")
    if isinstance(raw, list):
        tools = [str(t).strip() for t in raw if str(t).strip()]
        if tools:
            return [f"mcp__{server_name}__{t}" for t in tools]
    return [f"mcp__{server_name}"]


def _cli_sdk_oracle(agent_config: Mapping[str, Any], collect_patterns: bool):
    if not isinstance(agent_config, Mapping):
        return {}, []
    raw_servers = agent_config.get("mcpServers")
    if not isinstance(raw_servers, list):
        return {}, []
    servers: dict[str, dict[str, Any]] = {}
    allowed: list[str] = []
    for item in raw_servers:
        if not isinstance(item, Mapping):
            continue
        transport = _cli_norm_transport(item)
        if transport == "websocket":
            continue
        if transport not in {"streamable_http", "sse", "stdio"}:
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
        base_name = _dapr_norm_name(name_source)
        server_name = base_name
        suffix = 2
        while server_name in servers:
            server_name = f"{base_name}_{suffix}"
            suffix += 1
        if transport == "stdio":
            command = str(item.get("command") or "").strip()
            if not command:
                continue
            config = {"type": "stdio", "command": command}
            if isinstance(item.get("args"), list):
                config["args"] = [str(a) for a in item["args"]]
            if isinstance(item.get("env"), Mapping):
                env = {str(k): str(v) for k, v in item["env"].items() if str(k).strip() and v is not None}
                if env:
                    config["env"] = env
        else:
            url = str(item.get("url") or item.get("serverUrl") or "").strip()
            if not url.startswith(("http://", "https://")):
                continue
            url = _dapr_reachable(item, url)
            config = {"type": "http" if transport == "streamable_http" else "sse", "url": url}
            headers = _cli_safe_headers(item)
            if headers:
                config["headers"] = headers
        servers[server_name] = config
        if collect_patterns:
            allowed.extend(_cli_patterns(server_name, item))
    return servers, allowed


# --- oracle: verbatim dapr ``_extract_mcp_server_configs`` (post-coerce) ------
# Copied verbatim from services/dapr-agent-py/src/main.py (the post agentConfig
# coerce body) so the test pins TODAY's dapr output independent of the package.
def _dapr_norm_name(value: Any) -> str:
    text = str(value or "").strip().lower()
    text = re.sub(r"^@activepieces/piece-", "", text)
    text = re.sub(r"[^a-z0-9_-]+", "_", text)
    text = re.sub(r"_+", "_", text).strip("_")
    if not text:
        text = "mcp_server"
    if not re.match(r"^[a-z_]", text):
        text = f"mcp_{text}"
    return text[:48]


def _dapr_short_host(hostname: str) -> bool:
    if not hostname or "." in hostname:
        return False
    if hostname in {"localhost", "127.0.0.1", "::1"}:
        return False
    return (
        all(c.islower() or c.isdigit() or c == "-" for c in hostname)
        and hostname[0].isalnum()
        and hostname[-1].isalnum()
    )


def _dapr_should_qualify(server: dict) -> bool:
    st = str(server.get("sourceType") or server.get("source_type") or "")
    if st in {"nimble_piece", "nimble_shared", "hosted_workflow"}:
        return True
    rr = str(server.get("registryRef") or server.get("registry_ref") or "")
    return rr.startswith(("ap-", "nimble-", "shared-")) or rr in {
        "mcp-gateway",
        "shared-workflow-mcp-server",
    }


def _dapr_reachable(server: dict, url: str) -> str:
    text = str(url or "").strip()
    if not text or not _dapr_should_qualify(server):
        return text
    parsed = urllib.parse.urlparse(text)
    if parsed.scheme not in {"http", "https", "ws", "wss"} or not parsed.hostname:
        return text
    if not _dapr_short_host(parsed.hostname):
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
    return urllib.parse.urlunparse(parsed._replace(netloc=host))


def _dapr_oracle(agent_config: Mapping[str, Any]):
    if not isinstance(agent_config, dict):
        return {}, {}
    raw_servers = agent_config.get("mcpServers")
    if not isinstance(raw_servers, list):
        return {}, {}
    configs: dict[str, dict[str, Any]] = {}
    allowed_tools_by_server: dict[str, set[str]] = {}
    allowed_transports = {"streamable_http", "sse", "stdio", "websocket"}
    for item in raw_servers:
        if not isinstance(item, dict):
            continue
        raw_transport = str(
            item.get("transport") or item.get("type") or "streamable_http"
        ).strip().lower()
        transport = raw_transport.replace("-", "_")
        if transport in {"http", "streamablehttp"}:
            transport = "streamable_http"
        elif transport in {"ws", "web_socket"}:
            transport = "websocket"
        if transport not in allowed_transports:
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
        base_name = _dapr_norm_name(name_source)
        server_name = base_name
        suffix = 2
        while server_name in configs:
            server_name = f"{base_name}_{suffix}"
            suffix += 1
        config: dict[str, Any] = {"transport": transport}
        if transport == "stdio":
            command = str(item.get("command") or "").strip()
            if not command:
                continue
            config["command"] = command
            if isinstance(item.get("args"), list):
                config["args"] = [str(arg) for arg in item["args"]]
            if isinstance(item.get("env"), dict):
                config["env"] = {
                    str(k): str(v)
                    for k, v in item["env"].items()
                    if str(k).strip() and v is not None
                }
            if isinstance(item.get("cwd"), str) and item["cwd"].strip():
                config["cwd"] = item["cwd"].strip()
        else:
            url = str(item.get("url") or item.get("serverUrl") or "").strip()
            allowed_url_prefixes = (
                ("ws://", "wss://") if transport == "websocket" else ("http://", "https://")
            )
            if not url.startswith(allowed_url_prefixes):
                continue
            config["url"] = _dapr_reachable(item, url)
        headers = item.get("headers")
        if isinstance(headers, dict):
            safe_headers = {
                str(k): str(v)
                for k, v in headers.items()
                if str(k).strip() and v is not None
            }
            if safe_headers:
                config["headers"] = safe_headers
        connection_external_id = str(
            item.get("connectionExternalId") or item.get("connection_external_id") or ""
        ).strip()
        if connection_external_id:
            config_headers = config.setdefault("headers", {})
            if not any(
                str(k).lower() == "x-connection-external-id" for k in config_headers
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
            allowed_tools = {str(t).strip() for t in raw_allowed_tools if str(t).strip()}
            if allowed_tools:
                allowed_tools_by_server[server_name] = allowed_tools
    return configs, allowed_tools_by_server


# --- fixtures: cover every edge case the Pillar-1 plan flagged ----------------
def _ac(servers):
    return {"mcpServers": servers}


FIXTURES: dict[str, dict] = {
    "http_basic": _ac([{"name": "Weather", "transport": "streamable_http", "url": "https://api.example.com/mcp"}]),
    "sse_basic": _ac([{"name": "stream", "transport": "sse", "url": "https://api.example.com/sse"}]),
    "stdio_args_env": _ac([{"name": "fs", "transport": "stdio", "command": "npx", "args": ["-y", "x"], "env": {"A": "1", "B": None, "": "skip"}}]),
    "stdio_empty_env": _ac([{"name": "fs", "transport": "stdio", "command": "npx", "env": {}}]),
    "stdio_no_command": _ac([{"name": "broken", "transport": "stdio"}]),
    "websocket_literal": _ac([{"name": "wsx", "transport": "websocket", "url": "wss://api.example.com/ws"}]),
    "websocket_ws_alias": _ac([{"name": "wsx", "transport": "ws", "url": "wss://api.example.com/ws"}]),
    "conn_ext_only": _ac([{"name": "piece", "transport": "streamable_http", "url": "https://p/mcp", "connectionExternalId": "conn_123"}]),
    "conn_ext_with_headers": _ac([{"name": "piece", "transport": "streamable_http", "url": "https://p/mcp", "headers": {"X-Connection-External-Id": "explicit", "Other": "v"}, "connectionExternalId": "conn_123"}]),
    "dedup_same_name": _ac([
        {"name": "Dup", "transport": "streamable_http", "url": "https://a/mcp"},
        {"name": "dup", "transport": "sse", "url": "https://b/sse"},
    ]),
    "dedup_ws_collision": _ac([
        {"name": "foo", "transport": "websocket", "url": "wss://a/ws"},
        {"name": "foo", "transport": "streamable_http", "url": "https://b/mcp"},
    ]),
    "url_qualify_gateway": _ac([{"name": "gw", "transport": "streamable_http", "url": "http://mcp-gateway:8080/mcp", "registryRef": "mcp-gateway"}]),
    "allowed_tools": _ac([{"name": "piece", "transport": "streamable_http", "url": "https://p/mcp", "allowedTools": ["send", "read"]}]),
    "invalid_transport": _ac([{"name": "weird", "transport": "carrier-pigeon", "url": "https://x/y"}]),
    "invalid_url": _ac([{"name": "bad", "transport": "streamable_http", "url": "ftp://nope"}]),
    "dapr_numeric_bool": _ac([{"name": "tuned", "transport": "streamable_http", "url": "https://p/mcp", "timeout": 30, "sse_read_timeout": 60, "terminate_on_close": True}]),
    "empty": _ac([]),
    "no_mcp_key": {},
    "non_dict_items": _ac(["nope", 42, {"name": "ok", "transport": "streamable_http", "url": "https://ok/mcp"}]),
}


@pytest.mark.parametrize("name", list(FIXTURES))
def test_cli_emitter_matches_oracle(name):
    ac = FIXTURES[name]
    assert emit_claude_code_cli_servers(ac) == _cli_sdk_oracle(ac, collect_patterns=False)[0], name


@pytest.mark.parametrize("name", list(FIXTURES))
def test_claude_sdk_emitter_matches_oracle(name):
    ac = FIXTURES[name]
    assert emit_claude_agent_sdk_servers(ac) == _cli_sdk_oracle(ac, collect_patterns=True), name


@pytest.mark.parametrize("name", list(FIXTURES))
def test_dapr_emitter_matches_oracle(name):
    ac = FIXTURES[name]
    assert emit_dapr_agent_py(ac) == _dapr_oracle(ac), name


def test_ws_collision_dedup_differs_by_target():
    """The collision case the per-emitter dedup design exists to get right:
    dapr KEEPS the websocket (takes the ``foo`` slot, http -> ``foo_2``);
    the cli/sdk DROP it (http takes ``foo``)."""
    ac = FIXTURES["dedup_ws_collision"]
    dapr_configs, _ = emit_dapr_agent_py(ac)
    cli = emit_claude_code_cli_servers(ac)
    assert set(dapr_configs) == {"foo", "foo_2"}
    assert dapr_configs["foo"]["transport"] == "websocket"
    assert dapr_configs["foo_2"]["transport"] == "streamable_http"
    assert set(cli) == {"foo"}
    assert cli["foo"]["type"] == "http"


def test_conn_ext_id_injected_for_all_targets():
    ac = FIXTURES["conn_ext_only"]
    assert emit_claude_code_cli_servers(ac)["piece"]["headers"]["X-Connection-External-Id"] == "conn_123"
    sdk, _ = emit_claude_agent_sdk_servers(ac)
    assert sdk["piece"]["headers"]["X-Connection-External-Id"] == "conn_123"
    dapr, _ = emit_dapr_agent_py(ac)
    assert dapr["piece"]["headers"]["X-Connection-External-Id"] == "conn_123"

from __future__ import annotations

from src.claude_sdk_runner import build_claude_options

# mcp_config.py was consolidated into the shared capability compiler (Pillar 1);
# emit_claude_agent_sdk_servers is its byte-identical successor.
from src.capability_compiler import emit_claude_agent_sdk_servers as build_mcp_servers


def test_no_mcp_servers_returns_empty() -> None:
    assert build_mcp_servers(None) == ({}, [])
    assert build_mcp_servers({}) == ({}, [])
    assert build_mcp_servers({"mcpServers": "nope"}) == ({}, [])
    assert build_mcp_servers({"mcpServers": []}) == ({}, [])


def test_streamable_http_maps_to_sdk_http() -> None:
    servers, allowed = build_mcp_servers(
        {"mcpServers": [{"name": "GitHub", "transport": "streamable_http", "url": "https://mcp.example/sse"}]}
    )
    assert servers == {"github": {"type": "http", "url": "https://mcp.example/sse"}}
    assert allowed == ["mcp__github"]


def test_default_transport_is_streamable_http() -> None:
    # No transport field -> default streamable_http -> SDK "http" (mirrors dapr-agent-py).
    servers, _ = build_mcp_servers({"mcpServers": [{"name": "svc", "url": "https://h/mcp"}]})
    assert servers == {"svc": {"type": "http", "url": "https://h/mcp"}}


def test_http_and_streamablehttp_aliases() -> None:
    for transport in ("http", "streamablehttp", "streamable-http"):
        servers, _ = build_mcp_servers(
            {"mcpServers": [{"name": "svc", "transport": transport, "url": "https://h/mcp"}]}
        )
        assert servers["svc"]["type"] == "http"


def test_sse_transport() -> None:
    servers, _ = build_mcp_servers(
        {"mcpServers": [{"name": "svc", "transport": "sse", "url": "https://h/sse"}]}
    )
    assert servers == {"svc": {"type": "sse", "url": "https://h/sse"}}


def test_stdio_transport_with_args_and_env() -> None:
    servers, allowed = build_mcp_servers(
        {
            "mcpServers": [
                {
                    "name": "local",
                    "transport": "stdio",
                    "command": "npx",
                    "args": ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"],
                    "env": {"FOO": "bar", "EMPTY": None},
                }
            ]
        }
    )
    assert servers == {
        "local": {
            "type": "stdio",
            "command": "npx",
            "args": ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"],
            "env": {"FOO": "bar"},
        }
    }
    assert allowed == ["mcp__local"]


def test_stdio_without_command_skipped() -> None:
    servers, allowed = build_mcp_servers(
        {"mcpServers": [{"name": "local", "transport": "stdio"}]}
    )
    assert servers == {}
    assert allowed == []


def test_websocket_skipped_unsupported_by_sdk() -> None:
    servers, allowed = build_mcp_servers(
        {"mcpServers": [{"name": "ws", "transport": "websocket", "url": "ws://h/ws"}]}
    )
    assert servers == {}
    assert allowed == []


def test_invalid_http_url_skipped() -> None:
    servers, _ = build_mcp_servers(
        {"mcpServers": [{"name": "svc", "transport": "streamable_http", "url": "not-a-url"}]}
    )
    assert servers == {}


def test_duplicate_names_are_disambiguated() -> None:
    servers, allowed = build_mcp_servers(
        {
            "mcpServers": [
                {"name": "dup", "url": "https://a/mcp"},
                {"name": "dup", "url": "https://b/mcp"},
            ]
        }
    )
    assert set(servers) == {"dup", "dup_2"}
    assert allowed == ["mcp__dup", "mcp__dup_2"]


def test_connection_external_id_becomes_header() -> None:
    servers, _ = build_mcp_servers(
        {"mcpServers": [{"name": "svc", "url": "https://h/mcp", "connectionExternalId": "conn-123"}]}
    )
    assert servers["svc"]["headers"] == {"X-Connection-External-Id": "conn-123"}


def test_in_cluster_short_host_is_qualified() -> None:
    servers, _ = build_mcp_servers(
        {
            "mcpServers": [
                {
                    "name": "gw",
                    "registryRef": "mcp-gateway",
                    "namespace": "workflow-builder",
                    "url": "http://mcp-gateway:8080/mcp",
                }
            ]
        }
    )
    assert servers["gw"]["url"] == "http://mcp-gateway.workflow-builder.svc.cluster.local:8080/mcp"


def test_short_host_not_qualified_without_registry_marker() -> None:
    # Without a qualifying sourceType/registryRef, the URL is left untouched.
    servers, _ = build_mcp_servers(
        {"mcpServers": [{"name": "gw", "url": "http://mcp-gateway:8080/mcp"}]}
    )
    assert servers["gw"]["url"] == "http://mcp-gateway:8080/mcp"


def test_allowed_tools_narrowing() -> None:
    _, allowed = build_mcp_servers(
        {
            "mcpServers": [
                {"name": "svc", "url": "https://h/mcp", "allowedTools": ["search", "fetch"]}
            ]
        }
    )
    assert allowed == ["mcp__svc__search", "mcp__svc__fetch"]


def test_build_claude_options_wires_mcp_and_hook_events(tmp_path, monkeypatch) -> None:
    monkeypatch.setattr("src.claude_sdk_runner.DEFAULT_CWD", str(tmp_path))
    options = build_claude_options(
        {
            "sessionId": "s1",
            "agentConfig": {
                "modelSpec": "anthropic/claude-opus-4-8",
                "mcpServers": [{"name": "svc", "url": "https://h/mcp"}],
            },
        }
    )
    assert options.mcp_servers == {"svc": {"type": "http", "url": "https://h/mcp"}}
    assert options.strict_mcp_config is True
    assert options.allowed_tools == ["mcp__svc"]
    assert options.include_hook_events is True
    # Built-in tools preset is preserved alongside MCP.
    assert options.tools == {"type": "preset", "preset": "claude_code"}


def test_build_claude_options_no_mcp_leaves_strict_off(tmp_path, monkeypatch) -> None:
    monkeypatch.setattr("src.claude_sdk_runner.DEFAULT_CWD", str(tmp_path))
    options = build_claude_options(
        {"sessionId": "s1", "agentConfig": {"modelSpec": "anthropic/claude-opus-4-8"}}
    )
    assert options.mcp_servers == {}
    assert options.strict_mcp_config is False
    assert options.allowed_tools == []
    assert options.include_hook_events is True


def test_hook_event_extracts_response_only() -> None:
    from src.claude_sdk_runner import _hook_event

    class HookEventMessage:  # name-matched on purpose (runner checks __name__)
        def __init__(self, subtype, hook_event_name, data, uuid=None):
            self.subtype = subtype
            self.hook_event_name = hook_event_name
            self.data = data
            self.uuid = uuid

    started = HookEventMessage("hook_started", "PreToolUse", {})
    assert _hook_event(started) is None  # only completed responses are surfaced

    resp = HookEventMessage(
        "hook_response", "PreToolUse", {"outcome": "allow", "exit_code": 0}, uuid="u1"
    )
    evt = _hook_event(resp)
    assert evt is not None
    assert evt["type"] == "hook.decision"
    assert evt["data"]["hookEvent"] == "PreToolUse"
    assert evt["data"]["outcome"] == "allow"
    assert evt["data"]["exitCode"] == 0
    assert evt["sourceEventId"] == "hook:u1"


def test_hook_event_ignores_other_messages() -> None:
    from src.claude_sdk_runner import _hook_event

    class AssistantMessage:
        content = []

    assert _hook_event(AssistantMessage()) is None

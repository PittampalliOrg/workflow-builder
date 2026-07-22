"""Capability hook hosting: compaction in call_llm, overflow in execute_tool.

These exercise the real Harness OverflowingToolOutput plus the K3-aware history
window through the durable activity
seams — proving the hook chains run inside activities and their effects land
in the activity RETURN values (the durability contract).
"""

from __future__ import annotations

from typing import Any

import pytest

import src.toolsets as toolsets_mod
import src.workflow as wfmod
from src.messages_io import dump_messages, load_messages
from src.workflow import call_llm, execute_tool


class FakeActivityCtx:
    workflow_id = "wf-1"
    task_id = 1


@pytest.fixture()
def workspace(monkeypatch, tmp_path):
    monkeypatch.setattr(toolsets_mod, "WORKSPACE_ROOT", str(tmp_path))
    toolsets_mod._ROUTERS.clear()
    return tmp_path


def make_fake_model(captured: dict, parts_factory):
    from pydantic_ai.messages import ModelResponse
    from pydantic_ai.usage import RequestUsage

    class FakeModel:
        model_name = "kimi-k3"

        async def request(self, messages, model_settings, model_request_parameters):
            captured["messages"] = list(messages)
            captured["settings"] = model_settings
            return ModelResponse(
                parts=parts_factory(),
                usage=RequestUsage(input_tokens=10, output_tokens=5),
                model_name="kimi-k3",
            )

    return FakeModel()


def test_router_cache_shared_across_activities(workspace):
    r1 = toolsets_mod.get_router({"mcpServers": []})
    r2 = toolsets_mod.get_router({"mcpServers": []})
    assert r1 is r2
    r3 = toolsets_mod.get_router({"mcpServers": [{"url": "http://x/mcp"}]})
    assert r3 is not r1


def test_router_cache_changes_when_session_tool_policy_narrows(workspace):
    import asyncio as aio

    readable = toolsets_mod.get_router({"tools": ["read_file"]})
    denied = toolsets_mod.get_router({"tools": []})

    assert denied is not readable
    assert set(aio.run(readable.tools())) == {"read_file", "read_tool_result"}
    assert set(aio.run(denied.tools())) == {"read_tool_result"}


def test_router_builds_compaction_and_overflow_capabilities(workspace):
    router = toolsets_mod.get_router({})
    names = {type(c).__name__ for c in router._capabilities}
    assert "OverflowingToolOutput" in names
    assert "ClampOversizedMessages" not in names
    assert "SlidingWindow" not in names
    assert "KimiHistoryWindow" in names
    assert "FileSystem" in names and "Shell" in names
    assert "FunctionToolset" in names


def test_router_enforces_explicit_tool_narrowing(workspace):
    import asyncio as aio

    router = toolsets_mod.ToolRouter(
        {"tools": ["read_file"], "allowedTools": ["read_file"]}
    )
    assert set(aio.run(router.tools())) == {"read_file", "read_tool_result"}

    router = toolsets_mod.ToolRouter({"tools": []})
    assert set(aio.run(router.tools())) == {"read_tool_result"}

    router = toolsets_mod.ToolRouter({"tools": ["execute_command"]})
    assert set(aio.run(router.tools())) == {"run_command", "read_tool_result"}

    router = toolsets_mod.ToolRouter(
        {"tools": [], "builtinTools": ["read_file", "ReadMediaFile"]}
    )
    assert set(aio.run(router.tools())) == {
        "read_file",
        "ReadMediaFile",
        "read_tool_result",
    }

    router = toolsets_mod.ToolRouter(
        {
            "tools": [],
            "builtinTools": ["read_file", "write_file"],
            "allowedTools": ["read_file"],
        }
    )
    assert set(aio.run(router.tools())) == {"read_file", "read_tool_result"}


def test_router_enforces_tool_narrowing_on_cached_mcp_listing(workspace):
    import asyncio as aio
    import time

    class CachedMcpToolset:
        pass

    toolset = CachedMcpToolset()
    router = toolsets_mod.ToolRouter(
        {"tools": ["read_file"], "allowedTools": ["read_file"]}
    )
    router._toolsets = [toolset]
    router._network_toolsets = {id(toolset)}
    router._mcp_tools_cache = {
        id(toolset): (
            time.monotonic() + 60,
            {"read_file": object(), "write_file": object()},
        )
    }

    assert set(aio.run(router.tools())) == {"read_file"}


def test_router_enforces_per_server_mcp_allowlist(monkeypatch, workspace):
    import asyncio as aio
    import pydantic_ai.capabilities as capabilities

    called: list[str] = []

    class FakeToolset:
        async def get_tools(self, _ctx):
            return {"read_issue": object(), "delete_issue": object()}

        async def call_tool(self, name, _args, _ctx, _tool):
            called.append(name)
            return name

    class FakeMCP:
        def __init__(self, _url, **_kwargs):
            self.toolset = FakeToolset()

        def get_toolset(self):
            return self.toolset

    monkeypatch.setattr(capabilities, "MCP", FakeMCP)
    router = toolsets_mod.ToolRouter(
        {
            "builtinTools": ["read_file"],
            "tools": [],
            "mcpServers": [
                {
                    "url": "https://mcp.example.test/mcp",
                    "allowedTools": ["read_issue"],
                }
            ],
        }
    )

    exposed = aio.run(router.tools())
    assert "read_issue" in exposed
    assert "delete_issue" not in exposed
    assert "read_file" in exposed
    assert "read_tool_result" in exposed
    assert aio.run(router.call("read_issue", {})) == "read_issue"
    with pytest.raises(KeyError, match="unknown tool"):
        aio.run(router.call("delete_issue", {}))
    assert called == ["read_issue"]


def test_harness_support_tool_wins_over_mcp_name_collision(monkeypatch, workspace):
    import asyncio as aio
    import pydantic_ai.capabilities as capabilities

    class FakeToolset:
        async def get_tools(self, _ctx):
            return {"read_tool_result": object(), "remote_tool": object()}

    class FakeMCP:
        def __init__(self, _url, **_kwargs):
            self.toolset = FakeToolset()

        def get_toolset(self):
            return self.toolset

    monkeypatch.setattr(capabilities, "MCP", FakeMCP)
    router = toolsets_mod.ToolRouter(
        {"mcpServers": [{"url": "https://mcp.example.test/mcp"}]}
    )

    exposed = aio.run(router.tools())
    assert "remote_tool" in exposed
    assert id(exposed["read_tool_result"][0]) in router._support_toolsets


def test_compaction_flags_disable_capabilities(monkeypatch, tmp_path):
    monkeypatch.setattr(toolsets_mod, "WORKSPACE_ROOT", str(tmp_path))
    monkeypatch.setattr(toolsets_mod, "COMPACTION_ENABLED", False)
    monkeypatch.setattr(toolsets_mod, "OVERFLOW_ENABLED", False)
    toolsets_mod._ROUTERS.clear()
    router = toolsets_mod.ToolRouter({})
    names = {type(c).__name__ for c in router._capabilities}
    assert "SlidingWindow" not in names
    assert "KimiHistoryWindow" not in names
    assert "OverflowingToolOutput" not in names
    # core tools still present
    assert "FileSystem" in names and "Shell" in names


def test_kimi_history_window_reserves_context_and_transport_budgets(
    monkeypatch, tmp_path
):
    from src.config import (
        COMPACTION_KEEP_MESSAGES,
        COMPACTION_MAX_MESSAGES,
        KIMI_COMPACTION_KEEP_TOKENS,
        KIMI_CONTEXT_WINDOW,
        KIMI_INPUT_SAFETY_BUFFER_TOKENS,
        KIMI_MAX_COMPLETION_TOKENS,
        KIMI_MAX_INPUT_TOKENS,
        TRANSCRIPT_KEEP_BYTES,
        TRANSCRIPT_MAX_BYTES,
    )

    monkeypatch.setattr(toolsets_mod, "WORKSPACE_ROOT", str(tmp_path))
    toolsets_mod._ROUTERS.clear()
    router = toolsets_mod.ToolRouter({})
    window = next(
        capability
        for capability in router._capabilities
        if type(capability).__name__ == "KimiHistoryWindow"
    )

    assert window.max_tokens == KIMI_MAX_INPUT_TOKENS
    assert window.keep_tokens == KIMI_COMPACTION_KEEP_TOKENS
    assert window.keep_tokens < window.max_tokens
    assert window.max_bytes == TRANSCRIPT_MAX_BYTES
    assert window.keep_bytes == TRANSCRIPT_KEEP_BYTES
    assert window.keep_bytes < window.max_bytes
    assert window.max_messages == COMPACTION_MAX_MESSAGES
    assert window.keep_messages == COMPACTION_KEEP_MESSAGES
    assert (
        window.max_tokens + KIMI_MAX_COMPLETION_TOKENS + KIMI_INPUT_SAFETY_BUFFER_TOKENS
        == KIMI_CONTEXT_WINDOW
    )


def test_kimi_message_window_compacts_history_in_call_llm(monkeypatch, workspace):
    """A long history is windowed by before_model_request; what the model
    receives AND what the activity returns is the compacted list."""
    from pydantic_ai.messages import ModelRequest, TextPart, UserPromptPart

    from src.compaction.kimi_history import KimiHistoryWindow

    monkeypatch.setattr(
        toolsets_mod,
        "KimiHistoryWindow",
        lambda: KimiHistoryWindow(max_messages=6, keep_messages=4),
    )
    toolsets_mod._ROUTERS.clear()

    captured: dict[str, Any] = {}
    fake = make_fake_model(captured, lambda: [TextPart(content="ok")])
    monkeypatch.setattr(wfmod, "build_model", lambda: fake)

    # 30 prior messages + a fresh user turn.
    history = dump_messages(
        [ModelRequest(parts=[UserPromptPart(content=f"msg {i}")]) for i in range(30)]
    )
    out = call_llm(
        FakeActivityCtx(),
        {"task": "continue", "messages": history, "context": {}, "iteration": 5},
    )
    # The model saw far fewer than 31 messages (windowed).
    assert len(captured["messages"]) < 31
    # The activity's returned history reflects the compaction (durability
    # contract: replay sees the same bounded history).
    returned = load_messages(out["messages"])
    assert len(returned) <= len(captured["messages"]) + 1  # + the appended response


def test_token_sliding_window_compacts_before_durable_model_request(
    monkeypatch, workspace
):
    from pydantic_ai.messages import ModelRequest, TextPart, UserPromptPart

    from src.compaction.kimi_history import KimiHistoryWindow

    monkeypatch.setattr(
        toolsets_mod,
        "KimiHistoryWindow",
        lambda: KimiHistoryWindow(
            max_messages=1_000,
            keep_messages=900,
            max_tokens=300,
            keep_tokens=200,
            max_bytes=100_000,
            keep_bytes=80_000,
        ),
    )
    toolsets_mod._ROUTERS.clear()

    captured: dict[str, Any] = {}
    fake = make_fake_model(captured, lambda: [TextPart(content="ok")])
    monkeypatch.setattr(wfmod, "build_model", lambda: fake)
    history = dump_messages(
        [
            ModelRequest(parts=[UserPromptPart(content=f"message {i} " + "x" * 80)])
            for i in range(30)
        ]
    )

    out = call_llm(
        FakeActivityCtx(),
        {"task": "continue", "messages": history, "context": {}, "iteration": 5},
    )

    assert len(captured["messages"]) < 31
    returned = load_messages(out["messages"])
    assert len(returned) <= len(captured["messages"]) + 1


def test_kimi_history_budget_failure_is_not_skipped_or_retried(monkeypatch, workspace):
    from pydantic_ai.messages import TextPart

    from src.compaction.kimi_history import KimiHistoryWindow

    monkeypatch.setattr(
        toolsets_mod,
        "KimiHistoryWindow",
        lambda: KimiHistoryWindow(
            max_messages=1_000,
            keep_messages=900,
            max_tokens=10,
            keep_tokens=5,
            max_bytes=1_000,
            keep_bytes=500,
        ),
    )
    toolsets_mod._ROUTERS.clear()
    captured: dict[str, Any] = {}
    fake = make_fake_model(captured, lambda: [TextPart(content="should not run")])
    monkeypatch.setattr(wfmod, "build_model", lambda: fake)

    out = call_llm(
        FakeActivityCtx(),
        {"task": "x" * 1_000, "messages": [], "context": {}, "iteration": 0},
    )

    assert out["configurationErrorCode"] == "model_context_window_error"
    assert "messages" not in captured


def test_kimi_history_does_not_mutate_retained_assistant_text(monkeypatch, workspace):
    """K3 replay keeps retained assistant messages byte-for-byte."""
    from pydantic_ai.messages import (
        ModelRequest,
        ModelResponse,
        TextPart,
        UserPromptPart,
    )

    toolsets_mod._ROUTERS.clear()

    captured: dict[str, Any] = {}
    fake = make_fake_model(captured, lambda: [TextPart(content="done")])
    monkeypatch.setattr(wfmod, "build_model", lambda: fake)

    big = "X" * 50000
    history = dump_messages(
        [
            ModelRequest(parts=[UserPromptPart(content="earlier")]),
            ModelResponse(parts=[TextPart(content=big)]),
        ]
    )
    call_llm(
        FakeActivityCtx(),
        {"task": "go", "messages": history, "context": {}, "iteration": 2},
    )
    seen = "".join(
        p.content
        for m in captured["messages"]
        for p in getattr(m, "parts", [])
        if type(p).__name__ == "TextPart" and isinstance(p.content, str)
    )
    assert seen == big


def test_overflow_spills_large_tool_output_in_execute_tool(monkeypatch, workspace):
    """A large tool result is spilled/truncated by after_tool_execute; the
    in-history ToolReturnPart is bounded and the spill file exists."""
    monkeypatch.setattr(toolsets_mod, "OVERFLOW_ENABLED", True)
    toolsets_mod._ROUTERS.clear()

    # write a big file, then read it back (read_file yields a large result)
    big = "line\n" * 20000
    (workspace / "big.txt").write_text(big)

    out = execute_tool(
        FakeActivityCtx(),
        {
            "call": {
                "toolName": "read_file",
                "toolCallId": "tc-big",
                "args": {"path": "big.txt"},
            },
            "context": {},
            "iteration": 0,
        },
    )
    part = load_messages([out["message"]])[0].parts[0]
    content = str(part.content)
    # Bounded in history (overflow band trips well under the full ~100k body).
    assert len(content) < len(big)
    # Spill directory was created by the LocalFileStore.
    assert (workspace / ".overflow").exists()


async def test_read_tool_result_tool_is_offered(workspace):
    """OverflowingToolOutput contributes read_tool_result so the model can
    fetch spilled content — proves the toolset seam is wired."""
    router = toolsets_mod.get_router({})
    names = set(await router.tools())
    assert "read_tool_result" in names
    # core coding tools still present alongside it
    assert {"read_file", "write_file", "run_command"} <= names


async def test_read_tool_result_survives_runtime_tool_ceiling(workspace):
    """The overflow reader is infrastructure, not an optional agent tool."""
    router = toolsets_mod.get_router(
        {
            "builtinTools": ["read_file", "write_file"],
            "allowedTools": ["read_file"],
        }
    )
    assert set(await router.tools()) == {"read_file", "read_tool_result"}


def test_execute_tool_does_not_relist_toolsets(monkeypatch, workspace):
    """A known local execution route never invokes the global inventory."""
    calls = {"count": 0}
    real = toolsets_mod.ToolRouter.tools

    async def counting_tools(self):
        calls["count"] += 1
        return await real(self)

    monkeypatch.setattr(toolsets_mod.ToolRouter, "tools", counting_tools)
    toolsets_mod._ROUTERS.clear()
    (workspace / "f.txt").write_text("hello")
    out = execute_tool(
        FakeActivityCtx(),
        {
            "call": {
                "toolName": "read_file",
                "toolCallId": "t1",
                "args": {"path": "f.txt"},
            },
            "context": {},
            "iteration": 0,
        },
    )
    assert load_messages([out["message"]])[0].parts[0].tool_call_id == "t1"
    assert calls["count"] == 0


def test_parallel_local_calls_and_cached_mcp_route_skip_expired_listing(
    workspace,
):
    import asyncio as aio
    from concurrent.futures import ThreadPoolExecutor

    from pydantic_ai.tools import ToolDefinition

    def tool(name):
        definition = ToolDefinition(
            name=name, parameters_json_schema={"type": "object"}
        )
        return type("Tool", (), {"tool_def": definition})()

    class LocalToolset:
        def __init__(self):
            self.tools = {name: tool(name) for name in ("local_one", "local_two")}

        async def get_tools(self, _ctx):
            return self.tools

        async def call_tool(self, name, _args, _ctx, _tool):
            await aio.sleep(0.01)
            return f"{name}:ok"

    class NetworkToolset:
        def __init__(self):
            self.list_calls = 0
            self.allow_listing = True
            self.remote = tool("remote_tool")

        async def get_tools(self, _ctx):
            if not self.allow_listing:
                raise AssertionError("expired MCP listing was probed during execution")
            self.list_calls += 1
            return {"remote_tool": self.remote}

        async def call_tool(self, name, _args, _ctx, _tool):
            return f"{name}:ok"

    local = LocalToolset()
    network = NetworkToolset()
    router = toolsets_mod.ToolRouter({})
    router._toolsets = [local, network]
    router._network_toolsets = {id(network)}
    router._toolset_allowlists = {id(network): None}

    advertised = aio.run(router.tools())
    assert set(advertised) == {"local_one", "local_two", "remote_tool"}
    assert network.list_calls == 1
    _, cached_tools = router._mcp_tools_cache[id(network)]
    router._mcp_tools_cache[id(network)] = (0.0, cached_tools)
    network.allow_listing = False

    with ThreadPoolExecutor(max_workers=2) as pool:
        futures = [
            pool.submit(aio.run, router.call(name, {}))
            for name in ("local_one", "local_two")
        ]
        assert [future.result() for future in futures] == [
            "local_one:ok",
            "local_two:ok",
        ]

    # Even without the execution-route entry, the expired advertisement cache
    # is sufficient to route a call the model already emitted.
    router._tool_routes.pop("remote_tool")
    assert aio.run(router.call("remote_tool", {})) == "remote_tool:ok"
    assert network.list_calls == 1


def test_refreshed_mcp_advertisement_prunes_removed_execution_routes(workspace):
    import asyncio as aio

    from pydantic_ai.tools import ToolDefinition

    def tool(name):
        definition = ToolDefinition(
            name=name, parameters_json_schema={"type": "object"}
        )
        return type("Tool", (), {"tool_def": definition})()

    class ChangingToolset:
        def __init__(self):
            self.tools = {"removed_tool": tool("removed_tool")}

        async def get_tools(self, _ctx):
            return self.tools

    network = ChangingToolset()
    router = toolsets_mod.ToolRouter({})
    router._toolsets = [network]
    router._network_toolsets = {id(network)}
    router._toolset_allowlists = {id(network): None}

    _, sequential = aio.run(router.tool_defs_with_execution())
    assert sequential == {"removed_tool"}
    assert set(router._tool_routes) == {"removed_tool"}

    network.tools = {"replacement_tool": tool("replacement_tool")}
    router._mcp_tools_cache[id(network)] = (0.0, {})
    definitions, sequential = aio.run(router.tool_defs_with_execution())

    assert {definition.name for definition in definitions} == {"replacement_tool"}
    assert all(definition.sequential for definition in definitions)
    assert sequential == {"replacement_tool"}
    assert set(router._tool_routes) == {"replacement_tool"}


def test_mcp_toolset_get_tools_timeout_is_soft(monkeypatch, workspace):
    """A hung network (MCP) toolset times out and is skipped — the turn's
    other tools still resolve (activity never wedges)."""
    import asyncio as _asyncio

    monkeypatch.setattr(toolsets_mod, "MCP_LIST_TIMEOUT_SECONDS", 1)
    toolsets_mod._ROUTERS.clear()
    router = toolsets_mod.ToolRouter({})

    class HangingToolset:
        async def get_tools(self, ctx):
            await _asyncio.sleep(60)
            return {}

    hung = HangingToolset()
    router._toolsets.append(hung)
    router._network_toolsets.add(id(hung))

    async def go():
        return await router.tools()

    names = set(
        _asyncio.get_event_loop().run_until_complete(go())
        if False
        else __import__("asyncio").run(go())
    )
    # local FS/Shell tools still present despite the hung MCP toolset
    assert {"read_file", "run_command"} <= names


def test_timed_out_mcp_listing_rebuilds_for_the_next_probe(monkeypatch, workspace):
    import asyncio as aio

    monkeypatch.setattr(toolsets_mod, "MCP_LIST_TIMEOUT_SECONDS", 0.01)
    router = toolsets_mod.ToolRouter({})
    tool = type("Tool", (), {"tool_def": object()})()

    class HangingToolset:
        cancelled = False

        async def get_tools(self, _ctx):
            try:
                await aio.sleep(60)
            except aio.CancelledError:
                self.cancelled = True
                raise

    class HealthyToolset:
        list_calls = 0

        async def get_tools(self, _ctx):
            self.list_calls += 1
            return {"remote_tool": tool}

    hanging = HangingToolset()
    healthy = HealthyToolset()
    router._toolsets = [hanging]
    router._network_toolsets = {id(hanging)}
    router._toolset_allowlists = {id(hanging): None}
    router._network_toolset_factories = {id(hanging): lambda: healthy}

    assert aio.run(router.tools()) == {}
    assert hanging.cancelled is True
    assert router._toolsets == [healthy]
    assert router._mcp_fail_until[id(healthy)] > 0
    assert aio.run(router.tools()) == {}
    assert healthy.list_calls == 0
    router._mcp_fail_until[id(healthy)] = 0.0
    assert set(aio.run(router.tools())) == {"remote_tool"}
    assert healthy.list_calls == 1


def test_tool_def_execution_metadata_honors_native_and_mcp_sequentiality(
    workspace,
):
    import asyncio as aio

    from pydantic_ai.tools import ToolDefinition

    class Toolset:
        def __init__(self, tools):
            self.tools = tools

        async def get_tools(self, _ctx):
            return self.tools

    def tool(name, *, sequential=False):
        definition = ToolDefinition(
            name=name,
            parameters_json_schema={"type": "object"},
            sequential=sequential,
        )
        return type("Tool", (), {"tool_def": definition})()

    local = Toolset(
        {
            "local_parallel": tool("local_parallel"),
            "local_sequential": tool("local_sequential", sequential=True),
        }
    )
    network = Toolset({"remote": tool("remote")})
    router = toolsets_mod.ToolRouter({})
    router._toolsets = [local, network]
    router._network_toolsets = {id(network)}
    router._toolset_allowlists = {id(network): None}

    definitions, sequential = aio.run(router.tool_defs_with_execution())

    by_name = {definition.name: definition for definition in definitions}
    assert sequential == {"local_sequential", "remote"}
    assert by_name["local_parallel"].sequential is False
    assert by_name["local_sequential"].sequential is True
    assert by_name["remote"].sequential is True


def test_timed_out_mcp_call_rebuilds_only_its_client(monkeypatch, workspace):
    import asyncio as aio

    monkeypatch.setattr(toolsets_mod, "MCP_CALL_TIMEOUT_SECONDS", 0.01)
    router = toolsets_mod.ToolRouter({})

    tool = type("Tool", (), {"tool_def": object()})()

    class HangingToolset:
        cancelled = False

        async def get_tools(self, _ctx):
            return {"remote_tool": tool}

        async def call_tool(self, _name, _args, _ctx, _tool):
            try:
                await aio.sleep(60)
            except aio.CancelledError:
                self.cancelled = True
                raise

    class HealthyToolset:
        async def get_tools(self, _ctx):
            return {"remote_tool": tool}

        async def call_tool(self, name, _args, _ctx, _tool):
            return f"{name}:ok"

    hanging = HangingToolset()
    healthy = HealthyToolset()
    untouched = object()
    router._toolsets = [hanging, untouched]
    router._network_toolsets = {id(hanging)}
    router._toolset_allowlists = {id(hanging): None}
    router._network_toolset_factories = {id(hanging): lambda: healthy}

    with pytest.raises(aio.TimeoutError):
        aio.run(router.call("remote_tool", {}))

    assert hanging.cancelled is True
    assert router._toolsets == [healthy, untouched]
    assert id(hanging) not in router._network_toolsets
    assert id(healthy) in router._network_toolsets
    assert aio.run(router.call("remote_tool", {})) == "remote_tool:ok"


class _FlakyToolset:
    """Network toolset double: fails get_tools until told otherwise."""

    def __init__(self):
        self.list_calls = 0
        self.healthy = False
        self.tool_def = type("TD", (), {"name": "remote_tool"})()

    async def get_tools(self, ctx):
        self.list_calls += 1
        if not self.healthy:
            raise RuntimeError("Client failed to connect")
        tool = type("T", (), {"tool_def": self.tool_def})()
        return {"remote_tool": tool}


def test_mcp_listing_negative_and_positive_cache(monkeypatch, tmp_path):
    import src.toolsets as toolsets_mod
    from src.toolsets import ToolRouter

    monkeypatch.setattr(toolsets_mod, "WORKSPACE_ROOT", str(tmp_path))
    router = ToolRouter({})
    flaky = _FlakyToolset()
    router._toolsets.append(flaky)
    router._network_toolsets.add(id(flaky))

    import asyncio as aio

    # First round probes and fails -> negative-cached.
    aio.run(router.tools())
    assert flaky.list_calls == 1
    # Second round within the fail window must NOT re-probe.
    aio.run(router.tools())
    assert flaky.list_calls == 1

    # Expire the failure window; server is healthy now -> one probe, cached.
    router._mcp_fail_until[id(flaky)] = 0.0
    flaky.healthy = True
    tools = aio.run(router.tools())
    assert "remote_tool" in tools
    assert flaky.list_calls == 2
    # Subsequent rounds serve from the positive cache (fresh event loop too).
    tools = aio.run(router.tools())
    assert "remote_tool" in tools
    assert flaky.list_calls == 2


def test_repo_inventory_tool_disabled_by_default(monkeypatch, tmp_path):
    """The harness inventory hint reads as a standing mission ("...so you can
    read and translate it") and hijacked vague turns — tool + hint stay off
    unless PYDANTIC_AI_REPO_INVENTORY_TOOL opts in."""
    import asyncio as aio

    import src.toolsets as toolsets_mod
    from src.toolsets import ToolRouter

    monkeypatch.setattr(toolsets_mod, "WORKSPACE_ROOT", str(tmp_path))
    router = ToolRouter({})
    tools = aio.run(router.tools())
    assert "inventory_agent_context" not in tools
    instructions = aio.run(router.instructions())
    assert "translate" not in instructions


def test_stamp_workflow_mcp_session_token_targets_only_workflow_mcp():
    from src.session import _stamp_workflow_mcp_session_token

    cfg = {
        "mcpServers": [
            {
                "name": "wfb_team",
                "url": "http://workflow-mcp-server.ns.svc:3200/mcp",
                "headers": {"X-Wfb-Team-Id": "team-1"},
            },
            {"name": "gh", "url": "http://ap-github-service.ns.svc/mcp"},
        ]
    }
    _stamp_workflow_mcp_session_token(cfg, "sesn_1", "signed.jwt.token")
    team = cfg["mcpServers"][0]["headers"]
    assert team["X-Wfb-Session-Token"] == "signed.jwt.token"
    assert team["X-Wfb-Session-Id"] == "sesn_1"
    assert team["X-Wfb-Team-Id"] == "team-1"  # preserved
    # non-workflow-mcp servers are untouched
    assert "headers" not in cfg["mcpServers"][1]


def test_stamp_workflow_mcp_session_token_noops_without_token():
    from src.session import _stamp_workflow_mcp_session_token

    cfg = {"mcpServers": [{"url": "http://workflow-mcp-server.x/mcp"}]}
    _stamp_workflow_mcp_session_token(cfg, "sesn_1", "")
    assert "headers" not in cfg["mcpServers"][0]


def test_mcp_capability_forwards_headers(monkeypatch, tmp_path):
    import src.toolsets as toolsets_mod
    from src.toolsets import build_capabilities

    monkeypatch.setattr(toolsets_mod, "WORKSPACE_ROOT", str(tmp_path))
    monkeypatch.setattr(toolsets_mod, "MCP_CALL_TIMEOUT_SECONDS", 480)
    monkeypatch.setattr(toolsets_mod, "MCP_READ_TIMEOUT_SECONDS", 470)
    caps = build_capabilities(
        {
            "mcpServers": [
                {
                    "url": "http://workflow-mcp-server.ns.svc:3200/mcp",
                    "transport": "streamable_http",
                    "headers": {
                        "X-Wfb-Session-Token": "tok",
                        "X-Wfb-Session-Id": "sesn_1",
                    },
                }
            ]
        }
    )
    bindings = [c for c in caps if type(c).__name__ == "_McpCapabilityBinding"]
    assert len(bindings) == 1
    assert bindings[0].capability.headers == {
        "X-Wfb-Session-Token": "tok",
        "X-Wfb-Session-Id": "sesn_1",
    }
    read_timeout = (
        bindings[0].get_toolset().client._session_kwargs["read_timeout_seconds"]
    )
    assert read_timeout.total_seconds() == 470


def test_shell_scrubs_credentials_but_keeps_path(monkeypatch, tmp_path):
    """A shell command must not read the pod's KIMI_API_KEY / internal token,
    but PATH (inherited) must survive so commands still run."""
    import asyncio as aio

    import src.toolsets as toolsets_mod
    from src.toolsets import build_capabilities

    monkeypatch.setattr(toolsets_mod, "WORKSPACE_ROOT", str(tmp_path))
    monkeypatch.setenv("KIMI_API_KEY", "sk-kimi-secret")
    monkeypatch.setenv("INTERNAL_API_TOKEN", "internal-secret")
    monkeypatch.setenv("HARMLESS_VAR", "keepme")

    caps = build_capabilities({})
    shell = next(c for c in caps if type(c).__name__ == "Shell")
    toolset = shell.get_toolset()

    out = aio.run(
        toolset.run_command(
            "printenv KIMI_API_KEY || echo ABSENT; "
            "printenv INTERNAL_API_TOKEN || echo ABSENT2; "
            "printenv HARMLESS_VAR; "
            'test -n "$PATH" && echo PATH_OK'
        )
    )
    assert "sk-kimi-secret" not in out
    assert "internal-secret" not in out
    assert "ABSENT" in out and "ABSENT2" in out
    assert "keepme" in out
    assert "PATH_OK" in out

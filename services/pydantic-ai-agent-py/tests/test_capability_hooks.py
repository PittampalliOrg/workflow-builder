"""Capability hook hosting: compaction in call_llm, overflow in execute_tool.

These exercise the REAL harness capabilities (SlidingWindow,
ClampOversizedMessages, OverflowingToolOutput) through the durable activity
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


def test_router_builds_compaction_and_overflow_capabilities(workspace):
    router = toolsets_mod.get_router({})
    names = {type(c).__name__ for c in router._capabilities}
    assert "OverflowingToolOutput" in names
    assert "ClampOversizedMessages" in names
    assert "SlidingWindow" in names
    assert "FileSystem" in names and "Shell" in names


def test_compaction_flags_disable_capabilities(monkeypatch, tmp_path):
    monkeypatch.setattr(toolsets_mod, "WORKSPACE_ROOT", str(tmp_path))
    monkeypatch.setattr(toolsets_mod, "COMPACTION_ENABLED", False)
    monkeypatch.setattr(toolsets_mod, "OVERFLOW_ENABLED", False)
    toolsets_mod._ROUTERS.clear()
    router = toolsets_mod.ToolRouter({})
    names = {type(c).__name__ for c in router._capabilities}
    assert "SlidingWindow" not in names
    assert "OverflowingToolOutput" not in names
    # core tools still present
    assert "FileSystem" in names and "Shell" in names


def test_sliding_window_compacts_history_in_call_llm(monkeypatch, workspace):
    """A long history is windowed by before_model_request; what the model
    receives AND what the activity returns is the compacted list."""
    from pydantic_ai.messages import ModelRequest, TextPart, UserPromptPart

    # Tight window so the effect is unambiguous.
    monkeypatch.setattr(toolsets_mod, "COMPACTION_MAX_MESSAGES", 6)
    monkeypatch.setattr(toolsets_mod, "COMPACTION_KEEP_MESSAGES", 4)
    monkeypatch.setattr(toolsets_mod, "CLAMP_MAX_PART_CHARS", 100000)
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


def test_clamp_shrinks_oversized_assistant_text_in_call_llm(monkeypatch, workspace):
    """ClampOversizedMessages targets ModelResponse parts (prior assistant
    text + tool-call args) — complementary to OverflowingToolOutput, which
    handles tool RESULTS. A huge prior assistant TextPart is clamped before
    the next model call."""
    from pydantic_ai.messages import (
        ModelRequest,
        ModelResponse,
        TextPart,
        UserPromptPart,
    )

    monkeypatch.setattr(toolsets_mod, "CLAMP_MAX_PART_CHARS", 500)
    monkeypatch.setattr(toolsets_mod, "COMPACTION_MAX_MESSAGES", 1000)
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
    # the 50k assistant TextPart reached the model clamped well below 50k
    assert 0 < len(seen) < 50000


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


def test_execute_tool_does_not_relist_toolsets(monkeypatch, workspace):
    """Regression guard: execute_tool must NOT call router.tools() a second
    time for the after_tool_execute hook (that re-lists MCP over the network
    and can wedge the durable activity). It routes tool_def=None instead."""
    import src.workflow as _wf

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
            "call": {"toolName": "read_file", "toolCallId": "t1", "args": {"path": "f.txt"}},
            "context": {},
            "iteration": 0,
        },
    )
    assert load_messages([out["message"]])[0].parts[0].tool_call_id == "t1"
    # router.call lists once; the after-hook must NOT list again.
    assert calls["count"] == 1


def test_mcp_toolset_get_tools_timeout_is_soft(monkeypatch, workspace):
    """A hung network (MCP) toolset times out and is skipped — the turn's
    other tools still resolve (activity never wedges)."""
    import asyncio as _asyncio

    monkeypatch.setattr(toolsets_mod, "MCP_TIMEOUT_SECONDS", 1)
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

    names = set(_asyncio.get_event_loop().run_until_complete(go())
                if False else __import__("asyncio").run(go()))
    # local FS/Shell tools still present despite the hung MCP toolset
    assert {"read_file", "run_command"} <= names

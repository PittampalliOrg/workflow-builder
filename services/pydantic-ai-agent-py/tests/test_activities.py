"""call_llm / execute_tool / check_cancellation activity behavior."""

from __future__ import annotations

from typing import Any

import pytest

import src.toolsets as toolsets_mod
import src.workflow as wfmod
from src.messages_io import dump_messages, load_messages
from src.workflow import call_llm, check_cancellation, execute_tool


@pytest.fixture()
def workspace(monkeypatch, tmp_path):
    monkeypatch.setattr(toolsets_mod, "WORKSPACE_ROOT", str(tmp_path))
    return tmp_path


class FakeActivityCtx:
    workflow_id = "wf-1"
    task_id = 1


def make_fake_model(captured: dict, responses: list):
    from pydantic_ai.messages import ModelResponse
    from pydantic_ai.usage import RequestUsage

    class FakeModel:
        model_name = "kimi-k3"

        async def request(self, messages, model_settings, model_request_parameters):
            captured["messages"] = list(messages)
            captured["settings"] = model_settings
            captured["params"] = model_request_parameters
            parts = responses.pop(0)
            return ModelResponse(
                parts=parts,
                usage=RequestUsage(
                    input_tokens=120, cache_read_tokens=20, output_tokens=30
                ),
                model_name="kimi-k3",
            )

    return FakeModel()


def test_call_llm_bootstraps_and_extracts_tool_calls(monkeypatch, workspace):
    from pydantic_ai.messages import TextPart, ToolCallPart

    captured: dict[str, Any] = {}
    fake = make_fake_model(
        captured,
        [[TextPart(content="working"),
          ToolCallPart(tool_name="run_command", args={"command": "ls"}, tool_call_id="tc9")]],
    )
    monkeypatch.setattr(wfmod, "build_model", lambda: fake)

    out = call_llm(
        FakeActivityCtx(),
        {
            "task": "list the files",
            "messages": [],
            "context": {
                "sessionId": None,
                "agentConfig": {"systemPrompt": "You are a test agent."},
            },
            "iteration": 0,
        },
    )

    # kimi request params flowed through pydantic-ai ModelSettings
    settings = captured["settings"]
    assert settings["temperature"] == 1
    assert settings["frequency_penalty"] == 0
    assert settings["extra_body"] == {"reasoning_effort": "max"}

    # harness tools were offered to the model as pydantic-ai ToolDefinitions
    tool_names = {t.name for t in captured["params"].function_tools}
    assert {"read_file", "write_file", "edit_file", "run_command"} <= tool_names

    # bootstrap: system prompt + user task in the first request
    first = captured["messages"][0]
    kinds = [type(p).__name__ for p in first.parts]
    assert kinds[0] == "SystemPromptPart" and "You are a test agent." in first.parts[0].content
    assert kinds[-1] == "UserPromptPart"

    # response appended + tool calls extracted
    assert out["toolCalls"] == [
        {"toolName": "run_command", "toolCallId": "tc9", "args": {"command": "ls"}}
    ]
    assert out["text"] == "working"
    reloaded = load_messages(out["messages"])
    assert type(reloaded[-1]).__name__ == "ModelResponse"


def test_call_llm_continues_existing_history(monkeypatch, workspace):
    from pydantic_ai.messages import ModelRequest, TextPart, UserPromptPart

    captured: dict[str, Any] = {}
    fake = make_fake_model(captured, [[TextPart(content="final answer")]])
    monkeypatch.setattr(wfmod, "build_model", lambda: fake)

    history = dump_messages([ModelRequest(parts=[UserPromptPart(content="earlier")])])
    out = call_llm(
        FakeActivityCtx(),
        {"task": None, "messages": history, "context": {}, "iteration": 1},
    )
    # no re-bootstrap: history preserved, response appended
    assert len(captured["messages"]) == 1
    assert out["text"] == "final answer"
    assert out["toolCalls"] == []


def test_execute_tool_runs_real_harness_tools(workspace):
    out = execute_tool(
        FakeActivityCtx(),
        {
            "call": {
                "toolName": "write_file",
                "toolCallId": "tc1",
                "args": {"path": "hello.txt", "content": "hi there"},
            },
            "context": {},
            "iteration": 0,
        },
    )
    message = out["message"]
    loaded = load_messages([message])
    part = loaded[0].parts[0]
    assert type(part).__name__ == "ToolReturnPart"
    assert part.tool_call_id == "tc1"
    assert (workspace / "hello.txt").read_text() == "hi there"

    out2 = execute_tool(
        FakeActivityCtx(),
        {
            "call": {
                "toolName": "run_command",
                "toolCallId": "tc2",
                "args": {"command": "cat hello.txt"},
            },
            "context": {},
            "iteration": 0,
        },
    )
    part2 = load_messages([out2["message"]])[0].parts[0]
    assert "hi there" in str(part2.content)


def test_execute_tool_unknown_tool_returns_error_message(workspace):
    out = execute_tool(
        FakeActivityCtx(),
        {
            "call": {"toolName": "no_such_tool", "toolCallId": "tcX", "args": {}},
            "context": {},
            "iteration": 0,
        },
    )
    part = load_messages([out["message"]])[0].parts[0]
    assert "no_such_tool" in str(part.content)
    assert "failed" in str(part.content).lower()


def test_check_cancellation_activity(monkeypatch):
    monkeypatch.setattr(
        wfmod,
        "read_cancellation_request",
        lambda scope: {"type": "session.terminate", "reason": "stop now"}
        if scope == "cancelled-scope"
        else None,
    )
    hit = check_cancellation(FakeActivityCtx(), {"scopeId": "cancelled-scope"})
    assert hit == {
        "cancelled": True,
        "reason": "stop now",
        "stop_reason": {"type": "terminated", "reason": "stop now"},
    }
    miss = check_cancellation(FakeActivityCtx(), {"scopeId": "other"})
    assert miss == {"cancelled": False}


def test_cancellation_candidate_ids_strip_turn_suffixes():
    assert wfmod._cancellation_candidate_ids("s__turn__3") == ["s__turn__3", "s"]
    assert wfmod._cancellation_candidate_ids("s:turn-2") == ["s:turn-2", "s"]
    assert wfmod._cancellation_candidate_ids("s") == ["s"]
    assert wfmod._cancellation_candidate_ids("") == []

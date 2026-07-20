"""agent_workflow loop: activity boundaries, fan-out, retries, cancellation.

The workflow generator is driven manually with a fake context so the tests
assert the exact durable-activity choreography: one call_llm activity per
LLM message, one execute_tool activity per tool call (when_all fan-out),
a retry policy on every activity, and cancellation short-circuiting.
"""

from __future__ import annotations

from typing import Any

import pytest

import src.workflow as wfmod
from src.workflow import agent_workflow, call_llm, check_cancellation, execute_tool


class FakeCtx:
    def __init__(self):
        self.instance_id = "inst-1"
        self.calls: list[tuple[Any, dict, Any]] = []

    def call_activity(self, activity, *, input=None, retry_policy=None):
        self.calls.append((activity, input, retry_policy))
        return ("activity", activity, input, retry_policy)


@pytest.fixture(autouse=True)
def _fake_when_all(monkeypatch):
    monkeypatch.setattr(wfmod.wf, "when_all", lambda tasks: ("when_all", tasks))


def drive(gen, responses):
    """Send scripted responses into the workflow generator; return
    (yielded_tasks, final_result)."""
    yielded = []
    try:
        task = next(gen)
        for response in responses:
            yielded.append(task)
            task = gen.send(response)
        yielded.append(task)
    except StopIteration as stop:
        return yielded, stop.value
    raise AssertionError("generator did not finish with the scripted responses")


def llm_response(text="", tool_calls=None, messages=None):
    return {
        "messages": messages or [{"kind": "request"}],
        "toolCalls": tool_calls or [],
        "text": text,
    }


def test_single_llm_message_no_tools():
    ctx = FakeCtx()
    gen = agent_workflow(ctx, {"task": "say hi", "context": {"sessionId": "s1"}})
    yielded, result = drive(
        gen,
        [
            {"cancelled": False},              # check_cancellation
            llm_response(text="hello there"),  # call_llm — final (no tool calls)
        ],
    )
    activities = [c[0] for c in ctx.calls]
    assert activities == [check_cancellation, call_llm]
    assert result["success"] is True
    assert result["content"] == "hello there"
    assert result["iterations"] == 1
    # every activity carries the retry policy
    assert all(c[2] is wfmod.RETRY_POLICY for c in ctx.calls)


def test_tool_calls_fan_out_as_separate_activities():
    ctx = FakeCtx()
    gen = agent_workflow(ctx, {"task": "do work", "context": {}})
    calls = [
        {"toolName": "write_file", "toolCallId": "tc1", "args": {"path": "a"}},
        {"toolName": "run_command", "toolCallId": "tc2", "args": {"command": "ls"}},
    ]
    yielded, result = drive(
        gen,
        [
            {"cancelled": False},
            llm_response(tool_calls=calls),                      # iteration 0 LLM
            [{"message": {"kind": "request", "id": "r1"}},        # when_all results
             {"message": {"kind": "request", "id": "r2"}}],
            {"cancelled": False},
            llm_response(text="done", messages=[{"kind": "request"}, {"kind": "response"}]),
        ],
    )
    # exactly one execute_tool activity per tool call
    tool_activity_inputs = [c[1] for c in ctx.calls if c[0] is execute_tool]
    assert [i["call"]["toolCallId"] for i in tool_activity_inputs] == ["tc1", "tc2"]
    # the fan-out went through when_all as a barrier
    when_all_yield = yielded[2]
    assert when_all_yield[0] == "when_all" and len(when_all_yield[1]) == 2
    # tool-return messages were appended into history before the next LLM call
    second_llm_input = [c[1] for c in ctx.calls if c[0] is call_llm][1]
    appended = [m for m in second_llm_input["messages"] if m.get("id") in ("r1", "r2")]
    assert len(appended) == 2
    # the bootstrap task is consumed after iteration 0
    assert second_llm_input["task"] is None
    assert result["success"] is True and result["content"] == "done"


def test_cancellation_short_circuits_before_llm():
    ctx = FakeCtx()
    gen = agent_workflow(ctx, {"task": "x", "context": {"cancellationScopeId": "scope1"}})
    yielded, result = drive(
        gen,
        [{"cancelled": True, "reason": "stop", "stop_reason": {"type": "terminated"}}],
    )
    assert [c[0] for c in ctx.calls] == [check_cancellation]
    assert result["cancelled"] is True
    assert result["success"] is False
    assert result["stop_reason"] == {"type": "terminated"}
    # cancellation scope threaded from context
    assert ctx.calls[0][1] == {"scopeId": "scope1"}


def test_iteration_budget_exhaustion():
    ctx = FakeCtx()
    gen = agent_workflow(ctx, {"task": "loop", "context": {}, "maxIterations": 2})
    call = {"toolName": "run_command", "toolCallId": "t", "args": {}}
    yielded, result = drive(
        gen,
        [
            {"cancelled": False},
            llm_response(tool_calls=[call]),
            [{"message": {"kind": "request"}}],
            {"cancelled": False},
            llm_response(tool_calls=[call]),
            [{"message": {"kind": "request"}}],
        ],
    )
    assert result["success"] is False
    assert "2-iteration budget" in result["content"]
    assert len([c for c in ctx.calls if c[0] is call_llm]) == 2


def test_retry_policy_shape():
    policy = wfmod.RETRY_POLICY
    # dapr.ext.workflow RetryPolicy exposes underscored attrs; assert via repr-safe access
    assert policy is not None
    for attr, expected in (
        ("_max_number_of_attempts", 3),
        ("_backoff_coefficient", 2.0),
    ):
        if hasattr(policy, attr):
            assert getattr(policy, attr) == expected

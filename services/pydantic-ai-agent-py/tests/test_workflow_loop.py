"""agent_workflow loop: activity boundaries, fan-out, retries, cancellation.

The workflow generator is driven manually with a fake context so the tests
assert the exact durable-activity choreography: one call_llm activity per
LLM message, one execute_tool activity per tool call, local-tool when_all
fan-out, MCP barriers, a retry policy on every activity, and cancellation
short-circuiting.
"""

from __future__ import annotations

from typing import Any

import pytest

import src.workflow as wfmod
from src.workflow import agent_workflow, call_llm, check_cancellation, execute_tool
from src.structured_output import MAX_STRUCTURED_OUTPUT_NUDGES, STRUCTURED_OUTPUT_NUDGE


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
            {"cancelled": False},  # check_cancellation
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
            llm_response(tool_calls=calls),  # iteration 0 LLM
            [
                {"message": {"kind": "request", "id": "r1"}},  # when_all results
                {"message": {"kind": "request", "id": "r2"}},
            ],
            {"cancelled": False},
            llm_response(
                text="done", messages=[{"kind": "request"}, {"kind": "response"}]
            ),
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


def test_mcp_calls_are_ordered_barriers_around_local_fan_out():
    ctx = FakeCtx()
    gen = agent_workflow(ctx, {"task": "inspect page", "context": {}})
    calls = [
        {"toolName": "read_file", "toolCallId": "l1", "args": {}},
        {"toolName": "find_files", "toolCallId": "l2", "args": {}},
        {
            "toolName": "browser_open",
            "toolCallId": "m1",
            "args": {},
            "sequential": True,
        },
        {"toolName": "search_files", "toolCallId": "l3", "args": {}},
        {"toolName": "read_file", "toolCallId": "l4", "args": {}},
        {
            "toolName": "browser_screenshot",
            "toolCallId": "m2",
            "args": {},
            "sequential": True,
        },
    ]
    results = {
        call["toolCallId"]: {"message": {"kind": "request", "id": call["toolCallId"]}}
        for call in calls
    }
    yielded, result = drive(
        gen,
        [
            {"cancelled": False},
            llm_response(tool_calls=calls),
            [results["l1"], results["l2"]],
            results["m1"],
            [results["l3"], results["l4"]],
            results["m2"],
            {"cancelled": False},
            llm_response(text="done"),
        ],
    )

    assert yielded[2][0] == "when_all"
    assert len(yielded[2][1]) == 2
    assert yielded[3][0:2] == ("activity", execute_tool)
    assert yielded[4][0] == "when_all"
    assert len(yielded[4][1]) == 2
    assert yielded[5][0:2] == ("activity", execute_tool)

    second_llm = [call[1] for call in ctx.calls if call[0] is call_llm][1]
    assert [message.get("id") for message in second_llm["messages"][1:]] == [
        "l1",
        "l2",
        "m1",
        "l3",
        "l4",
        "m2",
    ]
    assert result["success"] is True and result["content"] == "done"


def test_cancellation_short_circuits_before_llm():
    ctx = FakeCtx()
    gen = agent_workflow(
        ctx, {"task": "x", "context": {"cancellationScopeId": "scope1"}}
    )
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


def test_structured_output_tool_finishes_with_canonical_json():
    ctx = FakeCtx()
    config = {
        "structuredOutputMode": "tool",
        "responseJsonSchema": {
            "type": "object",
            "required": ["summary"],
            "properties": {"summary": {"type": "string"}},
        },
    }
    call = {
        "toolName": "StructuredOutput",
        "toolCallId": "so1",
        "args": {"summary": "done"},
    }
    gen = agent_workflow(
        ctx,
        {"task": "do work", "context": {"agentConfig": config}},
    )
    _, result = drive(
        gen,
        [
            {"cancelled": False},
            llm_response(tool_calls=[call]),
            [
                {
                    "message": {"kind": "request"},
                    "structuredOutputAttempt": True,
                    "structuredOutput": '{"summary": "done"}',
                }
            ],
        ],
    )

    assert result["success"] is True
    assert result["content"] == '{"summary": "done"}'
    assert len([c for c in ctx.calls if c[0] is call_llm]) == 1


def test_plain_text_finish_is_nudged_before_structured_output():
    ctx = FakeCtx()
    config = {
        "structuredOutputMode": "tool",
        "responseJsonSchema": {
            "type": "object",
            "required": ["summary"],
            "properties": {"summary": {"type": "string"}},
        },
    }
    call = {
        "toolName": "StructuredOutput",
        "toolCallId": "so2",
        "args": {"summary": "done"},
    }
    gen = agent_workflow(
        ctx,
        {
            "task": "do work",
            "context": {"agentConfig": config},
            "maxIterations": 2,
        },
    )
    _, result = drive(
        gen,
        [
            {"cancelled": False},
            llm_response(text="I am done"),
            {"cancelled": False},
            llm_response(tool_calls=[call], messages=[{"kind": "response"}]),
            [
                {
                    "message": {"kind": "request"},
                    "structuredOutputAttempt": True,
                    "structuredOutput": '{"summary": "done"}',
                }
            ],
        ],
    )

    second_llm = [c[1] for c in ctx.calls if c[0] is call_llm][1]
    assert second_llm["task"] == STRUCTURED_OUTPUT_NUDGE
    assert result["content"] == '{"summary": "done"}'


def test_mixed_coding_and_structured_calls_defer_finalization():
    ctx = FakeCtx()
    config = {
        "structuredOutputMode": "tool",
        "responseJsonSchema": {
            "type": "object",
            "properties": {"summary": {"type": "string"}},
        },
    }
    mixed_calls = [
        {
            "toolName": "write_file",
            "toolCallId": "write1",
            "args": {"path": "index.html", "content": "ok"},
        },
        {
            "toolName": "StructuredOutput",
            "toolCallId": "so-early",
            "args": {"summary": "too early"},
        },
    ]
    final_call = {
        "toolName": "StructuredOutput",
        "toolCallId": "so-final",
        "args": {"summary": "done"},
    }
    gen = agent_workflow(
        ctx,
        {"task": "build", "context": {"agentConfig": config}},
    )
    _, result = drive(
        gen,
        [
            {"cancelled": False},
            llm_response(tool_calls=mixed_calls),
            [
                {"message": {"kind": "request"}, "toolSucceeded": True},
                {
                    "message": {"kind": "request"},
                    "toolSucceeded": False,
                    "structuredOutputAttempt": True,
                    "toolError": "submit by itself",
                },
            ],
            {"cancelled": False},
            llm_response(tool_calls=[final_call]),
            [
                {
                    "message": {"kind": "request"},
                    "toolSucceeded": True,
                    "structuredOutputAttempt": True,
                    "structuredOutput": '{"summary": "done"}',
                }
            ],
        ],
    )

    dispatched = [c[1]["call"] for c in ctx.calls if c[0] is execute_tool]
    assert "deferStructuredOutput" not in dispatched[0]
    assert dispatched[1]["deferStructuredOutput"] is True
    assert result["success"] is True
    assert result["content"] == '{"summary": "done"}'


def test_invalid_structured_calls_exhaust_the_local_budget_terminally():
    ctx = FakeCtx()
    config = {
        "structuredOutputMode": "tool",
        "responseJsonSchema": {"type": "object"},
    }
    responses = []
    for index in range(MAX_STRUCTURED_OUTPUT_NUDGES + 1):
        responses.extend(
            [
                {"cancelled": False},
                llm_response(
                    tool_calls=[
                        {
                            "toolName": "StructuredOutput",
                            "toolCallId": f"bad-{index}",
                            "args": {},
                        }
                    ]
                ),
                [
                    {
                        "message": {"kind": "request"},
                        "toolSucceeded": False,
                        "structuredOutputAttempt": True,
                        "toolError": "schema mismatch",
                    }
                ],
            ]
        )
    gen = agent_workflow(
        ctx,
        {
            "task": "finish",
            "context": {"agentConfig": config},
            "maxIterations": MAX_STRUCTURED_OUTPUT_NUDGES + 2,
        },
    )

    _, result = drive(gen, responses)

    assert result["success"] is False
    assert result["errorCode"] == "error_max_structured_output_retries"
    assert result["structuredOutputFailure"] == {
        "code": "error_max_structured_output_retries",
        "attemptsUsed": MAX_STRUCTURED_OUTPUT_NUDGES + 1,
        "feedback": "schema mismatch",
    }


def test_invalid_structured_schema_returns_a_typed_configuration_failure():
    ctx = FakeCtx()
    gen = agent_workflow(
        ctx,
        {
            "task": "finish",
            "context": {
                "agentConfig": {
                    "structuredOutputMode": "tool",
                    "responseJsonSchema": {"type": "array"},
                }
            },
        },
    )

    yielded, result = drive(gen, [])

    assert yielded == []
    assert ctx.calls == []
    assert result["success"] is False
    assert result["errorCode"] == "structured_output_config_error"
    assert "object-shaped" in result["content"]


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

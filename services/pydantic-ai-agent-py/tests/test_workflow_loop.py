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
from src.adapters.dapr_durable_payload_codec import DaprDurablePayloadCodecAdapter
from src.workflow import (
    agent_workflow,
    call_llm,
    check_cancellation,
    commit_tool_results,
    execute_tool,
)
from src.structured_output import MAX_STRUCTURED_OUTPUT_NUDGES, STRUCTURED_OUTPUT_NUDGE


class FakeCtx:
    def __init__(self, *, is_replaying=False):
        self.instance_id = "inst-1"
        self.is_replaying = is_replaying
        self.calls: list[tuple[Any, dict, Any]] = []
        self.continuations: list[tuple[dict, bool]] = []

    def call_activity(self, activity, *, input=None, retry_policy=None):
        self.calls.append((activity, input, retry_policy))
        return ("activity", activity, input, retry_policy)

    def continue_as_new(self, new_input, *, save_events=False):
        self.continuations.append((new_input, save_events))


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
    projected_calls = [
        {
            **call,
            "isStructuredOutput": call.get("toolName") == "StructuredOutput",
        }
        for call in (tool_calls or [])
    ]
    return {
        "messages": messages or [{"kind": "request"}],
        "toolCalls": projected_calls,
        "text": text,
    }


def reference_tool_responses(start: int, count: int, call: dict | None = None):
    responses = []
    base_call = call or {
        "toolName": "run_command",
        "toolCallId": "tool",
        "args": {},
    }
    for iteration in range(start, start + count):
        projected_call = {
            **base_call,
            "toolCallId": f"{base_call['toolCallId']}-{iteration}",
            "isStructuredOutput": base_call.get("toolName") == "StructuredOutput",
        }
        responses.extend(
            [
                {"cancelled": False},
                {
                    "historyRef": f"history-assistant-{iteration}",
                    "toolCalls": [projected_call],
                    "text": "",
                },
                [{"messageRef": f"message-tool-{iteration}"}],
                {"historyRef": f"history-committed-{iteration}"},
            ]
        )
    return responses


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


def test_iteration_override_cannot_exceed_hard_per_turn_cap():
    first_ctx = FakeCtx()
    _, first_result = drive(
        agent_workflow(
            first_ctx,
            {"task": "loop", "context": {}, "maxIterations": 999},
        ),
        reference_tool_responses(0, wfmod.DURABLE_HISTORY_ITERATIONS_PER_SEGMENT),
    )
    assert first_result is None
    assert first_ctx.calls[-1][0] is commit_tool_results
    assert len(first_ctx.continuations) == 1
    continuation, save_events = first_ctx.continuations[0]
    assert save_events is False
    assert continuation == {
        "context": {"workflowInstanceId": "inst-1"},
        "historyRef": "history-committed-39",
        "maxIterations": 120,
        "agentWorkflowState": {
            "iteration": 40,
            "structuredFailures": 0,
        },
    }
    assert "history" not in continuation

    replay_ctx = FakeCtx(is_replaying=True)
    _, replay_result = drive(
        agent_workflow(
            replay_ctx,
            {"task": "loop", "context": {}, "maxIterations": 999},
        ),
        reference_tool_responses(0, wfmod.DURABLE_HISTORY_ITERATIONS_PER_SEGMENT),
    )
    assert replay_result is None
    assert replay_ctx.calls == first_ctx.calls
    assert replay_ctx.continuations == first_ctx.continuations

    second_ctx = FakeCtx()
    _, second_result = drive(
        agent_workflow(second_ctx, continuation),
        reference_tool_responses(
            wfmod.DURABLE_HISTORY_ITERATIONS_PER_SEGMENT,
            wfmod.DURABLE_HISTORY_ITERATIONS_PER_SEGMENT,
        ),
    )
    assert second_result is None
    assert second_ctx.calls[-1][0] is commit_tool_results
    assert len(second_ctx.continuations) == 1
    second_continuation, second_save_events = second_ctx.continuations[0]
    assert second_save_events is False
    assert second_continuation == {
        "context": {"workflowInstanceId": "inst-1"},
        "historyRef": "history-committed-79",
        "maxIterations": 120,
        "agentWorkflowState": {
            "iteration": 80,
            "structuredFailures": 0,
        },
    }

    second_replay_ctx = FakeCtx(is_replaying=True)
    _, second_replay_result = drive(
        agent_workflow(second_replay_ctx, continuation),
        reference_tool_responses(
            wfmod.DURABLE_HISTORY_ITERATIONS_PER_SEGMENT,
            wfmod.DURABLE_HISTORY_ITERATIONS_PER_SEGMENT,
        ),
    )
    assert second_replay_result is None
    assert second_replay_ctx.calls == second_ctx.calls
    assert second_replay_ctx.continuations == second_ctx.continuations

    third_ctx = FakeCtx()
    _, result = drive(
        agent_workflow(third_ctx, second_continuation),
        reference_tool_responses(
            2 * wfmod.DURABLE_HISTORY_ITERATIONS_PER_SEGMENT,
            wfmod.DURABLE_HISTORY_ITERATIONS_PER_SEGMENT,
        ),
    )

    assert result["success"] is False
    assert "120-iteration budget" in result["content"]
    assert (
        len(
            [
                entry
                for entry in [*first_ctx.calls, *second_ctx.calls, *third_ctx.calls]
                if entry[0] is call_llm
            ]
        )
        == 120
    )


def test_structured_output_state_survives_history_rollover():
    schema = {
        "type": "object",
        "required": ["summary"],
        "properties": {"summary": {"type": "string"}},
    }
    context = {
        "agentConfig": {
            "structuredOutputMode": "tool",
            "responseJsonSchema": schema,
        }
    }
    first_ctx = FakeCtx()
    responses = reference_tool_responses(0, 38)
    for iteration in (38, 39):
        responses.extend(
            [
                {"cancelled": False},
                {
                    "historyRef": f"history-assistant-{iteration}",
                    "toolCalls": [],
                    "text": "",
                },
            ]
        )

    _, first_result = drive(
        agent_workflow(
            first_ctx,
            {
                "task": "produce structured output",
                "context": context,
                "maxIterations": 80,
            },
        ),
        responses,
    )
    assert first_result is None
    continuation, _save_events = first_ctx.continuations[0]
    assert continuation["historyRef"] == "history-assistant-39"
    assert continuation["task"] == STRUCTURED_OUTPUT_NUDGE
    assert continuation["agentWorkflowState"] == {
        "iteration": 40,
        "structuredFailures": 2,
    }

    resumed_ctx = FakeCtx()
    output_call = {
        "toolName": "StructuredOutput",
        "toolCallId": "structured",
        "args": {"summary": "done"},
    }
    resumed_responses = reference_tool_responses(40, 1, output_call)
    resumed_responses[2] = [
        {
            "messageRef": "message-structured-40",
            "structuredOutputAttempt": True,
            "structuredOutput": '{"summary":"done"}',
        }
    ]
    _, result = drive(
        agent_workflow(resumed_ctx, continuation),
        resumed_responses,
    )

    resumed_llm_input = next(
        entry[1] for entry in resumed_ctx.calls if entry[0] is call_llm
    )
    assert resumed_llm_input["iteration"] == 40
    assert resumed_llm_input["task"] == STRUCTURED_OUTPUT_NUDGE
    assert result["success"] is True
    assert result["content"] == '{"summary":"done"}'
    assert result["iterations"] == 41


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


def test_model_context_rejection_returns_a_non_structured_terminal_failure():
    ctx = FakeCtx()
    gen = agent_workflow(ctx, {"task": "inspect", "context": {}})

    _, result = drive(
        gen,
        [
            {"cancelled": False},
            {
                "messages": [{"kind": "request"}],
                "toolCalls": [],
                "text": "",
                "configurationError": "Kimi K3 context window exceeded.",
                "configurationErrorCode": "model_context_window_error",
            },
        ],
    )

    assert result["success"] is False
    assert result["errorCode"] == "model_context_window_error"
    assert "structuredOutputFailure" not in result


def test_unrepresentable_tool_result_returns_a_typed_terminal_failure():
    ctx = FakeCtx()
    gen = agent_workflow(ctx, {"task": "inspect", "context": {}})
    call = {"toolName": "inspect_dom", "toolCallId": "tc-large", "args": {}}

    _, result = drive(
        gen,
        [
            {"cancelled": False},
            llm_response(tool_calls=[call]),
            [
                {
                    "message": None,
                    "toolSucceeded": False,
                    "configurationError": "Tool correlation envelope is too large.",
                    "configurationErrorCode": (wfmod.TOOL_RESULT_DURABLE_PAYLOAD_ERROR),
                }
            ],
        ],
    )

    assert result["success"] is False
    assert result["errorCode"] == wfmod.TOOL_RESULT_DURABLE_PAYLOAD_ERROR
    assert "structuredOutputFailure" not in result
    assert len([entry for entry in ctx.calls if entry[0] is call_llm]) == 1


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


def test_exhausted_llm_retry_returns_bounded_terminal_with_balanced_history(
    monkeypatch,
):
    class FakeTaskFailedError(Exception):
        pass

    monkeypatch.setattr(wfmod.wf, "TaskFailedError", FakeTaskFailedError)
    old_ref = "history+sha256://" + "1" * 64
    ctx = FakeCtx()
    workflow = agent_workflow(
        ctx,
        {"task": "continue", "historyRef": old_ref, "context": {}},
    )

    assert next(workflow)[1] is check_cancellation
    scheduled = workflow.send({"cancelled": False})
    assert scheduled[1] is call_llm
    with pytest.raises(StopIteration) as stopped:
        workflow.throw(FakeTaskFailedError("provider body must not escape"))

    result = stopped.value.value
    assert result["errorCode"] == wfmod.ACTIVITY_RETRY_EXHAUSTED_ERROR
    assert result["historyRef"] == old_ref
    assert "provider body" not in result["error"]


def test_tool_and_commit_failures_roll_back_then_resume_from_balanced_ref(
    monkeypatch,
):
    class FakeTaskFailedError(Exception):
        pass

    monkeypatch.setattr(wfmod.wf, "TaskFailedError", FakeTaskFailedError)
    old_ref = "history+sha256://" + "2" * 64
    assistant_ref = "history+sha256://" + "3" * 64
    response_ref = "message+sha256://" + "4" * 64
    message_ref = "message+sha256://" + "5" * 64
    llm_out = {
        "historyRef": assistant_ref,
        "responseRef": response_ref,
        "toolCalls": [
            {
                "responseRef": response_ref,
                "toolIndex": 0,
                "sequential": False,
                "isStructuredOutput": False,
            }
        ],
        "text": "",
    }

    tool_ctx = FakeCtx()
    tool_workflow = agent_workflow(
        tool_ctx,
        {"task": "continue", "historyRef": old_ref, "context": {}},
    )
    next(tool_workflow)
    scheduled = tool_workflow.send({"cancelled": False})
    scheduled = tool_workflow.send(llm_out)
    assert scheduled[0] == "when_all"
    with pytest.raises(StopIteration) as tool_stopped:
        tool_workflow.throw(FakeTaskFailedError("tool failed"))
    assert tool_stopped.value.value["historyRef"] == old_ref
    assert "historyRefInvalid" not in tool_stopped.value.value

    commit_ctx = FakeCtx()
    commit_workflow = agent_workflow(
        commit_ctx,
        {"task": "continue", "historyRef": old_ref, "context": {}},
    )
    next(commit_workflow)
    scheduled = commit_workflow.send({"cancelled": False})
    scheduled = commit_workflow.send(llm_out)
    scheduled = commit_workflow.send([{"messageRef": message_ref}])
    assert scheduled[1] is wfmod.commit_tool_results
    with pytest.raises(StopIteration) as commit_stopped:
        commit_workflow.throw(FakeTaskFailedError("commit failed"))
    terminal = commit_stopped.value.value
    assert terminal["historyRef"] == old_ref
    assert "historyRefInvalid" not in terminal

    resumed_ctx = FakeCtx()
    resumed = agent_workflow(
        resumed_ctx,
        {"task": "resume", "historyRef": terminal["historyRef"], "context": {}},
    )
    next(resumed)
    scheduled = resumed.send({"cancelled": False})
    assert scheduled[1] is call_llm
    assert scheduled[2]["historyRef"] == old_ref


def test_later_irreducible_tool_input_schedules_no_tool_activities(monkeypatch):
    codec = DaprDurablePayloadCodecAdapter()
    monkeypatch.setattr(wfmod, "DURABLE_ACTIVITY_MAX_BYTES", 1_200)
    ctx = FakeCtx()
    gen = agent_workflow(ctx, {"task": "inspect", "context": {}})
    calls = [
        {"toolName": "read_file", "toolCallId": "fits", "args": {}},
        {
            "toolName": "read_file",
            "toolCallId": "too-large-" + "x" * 3_000,
            "args": {},
        },
    ]

    _, result = drive(
        gen,
        [
            {"cancelled": False},
            llm_response(tool_calls=calls),
        ],
    )

    assert [entry for entry in ctx.calls if entry[0] is execute_tool] == []
    assert result["errorCode"] == wfmod.DURABLE_WORKFLOW_PAYLOAD_ERROR
    assert result["messages"] == []
    assert codec.size_bytes(result) <= 1_200


def test_workflow_splits_parallel_fanout_by_aggregate_input_size(monkeypatch):
    codec = DaprDurablePayloadCodecAdapter()
    context = {"pad": "x" * 250, "workflowInstanceId": "inst-1"}
    response_ref = "message+sha256://" + "a" * 64
    projected_calls = [
        {
            "responseRef": response_ref,
            "toolIndex": index,
            "sequential": False,
            "isStructuredOutput": False,
        }
        for index in range(3)
    ]
    payloads = [
        {
            "call": call,
            "context": wfmod._tool_activity_context(context, call),
            "iteration": 0,
        }
        for call in projected_calls
    ]
    aggregate_limit = codec.size_bytes(payloads[:2])
    assert codec.size_bytes(payloads) > aggregate_limit
    monkeypatch.setattr(wfmod, "DURABLE_ACTIVITY_MAX_BYTES", aggregate_limit)
    ctx = FakeCtx()
    gen = agent_workflow(
        ctx,
        {"task": "inspect", "context": {"pad": "x" * 250}},
    )

    yielded, result = drive(
        gen,
        [
            {"cancelled": False},
            llm_response(tool_calls=projected_calls),
            [
                {"message": {"kind": "request", "id": "tc-0"}},
                {"message": {"kind": "request", "id": "tc-1"}},
            ],
            [{"message": {"kind": "request", "id": "tc-2"}}],
            {"cancelled": False},
            llm_response(text="done"),
        ],
    )

    fanout_yields = [item for item in yielded if item[0] == "when_all"]
    assert [len(item[1]) for item in fanout_yields] == [2, 1]
    assert all(
        codec.size_bytes([task[2] for task in item[1]]) <= aggregate_limit
        for item in fanout_yields
    )
    assert [
        entry[1]["call"]["toolIndex"] for entry in ctx.calls if entry[0] is execute_tool
    ] == [0, 1, 2]
    assert result["success"] is True


def test_workflow_boundary_decisions_are_deterministic():
    calls = [
        {"toolName": "read_file", "toolCallId": "tc-1", "args": {"path": "a"}},
        {"toolName": "read_file", "toolCallId": "tc-2", "args": {"path": "b"}},
    ]
    responses = [
        {"cancelled": False},
        llm_response(tool_calls=calls),
        [
            {"message": {"kind": "request", "id": "tc-1"}},
            {"message": {"kind": "request", "id": "tc-2"}},
        ],
        {"cancelled": False},
        llm_response(text="done"),
    ]

    def run_once():
        ctx = FakeCtx()
        _, result = drive(
            agent_workflow(ctx, {"task": "inspect", "context": {"sessionId": "s"}}),
            responses,
        )
        return [entry[1] for entry in ctx.calls], result

    assert run_once() == run_once()


def test_oversized_cancellation_result_returns_bounded_cancelled_terminal(
    monkeypatch,
):
    codec = DaprDurablePayloadCodecAdapter()
    monkeypatch.setattr(wfmod, "DURABLE_ACTIVITY_MAX_BYTES", 900)
    ctx = FakeCtx()
    gen = agent_workflow(
        ctx,
        {
            "task": "stop",
            "history": [{"kind": "request", "payload": "x" * 5_000}],
            "context": {},
        },
    )

    _, result = drive(
        gen,
        [
            {
                "cancelled": True,
                "reason": "stop" * 2_000,
                "stop_reason": {"type": "terminated", "reason": "stop" * 2_000},
            }
        ],
    )

    assert codec.size_bytes(result) <= 900
    assert result["errorCode"] == wfmod.DURABLE_WORKFLOW_PAYLOAD_ERROR
    assert result["messages"] == []
    assert result["cancelled"] is True
    assert result["stop_reason"] == {"type": "terminated"}


def test_oversized_final_output_returns_bounded_typed_terminal(monkeypatch):
    codec = DaprDurablePayloadCodecAdapter()
    monkeypatch.setattr(wfmod, "DURABLE_ACTIVITY_MAX_BYTES", 900)
    ctx = FakeCtx()

    _, result = drive(
        agent_workflow(ctx, {"task": "answer", "context": {}}),
        [
            {"cancelled": False},
            llm_response(text="x" * 5_000),
        ],
    )

    assert codec.size_bytes(result) <= 900
    assert result["errorCode"] == wfmod.DURABLE_WORKFLOW_PAYLOAD_ERROR
    assert result["messages"] == []


def test_oversized_max_iteration_output_returns_bounded_typed_terminal(monkeypatch):
    codec = DaprDurablePayloadCodecAdapter()
    monkeypatch.setattr(wfmod, "DURABLE_ACTIVITY_MAX_BYTES", 900)
    ctx = FakeCtx()
    call = {"toolName": "read_file", "toolCallId": "tc-max", "args": {}}

    _, result = drive(
        agent_workflow(
            ctx,
            {"task": "loop", "context": {}, "maxIterations": 1},
        ),
        [
            {"cancelled": False},
            llm_response(tool_calls=[call]),
            [
                {
                    "message": {
                        "kind": "request",
                        "id": "tc-max",
                        "payload": "x" * 5_000,
                    }
                }
            ],
        ],
    )

    assert codec.size_bytes(result) <= 900
    assert result["errorCode"] == wfmod.DURABLE_WORKFLOW_PAYLOAD_ERROR
    assert result["messages"] == []

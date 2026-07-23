"""Exact Dapr protobuf budget proof for reference-backed K3 turns."""

from __future__ import annotations

import hashlib
from dataclasses import dataclass, field
from typing import Any

from dapr.ext.workflow._durabletask.internal import protos as pb
from dapr.ext.workflow._durabletask.internal.shared import to_json
from google.protobuf import timestamp_pb2, wrappers_pb2

from src.config import (
    DURABLE_CONTEXT_MAX_BYTES,
    DURABLE_HISTORY_ITERATIONS_PER_SEGMENT,
    DURABLE_TASK_MAX_BYTES,
    DURABLE_TOOL_CONTEXT_MAX_BYTES,
    MAX_ITERATIONS_PER_TURN,
    MAX_TOOL_CALLS_PER_RESPONSE,
    TERMINAL_CONTENT_MAX_BYTES,
    WORKFLOW_IDENTIFIER_MAX_BYTES,
)
from src.structured_output import MAX_STRUCTURED_OUTPUT_NUDGES

_GRPC_MESSAGE_LIMIT_BYTES = 16 * 1024 * 1024
_REQUIRED_RESERVE_BYTES = 2 * 1024 * 1024
_FAILURE_MESSAGE_BYTES = 256
_FAILURE_STACK_BYTES = 640
_MAX_SCOPE = "s" * WORKFLOW_IDENTIFIER_MAX_BYTES


def _json(value: Any) -> str:
    return to_json(value)


def _json_size(value: Any) -> int:
    return len(_json(value).encode())


def _ref(scheme: str, *identity: object) -> str:
    digest = hashlib.sha256(":".join(map(str, identity)).encode()).hexdigest()
    return f"{scheme}+sha256://{digest}"


def _private_context(target_bytes: int, *, label: str) -> dict[str, Any]:
    context = {
        "agentConfig": {
            "model": "kimi-k3",
            "reasoningEffort": "max",
            "systemPrompt": "private runtime instructions",
        },
        "privateConfigurationPadding": "",
        "sessionId": "session-reference-budget",
        "workflowMcpSessionToken": "<private-inline-only>",
        "workload": label,
    }
    padding_size = target_bytes - _json_size(context)
    assert padding_size >= 0
    context["privateConfigurationPadding"] = "p" * padding_size
    assert _json_size(context) == target_bytes
    return context


def _max_size_task() -> str:
    marker = "FIRST-TURN-TASK:"
    task = marker + ("t" * (DURABLE_TASK_MAX_BYTES - len(marker) - 2))
    assert _json_size(task) == DURABLE_TASK_MAX_BYTES
    return task


def _max_terminal_content() -> str:
    marker = '{"result":"'
    suffix = '"}'
    content = marker + ("z" * (TERMINAL_CONTENT_MAX_BYTES - len(marker) - len(suffix)))
    content += suffix
    assert len(content.encode()) == TERMINAL_CONTENT_MAX_BYTES
    return content


@dataclass
class _WorkflowHistory:
    events: list[pb.HistoryEvent] = field(default_factory=list)
    next_event_id: int = 1
    logical_payload_sizes: list[int] = field(default_factory=list)

    def _timestamp(self) -> timestamp_pb2.Timestamp:
        return timestamp_pb2.Timestamp(
            seconds=1_753_184_400 + self.next_event_id,
            nanos=123_456_000,
        )

    def _append(self, **event: Any) -> int:
        event_id = self.next_event_id
        self.next_event_id += 1
        self.events.append(
            pb.HistoryEvent(
                eventId=event_id,
                timestamp=self._timestamp(),
                **event,
            )
        )
        return event_id

    def _schedule(
        self, name: str, payload: dict[str, Any], task_execution_id: str
    ) -> int:
        self.logical_payload_sizes.append(_json_size(payload))
        return self._append(
            taskScheduled=pb.TaskScheduledEvent(
                name=name,
                input=wrappers_pb2.StringValue(value=_json(payload)),
                taskExecutionId=task_execution_id,
            )
        )

    def _fail(self, scheduled_id: int, task_execution_id: str) -> None:
        self._append(
            taskFailed=pb.TaskFailedEvent(
                taskScheduledId=scheduled_id,
                failureDetails=pb.TaskFailureDetails(
                    errorType="RuntimeError",
                    errorMessage="e" * _FAILURE_MESSAGE_BYTES,
                    stackTrace=wrappers_pb2.StringValue(
                        value="s" * _FAILURE_STACK_BYTES
                    ),
                    isNonRetriable=False,
                ),
                taskExecutionId=task_execution_id,
            )
        )
        timer_id = self.next_event_id
        fire_at = self._timestamp()
        self._append(
            timerCreated=pb.TimerCreatedEvent(
                fireAt=fire_at,
                name="activityRetry",
                activityRetry=pb.TimerOriginActivityRetry(
                    taskExecutionId=task_execution_id
                ),
            )
        )
        self._append(timerFired=pb.TimerFiredEvent(fireAt=fire_at, timerId=timer_id))

    def _complete(
        self,
        scheduled_id: int,
        payload: dict[str, Any],
        task_execution_id: str,
    ) -> None:
        self.logical_payload_sizes.append(_json_size(payload))
        self._append(
            taskCompleted=pb.TaskCompletedEvent(
                taskScheduledId=scheduled_id,
                result=wrappers_pb2.StringValue(value=_json(payload)),
                taskExecutionId=task_execution_id,
            )
        )

    def retry_activity(
        self, name: str, payload: dict[str, Any], result: dict[str, Any]
    ) -> None:
        task_execution_id = self._task_execution_id(self.next_event_id)
        for _attempt in (1, 2):
            scheduled_id = self._schedule(name, payload, task_execution_id)
            self._fail(scheduled_id, task_execution_id)
        scheduled_id = self._schedule(name, payload, task_execution_id)
        self._complete(scheduled_id, result, task_execution_id)

    @staticmethod
    def _task_execution_id(event_id: int) -> str:
        value = f"00000000-0000-0000-0000-{event_id:012d}"
        assert len(value.encode()) == 36
        return value

    def request_bytes(self) -> bytes:
        return pb.WorkflowRequest(
            instanceId="k3-reference-budget-regression",
            executionId=wrappers_pb2.StringValue(value="execution-20260722"),
            pastEvents=self.events,
        ).SerializeToString(deterministic=True)


def _execution_started(input_payload: dict[str, Any]) -> pb.HistoryEvent:
    return pb.HistoryEvent(
        eventId=0,
        timestamp=timestamp_pb2.Timestamp(
            seconds=1_753_184_400,
            nanos=123_456_000,
        ),
        executionStarted=pb.ExecutionStartedEvent(
            name="agent_workflow",
            input=wrappers_pb2.StringValue(value=_json(input_payload)),
            workflowInstance=pb.WorkflowInstance(
                instanceId="k3-reference-budget-regression",
                executionId=wrappers_pb2.StringValue(value="execution-20260722"),
            ),
        ),
    )


def _new_history(llm_context: dict[str, Any], task: str) -> _WorkflowHistory:
    return _WorkflowHistory(
        events=[
            _execution_started(
                {
                    "context": llm_context,
                    "historyRef": _ref("history", "initial"),
                    "maxIterations": MAX_ITERATIONS_PER_TURN,
                    "task": task,
                }
            )
        ]
    )


def _tool_locator(response_ref: str, index: int, *, structured: bool) -> dict[str, Any]:
    return {
        "responseRef": response_ref,
        "toolIndex": index,
        "sequential": False,
        "isStructuredOutput": structured,
    }


def _run_iteration(
    history: _WorkflowHistory,
    *,
    iteration: int,
    current_history_ref: str,
    llm_context: dict[str, Any],
    ordinary_context: dict[str, Any],
    structured_context: dict[str, Any] | None,
    task: str | None,
    tool_count: int,
    structured_indexes: frozenset[int] = frozenset(),
    structured_final: str | None = None,
) -> str:
    history.retry_activity(
        "check_cancellation",
        {"scopeId": _MAX_SCOPE},
        {"cancelled": False},
    )
    response_ref = _ref("message", "assistant", iteration)
    assistant_history_ref = _ref("history", "assistant", iteration)
    calls = [
        _tool_locator(
            response_ref,
            index,
            structured=index in structured_indexes,
        )
        for index in range(tool_count)
    ]
    history.retry_activity(
        "call_llm",
        {
            "task": task,
            "historyRef": current_history_ref,
            "context": llm_context,
            "iteration": iteration,
        },
        {
            "historyRef": assistant_history_ref,
            "responseRef": response_ref,
            "toolCalls": calls,
            "text": "",
        },
    )

    message_refs: list[str] = []
    for index, call in enumerate(calls):
        structured = index in structured_indexes
        message_ref = _ref("message", "tool-result", iteration, index)
        if not structured:
            result = {
                "messageRef": message_ref,
                "toolSucceeded": False,
                "toolErrorCode": "tool_result_durable_payload_too_large",
                "structuredOutputAttempt": False,
                "structuredOutput": None,
            }
        elif structured_final is None:
            result = {
                "messageRef": message_ref,
                "toolSucceeded": False,
                "structuredOutputAttempt": True,
                "structuredOutput": None,
                "structuredOutputError": "e" * (2 * 1024),
            }
        else:
            result = {
                "messageRef": message_ref,
                "toolSucceeded": True,
                "structuredOutputAttempt": True,
                "structuredOutput": structured_final,
            }
        execute_call = (
            {**call, "deferStructuredOutput": True}
            if structured and tool_count > 1
            else call
        )
        history.retry_activity(
            "execute_tool",
            {
                "call": execute_call,
                "context": (
                    structured_context
                    if structured and structured_context is not None
                    else ordinary_context
                ),
                "iteration": iteration,
            },
            result,
        )
        message_refs.append(message_ref)

    committed_ref = _ref("history", "turn", iteration)
    history.retry_activity(
        "commit_tool_results",
        {"historyRef": assistant_history_ref, "messageRefs": message_refs},
        {"historyRef": committed_ref},
    )
    return committed_ref


def _retry_storm_history() -> _WorkflowHistory:
    llm_context = _private_context(DURABLE_CONTEXT_MAX_BYTES, label="call_llm")
    tool_context = _private_context(
        DURABLE_TOOL_CONTEXT_MAX_BYTES, label="ordinary-tool"
    )
    task = _max_size_task()
    history = _new_history(llm_context, task)
    current_ref = _ref("history", "initial")
    for iteration in range(DURABLE_HISTORY_ITERATIONS_PER_SEGMENT):
        current_ref = _run_iteration(
            history,
            iteration=iteration,
            current_history_ref=current_ref,
            llm_context=llm_context,
            ordinary_context=tool_context,
            structured_context=None,
            task=task if iteration == 0 else None,
            tool_count=MAX_TOOL_CALLS_PER_RESPONSE,
        )
    return history


def _structured_terminal_history() -> _WorkflowHistory:
    llm_context = _private_context(DURABLE_CONTEXT_MAX_BYTES, label="call_llm")
    ordinary_context = _private_context(
        DURABLE_TOOL_CONTEXT_MAX_BYTES, label="ordinary-tool"
    )
    structured_context = _private_context(
        DURABLE_CONTEXT_MAX_BYTES, label="StructuredOutput"
    )
    task = _max_size_task()
    history = _new_history(llm_context, task)
    current_ref = _ref("history", "initial")
    ordinary_iterations = (
        DURABLE_HISTORY_ITERATIONS_PER_SEGMENT - MAX_STRUCTURED_OUTPUT_NUDGES - 1
    )
    for iteration in range(ordinary_iterations):
        current_ref = _run_iteration(
            history,
            iteration=iteration,
            current_history_ref=current_ref,
            llm_context=llm_context,
            ordinary_context=ordinary_context,
            structured_context=None,
            task=task if iteration == 0 else None,
            tool_count=MAX_TOOL_CALLS_PER_RESPONSE,
        )
    for iteration in range(
        ordinary_iterations, DURABLE_HISTORY_ITERATIONS_PER_SEGMENT - 1
    ):
        current_ref = _run_iteration(
            history,
            iteration=iteration,
            current_history_ref=current_ref,
            llm_context=llm_context,
            ordinary_context=ordinary_context,
            structured_context=structured_context,
            task=None,
            tool_count=MAX_TOOL_CALLS_PER_RESPONSE,
            structured_indexes=frozenset({MAX_TOOL_CALLS_PER_RESPONSE - 1}),
        )
    _run_iteration(
        history,
        iteration=DURABLE_HISTORY_ITERATIONS_PER_SEGMENT - 1,
        current_history_ref=current_ref,
        llm_context=llm_context,
        ordinary_context=ordinary_context,
        structured_context=structured_context,
        task=None,
        tool_count=1,
        structured_indexes=frozenset({0}),
        structured_final=_max_terminal_content(),
    )
    return history


def _no_tool_terminal_history() -> _WorkflowHistory:
    llm_context = _private_context(DURABLE_CONTEXT_MAX_BYTES, label="call_llm")
    ordinary_context = _private_context(
        DURABLE_TOOL_CONTEXT_MAX_BYTES, label="ordinary-tool"
    )
    task = _max_size_task()
    history = _new_history(llm_context, task)
    current_ref = _ref("history", "initial")
    for iteration in range(DURABLE_HISTORY_ITERATIONS_PER_SEGMENT - 1):
        current_ref = _run_iteration(
            history,
            iteration=iteration,
            current_history_ref=current_ref,
            llm_context=llm_context,
            ordinary_context=ordinary_context,
            structured_context=None,
            task=task if iteration == 0 else None,
            tool_count=MAX_TOOL_CALLS_PER_RESPONSE,
        )
    history.retry_activity(
        "check_cancellation",
        {"scopeId": _MAX_SCOPE},
        {"cancelled": False},
    )
    history.retry_activity(
        "call_llm",
        {
            "task": None,
            "historyRef": current_ref,
            "context": llm_context,
            "iteration": DURABLE_HISTORY_ITERATIONS_PER_SEGMENT - 1,
        },
        {
            "historyRef": _ref("history", "final-text"),
            "responseRef": _ref("message", "final-text"),
            "toolCalls": [],
            "text": _max_terminal_content(),
        },
    )
    return history


def test_each_reference_history_segment_keeps_two_mib_grpc_reserve():
    retry_storm = _retry_storm_history()
    no_tool_terminal = _no_tool_terminal_history()
    structured_terminal = _structured_terminal_history()

    retry_request = retry_storm.request_bytes()
    no_tool_request = no_tool_terminal.request_bytes()
    structured_request = structured_terminal.request_bytes()
    retry_reserve = _GRPC_MESSAGE_LIMIT_BYTES - len(retry_request)
    no_tool_reserve = _GRPC_MESSAGE_LIMIT_BYTES - len(no_tool_request)
    structured_reserve = _GRPC_MESSAGE_LIMIT_BYTES - len(structured_request)
    print(
        f"retry_bytes={len(retry_request)} retry_reserve={retry_reserve} "
        f"retry_events={len(retry_storm.events)} "
        f"no_tool_bytes={len(no_tool_request)} "
        f"no_tool_reserve={no_tool_reserve} "
        f"no_tool_events={len(no_tool_terminal.events)} "
        f"structured_bytes={len(structured_request)} "
        f"structured_reserve={structured_reserve} "
        f"structured_events={len(structured_terminal.events)} "
        "max_payload="
        f"{max(retry_storm.logical_payload_sizes + no_tool_terminal.logical_payload_sizes + structured_terminal.logical_payload_sizes)}"
    )

    assert MAX_ITERATIONS_PER_TURN == 120
    assert DURABLE_HISTORY_ITERATIONS_PER_SEGMENT == 40
    assert len(retry_storm.events) == 1 + (
        DURABLE_HISTORY_ITERATIONS_PER_SEGMENT * 11 * 10
    )
    assert len(no_tool_terminal.events) == 1 + (
        (DURABLE_HISTORY_ITERATIONS_PER_SEGMENT - 1) * 11 * 10
    ) + (2 * 10)
    assert len(structured_terminal.events) == 1 + (
        (DURABLE_HISTORY_ITERATIONS_PER_SEGMENT - 1) * 11 * 10
    ) + (4 * 10)
    assert retry_request.count(b"FIRST-TURN-TASK:") == 4
    assert b"history+sha256://" in retry_request
    assert b"message+sha256://" in retry_request
    assert b"toolName" not in retry_request
    assert b"toolCallId" not in retry_request
    assert b'"toolError":' not in retry_request
    assert retry_reserve >= _REQUIRED_RESERVE_BYTES
    assert no_tool_reserve >= _REQUIRED_RESERVE_BYTES
    assert structured_reserve >= _REQUIRED_RESERVE_BYTES
    assert len(structured_request) == max(
        len(retry_request), len(no_tool_request), len(structured_request)
    )

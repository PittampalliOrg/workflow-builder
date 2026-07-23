"""The durable agent loop: reference-backed LLM and tool activities.

Diagrid python-ai pattern (diagrid/agent/pydantic_ai/workflow.py): the
workflow yields a ``call_llm`` activity per LLM message; local tool calls fan
out as one ``execute_tool`` activity each via ``when_all``, while stateful MCP
calls are ordered barriers. Full model messages live in a content-addressed
workspace transcript; Dapr history carries only small immutable references.
Unlike Diagrid's raw
OpenAI SDK, ``call_llm`` speaks through pydantic-ai's OWN model classes
(OpenAIChatModel + OpenAIProvider → Kimi K3), and history is pydantic-ai's
native ``ModelMessage`` list (ModelMessagesTypeAdapter codec).

Cancellation: a ``check_cancellation`` activity reads the Lifecycle
Controller's ``session-cancel:{instance}`` state key between iterations
(same key + turn-suffix stripping as dapr-agent-py / browser-use-agent).
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import re
import urllib.parse
import urllib.request
from contextlib import AsyncExitStack
from datetime import timedelta
from functools import wraps
from typing import Any, Callable

import dapr.ext.workflow as wf
from dapr.ext.workflow._durabletask.task import NonRetryableError
from pydantic_core import PydanticSerializationError
from pydantic_ai.messages import (
    ModelRequest,
    ModelResponse,
    ToolCallPart,
    ToolReturnPart,
    UserPromptPart,
)

from src.compaction.kimi_history import (
    compact_durable_message_json,
    compact_kimi_history,
    estimate_kimi_message_tokens,
)
from src.compaction.tokens import (
    ContextWindowBudgetError,
    get_completion_token_budget,
)
from src.config import (
    AGENT_STATE_STORE,
    DEFAULT_MAX_ITERATIONS,
    DURABLE_ACTIVITY_MAX_BYTES,
    DURABLE_CONTEXT_MAX_BYTES,
    DURABLE_ERROR_MAX_BYTES,
    DURABLE_HISTORY_KEEP_BYTES,
    DURABLE_HISTORY_ITERATIONS_PER_SEGMENT,
    DURABLE_HISTORY_MAX_BYTES,
    DURABLE_TOOL_CONTEXT_MAX_BYTES,
    DURABLE_TASK_MAX_BYTES,
    KIMI_BASE_URL,
    KIMI_DEFAULT_MODEL,
    KIMI_MAX_COMPLETION_TOKENS,
    KIMI_STREAMING_ENABLED,
    MEDIA_HISTORY_MAX_IMAGES,
    MEDIA_REQUEST_MAX_BYTES,
    MEDIA_REQUEST_MAX_IMAGES,
    MAX_ITERATIONS_PER_TURN,
    MAX_TOOL_CALLS_PER_RESPONSE,
    KIMI_TIMEOUT_SECONDS,
    TERMINAL_CONTENT_MAX_BYTES,
    TOOL_DESCRIPTOR_MAX_BYTES,
    TOOL_ERROR_MAX_BYTES,
    TOOL_RESULT_MAX_CHARS,
    TRANSCRIPT_KEEP_BYTES,
    TRANSCRIPT_MAX_BYTES,
    WORKSPACE_ROOT,
    WORKFLOW_IDENTIFIER_MAX_BYTES,
)
from src.composition import (
    durable_history_port,
    durable_media_port,
    durable_payload_codec_port,
)
from src.event_publisher import publish_session_event
from src.messages_io import (
    bootstrap_request,
    dump_messages,
    load_messages,
    messages_have_media,
    openinference_messages,
    response_text,
    response_tool_calls,
    tool_return_message,
    tool_result_display_text,
    tool_result_has_media,
    truncate,
    user_request,
)
from src.ports.durable_history import (
    DurableHistoryBudgetError,
    DurableHistoryError,
    DurableHistoryIntegrityError,
    DurableHistoryInvalidReferenceError,
    DurableHistorySerializationError,
)
from src.structured_output import (
    MAX_STRUCTURED_OUTPUT_NUDGES,
    STRUCTURED_OUTPUT_NUDGE,
    STRUCTURED_OUTPUT_MAX_BYTES,
    STRUCTURED_OUTPUT_TOOL_NAME,
    StructuredOutputConfigError,
    configured_schema,
    evaluate_call,
    output_tool_definition,
)
from src.session_native import terminal_stop_reason_from_events
from src.telemetry import (
    activity_span,
    content_capture_enabled,
    flush_telemetry,
    instrument_model,
    set_content_attr,
)
from src.toolsets import get_router

logger = logging.getLogger(__name__)

RETRY_POLICY = wf.RetryPolicy(
    first_retry_interval=timedelta(seconds=2),
    max_number_of_attempts=3,
    backoff_coefficient=2.0,
    max_retry_interval=timedelta(seconds=30),
)

CALL_LLM_ACTIVITY = "call_llm"
EXECUTE_TOOL_ACTIVITY = "execute_tool"
CHECK_CANCELLATION_ACTIVITY = "check_cancellation"
COMMIT_TOOL_RESULTS_ACTIVITY = "commit_tool_results"

STRUCTURED_OUTPUT_EXHAUSTED = "error_max_structured_output_retries"
STRUCTURED_OUTPUT_CONFIG_ERROR = "structured_output_config_error"
MODEL_CONTEXT_WINDOW_ERROR = "model_context_window_error"
MODEL_CONFIGURATION_ERROR = "model_configuration_error"
MODEL_PROVIDER_REQUEST_ERROR = "model_provider_request_error"
MODEL_TOOL_CALL_LIMIT_ERROR = "model_tool_call_limit_error"
MODEL_TOOL_DESCRIPTOR_LIMIT_ERROR = "model_tool_descriptor_limit_error"
MODEL_TERMINAL_CONTENT_LIMIT_ERROR = "model_terminal_content_too_large"
ACTIVITY_RETRY_EXHAUSTED_ERROR = "activity_retry_exhausted"
TOOL_RESULT_DURABLE_PAYLOAD_ERROR = "tool_result_durable_payload_too_large"
TOOL_RESULT_SERIALIZATION_ERROR = "tool_result_not_serializable"
DURABLE_WORKFLOW_PAYLOAD_ERROR = "durable_workflow_payload_too_large"
TRANSCRIPT_BUDGET_ERROR = "durable_transcript_budget_error"
TRANSCRIPT_INTEGRITY_ERROR = "durable_transcript_integrity_error"
TRANSCRIPT_REFERENCE_ERROR = "durable_transcript_reference_error"
TRANSCRIPT_SERIALIZATION_ERROR = "durable_transcript_serialization_error"
TRANSCRIPT_PERSISTENCE_ERROR = "durable_transcript_persistence_error"
EXECUTE_TOOL_ARGS_PAYLOAD_ERROR = (
    "were omitted because the complete execute_tool activity input exceeds "
    "the durable workflow transport budget. Request smaller tool arguments."
)


def _bounded_activity_failures(
    activity_name: str,
) -> Callable[[Callable[..., dict]], Callable[..., dict]]:
    """Keep Dapr failureDetails bounded without changing retry semantics."""

    def decorate(activity: Callable[..., dict]) -> Callable[..., dict]:
        @wraps(activity)
        def guarded(*args: Any, **kwargs: Any) -> dict:
            try:
                return activity(*args, **kwargs)
            except NonRetryableError as exc:
                logger.warning(
                    "[activity-boundary:%s] sanitized %s",
                    activity_name,
                    type(exc).__name__,
                )
                raise NonRetryableError(
                    f"{activity_name} failed with a non-retryable runtime error."
                ) from None
            except Exception as exc:  # noqa: BLE001
                logger.warning(
                    "[activity-boundary:%s] sanitized %s",
                    activity_name,
                    type(exc).__name__,
                )
                raise RuntimeError(
                    f"{activity_name} failed before returning a durable result."
                ) from None

        return guarded

    return decorate


_PROVIDER_CONTEXT_ERROR_HINTS = (
    "context length",
    "context limit",
    "context window",
    "maximum context",
    "max context",
    "too many tokens",
    "token limit",
    "input tokens",
    "max_completion_tokens",
)


def _transcript_error_code(exc: DurableHistoryError) -> str:
    if isinstance(exc, DurableHistoryBudgetError):
        return TRANSCRIPT_BUDGET_ERROR
    if isinstance(exc, DurableHistoryInvalidReferenceError):
        return TRANSCRIPT_REFERENCE_ERROR
    if isinstance(exc, DurableHistoryIntegrityError):
        return TRANSCRIPT_INTEGRITY_ERROR
    if isinstance(exc, DurableHistorySerializationError):
        return TRANSCRIPT_SERIALIZATION_ERROR
    return TRANSCRIPT_INTEGRITY_ERROR


def _transcript_error_detail(exc: DurableHistoryError) -> str:
    if isinstance(exc, DurableHistoryBudgetError):
        return (
            "The durable Kimi transcript exceeds its configured storage budget. "
            "Reduce the request or attached media and try again."
        )
    if isinstance(exc, DurableHistoryInvalidReferenceError):
        return "The durable Kimi transcript reference is invalid."
    if isinstance(exc, DurableHistorySerializationError):
        return "The durable Kimi transcript contains data that cannot be serialized."
    return "The durable Kimi transcript is unavailable or failed its integrity check."


def _bounded_inline_context(
    payload: dict[str, Any],
    *,
    payload_size_bytes: Callable[[Any], int],
    max_bytes: int = DURABLE_CONTEXT_MAX_BYTES,
) -> dict[str, Any]:
    context = dict(payload.get("context") or {})
    if payload_size_bytes(context) > max_bytes:
        raise DurableWorkflowPayloadError(
            "The private agent context exceeds its durable workflow budget."
        )
    return context


def _tool_activity_context(
    context: dict[str, Any], call: dict[str, Any]
) -> dict[str, Any]:
    agent_config = dict(context.get("agentConfig") or {})
    tool_config = {
        key: agent_config[key]
        for key in ("mcpServers", "tools", "allowedTools", "builtinTools", "modelSpec")
        if key in agent_config
    }
    if _uses_structured_output_context(context, call):
        for key in ("structuredOutputMode", "responseJsonSchema"):
            if key in agent_config:
                tool_config[key] = agent_config[key]
    return {
        key: value
        for key, value in {
            "sessionId": context.get("sessionId"),
            "dbExecutionId": context.get("dbExecutionId"),
            "workflowInstanceId": context.get("workflowInstanceId"),
            "cancellationScopeId": context.get("cancellationScopeId"),
            "turnId": context.get("turnId"),
            "turn": context.get("turn"),
            "agentConfig": tool_config,
        }.items()
        if value is not None
    }


def _uses_structured_output_context(
    context: dict[str, Any], call: dict[str, Any]
) -> bool:
    agent_config = context.get("agentConfig") or {}
    return bool(
        call.get("isStructuredOutput") is True
        and agent_config.get("structuredOutputMode") == "tool"
        and isinstance(agent_config.get("responseJsonSchema"), dict)
        and agent_config.get("responseJsonSchema")
    )


def _compact_externalized_history(
    messages: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    return compact_durable_message_json(
        messages,
        max_bytes=TRANSCRIPT_MAX_BYTES,
        keep_bytes=TRANSCRIPT_KEEP_BYTES,
    )


_DETERMINISTIC_TOOL_RESULT_ERRORS = (
    AttributeError,
    IndexError,
    KeyError,
    PydanticSerializationError,
    RecursionError,
    TypeError,
    ValueError,
    OverflowError,
)


def _enforce_durable_tool_message_budget(message: dict[str, Any]) -> None:
    """Ensure one indispensable tool return can fit K3's retained history."""

    compacted = compact_kimi_history(
        load_messages([message]),
        max_messages=1,
        keep_messages=1,
        max_bytes=TRANSCRIPT_KEEP_BYTES,
        keep_bytes=TRANSCRIPT_KEEP_BYTES,
    )
    if len(compacted) != 1:
        raise ContextWindowBudgetError(
            "A correlated tool result cannot fit the retained model history."
        )


def _project_response_tool_calls(
    response: ModelResponse,
    *,
    sequential_tool_names: set[str] | None = None,
) -> list[dict[str, Any]]:
    """Derive the bounded executable view of an immutable model response."""

    calls = response_tool_calls(response)
    sequential_names = sequential_tool_names or set()
    for call in calls:
        if call.get("toolName") in sequential_names:
            call["sequential"] = True
        if (
            call.get("toolName") == STRUCTURED_OUTPUT_TOOL_NAME
            and int(call.get("argsSizeBytes") or 0) > STRUCTURED_OUTPUT_MAX_BYTES
        ):
            call["args"] = {}
            call["argsError"] = (
                f"were {int(call['argsSizeBytes'])} UTF-8 bytes; the maximum "
                f"is {STRUCTURED_OUTPUT_MAX_BYTES}. Return a smaller object."
            )
    return calls


def _fit_small_activity_result(
    result: dict[str, Any], *, payload_size_bytes: Callable[[Any], int]
) -> dict[str, Any]:
    if result.get("toolError") is not None:
        result = {
            **result,
            "toolError": _truncate_utf8(result["toolError"], TOOL_ERROR_MAX_BYTES),
        }
    if payload_size_bytes(result) <= DURABLE_ACTIVITY_MAX_BYTES:
        return result
    detail = (
        "The activity metadata exceeds the durable workflow transport budget. "
        "Reduce the number of tool calls and try again."
    )
    failure = {
        "configurationError": detail,
        "configurationErrorCode": DURABLE_WORKFLOW_PAYLOAD_ERROR,
    }
    if payload_size_bytes(failure) > DURABLE_ACTIVITY_MAX_BYTES:
        raise DurableWorkflowPayloadError(
            "The configured durable activity transport budget cannot carry its "
            "terminal error envelope."
        )
    return failure


def _utf8_size(value: Any) -> int:
    return len(str(value or "").encode("utf-8"))


def _truncate_utf8(value: Any, max_bytes: int) -> str:
    encoded = str(value or "").encode("utf-8")
    if len(encoded) <= max_bytes:
        return encoded.decode("utf-8")
    return encoded[:max_bytes].decode("utf-8", errors="ignore")


def _tool_descriptor_limit_error(tool_calls: list[dict[str, Any]]) -> str | None:
    for call in tool_calls:
        for field in ("toolName", "toolCallId"):
            if _utf8_size(call.get(field)) > TOOL_DESCRIPTOR_MAX_BYTES:
                return (
                    f"Kimi K3 returned a {field} value larger than the durable "
                    f"{TOOL_DESCRIPTOR_MAX_BYTES}-byte descriptor limit."
                )
    return None


def _bounded_tool_event_args(args: Any) -> Any:
    try:
        encoded = json.dumps(args, ensure_ascii=False, allow_nan=False)
    except (TypeError, ValueError):
        return {"omitted": True, "reason": "arguments are not valid JSON"}
    size_bytes = len(encoded.encode("utf-8"))
    if size_bytes <= TOOL_RESULT_MAX_CHARS:
        return args
    return {
        "omitted": True,
        "reason": "arguments exceed the observability payload limit",
        "sizeBytes": size_bytes,
    }


def is_provider_context_window_error(exc: BaseException) -> bool:
    """Recognize a non-retriable provider rejection of the shared token budget."""

    if getattr(exc, "status_code", None) != 400:
        return False
    details = [str(exc)]
    body = getattr(exc, "body", None)
    if body is not None:
        try:
            details.append(json.dumps(body, sort_keys=True))
        except (TypeError, ValueError):
            details.append(str(body))
    response = getattr(exc, "response", None)
    response_text = getattr(response, "text", None)
    if response_text:
        details.append(str(response_text))
    normalized = " ".join(details).lower()
    return any(hint in normalized for hint in _PROVIDER_CONTEXT_ERROR_HINTS)


def is_terminal_provider_request_error(exc: BaseException) -> bool:
    status = getattr(exc, "status_code", None)
    return (
        isinstance(status, int)
        and 400 <= status < 500
        and status not in {408, 409, 425, 429}
    )


def _structured_failure_result(
    *,
    messages: list[dict],
    iterations: int,
    attempts: int,
    feedback: str,
    code: str = STRUCTURED_OUTPUT_EXHAUSTED,
) -> dict[str, Any]:
    detail = _truncate_utf8(
        feedback or "Structured output was not produced.", DURABLE_ERROR_MAX_BYTES
    )
    return {
        "role": "assistant",
        "content": detail,
        "success": False,
        "error": detail,
        "errorCode": code,
        "structuredOutputFailure": {
            "code": code,
            "attemptsUsed": attempts,
            "feedback": detail,
        },
        "iterations": iterations,
        "messages": messages,
    }


def _configuration_failure_result(
    *,
    messages: list[dict],
    iterations: int,
    feedback: str,
    code: str,
) -> dict[str, Any]:
    detail = _truncate_utf8(
        feedback or "Model configuration failure.", DURABLE_ERROR_MAX_BYTES
    )
    return {
        "role": "assistant",
        "content": detail,
        "success": False,
        "error": detail,
        "errorCode": code,
        "iterations": iterations,
        "messages": messages,
    }


def fit_call_llm_activity_result(
    *,
    messages: list[dict[str, Any]],
    tool_calls: list[dict[str, Any]],
    text: str,
    payload_size_bytes: Callable[[Any], int],
) -> dict[str, Any]:
    """Fit the complete result under Dapr's actual activity transport ceiling."""

    result = {"messages": messages, "toolCalls": tool_calls, "text": text}
    if payload_size_bytes(result) <= DURABLE_ACTIVITY_MAX_BYTES:
        return result

    envelope_size = payload_size_bytes(
        {"messages": [], "toolCalls": tool_calls, "text": text}
    )
    history_budget = max(1, DURABLE_ACTIVITY_MAX_BYTES - envelope_size)
    try:
        result["messages"] = compact_durable_message_json(
            messages,
            max_bytes=min(DURABLE_HISTORY_MAX_BYTES, history_budget),
            keep_bytes=min(DURABLE_HISTORY_KEEP_BYTES, history_budget),
        )
    except ContextWindowBudgetError:
        pass
    if payload_size_bytes(result) <= DURABLE_ACTIVITY_MAX_BYTES:
        return result

    detail = (
        "Kimi K3 produced an activity result that exceeds the durable transport "
        "budget after compaction. Reduce the request or attached media and try again."
    )
    return {
        "messages": [],
        "toolCalls": [],
        "text": "",
        "configurationError": detail,
        "configurationErrorCode": DURABLE_WORKFLOW_PAYLOAD_ERROR,
    }


def fit_execute_tool_activity_result(
    *,
    message: dict[str, Any],
    tool_name: str,
    tool_call_id: str,
    tool_error: str | None,
    structured_output_attempt: bool,
    structured_output: str | None,
    payload_size_bytes: Callable[[Any], int],
    tool_error_code: str | None = None,
) -> dict[str, Any]:
    """Bound one tool result using the exact durable-task representation."""

    result = {
        "message": message,
        "toolSucceeded": tool_error is None,
        "toolError": tool_error,
        **({"toolErrorCode": tool_error_code} if tool_error_code else {}),
        "structuredOutputAttempt": structured_output_attempt,
        "structuredOutput": structured_output,
    }
    if payload_size_bytes(result) <= DURABLE_ACTIVITY_MAX_BYTES:
        return result

    detail = (
        f"Tool {tool_name or 'tool'} returned more data than the durable workflow "
        "transport can retain. Request a narrower result or read it in smaller chunks."
    )
    bounded_message = dump_messages(
        [tool_return_message(tool_name or "tool", tool_call_id, detail)]
    )[0]
    tool_failure = {
        "message": bounded_message,
        "toolSucceeded": False,
        "toolError": detail,
        "toolErrorCode": TOOL_RESULT_DURABLE_PAYLOAD_ERROR,
        "structuredOutputAttempt": structured_output_attempt,
        "structuredOutput": None,
    }
    if payload_size_bytes(tool_failure) <= DURABLE_ACTIVITY_MAX_BYTES:
        return tool_failure

    # A pathological correlation id can make even the required tool-return
    # envelope too large. Fail the workflow explicitly instead of returning an
    # orphaned or truncated tool result that K3 cannot replay.
    terminal_detail = (
        "The tool result and its correlation metadata exceed the durable "
        "workflow transport budget."
    )
    terminal = {
        "message": None,
        "toolSucceeded": False,
        "toolError": terminal_detail,
        "toolErrorCode": TOOL_RESULT_DURABLE_PAYLOAD_ERROR,
        "structuredOutputAttempt": structured_output_attempt,
        "structuredOutput": None,
        "configurationError": terminal_detail,
        "configurationErrorCode": TOOL_RESULT_DURABLE_PAYLOAD_ERROR,
    }
    if payload_size_bytes(terminal) > DURABLE_ACTIVITY_MAX_BYTES:
        raise ContextWindowBudgetError(
            "The configured durable activity transport budget cannot carry its "
            "terminal error envelope."
        )
    return terminal


class DurableWorkflowPayloadError(ValueError):
    """A workflow boundary cannot fit without violating replay semantics."""


def fit_workflow_activity_input(
    *,
    activity_name: str,
    payload: dict[str, Any],
    payload_size_bytes: Callable[[Any], int],
) -> dict[str, Any]:
    """Fit one complete scheduled-activity input without rewriting content."""

    candidate = dict(payload)
    if payload_size_bytes(candidate) <= DURABLE_ACTIVITY_MAX_BYTES:
        return candidate

    raw_messages = candidate.get("messages")
    if isinstance(raw_messages, list) and raw_messages:
        envelope = {**candidate, "messages": []}
        history_budget = max(
            1, DURABLE_ACTIVITY_MAX_BYTES - payload_size_bytes(envelope)
        )
        try:
            candidate["messages"] = compact_durable_message_json(
                raw_messages,
                max_bytes=min(DURABLE_HISTORY_MAX_BYTES, history_budget),
                keep_bytes=min(DURABLE_HISTORY_KEEP_BYTES, history_budget),
            )
        except (ContextWindowBudgetError, TypeError, ValueError):
            pass
        if payload_size_bytes(candidate) <= DURABLE_ACTIVITY_MAX_BYTES:
            return candidate

    raise DurableWorkflowPayloadError(
        f"The complete {activity_name} activity input exceeds the durable workflow "
        "transport budget and cannot be compacted without removing the current "
        "request or a tool call/result pair."
    )


def fit_execute_tool_activity_input(
    *,
    call: dict[str, Any],
    context: dict[str, Any] | None,
    iteration: int,
    payload_size_bytes: Callable[[Any], int],
) -> dict[str, Any]:
    """Fit an execute input, omitting only its execution-copy arguments."""

    context_payload = {"context": dict(context or {})}
    payload = {"call": dict(call), **context_payload, "iteration": iteration}
    try:
        return fit_workflow_activity_input(
            activity_name=EXECUTE_TOOL_ACTIVITY,
            payload=payload,
            payload_size_bytes=payload_size_bytes,
        )
    except (DurableWorkflowPayloadError, PydanticSerializationError, TypeError):
        if call.get("responseRef"):
            raise
        projected_call = dict(call)
        projected_call["args"] = {}
        projected_call["argsError"] = EXECUTE_TOOL_ARGS_PAYLOAD_ERROR
        return fit_workflow_activity_input(
            activity_name=EXECUTE_TOOL_ACTIVITY,
            payload={
                "call": projected_call,
                **context_payload,
                "iteration": iteration,
            },
            payload_size_bytes=payload_size_bytes,
        )


def split_workflow_activity_batches(
    payloads: list[dict[str, Any]],
    *,
    payload_size_bytes: Callable[[Any], int],
) -> list[list[dict[str, Any]]]:
    """Greedily bound the aggregate inputs returned in one ``when_all``."""

    batches: list[list[dict[str, Any]]] = []
    current: list[dict[str, Any]] = []
    for payload in payloads:
        candidate = [*current, payload]
        if payload_size_bytes(candidate) <= DURABLE_ACTIVITY_MAX_BYTES:
            current = candidate
            continue
        if not current or payload_size_bytes([payload]) > DURABLE_ACTIVITY_MAX_BYTES:
            raise DurableWorkflowPayloadError(
                "An execute_tool activity input cannot fit in a durable workflow "
                "fan-out batch."
            )
        batches.append(current)
        current = [payload]
    if current:
        batches.append(current)
    return batches


def _durable_workflow_payload_failure_result(
    iterations: int, *, cancelled: bool = False
) -> dict[str, Any]:
    detail = (
        "The workflow payload exceeds the durable transport budget and cannot be "
        "compacted without removing the current request or a tool call/result pair."
    )
    result: dict[str, Any] = {
        "role": "assistant",
        "content": detail,
        "success": False,
        "error": detail,
        "errorCode": DURABLE_WORKFLOW_PAYLOAD_ERROR,
        "iterations": max(0, iterations),
        "messages": [],
    }
    if cancelled:
        result["cancelled"] = True
        result["stop_reason"] = {"type": "terminated"}
    return result


def fit_workflow_terminal_result(
    result: dict[str, Any], *, payload_size_bytes: Callable[[Any], int]
) -> dict[str, Any]:
    """Exact-bound a terminal workflow result, compacting only its history."""

    candidate = dict(result)
    if payload_size_bytes(candidate) <= DURABLE_ACTIVITY_MAX_BYTES:
        return candidate

    raw_messages = candidate.get("messages")
    if isinstance(raw_messages, list) and raw_messages:
        envelope = {**candidate, "messages": []}
        history_budget = max(
            1, DURABLE_ACTIVITY_MAX_BYTES - payload_size_bytes(envelope)
        )
        try:
            candidate["messages"] = compact_durable_message_json(
                raw_messages,
                max_bytes=min(DURABLE_HISTORY_MAX_BYTES, history_budget),
                keep_bytes=min(DURABLE_HISTORY_KEEP_BYTES, history_budget),
            )
        except (ContextWindowBudgetError, TypeError, ValueError):
            pass
        if payload_size_bytes(candidate) <= DURABLE_ACTIVITY_MAX_BYTES:
            return candidate

    try:
        iterations = int(candidate.get("iterations") or 0)
    except (TypeError, ValueError):
        iterations = 0
    failure = _durable_workflow_payload_failure_result(
        iterations, cancelled=bool(candidate.get("cancelled"))
    )
    if payload_size_bytes(failure) > DURABLE_ACTIVITY_MAX_BYTES:
        raise DurableWorkflowPayloadError(
            "The configured durable workflow transport budget cannot carry its "
            "terminal error envelope."
        )
    return failure


# ---------------------------------------------------------------------------
# Cancellation plumbing (session-cancel:{instance}, turn-suffix tolerant)
# ---------------------------------------------------------------------------


def _session_cancel_state_key(instance_id: str) -> str:
    return f"session-cancel:{instance_id}"


def _cancellation_candidate_ids(instance_id: str) -> list[str]:
    text = str(instance_id or "").strip()
    if not text:
        return []
    ids = [text]
    base = re.sub(r"__turn__\d+$", "", text)
    base = re.sub(r":turn-\d+$", "", base)
    if base and base != text and base not in ids:
        ids.append(base)
    return ids


def _read_agent_state_key(key: str) -> Any | None:
    sidecar = (
        f"http://{os.environ.get('DAPR_HOST', '127.0.0.1')}:"
        f"{os.environ.get('DAPR_HTTP_PORT', '3500')}"
    )
    encoded = urllib.parse.quote(key, safe="")
    url = (
        f"{sidecar}/v1.0/state/{AGENT_STATE_STORE}/{encoded}"
        f"?metadata.partitionKey={encoded}"
    )
    try:
        with urllib.request.urlopen(
            urllib.request.Request(url, method="GET"), timeout=5
        ) as response:
            body = response.read()
    except Exception:  # noqa: BLE001 — missing key / sidecar blip → not cancelled
        return None
    if not body:
        return None
    try:
        return json.loads(body)
    except (TypeError, ValueError):
        return None


def read_cancellation_request(scope_id: str) -> dict[str, Any] | None:
    for candidate in _cancellation_candidate_ids(scope_id):
        value = _read_agent_state_key(_session_cancel_state_key(candidate))
        if isinstance(value, dict) and value.get("type"):
            return value
    return None


# ---------------------------------------------------------------------------
# LLM construction (pydantic-ai model classes → Kimi K3)
# ---------------------------------------------------------------------------


def build_model():
    """Kimi K3 through pydantic-ai's OpenAI-compatible model class."""
    from pydantic_ai.models.openai import OpenAIChatModel
    from pydantic_ai.providers.openai import OpenAIProvider

    api_key = os.environ.get("KIMI_API_KEY")
    if not api_key:
        raise RuntimeError(
            "No Kimi authentication configured. Set KIMI_API_KEY "
            "(pydantic-ai-agent-py authenticates the default kimi-k3 model with it)."
        )
    provider = OpenAIProvider(base_url=KIMI_BASE_URL, api_key=api_key)
    # Dapr activity retries are the durable retry authority. SDK retries would
    # multiply one failed activity into as many as nine provider requests.
    provider.client.max_retries = 0
    return OpenAIChatModel(
        KIMI_DEFAULT_MODEL,
        provider=provider,
        profile=_kimi_model_profile,
    )


def _kimi_model_profile(base: dict[str, Any]) -> dict[str, Any]:
    """Keep Kimi's wire contract exact instead of applying OpenAI rewrites."""
    return {
        **base,
        "json_schema_transformer": None,
        "supports_json_schema_output": True,
        "supports_thinking": True,
        "thinking_always_enabled": True,
        "openai_chat_thinking_field": "reasoning_content",
        "openai_chat_send_back_thinking_parts": "field",
        "openai_supports_tool_choice_required": True,
        "openai_supports_strict_tool_definition": False,
    }


def build_model_settings() -> dict[str, Any]:
    """kimi-k3 accepts only temperature=1 / frequency_penalty=0 and always
    runs max reasoning (verified against the live Kimi-for-Coding endpoint)."""
    from pydantic_ai.settings import ModelSettings

    return ModelSettings(
        temperature=1,
        frequency_penalty=0,
        max_tokens=KIMI_MAX_COMPLETION_TOKENS,
        timeout=float(KIMI_TIMEOUT_SECONDS),
        extra_body={"reasoning_effort": "max"},
    )


def apply_context_completion_budget(
    settings: dict[str, Any], messages: list[Any]
) -> dict[str, Any]:
    completion_tokens = get_completion_token_budget(
        KIMI_DEFAULT_MODEL,
        input_tokens=estimate_kimi_message_tokens(messages),
        requested_tokens=KIMI_MAX_COMPLETION_TOKENS,
    )
    return {**settings, "max_tokens": completion_tokens}


async def request_model_response(model: Any, request_context: Any) -> Any:
    """Return one complete response while streaming only at the HTTP boundary."""
    async with AsyncExitStack() as stack:
        if hasattr(model, "__aenter__") and hasattr(model, "__aexit__"):
            await stack.enter_async_context(model)

        if not KIMI_STREAMING_ENABLED or not hasattr(model, "request_stream"):
            if KIMI_STREAMING_ENABLED:
                logger.warning(
                    "[call-llm] model has no request_stream; using non-streaming transport"
                )
            return await model.request(
                request_context.messages,
                request_context.model_settings,
                request_context.model_request_parameters,
            )

        async with model.request_stream(
            request_context.messages,
            request_context.model_settings,
            request_context.model_request_parameters,
        ) as streamed:
            # Drain every event so pydantic-ai can assemble text, preserved
            # reasoning, fragmented tool calls, finish reason, and final usage.
            # Individual events never cross the activity boundary.
            async for _ in streamed:
                pass
            response = streamed.get()

    usage = getattr(response, "usage", None)
    input_tokens = int(getattr(usage, "input_tokens", 0) or 0)
    output_tokens = int(getattr(usage, "output_tokens", 0) or 0)
    if (
        getattr(response, "state", "complete") != "complete"
        or not getattr(response, "finish_reason", None)
        or input_tokens + output_tokens <= 0
    ):
        raise RuntimeError(
            "Kimi streaming response ended without complete terminal usage"
        )
    return response


def _span_base_attrs(context: dict, iteration: int) -> dict[str, Any]:
    """Platform identity attrs every activity span carries.

    `session.id` / `workflow.execution.id` are the keys the BFF ClickHouse
    reader and the curated obs.* views filter on; the rest make the trace
    self-describing without a DB join.
    """
    attrs: dict[str, Any] = {"agent.framework": "pydantic-ai", "iteration": iteration}
    if context.get("sessionId"):
        attrs["session.id"] = str(context["sessionId"])
    if context.get("dbExecutionId"):
        attrs["workflow.execution.id"] = str(context["dbExecutionId"])
    if context.get("workflowInstanceId"):
        attrs["dapr.workflow.instance_id"] = str(context["workflowInstanceId"])
    if context.get("turnId"):
        attrs["workflow_builder.turn_id"] = str(context["turnId"])
    if context.get("turn") is not None:
        attrs["agent.turn"] = int(context.get("turn") or 0)
    model_spec = (context.get("agentConfig") or {}).get("modelSpec")
    if model_spec:
        attrs["agent.model_spec"] = str(model_spec)
    return attrs


# ---------------------------------------------------------------------------
# Activities
# ---------------------------------------------------------------------------


@_bounded_activity_failures(CHECK_CANCELLATION_ACTIVITY)
def check_cancellation(ctx: wf.WorkflowActivityContext, payload: dict) -> dict:
    del ctx
    payload_codec = durable_payload_codec_port()
    scope = str((payload or {}).get("scopeId") or "")
    request = read_cancellation_request(scope) if scope else None
    if not request:
        return {"cancelled": False}
    stop_reason = terminal_stop_reason_from_events([request]) or {"type": "terminated"}
    reason = _truncate_utf8(
        request.get("reason") or stop_reason.get("reason") or "session cancelled",
        DURABLE_ERROR_MAX_BYTES,
    )
    return _fit_small_activity_result(
        {"cancelled": True, "reason": reason, "stop_reason": stop_reason},
        payload_size_bytes=payload_codec.size_bytes,
    )


@_bounded_activity_failures(CALL_LLM_ACTIVITY)
def call_llm(ctx: wf.WorkflowActivityContext, payload: dict) -> dict:
    """One LLM message as one durable activity.

    Normal input carries ``historyRef`` plus a strictly bounded private inline
    context. Credentials are never written to the agent-readable workspace.
    ``messages`` remains a one-time legacy import shape only.
    On iteration 0 with a task, the message list is bootstrapped here
    (system prompt = agentConfig.systemPrompt + capability instructions) so
    the workflow body stays deterministic/pure.
    """
    payload = payload or {}
    history_store = durable_history_port(WORKSPACE_ROOT)
    payload_codec = durable_payload_codec_port()
    legacy_inline = "messages" in payload and not payload.get("historyRef")
    legacy_output = legacy_inline and not bool(payload.get("migrateInlineHistory"))
    try:
        context = _bounded_inline_context(
            payload, payload_size_bytes=payload_codec.size_bytes
        )
        history_ref = str(payload.get("historyRef") or "").strip()
        durable_history = (
            history_store.load(history_ref)
            if history_ref
            else list(payload.get("messages") or [])
        )
        for message_ref in payload.get("messageRefs") or []:
            durable_history.append(history_store.load_message(str(message_ref)))
    except DurableWorkflowPayloadError as exc:
        return _fit_small_activity_result(
            {
                "toolCalls": [],
                "text": "",
                "configurationError": str(exc),
                "configurationErrorCode": DURABLE_WORKFLOW_PAYLOAD_ERROR,
            },
            payload_size_bytes=payload_codec.size_bytes,
        )
    except DurableHistoryError as exc:
        return _fit_small_activity_result(
            {
                "toolCalls": [],
                "text": "",
                "configurationError": _transcript_error_detail(exc),
                "configurationErrorCode": _transcript_error_code(exc),
                "transcriptStateInvalid": True,
            },
            payload_size_bytes=payload_codec.size_bytes,
        )
    known_balanced_history_ref = history_ref
    agent_cfg = context.get("agentConfig") or {}
    iteration = int(payload.get("iteration") or 0)
    session_id = str(context.get("sessionId") or "") or None
    scope = str(
        context.get("cancellationScopeId") or context.get("workflowInstanceId") or ""
    )
    turn_id = str(context.get("turnId") or "turn")
    logger.info(
        "[activity:%s] iteration=%d scope=%s", CALL_LLM_ACTIVITY, iteration, scope
    )

    async def run(span) -> dict:
        router = get_router(agent_cfg)
        media = durable_media_port(WORKSPACE_ROOT)

        def post_provider_failure(
            detail: str,
            code: str,
            *,
            history_reference: str | None = None,
            response_reference: str = "",
        ) -> dict[str, Any]:
            retained_history_ref = (
                known_balanced_history_ref
                if history_reference is None
                else history_reference
            )
            return _fit_small_activity_result(
                {
                    "toolCalls": [],
                    "text": "",
                    "configurationError": _truncate_utf8(
                        detail, DURABLE_ERROR_MAX_BYTES
                    ),
                    "configurationErrorCode": code,
                    **(
                        {"historyRef": retained_history_ref}
                        if retained_history_ref
                        else {}
                    ),
                    **(
                        {"responseRef": response_reference}
                        if response_reference
                        else {}
                    ),
                },
                payload_size_bytes=payload_codec.size_bytes,
            )

        def persistence_failure() -> dict[str, Any]:
            return post_provider_failure(
                "Kimi completed the model request, but its response could not be "
                "persisted. The request will not be retried automatically.",
                TRANSCRIPT_PERSISTENCE_ERROR,
            )

        def serialization_failure() -> dict[str, Any]:
            return post_provider_failure(
                "Kimi completed the model request, but its response could not be "
                "serialized into durable history. The request will not be retried "
                "automatically.",
                TRANSCRIPT_SERIALIZATION_ERROR,
            )

        try:
            restored = await media.restore(
                durable_history,
                max_media_items=MEDIA_HISTORY_MAX_IMAGES,
                max_request_images=MEDIA_REQUEST_MAX_IMAGES,
                max_request_bytes=MEDIA_REQUEST_MAX_BYTES,
            )
        except (FileNotFoundError, ValueError):
            return _fit_small_activity_result(
                {
                    "toolCalls": [],
                    "text": "",
                    "configurationError": (
                        "The durable Kimi transcript contains invalid media data."
                    ),
                    "configurationErrorCode": TRANSCRIPT_INTEGRITY_ERROR,
                    **(
                        {"transcriptStateInvalid": True}
                        if known_balanced_history_ref
                        else {}
                    ),
                },
                payload_size_bytes=payload_codec.size_bytes,
            )
        messages = restored

        async def configuration_failure(
            history: list[Any], detail: str, code: str
        ) -> dict[str, Any]:
            durable: list[dict[str, Any]] = []
            bounded_history_ref = ""
            persistence_failed = False
            try:
                bounded = compact_kimi_history(list(history))
                durable = _compact_externalized_history(
                    await media.externalize(bounded)
                )
                bounded_history_ref = history_store.save(durable)
            except ContextWindowBudgetError:
                pass
            except OSError:
                # The provider/configuration failure is already terminal. Do
                # not retry it merely because recording its bounded history
                # hit a transient workspace failure.
                bounded_history_ref = known_balanced_history_ref
                persistence_failed = True
            except DurableHistoryError as exc:
                durable = []
                bounded_history_ref = known_balanced_history_ref
                detail = _transcript_error_detail(exc)
                code = _transcript_error_code(exc)
                persistence_failed = True
            except _DETERMINISTIC_TOOL_RESULT_ERRORS:
                durable = []
                bounded_history_ref = known_balanced_history_ref
                detail = (
                    "The terminal model failure could not be serialized into "
                    "durable history."
                )
                code = TRANSCRIPT_SERIALIZATION_ERROR
                persistence_failed = True
            failure = {
                "toolCalls": [],
                "text": "",
                "configurationError": _truncate_utf8(detail, DURABLE_ERROR_MAX_BYTES),
                "configurationErrorCode": code,
                **({"historyRef": bounded_history_ref} if bounded_history_ref else {}),
            }
            if legacy_output and not persistence_failed:
                failure["messages"] = durable
            return _fit_small_activity_result(
                failure, payload_size_bytes=payload_codec.size_bytes
            )

        task = str(payload.get("task") or "")
        if payload_codec.size_bytes(task) > DURABLE_TASK_MAX_BYTES:
            return await configuration_failure(
                messages,
                "The user task exceeds its durable workflow input budget.",
                DURABLE_WORKFLOW_PAYLOAD_ERROR,
            )
        if task:
            if not messages:
                base_prompt = str(agent_cfg.get("systemPrompt") or "").strip() or (
                    "You are a precise, capable coding agent working in a "
                    "pod-local workspace. Use the available tools to complete "
                    "the task, then reply with a concise factual summary."
                )
                capability_instructions = await router.instructions()
                system_prompt = "\n\n".join(
                    p for p in (base_prompt, capability_instructions) if p
                )
                messages.append(bootstrap_request(system_prompt, task))
            else:
                messages.append(user_request(task))

        from pydantic_ai.models import ModelRequestContext, ModelRequestParameters

        try:
            schema = configured_schema(agent_cfg)
        except StructuredOutputConfigError as exc:
            return await configuration_failure(
                messages, str(exc), STRUCTURED_OUTPUT_CONFIG_ERROR
            )
        function_tools, sequential_tool_names = await router.tool_defs_with_execution()
        if schema and any(
            tool.name == STRUCTURED_OUTPUT_TOOL_NAME for tool in function_tools
        ):
            return await configuration_failure(
                messages,
                (
                    "A configured harness or MCP tool collides with the reserved "
                    "StructuredOutput tool name."
                ),
                STRUCTURED_OUTPUT_CONFIG_ERROR,
            )
        if schema:
            function_tools = [output_tool_definition(schema), *function_tools]
        params = ModelRequestParameters(
            function_tools=function_tools,
            output_mode="text",
            output_tools=[],
            # Match dapr-agent-py's proven Kimi contract: normal coding tools
            # and the synthetic result tool coexist under tool_choice=auto.
            allow_text_output=True,
        )
        # Native pydantic-ai instrumentation: the wrapped model emits the
        # GenAI-semconv `chat <model>` span (request params, messages, usage,
        # cost, token metrics) as a child of this activity's span.
        try:
            raw_model = build_model()
        except RuntimeError as exc:
            return await configuration_failure(
                messages, str(exc), MODEL_CONFIGURATION_ERROR
            )
        model = instrument_model(
            raw_model, include_content=not messages_have_media(messages)
        )
        request_context = ModelRequestContext(
            model=model,
            messages=messages,
            model_settings=build_model_settings(),
            model_request_parameters=params,
        )
        # Capability hook chain, hosted inside this durable activity:
        # before_model_request (the unified K3 history window) transforms
        # the DURABLE history — whatever the model sees is what this activity
        # returns, so replay stays consistent and history stays bounded.
        try:
            request_context = await router.apply_before_model_request(request_context)
            request_context.model_settings = apply_context_completion_budget(
                dict(request_context.model_settings or {}),
                list(request_context.messages),
            )
        except ContextWindowBudgetError as exc:
            return await configuration_failure(
                list(request_context.messages), str(exc), MODEL_CONTEXT_WINDOW_ERROR
            )

        async def base_handler(rc):
            return await request_model_response(model, rc)

        if span is not None:
            span.set_attribute("llm.streaming", KIMI_STREAMING_ENABLED)
        try:
            response = await router.apply_model_request(request_context, base_handler)
        except Exception as exc:  # noqa: BLE001
            if is_provider_context_window_error(exc):
                logger.warning(
                    "[call-llm] Kimi rejected the shared context budget: %s", exc
                )
                return await configuration_failure(
                    list(request_context.messages),
                    (
                        "Kimi K3 rejected the request because its input and completion "
                        "budget exceed the 1,048,576-token context window. Reduce the "
                        "request or attached media and try again."
                    ),
                    MODEL_CONTEXT_WINDOW_ERROR,
                )
            if is_terminal_provider_request_error(exc):
                logger.warning("[call-llm] terminal Kimi request rejection: %s", exc)
                status = int(getattr(exc, "status_code"))
                return await configuration_failure(
                    list(request_context.messages),
                    f"Kimi K3 rejected the request with HTTP {status}.",
                    MODEL_PROVIDER_REQUEST_ERROR,
                )
            raise
        try:
            response = await router.apply_after_model_request(request_context, response)
            input_messages = list(request_context.messages)
            text = response_text(response)
            tool_calls = _project_response_tool_calls(
                response,
                sequential_tool_names=sequential_tool_names,
            )
        except _DETERMINISTIC_TOOL_RESULT_ERRORS:
            return serialization_failure()
        messages = list(request_context.messages)
        messages.append(response)
        try:
            messages = compact_kimi_history(
                messages,
                max_bytes=TRANSCRIPT_MAX_BYTES,
                keep_bytes=TRANSCRIPT_KEEP_BYTES,
            )
            response = messages[-1]
            durable_messages = _compact_externalized_history(
                await media.externalize(messages)
            )
            history_ref = history_store.save(durable_messages)
            response_ref = history_store.save_message(durable_messages[-1])
        except ContextWindowBudgetError as exc:
            return post_provider_failure(str(exc), MODEL_CONTEXT_WINDOW_ERROR)
        except OSError:
            return persistence_failure()
        except DurableHistoryError as exc:
            return post_provider_failure(
                _transcript_error_detail(exc), _transcript_error_code(exc)
            )
        except _DETERMINISTIC_TOOL_RESULT_ERRORS:
            return serialization_failure()
        try:
            usage = response.usage
        except _DETERMINISTIC_TOOL_RESULT_ERRORS:
            return serialization_failure()

        if len(tool_calls) > MAX_TOOL_CALLS_PER_RESPONSE:
            return post_provider_failure(
                (
                    f"Kimi K3 returned {len(tool_calls)} tool calls in one response; "
                    f"the durable maximum is {MAX_TOOL_CALLS_PER_RESPONSE}."
                ),
                MODEL_TOOL_CALL_LIMIT_ERROR,
                response_reference=response_ref,
            )
        descriptor_error = _tool_descriptor_limit_error(tool_calls)
        if descriptor_error:
            return post_provider_failure(
                descriptor_error,
                MODEL_TOOL_DESCRIPTOR_LIMIT_ERROR,
                response_reference=response_ref,
            )
        if not tool_calls and _utf8_size(text) > TERMINAL_CONTENT_MAX_BYTES:
            return post_provider_failure(
                (
                    "Kimi K3 returned final text larger than the durable "
                    f"{TERMINAL_CONTENT_MAX_BYTES}-byte terminal-content limit."
                ),
                MODEL_TERMINAL_CONTENT_LIMIT_ERROR,
                history_reference=history_ref,
                response_reference=response_ref,
            )

        if span is not None:
            # Platform/OpenInference contract on the ACTIVITY span: the
            # curated obs.llm_spans view gates on openinference.span.kind
            # and reads llm.token_count.* / llm.{input,output}_messages.
            # The nested native chat span has no span.kind, so it is never
            # double-counted by the view.
            try:
                gross_input = int(getattr(usage, "input_tokens", 0) or 0)
                output_toks = int(getattr(usage, "output_tokens", 0) or 0)
                span.set_attribute("openinference.span.kind", "LLM")
                span.set_attribute(
                    "llm.model_name",
                    str(getattr(response, "model_name", None) or KIMI_DEFAULT_MODEL),
                )
                span.set_attribute("llm.provider", "kimi")
                span.set_attribute("llm.token_count.prompt", gross_input)
                span.set_attribute("llm.token_count.completion", output_toks)
                span.set_attribute("llm.token_count.total", gross_input + output_toks)
                cache_read_toks = int(getattr(usage, "cache_read_tokens", 0) or 0)
                if cache_read_toks:
                    span.set_attribute(
                        "gen_ai.usage.cache_read_input_tokens", cache_read_toks
                    )
                cache_write_toks = int(getattr(usage, "cache_write_tokens", 0) or 0)
                if cache_write_toks:
                    span.set_attribute(
                        "gen_ai.usage.cache_creation_input_tokens", cache_write_toks
                    )
                finish = getattr(response, "finish_reason", None)
                if finish:
                    span.set_attribute("llm.finish_reason", str(finish))
                if content_capture_enabled():
                    set_content_attr(
                        span,
                        "llm.input_messages",
                        openinference_messages(input_messages),
                    )
                    set_content_attr(
                        span, "llm.output_messages", openinference_messages([response])
                    )
            except Exception as exc:  # noqa: BLE001
                logger.debug("[call-llm] span stamping failed: %s", exc)

        if session_id:
            if text or tool_calls:
                publish_session_event(
                    session_id,
                    "llm_complete",
                    {
                        "content": text
                        or "(tool calls: "
                        + ", ".join(c["toolName"] for c in tool_calls)
                        + ")",
                        "iteration": iteration,
                    },
                    source_event_id=f"{scope}:{turn_id}:i{iteration}:msg",
                    instance_id=scope,
                )
            try:
                gross_input = int(getattr(usage, "input_tokens", 0) or 0)
                cache_read = int(getattr(usage, "cache_read_tokens", 0) or 0)
                output_tokens = int(getattr(usage, "output_tokens", 0) or 0)
                if gross_input or output_tokens:
                    publish_session_event(
                        session_id,
                        "agent.llm_usage",
                        {
                            # Platform invariant: input NET of cache reads.
                            "input_tokens": max(gross_input - cache_read, 0),
                            "output_tokens": output_tokens,
                            "cache_read_input_tokens": cache_read,
                            "model": KIMI_DEFAULT_MODEL,
                            "iteration": iteration,
                        },
                        source_event_id=f"{scope}:{turn_id}:i{iteration}:usage",
                        instance_id=scope,
                    )
            except Exception as exc:  # noqa: BLE001
                logger.debug("[call-llm] usage publish skipped: %s", exc)

        if legacy_output:
            return fit_call_llm_activity_result(
                messages=durable_messages,
                tool_calls=tool_calls,
                text=text,
                payload_size_bytes=payload_codec.size_bytes,
            )

        try:
            projected_calls: list[dict[str, Any]] = []
            for tool_index, call in enumerate(tool_calls):
                projected_calls.append(
                    {
                        "responseRef": response_ref,
                        "toolIndex": tool_index,
                        "sequential": bool(call.get("sequential")),
                        "isStructuredOutput": bool(
                            schema is not None
                            and call.get("toolName") == STRUCTURED_OUTPUT_TOOL_NAME
                        ),
                    }
                )
        except _DETERMINISTIC_TOOL_RESULT_ERRORS:
            return serialization_failure()
        return _fit_small_activity_result(
            {
                "historyRef": history_ref,
                "responseRef": response_ref,
                "toolCalls": projected_calls,
                "text": "" if projected_calls else text,
            },
            payload_size_bytes=payload_codec.size_bytes,
        )

    try:
        with activity_span("call_llm", _span_base_attrs(context, iteration)) as span:
            return asyncio.run(run(span))
    finally:
        # Per-session pods are reaped at session end — flush per activity so
        # a reap between batch-export ticks loses nothing.
        flush_telemetry()


@_bounded_activity_failures(EXECUTE_TOOL_ACTIVITY)
def execute_tool(ctx: wf.WorkflowActivityContext, payload: dict) -> dict:
    """One tool call as one durable activity.

    The normal input identifies a tool part inside an immutable assistant
    ``responseRef``. The activity resolves exact arguments locally and returns
    a ``messageRef`` for one correlated ToolReturnPart. Inline args/message
    output remains only as a legacy activity-test/import shape.
    """
    payload = payload or {}
    call = payload.get("call") or {}
    history_store = durable_history_port(WORKSPACE_ROOT)
    payload_codec = durable_payload_codec_port()
    legacy_inline = not bool(call.get("responseRef"))
    try:
        raw_context = dict(payload.get("context") or {})
        context = _bounded_inline_context(
            payload,
            payload_size_bytes=payload_codec.size_bytes,
            max_bytes=(
                DURABLE_CONTEXT_MAX_BYTES
                if _uses_structured_output_context(raw_context, call)
                else DURABLE_TOOL_CONTEXT_MAX_BYTES
            ),
        )
    except DurableWorkflowPayloadError as exc:
        return _fit_small_activity_result(
            {
                "toolSucceeded": False,
                "configurationError": str(exc),
                "configurationErrorCode": DURABLE_WORKFLOW_PAYLOAD_ERROR,
            },
            payload_size_bytes=payload_codec.size_bytes,
        )
    agent_cfg = context.get("agentConfig") or {}
    iteration = int(payload.get("iteration") or 0)
    session_id = str(context.get("sessionId") or "") or None
    scope = str(
        context.get("cancellationScopeId") or context.get("workflowInstanceId") or ""
    )
    turn_id = str(context.get("turnId") or "turn")

    name = str(call.get("toolName") or "")
    tool_call_id = str(call.get("toolCallId") or "")
    args = call.get("args") or {}
    args_error = str(call.get("argsError") or "").strip() or None
    response_ref = str(call.get("responseRef") or "").strip()
    if response_ref:
        try:
            raw_response = history_store.load_message(response_ref)
            response_message = load_messages([raw_response])[0]
            tool_index = int(call.get("toolIndex"))
            if not isinstance(response_message, ModelResponse):
                raise DurableHistoryIntegrityError(
                    "tool response reference does not contain a ModelResponse"
                )
            response_tool_parts = [
                candidate
                for candidate in response_message.parts
                if isinstance(candidate, ToolCallPart)
            ]
            if tool_index < 0 or tool_index >= len(response_tool_parts):
                raise DurableHistoryIntegrityError(
                    "tool index is outside the stored assistant response"
                )
            part = response_tool_parts[tool_index]
            name = part.tool_name
            tool_call_id = part.tool_call_id
            if call.get("isStructuredOutput") is True and name != (
                STRUCTURED_OUTPUT_TOOL_NAME
            ):
                raise DurableHistoryIntegrityError(
                    "structured-output locator does not match the stored tool call"
                )
            call_projection = _project_response_tool_calls(response_message)[tool_index]
            args = call_projection.get("args") or {}
            args_error = str(call_projection.get("argsError") or "").strip() or None
        except (TypeError, ValueError, DurableHistoryError) as exc:
            history_error = (
                exc
                if isinstance(exc, DurableHistoryError)
                else DurableHistoryIntegrityError(
                    "tool descriptor contains an invalid response locator"
                )
            )
            return _fit_small_activity_result(
                {
                    "toolSucceeded": False,
                    "configurationError": _transcript_error_detail(history_error),
                    "configurationErrorCode": _transcript_error_code(history_error),
                },
                payload_size_bytes=payload_codec.size_bytes,
            )
    defer_structured = bool(call.get("deferStructuredOutput"))
    logger.info(
        "[activity:%s] tool=%s id=%s iteration=%d scope=%s",
        EXECUTE_TOOL_ACTIVITY,
        name,
        tool_call_id,
        iteration,
        scope,
    )
    try:
        schema = configured_schema(agent_cfg)
    except StructuredOutputConfigError as exc:
        schema = None
        configuration_error = str(exc)
    else:
        configuration_error = None

    async def run() -> tuple[Any, str | None]:
        if configuration_error:
            result = f"Error: StructuredOutput configuration is invalid: {configuration_error}"
            return result, result
        if name == STRUCTURED_OUTPUT_TOOL_NAME and schema is not None:
            if defer_structured:
                result = (
                    "Error: StructuredOutput cannot be submitted in the same "
                    "response as coding tools. Review those tool results, then "
                    "call StructuredOutput again by itself."
                )
                return result, result
            valid, result = evaluate_call(schema, args, args_error=args_error)
            return result, None if valid else result

        if args_error:
            result = f"Tool {name} arguments {args_error}"
            return result, result

        router = get_router(agent_cfg)
        try:
            result = await router.call(name, args)
            # Capability after_tool_execute chain (OverflowingToolOutput
            # spills big results to <workspace>/.overflow and truncates the
            # in-history copy; the read_tool_result tool fetches the rest).
            # tool_def is passed None: the overflow hook keys on the tool
            # name (from `call`), so re-listing all toolsets — which would
            # hit MCP over the network a second time and can wedge the
            # durable activity — is neither needed nor safe here.
            try:
                from pydantic_ai.messages import ToolCallPart

                call_part = ToolCallPart(
                    tool_name=name, args=dict(args or {}), tool_call_id=tool_call_id
                )
                # OverflowingToolOutput serializes arbitrary values as JSON.
                # Applying it to BinaryContent would replace the pixels with a
                # text spill pointer before durable media externalization.
                if not tool_result_has_media(result):
                    result = await router.apply_after_tool_execute(
                        call=call_part,
                        tool_def=None,
                        args=dict(args or {}),
                        result=result,
                    )
            except Exception as exc:  # noqa: BLE001
                logger.warning(
                    "[execute-tool] after_tool_execute chain failed: %s", exc
                )
            return result, None
        except Exception as exc:  # noqa: BLE001
            logger.warning("[execute-tool] %s failed: %s", name, exc)
            return f"Tool {name} failed: {type(exc).__name__}: {exc}", str(exc)

    span_attrs = {
        **_span_base_attrs(context, iteration),
        # OpenInference TOOL contract (obs.tool_spans) + OTel GenAI conventions.
        "openinference.span.kind": "TOOL",
        "gen_ai.operation.name": "execute_tool",
        "gen_ai.tool.name": name,
        "tool.name": name,
        **({"gen_ai.tool.call.id": tool_call_id} if tool_call_id else {}),
    }
    event_args = _bounded_tool_event_args(args)

    def post_effect_persistence_failure() -> dict[str, Any]:
        detail = (
            f"Tool {name or 'tool'} completed, but its correlated result could not "
            "be persisted. The tool will not be retried automatically."
        )
        return _fit_small_activity_result(
            {
                "toolSucceeded": False,
                "toolErrorCode": TRANSCRIPT_PERSISTENCE_ERROR,
                "configurationError": detail,
                "configurationErrorCode": TRANSCRIPT_PERSISTENCE_ERROR,
            },
            payload_size_bytes=payload_codec.size_bytes,
        )

    try:
        with activity_span(f"execute_tool {name}", span_attrs) as span:
            if span is not None and content_capture_enabled():
                set_content_attr(span, "tool.arguments", event_args)

            if session_id:
                publish_session_event(
                    session_id,
                    "tool_call_start",
                    {
                        "toolName": name,
                        "args": event_args,
                        "tool_use_id": tool_call_id,
                    },
                    source_event_id=f"{scope}:{turn_id}:{tool_call_id}:start",
                    instance_id=scope,
                )

            result, error = asyncio.run(run())
            tool_error_code = None

            def correlated_failure(
                detail: str, code: str
            ) -> tuple[str, str, str, dict[str, Any], str]:
                failure_message = dump_messages(
                    [tool_return_message(name or "tool", tool_call_id, detail)]
                )[0]
                return detail, detail, detail, failure_message, code

            try:
                media = durable_media_port(WORKSPACE_ROOT)
                message = tool_return_message(name, tool_call_id, result)
                durable_message = asyncio.run(media.externalize([message]))[0]
                output = tool_result_display_text(result)
                _enforce_durable_tool_message_budget(durable_message)
            except OSError:
                return post_effect_persistence_failure()
            except ContextWindowBudgetError:
                detail = (
                    f"Tool {name or 'tool'} returned more data than Kimi model "
                    "history can retain. Request a narrower result or read it in "
                    "smaller chunks."
                )
                result, error, output, durable_message, tool_error_code = (
                    correlated_failure(detail, TOOL_RESULT_DURABLE_PAYLOAD_ERROR)
                )
            except _DETERMINISTIC_TOOL_RESULT_ERRORS:
                # Deterministic data-shape failures cannot heal on activity retry.
                # Keep the original call id and return a model-readable error.
                # A worker crash after an external side effect can still
                # duplicate that side effect on retry; tools remain at-least-once.
                detail = (
                    f"Tool {name or 'tool'} returned a value that cannot be "
                    "serialized into durable workflow history. Request "
                    "JSON-compatible output."
                )
                result, error, output, durable_message, tool_error_code = (
                    correlated_failure(detail, TOOL_RESULT_SERIALIZATION_ERROR)
                )

            if tool_error_code:
                try:
                    _enforce_durable_tool_message_budget(durable_message)
                except (ContextWindowBudgetError, *_DETERMINISTIC_TOOL_RESULT_ERRORS):
                    detail = (
                        "The tool result and its correlation metadata exceed the "
                        "retained model-history budget."
                    )
                    return _fit_small_activity_result(
                        {
                            "toolSucceeded": False,
                            "toolErrorCode": tool_error_code,
                            "configurationError": detail,
                            "configurationErrorCode": tool_error_code,
                        },
                        payload_size_bytes=payload_codec.size_bytes,
                    )
            try:
                message_ref = history_store.save_message(durable_message)
            except OSError:
                return post_effect_persistence_failure()
            except (
                DurableHistoryBudgetError,
                DurableHistorySerializationError,
                *_DETERMINISTIC_TOOL_RESULT_ERRORS,
            ) as exc:
                if isinstance(exc, DurableHistoryBudgetError):
                    detail = (
                        f"Tool {name or 'tool'} returned more data than Kimi model "
                        "history can retain. Request a narrower result or read it "
                        "in smaller chunks."
                    )
                    fallback_code = TOOL_RESULT_DURABLE_PAYLOAD_ERROR
                else:
                    detail = (
                        f"Tool {name or 'tool'} returned a value that cannot be "
                        "serialized into durable workflow history. Request "
                        "JSON-compatible output."
                    )
                    fallback_code = TOOL_RESULT_SERIALIZATION_ERROR
                result, error, output, durable_message, tool_error_code = (
                    correlated_failure(detail, fallback_code)
                )
                try:
                    _enforce_durable_tool_message_budget(durable_message)
                    message_ref = history_store.save_message(durable_message)
                except OSError:
                    return post_effect_persistence_failure()
                except (
                    ContextWindowBudgetError,
                    DurableHistoryError,
                    *_DETERMINISTIC_TOOL_RESULT_ERRORS,
                ) as fallback_exc:
                    fallback_detail = (
                        _transcript_error_detail(fallback_exc)
                        if isinstance(fallback_exc, DurableHistoryError)
                        else "The correlated tool failure exceeds model-history budget."
                    )
                    return _fit_small_activity_result(
                        {
                            "toolSucceeded": False,
                            "toolErrorCode": fallback_code,
                            "configurationError": fallback_detail,
                            "configurationErrorCode": fallback_code,
                        },
                        payload_size_bytes=payload_codec.size_bytes,
                    )
            except DurableHistoryError as exc:
                return _fit_small_activity_result(
                    {
                        "toolSucceeded": False,
                        "configurationError": _transcript_error_detail(exc),
                        "configurationErrorCode": _transcript_error_code(exc),
                    },
                    payload_size_bytes=payload_codec.size_bytes,
                )

            if span is not None:
                if content_capture_enabled():
                    set_content_attr(span, "tool.result", truncate(output))
                if error:
                    try:
                        from opentelemetry.trace import Status, StatusCode

                        span.set_status(Status(StatusCode.ERROR, error[:200]))
                        span.set_attribute("tool.error", error[:1000])
                    except Exception:  # noqa: BLE001
                        pass

            if session_id:
                publish_session_event(
                    session_id,
                    "tool_call_error" if error else "tool_call_end",
                    {
                        "toolName": name,
                        "tool_use_id": tool_call_id,
                        "output": truncate(output),
                        **({"error": truncate(error, 1000)} if error else {}),
                    },
                    source_event_id=f"{scope}:{turn_id}:{tool_call_id}:end",
                    instance_id=scope,
                )
    finally:
        flush_telemetry()

    structured_output_attempt = (
        name == STRUCTURED_OUTPUT_TOOL_NAME and schema is not None
    )
    structured_output = (
        result if name == STRUCTURED_OUTPUT_TOOL_NAME and error is None else None
    )
    if legacy_inline:
        return fit_execute_tool_activity_result(
            message=durable_message,
            tool_name=name,
            tool_call_id=tool_call_id,
            tool_error=error,
            structured_output_attempt=structured_output_attempt,
            structured_output=structured_output,
            payload_size_bytes=payload_codec.size_bytes,
            tool_error_code=tool_error_code,
        )
    return _fit_small_activity_result(
        {
            "messageRef": message_ref,
            "toolSucceeded": error is None,
            **({"toolErrorCode": tool_error_code} if tool_error_code else {}),
            "structuredOutputAttempt": structured_output_attempt,
            "structuredOutput": structured_output,
            **(
                {
                    "structuredOutputError": _truncate_utf8(
                        error, DURABLE_ERROR_MAX_BYTES
                    )
                }
                if structured_output_attempt and error
                else {}
            ),
        },
        payload_size_bytes=payload_codec.size_bytes,
    )


@_bounded_activity_failures(COMMIT_TOOL_RESULTS_ACTIVITY)
def commit_tool_results(ctx: wf.WorkflowActivityContext, payload: dict) -> dict:
    """Atomically advance a transcript from one assistant tool wave.

    Every referenced ToolReturnPart is validated against the exact final
    ModelResponse in ``historyRef`` before a new balanced history manifest is
    published. Deterministic reference/integrity failures are returned as
    terminal configuration errors; raw filesystem I/O remains retryable.
    """

    del ctx
    payload = payload or {}
    history_store = durable_history_port(WORKSPACE_ROOT)
    payload_codec = durable_payload_codec_port()
    try:
        history_ref = str(payload.get("historyRef") or "").strip()
        if not history_ref:
            raise DurableHistoryInvalidReferenceError(
                "commit_tool_results requires historyRef"
            )
        message_refs = [str(item) for item in payload.get("messageRefs") or []]
        if not message_refs:
            raise DurableHistoryIntegrityError(
                "tool result commit requires at least one message reference"
            )

        durable_history = history_store.load(history_ref)
        if not durable_history:
            raise DurableHistoryIntegrityError(
                "tool results do not follow a stored assistant response"
            )
        typed_history = load_messages(durable_history)
        response = typed_history[-1]
        if not isinstance(response, ModelResponse):
            raise DurableHistoryIntegrityError(
                "tool results do not follow a stored assistant response"
            )
        response_calls = [
            part for part in response.parts if isinstance(part, ToolCallPart)
        ]
        if len(response_calls) != len(message_refs):
            raise DurableHistoryIntegrityError(
                "stored assistant tool count does not match the commit request"
            )

        durable_returns = [
            history_store.load_message(message_ref) for message_ref in message_refs
        ]
        # Internal ImageUrl sentinels are valid Pydantic message content, so
        # correlation and compaction never need to read historical pixels.
        # The next model activity restores only the bounded request window.
        typed_returns = load_messages(durable_returns)
        correlated_return_parts: list[ToolReturnPart] = []
        user_return_parts: list[UserPromptPart] = []
        for return_message, tool_call in zip(
            typed_returns,
            response_calls,
            strict=True,
        ):
            if not isinstance(return_message, ModelRequest):
                raise DurableHistoryIntegrityError(
                    "tool result reference does not contain a ModelRequest"
                )
            return_parts = [
                part
                for part in return_message.parts
                if isinstance(part, ToolReturnPart)
            ]
            user_parts = [
                part
                for part in return_message.parts
                if isinstance(part, UserPromptPart)
            ]
            if (
                len(return_message.parts) != len(return_parts) + len(user_parts)
                or len(return_parts) != 1
                or return_parts[0].tool_name != tool_call.tool_name
                or return_parts[0].tool_call_id != tool_call.tool_call_id
            ):
                raise DurableHistoryIntegrityError(
                    "tool return does not match its stored assistant call"
                )
            correlated_return_parts.append(return_parts[0])
            user_return_parts.extend(user_parts)

        combined_return = ModelRequest(
            parts=[*correlated_return_parts, *user_return_parts]
        )
        merged = [*typed_history, combined_return]
        compacted = compact_kimi_history(
            merged,
            max_bytes=TRANSCRIPT_MAX_BYTES,
            keep_bytes=TRANSCRIPT_KEEP_BYTES,
        )
        media = durable_media_port(WORKSPACE_ROOT)
        durable_compacted = asyncio.run(
            media.externalize(compacted, preserve_references=True)
        )
        committed_ref = history_store.save(
            _compact_externalized_history(durable_compacted)
        )
        return _fit_small_activity_result(
            {"historyRef": committed_ref},
            payload_size_bytes=payload_codec.size_bytes,
        )
    except ContextWindowBudgetError:
        detail = (
            "The durable Kimi transcript cannot retain the current tool call/result "
            "wave within its configured context budget."
        )
        code = TRANSCRIPT_BUDGET_ERROR
    except DurableHistoryError as exc:
        detail = _transcript_error_detail(exc)
        code = _transcript_error_code(exc)
    except (PydanticSerializationError, TypeError, ValueError):
        detail = "The durable Kimi transcript contains invalid tool correlation data."
        code = TRANSCRIPT_INTEGRITY_ERROR

    return _fit_small_activity_result(
        {
            "configurationError": detail,
            "configurationErrorCode": code,
        },
        payload_size_bytes=payload_codec.size_bytes,
    )


# ---------------------------------------------------------------------------
# The workflow (deterministic orchestration only)
# ---------------------------------------------------------------------------


_AGENT_WORKFLOW_STATE_KEY = "agentWorkflowState"


def _workflow_rollover_state(wf_input: dict[str, Any]) -> tuple[int, int]:
    raw_state = wf_input.get(_AGENT_WORKFLOW_STATE_KEY)
    state = raw_state if isinstance(raw_state, dict) else {}
    try:
        iteration = max(0, int(state.get("iteration") or 0))
    except (TypeError, ValueError):
        iteration = 0
    try:
        structured_failures = max(0, int(state.get("structuredFailures") or 0))
    except (TypeError, ValueError):
        structured_failures = 0
    return iteration, structured_failures


def _build_agent_continue_as_new_input(
    *,
    context: dict[str, Any],
    history_ref: str,
    max_iterations: int,
    next_iteration: int,
    structured_failures: int,
    task: str | None,
) -> dict[str, Any]:
    next_input: dict[str, Any] = {
        "context": context,
        "historyRef": history_ref,
        "maxIterations": max_iterations,
        _AGENT_WORKFLOW_STATE_KEY: {
            "iteration": next_iteration,
            "structuredFailures": structured_failures,
        },
    }
    if task:
        next_input["task"] = task
    return next_input


def agent_workflow(ctx: wf.DaprWorkflowContext, wf_input: dict):
    """One agent turn: LLM messages and tool calls as separate activities.

    Normal input/output continuity is an opaque ``historyRef``. A legacy
    inline ``history`` can be imported once, but the real activity path
    switches to references after the first LLM activity.
    """
    wf_input = wf_input or {}
    payload_codec = durable_payload_codec_port()
    context = dict(wf_input.get("context") or {})
    context.setdefault("workflowInstanceId", ctx.instance_id)
    scope = str(context.get("cancellationScopeId") or ctx.instance_id)
    try:
        max_iterations = int(wf_input.get("maxIterations") or 0)
    except (TypeError, ValueError):
        max_iterations = 0
    if max_iterations <= 0:
        max_iterations = DEFAULT_MAX_ITERATIONS
    max_iterations = min(max_iterations, MAX_ITERATIONS_PER_TURN)
    iteration_offset, structured_failures = _workflow_rollover_state(wf_input)
    iteration_offset = min(iteration_offset, max_iterations)

    history_ref = str(wf_input.get("historyRef") or "").strip()
    messages: list[dict] = list(wf_input.get("history") or [])
    legacy_inline = "history" in wf_input and not history_ref
    balanced_history_ref = history_ref
    balanced_messages = list(messages)
    balanced_legacy_inline = legacy_inline
    task: str | None = str(wf_input.get("task") or "") or None
    final_text = ""
    iterations_used = iteration_offset

    def finish(result: dict[str, Any]) -> dict[str, Any]:
        return fit_workflow_terminal_result(
            result, payload_size_bytes=payload_codec.size_bytes
        )

    def durable_state(
        *, rollback: bool = False, history_ref_invalid: bool = False
    ) -> dict[str, Any]:
        if history_ref_invalid:
            return {"historyRefInvalid": True}
        state_ref = balanced_history_ref if rollback else history_ref
        if state_ref:
            return {"historyRef": state_ref}
        state_is_legacy = balanced_legacy_inline if rollback else legacy_inline
        if state_is_legacy:
            return {"messages": balanced_messages if rollback else messages}
        return {}

    def payload_failure(
        *, cancelled: bool = False, rollback: bool = False
    ) -> dict[str, Any]:
        result = _durable_workflow_payload_failure_result(
            iterations_used, cancelled=cancelled
        )
        state = durable_state(rollback=rollback)
        if "messages" not in state and state:
            result.pop("messages", None)
        result.update(state)
        return finish(result)

    def configuration_failure_result(
        *,
        feedback: str,
        code: str,
        rollback: bool = False,
        history_ref_invalid: bool = False,
    ) -> dict[str, Any]:
        state = durable_state(
            rollback=rollback, history_ref_invalid=history_ref_invalid
        )
        result = _configuration_failure_result(
            messages=list(state.get("messages") or []),
            iterations=iterations_used,
            feedback=feedback,
            code=code,
        )
        if "messages" not in state:
            result.pop("messages", None)
        result.update(state)
        return result

    def activity_retry_failure(
        activity_name: str, *, rollback: bool = False
    ) -> dict[str, Any]:
        return finish(
            configuration_failure_result(
                feedback=(
                    f"The {activity_name} activity exhausted its durable retry budget."
                ),
                code=ACTIVITY_RETRY_EXHAUSTED_ERROR,
                rollback=rollback,
            )
        )

    def structured_failure_result(
        *, feedback: str, code: str = STRUCTURED_OUTPUT_EXHAUSTED
    ) -> dict[str, Any]:
        result = _structured_failure_result(
            messages=messages if legacy_inline else [],
            iterations=iterations_used,
            attempts=structured_failures,
            feedback=feedback,
            code=code,
        )
        if not legacy_inline:
            result.pop("messages", None)
        result.update(durable_state())
        return result

    if _utf8_size(scope) > WORKFLOW_IDENTIFIER_MAX_BYTES:
        return finish(
            configuration_failure_result(
                feedback=(
                    "The cancellation scope exceeds the durable "
                    f"{WORKFLOW_IDENTIFIER_MAX_BYTES}-byte identifier limit."
                ),
                code=DURABLE_WORKFLOW_PAYLOAD_ERROR,
            )
        )

    if (
        payload_codec.size_bytes(context) > DURABLE_CONTEXT_MAX_BYTES
        or payload_codec.size_bytes(task or "") > DURABLE_TASK_MAX_BYTES
    ):
        return payload_failure()

    try:
        structured_schema = configured_schema(context.get("agentConfig") or {})
    except StructuredOutputConfigError as exc:
        return finish(
            structured_failure_result(
                feedback=str(exc), code=STRUCTURED_OUTPUT_CONFIG_ERROR
            )
        )
    for iteration in range(iteration_offset, max_iterations):
        if iteration - iteration_offset >= DURABLE_HISTORY_ITERATIONS_PER_SEGMENT:
            # This boundary is reached only after the previous LLM/tool wave is
            # fully committed. No activity, timer, or tool task is outstanding.
            if not history_ref or legacy_inline:
                return finish(
                    configuration_failure_result(
                        feedback=(
                            "The durable transcript did not provide a historyRef "
                            "required for workflow history rollover."
                        ),
                        code=TRANSCRIPT_INTEGRITY_ERROR,
                    )
                )
            ctx.continue_as_new(
                _build_agent_continue_as_new_input(
                    context=context,
                    history_ref=history_ref,
                    max_iterations=max_iterations,
                    next_iteration=iteration,
                    structured_failures=structured_failures,
                    task=task,
                ),
                save_events=False,
            )
            return
        try:
            cancellation_input = fit_workflow_activity_input(
                activity_name=CHECK_CANCELLATION_ACTIVITY,
                payload={"scopeId": scope},
                payload_size_bytes=payload_codec.size_bytes,
            )
        except DurableWorkflowPayloadError:
            return payload_failure()
        try:
            cancel = yield ctx.call_activity(
                check_cancellation,
                input=cancellation_input,
                retry_policy=RETRY_POLICY,
            )
        except wf.TaskFailedError:
            return activity_retry_failure(CHECK_CANCELLATION_ACTIVITY)
        if cancel and cancel.get("cancelled"):
            reason = str(cancel.get("reason") or "session cancelled")
            return finish(
                {
                    "role": "assistant",
                    "content": reason,
                    "success": False,
                    "cancelled": True,
                    "error": reason,
                    "stop_reason": cancel.get("stop_reason") or {"type": "terminated"},
                    "iterations": iterations_used,
                    **durable_state(),
                }
            )

        balanced_history_ref = history_ref
        balanced_messages = list(messages)
        balanced_legacy_inline = legacy_inline
        try:
            llm_state = (
                {"historyRef": history_ref}
                if history_ref
                else (
                    {
                        "messages": messages,
                        "migrateInlineHistory": True,
                    }
                    if legacy_inline
                    else {}
                )
            )
            llm_input = fit_workflow_activity_input(
                activity_name=CALL_LLM_ACTIVITY,
                payload={
                    "task": task,
                    **llm_state,
                    "context": context,
                    "iteration": iteration,
                },
                payload_size_bytes=payload_codec.size_bytes,
            )
        except DurableWorkflowPayloadError:
            return payload_failure()
        try:
            llm_out = yield ctx.call_activity(
                call_llm,
                input=llm_input,
                retry_policy=RETRY_POLICY,
            )
        except wf.TaskFailedError:
            return activity_retry_failure(CALL_LLM_ACTIVITY, rollback=True)
        task = None  # consumed by the bootstrap iteration
        next_history_ref = str(llm_out.get("historyRef") or "").strip()
        llm_returned_state = bool(next_history_ref or "messages" in llm_out)
        if next_history_ref:
            history_ref = next_history_ref
            messages = []
            legacy_inline = False
        elif "messages" in llm_out:
            messages = list(llm_out.get("messages") or [])
            legacy_inline = True
        iterations_used = iteration + 1
        configuration_error = str(llm_out.get("configurationError") or "").strip()
        if configuration_error:
            configuration_error_code = str(
                llm_out.get("configurationErrorCode") or STRUCTURED_OUTPUT_CONFIG_ERROR
            )
            if configuration_error_code == STRUCTURED_OUTPUT_CONFIG_ERROR:
                return finish(
                    structured_failure_result(
                        feedback=configuration_error,
                        code=configuration_error_code,
                    )
                )
            transcript_state_invalid = bool(llm_out.get("transcriptStateInvalid"))
            return finish(
                configuration_failure_result(
                    feedback=configuration_error,
                    code=configuration_error_code,
                    history_ref_invalid=transcript_state_invalid,
                )
            )
        if not llm_returned_state:
            return finish(
                configuration_failure_result(
                    feedback="The LLM activity did not return durable transcript state.",
                    code=TRANSCRIPT_INTEGRITY_ERROR,
                )
            )
        tool_calls = list(llm_out.get("toolCalls") or [])

        if not tool_calls:
            if structured_schema is not None:
                structured_failures += 1
                if structured_failures <= MAX_STRUCTURED_OUTPUT_NUDGES:
                    task = STRUCTURED_OUTPUT_NUDGE
                    continue
                return finish(
                    structured_failure_result(
                        feedback=(
                            "Kimi repeatedly finished without calling the required "
                            "StructuredOutput tool."
                        ),
                    )
                )
            final_text = str(llm_out.get("text") or "")
            break

        output_calls = (
            [call for call in tool_calls if call.get("isStructuredOutput") is True]
            if structured_schema is not None
            else []
        )
        normal_calls = [
            call for call in tool_calls if call.get("isStructuredOutput") is not True
        ]
        if len(output_calls) > 1:
            return finish(
                configuration_failure_result(
                    feedback=(
                        "Kimi K3 returned more than one StructuredOutput call in "
                        "a single response."
                    ),
                    code=MODEL_TOOL_CALL_LIMIT_ERROR,
                    rollback=True,
                )
            )

        # A result generated before co-emitted coding tools have run cannot be
        # trusted. Execute every call so Kimi receives a matching tool result,
        # but defer StructuredOutput and require it alone on the next turn.
        mixed_turn = bool(output_calls and normal_calls)
        calls_to_execute = []
        for call in tool_calls:
            if mixed_turn and call in output_calls:
                calls_to_execute.append({**call, "deferStructuredOutput": True})
            else:
                calls_to_execute.append(call)
        # Preflight every call before scheduling any activity. A later invalid
        # call must not leave an earlier task partially scheduled in history.
        try:
            prepared_calls = []
            for call in calls_to_execute:
                tool_context = _tool_activity_context(context, call)
                context_limit = (
                    DURABLE_CONTEXT_MAX_BYTES
                    if structured_schema is not None
                    and call.get("isStructuredOutput") is True
                    else DURABLE_TOOL_CONTEXT_MAX_BYTES
                )
                if payload_codec.size_bytes(tool_context) > context_limit:
                    raise DurableWorkflowPayloadError(
                        "The private tool context exceeds its durable workflow budget."
                    )
                prepared_calls.append(
                    (
                        call,
                        fit_execute_tool_activity_input(
                            call=call,
                            context=tool_context,
                            iteration=iteration,
                            payload_size_bytes=payload_codec.size_bytes,
                        ),
                    )
                )
            segments: list[tuple[str, list[dict[str, Any]]]] = []
            parallel_payloads: list[dict[str, Any]] = []
            for call, payload in prepared_calls:
                if call.get("sequential"):
                    if parallel_payloads:
                        segments.append(("parallel", parallel_payloads))
                        parallel_payloads = []
                    segments.append(("sequential", [payload]))
                else:
                    parallel_payloads.append(payload)
            if parallel_payloads:
                segments.append(("parallel", parallel_payloads))

            execution_plan: list[tuple[str, list[dict[str, Any]]]] = []
            for mode, payloads in segments:
                if mode == "sequential":
                    execution_plan.append((mode, payloads))
                    continue
                execution_plan.extend(
                    (mode, batch)
                    for batch in split_workflow_activity_batches(
                        payloads, payload_size_bytes=payload_codec.size_bytes
                    )
                )
        except (DurableWorkflowPayloadError, PydanticSerializationError, TypeError):
            return payload_failure(rollback=True)

        # Each execute_tool activity owns an asyncio.run() loop. A stateful
        # MCPToolset/FastMCP client cannot be shared by concurrent activity
        # loops, so MCP calls remain ordered barriers. Adjacent local calls use
        # their existing when_all fan-out, split only when aggregate inputs need
        # more than one durable workflow response.
        tool_results = []
        for mode, payloads in execution_plan:
            if mode == "sequential":
                try:
                    result = yield ctx.call_activity(
                        execute_tool,
                        input=payloads[0],
                        retry_policy=RETRY_POLICY,
                    )
                except wf.TaskFailedError:
                    return activity_retry_failure(EXECUTE_TOOL_ACTIVITY, rollback=True)
                tool_results.append(result)
                continue
            parallel_tasks = [
                ctx.call_activity(
                    execute_tool,
                    input=payload,
                    retry_policy=RETRY_POLICY,
                )
                for payload in payloads
            ]
            try:
                tool_results.extend((yield wf.when_all(parallel_tasks)))
            except wf.TaskFailedError:
                return activity_retry_failure(EXECUTE_TOOL_ACTIVITY, rollback=True)
        structured_final = None
        structured_errors: list[str] = []
        message_refs: list[str] = []
        for result in tool_results:
            configuration_error = str(
                (result or {}).get("configurationError") or ""
            ).strip()
            if configuration_error:
                # The current assistant response contains an unmatched call if
                # no correlated return can be represented. Never expose that
                # history for a future K3 request.
                return finish(
                    configuration_failure_result(
                        feedback=configuration_error,
                        code=str(
                            (result or {}).get("configurationErrorCode")
                            or TOOL_RESULT_DURABLE_PAYLOAD_ERROR
                        ),
                        rollback=True,
                    )
                )
            message_ref = str((result or {}).get("messageRef") or "").strip()
            if message_ref:
                message_refs.append(message_ref)
            message = (result or {}).get("message")
            if message:
                messages.append(message)
            candidate = (result or {}).get("structuredOutput")
            if structured_final is None and isinstance(candidate, str) and candidate:
                structured_final = candidate
            elif (result or {}).get("structuredOutputAttempt"):
                structured_errors.append(
                    _truncate_utf8(
                        (result or {}).get("toolError")
                        or (result or {}).get("structuredOutputError")
                        or "StructuredOutput validation failed.",
                        DURABLE_ERROR_MAX_BYTES,
                    )
                )

        if history_ref:
            if len(message_refs) != len(calls_to_execute):
                return finish(
                    configuration_failure_result(
                        feedback=(
                            "A tool activity did not return a durable correlated "
                            "message reference."
                        ),
                        code=TRANSCRIPT_INTEGRITY_ERROR,
                        rollback=True,
                    )
                )
            try:
                commit_input = fit_workflow_activity_input(
                    activity_name=COMMIT_TOOL_RESULTS_ACTIVITY,
                    payload={
                        "historyRef": history_ref,
                        "messageRefs": message_refs,
                    },
                    payload_size_bytes=payload_codec.size_bytes,
                )
            except DurableWorkflowPayloadError:
                return payload_failure(rollback=True)
            try:
                commit_out = yield ctx.call_activity(
                    commit_tool_results,
                    input=commit_input,
                    retry_policy=RETRY_POLICY,
                )
            except wf.TaskFailedError:
                return activity_retry_failure(
                    COMMIT_TOOL_RESULTS_ACTIVITY, rollback=True
                )
            commit_error = str(
                (commit_out or {}).get("configurationError") or ""
            ).strip()
            committed_ref = str((commit_out or {}).get("historyRef") or "").strip()
            if commit_error or not committed_ref:
                return finish(
                    configuration_failure_result(
                        feedback=commit_error
                        or "The durable tool-result commit did not return historyRef.",
                        code=str(
                            (commit_out or {}).get("configurationErrorCode")
                            or TRANSCRIPT_INTEGRITY_ERROR
                        ),
                        rollback=True,
                    )
                )
            history_ref = committed_ref
        elif not legacy_inline:
            return finish(
                configuration_failure_result(
                    feedback="The LLM activity did not return a durable historyRef.",
                    code=TRANSCRIPT_INTEGRITY_ERROR,
                    rollback=True,
                )
            )
        balanced_history_ref = history_ref
        balanced_messages = list(messages)
        balanced_legacy_inline = legacy_inline
        if structured_final is not None:
            final_text = structured_final
            break
        if output_calls:
            structured_failures += len(output_calls)
            if structured_failures > MAX_STRUCTURED_OUTPUT_NUDGES:
                return finish(
                    structured_failure_result(
                        feedback=(
                            structured_errors[-1]
                            if structured_errors
                            else "StructuredOutput finalization failed."
                        ),
                    )
                )
    else:
        final_text = (
            f"Stopped after reaching the {max_iterations}-iteration budget "
            "without a final answer."
        )
        if structured_schema is not None:
            return finish(structured_failure_result(feedback=final_text))
        return finish(
            {
                "role": "assistant",
                "content": final_text,
                "success": False,
                "iterations": iterations_used,
                **durable_state(),
            }
        )

    if _utf8_size(final_text) > TERMINAL_CONTENT_MAX_BYTES:
        return finish(
            configuration_failure_result(
                feedback=(
                    "The final agent content exceeds the durable "
                    f"{TERMINAL_CONTENT_MAX_BYTES}-byte terminal-content limit."
                ),
                code=MODEL_TERMINAL_CONTENT_LIMIT_ERROR,
            )
        )

    return finish(
        {
            "role": "assistant",
            "content": final_text,
            "success": True,
            "iterations": iterations_used,
            **durable_state(),
        }
    )

"""The durable agent loop: one workflow, three activities.

Diagrid python-ai pattern (diagrid/agent/pydantic_ai/workflow.py): the
workflow yields a ``call_llm`` activity per LLM message; tool calls fan out
as one ``execute_tool`` activity each via ``when_all``; the full message
history crosses every boundary as serialized JSON. Unlike Diagrid's raw
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
from datetime import timedelta
from typing import Any

import dapr.ext.workflow as wf

from src.config import (
    AGENT_STATE_STORE,
    DEFAULT_MAX_ITERATIONS,
    KIMI_BASE_URL,
    KIMI_DEFAULT_MODEL,
    MEDIA_HISTORY_MAX_IMAGES,
    MEDIA_REQUEST_MAX_BYTES,
    MEDIA_REQUEST_MAX_IMAGES,
    KIMI_TIMEOUT_SECONDS,
    WORKSPACE_ROOT,
)
from src.composition import durable_media_port
from src.event_publisher import publish_session_event
from src.messages_io import (
    bootstrap_request,
    messages_have_media,
    openinference_messages,
    response_text,
    response_tool_calls,
    sanitize_invalid_tool_call_args,
    tool_return_message,
    tool_result_display_text,
    tool_result_has_media,
    truncate,
    user_request,
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

STRUCTURED_OUTPUT_EXHAUSTED = "error_max_structured_output_retries"
STRUCTURED_OUTPUT_CONFIG_ERROR = "structured_output_config_error"


def _structured_failure_result(
    *,
    messages: list[dict],
    iterations: int,
    attempts: int,
    feedback: str,
    code: str = STRUCTURED_OUTPUT_EXHAUSTED,
) -> dict[str, Any]:
    detail = str(feedback or "Structured output was not produced.")[:2000]
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
    return OpenAIChatModel(
        KIMI_DEFAULT_MODEL,
        provider=OpenAIProvider(base_url=KIMI_BASE_URL, api_key=api_key),
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
        timeout=float(KIMI_TIMEOUT_SECONDS),
        extra_body={"reasoning_effort": "max"},
    )


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


def check_cancellation(ctx: wf.WorkflowActivityContext, payload: dict) -> dict:
    scope = str((payload or {}).get("scopeId") or "")
    request = read_cancellation_request(scope) if scope else None
    if not request:
        return {"cancelled": False}
    stop_reason = terminal_stop_reason_from_events([request]) or {"type": "terminated"}
    reason = str(
        request.get("reason") or stop_reason.get("reason") or "session cancelled"
    )
    return {"cancelled": True, "reason": reason, "stop_reason": stop_reason}


def call_llm(ctx: wf.WorkflowActivityContext, payload: dict) -> dict:
    """One LLM message as one durable activity.

    Input: {"task"?: str, "messages": [...serialized...], "context": {...},
            "iteration": int}
    On iteration 0 with a task, the message list is bootstrapped here
    (system prompt = agentConfig.systemPrompt + capability instructions) so
    the workflow body stays deterministic/pure.
    """
    payload = payload or {}
    context = payload.get("context") or {}
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
        restored = await media.restore(
            payload.get("messages") or [],
            max_media_items=MEDIA_HISTORY_MAX_IMAGES,
            max_request_images=MEDIA_REQUEST_MAX_IMAGES,
            max_request_bytes=MEDIA_REQUEST_MAX_BYTES,
        )
        messages = restored
        task = str(payload.get("task") or "")
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
            durable_messages = await media.externalize(messages)
            return {
                "messages": durable_messages,
                "toolCalls": [],
                "text": "",
                "configurationError": str(exc),
            }
        function_tools = await router.tool_defs()
        if schema and any(
            tool.name == STRUCTURED_OUTPUT_TOOL_NAME for tool in function_tools
        ):
            durable_messages = await media.externalize(messages)
            return {
                "messages": durable_messages,
                "toolCalls": [],
                "text": "",
                "configurationError": (
                    "A configured harness or MCP tool collides with the reserved "
                    "StructuredOutput tool name."
                ),
            }
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
        model = instrument_model(
            build_model(),
            include_content=not messages_have_media(messages),
        )
        request_context = ModelRequestContext(
            model=model,
            messages=messages,
            model_settings=build_model_settings(),
            model_request_parameters=params,
        )
        # Capability hook chain, hosted inside this durable activity:
        # before_model_request (clamp → sliding-window compaction) transforms
        # the DURABLE history — whatever the model sees is what this activity
        # returns, so replay stays consistent and history stays bounded.
        request_context = await router.apply_before_model_request(request_context)

        async def base_handler(rc):
            return await model.request(
                rc.messages, rc.model_settings, rc.model_request_parameters
            )

        response = await router.apply_model_request(request_context, base_handler)
        response = await router.apply_after_model_request(request_context, response)
        input_messages = list(request_context.messages)
        text = response_text(response)
        tool_calls = response_tool_calls(response)
        invalid_call_ids: set[str] = set()
        for call in tool_calls:
            if (
                call.get("toolName") == STRUCTURED_OUTPUT_TOOL_NAME
                and int(call.get("argsSizeBytes") or 0) > STRUCTURED_OUTPUT_MAX_BYTES
            ):
                call["args"] = {}
                call["argsError"] = (
                    f"were {int(call['argsSizeBytes'])} UTF-8 bytes; the maximum "
                    f"is {STRUCTURED_OUTPUT_MAX_BYTES}. Return a smaller object."
                )
            if call.get("argsError"):
                invalid_call_ids.add(str(call.get("toolCallId") or ""))
        response = sanitize_invalid_tool_call_args(response, invalid_call_ids)
        messages = list(request_context.messages)
        messages.append(response)
        durable_messages = await media.externalize(messages)
        usage = response.usage

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

        return {
            "messages": durable_messages,
            "toolCalls": tool_calls,
            "text": text,
        }

    try:
        with activity_span("call_llm", _span_base_attrs(context, iteration)) as span:
            return asyncio.run(run(span))
    finally:
        # Per-session pods are reaped at session end — flush per activity so
        # a reap between batch-export ticks loses nothing.
        flush_telemetry()


def execute_tool(ctx: wf.WorkflowActivityContext, payload: dict) -> dict:
    """One tool call as one durable activity.

    Input: {"call": {toolName, toolCallId, args}, "context": {...},
            "iteration": int}
    Returns a serialized ModelRequest carrying the single ToolReturnPart.
    """
    payload = payload or {}
    call = payload.get("call") or {}
    context = payload.get("context") or {}
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
    try:
        with activity_span(f"execute_tool {name}", span_attrs) as span:
            if span is not None and content_capture_enabled():
                set_content_attr(span, "tool.arguments", dict(args or {}))

            if session_id:
                publish_session_event(
                    session_id,
                    "tool_call_start",
                    {"toolName": name, "args": args, "tool_use_id": tool_call_id},
                    source_event_id=f"{scope}:{turn_id}:{tool_call_id}:start",
                    instance_id=scope,
                )

            result, error = asyncio.run(run())
            output = tool_result_display_text(result)

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

    message = tool_return_message(name, tool_call_id, result)
    media = durable_media_port(WORKSPACE_ROOT)
    durable_message = asyncio.run(media.externalize([message]))[0]
    return {
        "message": durable_message,
        "toolSucceeded": error is None,
        "toolError": error,
        "structuredOutputAttempt": (
            name == STRUCTURED_OUTPUT_TOOL_NAME and schema is not None
        ),
        "structuredOutput": (
            result if name == STRUCTURED_OUTPUT_TOOL_NAME and error is None else None
        ),
    }


# ---------------------------------------------------------------------------
# The workflow (deterministic orchestration only)
# ---------------------------------------------------------------------------


def agent_workflow(ctx: wf.DaprWorkflowContext, wf_input: dict):
    """One agent turn: LLM messages and tool calls as separate activities.

    Input: {"task": str, "history": [...serialized...]?, "context": {...},
            "maxIterations": int?}
    Output: {"role", "content", "success", "iterations", "messages",
             "cancelled"?, "stop_reason"?}
    """
    wf_input = wf_input or {}
    context = dict(wf_input.get("context") or {})
    context.setdefault("workflowInstanceId", ctx.instance_id)
    scope = str(context.get("cancellationScopeId") or ctx.instance_id)
    try:
        max_iterations = int(wf_input.get("maxIterations") or 0)
    except (TypeError, ValueError):
        max_iterations = 0
    if max_iterations <= 0:
        max_iterations = DEFAULT_MAX_ITERATIONS

    messages: list[dict] = list(wf_input.get("history") or [])
    task: str | None = str(wf_input.get("task") or "") or None
    final_text = ""
    iterations_used = 0
    try:
        structured_schema = configured_schema(context.get("agentConfig") or {})
    except StructuredOutputConfigError as exc:
        return _structured_failure_result(
            messages=messages,
            iterations=0,
            attempts=0,
            feedback=str(exc),
            code=STRUCTURED_OUTPUT_CONFIG_ERROR,
        )
    structured_failures = 0

    for iteration in range(max_iterations):
        cancel = yield ctx.call_activity(
            check_cancellation,
            input={"scopeId": scope},
            retry_policy=RETRY_POLICY,
        )
        if cancel and cancel.get("cancelled"):
            reason = str(cancel.get("reason") or "session cancelled")
            return {
                "role": "assistant",
                "content": reason,
                "success": False,
                "cancelled": True,
                "error": reason,
                "stop_reason": cancel.get("stop_reason") or {"type": "terminated"},
                "iterations": iterations_used,
                "messages": messages,
            }

        llm_out = yield ctx.call_activity(
            call_llm,
            input={
                "task": task,
                "messages": messages,
                "context": context,
                "iteration": iteration,
            },
            retry_policy=RETRY_POLICY,
        )
        task = None  # consumed by the bootstrap iteration
        messages = list(llm_out.get("messages") or [])
        iterations_used = iteration + 1
        configuration_error = str(llm_out.get("configurationError") or "").strip()
        if configuration_error:
            return _structured_failure_result(
                messages=messages,
                iterations=iterations_used,
                attempts=structured_failures,
                feedback=configuration_error,
                code=STRUCTURED_OUTPUT_CONFIG_ERROR,
            )
        tool_calls = list(llm_out.get("toolCalls") or [])

        if not tool_calls:
            if structured_schema is not None:
                structured_failures += 1
                if structured_failures <= MAX_STRUCTURED_OUTPUT_NUDGES:
                    task = STRUCTURED_OUTPUT_NUDGE
                    continue
                return _structured_failure_result(
                    messages=messages,
                    iterations=iterations_used,
                    attempts=structured_failures,
                    feedback=(
                        "Kimi repeatedly finished without calling the required "
                        "StructuredOutput tool."
                    ),
                )
            final_text = str(llm_out.get("text") or "")
            break

        output_calls = (
            [
                call
                for call in tool_calls
                if call.get("toolName") == STRUCTURED_OUTPUT_TOOL_NAME
            ]
            if structured_schema is not None
            else []
        )
        normal_calls = [
            call
            for call in tool_calls
            if call.get("toolName") != STRUCTURED_OUTPUT_TOOL_NAME
        ]

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
        tool_tasks = [
            ctx.call_activity(
                execute_tool,
                input={"call": call, "context": context, "iteration": iteration},
                retry_policy=RETRY_POLICY,
            )
            for call in calls_to_execute
        ]
        tool_results = yield wf.when_all(tool_tasks)
        structured_final = None
        structured_errors: list[str] = []
        for result in tool_results:
            message = (result or {}).get("message")
            if message:
                messages.append(message)
            candidate = (result or {}).get("structuredOutput")
            if structured_final is None and isinstance(candidate, str) and candidate:
                structured_final = candidate
            elif (result or {}).get("structuredOutputAttempt"):
                structured_errors.append(
                    str(
                        (result or {}).get("toolError")
                        or "StructuredOutput validation failed."
                    )[:2000]
                )
        if structured_final is not None:
            final_text = structured_final
            break
        if output_calls:
            structured_failures += len(output_calls)
            if structured_failures > MAX_STRUCTURED_OUTPUT_NUDGES:
                return _structured_failure_result(
                    messages=messages,
                    iterations=iterations_used,
                    attempts=structured_failures,
                    feedback=(
                        structured_errors[-1]
                        if structured_errors
                        else "StructuredOutput finalization failed."
                    ),
                )
    else:
        final_text = (
            f"Stopped after reaching the {max_iterations}-iteration budget "
            "without a final answer."
        )
        if structured_schema is not None:
            return _structured_failure_result(
                messages=messages,
                iterations=iterations_used,
                attempts=structured_failures,
                feedback=final_text,
            )
        return {
            "role": "assistant",
            "content": final_text,
            "success": False,
            "iterations": iterations_used,
            "messages": messages,
        }

    return {
        "role": "assistant",
        "content": final_text,
        "success": True,
        "iterations": iterations_used,
        "messages": messages,
    }

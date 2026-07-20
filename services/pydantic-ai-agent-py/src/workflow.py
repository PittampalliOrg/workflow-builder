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
    KIMI_TIMEOUT_SECONDS,
)
from src.event_publisher import publish_session_event
from src.messages_io import (
    bootstrap_request,
    dump_messages,
    load_messages,
    response_text,
    response_tool_calls,
    tool_return_message,
    truncate,
    user_request,
)
from src.session_native import terminal_stop_reason_from_events
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
    )


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


# ---------------------------------------------------------------------------
# Activities
# ---------------------------------------------------------------------------


def check_cancellation(ctx: wf.WorkflowActivityContext, payload: dict) -> dict:
    scope = str((payload or {}).get("scopeId") or "")
    request = read_cancellation_request(scope) if scope else None
    if not request:
        return {"cancelled": False}
    stop_reason = terminal_stop_reason_from_events([request]) or {"type": "terminated"}
    reason = str(request.get("reason") or stop_reason.get("reason") or "session cancelled")
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
    scope = str(context.get("cancellationScopeId") or context.get("workflowInstanceId") or "")
    turn_id = str(context.get("turnId") or "turn")
    logger.info(
        "[activity:%s] iteration=%d scope=%s", CALL_LLM_ACTIVITY, iteration, scope
    )

    async def run() -> dict:
        router = get_router(agent_cfg)
        messages = load_messages(payload.get("messages"))
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

        params = ModelRequestParameters(
            function_tools=await router.tool_defs(),
            allow_text_output=True,
        )
        model = build_model()
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
        messages = list(request_context.messages)
        messages.append(response)

        text = response_text(response)
        tool_calls = response_tool_calls(response)
        usage = response.usage

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
            "messages": dump_messages(messages),
            "toolCalls": tool_calls,
            "text": text,
        }

    return asyncio.run(run())


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
    scope = str(context.get("cancellationScopeId") or context.get("workflowInstanceId") or "")
    turn_id = str(context.get("turnId") or "turn")

    name = str(call.get("toolName") or "")
    tool_call_id = str(call.get("toolCallId") or "")
    args = call.get("args") or {}
    logger.info(
        "[activity:%s] tool=%s id=%s iteration=%d scope=%s",
        EXECUTE_TOOL_ACTIVITY,
        name,
        tool_call_id,
        iteration,
        scope,
    )

    if session_id:
        publish_session_event(
            session_id,
            "tool_call_start",
            {"toolName": name, "args": args, "tool_use_id": tool_call_id},
            source_event_id=f"{scope}:{turn_id}:{tool_call_id}:start",
            instance_id=scope,
        )

    async def run() -> tuple[str, str | None]:
        router = get_router(agent_cfg)
        try:
            result = await router.call(name, args)
            # Capability after_tool_execute chain (OverflowingToolOutput
            # spills big results to <workspace>/.overflow and truncates the
            # in-history copy; the read_tool_result tool fetches the rest).
            try:
                from pydantic_ai.messages import ToolCallPart

                tools = await router.tools()
                tool_def = tools[name][1].tool_def if name in tools else None
                call_part = ToolCallPart(
                    tool_name=name, args=dict(args or {}), tool_call_id=tool_call_id
                )
                result = await router.apply_after_tool_execute(
                    call=call_part, tool_def=tool_def, args=dict(args or {}), result=result
                )
            except Exception as exc:  # noqa: BLE001
                logger.warning("[execute-tool] after_tool_execute chain failed: %s", exc)
            return (result if isinstance(result, str) else str(result)), None
        except Exception as exc:  # noqa: BLE001
            logger.warning("[execute-tool] %s failed: %s", name, exc)
            return f"Tool {name} failed: {type(exc).__name__}: {exc}", str(exc)

    output, error = asyncio.run(run())

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

    message = tool_return_message(name, tool_call_id, output)
    return {"message": dump_messages([message])[0]}


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
        tool_calls = list(llm_out.get("toolCalls") or [])

        if not tool_calls:
            final_text = str(llm_out.get("text") or "")
            break

        tool_tasks = [
            ctx.call_activity(
                execute_tool,
                input={"call": call, "context": context, "iteration": iteration},
                retry_policy=RETRY_POLICY,
            )
            for call in tool_calls
        ]
        tool_results = yield wf.when_all(tool_tasks)
        for result in tool_results:
            message = (result or {}).get("message")
            if message:
                messages.append(message)
    else:
        final_text = (
            f"Stopped after reaching the {max_iterations}-iteration budget "
            "without a final answer."
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

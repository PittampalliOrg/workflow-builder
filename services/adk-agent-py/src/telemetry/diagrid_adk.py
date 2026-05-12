"""Workflow Builder telemetry patch for Diagrid's ADK durable bridge.

Diagrid's ADK runner emits durable activity spans, but those spans do not carry
the MLflow/OpenInference attributes that the workflow UI and MLflow collector
use to classify LLM/tool work. Patch the registered workflow and activities so
each LLM and tool activity gets the same typed span shape as dapr-agent-py.
"""

from __future__ import annotations

import json
import logging
from datetime import timedelta
from time import perf_counter
from typing import Any, Generator, Mapping

from src.telemetry.genai_attrs import (
    get_current_span,
    set_activity_attrs,
    set_genai_request_attrs,
    set_genai_response_attrs,
)

logger = logging.getLogger(__name__)

_PATCHED = False
_MAX_ATTR_CHARS = 20_000


def _json_attr(value: Any) -> str:
    try:
        text = json.dumps(value, default=str, ensure_ascii=False)
    except Exception:
        text = str(value)
    if len(text) > _MAX_ATTR_CHARS:
        return text[:_MAX_ATTR_CHARS] + "...<truncated>"
    return text


def _clean_string(value: Any) -> str | None:
    if value is None:
        return None
    text = str(value).strip()
    return text or None


def _int_or_none(value: Any) -> int | None:
    if value is None or isinstance(value, bool):
        return None
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def _telemetry_context(input_data: Mapping[str, Any]) -> dict[str, Any]:
    value = input_data.get("_telemetry_context")
    return dict(value) if isinstance(value, Mapping) else {}


def _base_attrs(ctx: Mapping[str, Any]) -> dict[str, Any]:
    attrs: dict[str, Any] = {}
    for key in (
        "workflow.id",
        "workflow.execution.id",
        "workflow.node.id",
        "workflow.node.name",
        "workflow.node.type",
        "workflow.node.action_type",
        "workflow.node.sequence",
        "session.id",
        "agent.id",
        "agent.version",
        "agent.slug",
        "agent.app_id",
        "sandbox.name",
        "sandbox.workspace_ref",
        "sandbox.cwd",
        "dapr.component",
    ):
        value = ctx.get(key)
        if value is not None and str(value).strip():
            attrs[key] = value
    return attrs


def _stamp_current_activity(
    ctx: Mapping[str, Any],
    *,
    activity: str,
    mlflow_span_type: str | None = None,
) -> Any | None:
    span = get_current_span()
    if span is None:
        return None
    set_activity_attrs(
        span,
        workflow_id=_clean_string(ctx.get("workflow.id")),
        workflow_execution_id=_clean_string(ctx.get("workflow.execution.id")),
        workflow_instance_id=_clean_string(ctx.get("workflow.instance_id")),
        session_id=_clean_string(ctx.get("session.id")),
        agent_id=_clean_string(ctx.get("agent.id")),
        agent_version=ctx.get("agent.version"),
        agent_slug=_clean_string(ctx.get("agent.slug")),
        agent_app_id=_clean_string(ctx.get("agent.app_id")),
        component=_clean_string(ctx.get("dapr.component")),
        iteration=_int_or_none(ctx.get("agent.iteration")),
        mlflow_span_type=mlflow_span_type,
        extra={
            "workflow.activity": activity,
            "workflow.node.id": ctx.get("workflow.node.id"),
            "workflow.node.name": ctx.get("workflow.node.name"),
            "workflow.node.type": ctx.get("workflow.node.type"),
            "workflow.node.action_type": ctx.get("workflow.node.action_type"),
            "workflow.node.sequence": ctx.get("workflow.node.sequence"),
            "sandbox.name": ctx.get("sandbox.name"),
            "sandbox.workspace_ref": ctx.get("sandbox.workspace_ref"),
            "sandbox.cwd": ctx.get("sandbox.cwd"),
        },
    )
    return span


def _llm_output_stats(output: Mapping[str, Any]) -> tuple[str | None, int, int]:
    message = output.get("message")
    if not isinstance(message, Mapping):
        return None, 0, 0
    content = _clean_string(message.get("content"))
    tool_calls = message.get("tool_calls")
    tool_call_count = len(tool_calls) if isinstance(tool_calls, list) else 0
    return content, tool_call_count, len(content or "")


def _patch_workflow_module(module: Any) -> None:
    original_call_llm_activity = module.call_llm_activity
    original_execute_tool_activity = module.execute_tool_activity

    def call_llm_activity(ctx: Any, input_data: dict[str, Any]) -> dict[str, Any]:
        tel = _telemetry_context(input_data)
        agent_config = input_data.get("agent_config") or {}
        model = _clean_string(agent_config.get("model"))
        provider = _clean_string(agent_config.get("provider")) or "gemini"
        component = _clean_string(agent_config.get("component_name")) or _clean_string(
            tel.get("dapr.component")
        )
        tel.setdefault("dapr.component", component or f"llm-{provider}")

        span = _stamp_current_activity(
            tel,
            activity="call_llm_activity",
            mlflow_span_type="CHAT_MODEL",
        )
        start = perf_counter()
        if span is not None:
            for key, value in {
                **_base_attrs(tel),
                "openinference.span.kind": "LLM",
                "gen_ai.operation.name": "chat",
                "input.mime_type": "application/json",
                "input.value": _json_attr(input_data),
            }.items():
                if value is not None and value != "":
                    span.set_attribute(key, value)
            set_genai_request_attrs(
                span,
                system=provider,
                request_model=model,
                tools_count=len(agent_config.get("tool_definitions") or []),
                streaming=False,
                extra={"dapr.component": tel.get("dapr.component")},
            )
        try:
            output = original_call_llm_activity(ctx, input_data)
            if span is not None:
                content, tool_call_count, output_chars = _llm_output_stats(output)
                set_genai_response_attrs(
                    span,
                    response_model=model,
                    duration_ms=(perf_counter() - start) * 1000,
                    tool_calls_count=tool_call_count,
                    output_chars=output_chars,
                    finish_reason="tool_calls" if tool_call_count else "stop",
                )
                span.set_attribute("output.mime_type", "application/json")
                span.set_attribute("output.value", _json_attr(output))
                if content is not None:
                    span.set_attribute("gen_ai.response.content.chars", len(content))
            return output
        except Exception as exc:
            if span is not None:
                span.set_attribute("error", True)
                span.record_exception(exc)
            raise

    def execute_tool_activity(ctx: Any, input_data: dict[str, Any]) -> dict[str, Any]:
        tel = _telemetry_context(input_data)
        tool_call = input_data.get("tool_call") or {}
        tool_name = _clean_string(tool_call.get("name")) or "unknown"
        args = tool_call.get("args") if isinstance(tool_call, Mapping) else None

        span = _stamp_current_activity(
            tel,
            activity="execute_tool_activity",
            mlflow_span_type="TOOL",
        )
        if span is not None:
            attrs = {
                **_base_attrs(tel),
                "openinference.span.kind": "TOOL",
                "gen_ai.operation.name": "execute_tool",
                "gen_ai.tool.name": tool_name,
                "tool.name": tool_name,
                "tool.call_id": tool_call.get("id") if isinstance(tool_call, Mapping) else None,
                "input.mime_type": "application/json",
                "input.value": _json_attr(input_data),
            }
            if isinstance(args, Mapping):
                attrs["tool.args.keys"] = ",".join(str(k) for k in sorted(args.keys()))
                attrs["tool.args.size_chars"] = len(_json_attr(args))
            for key, value in attrs.items():
                if value is not None and value != "":
                    span.set_attribute(key, value)
        try:
            output = original_execute_tool_activity(ctx, input_data)
            if span is not None:
                span.set_attribute("output.mime_type", "application/json")
                span.set_attribute("output.value", _json_attr(output))
                result = output.get("tool_result") if isinstance(output, Mapping) else None
                if isinstance(result, Mapping) and result.get("error"):
                    span.set_attribute("error", True)
                    span.set_attribute("tool.error", str(result.get("error")))
            return output
        except Exception as exc:
            if span is not None:
                span.set_attribute("error", True)
                span.record_exception(exc)
            raise

    def agent_workflow(
        ctx: Any, input_data: dict[str, Any]
    ) -> Generator[Any, Any, Any]:
        if "agent_config" in input_data:
            workflow_input = module.AgentWorkflowInput.from_dict(input_data)
        elif module._default_workflow_input_factory is not None:
            task = input_data.get("task", "")
            workflow_input = module.AgentWorkflowInput.from_dict(
                module._default_workflow_input_factory(task)
            )
        else:
            raise ValueError(
                "Received input without 'agent_config' and no default factory is set. "
                "Ensure the runner has been started before the workflow is invoked."
            )

        telemetry_context = _telemetry_context(input_data)
        retry_policy = module.RetryPolicy(
            max_number_of_attempts=3,
            first_retry_interval=timedelta(seconds=1),
            backoff_coefficient=2.0,
            max_retry_interval=timedelta(seconds=30),
        )

        iteration = 0
        while iteration < workflow_input.max_iterations:
            iter_context = {
                **telemetry_context,
                "agent.iteration": iteration,
                "workflow.instance_id": getattr(ctx, "instance_id", None),
            }
            llm_input = module.CallLlmInput(
                agent_config=workflow_input.agent_config,
                messages=workflow_input.messages,
            ).to_dict()
            llm_input["_telemetry_context"] = iter_context

            llm_output_data = yield ctx.call_activity(
                call_llm_activity,
                input=llm_input,
                retry_policy=retry_policy,
            )
            llm_output = module.CallLlmOutput.from_dict(llm_output_data)

            if llm_output.error:
                return module.AgentWorkflowOutput(
                    final_response=None,
                    messages=workflow_input.messages,
                    iterations=iteration,
                    status="error",
                    error=llm_output.error,
                ).to_dict()

            workflow_input.messages.append(llm_output.message)

            if llm_output.is_final:
                return module.AgentWorkflowOutput(
                    final_response=llm_output.message.content,
                    messages=workflow_input.messages,
                    iterations=iteration + 1,
                    status="completed",
                ).to_dict()

            tool_tasks = []
            for order, tool_call in enumerate(llm_output.message.tool_calls):
                tool_input = module.ExecuteToolInput(
                    tool_call=tool_call,
                    agent_name=workflow_input.agent_config.name,
                    session_id=workflow_input.session_id,
                    user_id=workflow_input.user_id,
                    app_name=workflow_input.app_name,
                ).to_dict()
                tool_input["_telemetry_context"] = {
                    **iter_context,
                    "tool.order": order,
                }
                task = ctx.call_activity(
                    execute_tool_activity,
                    input=tool_input,
                    retry_policy=retry_policy,
                )
                tool_tasks.append(task)

            tool_outputs_data = yield module.when_all(tool_tasks)
            tool_results = []
            for tool_output_data in tool_outputs_data:
                tool_output = module.ExecuteToolOutput.from_dict(tool_output_data)
                tool_results.append(tool_output.tool_result)

            tool_results_message = module.Message(
                role=module.MessageRole.USER,
                tool_results=tool_results,
            )
            workflow_input.messages.append(tool_results_message)
            iteration += 1

        return module.AgentWorkflowOutput(
            final_response=None,
            messages=workflow_input.messages,
            iterations=iteration,
            status="max_iterations_reached",
            error=f"Max iterations ({workflow_input.max_iterations}) reached",
        ).to_dict()

    call_llm_activity.__name__ = "call_llm_activity"
    execute_tool_activity.__name__ = "execute_tool_activity"
    agent_workflow.__name__ = "agent_workflow"

    module.call_llm_activity = call_llm_activity
    module.execute_tool_activity = execute_tool_activity
    module.agent_workflow = agent_workflow


def install_diagrid_adk_telemetry_patch() -> None:
    """Patch Diagrid ADK workflow globals before the runner registers them."""
    global _PATCHED
    if _PATCHED:
        return

    try:
        import diagrid.agent.adk.workflow as workflow_module
        import diagrid.agent.adk.runner as runner_module
    except Exception as exc:  # noqa: BLE001
        logger.warning("[adk-telemetry] failed to import Diagrid modules: %s", exc)
        return

    _patch_workflow_module(workflow_module)
    runner_module.agent_workflow = workflow_module.agent_workflow
    runner_module.call_llm_activity = workflow_module.call_llm_activity
    runner_module.execute_tool_activity = workflow_module.execute_tool_activity
    _PATCHED = True
    logger.info("[adk-telemetry] installed Diagrid ADK typed span patch")

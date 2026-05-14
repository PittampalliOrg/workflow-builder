"""Workflow Builder telemetry patch for Diagrid's ADK durable bridge.

Diagrid's ADK runner emits durable activity spans, but those spans do not carry
the MLflow/OpenInference attributes that the workflow UI and MLflow collector
use to classify LLM/tool work. Patch the registered workflow and activities so
each LLM and tool activity gets the same typed span shape as dapr-agent-py.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
from datetime import timedelta
from time import perf_counter
from typing import Any, Generator, Mapping

from src.telemetry.adk_session_events import (
    publish_adk_event_actions,
    publish_adk_iteration,
    publish_adk_llm_start,
    publish_adk_llm_usage,
    publish_adk_tool_result,
    publish_adk_tool_use,
)
from src.telemetry.genai_attrs import (
    get_current_span,
    set_activity_attrs,
    set_genai_request_attrs,
    set_genai_response_attrs,
)
from src.telemetry.providers import get_tracer, telemetry_debug_state

logger = logging.getLogger(__name__)

_PATCHED = False
_MAX_ATTR_CHARS = 20_000
_DIAG_COUNT = 0
_DIAG_LIMIT = 0


def _diag_limit() -> int:
    raw = os.environ.get("ADK_TELEMETRY_DIAG_LIMIT")
    if raw is None or not raw.strip():
        return _DIAG_LIMIT
    try:
        return max(0, int(raw.strip()))
    except ValueError:
        return _DIAG_LIMIT


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


def _span_debug(span: Any | None) -> dict[str, Any]:
    if span is None:
        return {"present": False}
    try:
        context = span.get_span_context()
        return {
            "present": True,
            "recording": bool(span.is_recording()),
            "trace_id": format(context.trace_id, "032x") if context.trace_id else None,
            "span_id": format(context.span_id, "016x") if context.span_id else None,
        }
    except Exception as exc:  # noqa: BLE001
        return {"present": True, "error": str(exc)}


def _diag(
    activity: str,
    ctx: Mapping[str, Any],
    *,
    tracer: Any | None = None,
    span: Any | None = None,
) -> None:
    global _DIAG_COUNT
    if _DIAG_COUNT >= _diag_limit():
        return
    _DIAG_COUNT += 1
    logger.warning(
        "[adk-telemetry] activity=%s diag=%d ctx_keys=%s workflow_execution=%r "
        "workflow_node=%r/%r agent=%r/%r session=%r workspace=%r component=%r "
        "active_span=%s tracer=%s providers=%s",
        activity,
        _DIAG_COUNT,
        sorted(str(key) for key in ctx.keys()),
        ctx.get("workflow.execution.id"),
        ctx.get("workflow.node.id"),
        ctx.get("workflow.node.name"),
        ctx.get("agent.id"),
        ctx.get("agent.app_id") or ctx.get("agent.slug"),
        ctx.get("session.id"),
        ctx.get("sandbox.workspace_ref"),
        ctx.get("dapr.component"),
        _span_debug(span),
        type(tracer).__name__ if tracer is not None else None,
        telemetry_debug_state(),
    )


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


def _pop_gemini_usage() -> dict[str, int] | None:
    try:
        from src.adapters.gemini_thought_signatures import pop_last_usage
    except Exception:  # noqa: BLE001
        return None
    return pop_last_usage()


def _span_name(ctx: Mapping[str, Any], activity: str) -> str:
    agent_app_id = _clean_string(ctx.get("agent.app_id")) or _clean_string(
        ctx.get("agent.slug")
    )
    return f"{agent_app_id}.{activity}" if agent_app_id else f"adk_agent.{activity}"


def _serialize_tool_value(value: Any) -> Any:
    if hasattr(value, "model_dump"):
        return value.model_dump()
    if hasattr(value, "to_dict"):
        return value.to_dict()
    if isinstance(value, (str, int, float, bool, list, dict, type(None))):
        return value
    return str(value)


def _execute_tool_activity_with_actions(
    module: Any,
    input_data: dict[str, Any],
) -> tuple[dict[str, Any], Any | None]:
    """Mirror Diagrid's tool activity while retaining ToolContext.actions."""

    tool_input = module.ExecuteToolInput.from_dict(input_data)
    tool_call = tool_input.tool_call
    event_actions = None

    tool = module.get_registered_tool(tool_call.name)
    if tool is None:
        return (
            module.ExecuteToolOutput(
                tool_result=module.ToolResult(
                    tool_call_id=tool_call.id,
                    tool_name=tool_call.name,
                    result=None,
                    error=f"Tool '{tool_call.name}' not found in registry",
                )
            ).to_dict(),
            None,
        )

    loop = None
    try:
        from google.adk.agents.invocation_context import (
            InvocationContext,
            new_invocation_context_id,
        )
        from google.adk.agents.llm_agent import LlmAgent
        from google.adk.events.event_actions import EventActions
        from google.adk.sessions.in_memory_session_service import InMemorySessionService
        from google.adk.tools.tool_context import ToolContext

        session_service = InMemorySessionService()
        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)
        session = loop.run_until_complete(
            session_service.create_session(
                app_name=tool_input.app_name or "dapr_workflow",
                user_id=tool_input.user_id or "workflow_user",
                session_id=tool_input.session_id,
            )
        )
        dummy_agent = LlmAgent(
            name=tool_input.agent_name,
            model="gemini-2.0-flash",
        )
        invocation_context = InvocationContext(
            invocation_id=new_invocation_context_id(),
            session=session,
            session_service=session_service,
            agent=dummy_agent,
        )
        event_actions = EventActions()
        tool_context = ToolContext(
            invocation_context=invocation_context,
            function_call_id=tool_call.id,
            event_actions=event_actions,
        )

        result = loop.run_until_complete(
            tool.run_async(args=tool_call.args, tool_context=tool_context)
        )
        return (
            module.ExecuteToolOutput(
                tool_result=module.ToolResult(
                    tool_call_id=tool_call.id,
                    tool_name=tool_call.name,
                    result=_serialize_tool_value(result),
                )
            ).to_dict(),
            event_actions,
        )
    except Exception as exc:  # noqa: BLE001
        logger.exception("Error executing tool '%s'", tool_call.name)
        return (
            module.ExecuteToolOutput(
                tool_result=module.ToolResult(
                    tool_call_id=tool_call.id,
                    tool_name=tool_call.name,
                    result=None,
                    error=str(exc),
                )
            ).to_dict(),
            event_actions,
        )
    finally:
        if loop is not None:
            try:
                loop.close()
            finally:
                try:
                    asyncio.set_event_loop(None)
                except Exception:
                    pass


def _patch_workflow_module(module: Any) -> None:
    original_call_llm_activity = module.call_llm_activity

    def call_llm_activity(ctx: Any, input_data: dict[str, Any]) -> dict[str, Any]:
        tel = _telemetry_context(input_data)
        agent_config = input_data.get("agent_config") or {}
        model = _clean_string(agent_config.get("model"))
        provider = _clean_string(agent_config.get("provider")) or "gemini"
        component = _clean_string(agent_config.get("component_name")) or _clean_string(
            tel.get("dapr.component")
        )
        tel.setdefault("dapr.component", component or f"llm-{provider}")

        _stamp_current_activity(
            tel,
            activity="call_llm_activity",
            mlflow_span_type="CHAT_MODEL",
        )
        attrs = {
            **_base_attrs(tel),
            "span_type": "CHAT_MODEL",
            "mlflow.spanType": "CHAT_MODEL",
            "openinference.span.kind": "LLM",
            "gen_ai.operation.name": "chat",
            "input.mime_type": "application/json",
            "input.value": _json_attr(input_data),
        }
        attrs = {
            key: value
            for key, value in attrs.items()
            if value is not None and value != ""
        }
        tracer = get_tracer()
        _diag(
            "call_llm_activity.before_child",
            tel,
            tracer=tracer,
            span=get_current_span(),
        )
        publish_adk_iteration(
            tel,
            agent_config,
            max_iterations=tel.get("agent.max_iterations"),
        )
        publish_adk_llm_start(tel, agent_config)

        def run_with_span(span: Any | None) -> dict[str, Any]:
            start = perf_counter()
            _diag("call_llm_activity.child", tel, tracer=tracer, span=span)
            if span is not None:
                for key, value in attrs.items():
                    span.set_attribute(key, value)
                span.set_attribute("span_type", "CHAT_MODEL")
                span.set_attribute("mlflow.spanType", "CHAT_MODEL")
                span.set_attribute("openinference.span.kind", "LLM")
                span.set_attribute("gen_ai.operation.name", "chat")
                span.set_attribute("input.mime_type", "application/json")
                span.set_attribute("input.value", _json_attr(input_data))
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
                duration_ms = (perf_counter() - start) * 1000
                usage = _pop_gemini_usage()
                output_error = (
                    output.get("error") if isinstance(output, Mapping) else None
                )
                if span is not None:
                    content, tool_call_count, output_chars = _llm_output_stats(output)
                    set_genai_response_attrs(
                        span,
                        response_model=model,
                        usage=usage,
                        duration_ms=duration_ms,
                        tool_calls_count=tool_call_count,
                        output_chars=output_chars,
                        finish_reason="tool_calls" if tool_call_count else "stop",
                    )
                    span.set_attribute("output.mime_type", "application/json")
                    span.set_attribute("output.value", _json_attr(output))
                    if content is not None:
                        span.set_attribute(
                            "gen_ai.response.content.chars", len(content)
                        )
            except Exception as exc:
                if span is not None:
                    span.set_attribute("error", True)
                    span.record_exception(exc)
                raise
            if isinstance(output, Mapping):
                publish_adk_llm_usage(
                    tel,
                    agent_config,
                    usage,
                    duration_ms=duration_ms,
                    success=not output_error,
                    error=str(output_error) if output_error else None,
                )
                message = output.get("message")
                tool_calls = (
                    message.get("tool_calls") if isinstance(message, Mapping) else []
                )
                if isinstance(tool_calls, list):
                    for tool_call in tool_calls:
                        if isinstance(tool_call, Mapping):
                            publish_adk_tool_use(tel, tool_call)
            return output

        if tracer is not None:
            with tracer.start_as_current_span(
                _span_name(tel, "call_llm"),
                attributes=attrs,
            ) as child_span:
                return run_with_span(child_span)
        return run_with_span(None)

    def execute_tool_activity(ctx: Any, input_data: dict[str, Any]) -> dict[str, Any]:
        tel = _telemetry_context(input_data)
        raw_tool_call = input_data.get("tool_call")
        tool_call = raw_tool_call if isinstance(raw_tool_call, Mapping) else {}
        tool_name = _clean_string(tool_call.get("name")) or "unknown"
        args = tool_call.get("args")

        _stamp_current_activity(
            tel,
            activity="execute_tool_activity",
            mlflow_span_type="TOOL",
        )
        attrs = {
            **_base_attrs(tel),
            "span_type": "TOOL",
            "mlflow.spanType": "TOOL",
            "openinference.span.kind": "TOOL",
            "gen_ai.operation.name": "execute_tool",
            "gen_ai.tool.name": tool_name,
            "tool.name": tool_name,
            "tool.call_id": tool_call.get("id")
            if isinstance(tool_call, Mapping)
            else None,
            "input.mime_type": "application/json",
            "input.value": _json_attr(input_data),
        }
        if isinstance(args, Mapping):
            attrs["tool.args.keys"] = ",".join(str(k) for k in sorted(args.keys()))
            attrs["tool.args.size_chars"] = len(_json_attr(args))
        attrs = {
            key: value
            for key, value in attrs.items()
            if value is not None and value != ""
        }
        tracer = get_tracer()
        _diag(
            "execute_tool_activity.before_child",
            tel,
            tracer=tracer,
            span=get_current_span(),
        )

        def run_with_span(span: Any | None) -> dict[str, Any]:
            start = perf_counter()
            _diag("execute_tool_activity.child", tel, tracer=tracer, span=span)
            if span is not None:
                for key, value in attrs.items():
                    span.set_attribute(key, value)
            try:
                output, event_actions = _execute_tool_activity_with_actions(
                    module, input_data
                )
                duration_ms = (perf_counter() - start) * 1000
                if span is not None:
                    span.set_attribute("output.mime_type", "application/json")
                    span.set_attribute("output.value", _json_attr(output))
                    result = (
                        output.get("tool_result")
                        if isinstance(output, Mapping)
                        else None
                    )
                    if isinstance(result, Mapping) and result.get("error"):
                        span.set_attribute("error", True)
                        span.set_attribute("tool.error", str(result.get("error")))
                result = (
                    output.get("tool_result") if isinstance(output, Mapping) else None
                )
                if isinstance(result, Mapping):
                    publish_adk_tool_result(tel, result, duration_ms=duration_ms)
                publish_adk_event_actions(tel, tool_call, event_actions)
                return output
            except Exception as exc:
                if span is not None:
                    span.set_attribute("error", True)
                    span.record_exception(exc)
                raise

        if tracer is not None:
            with tracer.start_as_current_span(
                _span_name(tel, "run_tool"),
                attributes=attrs,
            ) as child_span:
                return run_with_span(child_span)
        return run_with_span(None)

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
        telemetry_context.setdefault("agent.session.id", workflow_input.session_id)
        telemetry_context.setdefault(
            "workflow_builder.session_id", workflow_input.session_id
        )
        telemetry_context.setdefault("session.id", workflow_input.session_id)
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
                "agent.max_iterations": workflow_input.max_iterations,
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
    if _diag_limit() > 0:
        logger.warning(
            "[adk-telemetry] installed Diagrid ADK typed span patch workflow=%s "
            "call_llm=%s execute_tool=%s providers=%s",
            workflow_module.agent_workflow,
            workflow_module.call_llm_activity,
            workflow_module.execute_tool_activity,
            telemetry_debug_state(),
        )
    else:
        logger.info("[adk-telemetry] installed Diagrid ADK typed span patch")

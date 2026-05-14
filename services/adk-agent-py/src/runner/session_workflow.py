"""Outer `session_workflow` — structural port of dapr-agent-py's session loop.

The workflow-orchestrator calls this workflow via
`ctx.call_child_workflow("session_workflow", app_id="agent-session-<sha>",
input={...})`. We:

1. Pull metadata from the input envelope (sessionId, autoTerminateAfterEndTurn,
   agentConfig, instructionBundle.rendered.system, maxTurns).
2. Stamp the session_id on the process-local `OpenShellRuntime` so all tools
   (Bash, Read, Write, ReadSessionEvents, etc.) can scope their effects.
3. Publish `session.status_starting`.
4. For each turn:
   - Build per-turn `AgentConfig` (model + system_instruction + tool_definitions).
   - Compact image tool_results in the message history before the child call.
   - Invoke Diagrid's `agent_workflow` as a child workflow (per-LLM-call + per-
     tool-call durability owned by Diagrid).
   - Wrap the call in `when_any([child, timer])` for session-turn-timeout.
   - On child completion: append the assistant message to history, publish
     `agent.message`, `session.status_idle{stop_reason}`.
5. If `autoTerminateAfterEndTurn=true`, terminate after the first turn.
   Otherwise, wait for `session.user_events` external events (user_message,
   terminate, update_agent_config) and loop.

The agent_workflow that Diagrid registered handles the inner durable loop —
LLM calls become `call_llm_activity` invocations, tool calls become
`execute_tool_activity` invocations parallelized via `when_all`. We get
per-activity retry + replay automatically.
"""

from __future__ import annotations

import logging
import os
from datetime import timedelta
from typing import Any, Callable, Generator

from dapr.ext.workflow import (
    DaprWorkflowContext,
    RetryPolicy,
    when_any as wf_when_any,
)

from src.constants import SESSION_TURN_TIMEOUT_SECONDS
from src.event_publisher import publish_session_event, scope_session, unscope_session
from src.openshell_runtime import get_runtime
from src.adapters.agent_config_builder import build_per_turn_agent_config
from src.runner.image_compaction import compact_image_tool_results

logger = logging.getLogger(__name__)


# Outer retry policy on the child Diagrid workflow call — surface pod-restart
# resilience even when Diagrid's inner activity retries are exhausted.
_CHILD_RETRY_POLICY = RetryPolicy(
    max_number_of_attempts=8,
    first_retry_interval=timedelta(seconds=4),
    backoff_coefficient=1.5,
    max_retry_interval=timedelta(seconds=45),
)


def _extract_seed_user_message(input_data: dict[str, Any]) -> str | None:
    """Pull the initial user prompt from the workflow/session bridge envelope.

    New workflow-driven sessions arrive through the BFF's
    `ensure-for-workflow` bridge, which stores the prompt in `initialEvents`.
    Keep the older `with.x-workflow-builder.input` fallback for direct legacy
    child-input shapes.
    """
    initial_events = input_data.get("initialEvents")
    if isinstance(initial_events, list):
        for event in initial_events:
            if not isinstance(event, dict) or event.get("type") != "user.message":
                continue
            content = event.get("content")
            if isinstance(content, str) and content.strip():
                return content.strip()
            if isinstance(content, list):
                parts: list[str] = []
                for item in content:
                    if isinstance(item, str) and item.strip():
                        parts.append(item.strip())
                    elif isinstance(item, dict):
                        text = item.get("text")
                        if isinstance(text, str) and text.strip():
                            parts.append(text.strip())
                if parts:
                    return "\n".join(parts)

    with_block = input_data.get("with") or {}
    wb = with_block.get("x-workflow-builder") or {}
    raw = wb.get("input")
    if isinstance(raw, str) and raw.strip():
        return raw.strip()
    return None


def _session_id(input_data: dict[str, Any]) -> str | None:
    sid = (input_data.get("sessionId") or "").strip()
    return sid or None


def _resolved_string(value: Any) -> str | None:
    if not isinstance(value, str):
        return None
    text = value.strip()
    if not text or "${" in text:
        return None
    return text


def _nested_record(value: Any, *path: str) -> dict[str, Any]:
    current = value
    for key in path:
        if not isinstance(current, dict):
            return {}
        current = current.get(key)
    return current if isinstance(current, dict) else {}


def _runtime_value(input_data: dict[str, Any], *keys: str) -> str | None:
    candidates: list[Any] = []

    for key in keys:
        candidates.append(input_data.get(key))

    metadata = _nested_record(input_data, "_message_metadata")
    for key in keys:
        candidates.append(metadata.get(key))

    runtime = _nested_record(input_data, "instructionBundle", "runtime")
    for key in keys:
        candidates.append(runtime.get(key))

    agent_config = _nested_record(input_data, "agentConfig")
    for key in keys:
        candidates.append(agent_config.get(key))

    effective_agent_config = _nested_record(input_data, "effectiveAgentConfig")
    for key in keys:
        candidates.append(effective_agent_config.get(key))

    for candidate in candidates:
        resolved = _resolved_string(candidate)
        if resolved:
            return resolved
    return None


def _extract_runtime_context(input_data: dict[str, Any]) -> tuple[str | None, str | None, str | None]:
    workspace_ref = _runtime_value(input_data, "workspaceRef", "workspace_ref")
    sandbox_name = _runtime_value(input_data, "sandboxName", "sandbox_name") or (
        workspace_ref if workspace_ref and workspace_ref.startswith("workspace-") else None
    )
    cwd = _runtime_value(input_data, "cwd", "workingDirectory", "rootPath")
    return sandbox_name, workspace_ref, cwd


def _session_turn_timeout_seconds(input_data: dict[str, Any]) -> int:
    """Honor workflow-provided timeoutMinutes for long single-turn runs.

    UI chat sessions usually omit timeoutMinutes and keep the runtime default.
    SWE-bench durable/run calls pass a larger timeout through the orchestrator;
    the session wrapper should not abort those turns at the 600s default.
    """

    agent_config = _nested_record(input_data, "agentConfig")
    effective_agent_config = _nested_record(input_data, "effectiveAgentConfig")
    candidates = [
        input_data.get("timeoutMinutes"),
        input_data.get("timeout_minutes"),
        agent_config.get("timeoutMinutes"),
        agent_config.get("timeout_minutes"),
        effective_agent_config.get("timeoutMinutes"),
        effective_agent_config.get("timeout_minutes"),
    ]
    for raw in candidates:
        try:
            minutes = int(raw)
        except (TypeError, ValueError):
            continue
        if minutes > 0:
            return max(SESSION_TURN_TIMEOUT_SECONDS, minutes * 60)
    return SESSION_TURN_TIMEOUT_SECONDS


def _first_resolved(*values: Any) -> str | None:
    for value in values:
        resolved = _resolved_string(value)
        if resolved:
            return resolved
        if value is None or isinstance(value, bool):
            continue
        text = str(value).strip()
        if text and "${" not in text:
            return text
    return None


def _telemetry_context_value(input_data: dict[str, Any], *keys: str) -> str | None:
    candidates: list[Any] = []

    for key in keys:
        candidates.append(input_data.get(key))

    metadata = _nested_record(input_data, "_message_metadata")
    for key in keys:
        candidates.append(metadata.get(key))

    instruction_agent = _nested_record(input_data, "instructionBundle", "agent")
    agent_config = _nested_record(input_data, "agentConfig")
    effective_agent_config = _nested_record(input_data, "effectiveAgentConfig")
    for key in keys:
        candidates.append(instruction_agent.get(key))
        candidates.append(agent_config.get(key))
        candidates.append(effective_agent_config.get(key))

    return _first_resolved(*candidates)


def _build_telemetry_context(
    input_data: dict[str, Any],
    *,
    session_id: str | None,
    sandbox_name: str | None,
    workspace_ref: str | None,
    cwd: str | None,
    agent_config: dict[str, Any],
    model: str | None,
    provider: str | None,
) -> dict[str, Any]:
    """Build attrs for Diagrid's inner LLM/tool activities.

    Diagrid's dataclasses drop unknown top-level fields, so pass these as an
    explicit private dict and have the patched inner workflow copy it into each
    activity input.
    """

    workflow_id = _telemetry_context_value(input_data, "workflowId", "workflow_id")
    workflow_execution_id = _telemetry_context_value(
        input_data,
        "workflowExecutionId",
        "workflow_execution_id",
        "dbExecutionId",
        "executionId",
    )
    node_id = _telemetry_context_value(
        input_data,
        "nodeId",
        "workflowNodeId",
        "workflow_node_id",
    )
    node_name = _telemetry_context_value(
        input_data,
        "nodeName",
        "workflowNodeName",
        "workflow_node_name",
    ) or node_id

    agent_id = _telemetry_context_value(input_data, "agentId", "agent_id", "id")
    agent_version = _telemetry_context_value(
        input_data,
        "agentVersion",
        "agent_version",
        "version",
    )
    agent_slug = _telemetry_context_value(input_data, "agentSlug", "agent_slug", "slug")
    agent_app_id = _telemetry_context_value(
        input_data,
        "agentAppId",
        "agent_app_id",
        "appId",
        "appid",
    )
    if not agent_app_id:
        agent_app_id = _first_resolved(
            agent_config.get("agentAppId"),
            os.environ.get("APP_ID"),
            os.environ.get("DAPR_APP_ID"),
        )

    component = _first_resolved(
        _telemetry_context_value(input_data, "llmComponent", "daprComponent"),
        f"llm-{provider}" if provider else None,
    )
    mlflow_context = (
        input_data.get("mlflowContext")
        if isinstance(input_data.get("mlflowContext"), dict)
        else {}
    )
    mlflow_session_id = _first_resolved(
        input_data.get("mlflowSessionId"),
        mlflow_context.get("mlflowSessionId"),
        session_id,
    )

    attrs: dict[str, Any] = {
        "workflow.id": workflow_id,
        "workflow.execution.id": workflow_execution_id,
        "workflow.node.id": node_id,
        "workflow.node.name": node_name,
        "workflow.node.type": "agent",
        "workflow.node.action_type": "durable/run",
        "workflow.node.sequence": _telemetry_context_value(
            input_data,
            "nodeSequence",
            "workflowNodeSequence",
            "sequence",
        ),
        "session.id": mlflow_session_id,
        "agent.session.id": session_id,
        "workflow_builder.session_id": session_id,
        "workflow_builder.mlflow_session_id": mlflow_session_id,
        "mlflow.run_id": mlflow_context.get("runId"),
        "mlflow.parent_run_id": mlflow_context.get("parentRunId"),
        "mlflow.modelId": mlflow_context.get("activeModelId"),
        "mlflow.model.uri": mlflow_context.get("activeModelUri"),
        "agent.id": agent_id,
        "agent.version": agent_version,
        "agent.slug": agent_slug,
        "agent.app_id": agent_app_id,
        "sandbox.name": sandbox_name,
        "sandbox.workspace_ref": workspace_ref,
        "sandbox.cwd": cwd,
        "dapr.component": component,
        "gen_ai.request.model": model,
        "gen_ai.system": provider,
    }
    return {key: value for key, value in attrs.items() if value is not None and value != ""}


def session_workflow_factory(
    diagrid_workflow_name: str,
    *,
    declared_tools: list[Any] | None = None,
) -> Callable[..., Any]:
    """Return a Dapr workflow body closed over the Diagrid child workflow name."""

    def session_workflow(
        ctx: DaprWorkflowContext, input_data: dict[str, Any]
    ) -> Generator[Any, Any, dict[str, Any]]:
        session_id = _session_id(input_data)
        agent_config = input_data.get("agentConfig") or {}
        instruction_bundle = input_data.get("instructionBundle") or {}
        rendered_system = (instruction_bundle.get("rendered") or {}).get("system") or ""
        auto_term = bool(input_data.get("autoTerminateAfterEndTurn"))
        max_turns = int(input_data.get("maxIterations") or agent_config.get("maxTurns") or 120)
        turn_timeout_seconds = _session_turn_timeout_seconds(input_data)
        sandbox_name, workspace_ref, cwd = _extract_runtime_context(input_data)

        # Scope tools to this session for the lifetime of the workflow body.
        # Configure the singleton OpenShell runtime + push a ContextVar onto
        # event_publisher.scope_session — both used by the tool wrappers to
        # publish CMA-shaped session events and target the workflow sandbox.
        if not ctx.is_replaying and session_id:
            try:
                runtime = get_runtime()
                runtime.set_session_id(session_id)
                runtime.set_sandbox_name(sandbox_name)
                runtime.set_cwd(cwd)
            except Exception as exc:  # noqa: BLE001
                logger.warning("[session_workflow] runtime context setup failed: %s", exc)
            publish_session_event(session_id, "session.status_starting", {})

        scope_token = None
        if session_id and not ctx.is_replaying:
            try:
                scope_token = scope_session(session_id, ctx.instance_id)
            except Exception as exc:  # noqa: BLE001
                logger.warning("[session_workflow] scope_session failed: %s", exc)

        message_history: list[dict[str, Any]] = []
        seed_user = _extract_seed_user_message(input_data)
        if seed_user:
            message_history.append(
                {"role": "user", "content": seed_user, "tool_calls": [], "tool_results": []}
            )

        final_output: str | None = None
        turn_index = 0

        try:
            while True:
                # Wait for next user event unless we already have a queued user msg
                # (initial seed OR a user_message we just pushed in the previous loop).
                needs_user_event = not (message_history and message_history[-1].get("role") == "user")
                if needs_user_event:
                    user_event = yield ctx.wait_for_external_event("session.user_events")
                    if not isinstance(user_event, dict):
                        # Malformed event — terminate cleanly.
                        break
                    event_type = user_event.get("type") or ""
                    if event_type == "session.terminate":
                        break
                    if event_type == "session.update_agent_config":
                        new_cfg = user_event.get("agentConfig") or {}
                        if isinstance(new_cfg, dict):
                            agent_config = {**agent_config, **new_cfg}
                        continue
                    # Default: treat as user message.
                    content = (
                        user_event.get("content")
                        or user_event.get("message")
                        or ""
                    )
                    if not content:
                        continue
                    message_history.append(
                        {"role": "user", "content": content, "tool_calls": [], "tool_results": []}
                    )

                turn_index += 1

                # Build child input for Diagrid's agent_workflow.
                per_turn_config = build_per_turn_agent_config(
                    agent_config,
                    rendered_system_prompt=rendered_system,
                    model=agent_config.get("modelSpec"),
                    declared_tools=declared_tools,
                )
                telemetry_context = _build_telemetry_context(
                    input_data,
                    session_id=session_id,
                    sandbox_name=sandbox_name,
                    workspace_ref=workspace_ref,
                    cwd=cwd,
                    agent_config=agent_config,
                    model=per_turn_config.get("model"),
                    provider=per_turn_config.get("provider"),
                )
                if telemetry_context.get("dapr.component"):
                    per_turn_config["component_name"] = telemetry_context["dapr.component"]
                child_input = {
                    "agent_config": per_turn_config,
                    "messages": compact_image_tool_results(message_history),
                    "session_id": session_id or "",
                    "user_id": input_data.get("userId"),
                    "app_name": workspace_ref or "workflow-builder",
                    "iteration": 0,
                    "max_iterations": max_turns,
                    "_telemetry_context": telemetry_context,
                }

                child_instance_id = f"{ctx.instance_id}-t{turn_index}"
                child_task = ctx.call_child_workflow(
                    workflow=diagrid_workflow_name,
                    input=child_input,
                    instance_id=child_instance_id,
                    retry_policy=_CHILD_RETRY_POLICY,
                )
                timer_task = ctx.create_timer(timedelta(seconds=turn_timeout_seconds))
                winner = yield wf_when_any([child_task, timer_task])

                if winner is timer_task:
                    if session_id and not ctx.is_replaying:
                        publish_session_event(
                            session_id,
                            "run_error",
                            {
                                "reason": "session_turn_timeout",
                                "timeoutSeconds": turn_timeout_seconds,
                            },
                        )
                    raise RuntimeError(
                        f"session_workflow turn {turn_index} exceeded "
                        f"{turn_timeout_seconds}s — aborting"
                    )

                # Child completed.
                child_output = winner.get_result() or {}
                child_status = child_output.get("status") or "completed"
                child_messages = child_output.get("messages") or []
                if child_messages:
                    message_history = child_messages
                final_response = child_output.get("final_response")
                if final_response is not None:
                    final_output = final_response

                # Publish agent.message for the final response of this turn.
                if session_id and not ctx.is_replaying:
                    publish_session_event(
                        session_id,
                        "llm_complete",
                        {
                            "content": final_response or "",
                            "iterations": child_output.get("iterations"),
                            "status": child_status,
                        },
                    )
                    stop_reason = (
                        "end_turn" if child_status == "completed" else child_status
                    )
                    publish_session_event(
                        session_id,
                        "session.status_idle",
                        {"stop_reason": stop_reason},
                    )

                if auto_term:
                    if session_id and not ctx.is_replaying:
                        publish_session_event(
                            session_id,
                            "session.status_terminated",
                            {"reason": "auto_terminate_after_end_turn"},
                        )
                    return {
                        "output": final_output,
                        "messages": message_history,
                        "status": child_status,
                    }
        finally:
            if scope_token is not None:
                try:
                    unscope_session(scope_token)
                except Exception:
                    pass

        if session_id and not ctx.is_replaying:
            publish_session_event(
                session_id,
                "session.status_terminated",
                {"reason": "user_terminate"},
            )
        return {
            "output": final_output,
            "messages": message_history,
            "status": "terminated",
        }

    return session_workflow

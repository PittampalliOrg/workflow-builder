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

        # Scope tools to this session for the lifetime of the workflow body.
        # `set_session_id` on the singleton OpenShell runtime + push a
        # ContextVar onto event_publisher.scope_session — both used by the
        # tool wrappers to publish CMA-shaped session events.
        if not ctx.is_replaying and session_id:
            try:
                get_runtime().set_session_id(session_id)
            except Exception as exc:  # noqa: BLE001
                logger.warning("[session_workflow] set_session_id failed: %s", exc)
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
                child_input = {
                    "agent_config": per_turn_config,
                    "messages": compact_image_tool_results(message_history),
                    "session_id": session_id or "",
                    "user_id": input_data.get("userId"),
                    "app_name": input_data.get("workspaceRef") or "workflow-builder",
                    "iteration": 0,
                    "max_iterations": max_turns,
                }

                child_instance_id = f"{ctx.instance_id}-t{turn_index}"
                child_task = ctx.call_child_workflow(
                    workflow=diagrid_workflow_name,
                    input=child_input,
                    instance_id=child_instance_id,
                    retry_policy=_CHILD_RETRY_POLICY,
                )
                timer_task = ctx.create_timer(
                    timedelta(seconds=SESSION_TURN_TIMEOUT_SECONDS)
                )
                winner = yield wf_when_any([child_task, timer_task])

                if winner is timer_task:
                    if session_id and not ctx.is_replaying:
                        publish_session_event(
                            session_id,
                            "run_error",
                            {
                                "reason": "session_turn_timeout",
                                "timeoutSeconds": SESSION_TURN_TIMEOUT_SECONDS,
                            },
                        )
                    raise RuntimeError(
                        f"session_workflow turn {turn_index} exceeded "
                        f"{SESSION_TURN_TIMEOUT_SECONDS}s — aborting"
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

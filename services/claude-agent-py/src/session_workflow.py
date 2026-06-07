from __future__ import annotations

import logging
from datetime import timedelta
from typing import Any, Generator, Mapping

from dapr.ext.workflow import DaprWorkflowContext, RetryPolicy, when_any as wf_when_any

from src.cancellation import check_cancellation_activity
from src.claude_sdk_runner import run_claude_sdk_turn_activity
from src.event_publisher import publish_session_event
from src.session_config import TERMINAL_CONTROL_EVENT_TYPES

logger = logging.getLogger(__name__)

_TURN_RETRY_POLICY = RetryPolicy(
    max_number_of_attempts=3,
    first_retry_interval=timedelta(seconds=5),
    backoff_coefficient=2,
    max_retry_interval=timedelta(seconds=30),
)


def _clean_string(value: Any) -> str | None:
    return value.strip() if isinstance(value, str) and value.strip() else None


def _record(value: Any) -> dict[str, Any]:
    return dict(value) if isinstance(value, Mapping) else {}


def _extract_seed_user_message(input_data: Mapping[str, Any]) -> str | None:
    initial_events = input_data.get("initialEvents")
    if isinstance(initial_events, list):
        for event in initial_events:
            if not isinstance(event, Mapping) or event.get("type") != "user.message":
                continue
            content = event.get("content")
            if isinstance(content, str) and content.strip():
                return content.strip()
            if isinstance(content, list):
                parts: list[str] = []
                for item in content:
                    if isinstance(item, str) and item.strip():
                        parts.append(item.strip())
                    elif isinstance(item, Mapping):
                        text = item.get("text")
                        if isinstance(text, str) and text.strip():
                            parts.append(text.strip())
                if parts:
                    return "\n".join(parts)

    with_block = _record(input_data.get("with"))
    wb = _record(with_block.get("x-workflow-builder"))
    return _clean_string(wb.get("input"))


def _session_id(input_data: Mapping[str, Any]) -> str | None:
    return _clean_string(input_data.get("sessionId"))


def _rendered_system(input_data: Mapping[str, Any]) -> str | None:
    bundle = _record(input_data.get("instructionBundle"))
    rendered = _record(bundle.get("rendered"))
    return _clean_string(rendered.get("system"))


def _timeout_seconds(input_data: Mapping[str, Any]) -> int:
    agent_config = _record(input_data.get("agentConfig"))
    for value in (
        input_data.get("timeoutMinutes"),
        input_data.get("timeout_minutes"),
        agent_config.get("timeoutMinutes"),
        agent_config.get("timeout_minutes"),
    ):
        try:
            minutes = int(value)
        except (TypeError, ValueError):
            continue
        if minutes > 0:
            return max(60, minutes * 60)
    return 15 * 60


def _max_iterations(input_data: Mapping[str, Any]) -> int:
    agent_config = _record(input_data.get("agentConfig"))
    for value in (input_data.get("maxIterations"), input_data.get("maxTurns"), agent_config.get("maxTurns")):
        try:
            parsed = int(value)
        except (TypeError, ValueError):
            continue
        if parsed > 0:
            return min(parsed, 400)
    return 80


def _event_batch(payload: Any) -> list[dict[str, Any]]:
    if isinstance(payload, Mapping):
        events = payload.get("events")
        if isinstance(events, list):
            return [dict(event) for event in events if isinstance(event, Mapping)]
        return [dict(payload)]
    return []


def _control_patch(event: Mapping[str, Any]) -> dict[str, Any] | None:
    event_type = event.get("type")
    if event_type == "session.control.update_agent_config":
        patch = event.get("patch")
        if isinstance(patch, Mapping):
            return dict(patch)
        data = event.get("data")
        if isinstance(data, Mapping):
            return dict(data.get("patch") if isinstance(data.get("patch"), Mapping) else data)
        return {}
    if event_type == "session.control.set_model":
        model = _clean_string(event.get("modelSpec"))
        if not model and isinstance(event.get("data"), Mapping):
            model = _clean_string(event["data"].get("modelSpec"))
        return {"modelSpec": model} if model else {}
    if event_type == "session.control.set_permission_mode":
        mode = _clean_string(event.get("mode"))
        if not mode and isinstance(event.get("data"), Mapping):
            mode = _clean_string(event["data"].get("mode"))
        return {"permissionMode": mode} if mode else {}
    return None


def _user_message_from_event(event: Mapping[str, Any]) -> str | None:
    event_type = event.get("type")
    if event_type in {"session.terminate", "terminate"}:
        return None
    content = event.get("content") or event.get("message")
    return _clean_string(content)


def _turn_input(
    input_data: Mapping[str, Any],
    *,
    prompt: str,
    agent_config: dict[str, Any],
    turn_index: int,
    ctx: DaprWorkflowContext,
) -> dict[str, Any]:
    return {
        "prompt": prompt,
        "sessionId": _session_id(input_data),
        "workflowInstanceId": ctx.instance_id,
        "workflowExecutionId": input_data.get("workflowExecutionId") or input_data.get("executionId"),
        "nodeId": input_data.get("nodeId"),
        "nodeName": input_data.get("nodeName"),
        "agentConfig": agent_config,
        "renderedSystem": _rendered_system(input_data),
        "cwd": input_data.get("cwd") or agent_config.get("cwd"),
        "workspaceRef": input_data.get("workspaceRef"),
        "sandboxName": input_data.get("sandboxName"),
        "runtimeSandboxName": input_data.get("runtimeSandboxName"),
        "outputSync": input_data.get("outputSync"),
        "environmentConfig": input_data.get("environmentConfig"),
        "agentAppId": input_data.get("agentAppId"),
        "agentSlug": input_data.get("agentSlug"),
        "maxTurns": agent_config.get("maxTurns") or input_data.get("maxIterations"),
        "maxIterations": agent_config.get("maxTurns") or input_data.get("maxIterations"),
        "turnIndex": turn_index,
    }


def _publish_events(session_id: str | None, events: list[dict[str, Any]]) -> None:
    if not session_id:
        return
    for event in events:
        if not isinstance(event, Mapping):
            continue
        event_type = _clean_string(event.get("type"))
        if not event_type:
            continue
        data = event.get("data") if isinstance(event.get("data"), Mapping) else {}
        source_event_id = _clean_string(event.get("sourceEventId"))
        publish_session_event(session_id, event_type, dict(data), source_event_id=source_event_id)


def session_workflow(
    ctx: DaprWorkflowContext, input_data: dict[str, Any]
) -> Generator[Any, Any, dict[str, Any]]:
    session_id = _session_id(input_data)
    agent_config = _record(input_data.get("agentConfig"))
    auto_term = bool(input_data.get("autoTerminateAfterEndTurn"))
    timeout_seconds = _timeout_seconds(input_data)
    max_iterations = _max_iterations(input_data)
    messages: list[dict[str, Any]] = []
    prompt = _extract_seed_user_message(input_data)
    final_text = ""
    status = "completed"
    last_result: dict[str, Any] = {}

    if session_id and not ctx.is_replaying:
        publish_session_event(session_id, "session.status_starting", {})

    turn_index = 0
    while True:
        if not prompt:
            payload = yield ctx.wait_for_external_event("session.user_events")
            terminated = False
            for event in _event_batch(payload):
                patch = _control_patch(event)
                if patch is not None:
                    agent_config.update({k: v for k, v in patch.items() if v is not None})
                    continue
                if (
                    event.get("type") in TERMINAL_CONTROL_EVENT_TYPES
                    or event.get("type") == "terminate"
                ):
                    terminated = True
                    break
                prompt = _user_message_from_event(event)
                if prompt:
                    break
            if terminated:
                status = "terminated"
                break
            if not prompt:
                continue

        # Between-turn cooperative cancel: a session.terminate / user.interrupt
        # may have persisted a cancel flag (via the raise-event endpoint) while
        # the previous turn's activity was still running. Honor it before starting
        # more work rather than running another turn.
        cancellation = yield ctx.call_activity(
            check_cancellation_activity, input={"instanceId": ctx.instance_id}
        )
        if isinstance(cancellation, Mapping) and cancellation.get("cancelled"):
            status = "terminated"
            break

        turn_index += 1
        if turn_index > max_iterations:
            status = "max_iterations"
            break

        messages.append({"role": "user", "content": prompt})
        if session_id and not ctx.is_replaying:
            publish_session_event(session_id, "session.status_running", {"turn": turn_index})

        activity_task = ctx.call_activity(
            run_claude_sdk_turn_activity,
            input=_turn_input(
                input_data,
                prompt=prompt,
                agent_config=agent_config,
                turn_index=turn_index,
                ctx=ctx,
            ),
            retry_policy=_TURN_RETRY_POLICY,
        )
        timer_task = ctx.create_timer(timedelta(seconds=timeout_seconds))
        winner = yield wf_when_any([activity_task, timer_task])
        if winner is timer_task:
            if session_id and not ctx.is_replaying:
                publish_session_event(
                    session_id,
                    "run_error",
                    {"reason": "session_turn_timeout", "timeoutSeconds": timeout_seconds},
                )
            raise RuntimeError(
                f"session_workflow turn {turn_index} exceeded {timeout_seconds}s"
            )

        result = winner.get_result() or {}
        last_result = dict(result) if isinstance(result, Mapping) else {}
        _publish_events(session_id if not ctx.is_replaying else None, result.get("events") or [])

        if not result.get("success", False):
            status = "failed"
            error = _clean_string(result.get("error")) or "Claude SDK turn failed"
            if session_id and not ctx.is_replaying:
                publish_session_event(session_id, "run_error", {"error": error})
            raise RuntimeError(error)

        final_text = _clean_string(result.get("finalText")) or ""
        messages.append(
            {
                "role": "assistant",
                "content": final_text,
                "sdkSessionId": result.get("sdkSessionId"),
            }
        )
        if session_id and not ctx.is_replaying:
            publish_session_event(
                session_id,
                "session.status_idle",
                {"stop_reason": "end_turn", "turn": turn_index},
            )

        if auto_term:
            if session_id and not ctx.is_replaying:
                publish_session_event(
                    session_id,
                    "session.status_terminated",
                    {"reason": "auto_terminate_after_end_turn"},
                )
            return {
                "success": True,
                "status": status,
                "output": final_text,
                "content": final_text,
                "modelPatch": last_result.get("modelPatch"),
                "messages": messages,
                "sessionId": session_id,
                "agentRuntime": "claude-agent-py",
                "agentWorkflowMode": "claude-agent-sdk",
                "childWorkflowName": "session_workflow",
                "workflowInstanceId": ctx.instance_id,
                "cwd": last_result.get("cwd") or input_data.get("cwd"),
                "workspaceRef": last_result.get("workspaceRef") or input_data.get("workspaceRef"),
                "sandboxName": last_result.get("sandboxName") or input_data.get("sandboxName"),
                "runtimeSandboxName": last_result.get("runtimeSandboxName") or input_data.get("runtimeSandboxName"),
                "outputSync": last_result.get("outputSync"),
                "swebench": last_result.get("swebench"),
            }

        prompt = None

    if session_id and not ctx.is_replaying:
        publish_session_event(session_id, "session.status_terminated", {"reason": status})
    return {
        "success": status != "failed",
        "status": status,
        "output": final_text,
        "content": final_text,
        "modelPatch": last_result.get("modelPatch"),
        "messages": messages,
        "sessionId": session_id,
        "agentRuntime": "claude-agent-py",
        "agentWorkflowMode": "claude-agent-sdk",
        "childWorkflowName": "session_workflow",
        "workflowInstanceId": ctx.instance_id,
        "cwd": last_result.get("cwd") or input_data.get("cwd"),
        "workspaceRef": last_result.get("workspaceRef") or input_data.get("workspaceRef"),
        "sandboxName": last_result.get("sandboxName") or input_data.get("sandboxName"),
        "runtimeSandboxName": last_result.get("runtimeSandboxName") or input_data.get("runtimeSandboxName"),
        "outputSync": last_result.get("outputSync"),
        "swebench": last_result.get("swebench"),
    }

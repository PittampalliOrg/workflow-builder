"""Deterministic LIFECYCLE workflow for the `interactive-cli` runtime family.

For direct UI sessions, the user drives the CLI TUI through the web terminal and
the workflow wraps the session lifecycle. For SW 1.0 ``durable/run`` sessions,
the BFF sets ``autoTerminateAfterEndTurn=true`` and provides the kickoff prompt;
this workflow starts the same CLI, waits for the adapter hook that emits
``turn.completed``, then cooperatively closes the pane and returns the standard
durable/run result contract.

History is bounded via ``ctx.continue_as_new`` every ~CLI_LIFECYCLE_MAX_ITERATIONS
when_any cycles, carrying {turnCount, lastAssistantText, paneRef, seeded: true}.
"""

from __future__ import annotations

import logging
import os
from collections import Counter
from datetime import timedelta
from typing import Any, Generator, Mapping

from dapr.ext.workflow import DaprWorkflowContext, RetryPolicy, when_any as wf_when_any

from src.cancellation import TERMINAL_CONTROL_EVENT_TYPES, check_cancellation_activity
from src.cli_lifecycle import probe_cli_activity, start_cli_activity, stop_cli_activity
from src.event_publisher import publish_session_event
from src.output_sync import sync_output_activity
from src.seed import seed_session_activity
from src.taskhub import LIFECYCLE_EVENT_NAME

logger = logging.getLogger(__name__)

CLI_IDLE_PROBE_SECONDS = int(os.environ.get("CLI_IDLE_PROBE_SECONDS", "600"))
CLI_LIFECYCLE_MAX_ITERATIONS = int(os.environ.get("CLI_LIFECYCLE_MAX_ITERATIONS", "50"))

_SEED_RETRY_POLICY = RetryPolicy(
    max_number_of_attempts=3,
    first_retry_interval=timedelta(seconds=5),
    backoff_coefficient=2,
    max_retry_interval=timedelta(seconds=30),
)
_START_RETRY_POLICY = RetryPolicy(
    max_number_of_attempts=2,
    first_retry_interval=timedelta(seconds=5),
    backoff_coefficient=2,
    max_retry_interval=timedelta(seconds=30),
)


def _clean_string(value: Any) -> str | None:
    return value.strip() if isinstance(value, str) and value.strip() else None


def _record(value: Any) -> dict[str, Any]:
    return dict(value) if isinstance(value, Mapping) else {}


def _session_id(input_data: Mapping[str, Any]) -> str | None:
    return _clean_string(input_data.get("sessionId"))


def _extract_seed_user_message(input_data: Mapping[str, Any]) -> str | None:
    """The kickoff prompt — the first ``user.message`` the BFF stamps into
    ``childInput.initialEvents`` at session create (mirrors claude-agent-py).
    Falls back to the ``x-workflow-builder.input`` block for canvas-launched
    runs. Returned to start_cli, which arms the readiness-gated injection."""
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


def _agent_runtime(input_data: Mapping[str, Any]) -> str:
    agent_config = _record(input_data.get("agentConfig"))
    for value in (
        input_data.get("agentRuntime"),
        input_data.get("runtime"),
        agent_config.get("runtime"),
        agent_config.get("agentRuntime"),
    ):
        picked = _clean_string(value)
        if picked:
            return picked
    adapter = _clean_string(agent_config.get("cliAdapter"))
    if adapter == "codex":
        return "codex-cli"
    if adapter == "antigravity":
        return "agy-cli"
    return "claude-code-cli"


def _scope_label(value: Any) -> str | None:
    if value is None:
        return None
    enum_name = getattr(value, "name", None)
    if isinstance(enum_name, str) and enum_name.strip():
        return _scope_label(enum_name)
    text = str(value).strip()
    if not text:
        return None
    compact = text.replace("_", "").replace("-", "").replace(" ", "").lower()
    if compact == "none":
        return "none"
    if compact == "ownhistory":
        return "ownHistory"
    if compact == "lineage":
        return "lineage"
    return text


def _requested_history_scope(input_data: Mapping[str, Any]) -> str:
    propagation = _record(input_data.get("workflowHistoryPropagation"))
    return (
        _scope_label(
            propagation.get("requestedScope")
            or propagation.get("scope")
            or input_data.get("historyPropagation")
        )
        or "none"
    )


_HISTORY_EVENT_FIELDS = (
    "executionStarted",
    "executionCompleted",
    "executionTerminated",
    "executionSuspended",
    "executionResumed",
    "executionStalled",
    "orchestratorStarted",
    "orchestratorCompleted",
    "taskScheduled",
    "taskCompleted",
    "taskFailed",
    "timerCreated",
    "timerFired",
    "eventSent",
    "eventRaised",
    "childWorkflowInstanceCreated",
    "childWorkflowInstanceCompleted",
    "childWorkflowInstanceFailed",
    "subOrchestrationInstanceCreated",
    "subOrchestrationInstanceCompleted",
    "subOrchestrationInstanceFailed",
    "continueAsNew",
)


def _propagated_history_events(history: Any) -> list[Any]:
    events = getattr(history, "events", None)
    if events is None:
        return []
    if isinstance(events, list):
        return events
    try:
        return list(events)
    except TypeError:
        return []


def _history_event_type(event: Any) -> str:
    if isinstance(event, Mapping):
        for key in ("eventType", "type", "kind"):
            value = _clean_string(event.get(key))
            if value:
                return value

    which_oneof = getattr(event, "WhichOneof", None)
    if callable(which_oneof):
        for group_name in ("eventType", "event_type"):
            try:
                selected = _clean_string(which_oneof(group_name))
            except Exception:
                selected = None
            if selected:
                return selected

    has_field = getattr(event, "HasField", None)
    if callable(has_field):
        for field_name in _HISTORY_EVENT_FIELDS:
            try:
                if has_field(field_name):
                    return field_name
            except Exception:
                continue

    for field_name in _HISTORY_EVENT_FIELDS:
        value = getattr(event, field_name, None)
        if value:
            return field_name

    return event.__class__.__name__


def _workflow_history_provenance(
    ctx: DaprWorkflowContext,
    input_data: Mapping[str, Any],
    agent_runtime: str,
) -> dict[str, Any]:
    requested_scope = _requested_history_scope(input_data)
    history = None
    get_history = getattr(ctx, "get_propagated_history", None)
    if callable(get_history):
        try:
            history = get_history()
        except Exception:
            history = None

    events = _propagated_history_events(history)
    event_type_counts = Counter(_history_event_type(event) for event in events)
    metadata = _record(input_data.get("_message_metadata"))
    return {
        "workflowHistoryPropagation": {
            "scope": _scope_label(getattr(history, "scope", None)) or requested_scope,
            "available": bool(events),
            "eventCount": len(events),
            "eventTypeCounts": dict(sorted(event_type_counts.items())),
        },
        "workflowContext": {
            "workflowId": input_data.get("workflowId") or metadata.get("workflowId"),
            "workflowExecutionId": input_data.get("workflowExecutionId")
            or input_data.get("dbExecutionId")
            or input_data.get("executionId")
            or metadata.get("workflowExecutionId")
            or metadata.get("executionId"),
            "nodeId": input_data.get("nodeId") or metadata.get("nodeId"),
            "agentRuntime": agent_runtime,
        },
    }


def _event_batch(payload: Any) -> list[dict[str, Any]]:
    if isinstance(payload, Mapping):
        events = payload.get("events")
        if isinstance(events, list):
            return [dict(event) for event in events if isinstance(event, Mapping)]
        return [dict(payload)]
    return []


def _result_contract(
    *,
    ctx: DaprWorkflowContext,
    session_id: str | None,
    status: str,
    last_assistant_text: str,
    turn_count: int,
    agent_runtime: str,
    provenance: Mapping[str, Any],
    output_sync: Mapping[str, Any] | None = None,
) -> dict[str, Any]:
    result = {
        "success": status not in ("failed",),
        "status": status,
        "output": last_assistant_text or "",
        "content": last_assistant_text or "",
        "sessionId": session_id,
        "agentRuntime": agent_runtime,
        "childWorkflowName": "session_workflow",
        "daprInstanceId": ctx.instance_id,
        "turnCount": turn_count,
        "provenance": dict(provenance),
    }
    if output_sync is not None:
        result["outputSync"] = dict(output_sync)
    return result


def _terminal_stop_reason(status: str | None, reason: str | None) -> dict[str, str]:
    if status == "terminated":
        return {"type": "terminated"}
    if status == "failed":
        return {"type": "interrupted"}
    if reason in {"cancel_requested", "session.terminate", "terminate"}:
        return {"type": "terminated"}
    return {"type": "end_turn"}


def session_workflow(
    ctx: DaprWorkflowContext, input_data: dict[str, Any]
) -> Generator[Any, Any, dict[str, Any] | None]:
    session_id = _session_id(input_data)
    auto_terminate = bool(input_data.get("autoTerminateAfterEndTurn"))
    agent_runtime = _agent_runtime(input_data)
    provenance = _workflow_history_provenance(ctx, input_data, agent_runtime)
    carried = _record(input_data.get("_carried"))
    carried_provenance = carried.get("provenance")
    if (
        isinstance(carried_provenance, Mapping)
        and not provenance["workflowHistoryPropagation"]["available"]
    ):
        provenance = dict(carried_provenance)
    seeded = bool(carried.get("seeded"))
    turn_count = int(carried.get("turnCount") or 0)
    last_assistant_text = str(carried.get("lastAssistantText") or "")
    pane_ref = _clean_string(carried.get("paneRef"))

    if not seeded:
        if session_id and not ctx.is_replaying:
            publish_session_event(session_id, "session.status_starting", {})
        seed_result = yield ctx.call_activity(
            seed_session_activity,
            input=dict(input_data),
            retry_policy=_SEED_RETRY_POLICY,
        )
        start_result = yield ctx.call_activity(
            start_cli_activity,
            input={
                "sessionId": session_id,
                "instanceId": ctx.instance_id,
                "agentConfig": _record(input_data.get("agentConfig")),
                "seed": _record(seed_result),
                # Kickoff prompt: start_cli arms a readiness-gated injection so
                # it is typed into the TUI only once it has booted to its prompt.
                "seedUserMessage": _extract_seed_user_message(input_data),
                "workspaceRef": input_data.get("workspaceRef"),
                "sandboxName": input_data.get("sandboxName"),
            },
            retry_policy=_START_RETRY_POLICY,
        )
        pane_ref = _clean_string(_record(start_result).get("paneRef"))

    status: str | None = None
    reason: str | None = None
    iterations = 0
    while status is None:
        iterations += 1
        if iterations > CLI_LIFECYCLE_MAX_ITERATIONS:
            ctx.continue_as_new(
                {
                    **input_data,
                    "_carried": {
                        "seeded": True,
                        "turnCount": turn_count,
                        "lastAssistantText": last_assistant_text,
                        "paneRef": pane_ref,
                        "provenance": provenance,
                    },
                }
            )
            return None

        event_task = ctx.wait_for_external_event(LIFECYCLE_EVENT_NAME)
        timer_task = ctx.create_timer(timedelta(seconds=CLI_IDLE_PROBE_SECONDS))
        winner = yield wf_when_any([event_task, timer_task])

        if winner is timer_task:
            # Out-of-band liveness probe — also honors a cooperative-cancel
            # flag persisted by the raise-event endpoint in case the raised
            # terminal event was lost.
            cancellation = yield ctx.call_activity(
                check_cancellation_activity, input={"instanceId": ctx.instance_id}
            )
            if isinstance(cancellation, Mapping) and cancellation.get("cancelled"):
                status, reason = "terminated", "cancel_requested"
                break
            probe = yield ctx.call_activity(
                probe_cli_activity,
                input={
                    "paneRef": pane_ref,
                    "sessionId": session_id,
                    "instanceId": ctx.instance_id,
                },
            )
            probe_data = _record(probe)
            if probe_data.get("terminal"):
                status = _clean_string(probe_data.get("status")) or "completed"
                reason = _clean_string(probe_data.get("reason")) or "cli_exited"
                break
            continue

        for event in _event_batch(winner.get_result()):
            event_type = event.get("type")
            if event_type == "turn.completed":
                turn_count += 1
                text = _clean_string(
                    event.get("lastAssistantText") or event.get("content")
                )
                if text:
                    last_assistant_text = text
                if session_id and not ctx.is_replaying:
                    publish_session_event(
                        session_id,
                        "session.turn_completed",
                        {
                            "turn": turn_count,
                            "turnId": f"{ctx.instance_id}:turn:{turn_count}",
                            "workflowInstanceId": ctx.instance_id,
                            "agentRuntime": agent_runtime,
                            "reason": "turn_completed",
                            "hasOutput": bool(last_assistant_text),
                            "output_preview": last_assistant_text[:500],
                        },
                        source_event_id=(
                            f"{ctx.instance_id}:turn:{turn_count}:completed"
                        ),
                    )
                if auto_terminate:
                    status, reason = "completed", "turn_completed"
                    break
                continue
            if event_type in ("cli.session_end", "cli.exited"):
                exit_code = event.get("exitCode")
                status = "completed" if exit_code in (None, 0) else "failed"
                reason = _clean_string(event.get("reason")) or str(event_type)
                break
            if event_type in TERMINAL_CONTROL_EVENT_TYPES or event_type == "terminate":
                status, reason = "terminated", str(event_type)
                break

    # Cooperative close — idempotent; tolerates the pane already being gone.
    yield ctx.call_activity(
        stop_cli_activity,
        input={
            "paneRef": pane_ref,
            "sessionId": session_id,
            "instanceId": ctx.instance_id,
            "reason": reason,
        },
    )

    if session_id and not ctx.is_replaying:
        publish_session_event(
            session_id,
            "session.status_terminated",
            {
                "reason": reason or status,
                "stop_reason": _terminal_stop_reason(status, reason),
                "status": status,
                "success": status not in ("failed",),
                "turnCount": turn_count,
                "agentRuntime": agent_runtime,
                "workflowInstanceId": ctx.instance_id,
            },
        )
    output_sync_result = None
    if status == "completed" and isinstance(input_data.get("outputSync"), Mapping):
        output_sync_result = yield ctx.call_activity(
            sync_output_activity,
            input={
                "outputSync": input_data.get("outputSync"),
                "sandboxName": input_data.get("sandboxName"),
                "workspaceSandboxName": input_data.get("workspaceSandboxName"),
                "workspaceRef": input_data.get("workspaceRef"),
                "sessionId": session_id,
                "instanceId": ctx.instance_id,
            },
        )
        if isinstance(output_sync_result, Mapping) and not output_sync_result.get("ok"):
            status = "failed"
            error = _clean_string(output_sync_result.get("error")) or "outputSync failed"
            last_assistant_text = (
                f"{last_assistant_text}\n\nOutput sync failed: {error}"
                if last_assistant_text
                else f"Output sync failed: {error}"
            )
    return _result_contract(
        ctx=ctx,
        session_id=session_id,
        status=status,
        last_assistant_text=last_assistant_text,
        turn_count=turn_count,
        agent_runtime=agent_runtime,
        provenance=provenance,
        output_sync=output_sync_result if isinstance(output_sync_result, Mapping) else None,
    )

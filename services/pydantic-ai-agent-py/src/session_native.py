"""Helpers for the session-native Dapr agent workflow loop."""

from __future__ import annotations

from collections.abc import Iterable
from typing import Any


SESSION_NATIVE_AGENT_WORKFLOW_MODE = "session-native"
SESSION_WORKFLOW_STATE_KEY = "sessionWorkflowState"
SESSION_TERMINATE_EVENT_TYPE = "session.terminate"
USER_INTERRUPT_EVENT_TYPE = "user.interrupt"
TEAM_MAILBOX_DELIVERY_KIND = "team-mailbox"


def _positive_int(value: Any) -> int | None:
    if value is None or isinstance(value, bool):
        return None
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        return None
    return parsed if parsed > 0 else None


def session_workflow_instance_id(ctx_instance_id: Any, session_id: str) -> str:
    """Return the Dapr workflow instance that owns the session loop."""
    text = str(ctx_instance_id or "").strip()
    return text or str(session_id or "").strip()


def logical_turn_id(session_id: str, turn: int) -> str:
    """Return a logical turn id. This is not a Dapr workflow instance id."""
    return f"{session_id}:turn-{int(turn)}"


def session_native_event_fields(workflow_instance_id: str) -> dict[str, str]:
    return {
        "agentWorkflowMode": SESSION_NATIVE_AGENT_WORKFLOW_MODE,
        "workflowInstanceId": workflow_instance_id,
    }


def terminal_stop_reason_from_events(
    events: list[dict[str, Any]],
) -> dict[str, str] | None:
    """Return the terminal stop reason for a pending session event batch, if any."""
    for event in events:
        if not isinstance(event, dict):
            continue
        event_type = event.get("type")
        if event_type == USER_INTERRUPT_EVENT_TYPE:
            reason: dict[str, str] = {"type": "interrupted"}
            if event.get("reason") is not None:
                reason["reason"] = str(event.get("reason"))
            if event.get("source") is not None:
                reason["source"] = str(event.get("source"))
            return reason
        if event_type == SESSION_TERMINATE_EVENT_TYPE:
            reason = {"type": "terminated"}
            if event.get("reason") is not None:
                reason["reason"] = str(event.get("reason"))
            if event.get("source") is not None:
                reason["source"] = str(event.get("source"))
            return reason
    return None


def session_workflow_state_from_message(message: dict[str, Any]) -> dict[str, Any]:
    raw = message.get(SESSION_WORKFLOW_STATE_KEY)
    state = dict(raw) if isinstance(raw, dict) else {}
    turn_counter = _positive_int(state.get("turnCounter")) or 0
    config_revision = _positive_int(state.get("configRevision")) or 1
    continuation_count = _positive_int(state.get("continuationCount")) or 0
    overrides = state.get("controlOverrideFields")
    if isinstance(overrides, Iterable) and not isinstance(
        overrides, (str, bytes, bytearray)
    ):
        control_override_fields = sorted(
            {str(item).strip() for item in overrides if str(item).strip()}
        )
    else:
        control_override_fields = []
    team_mailbox_batch_ids = _string_id_list(state.get("teamMailboxBatchIds"))
    team_mailbox_event_ids = _string_id_list(state.get("teamMailboxEventIds"))
    return {
        "turnCounter": turn_counter,
        "configRevision": config_revision,
        "continuationCount": continuation_count,
        "controlOverrideFields": control_override_fields,
        "teamMailboxBatchIds": team_mailbox_batch_ids,
        "teamMailboxEventIds": team_mailbox_event_ids,
    }


def _string_id_list(value: Any) -> list[str]:
    if not isinstance(value, Iterable) or isinstance(value, (str, bytes, bytearray)):
        return []
    return sorted({str(item).strip() for item in value if str(item).strip()})


def accept_team_mailbox_delivery(
    batch: Any,
    *,
    accepted_batch_ids: set[str],
    accepted_event_ids: set[str],
) -> list[dict[str, Any]]:
    """Deduplicate accepted team mailbox events in durable workflow state."""
    if not isinstance(batch, dict):
        return []
    raw_events = batch.get("events")
    events = (
        [event for event in raw_events if isinstance(event, dict)]
        if isinstance(raw_events, list)
        else []
    )
    delivery = batch.get("delivery")
    if (
        not isinstance(delivery, dict)
        or delivery.get("kind") != TEAM_MAILBOX_DELIVERY_KIND
    ):
        return events

    batch_id = str(delivery.get("batchId") or "").strip()
    raw_event_ids = delivery.get("eventIds")
    if (
        not batch_id
        or not isinstance(raw_event_ids, list)
        or len(raw_event_ids) != len(raw_events or [])
        or len(events) != len(raw_events or [])
    ):
        return events
    event_ids = [str(event_id or "").strip() for event_id in raw_event_ids]
    if not all(event_ids):
        return events
    if batch_id in accepted_batch_ids:
        return []

    accepted_batch_ids.add(batch_id)
    pending: list[dict[str, Any]] = []
    for event_id, event in zip(event_ids, events, strict=True):
        if event_id in accepted_event_ids:
            continue
        accepted_event_ids.add(event_id)
        pending.append(event)
    return pending


def should_continue_session_as_new(
    *,
    auto_terminate: bool,
    turn_counter: int,
    compaction_runs: int,
    continue_as_new_turn_threshold: int | None,
    continue_as_new_after_compactions: int | None,
) -> tuple[bool, str | None]:
    """Decide whether a long-lived session should compact workflow history."""
    if auto_terminate:
        return False, None
    turn_threshold = _positive_int(continue_as_new_turn_threshold)
    if turn_threshold and turn_counter >= turn_threshold:
        return True, "turn_threshold"
    compaction_threshold = _positive_int(continue_as_new_after_compactions)
    if compaction_threshold and compaction_runs >= compaction_threshold:
        return True, "compaction_threshold"
    return False, None


def build_continue_as_new_input(
    *,
    message: dict[str, Any],
    agent_config: dict[str, Any],
    pending_events: list[dict[str, Any]],
    turn_counter: int,
    config_revision: int,
    control_override_fields: set[str],
    continuation_count: int,
    reason: str,
    team_mailbox_batch_ids: set[str] | None = None,
    team_mailbox_event_ids: set[str] | None = None,
) -> dict[str, Any]:
    """Build the next session_workflow input while keeping agent state external."""
    next_message = dict(message)
    next_message["agentConfig"] = dict(agent_config or {})
    next_message["initialEvents"] = list(pending_events or [])
    next_message[SESSION_WORKFLOW_STATE_KEY] = {
        "turnCounter": int(turn_counter),
        "configRevision": int(config_revision),
        "controlOverrideFields": sorted(control_override_fields),
        "continuationCount": int(continuation_count) + 1,
        "lastContinueAsNewReason": reason,
        "teamMailboxBatchIds": sorted(team_mailbox_batch_ids or set()),
        "teamMailboxEventIds": sorted(team_mailbox_event_ids or set()),
    }
    return next_message

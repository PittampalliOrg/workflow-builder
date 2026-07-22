"""Helpers for the session-native Dapr agent workflow loop."""

from __future__ import annotations

from collections.abc import Iterable
from typing import Any

from src.config import DURABLE_ERROR_MAX_BYTES


SESSION_NATIVE_AGENT_WORKFLOW_MODE = "session-native"
SESSION_WORKFLOW_STATE_KEY = "sessionWorkflowState"
SESSION_TERMINATE_EVENT_TYPE = "session.terminate"
USER_INTERRUPT_EVENT_TYPE = "user.interrupt"
TEAM_MAILBOX_DELIVERY_KIND = "team-mailbox"
TEAM_MAILBOX_BATCH_ID_WINDOW = 128
TEAM_MAILBOX_EVENT_ID_WINDOW = 512
TEAM_MAILBOX_ID_MAX_BYTES = 256


def _bounded_event_text(value: Any) -> str:
    encoded = str(value or "").encode("utf-8")
    return encoded[:DURABLE_ERROR_MAX_BYTES].decode("utf-8", errors="ignore")


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
                reason["reason"] = _bounded_event_text(event.get("reason"))
            if event.get("source") is not None:
                reason["source"] = _bounded_event_text(event.get("source"))
            return reason
        if event_type == SESSION_TERMINATE_EVENT_TYPE:
            reason = {"type": "terminated"}
            if event.get("reason") is not None:
                reason["reason"] = _bounded_event_text(event.get("reason"))
            if event.get("source") is not None:
                reason["source"] = _bounded_event_text(event.get("source"))
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
    team_mailbox_batch_ids = _bounded_id_list(
        state.get("teamMailboxBatchIds"), max_items=TEAM_MAILBOX_BATCH_ID_WINDOW
    )
    team_mailbox_event_ids = _bounded_id_list(
        state.get("teamMailboxEventIds"), max_items=TEAM_MAILBOX_EVENT_ID_WINDOW
    )
    return {
        "turnCounter": turn_counter,
        "configRevision": config_revision,
        "continuationCount": continuation_count,
        "controlOverrideFields": control_override_fields,
        "teamMailboxBatchIds": team_mailbox_batch_ids,
        "teamMailboxEventIds": team_mailbox_event_ids,
    }


def _bounded_id(value: Any) -> str | None:
    text = str(value or "").strip()
    if not text or len(text.encode("utf-8")) > TEAM_MAILBOX_ID_MAX_BYTES:
        return None
    return text


def _bounded_id_list(value: Any, *, max_items: int) -> list[str]:
    if not isinstance(value, Iterable) or isinstance(value, (str, bytes, bytearray)):
        return []
    items = sorted(value, key=str) if isinstance(value, (set, frozenset)) else value
    ordered: list[str] = []
    seen: set[str] = set()
    for item in items:
        identifier = _bounded_id(item)
        if identifier is None or identifier in seen:
            continue
        seen.add(identifier)
        ordered.append(identifier)
    return ordered[-max_items:]


def _remember_recent_id(identifiers: list[str], identifier: str, *, max_items: int) -> None:
    identifiers.append(identifier)
    overflow = len(identifiers) - max_items
    if overflow > 0:
        del identifiers[:overflow]


def accept_team_mailbox_delivery(
    batch: Any,
    *,
    accepted_batch_ids: list[str],
    accepted_event_ids: list[str],
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

    batch_id = _bounded_id(delivery.get("batchId"))
    raw_event_ids = delivery.get("eventIds")
    if (
        batch_id is None
        or not isinstance(raw_event_ids, list)
        or len(raw_event_ids) != len(raw_events or [])
        or len(events) != len(raw_events or [])
    ):
        return events
    event_ids = [_bounded_id(event_id) for event_id in raw_event_ids]
    if not all(event_ids):
        return events
    if batch_id in accepted_batch_ids:
        return []

    _remember_recent_id(
        accepted_batch_ids,
        batch_id,
        max_items=TEAM_MAILBOX_BATCH_ID_WINDOW,
    )
    pending: list[dict[str, Any]] = []
    for event_id, event in zip(event_ids, events, strict=True):
        assert event_id is not None
        if event_id in accepted_event_ids:
            continue
        _remember_recent_id(
            accepted_event_ids,
            event_id,
            max_items=TEAM_MAILBOX_EVENT_ID_WINDOW,
        )
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
    history_ref: str | None,
    pending_events: list[dict[str, Any]],
    turn_counter: int,
    config_revision: int,
    control_override_fields: set[str],
    continuation_count: int,
    reason: str,
    team_mailbox_batch_ids: Iterable[str] | None = None,
    team_mailbox_event_ids: Iterable[str] | None = None,
) -> dict[str, Any]:
    """Build one bounded rollover input while keeping agent history external."""
    next_message = dict(message)
    next_message.pop("history", None)
    if isinstance(history_ref, str) and history_ref:
        next_message["historyRef"] = history_ref
    else:
        next_message.pop("historyRef", None)
    next_message["agentConfig"] = dict(agent_config or {})
    next_message["initialEvents"] = list(pending_events or [])
    next_message[SESSION_WORKFLOW_STATE_KEY] = {
        "turnCounter": int(turn_counter),
        "configRevision": int(config_revision),
        "controlOverrideFields": sorted(control_override_fields),
        "continuationCount": int(continuation_count) + 1,
        "lastContinueAsNewReason": reason,
        "teamMailboxBatchIds": _bounded_id_list(
            team_mailbox_batch_ids or [], max_items=TEAM_MAILBOX_BATCH_ID_WINDOW
        ),
        "teamMailboxEventIds": _bounded_id_list(
            team_mailbox_event_ids or [], max_items=TEAM_MAILBOX_EVENT_ID_WINDOW
        ),
    }
    return next_message

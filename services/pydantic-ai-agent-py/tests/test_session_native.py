from __future__ import annotations

from src.session_native import (
    TEAM_MAILBOX_BATCH_ID_WINDOW,
    TEAM_MAILBOX_EVENT_ID_WINDOW,
    TEAM_MAILBOX_ID_MAX_BYTES,
    accept_team_mailbox_delivery,
    build_continue_as_new_input,
    session_workflow_state_from_message,
)


def test_team_mailbox_delivery_deduplicates_same_and_regrouped_events() -> None:
    batches: list[str] = []
    events: list[str] = []
    event_1 = {"type": "user.message", "content": [{"type": "text", "text": "a"}]}
    event_2 = {"type": "user.message", "content": [{"type": "text", "text": "b"}]}

    first = {
        "events": [event_1],
        "delivery": {
            "kind": "team-mailbox",
            "batchId": "batch-a",
            "eventIds": ["event-1"],
        },
    }
    assert accept_team_mailbox_delivery(
        first, accepted_batch_ids=batches, accepted_event_ids=events
    ) == [event_1]
    assert (
        accept_team_mailbox_delivery(
            first, accepted_batch_ids=batches, accepted_event_ids=events
        )
        == []
    )

    regrouped = {
        "events": [event_1, event_2],
        "delivery": {
            "kind": "team-mailbox",
            "batchId": "batch-b",
            "eventIds": ["event-1", "event-2"],
        },
    }
    assert accept_team_mailbox_delivery(
        regrouped, accepted_batch_ids=batches, accepted_event_ids=events
    ) == [event_2]
    assert batches == ["batch-a", "batch-b"]
    assert events == ["event-1", "event-2"]


def test_pre_runtime_team_event_receipt_starts_exactly_one_model_turn() -> None:
    accepted_batches: list[str] = []
    accepted_events: list[str] = []
    team_event = {
        "type": "user.message",
        "origin": "teammate-message",
        "content": [{"type": "text", "text": "review this"}],
    }
    delivery = {
        "events": [team_event],
        "delivery": {
            "kind": "team-mailbox",
            "batchId": "team-mailbox:stable",
            "eventIds": ["pre-runtime-event-1"],
        },
    }

    turns = [
        pending
        for pending in (
            accept_team_mailbox_delivery(
                delivery,
                accepted_batch_ids=accepted_batches,
                accepted_event_ids=accepted_events,
            )
            for _ in range(2)
        )
        if pending
    ]

    assert turns == [[team_event]]
    assert accepted_batches == ["team-mailbox:stable"]
    assert accepted_events == ["pre-runtime-event-1"]


def test_receipts_restore_from_durable_session_state() -> None:
    state = session_workflow_state_from_message(
        {
            "sessionWorkflowState": {
                "teamMailboxBatchIds": ["batch-b", "batch-a", "batch-a"],
                "teamMailboxEventIds": ["event-2", "event-1", "event-1"],
            }
        }
    )
    assert state["teamMailboxBatchIds"] == ["batch-b", "batch-a"]
    assert state["teamMailboxEventIds"] == ["event-2", "event-1"]


def test_receipt_windows_keep_recent_bounded_valid_ids_in_insertion_order() -> None:
    exact_utf8_limit = "\u00e9" * (TEAM_MAILBOX_ID_MAX_BYTES // 2)
    too_long = exact_utf8_limit + "\u00e9"
    batch_ids = [too_long, *(f"batch-{index}" for index in range(140)), exact_utf8_limit]
    event_ids = [too_long, *(f"event-{index}" for index in range(530))]

    state = session_workflow_state_from_message(
        {
            "sessionWorkflowState": {
                "teamMailboxBatchIds": batch_ids,
                "teamMailboxEventIds": event_ids,
            }
        }
    )

    assert state["teamMailboxBatchIds"] == batch_ids[-TEAM_MAILBOX_BATCH_ID_WINDOW:]
    assert state["teamMailboxEventIds"] == event_ids[-TEAM_MAILBOX_EVENT_ID_WINDOW:]
    assert all(
        len(identifier.encode("utf-8")) <= TEAM_MAILBOX_ID_MAX_BYTES
        for identifier in (
            *state["teamMailboxBatchIds"],
            *state["teamMailboxEventIds"],
        )
    )


def test_team_mailbox_delivery_evicts_oldest_receipts_deterministically() -> None:
    batches = [
        f"batch-{index}" for index in range(TEAM_MAILBOX_BATCH_ID_WINDOW)
    ]
    events = [
        f"event-{index}" for index in range(TEAM_MAILBOX_EVENT_ID_WINDOW)
    ]
    event = {"type": "user.message", "content": [{"type": "text", "text": "new"}]}

    assert accept_team_mailbox_delivery(
        {
            "events": [event],
            "delivery": {
                "kind": "team-mailbox",
                "batchId": "batch-new",
                "eventIds": ["event-new"],
            },
        },
        accepted_batch_ids=batches,
        accepted_event_ids=events,
    ) == [event]

    assert len(batches) == TEAM_MAILBOX_BATCH_ID_WINDOW
    assert batches[0] == "batch-1"
    assert batches[-1] == "batch-new"
    assert len(events) == TEAM_MAILBOX_EVENT_ID_WINDOW
    assert events[0] == "event-1"
    assert events[-1] == "event-new"

    continued = build_continue_as_new_input(
        message={"sessionId": "session-1"},
        agent_config={},
        history_ref=None,
        pending_events=[],
        turn_counter=1,
        config_revision=1,
        control_override_fields=set(),
        continuation_count=0,
        reason="turn_complete",
        team_mailbox_batch_ids=batches,
        team_mailbox_event_ids=events,
    )
    durable_state = continued["sessionWorkflowState"]
    assert durable_state["teamMailboxBatchIds"] == batches
    assert durable_state["teamMailboxEventIds"] == events


def test_continue_as_new_input_carries_reference_and_compact_session_state() -> None:
    continued = build_continue_as_new_input(
        message={
            "sessionId": "session-1",
            "history": [{"kind": "legacy"}],
            "historyRef": "history+sha256://" + "0" * 64,
            "unchanged": True,
        },
        agent_config={"modelSpec": "kimi/kimi-k3"},
        history_ref="history+sha256://" + "1" * 64,
        pending_events=[],
        turn_counter=7,
        config_revision=3,
        control_override_fields={"tools", "modelSpec"},
        continuation_count=2,
        reason="turn_complete",
        team_mailbox_batch_ids={"batch-b", "batch-a"},
        team_mailbox_event_ids={"event-2", "event-1"},
    )

    assert continued["historyRef"] == "history+sha256://" + "1" * 64
    assert "history" not in continued
    assert continued["agentConfig"] == {"modelSpec": "kimi/kimi-k3"}
    assert continued["initialEvents"] == []
    assert continued["unchanged"] is True
    assert continued["sessionWorkflowState"] == {
        "turnCounter": 7,
        "configRevision": 3,
        "controlOverrideFields": ["modelSpec", "tools"],
        "continuationCount": 3,
        "lastContinueAsNewReason": "turn_complete",
        "teamMailboxBatchIds": ["batch-a", "batch-b"],
        "teamMailboxEventIds": ["event-1", "event-2"],
    }


def test_continue_as_new_input_clears_stale_history_references() -> None:
    continued = build_continue_as_new_input(
        message={
            "sessionId": "session-1",
            "history": [{"kind": "legacy"}],
            "historyRef": "history+sha256://" + "0" * 64,
        },
        agent_config={},
        history_ref=None,
        pending_events=[],
        turn_counter=1,
        config_revision=1,
        control_override_fields=set(),
        continuation_count=0,
        reason="turn_complete",
    )

    assert "history" not in continued
    assert "historyRef" not in continued

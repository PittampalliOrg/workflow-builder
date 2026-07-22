from __future__ import annotations

from src.session_native import (
    accept_team_mailbox_delivery,
    session_workflow_state_from_message,
)


def test_team_mailbox_delivery_deduplicates_same_and_regrouped_events() -> None:
    batches: set[str] = set()
    events: set[str] = set()
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
    assert batches == {"batch-a", "batch-b"}
    assert events == {"event-1", "event-2"}


def test_pre_runtime_team_event_receipt_starts_exactly_one_model_turn() -> None:
    accepted_batches: set[str] = set()
    accepted_events: set[str] = set()
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
    assert accepted_batches == {"team-mailbox:stable"}
    assert accepted_events == {"pre-runtime-event-1"}


def test_receipts_restore_from_durable_session_state() -> None:
    state = session_workflow_state_from_message(
        {
            "sessionWorkflowState": {
                "teamMailboxBatchIds": ["batch-b", "batch-a", "batch-a"],
                "teamMailboxEventIds": ["event-2", "event-1", "event-1"],
            }
        }
    )
    assert state["teamMailboxBatchIds"] == ["batch-a", "batch-b"]
    assert state["teamMailboxEventIds"] == ["event-1", "event-2"]

from __future__ import annotations

from typing import Any

import pytest

import src.taskhub as taskhub


def test_raise_lifecycle_events_retries_transient_taskhub_failure(monkeypatch):
    calls: list[tuple[str, Any]] = []

    def flaky_raise(instance_id: str, event_name: str, payload: Any) -> None:
        calls.append((event_name, payload))
        if len(calls) == 1:
            raise RuntimeError("dapr temporarily unavailable")

    monkeypatch.setattr(taskhub, "raise_event", flaky_raise)
    monkeypatch.setattr(taskhub.time, "sleep", lambda _seconds: None)
    monkeypatch.setenv("TASKHUB_LIFECYCLE_RAISE_ATTEMPTS", "2")

    taskhub.raise_lifecycle_events("session-1", [{"type": "turn.completed"}])

    assert len(calls) == 2
    assert calls[0][0] == taskhub.LIFECYCLE_EVENT_NAME
    assert calls[1][1] == {"events": [{"type": "turn.completed"}]}


def test_raise_lifecycle_events_raises_after_retry_budget(monkeypatch):
    calls = 0

    def always_fails(_instance_id: str, _event_name: str, _payload: Any) -> None:
        nonlocal calls
        calls += 1
        raise RuntimeError("still unavailable")

    monkeypatch.setattr(taskhub, "raise_event", always_fails)
    monkeypatch.setattr(taskhub.time, "sleep", lambda _seconds: None)
    monkeypatch.setenv("TASKHUB_LIFECYCLE_RAISE_ATTEMPTS", "3")

    with pytest.raises(RuntimeError, match="still unavailable"):
        taskhub.raise_lifecycle_events("session-1", [{"type": "turn.completed"}])

    assert calls == 3

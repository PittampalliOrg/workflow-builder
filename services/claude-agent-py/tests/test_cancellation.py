from __future__ import annotations

import src.cancellation as c
from src.session_config import (
    TERMINAL_CONTROL_EVENT_TYPES,
    external_control_event_as_user_event,
)


def test_candidate_ids_turn_and_base():
    assert c._cancellation_candidate_ids("sess__turn__3") == ["sess__turn__3", "sess"]
    assert c._cancellation_candidate_ids("sess:turn-2") == ["sess:turn-2", "sess"]
    assert c._cancellation_candidate_ids("sess") == ["sess"]
    assert c._cancellation_candidate_ids("") == []


def test_session_cancel_state_key():
    assert c._session_cancel_state_key("abc") == "session-cancel:abc"


def test_check_cancellation_found_under_base(monkeypatch):
    # flag stored under the base session id; reading with a turn-scoped id still finds it
    store = {"session-cancel:sess": {"type": "session.terminate", "reason": "x"}}
    monkeypatch.setattr(
        c, "_read_agent_state_key", lambda key, timeout_seconds=1: store.get(key)
    )
    res = c.check_cancellation_for_instance("sess__turn__5")
    assert res["cancelled"] is True
    assert res["request"]["type"] == "session.terminate"


def test_check_cancellation_absent(monkeypatch):
    monkeypatch.setattr(c, "_read_agent_state_key", lambda key, timeout_seconds=1: None)
    assert c.check_cancellation_for_instance("sess")["cancelled"] is False
    assert c.check_cancellation_for_instance("")["cancelled"] is False


def test_save_cancellation_request_shape(monkeypatch):
    saved: dict = {}
    monkeypatch.setattr(
        c,
        "_save_agent_state_key",
        lambda key, value: saved.update({"key": key, "value": value}),
    )
    c._save_session_cancellation_request("sess", "user.interrupt", {"reason": "stop"})
    assert saved["key"] == "session-cancel:sess"
    assert saved["value"]["type"] == "user.interrupt"
    assert saved["value"]["reason"] == "stop"


def test_check_cancellation_activity(monkeypatch):
    monkeypatch.setattr(
        c, "_read_agent_state_key", lambda key, timeout_seconds=1: {"type": "session.terminate"}
    )
    assert c.check_cancellation_activity(None, {"instanceId": "sess"})["cancelled"] is True
    monkeypatch.setattr(c, "_read_agent_state_key", lambda key, timeout_seconds=1: None)
    assert c.check_cancellation_activity(None, {"instance_id": "sess"})["cancelled"] is False


def test_terminal_events_mapped_to_user_events():
    assert TERMINAL_CONTROL_EVENT_TYPES == {"session.terminate", "user.interrupt"}
    for ev in TERMINAL_CONTROL_EVENT_TYPES:
        name, payload = external_control_event_as_user_event(ev, {"reason": "x"})
        assert name == "session.user_events"
        assert payload["events"][0]["type"] == ev
        assert payload["events"][0]["reason"] == "x"


def test_non_control_event_passthrough():
    name, payload = external_control_event_as_user_event("some.other.event", {"a": 1})
    assert name == "some.other.event"
    assert payload == {"a": 1}

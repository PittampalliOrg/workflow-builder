from __future__ import annotations

from typing import Any, Mapping


CONTROL_EVENT_TYPES = {
    "session.control.update_agent_config",
    "session.control.set_model",
    "session.control.set_permission_mode",
}


def external_control_event_as_user_event(
    event_name: str,
    payload: Any,
) -> tuple[str, Any]:
    """Map direct control events onto the session.user_events lane."""
    if event_name not in CONTROL_EVENT_TYPES:
        return event_name, payload
    event: dict[str, Any] = {"type": event_name}
    if isinstance(payload, Mapping):
        event.update(dict(payload))
    else:
        event["data"] = payload
    return "session.user_events", {"events": [event]}

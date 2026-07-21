from __future__ import annotations

from copy import deepcopy
from typing import Any, Mapping


SESSION_CONFIG_UPDATE_EVENT = "session.control.update_agent_config"
LEGACY_SET_MODEL_EVENT = "session.control.set_model"
LEGACY_SET_PERMISSION_MODE_EVENT = "session.control.set_permission_mode"
CONTROL_EVENT_TYPES = {
    SESSION_CONFIG_UPDATE_EVENT,
    LEGACY_SET_MODEL_EVENT,
    LEGACY_SET_PERMISSION_MODE_EVENT,
}
TERMINAL_CONTROL_EVENT_TYPES = {
    "session.terminate",
    "user.interrupt",
}


def session_event_batch(payload: Any) -> list[dict[str, Any]]:
    if not isinstance(payload, Mapping):
        return []
    events = payload.get("events")
    if isinstance(events, list):
        return [dict(event) for event in events if isinstance(event, Mapping)]
    return [dict(payload)]


_STRING_FIELDS = {
    "modelSpec",
    "role",
    "goal",
    "systemPrompt",
    "toolChoice",
    "permissionMode",
    "mcpConnectionMode",
}
_STRING_LIST_FIELDS = {
    "tools",
    "allowedTools",
    "builtinTools",
    "instructions",
    "styleGuidelines",
    "plugins",
    "mcpConnectionWarnings",
}
_NUMBER_FIELDS = {
    "maxTurns",
    "maxIterations",
    "temperature",
    "timeoutMinutes",
}
_OBJECT_LIST_FIELDS = {
    "mcpServers",
    "skills",
}
_PASSTHROUGH_OBJECT_FIELDS = {
    "compaction",
}
_PATCH_FIELDS = (
    _STRING_FIELDS
    | _STRING_LIST_FIELDS
    | _NUMBER_FIELDS
    | _OBJECT_LIST_FIELDS
    | _PASSTHROUGH_OBJECT_FIELDS
)


def _record(value: Any) -> dict[str, Any] | None:
    if isinstance(value, Mapping):
        return dict(value)
    return None


def _string(value: Any) -> str | None:
    if not isinstance(value, str):
        return None
    text = value.strip()
    return text or None


def _string_list(value: Any) -> list[str] | None:
    if not isinstance(value, list):
        return None
    items = [str(item).strip() for item in value if str(item).strip()]
    return items


def _number(value: Any) -> int | float | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        return value
    if isinstance(value, str) and value.strip():
        try:
            parsed = float(value)
        except ValueError:
            return None
        return int(parsed) if parsed.is_integer() else parsed
    return None


def _object_list(value: Any) -> list[dict[str, Any]] | None:
    if not isinstance(value, list):
        return None
    return [dict(item) for item in value if isinstance(item, Mapping)]


def _raw_patch_from_payload(payload: Any) -> dict[str, Any] | None:
    data = _record(payload)
    if data is None:
        return None
    nested = _record(data.get("patch"))
    if nested is not None:
        return nested
    nested_data = _record(data.get("data"))
    if nested_data is not None:
        nested = _record(nested_data.get("patch"))
        if nested is not None:
            return nested
        return nested_data
    return data


def normalize_agent_config_patch(payload: Any) -> dict[str, Any]:
    """Return the allowed, JSON-safe subset of a session config patch."""
    raw = _raw_patch_from_payload(payload)
    if raw is None:
        return {}

    patch: dict[str, Any] = {}
    for key, value in raw.items():
        if key not in _PATCH_FIELDS:
            continue
        if key in _STRING_FIELDS:
            normalized = _string(value)
        elif key in _STRING_LIST_FIELDS:
            normalized = _string_list(value)
        elif key in _NUMBER_FIELDS:
            normalized = _number(value)
        elif key in _OBJECT_LIST_FIELDS:
            normalized = _object_list(value)
        elif key in _PASSTHROUGH_OBJECT_FIELDS:
            normalized = dict(value) if isinstance(value, Mapping) else None
        else:
            normalized = None
        if normalized is not None:
            patch[key] = normalized

    # The runtime enforces builtin tool changes through the existing per-run
    # `tools` allowlist. Keep the UI-facing field too, but mirror it for the
    # turn runner when the caller did not provide a more explicit allowlist.
    if (
        "builtinTools" in patch
        and "tools" not in patch
        and "allowedTools" not in patch
    ):
        patch["tools"] = list(patch["builtinTools"])

    return patch


def session_control_event_to_patch(event: Any) -> dict[str, Any] | None:
    record = _record(event)
    if record is None:
        return None
    event_type = _string(record.get("type"))
    if event_type not in CONTROL_EVENT_TYPES:
        return None

    if event_type == LEGACY_SET_MODEL_EVENT:
        model_spec = _string(record.get("modelSpec"))
        if model_spec is None:
            data = _record(record.get("data"))
            model_spec = _string(data.get("modelSpec")) if data else None
        return {"modelSpec": model_spec} if model_spec else {}

    if event_type == LEGACY_SET_PERMISSION_MODE_EVENT:
        mode = _string(record.get("mode"))
        if mode is None:
            data = _record(record.get("data"))
            mode = _string(data.get("mode")) if data else None
        return {"permissionMode": mode} if mode in {"bypass", "default"} else {}

    return normalize_agent_config_patch(record)


def apply_agent_config_patch(
    agent_config: Mapping[str, Any] | None,
    patch: Mapping[str, Any] | None,
) -> tuple[dict[str, Any], list[str]]:
    next_config = deepcopy(dict(agent_config or {}))
    clean_patch = normalize_agent_config_patch({"patch": dict(patch or {})})
    changed: list[str] = []
    for key, value in clean_patch.items():
        if next_config.get(key) != value:
            next_config[key] = deepcopy(value)
            changed.append(key)
    return next_config, changed


def apply_session_control_events(
    agent_config: Mapping[str, Any] | None,
    events: list[dict[str, Any]],
) -> tuple[dict[str, Any], list[dict[str, Any]], list[dict[str, Any]]]:
    """Apply control events and return (agent_config, non_control_events, changes)."""
    current = deepcopy(dict(agent_config or {}))
    remaining: list[dict[str, Any]] = []
    applied: list[dict[str, Any]] = []

    for event in events:
        patch = session_control_event_to_patch(event)
        if patch is None:
            remaining.append(event)
            continue
        current, changed_keys = apply_agent_config_patch(current, patch)
        if changed_keys:
            applied.append(
                {
                    "type": event.get("type"),
                    "changedKeys": changed_keys,
                }
            )

    return current, remaining, applied


def external_control_event_as_user_event(
    event_name: str,
    payload: Any,
) -> tuple[str, Any]:
    """Map direct control external events onto the session.user_events lane."""
    if (
        event_name not in CONTROL_EVENT_TYPES
        and event_name not in TERMINAL_CONTROL_EVENT_TYPES
    ):
        return event_name, payload
    event: dict[str, Any] = {"type": event_name}
    if isinstance(payload, Mapping):
        event.update(dict(payload))
    else:
        event["data"] = payload
    return "session.user_events", {"events": [event]}

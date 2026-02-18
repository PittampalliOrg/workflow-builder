from __future__ import annotations

import json
from typing import Any

from core.template_resolver import NodeOutputs, resolve_templates


def _try_parse_json(value: Any) -> Any:
    """Best-effort parse JSON strings into Python objects; otherwise return as-is."""
    if not isinstance(value, str):
        return value
    s = value.strip()
    if not s:
        return value
    if not ((s.startswith("{") and s.endswith("}")) or (s.startswith("[") and s.endswith("]"))):
        return value
    try:
        return json.loads(s)
    except Exception:
        return value


def _coerce_entries_payload(entries_raw: Any) -> list[dict[str, Any]]:
    parsed = _try_parse_json(entries_raw)
    if isinstance(parsed, dict):
        return [{"key": key, "value": value} for key, value in parsed.items()]
    if isinstance(parsed, list):
        out: list[dict[str, Any]] = []
        for item in parsed:
            if isinstance(item, dict):
                out.append(item)
        return out
    return []


def resolve_set_state_updates(
    config: dict[str, Any],
    node_outputs: NodeOutputs,
) -> tuple[dict[str, Any], str | None]:
    """
    Resolve set-state config into concrete key/value assignments.

    Supported config formats:
      - Legacy single assignment: {"key": "...", "value": ...}
      - Multi assignment: {"entries": [{"key": "...", "value": ...}, ...]}
      - Multi assignment (object map): {"entries": {"k1": "...", "k2": "..."}}
    """
    entries_raw = config.get("entries")
    entries: list[dict[str, Any]]

    if entries_raw is None:
        key_raw = config.get("key", "")
        value_raw = config.get("value", "")
        resolved = resolve_templates({"key": key_raw, "value": value_raw}, node_outputs)
        key = resolved.get("key") if isinstance(resolved, dict) else key_raw
        value = resolved.get("value") if isinstance(resolved, dict) else value_raw
        entries = [{"key": key, "value": value}]
    else:
        entries = _coerce_entries_payload(entries_raw)
        resolved = resolve_templates({"entries": entries}, node_outputs)
        resolved_entries = resolved.get("entries") if isinstance(resolved, dict) else entries
        if isinstance(resolved_entries, dict):
            entries = [{"key": key, "value": value} for key, value in resolved_entries.items()]
        elif isinstance(resolved_entries, list):
            entries = [item for item in resolved_entries if isinstance(item, dict)]
        else:
            return {}, 'entries must resolve to an array of {"key","value"} objects'

    if len(entries) == 0:
        return {}, "at least one key/value entry is required"

    updates: dict[str, Any] = {}
    for index, entry in enumerate(entries):
        key = str(entry.get("key") or "").strip()
        if not key:
            return {}, f"entry {index + 1} is missing key"
        updates[key] = _try_parse_json(entry.get("value"))

    return updates, None

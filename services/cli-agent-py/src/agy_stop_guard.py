"""Antigravity Stop-hook guard for workflow-driven output contracts.

Antigravity's Stop hook can return ``{"decision": "continue"}`` to re-enter
the execution loop. For SW durable/run sessions, use that hook to prevent an
early Agy stop when the workflow still needs concrete filesystem output for
``outputSync``.
"""

from __future__ import annotations

import json
import os
import re
from pathlib import Path
from typing import Any, Mapping

DEFAULT_MAX_CONTINUES = 3
MUTATING_TOOLS = {
    "write_to_file",
    "replace_file_content",
    "multi_replace_file_content",
    "run_command",
}
_FILENAME_RE = re.compile(
    r"\b([A-Za-z0-9_.-]+\.(?:html|css|js|mjs|cjs|ts|tsx|jsx|md|json|txt|py|sh|yml|yaml))\b"
)


def _sandbox_root() -> Path:
    return Path(os.environ.get("AGENT_LOCAL_SANDBOX_ROOT", "/sandbox")).resolve()


def _wfb_dir() -> Path:
    root = os.environ.get("CLI_AGENT_WFB_DIR")
    if root:
        return Path(root)
    return _sandbox_root() / ".wfb"


def _config_path() -> Path:
    return _wfb_dir() / "agy_stop_guard.json"


def has_stop_guard_config() -> bool:
    return _config_path().exists()


def _state_path() -> Path:
    return _wfb_dir() / "agy_stop_guard_state.json"


def _record(value: Any) -> dict[str, Any]:
    return dict(value) if isinstance(value, Mapping) else {}


def _clean(value: Any) -> str | None:
    return value.strip() if isinstance(value, str) and value.strip() else None


def _env_int(name: str, default: int) -> int:
    try:
        return int(os.environ.get(name, default))
    except (TypeError, ValueError):
        return default


def _resolved_local_path(raw: str) -> Path | None:
    text = raw.strip()
    if not text:
        return None
    candidate = Path(text)
    if not candidate.is_absolute():
        candidate = _sandbox_root() / candidate
    try:
        resolved = candidate.resolve()
        resolved.relative_to(_sandbox_root())
    except (OSError, ValueError):
        return None
    return resolved


def _source_specs(output_sync: Mapping[str, Any]) -> list[dict[str, Any]]:
    paths = output_sync.get("paths")
    if not isinstance(paths, list):
        return []
    specs: list[dict[str, Any]] = []
    for item in paths:
        if not isinstance(item, Mapping):
            continue
        source = _clean(item.get("source"))
        if not source:
            continue
        resolved = _resolved_local_path(source)
        if resolved is None:
            continue
        specs.append({"source": str(resolved)})
    return specs


def _text_from_content(value: Any) -> str | None:
    if isinstance(value, str) and value.strip():
        return value.strip()
    if isinstance(value, list):
        parts = [_text_from_content(item) for item in value]
        joined = "\n".join(part for part in parts if part)
        return joined or None
    if isinstance(value, Mapping):
        for key in ("text", "content", "message", "prompt"):
            text = _text_from_content(value.get(key))
            if text:
                return text
    return None


def _initial_user_text(session_input: Mapping[str, Any]) -> str | None:
    initial_events = session_input.get("initialEvents")
    if not isinstance(initial_events, list):
        return None
    for event in initial_events:
        if not isinstance(event, Mapping) or event.get("type") != "user.message":
            continue
        text = _text_from_content(event.get("content"))
        if text:
            return text
    return None


def _body_contract(session_input: Mapping[str, Any]) -> dict[str, Any]:
    body = _record(session_input.get("body"))
    stop_condition = (
        session_input.get("stopCondition")
        or body.get("stopCondition")
        or session_input.get("prompt")
        or body.get("prompt")
        or _initial_user_text(session_input)
    )
    return {
        "stopCondition": stop_condition,
        "requireFileChanges": session_input.get(
            "requireFileChanges", body.get("requireFileChanges")
        ),
    }


def _is_negated_or_optional_reference(text: str, start: int, end: int) -> bool:
    before = text[max(0, start - 64) : start].lower()
    after = text[end : min(len(text), end + 32)].lower()
    negative_markers = ("do not", "don't", "never", "not create", "without")
    if any(marker in before for marker in negative_markers):
        return True
    return "optional" in before or "optional" in after


def _required_file_names(stop_condition: Any) -> list[str]:
    if not isinstance(stop_condition, str):
        return []
    names = []
    seen: set[str] = set()
    for match in _FILENAME_RE.finditer(stop_condition):
        if _is_negated_or_optional_reference(stop_condition, match.start(), match.end()):
            continue
        name = match.group(1)
        if name not in seen:
            seen.add(name)
            names.append(name)
    return names[:20]


def write_stop_guard_config(session_input: Mapping[str, Any]) -> str | None:
    """Materialize the per-session guard config, returning its path.

    The guard is only enabled for workflow-mode sessions that have at least one
    local ``outputSync.paths[].source`` requirement.
    """
    output_sync = _record(session_input.get("outputSync"))
    sources = _source_specs(output_sync)
    if not sources:
        return None

    path = _config_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    max_continues = _env_int("CLI_AGY_STOP_GUARD_MAX_CONTINUES", DEFAULT_MAX_CONTINUES)
    contract = _body_contract(session_input)
    stop_condition = contract["stopCondition"]
    required_file_names = _required_file_names(stop_condition)
    explicit_require_changes = contract["requireFileChanges"]
    config = {
        "enabled": True,
        "maxContinues": max(0, max_continues),
        "requiredSources": sources,
        "requiredFileNames": required_file_names,
        "requireFileChanges": (
            bool(explicit_require_changes)
            if explicit_require_changes is not None
            else bool(required_file_names)
        ),
        "stopCondition": _clean(stop_condition),
    }
    path.write_text(json.dumps(config, indent=2) + "\n", encoding="utf-8")
    return str(path)


def _read_json(path: Path) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, TypeError, ValueError):
        return {}
    return dict(value) if isinstance(value, Mapping) else {}


def _write_json(path: Path, value: Mapping[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(dict(value), indent=2) + "\n", encoding="utf-8")
    tmp.replace(path)


def _tool_name(payload: Mapping[str, Any]) -> str | None:
    for record in (payload, _record(payload.get("toolCall")), _record(payload.get("tool"))):
        for key in ("toolName", "tool_name", "name", "command"):
            value = _clean(record.get(key))
            if value:
                return value
    return None


def record_hook_event(payload: Mapping[str, Any]) -> None:
    """Track mutating Agy tool attempts for guard diagnostics."""
    event_name = _clean(payload.get("hook_event_name") or payload.get("eventName"))
    if event_name != "PreToolUse" or not _config_path().exists():
        return
    tool = _tool_name(payload)
    if not tool:
        return
    state = _read_json(_state_path())
    counts = _record(state.get("toolCounts"))
    counts[tool] = int(counts.get(tool) or 0) + 1
    state["toolCounts"] = counts
    if tool in MUTATING_TOOLS:
        mutating = [
            str(item)
            for item in state.get("mutatingTools", [])
            if isinstance(item, str)
        ]
        if tool not in mutating:
            mutating.append(tool)
        state["mutatingTools"] = mutating
    _write_json(_state_path(), state)


def _missing_requirements(config: Mapping[str, Any]) -> list[str]:
    missing: list[str] = []
    required_file_names = [
        str(item)
        for item in config.get("requiredFileNames", [])
        if isinstance(item, str) and item.strip()
    ]
    sources = config.get("requiredSources")
    for item in sources if isinstance(sources, list) else []:
        if not isinstance(item, Mapping):
            continue
        source = _clean(item.get("source"))
        if not source:
            continue
        path = Path(source)
        if not path.exists():
            missing.append(source)
            continue
        if path.is_dir() and required_file_names:
            for name in required_file_names:
                child = path / name
                if not child.exists():
                    missing.append(str(child))
    return missing


def evaluate_stop_guard(*, increment_continue: bool) -> dict[str, Any]:
    """Return an Antigravity Stop-hook response.

    ``{}`` allows the stop. ``{"decision": "continue", ...}`` keeps Agy in its
    execution loop.
    """
    config = _read_json(_config_path())
    if not config.get("enabled"):
        return {}
    missing = _missing_requirements(config)
    if not missing:
        return {}

    state = _read_json(_state_path())
    continue_count = int(state.get("continueCount") or 0)
    max_continues = int(config.get("maxContinues") or 0)
    if max_continues <= 0 or continue_count >= max_continues:
        return {}

    if increment_continue:
        continue_count += 1
        state["continueCount"] = continue_count
        state["lastMissing"] = missing
        _write_json(_state_path(), state)

    mutating = [
        str(item)
        for item in state.get("mutatingTools", [])
        if isinstance(item, str) and item.strip()
    ]
    missing_preview = ", ".join(missing[:8])
    more = "" if len(missing) <= 8 else f", and {len(missing) - 8} more"
    reason = (
        "The workflow output contract is not satisfied yet. "
        f"Missing required path(s): {missing_preview}{more}. "
        "Continue now and create or update the required files using absolute "
        "paths under /sandbox before stopping."
    )
    if not mutating and config.get("requireFileChanges"):
        reason += " No mutating file tool has been observed in this turn."
    if config.get("stopCondition"):
        reason += f" Stop condition: {config['stopCondition']}"
    return {"decision": "continue", "reason": reason[:1800]}


def completion_guard_allows_turn_completion() -> bool:
    return not bool(evaluate_stop_guard(increment_continue=False).get("decision"))

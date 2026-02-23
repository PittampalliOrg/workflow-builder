from __future__ import annotations

import re
from typing import Any

SUMMARY_OUTPUT_KEYS = (
    "text",
    "toolCalls",
    "fileChanges",
    "patch",
    "patchRef",
    "changeSummary",
    "artifactRef",
    "plan",
    "planMarkdown",
    "planPolicy",
    "tasks",
    "daprInstanceId",
    "workspaceRef",
    "cleanup",
    "compactionApplied",
    "compactionCount",
    "contextOverflowRecovered",
    "lastCompactionReason",
    "branch",
    "commit",
    "prNumber",
    "prUrl",
    "prState",
    "remote",
    "changedFileCount",
)

_EXPORT_LINE = re.compile(r"^([A-Z_][A-Z0-9_]*)=(.*)$")
_EXPORT_KEY_MAP = {
    "BRANCH": "branch",
    "COMMIT": "commit",
    "PR_NUMBER": "prNumber",
    "PR_URL": "prUrl",
    "PR_STATE": "prState",
    "REMOTE": "remote",
    "CHANGED_COUNT": "changedFileCount",
}

_SNAKE_TO_CAMEL = {
    "pr_number": "prNumber",
    "pr_url": "prUrl",
    "pr_state": "prState",
    "changed_count": "changedFileCount",
}


def _coerce_summary_value(key: str, value: Any) -> Any:
    if value is None:
        return None

    if key in {"prNumber", "changedFileCount"}:
        if isinstance(value, int):
            return value
        if isinstance(value, str):
            stripped = value.strip()
            if not stripped:
                return None
            try:
                return int(stripped)
            except ValueError:
                return stripped

    if isinstance(value, str):
        stripped = value.strip()
        return stripped if stripped else None

    return value


def _node_output_has_file_changes(candidate: dict[str, Any]) -> bool:
    file_changes = candidate.get("fileChanges")
    if isinstance(file_changes, list) and len(file_changes) > 0:
        return True

    summary = candidate.get("changeSummary")
    if not isinstance(summary, dict):
        return False

    changed = summary.get("changed")
    if isinstance(changed, bool) and changed:
        return True

    stats = summary.get("stats")
    if isinstance(stats, dict):
        files = stats.get("files")
        additions = stats.get("additions")
        deletions = stats.get("deletions")
        if isinstance(files, int) and files > 0:
            return True
        if isinstance(additions, int) and additions > 0:
            return True
        if isinstance(deletions, int) and deletions > 0:
            return True

    return False


def _extract_direct_summary_fields(candidate: dict[str, Any]) -> dict[str, Any]:
    summary: dict[str, Any] = {}
    sources: list[dict[str, Any]] = [candidate]

    nested = candidate.get("result")
    if isinstance(nested, dict):
        sources.append(nested)

    for source in sources:
        for key in SUMMARY_OUTPUT_KEYS:
            value = _coerce_summary_value(key, source.get(key))
            if value is not None:
                summary[key] = value

        for snake_key, camel_key in _SNAKE_TO_CAMEL.items():
            value = _coerce_summary_value(camel_key, source.get(snake_key))
            if value is not None:
                summary[camel_key] = value

    return summary


def _extract_command_text(candidate: dict[str, Any]) -> list[str]:
    texts: list[str] = []

    for field in ("stdout", "stderr", "text", "content"):
        value = candidate.get(field)
        if isinstance(value, str) and value.strip():
            texts.append(value)

    nested = candidate.get("result")
    if isinstance(nested, dict):
        for field in ("stdout", "stderr", "text", "content"):
            value = nested.get(field)
            if isinstance(value, str) and value.strip():
                texts.append(value)

    return texts


def _extract_exports_from_text(text: str) -> dict[str, Any]:
    exports: dict[str, Any] = {}

    for raw_line in text.splitlines():
        line = raw_line.strip()
        if not line:
            continue

        match = _EXPORT_LINE.match(line)
        if not match:
            continue

        export_key = match.group(1)
        export_value = match.group(2)
        summary_key = _EXPORT_KEY_MAP.get(export_key)
        if not summary_key:
            continue

        coerced = _coerce_summary_value(summary_key, export_value)
        if coerced is not None:
            exports[summary_key] = coerced

    return exports


def extract_summary_fields_from_outputs(outputs: Any) -> dict[str, Any]:
    """
    Extract top-level execution summary fields from node outputs.

    Strategy:
    1) Start from the latest output with file-change signals (or latest output).
    2) Merge direct summary fields from all outputs (latest first) for missing keys.
    3) Parse command stdout/stderr export lines (e.g., PR_URL=..., COMMIT=...).
    """
    if not isinstance(outputs, dict):
        return {}

    values = [value for value in outputs.values() if isinstance(value, dict)]
    if not values:
        return {}

    source: dict[str, Any] | None = None
    for value in reversed(values):
        if _node_output_has_file_changes(value):
            source = value
            break
    if source is None:
        source = values[-1]

    summary = _extract_direct_summary_fields(source)

    for value in reversed(values):
        direct = _extract_direct_summary_fields(value)
        for key, field_value in direct.items():
            if key not in summary and field_value is not None:
                summary[key] = field_value

        for text in _extract_command_text(value):
            exports = _extract_exports_from_text(text)
            for key, field_value in exports.items():
                if key not in summary and field_value is not None:
                    summary[key] = field_value

    return {key: value for key, value in summary.items() if value is not None}

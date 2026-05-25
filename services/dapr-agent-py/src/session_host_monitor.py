from __future__ import annotations

from dataclasses import dataclass
from typing import Any


@dataclass(frozen=True)
class MissingWorkflowDecision:
    missing_since: float
    exit_code: int | None = None


def decide_missing_workflow_action(
    *,
    first_seen_at: float | None,
    missing_since: float | None,
    now: float,
    missing_grace_seconds: int,
) -> MissingWorkflowDecision:
    started_missing_at = now if missing_since is None else missing_since
    if first_seen_at is not None and now - started_missing_at > missing_grace_seconds:
        return MissingWorkflowDecision(missing_since=started_missing_at, exit_code=0)
    return MissingWorkflowDecision(missing_since=started_missing_at)


def terminal_hold_seconds_for_status(
    runtime_status: str,
    configured_seconds: int,
) -> int:
    if runtime_status.upper() != "COMPLETED":
        return 0
    return max(0, configured_seconds)


def normalize_nonterminal_timeout_action(value: str | None) -> str:
    action = (value or "").strip().lower()
    if action in {"terminate", "terminated", "exit", "fail"}:
        return "terminate"
    return "warn"


def workflow_progress_marker(state: dict[str, Any]) -> str | None:
    for key in (
        "lastUpdatedAt",
        "last_updated_at",
        "updatedAt",
        "updated_at",
        "customStatus",
        "custom_status",
    ):
        value = state.get(key)
        if value is not None:
            marker = str(value).strip()
            if marker:
                return marker
    return None


def benchmark_activity_marker(progress: dict[str, Any]) -> str | None:
    value = progress.get("progressMarker")
    if value is not None:
        marker = str(value).strip()
        if marker:
            return marker
    return None


def benchmark_activity_age_seconds(progress: dict[str, Any]) -> float | None:
    try:
        age = float(progress.get("activityAgeSeconds"))
    except (TypeError, ValueError):
        return None
    return age if age >= 0 else None


def benchmark_activity_is_recent(
    progress: dict[str, Any],
    *,
    idle_timeout_seconds: int,
) -> bool:
    age = benchmark_activity_age_seconds(progress)
    if age is None:
        return False
    return age <= max(0, idle_timeout_seconds)

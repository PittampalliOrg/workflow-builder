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
    """Build a progress marker that changes when the workflow makes progress.

    Combines the Dapr workflow's last-checkpoint timestamp AND its custom status,
    so a change in EITHER counts as progress. The custom status is the agent's
    explicit per-iteration/per-tool heartbeat (Dapr's intended mechanism for
    surfacing workflow progress to external observers) — needed because the
    checkpoint timestamp does not reliably advance per activity for long,
    many-tool single turns from slow reasoning models. Reading the timestamp
    ALONE (the old behavior) masked the heartbeat entirely.
    """
    parts: list[str] = []
    for key in ("lastUpdatedAt", "last_updated_at", "updatedAt", "updated_at"):
        value = state.get(key)
        if value is not None and str(value).strip():
            parts.append(str(value).strip())
            break
    for key in ("customStatus", "custom_status", "serialized_custom_status"):
        value = state.get(key)
        if value is not None and str(value).strip():
            parts.append(str(value).strip())
            break
    return "|".join(parts) if parts else None


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

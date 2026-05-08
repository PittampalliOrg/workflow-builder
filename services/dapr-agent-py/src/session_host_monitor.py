from __future__ import annotations

from dataclasses import dataclass


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
    if first_seen_at is not None:
        return MissingWorkflowDecision(missing_since=now, exit_code=0)
    started_missing_at = now if missing_since is None else missing_since
    if now - started_missing_at > missing_grace_seconds:
        return MissingWorkflowDecision(missing_since=started_missing_at, exit_code=1)
    return MissingWorkflowDecision(missing_since=started_missing_at)

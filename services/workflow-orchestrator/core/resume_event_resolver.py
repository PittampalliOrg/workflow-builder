"""Pure resume/fork node→history-event resolution (no FastAPI/Dapr deps).

Extracted from app.py so it can be unit-tested standalone. The orchestrator's
`/resume` endpoint imports these and maps `ResumeEventResolutionError` onto an
HTTPException with the same status_code/detail.
"""
from __future__ import annotations

from typing import Any


class ResumeEventResolutionError(Exception):
    """Resume target could not be resolved. `status_code` is 404 (node not found in
    the run's history) or 409 (the run has no resumable node boundaries)."""

    def __init__(self, status_code: int, detail: str):
        self.status_code = status_code
        self.detail = detail
        super().__init__(detail)


def node_start_events(events: list[dict[str, Any]]) -> list[tuple[int, str]]:
    """Ordered (eventId, nodeId) for every top-level node start in a run history.

    The SW interpreter schedules an `update_execution_node` activity at the start of
    each top-level node, carrying the node id in its input. That TaskScheduled event
    is the node's boundary: rerunning from its eventId re-executes the node (and all
    later nodes) while everything before replays from cached history.
    """
    starts: list[tuple[int, str]] = []
    for event in events:
        if str(event.get("eventType") or "") != "TaskScheduled":
            continue
        if str(event.get("name") or "") != "update_execution_node":
            continue
        event_id = event.get("eventId")
        if not isinstance(event_id, int):
            continue
        node_id = None
        inp = event.get("input")
        if isinstance(inp, dict):
            node_id = inp.get("nodeId") or inp.get("node_id") or inp.get("node")
        if isinstance(node_id, str) and node_id:
            starts.append((event_id, node_id))
    starts.sort(key=lambda item: item[0])
    return starts


def resolve_resume_event(
    events: list[dict[str, Any]], from_node_id: str | None
) -> tuple[int, str]:
    """Map a node id (or auto-failed) to the history eventId to rerun from.

    Returns (eventId, resolvedNodeId). Raises ResumeEventResolutionError(404) if the
    node never started in this run, or (409) if the run has no node-start events.
    """
    starts = node_start_events(events)
    if not starts:
        raise ResumeEventResolutionError(
            status_code=409,
            detail="Run has no resumable node boundaries in its history",
        )
    target = (from_node_id or "").strip()
    if not target or target == "__failed__":
        # The last node that started is the one in-flight when the run stopped.
        event_id, node_id = starts[-1]
        return event_id, node_id
    # Earliest start for the requested node (a looped node only has one top-level start).
    for event_id, node_id in starts:
        if node_id == target:
            return event_id, node_id
    available = ", ".join(sorted({n for _, n in starts}))
    raise ResumeEventResolutionError(
        status_code=404,
        detail=f"Node '{target}' did not start in this run (available: {available})",
    )

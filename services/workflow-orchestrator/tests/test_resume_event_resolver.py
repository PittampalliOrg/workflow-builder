from __future__ import annotations

import importlib.util
from pathlib import Path
import sys

import pytest

MODULE_PATH = Path(__file__).resolve().parent.parent / "core" / "resume_event_resolver.py"
SERVICE_ROOT = MODULE_PATH.parent.parent
if str(SERVICE_ROOT) not in sys.path:
    sys.path.insert(0, str(SERVICE_ROOT))

SPEC = importlib.util.spec_from_file_location("resume_event_resolver", MODULE_PATH)
if SPEC is None or SPEC.loader is None:
    raise RuntimeError(f"Unable to load module from {MODULE_PATH}")
RESOLVER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(RESOLVER)

node_start_events = RESOLVER.node_start_events
resolve_resume_event = RESOLVER.resolve_resume_event
ResumeEventResolutionError = RESOLVER.ResumeEventResolutionError


def _start(event_id: int, node_id: str) -> dict:
    return {
        "eventType": "TaskScheduled",
        "name": "update_execution_node",
        "eventId": event_id,
        "input": {"nodeId": node_id},
    }


SAMPLE = [
    {"eventType": "ExecutionStarted", "eventId": 0},
    _start(1, "clone_repo"),
    {"eventType": "TaskCompleted", "eventId": 2},
    _start(4, "plan"),
    # noise: a non-boundary TaskScheduled + an out-of-order event id
    {"eventType": "TaskScheduled", "name": "log_node_start", "eventId": 5, "input": {"nodeId": "plan"}},
    _start(20, "publish_contract"),
    _start(10, "refine"),  # out of order on purpose — must sort by eventId
]


def test_node_start_events_extracts_and_sorts_boundaries():
    assert node_start_events(SAMPLE) == [
        (1, "clone_repo"),
        (4, "plan"),
        (10, "refine"),
        (20, "publish_contract"),
    ]


def test_node_start_events_ignores_non_update_execution_node():
    # log_node_start is not a boundary even though it carries a nodeId.
    names = {n for _, n in node_start_events(SAMPLE)}
    assert "plan" in names
    assert all(isinstance(e, int) for e, _ in node_start_events(SAMPLE))


def test_resolve_named_node_returns_its_start_event():
    assert resolve_resume_event(SAMPLE, "publish_contract") == (20, "publish_contract")
    assert resolve_resume_event(SAMPLE, "refine") == (10, "refine")


@pytest.mark.parametrize("from_node", [None, "", "  ", "__failed__"])
def test_resolve_auto_failed_picks_last_node_started(from_node):
    # The last node that started (highest eventId after sort) = the in-flight node.
    assert resolve_resume_event(SAMPLE, from_node) == (20, "publish_contract")


def test_resolve_unknown_node_raises_404_with_available_list():
    with pytest.raises(ResumeEventResolutionError) as exc:
        resolve_resume_event(SAMPLE, "does_not_exist")
    assert exc.value.status_code == 404
    assert "does_not_exist" in exc.value.detail
    assert "clone_repo" in exc.value.detail  # available nodes listed


def test_resolve_no_boundaries_raises_409():
    events = [
        {"eventType": "ExecutionStarted", "eventId": 0},
        {"eventType": "ExecutionCompleted", "eventId": 9},
    ]
    with pytest.raises(ResumeEventResolutionError) as exc:
        resolve_resume_event(events, None)
    assert exc.value.status_code == 409

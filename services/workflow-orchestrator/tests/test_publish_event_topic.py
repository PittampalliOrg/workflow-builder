from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from activities import publish_event


def test_workflow_events_topic_bare_on_host(monkeypatch):
    monkeypatch.delenv("WORKFLOW_ORCHESTRATOR_EVENT_TOPIC_PREFIX", raising=False)
    assert publish_event._workflow_events_topic() == "workflow.events"


def test_workflow_events_topic_preview_prefixed(monkeypatch):
    # Matches the runner.sh stream subject namespace `wbpreview-<name>.>` and the
    # E1 consumer's previewWorkflowEventsSubject.
    monkeypatch.setenv("WORKFLOW_ORCHESTRATOR_EVENT_TOPIC_PREFIX", "wbpreview-gan-codex")
    assert publish_event._workflow_events_topic() == "wbpreview-gan-codex.workflow.events"


def test_workflow_events_topic_strips_stray_dots(monkeypatch):
    monkeypatch.setenv("WORKFLOW_ORCHESTRATOR_EVENT_TOPIC_PREFIX", ".wbpreview-x.")
    assert publish_event._workflow_events_topic() == "wbpreview-x.workflow.events"


# --- lifecycle auto-emit gate (task #17) ---------------------------------------


def test_lifecycle_emit_off_on_host_by_default(monkeypatch):
    # No preview prefix and no explicit flag => host stays OFF (no new event volume,
    # behavior byte-identical to pre-#17).
    monkeypatch.delenv("WORKFLOW_ORCHESTRATOR_EVENT_TOPIC_PREFIX", raising=False)
    monkeypatch.delenv("WORKFLOW_ORCHESTRATOR_EMIT_LIFECYCLE_EVENTS", raising=False)
    assert publish_event._emit_lifecycle_events_enabled() is False


def test_lifecycle_emit_on_in_preview_by_default(monkeypatch):
    # A preview (topic prefix set) auto-emits so the E1 feed shows every run.
    monkeypatch.setenv("WORKFLOW_ORCHESTRATOR_EVENT_TOPIC_PREFIX", "wbpreview-b1check")
    monkeypatch.delenv("WORKFLOW_ORCHESTRATOR_EMIT_LIFECYCLE_EVENTS", raising=False)
    assert publish_event._emit_lifecycle_events_enabled() is True


def test_lifecycle_emit_explicit_true_enables_host(monkeypatch):
    monkeypatch.delenv("WORKFLOW_ORCHESTRATOR_EVENT_TOPIC_PREFIX", raising=False)
    for val in ("true", "1", "yes", "on", "TRUE"):
        monkeypatch.setenv("WORKFLOW_ORCHESTRATOR_EMIT_LIFECYCLE_EVENTS", val)
        assert publish_event._emit_lifecycle_events_enabled() is True


def test_lifecycle_emit_explicit_false_overrides_preview_default(monkeypatch):
    # Explicit opt-out wins even inside a preview.
    monkeypatch.setenv("WORKFLOW_ORCHESTRATOR_EVENT_TOPIC_PREFIX", "wbpreview-b1check")
    for val in ("false", "0", "no", "off"):
        monkeypatch.setenv("WORKFLOW_ORCHESTRATOR_EMIT_LIFECYCLE_EVENTS", val)
        assert publish_event._emit_lifecycle_events_enabled() is False


def test_lifecycle_helpers_publish_expected_types(monkeypatch):
    # The three helpers must target WORKFLOW_EVENTS_TOPIC with the right CloudEvent
    # type + carry executionId (the E1 feed keys the run on it).
    captured: list[dict] = []

    def _fake_publish_event(ctx, input_data):
        captured.append(input_data)
        return {"success": True}

    monkeypatch.setattr(publish_event, "publish_event", _fake_publish_event)
    publish_event.publish_workflow_started(None, {"executionId": "e", "workflowId": "w", "workflowName": "n"})
    publish_event.publish_workflow_completed(None, {"executionId": "e", "workflowId": "w"})
    publish_event.publish_workflow_failed(None, {"executionId": "e", "workflowId": "w", "error": "boom"})

    types = [c["eventType"] for c in captured]
    assert types == ["workflow.started", "workflow.completed", "workflow.failed"]
    assert all(c["data"].get("executionId") == "e" for c in captured)
    assert captured[2]["data"].get("error") == "boom"

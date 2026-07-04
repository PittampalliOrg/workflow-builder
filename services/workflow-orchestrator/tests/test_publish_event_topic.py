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

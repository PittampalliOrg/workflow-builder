"""Unit tests for record_script_call_result normalization — focus on the
workflow-kind branch (a nested dynamic_script_workflow_v1 result resolves to the
child's returnValue object, not extracted text)."""
from __future__ import annotations

import pytest

from activities import script_call_journal as jc


@pytest.fixture
def captured(monkeypatch):
    rows: list[dict] = []
    monkeypatch.setattr(
        jc.script_journal_client,
        "put_script_call",
        lambda exec_id, call_id, row: rows.append({"execId": exec_id, "callId": call_id, **row}),
    )
    return rows


def _record(spec, raw):
    return jc.record_script_call_result(
        None,
        {"executionId": "exec1", "callId": "c1", "seq": 0, "spec": spec, "raw": raw},
    )


def test_workflow_kind_resolves_to_child_return_value(captured):
    raw = {"success": True, "status": "completed", "returnValue": {"source": "x", "summary": {"title": "T"}}}
    res = _record({"kind": "workflow", "label": "child"}, raw)
    assert res["status"] == "done"
    assert captured[-1]["result"] == {"source": "x", "summary": {"title": "T"}}
    assert captured[-1]["kind"] == "workflow"


def test_workflow_kind_failure_journals_error_so_workflow_throws(captured):
    # Workflow-tool contract: workflow() THROWS on child failure (agent() nulls).
    # The journal encodes that as status=error + errorCode=workflow_child_error,
    # with the human reason in result.message for the evaluator to throw verbatim.
    res = _record({"kind": "workflow"}, {"success": False, "error": "child died"})
    assert res["status"] == "error"
    assert res["errorCode"] == "workflow_child_error"
    assert captured[-1]["status"] == "error"
    assert captured[-1]["errorCode"] == "workflow_child_error"
    assert captured[-1]["result"] == {"message": "child died"}


def test_workflow_kind_cancelled_child_journals_error(captured):
    res = _record({"kind": "workflow"}, {"success": False, "cancelled": True})
    assert res["status"] == "error"
    assert captured[-1]["result"] == {"message": "workflow() child was cancelled"}


def test_workflow_kind_skip_still_resolves_null(captured):
    # User skip stays a null resolution even for workflow() (spec: skip -> null).
    res = _record({"kind": "workflow"}, {"skipped": True})
    assert res["status"] == "skipped"
    assert captured[-1]["status"] == "skipped"


def test_agent_kind_no_schema_uses_content(captured):
    res = _record({"kind": "agent"}, {"content": "hello"})
    assert res["status"] == "done"
    assert captured[-1]["result"] == "hello"


def test_agent_kind_schema_validates(captured):
    schema = {"type": "object", "required": ["ok"], "properties": {"ok": {"type": "boolean"}}}
    res = _record({"kind": "agent", "schema": schema}, {"content": '```json\n{"ok": true}\n```'})
    assert res["status"] == "done"
    assert captured[-1]["result"] == {"ok": True}


def test_skip(captured):
    res = _record({"kind": "agent"}, {"skipped": True})
    assert res["status"] == "skipped"
    assert captured[-1]["status"] == "skipped"

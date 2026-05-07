from __future__ import annotations

import json

import requests

from src import worker


class _Response:
    def __init__(
        self,
        status_code: int,
        text: str = "",
        body: dict[str, object] | None = None,
    ) -> None:
        self.status_code = status_code
        self.text = text
        self._body = body or {}

    def json(self) -> dict[str, object]:
        return self._body


def test_load_payload_prefers_request_file(monkeypatch, tmp_path) -> None:
    payload_path = tmp_path / "request.json"
    payload_path.write_text(json.dumps({"runId": "run_1"}), encoding="utf-8")
    monkeypatch.setenv("EXECUTION_REQUEST_PATH", str(payload_path))
    monkeypatch.setenv("EXECUTION_REQUEST_JSON", json.dumps({"runId": "env"}))

    assert worker._load_payload()["runId"] == "run_1"


def test_post_callback_retries_transient_connection_errors(monkeypatch) -> None:
    monkeypatch.setenv("WORKFLOW_BUILDER_URL", "http://workflow-builder:3000")
    monkeypatch.setenv("INTERNAL_API_TOKEN", "secret")
    monkeypatch.setenv("SANDBOX_EXECUTION_CALLBACK_ATTEMPTS", "3")
    sleeps: list[float] = []
    attempts = {"count": 0}

    def fake_post(*args, **kwargs):
        attempts["count"] += 1
        if attempts["count"] == 1:
            raise requests.ConnectionError("connection refused")
        return _Response(200)

    monkeypatch.setattr(worker.requests, "post", fake_post)
    monkeypatch.setattr(worker.time, "sleep", sleeps.append)

    worker._post_callback(
        {"callback": {"path": "/api/internal/benchmarks/runs/r/instances/i/execution"}},
        {"status": "success"},
    )

    assert attempts["count"] == 2
    assert sleeps == [2.0]


def test_post_callback_raises_after_retry_budget(monkeypatch) -> None:
    monkeypatch.setenv("WORKFLOW_BUILDER_URL", "http://workflow-builder:3000")
    monkeypatch.setenv("SANDBOX_EXECUTION_CALLBACK_ATTEMPTS", "2")
    monkeypatch.setattr(worker.time, "sleep", lambda _: None)
    monkeypatch.setattr(
        worker.requests,
        "post",
        lambda *args, **kwargs: _Response(503, "not ready"),
    )

    try:
        worker._post_callback(
            {"callback": {"path": "/api/internal/benchmarks/runs/r/instances/i/execution"}},
            {"status": "success"},
        )
    except RuntimeError as exc:
        assert "after 2 attempt" in str(exc)
    else:
        raise AssertionError("expected RuntimeError")


def test_start_workflow_retries_transient_runtime_unavailable(monkeypatch) -> None:
    monkeypatch.setenv("WORKFLOW_ORCHESTRATOR_URL", "http://workflow-orchestrator:8080")
    monkeypatch.setenv("SANDBOX_EXECUTION_WORKFLOW_START_ATTEMPTS", "3")
    sleeps: list[float] = []
    attempts = {"count": 0}

    def fake_post(*args, **kwargs):
        attempts["count"] += 1
        if attempts["count"] == 1:
            return _Response(
                503,
                '{"detail":{"code":"workflow_runtime_unavailable","error":"Dapr workflow runtime is not ready"}}',
            )
        return _Response(200, body={"instanceId": "sw-1"})

    monkeypatch.setattr(worker.requests, "post", fake_post)
    monkeypatch.setattr(worker.time, "sleep", sleeps.append)
    monkeypatch.setattr(worker.random, "uniform", lambda *_args: 0.0)

    instance_id = worker._start_workflow(
        {
            "workflow": {"id": "wf"},
            "workflowId": "wf",
            "workflowExecutionId": "exec_1",
        }
    )

    assert instance_id == "sw-1"
    assert attempts["count"] == 2
    assert sleeps == [4.0]


def test_start_workflow_does_not_retry_non_transient_client_error(monkeypatch) -> None:
    monkeypatch.setenv("SANDBOX_EXECUTION_WORKFLOW_START_ATTEMPTS", "3")
    attempts = {"count": 0}

    def fake_post(*args, **kwargs):
        attempts["count"] += 1
        return _Response(400, "bad workflow")

    monkeypatch.setattr(worker.requests, "post", fake_post)
    monkeypatch.setattr(worker.time, "sleep", lambda _: None)

    try:
        worker._start_workflow(
            {
                "workflow": {"id": "wf"},
                "workflowId": "wf",
                "workflowExecutionId": "exec_1",
            }
        )
    except RuntimeError as exc:
        assert "after 1 attempt" in str(exc)
        assert "bad workflow" in str(exc)
    else:
        raise AssertionError("expected RuntimeError")
    assert attempts["count"] == 1

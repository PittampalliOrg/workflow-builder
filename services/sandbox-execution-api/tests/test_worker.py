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


def test_start_workflow_retries_connection_refused(monkeypatch) -> None:
    monkeypatch.setenv("WORKFLOW_ORCHESTRATOR_URL", "http://workflow-orchestrator:8080")
    monkeypatch.setenv("SANDBOX_EXECUTION_WORKFLOW_START_ATTEMPTS", "3")
    sleeps: list[float] = []
    attempts = {"count": 0}

    def fake_post(*args, **kwargs):
        attempts["count"] += 1
        if attempts["count"] == 1:
            raise requests.ConnectionError(
                "HTTPConnectionPool(host='workflow-orchestrator', port=8080): "
                "Failed to establish a new connection: [Errno 111] Connection refused"
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


def test_workflow_start_stagger_is_deterministic(monkeypatch) -> None:
    monkeypatch.setenv("SANDBOX_EXECUTION_WORKFLOW_START_STAGGER_SECONDS", "120")
    payload = {"executionId": "hexec_1", "workflowExecutionId": "exec_1"}

    first = worker._workflow_start_stagger_seconds(payload)
    second = worker._workflow_start_stagger_seconds(payload)

    assert first == second
    assert 0 <= first <= 120


def test_workflow_baggage_ignores_retired_mlflow_context() -> None:
    baggage = worker._workflow_baggage(
        {
            "workflowExecutionId": "exec_1",
            "workflowId": "workflow_1",
            "mlflowContext": {
                "experimentId": "experiment_1",
                "runId": "run_1",
                "parentRunId": "parent_1",
            },
        }
    )

    assert "mlflow" not in baggage.lower()
    assert "workflow.execution.id=exec_1" in baggage
    assert "workflow.id=workflow_1" in baggage


def test_run_applies_workflow_start_stagger_before_start(monkeypatch, tmp_path) -> None:
    payload = {
        "executionId": "hexec_1",
        "workflowExecutionId": "exec_1",
        "workflow": {"id": "wf"},
        "workflowId": "wf",
        "timeoutSeconds": 60,
        "callback": {"path": "/callback"},
    }
    payload_path = tmp_path / "request.json"
    payload_path.write_text(json.dumps(payload), encoding="utf-8")
    monkeypatch.setenv("EXECUTION_REQUEST_PATH", str(payload_path))
    monkeypatch.setenv("SANDBOX_EXECUTION_WORKFLOW_START_STAGGER_SECONDS", "10")
    monkeypatch.setattr(worker, "_start_workflow", lambda _payload: "sw-1")
    monkeypatch.setattr(
        worker,
        "_workflow_status",
        lambda _instance_id: {"runtimeStatus": "COMPLETED", "output": {}},
    )
    monkeypatch.setattr(worker, "_post_callback", lambda *_args, **_kwargs: None)
    sleeps: list[float] = []
    monkeypatch.setattr(worker, "_sleep", sleeps.append)

    assert worker._run() == 0
    assert len(sleeps) == 1
    assert 0 <= sleeps[0] <= 10


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


def test_sync_instance_uses_sibling_sync_endpoint(monkeypatch) -> None:
    monkeypatch.setenv("WORKFLOW_BUILDER_URL", "http://workflow-builder:3000")
    calls: list[str] = []

    def fake_post(url, **_kwargs):
        calls.append(url)
        return _Response(200, body={"instance": {"inferenceStatus": "inferred"}})

    monkeypatch.setattr(worker.requests, "post", fake_post)

    instance = worker._sync_instance(
        {
            "callback": {
                "path": "/api/internal/benchmarks/runs/r/instances/i/execution"
            }
        }
    )

    assert calls == ["http://workflow-builder:3000/api/internal/benchmarks/runs/r/instances/i/sync"]
    assert instance == {"inferenceStatus": "inferred"}


def test_run_waits_for_dapr_terminal_after_bff_sync_reports_terminal_inference(
    monkeypatch, tmp_path
) -> None:
    payload = {
        "executionId": "hexec_1",
        "workflowExecutionId": "exec_1",
        "workflow": {"id": "wf"},
        "workflowId": "wf",
        "timeoutSeconds": 60,
        "callback": {"path": "/callback/execution"},
    }
    payload_path = tmp_path / "request.json"
    payload_path.write_text(json.dumps(payload), encoding="utf-8")
    monkeypatch.setenv("EXECUTION_REQUEST_PATH", str(payload_path))
    monkeypatch.setattr(worker, "_install_signal_handlers", lambda: None)
    monkeypatch.setattr(worker, "_start_workflow", lambda _payload: "sw-1")
    statuses = iter([
        {"runtimeStatus": "RUNNING"},
        {"runtimeStatus": "COMPLETED", "output": {"ok": True}},
    ])
    monkeypatch.setattr(worker, "_workflow_status", lambda _instance_id: next(statuses))
    monkeypatch.setattr(
        worker,
        "_sync_instance",
        lambda _payload: {"status": "evaluating", "inferenceStatus": "inferred"},
    )
    callbacks: list[dict[str, object]] = []
    terminated: list[tuple[str, str]] = []
    monkeypatch.setattr(worker, "_post_callback", lambda _payload, body: callbacks.append(body))
    monkeypatch.setattr(
        worker,
        "_terminate_workflow",
        lambda instance_id, reason: terminated.append((instance_id, reason)),
    )
    monkeypatch.setattr(worker, "_sleep", lambda _seconds: None)

    assert worker._run() == 0
    assert callbacks == [
        {"status": "running", "hostExecutionId": "hexec_1", "daprInstanceId": "sw-1"},
        {
            "status": "success",
            "hostExecutionId": "hexec_1",
            "daprInstanceId": "sw-1",
            "output": {"ok": True},
            "error": None,
        },
    ]
    assert terminated == []


def test_run_requeues_when_workflow_stays_pending_at_startup(monkeypatch, tmp_path) -> None:
    payload = {
        "executionId": "hexec_1",
        "workflowExecutionId": "exec_1",
        "workflow": {"id": "wf"},
        "workflowId": "wf",
        "timeoutSeconds": 60,
        "callback": {"path": "/callback/execution"},
    }
    payload_path = tmp_path / "request.json"
    payload_path.write_text(json.dumps(payload), encoding="utf-8")
    monkeypatch.setenv("EXECUTION_REQUEST_PATH", str(payload_path))
    monkeypatch.setenv("SANDBOX_EXECUTION_WORKFLOW_PENDING_TIMEOUT_SECONDS", "0")
    monkeypatch.setattr(worker, "_install_signal_handlers", lambda: None)
    monkeypatch.setattr(worker, "_start_workflow", lambda _payload: "sw-1")
    monkeypatch.setattr(
        worker,
        "_workflow_status",
        lambda _instance_id: {"runtimeStatus": "PENDING"},
    )
    monkeypatch.setattr(
        worker,
        "_orchestrator_readyz",
        lambda: {"workflowConnectedWorkers": 0, "taskhub": {"ready": False}},
    )
    callbacks: list[dict[str, object]] = []
    terminated: list[tuple[str, str]] = []
    monkeypatch.setattr(worker, "_post_callback", lambda _payload, body: callbacks.append(body))
    monkeypatch.setattr(
        worker,
        "_terminate_workflow",
        lambda instance_id, reason: terminated.append((instance_id, reason)),
    )

    assert worker._run() == 0
    assert callbacks == [
        {
            "status": "transient",
            "hostExecutionId": "hexec_1",
            "daprInstanceId": "sw-1",
            "error": "workflow_start_pending_timeout",
            "terminationReason": "workflow_start_pending_timeout",
            "retryable": True,
            "retryAfterSeconds": 15,
            "output": {
                "reason": "workflow_start_pending_timeout",
                "startup": {
                    "workflowStatus": {"runtimeStatus": "PENDING"},
                    "readyz": {
                        "workflowConnectedWorkers": 0,
                        "taskhub": {"ready": False},
                    },
                },
            },
        }
    ]
    assert terminated == [("sw-1", "workflow_start_pending_timeout")]


def test_run_posts_running_callback_after_startup_running(monkeypatch, tmp_path) -> None:
    payload = {
        "executionId": "hexec_1",
        "workflowExecutionId": "exec_1",
        "workflow": {"id": "wf"},
        "workflowId": "wf",
        "timeoutSeconds": 60,
        "callback": {"path": "/callback/execution"},
    }
    payload_path = tmp_path / "request.json"
    payload_path.write_text(json.dumps(payload), encoding="utf-8")
    monkeypatch.setenv("EXECUTION_REQUEST_PATH", str(payload_path))
    monkeypatch.setattr(worker, "_install_signal_handlers", lambda: None)
    monkeypatch.setattr(worker, "_start_workflow", lambda _payload: "sw-1")
    statuses = iter([
        {"runtimeStatus": "RUNNING"},
        {"runtimeStatus": "COMPLETED", "output": {"ok": True}},
    ])
    monkeypatch.setattr(worker, "_workflow_status", lambda _instance_id: next(statuses))
    callbacks: list[dict[str, object]] = []
    monkeypatch.setattr(worker, "_post_callback", lambda _payload, body: callbacks.append(body))
    monkeypatch.setattr(worker, "_sync_instance", lambda _payload: None)

    assert worker._run() == 0
    assert callbacks[0] == {
        "status": "running",
        "hostExecutionId": "hexec_1",
        "daprInstanceId": "sw-1",
    }
    assert callbacks[1]["status"] == "success"


def test_run_propagates_terminal_status_during_startup(monkeypatch, tmp_path) -> None:
    payload = {
        "executionId": "hexec_1",
        "workflowExecutionId": "exec_1",
        "workflow": {"id": "wf"},
        "workflowId": "wf",
        "timeoutSeconds": 60,
        "callback": {"path": "/callback/execution"},
    }
    payload_path = tmp_path / "request.json"
    payload_path.write_text(json.dumps(payload), encoding="utf-8")
    monkeypatch.setenv("EXECUTION_REQUEST_PATH", str(payload_path))
    monkeypatch.setattr(worker, "_install_signal_handlers", lambda: None)
    monkeypatch.setattr(worker, "_start_workflow", lambda _payload: "sw-1")
    monkeypatch.setattr(
        worker,
        "_workflow_status",
        lambda _instance_id: {"runtimeStatus": "FAILED", "error": "boom"},
    )
    callbacks: list[dict[str, object]] = []
    monkeypatch.setattr(worker, "_post_callback", lambda _payload, body: callbacks.append(body))

    assert worker._run() == 1
    assert callbacks == [
        {
            "status": "error",
            "hostExecutionId": "hexec_1",
            "daprInstanceId": "sw-1",
            "output": None,
            "error": "boom",
        }
    ]


def test_run_leaves_started_workflow_when_shutdown_requested(monkeypatch, tmp_path) -> None:
    payload = {
        "executionId": "hexec_1",
        "workflowExecutionId": "exec_1",
        "workflow": {"id": "wf"},
        "workflowId": "wf",
        "timeoutSeconds": 60,
        "callback": {"path": "/callback"},
    }
    payload_path = tmp_path / "request.json"
    payload_path.write_text(json.dumps(payload), encoding="utf-8")
    monkeypatch.setenv("EXECUTION_REQUEST_PATH", str(payload_path))
    monkeypatch.setattr(worker, "_install_signal_handlers", lambda: None)
    monkeypatch.setattr(worker, "_start_workflow", lambda _payload: "sw-1")
    callbacks: list[dict[str, object]] = []
    terminated: list[tuple[str, str]] = []
    monkeypatch.setattr(
        worker,
        "_workflow_status",
        lambda _instance_id: {"runtimeStatus": "RUNNING"},
    )
    monkeypatch.setattr(
        worker,
        "_terminate_workflow",
        lambda instance_id, reason: terminated.append((instance_id, reason)),
    )

    def fake_callback(_payload, body):
        callbacks.append(body)
        if body["status"] == "running":
            worker._termination_requested.set()

    monkeypatch.setattr(worker, "_post_callback", fake_callback)
    worker._termination_requested.clear()

    try:
        assert worker._run() == 0
    finally:
        worker._termination_requested.clear()

    assert terminated == []
    assert callbacks == [
        {"status": "running", "hostExecutionId": "hexec_1", "daprInstanceId": "sw-1"}
    ]


def test_run_does_not_overwrite_terminal_instance_when_cleanup_terminates_worker(
    monkeypatch, tmp_path
) -> None:
    payload = {
        "executionId": "hexec_1",
        "workflowExecutionId": "exec_1",
        "workflow": {"id": "wf"},
        "workflowId": "wf",
        "timeoutSeconds": 60,
        "callback": {"path": "/callback/execution"},
    }
    payload_path = tmp_path / "request.json"
    payload_path.write_text(json.dumps(payload), encoding="utf-8")
    monkeypatch.setenv("EXECUTION_REQUEST_PATH", str(payload_path))
    monkeypatch.setattr(worker, "_install_signal_handlers", lambda: None)
    monkeypatch.setattr(worker, "_start_workflow", lambda _payload: "sw-1")
    monkeypatch.setattr(
        worker,
        "_workflow_status",
        lambda _instance_id: {"runtimeStatus": "RUNNING"},
    )
    monkeypatch.setattr(
        worker,
        "_sync_instance",
        lambda _payload: {"status": "evaluating", "inferenceStatus": "inferred"},
    )
    callbacks: list[dict[str, object]] = []
    terminated: list[tuple[str, str]] = []
    monkeypatch.setattr(worker, "_post_callback", lambda _payload, body: callbacks.append(body))
    monkeypatch.setattr(
        worker,
        "_terminate_workflow",
        lambda instance_id, reason: terminated.append((instance_id, reason)),
    )

    def fake_sleep(_seconds):
        worker._termination_requested.set()

    monkeypatch.setattr(worker, "_sleep", fake_sleep)
    worker._termination_requested.clear()

    try:
        assert worker._run() == 0
    finally:
        worker._termination_requested.clear()

    assert terminated == []
    assert callbacks == [
        {"status": "running", "hostExecutionId": "hexec_1", "daprInstanceId": "sw-1"}
    ]

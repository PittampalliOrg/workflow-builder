from __future__ import annotations

import json
import hashlib
import os
import pathlib
import random
import signal
import sys
import threading
import time
from urllib.parse import quote
from typing import Any

import requests

TERMINAL_RUNTIME_STATUSES = {
    "COMPLETED": "success",
    "FAILED": "error",
    "TERMINATED": "cancelled",
    "CANCELED": "cancelled",
    "CANCELLED": "cancelled",
}
TERMINAL_INSTANCE_INFERENCE_STATUSES = {
    "inferred",
    "error",
    "timeout",
    "cancelled",
}

_termination_requested = threading.Event()


def _log(message: str) -> None:
    print(message, file=sys.stderr, flush=True)


def _env(name: str, default: str = "") -> str:
    return os.environ.get(name, default).strip()


def _load_payload() -> dict[str, Any]:
    payload_path = _env("EXECUTION_REQUEST_PATH")
    raw = pathlib.Path(payload_path).read_text(encoding="utf-8") if payload_path else ""
    if not raw:
        raw = _env("EXECUTION_REQUEST_JSON")
    if not raw:
        raise RuntimeError("EXECUTION_REQUEST_PATH or EXECUTION_REQUEST_JSON is required")
    payload = json.loads(raw)
    if not isinstance(payload, dict):
        raise RuntimeError("execution request payload must decode to an object")
    return payload


def _headers() -> dict[str, str]:
    headers = {"Content-Type": "application/json"}
    token = _env("INTERNAL_API_TOKEN")
    if token:
        headers["X-Internal-Token"] = token
        headers["Authorization"] = f"Bearer {token}"
    return headers


def _handle_termination(signum: int, _frame: object) -> None:
    _log(f"received signal {signum}; requesting workflow termination")
    _termination_requested.set()


def _install_signal_handlers() -> None:
    signal.signal(signal.SIGTERM, _handle_termination)
    signal.signal(signal.SIGINT, _handle_termination)


def _sleep(seconds: float) -> None:
    _termination_requested.wait(timeout=max(0.0, seconds))


def _callback_url(payload: dict[str, Any]) -> str:
    workflow_builder_url = _env(
        "WORKFLOW_BUILDER_URL",
        "http://workflow-builder.workflow-builder.svc.cluster.local:3000",
    ).rstrip("/")
    callback = payload.get("callback")
    if not isinstance(callback, dict) or not isinstance(callback.get("path"), str):
        raise RuntimeError("callback.path is required")
    return f"{workflow_builder_url}{callback['path']}"


def _sync_url(payload: dict[str, Any]) -> str | None:
    workflow_builder_url = _env(
        "WORKFLOW_BUILDER_URL",
        "http://workflow-builder.workflow-builder.svc.cluster.local:3000",
    ).rstrip("/")
    callback = payload.get("callback")
    if not isinstance(callback, dict) or not isinstance(callback.get("path"), str):
        return None
    path = callback["path"].rstrip("/")
    if not path.endswith("/execution"):
        return None
    return f"{workflow_builder_url}{path.removesuffix('/execution')}/sync"


def _post_callback(payload: dict[str, Any], body: dict[str, Any]) -> None:
    url = _callback_url(payload)
    attempts = max(1, int(_env("SANDBOX_EXECUTION_CALLBACK_ATTEMPTS", "8")))
    backoff_seconds = max(
        1.0,
        float(_env("SANDBOX_EXECUTION_CALLBACK_BACKOFF_SECONDS", "2")),
    )
    last_error: Exception | None = None
    for attempt in range(1, attempts + 1):
        try:
            res = requests.post(url, headers=_headers(), json=body, timeout=60)
            if res.status_code < 400:
                return
            last_error = RuntimeError(
                f"callback failed ({res.status_code}): {res.text[:800]}"
            )
        except requests.RequestException as exc:
            last_error = exc
        if attempt < attempts:
            time.sleep(min(30.0, backoff_seconds * attempt))
    raise RuntimeError(f"callback failed after {attempts} attempt(s): {last_error}")


def _sync_instance(payload: dict[str, Any]) -> dict[str, Any] | None:
    url = _sync_url(payload)
    if not url:
        return None
    try:
        res = requests.post(url, headers=_headers(), timeout=60)
    except requests.RequestException as exc:
        _log(f"instance sync failed transiently: {exc}")
        return None
    if res.status_code == 404:
        return None
    if res.status_code >= 400:
        _log(f"instance sync failed ({res.status_code}): {res.text[:800]}")
        return None
    body = res.json()
    if not isinstance(body, dict):
        return None
    instance = body.get("instance")
    return instance if isinstance(instance, dict) else None


def _terminal_instance_status(instance: dict[str, Any] | None) -> str | None:
    if not instance:
        return None
    inference_status = str(instance.get("inferenceStatus") or "").lower()
    if inference_status in TERMINAL_INSTANCE_INFERENCE_STATUSES:
        return inference_status
    status = str(instance.get("status") or "").lower()
    if status in {"evaluating", "resolved", "unresolved", "empty_patch"}:
        return inference_status or status
    return None


def _orchestrator_url() -> str:
    return _env(
        "WORKFLOW_ORCHESTRATOR_URL",
        "http://workflow-orchestrator.workflow-builder.svc.cluster.local:8080",
    ).rstrip("/")


def _is_transient_workflow_start_failure(status_code: int | None, detail: str) -> bool:
    if status_code in {408, 429, 500, 502, 503, 504}:
        return True
    lowered = detail.lower()
    return any(
        marker in lowered
        for marker in (
            "deadline_exceeded",
            "deadline exceeded",
            "rst_stream",
            "workflow_runtime_unavailable",
            "workflow runtime is not ready",
            "temporarily unavailable",
            "connection reset",
            "connection aborted",
            "connection refused",
            "read timed out",
        )
    )


def _workflow_start_backoff_seconds(attempt: int) -> float:
    base = max(
        1.0,
        float(_env("SANDBOX_EXECUTION_WORKFLOW_START_BACKOFF_SECONDS", "4")),
    )
    cap = max(
        base,
        float(_env("SANDBOX_EXECUTION_WORKFLOW_START_MAX_BACKOFF_SECONDS", "45")),
    )
    return min(cap, base * attempt) + random.uniform(0, min(1.0, base))


def _workflow_start_stagger_seconds(payload: dict[str, Any]) -> float:
    window = max(
        0.0,
        float(_env("SANDBOX_EXECUTION_WORKFLOW_START_STAGGER_SECONDS", "0")),
    )
    if window <= 0:
        return 0.0
    key = str(
        payload.get("executionId")
        or payload.get("workflowExecutionId")
        or payload.get("instanceId")
        or ""
    )
    digest = hashlib.sha256(key.encode("utf-8")).hexdigest()
    bucket = int(digest[:12], 16) / float(0xFFFFFFFFFFFF)
    return bucket * window


def _stagger_workflow_start(payload: dict[str, Any]) -> None:
    sleep_seconds = _workflow_start_stagger_seconds(payload)
    if sleep_seconds <= 0:
        return
    _log(f"staggering workflow start for {sleep_seconds:.1f}s")
    _sleep(sleep_seconds)


def _workflow_baggage(payload: dict[str, Any]) -> str:
    mlflow_context = payload.get("mlflowContext")
    if not isinstance(mlflow_context, dict):
        mlflow_context = {}
    attrs = {
        "session.id": payload.get("workflowExecutionId"),
        "workflow.execution.id": payload.get("workflowExecutionId"),
        "workflow.id": payload.get("workflowId"),
        "workflow_builder.trace_group_id": payload.get("workflowExecutionId"),
        "mlflow.experiment_id": mlflow_context.get("traceExperimentId")
        or mlflow_context.get("experimentId"),
        "mlflow.run_id": mlflow_context.get("runId"),
        "mlflow.parent_run_id": mlflow_context.get("parentRunId"),
        "mlflow.modelId": mlflow_context.get("activeModelId"),
        "mlflow.model.uri": mlflow_context.get("activeModelUri"),
    }
    return ",".join(
        f"{key}={quote(str(value), safe='')}"
        for key, value in attrs.items()
        if isinstance(value, str) and value.strip()
    )


def _start_workflow_once(payload: dict[str, Any]) -> str:
    headers = {"Content-Type": "application/json"}
    trace_context = payload.get("traceContext")
    if not isinstance(trace_context, dict):
        trace_context = {}
    for key in ("traceparent", "tracestate", "baggage"):
        value = trace_context.get(key)
        if isinstance(value, str) and value.strip():
            headers[key] = value.strip()
    baggage = _workflow_baggage(payload)
    if baggage:
        headers["baggage"] = ",".join(
            part for part in (headers.get("baggage"), baggage) if part
        )
    if isinstance(payload.get("workflowExecutionId"), str):
        headers["x-workflow-session-id"] = payload["workflowExecutionId"]
    # Cutover P3 (item 15): the payload carries EITHER an SW spec ("workflow")
    # or a dynamic-script build ("script"/"meta"). Route to the matching
    # orchestrator endpoint so the benchmark producer can flip engines without
    # touching this worker.
    script = payload.get("script")
    if isinstance(script, str) and script.strip():
        endpoint = f"{_orchestrator_url()}/api/v2/script-workflows"
        body = {
            "script": script,
            "scriptSha256": payload.get("scriptSha256") or "",
            "meta": payload.get("meta") or {},
            "args": payload.get("triggerData") or {},
            "nested": False,
            "dispatchMode": "batch-v2",
            "workflowId": payload["workflowId"],
            "dbExecutionId": payload["workflowExecutionId"],
            "userId": payload.get("userId"),
            "projectId": payload.get("projectId"),
            "defaults": payload.get("defaults") or {},
            "limits": payload.get("limits") or {},
            "features": payload.get("features") or {},
        }
    else:
        endpoint = f"{_orchestrator_url()}/api/v2/sw-workflows"
        body = {
            "workflow": payload["workflow"],
            "workflowId": payload["workflowId"],
            "triggerData": payload.get("triggerData") or {},
            "dbExecutionId": payload["workflowExecutionId"],
            "mlflowContext": payload.get("mlflowContext"),
        }
    res = requests.post(
        endpoint,
        json=body,
        headers=headers,
        timeout=max(
            30,
            int(_env("SANDBOX_EXECUTION_WORKFLOW_START_TIMEOUT_SECONDS", "120")),
        ),
    )
    if res.status_code >= 400:
        raise RuntimeError(f"workflow start failed ({res.status_code}): {res.text[:1200]}")
    body = res.json()
    instance_id = body.get("instanceId")
    if not isinstance(instance_id, str) or not instance_id:
        raise RuntimeError("workflow start response did not include instanceId")
    return instance_id


def _start_workflow(payload: dict[str, Any]) -> str:
    attempts = max(
        1,
        int(_env("SANDBOX_EXECUTION_WORKFLOW_START_ATTEMPTS", "10")),
    )
    last_error: Exception | None = None
    for attempt in range(1, attempts + 1):
        try:
            return _start_workflow_once(payload)
        except requests.RequestException as exc:
            last_error = exc
            transient = _is_transient_workflow_start_failure(None, str(exc))
        except RuntimeError as exc:
            last_error = exc
            message = str(exc)
            status_code: int | None = None
            if message.startswith("workflow start failed ("):
                status_text = message.split("(", 1)[1].split(")", 1)[0]
                try:
                    status_code = int(status_text)
                except ValueError:
                    status_code = None
            transient = _is_transient_workflow_start_failure(status_code, message)
        if not transient or attempt >= attempts:
            break
        sleep_seconds = _workflow_start_backoff_seconds(attempt)
        _log(
            f"workflow start attempt {attempt}/{attempts} failed transiently; retrying in {sleep_seconds:.1f}s: {last_error}",
        )
        time.sleep(sleep_seconds)
    raise RuntimeError(
        f"workflow start failed after {attempt} attempt(s): {last_error}"
    )


def _workflow_status(instance_id: str) -> dict[str, Any]:
    res = requests.get(
        f"{_orchestrator_url()}/api/v2/workflows/{instance_id}/status",
        timeout=60,
    )
    if res.status_code >= 400:
        raise RuntimeError(f"workflow status failed ({res.status_code}): {res.text[:800]}")
    body = res.json()
    if not isinstance(body, dict):
        raise RuntimeError("workflow status response was not an object")
    return body


def _orchestrator_readyz() -> dict[str, Any]:
    try:
        res = requests.get(f"{_orchestrator_url()}/readyz", timeout=10)
        body: dict[str, Any]
        try:
            raw = res.json()
            body = raw if isinstance(raw, dict) else {"body": raw}
        except Exception:
            body = {"body": res.text[:1000]}
        body["httpStatus"] = res.status_code
        return body
    except Exception as exc:
        return {"error": str(exc)}


def _pending_start_timeout_seconds() -> float:
    return max(
        0.0,
        float(_env("SANDBOX_EXECUTION_WORKFLOW_PENDING_TIMEOUT_SECONDS", "30")),
    )


def _pending_start_poll_seconds() -> float:
    return max(
        0.5,
        float(_env("SANDBOX_EXECUTION_WORKFLOW_PENDING_POLL_SECONDS", "2")),
    )


def _wait_for_workflow_start_ready(
    payload: dict[str, Any],
    *,
    execution_id: str,
    instance_id: str,
) -> tuple[str, dict[str, Any]]:
    timeout_seconds = _pending_start_timeout_seconds()
    deadline = time.monotonic() + timeout_seconds
    last_status: dict[str, Any] = {}
    while True:
        last_status = _workflow_status(instance_id)
        runtime_status = str(last_status.get("runtimeStatus") or "").upper()
        if runtime_status == "RUNNING":
            return "running", last_status
        if runtime_status in TERMINAL_RUNTIME_STATUSES:
            return "terminal", last_status
        if runtime_status and runtime_status != "PENDING":
            _log(
                "workflow startup observed non-running status "
                f"execution={execution_id} daprInstance={instance_id} "
                f"runtimeStatus={runtime_status}"
            )
        if timeout_seconds <= 0 or time.monotonic() >= deadline:
            readyz = _orchestrator_readyz()
            _log(
                "workflow remained pending beyond startup threshold "
                f"execution={execution_id} daprInstance={instance_id} "
                f"timeoutSeconds={timeout_seconds} "
                f"runtimeStatus={runtime_status or '<empty>'} "
                f"readyz={json.dumps(readyz, default=str)[:1200]}"
            )
            return "pending-timeout", {"workflowStatus": last_status, "readyz": readyz}
        if _termination_requested.is_set():
            return "terminated", last_status
        _sleep(min(_pending_start_poll_seconds(), max(0.0, deadline - time.monotonic())))


def _terminate_workflow(instance_id: str, reason: str) -> None:
    res = requests.post(
        f"{_orchestrator_url()}/api/v2/workflows/{instance_id}/terminate",
        json={"reason": reason},
        headers=_headers(),
        timeout=30,
    )
    if res.status_code >= 400:
        raise RuntimeError(
            f"workflow terminate failed ({res.status_code}): {res.text[:800]}"
        )


def _cancel_started_workflow(
    payload: dict[str, Any],
    *,
    execution_id: str,
    instance_id: str,
    reason: str,
) -> None:
    termination_error: str | None = None
    try:
        _terminate_workflow(instance_id, reason)
    except Exception as exc:
        termination_error = str(exc)
        _log(f"workflow termination failed for {instance_id}: {exc}")

    callback_body: dict[str, Any] = {
        "status": "cancelled",
        "hostExecutionId": execution_id,
        "daprInstanceId": instance_id,
        "error": reason,
    }
    if termination_error:
        callback_body["terminationError"] = termination_error
    _post_callback(payload, callback_body)


def _defer_started_workflow_after_worker_termination(
    payload: dict[str, Any],
    *,
    execution_id: str,
    instance_id: str,
) -> int:
    terminal_instance_status = _terminal_instance_status(_sync_instance(payload))
    if terminal_instance_status:
        _log(
            "host execution worker terminated after benchmark instance reached "
            "terminal inference state; leaving terminal result intact "
            f"execution={execution_id} daprInstance={instance_id} "
            f"inferenceStatus={terminal_instance_status}"
        )
        return 0

    try:
        last_status = _workflow_status(instance_id)
    except Exception as exc:
        _log(
            "host execution worker terminated while workflow status was unavailable; "
            "leaving child workflow for coordinator sync or timeout "
            f"execution={execution_id} daprInstance={instance_id} error={exc}"
        )
        return 0

    runtime_status = str(last_status.get("runtimeStatus") or "").upper()
    if runtime_status in TERMINAL_RUNTIME_STATUSES:
        status = TERMINAL_RUNTIME_STATUSES[runtime_status]
        _post_callback(
            payload,
            {
                "status": status,
                "hostExecutionId": execution_id,
                "daprInstanceId": instance_id,
                "output": last_status.get("output")
                if "output" in last_status
                else last_status.get("outputs"),
                "error": last_status.get("error"),
            },
        )
        _log(
            "terminal callback posted during worker termination "
            f"execution={execution_id} daprInstance={instance_id} "
            f"runtimeStatus={runtime_status} status={status}"
        )
        return 0 if status == "success" else 1

    _log(
        "host execution worker terminated while child workflow was still active; "
        "leaving workflow for coordinator sync or timeout "
        f"execution={execution_id} daprInstance={instance_id} "
        f"runtimeStatus={runtime_status or '<empty>'}"
    )
    return 0


def _run() -> int:
    _install_signal_handlers()
    payload = _load_payload()
    execution_id = str(payload.get("executionId") or payload["workflowExecutionId"])
    instance_id: str | None = None
    run_id = str(payload.get("runId") or "")
    benchmark_instance_id = str(payload.get("instanceId") or "")
    try:
        _log(
            "host execution worker starting "
            f"execution={execution_id} run={run_id} "
            f"instance={benchmark_instance_id} class={payload.get('executionClass')} "
            f"timeoutSeconds={payload.get('timeoutSeconds')}"
        )
        _stagger_workflow_start(payload)
        if _termination_requested.is_set():
            raise RuntimeError("host execution worker terminated before workflow start")
        _log(
            "starting workflow "
            f"execution={execution_id} workflowExecution={payload.get('workflowExecutionId')}"
        )
        instance_id = _start_workflow(payload)
        _log(f"workflow started execution={execution_id} daprInstance={instance_id}")
        if _termination_requested.is_set():
            return _defer_started_workflow_after_worker_termination(
                payload,
                execution_id=execution_id,
                instance_id=instance_id,
            )
        startup_status, startup_detail = _wait_for_workflow_start_ready(
            payload,
            execution_id=execution_id,
            instance_id=instance_id,
        )
        if startup_status == "pending-timeout":
            reason = "workflow_start_pending_timeout"
            termination_error: str | None = None
            try:
                _terminate_workflow(instance_id, reason)
            except Exception as exc:
                termination_error = str(exc)
                _log(f"workflow termination failed for pending {instance_id}: {exc}")
            output = {
                "reason": reason,
                "startup": startup_detail,
            }
            if termination_error:
                output["terminationError"] = termination_error
            _post_callback(
                payload,
                {
                    "status": "transient",
                    "hostExecutionId": execution_id,
                    "daprInstanceId": instance_id,
                    "error": reason,
                    "terminationReason": reason,
                    "retryable": True,
                    "retryAfterSeconds": int(
                        _env("SANDBOX_EXECUTION_WORKFLOW_PENDING_RETRY_SECONDS", "15")
                    ),
                    "output": output,
                },
            )
            _log(
                "transient callback posted "
                f"execution={execution_id} daprInstance={instance_id} reason={reason}"
            )
            return 0
        if startup_status == "terminal":
            runtime_status = str(startup_detail.get("runtimeStatus") or "").upper()
            status = TERMINAL_RUNTIME_STATUSES[runtime_status]
            _post_callback(
                payload,
                {
                    "status": status,
                    "hostExecutionId": execution_id,
                    "daprInstanceId": instance_id,
                    "output": startup_detail.get("output")
                    if "output" in startup_detail
                    else startup_detail.get("outputs"),
                    "error": startup_detail.get("error"),
                },
            )
            _log(
                "terminal callback posted during startup "
                f"execution={execution_id} daprInstance={instance_id} "
                f"runtimeStatus={runtime_status} status={status}"
            )
            return 0 if status == "success" else 1
        if startup_status == "terminated":
            return _defer_started_workflow_after_worker_termination(
                payload,
                execution_id=execution_id,
                instance_id=instance_id,
            )
        _post_callback(
            payload,
            {
                "status": "running",
                "hostExecutionId": execution_id,
                "daprInstanceId": instance_id,
            },
        )
        _log(f"running callback posted execution={execution_id} daprInstance={instance_id}")
        deadline = time.monotonic() + int(payload.get("timeoutSeconds") or 7200) + 300
        poll_seconds = max(2, int(_env("SANDBOX_EXECUTION_WORKER_POLL_SECONDS", "15")))
        last_status: dict[str, Any] = {}
        previous_runtime_status: str | None = None
        previous_terminal_instance_status: str | None = None
        while time.monotonic() < deadline:
            if _termination_requested.is_set():
                if previous_terminal_instance_status:
                    return _defer_started_workflow_after_worker_termination(
                        payload,
                        execution_id=execution_id,
                        instance_id=instance_id,
                    )
                return _defer_started_workflow_after_worker_termination(
                    payload,
                    execution_id=execution_id,
                    instance_id=instance_id,
                )
            last_status = _workflow_status(instance_id)
            runtime_status = str(last_status.get("runtimeStatus") or "").upper()
            if runtime_status != previous_runtime_status:
                _log(
                    "workflow status changed "
                    f"execution={execution_id} daprInstance={instance_id} "
                    f"runtimeStatus={runtime_status or '<empty>'}"
                )
                previous_runtime_status = runtime_status
            if runtime_status in TERMINAL_RUNTIME_STATUSES:
                status = TERMINAL_RUNTIME_STATUSES[runtime_status]
                _post_callback(
                    payload,
                    {
                        "status": status,
                        "hostExecutionId": execution_id,
                        "daprInstanceId": instance_id,
                        "output": last_status.get("output")
                        if "output" in last_status
                        else last_status.get("outputs"),
                        "error": last_status.get("error"),
                    },
                )
                _log(
                    "terminal callback posted "
                    f"execution={execution_id} daprInstance={instance_id} "
                    f"runtimeStatus={runtime_status} status={status}"
                )
                return 0 if status == "success" else 1
            terminal_instance_status = _terminal_instance_status(_sync_instance(payload))
            if terminal_instance_status:
                if terminal_instance_status != previous_terminal_instance_status:
                    _log(
                        "benchmark instance reached terminal inference state; "
                        "continuing to wait for Dapr workflow terminal state "
                        f"execution={execution_id} daprInstance={instance_id} "
                        f"inferenceStatus={terminal_instance_status}"
                    )
                    previous_terminal_instance_status = terminal_instance_status
            _sleep(poll_seconds)
        if _termination_requested.is_set():
            return _defer_started_workflow_after_worker_termination(
                payload,
                execution_id=execution_id,
                instance_id=instance_id,
            )
        _post_callback(
            payload,
            {
                "status": "timeout",
                "hostExecutionId": execution_id,
                "daprInstanceId": instance_id,
                "output": last_status,
                "error": "host execution worker timed out waiting for workflow",
            },
        )
        _log(f"timeout callback posted execution={execution_id} daprInstance={instance_id}")
        return 1
    except Exception as exc:
        try:
            _post_callback(
                payload,
                {
                    "status": "error",
                    "hostExecutionId": execution_id,
                    "daprInstanceId": instance_id,
                    "error": str(exc),
                },
            )
        except Exception as callback_exc:
            _log(f"callback after failure also failed: {callback_exc}")
        _log(str(exc))
        return 1


if __name__ == "__main__":
    raise SystemExit(_run())

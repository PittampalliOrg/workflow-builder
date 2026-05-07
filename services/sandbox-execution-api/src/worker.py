from __future__ import annotations

import json
import os
import pathlib
import random
import sys
import time
from typing import Any

import requests

TERMINAL_RUNTIME_STATUSES = {
    "COMPLETED": "success",
    "FAILED": "error",
    "TERMINATED": "cancelled",
    "CANCELED": "cancelled",
    "CANCELLED": "cancelled",
}


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


def _callback_url(payload: dict[str, Any]) -> str:
    workflow_builder_url = _env(
        "WORKFLOW_BUILDER_URL",
        "http://workflow-builder.workflow-builder.svc.cluster.local:3000",
    ).rstrip("/")
    callback = payload.get("callback")
    if not isinstance(callback, dict) or not isinstance(callback.get("path"), str):
        raise RuntimeError("callback.path is required")
    return f"{workflow_builder_url}{callback['path']}"


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


def _start_workflow_once(payload: dict[str, Any]) -> str:
    res = requests.post(
        f"{_orchestrator_url()}/api/v2/sw-workflows",
        json={
            "workflow": payload["workflow"],
            "workflowId": payload["workflowId"],
            "triggerData": payload.get("triggerData") or {},
            "dbExecutionId": payload["workflowExecutionId"],
        },
        headers={"Content-Type": "application/json"},
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
        print(
            f"workflow start attempt {attempt}/{attempts} failed transiently; retrying in {sleep_seconds:.1f}s: {last_error}",
            file=sys.stderr,
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


def _run() -> int:
    payload = _load_payload()
    execution_id = str(payload.get("executionId") or payload["workflowExecutionId"])
    instance_id: str | None = None
    try:
        instance_id = _start_workflow(payload)
        _post_callback(
            payload,
            {
                "status": "running",
                "hostExecutionId": execution_id,
                "daprInstanceId": instance_id,
            },
        )
        deadline = time.monotonic() + int(payload.get("timeoutSeconds") or 7200) + 300
        poll_seconds = max(2, int(_env("SANDBOX_EXECUTION_WORKER_POLL_SECONDS", "15")))
        last_status: dict[str, Any] = {}
        while time.monotonic() < deadline:
            last_status = _workflow_status(instance_id)
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
                return 0 if status == "success" else 1
            time.sleep(poll_seconds)
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
            print(f"callback after failure also failed: {callback_exc}", file=sys.stderr)
        print(str(exc), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(_run())

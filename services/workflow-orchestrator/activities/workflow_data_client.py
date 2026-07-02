"""Client for workflow-builder's internal workflow-data API.

The orchestrator should not own workflow-builder product tables. Activities use
this client in HTTP mode; the BFF maps the requests to the active persistence
adapter. Direct Postgres access is kept in selected activities only as an
explicit rollback path while the boundary is being migrated.
"""

from __future__ import annotations

import os
from typing import Any
from urllib.parse import quote, urlencode

import requests

from core.config import config


class WorkflowDataApiError(RuntimeError):
    """Raised when the workflow-data API cannot satisfy a request."""


def workflow_data_api_mode() -> str:
    mode = str(os.environ.get("WORKFLOW_DATA_API_MODE") or "http-fallback-db").strip().lower()
    if mode in {"postgres", "http", "http-fallback-db"}:
        return mode
    return "http-fallback-db"


def _timeout_seconds() -> float:
    try:
        return max(0.1, float(os.environ.get("WORKFLOW_DATA_API_TIMEOUT_SECONDS", "5")))
    except ValueError:
        return 5.0


def _direct_base_url() -> str:
    return os.environ.get(
        "WORKFLOW_BUILDER_URL",
        "http://workflow-builder.workflow-builder.svc.cluster.local:3000",
    ).rstrip("/")


def _dapr_invoke_base_url() -> str:
    app_id = os.environ.get("WORKFLOW_BUILDER_APP_ID", "workflow-builder").strip()
    if not app_id:
        raise WorkflowDataApiError("WORKFLOW_BUILDER_APP_ID is required for Dapr invocation")
    return (
        f"http://{config.DAPR_HOST}:{config.DAPR_HTTP_PORT}"
        f"/v1.0/invoke/{app_id}/method"
    )


def _base_url() -> str:
    transport = str(os.environ.get("WORKFLOW_DATA_API_TRANSPORT") or "dapr").strip().lower()
    if transport == "direct":
        return _direct_base_url()
    if transport == "dapr":
        return _dapr_invoke_base_url()
    raise WorkflowDataApiError(
        f"Unsupported WORKFLOW_DATA_API_TRANSPORT={transport!r}; use 'dapr' or 'direct'"
    )


class WorkflowDataClient:
    def __init__(self) -> None:
        session_factory = getattr(requests, "Session", None)
        self._session = session_factory() if callable(session_factory) else requests

    def _request(
        self,
        method: str,
        path: str,
        *,
        json_body: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        token = os.environ.get("INTERNAL_API_TOKEN", "").strip()
        if not token:
            raise WorkflowDataApiError("INTERNAL_API_TOKEN is required for workflow-data API")
        normalized_path = "/" + path.lstrip("/")
        request_fn = getattr(self._session, "request", None)
        uses_generic_request = callable(request_fn)
        if not uses_generic_request:
            request_fn = getattr(self._session, method.lower(), None)
        if not callable(request_fn):
            raise WorkflowDataApiError(
                f"requests adapter does not support {method} for workflow-data API"
            )
        request_kwargs = {
            "headers": {
                "Content-Type": "application/json",
                "X-Internal-Token": token,
            },
            "json": json_body,
            "timeout": _timeout_seconds(),
        }
        url = f"{_base_url()}{normalized_path}"
        response = (
            request_fn(method, url, **request_kwargs)
            if uses_generic_request
            else request_fn(url, **request_kwargs)
        )
        if response.status_code >= 400:
            raise WorkflowDataApiError(
                f"workflow-data {method} {normalized_path} failed "
                f"({response.status_code}): {response.text[:500]}"
            )
        try:
            payload = response.json()
        except ValueError as exc:
            raise WorkflowDataApiError(
                f"workflow-data {method} {normalized_path} returned non-JSON"
            ) from exc
        if not isinstance(payload, dict):
            raise WorkflowDataApiError(
                f"workflow-data {method} {normalized_path} returned non-object JSON"
            )
        return payload

    def get_workflow(self, workflow_ref: str, *, by: str | None = None) -> dict[str, Any] | None:
        suffix = f"?{urlencode({'by': by})}" if by else ""
        payload = self._request(
            "GET",
            f"/api/internal/workflow-data/workflows/{quote(workflow_ref, safe='')}{suffix}",
        )
        workflow = payload.get("workflow")
        return workflow if isinstance(workflow, dict) else None

    def get_execution(self, execution_id: str) -> dict[str, Any] | None:
        payload = self._request(
            "GET",
            f"/api/internal/workflow-data/executions/{quote(execution_id, safe='')}",
        )
        execution = payload.get("execution")
        return execution if isinstance(execution, dict) else None

    def patch_execution(self, execution_id: str, patch: dict[str, Any]) -> dict[str, Any]:
        return self._request(
            "PATCH",
            f"/api/internal/workflow-data/executions/{quote(execution_id, safe='')}",
            json_body=patch,
        )

    def append_execution_log(
        self,
        execution_id: str,
        payload: dict[str, Any],
    ) -> dict[str, Any]:
        return self._request(
            "POST",
            f"/api/internal/workflow-data/executions/{quote(execution_id, safe='')}/logs",
            json_body=payload,
        )

    def update_execution_log(
        self,
        execution_id: str,
        log_id: str,
        payload: dict[str, Any],
    ) -> dict[str, Any]:
        return self._request(
            "PATCH",
            "/api/internal/workflow-data/executions/"
            f"{quote(execution_id, safe='')}/logs/{quote(log_id, safe='')}",
            json_body=payload,
        )

    def upsert_workflow_artifact(
        self,
        execution_id: str,
        payload: dict[str, Any],
    ) -> dict[str, Any]:
        return self._request(
            "POST",
            f"/api/internal/workflow-data/executions/{quote(execution_id, safe='')}/artifacts",
            json_body=payload,
        )

    def upsert_workspace_session(self, payload: dict[str, Any]) -> dict[str, Any]:
        return self._request(
            "POST",
            "/api/internal/workflow-data/workspace-sessions",
            json_body=payload,
        )

    def resolve_mcp_config(self, payload: dict[str, Any]) -> dict[str, Any]:
        return self._request(
            "POST",
            "/api/internal/workflow-data/mcp/resolve",
            json_body=payload,
        )

    def schedule_agent_run(self, payload: dict[str, Any]) -> dict[str, Any]:
        return self._request(
            "POST",
            "/api/internal/workflow-data/agent-runs",
            json_body=payload,
        )

    def update_agent_run(self, run_id: str, payload: dict[str, Any]) -> dict[str, Any]:
        return self._request(
            "PATCH",
            f"/api/internal/workflow-data/agent-runs/{quote(run_id, safe='')}",
            json_body=payload,
        )

    def upsert_plan_artifact(self, payload: dict[str, Any]) -> dict[str, Any]:
        return self._request(
            "POST",
            "/api/internal/workflow-data/plan-artifacts",
            json_body=payload,
        )

    def update_plan_artifact(self, artifact_ref: str, payload: dict[str, Any]) -> dict[str, Any]:
        return self._request(
            "PATCH",
            f"/api/internal/workflow-data/plan-artifacts/{quote(artifact_ref, safe='')}",
            json_body=payload,
        )

    def get_plan_artifact(self, artifact_ref: str) -> dict[str, Any] | None:
        payload = self._request(
            "GET",
            f"/api/internal/workflow-data/plan-artifacts/{quote(artifact_ref, safe='')}",
        )
        artifact = payload.get("artifact")
        return artifact if isinstance(artifact, dict) else None

    def get_trace_targets(self, execution_id: str) -> list[dict[str, Any]]:
        payload = self._request(
            "GET",
            "/api/internal/workflow-data/traces/executions/"
            f"{quote(execution_id, safe='')}/targets",
        )
        targets = payload.get("targets")
        return [item for item in targets if isinstance(item, dict)] if isinstance(targets, list) else []

    def upsert_trace_lineage(self, payload: dict[str, Any]) -> dict[str, Any]:
        return self._request(
            "POST",
            "/api/internal/workflow-data/traces/lineage",
            json_body=payload,
        )


workflow_data_client = WorkflowDataClient()

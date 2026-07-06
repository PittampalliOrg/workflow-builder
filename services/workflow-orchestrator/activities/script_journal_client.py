"""HTTP client for the dynamic-script journal (workflow_script_calls) API.

The dynamic-script engine keeps its per-call journal in a dedicated
``workflow_script_calls`` table (design flaw #1: the journal must NOT ride inside
Dapr activity inputs). This client is the orchestrator's window onto that table
via WS3's internal BFF routes, and is the SOLE forwarder of results into the
``evaluate_script`` HTTP call.

Route contract (internal-token; mirrors the artifacts-endpoint pattern — distinct
from ``activities.workflow_data_client`` which targets ``/api/internal/workflow-data``):

  GET  /api/internal/workflows/executions/{executionId}/script-calls
       -> { "scriptCalls": [ { callId, kind, seq, baseHash, occurrence, label,
              phase, promptSha256, status, sessionId, result, errorCode, retries,
              tokensUsed } ], "logCount"?: int }
  PUT  /api/internal/workflows/executions/{executionId}/script-calls/{callId}
       body { seq, kind, baseHash, occurrence, label, phase, promptSha256, status,
              sessionId?, result?, errorCode?, retries, tokensUsed? }  (idempotent upsert)
  POST /api/internal/workflows/executions/{executionId}/script-calls/import
       body { fromExecutionId }  -> { imported: int }
  GET  /api/internal/workflows/executions/{executionId}/llm-usage
       -> { totalTokens: int }

Transport mirrors ``workflow_data_client`` (Dapr service-invoke by default, direct
HTTP when ``WORKFLOW_DATA_API_TRANSPORT=direct``) so the two clients share the
same reachability/auth story.
"""

from __future__ import annotations

import os
from typing import Any
from urllib.parse import quote

import requests

from core.config import config


class ScriptJournalApiError(RuntimeError):
    """Raised when the script-journal API cannot satisfy a request."""


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
        raise ScriptJournalApiError("WORKFLOW_BUILDER_APP_ID is required for Dapr invocation")
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
    raise ScriptJournalApiError(
        f"Unsupported WORKFLOW_DATA_API_TRANSPORT={transport!r}; use 'dapr' or 'direct'"
    )


class ScriptJournalClient:
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
            raise ScriptJournalApiError("INTERNAL_API_TOKEN is required for the script-journal API")
        normalized_path = "/" + path.lstrip("/")
        request_fn = getattr(self._session, "request", None)
        uses_generic_request = callable(request_fn)
        if not uses_generic_request:
            request_fn = getattr(self._session, method.lower(), None)
        if not callable(request_fn):
            raise ScriptJournalApiError(
                f"requests adapter does not support {method} for the script-journal API"
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
            raise ScriptJournalApiError(
                f"script-journal {method} {normalized_path} failed "
                f"({response.status_code}): {response.text[:500]}"
            )
        try:
            payload = response.json()
        except ValueError as exc:
            raise ScriptJournalApiError(
                f"script-journal {method} {normalized_path} returned non-JSON"
            ) from exc
        if not isinstance(payload, dict):
            raise ScriptJournalApiError(
                f"script-journal {method} {normalized_path} returned non-object JSON"
            )
        return payload

    # ---- journal rows --------------------------------------------------
    def list_script_calls(self, execution_id: str) -> list[dict[str, Any]]:
        payload = self._request(
            "GET",
            f"/api/internal/workflows/executions/{quote(execution_id, safe='')}/script-calls",
        )
        rows = payload.get("scriptCalls")
        return [row for row in rows if isinstance(row, dict)] if isinstance(rows, list) else []

    def put_script_call(
        self,
        execution_id: str,
        call_id: str,
        row: dict[str, Any],
    ) -> dict[str, Any]:
        return self._request(
            "PUT",
            f"/api/internal/workflows/executions/{quote(execution_id, safe='')}"
            f"/script-calls/{quote(call_id, safe='')}",
            json_body=row,
        )

    def import_script_calls(self, execution_id: str, from_execution_id: str) -> dict[str, Any]:
        return self._request(
            "POST",
            f"/api/internal/workflows/executions/{quote(execution_id, safe='')}"
            "/script-calls/import",
            json_body={"fromExecutionId": from_execution_id},
        )

    # ---- budget --------------------------------------------------------
    def get_llm_usage(self, execution_id: str) -> dict[str, Any]:
        return self._request(
            "GET",
            f"/api/internal/workflows/executions/{quote(execution_id, safe='')}/llm-usage",
        )


script_journal_client = ScriptJournalClient()

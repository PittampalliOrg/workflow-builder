"""Workflow Builder HTTP adapter for the runtime-start authority port."""

from __future__ import annotations

import json
import urllib.error
import urllib.parse
import urllib.request

from src.ports.runtime_start_authority import (
    RuntimeStartAuthorityDecision,
    RuntimeStartAuthorityRequest,
)

_RETRYABLE_PENDING_CODES = {"team_pending", "runtime_unpublished"}


class WorkflowBuilderRuntimeStartAuthorityAdapter:
    def __init__(
        self,
        *,
        internal_token: str,
        workflow_builder_app_id: str,
        dapr_http_port: str,
        timeout_seconds: float = 15,
    ) -> None:
        self._internal_token = internal_token.strip()
        self._workflow_builder_app_id = workflow_builder_app_id.strip()
        self._dapr_http_port = dapr_http_port.strip()
        self._timeout_seconds = timeout_seconds

    def authorize(
        self, request: RuntimeStartAuthorityRequest
    ) -> RuntimeStartAuthorityDecision:
        if not self._internal_token:
            raise RuntimeError(
                "INTERNAL_API_TOKEN not configured on pydantic-ai-agent-py"
            )
        encoded_session_id = urllib.parse.quote(request.session_id, safe="")
        url = (
            f"http://localhost:{self._dapr_http_port}/v1.0/invoke/"
            f"{self._workflow_builder_app_id}/method/api/internal/sessions/"
            f"{encoded_session_id}/authorize-runtime-start"
        )
        req = urllib.request.Request(
            url,
            data=json.dumps(
                {
                    "runtimeAppId": request.runtime_app_id,
                    "runtimeInstanceId": request.runtime_instance_id,
                }
            ).encode("utf-8"),
            headers={
                "Content-Type": "application/json",
                "X-Internal-Token": self._internal_token,
                "X-Wfb-Session-Id": request.session_id,
                "X-Wfb-Session-Token": request.session_token,
            },
            method="POST",
        )
        try:
            with urllib.request.urlopen(req, timeout=self._timeout_seconds) as resp:
                text = resp.read().decode("utf-8", errors="replace")
        except urllib.error.HTTPError as exc:
            detail = exc.read().decode("utf-8", errors="replace")[:400]
            if exc.code not in {401, 403, 404, 409}:
                raise RuntimeError(
                    f"runtime start authorization failed (HTTP {exc.code}): {detail}"
                ) from exc
            try:
                denial = json.loads(detail)
            except (TypeError, ValueError):
                denial = {}
            code = str(denial.get("code") or "") if isinstance(denial, dict) else ""
            retryable = bool(
                isinstance(denial, dict)
                and denial.get("retryable") is True
                and code in _RETRYABLE_PENDING_CODES
            )
            reason = (
                str(denial.get("message") or detail)
                if isinstance(denial, dict)
                else detail
            ) or "session start was denied"
            return RuntimeStartAuthorityDecision(
                authorized=False,
                status=exc.code,
                code=code,
                retryable=retryable,
                reason=reason,
            )

        try:
            result = json.loads(text)
        except (TypeError, ValueError) as exc:
            raise RuntimeError(
                f"runtime start authorization returned non-JSON: {text[:200]!r}"
            ) from exc
        if not isinstance(result, dict) or result.get("authorized") is not True:
            return RuntimeStartAuthorityDecision(
                authorized=False,
                status=409,
                reason="runtime start authorization was not confirmed",
            )
        return RuntimeStartAuthorityDecision(authorized=True)

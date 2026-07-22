"""Durable activity seam for runtime-start authorization."""

from __future__ import annotations

from typing import Any

from src.composition import runtime_start_authority_port
from src.ports.runtime_start_authority import RuntimeStartAuthorityRequest

AUTHORIZE_SESSION_RUNTIME_START_ACTIVITY = "authorize_session_runtime_start"


def authorize_session_runtime_start(_ctx: Any, payload: dict[str, Any]) -> dict:
    session_id = str(payload.get("sessionId") or "").strip()
    session_token = str(payload.get("workflowMcpSessionToken") or "").strip()
    runtime_app_id = str(payload.get("runtimeAppId") or "").strip()
    runtime_instance_id = str(payload.get("runtimeInstanceId") or "").strip()
    if not session_id:
        raise ValueError("authorize_session_runtime_start requires sessionId")
    if not session_token:
        raise RuntimeError(
            "authorize_session_runtime_start requires a signed session token"
        )
    if not runtime_app_id:
        raise RuntimeError("authorize_session_runtime_start requires runtimeAppId")
    if not runtime_instance_id:
        raise RuntimeError("authorize_session_runtime_start requires runtimeInstanceId")
    return (
        runtime_start_authority_port()
        .authorize(
            RuntimeStartAuthorityRequest(
                session_id=session_id,
                session_token=session_token,
                runtime_app_id=runtime_app_id,
                runtime_instance_id=runtime_instance_id,
            )
        )
        .as_dict()
    )

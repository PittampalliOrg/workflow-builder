"""Readiness contract for the per-session Dapr workflow worker."""

from __future__ import annotations

import json
import os
import urllib.error
import urllib.request
from collections.abc import Callable
from typing import Any


def _env_bool(name: str, default: bool = True) -> bool:
    value = os.environ.get(name)
    if value is None:
        return default
    return value.strip().lower() not in {"0", "false", "no", "off"}


def _timeout_seconds() -> float:
    try:
        return max(
            0.5,
            float(os.environ.get("DAPR_AGENT_READYZ_TIMEOUT_SECONDS", "2")),
        )
    except ValueError:
        return 2.0


def _metadata_url() -> str:
    host = os.environ.get("DAPR_HOST", "127.0.0.1")
    port = os.environ.get("DAPR_HTTP_PORT", "3500")
    return f"http://{host}:{port}/v1.0/metadata"


def _api_token_headers() -> dict[str, str]:
    token = str(os.environ.get("DAPR_API_TOKEN") or "").strip()
    return {"dapr-api-token": token} if token else {}


def workflow_runtime_readiness(
    *,
    urlopen: Callable[..., Any] = urllib.request.urlopen,
) -> tuple[bool, dict[str, Any]]:
    """Return ready only after Dapr reports a connected workflow worker."""
    require_workers = _env_bool("DAPR_AGENT_READYZ_REQUIRE_WORKFLOW_WORKERS")
    details: dict[str, Any] = {
        "daprHttpUrl": _metadata_url().removesuffix("/v1.0/metadata"),
        "requireWorkflowWorkers": require_workers,
    }
    if not require_workers:
        return True, details

    request = urllib.request.Request(
        _metadata_url(),
        headers=_api_token_headers(),
        method="GET",
    )
    try:
        with urlopen(request, timeout=_timeout_seconds()) as response:
            raw = response.read()
    except urllib.error.HTTPError as exc:
        details["metadataError"] = f"HTTP {exc.code}"
        return False, details
    except Exception as exc:  # noqa: BLE001
        details["metadataError"] = str(exc)
        return False, details

    try:
        payload = json.loads(raw.decode("utf-8")) if raw else {}
    except Exception as exc:  # noqa: BLE001
        details["metadataError"] = f"invalid metadata JSON: {exc}"
        return False, details
    if not isinstance(payload, dict):
        details["metadataError"] = "metadata response was not an object"
        return False, details

    workflows = payload.get("workflows")
    workflows = workflows if isinstance(workflows, dict) else {}
    try:
        connected_workers = int(workflows.get("connectedWorkers") or 0)
    except (TypeError, ValueError):
        connected_workers = 0
    details.update(
        {
            "appId": payload.get("id"),
            "runtimeVersion": payload.get("runtimeVersion"),
            "workflowConnectedWorkers": connected_workers,
        }
    )
    if connected_workers < 1:
        details["error"] = "workflow runtime has no connected Dapr workflow workers"
        return False, details
    return True, details

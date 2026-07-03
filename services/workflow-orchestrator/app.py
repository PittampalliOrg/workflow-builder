"""
Workflow Orchestrator Service

A Python microservice that runs the Dapr Workflow Runtime for executing
workflow definitions from the visual workflow builder.

Architecture:
- FastAPI HTTP server for REST API endpoints
- Dapr Workflow Runtime for durable workflow execution
- Dapr service invocation to call function-router for OpenFunction execution
- Dapr state store for workflow state persistence
- Dapr pub/sub for event publishing

KEY FEATURE: Native child workflow support for Dapr agent actions via Dapr child workflows.
"""

from __future__ import annotations

import inspect
import json
import logging
import os
import random
import string
import threading
import time
import urllib.parse
import uuid
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from functools import wraps
from typing import Any
from collections.abc import Callable

import grpc
import requests
import dapr.ext.workflow._durabletask.internal.protos as pb
import dapr.ext.workflow._durabletask.internal.orchestrator_service_pb2_grpc as pb_grpc
from dapr.ext.workflow import DaprWorkflowClient
from fastapi.encoders import jsonable_encoder
from fastapi import FastAPI, HTTPException, Request
from google.protobuf import wrappers_pb2
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

from core.config import config
from core.resume_event_resolver import (
    ResumeEventResolutionError,
    resolve_resume_event,
)
from workflows.sw_workflow import sw_workflow
from workflows.sw_workflow import wfr
from activities.metadata import get_activity_metadata
from activities.workflow_data_client import workflow_data_api_mode, workflow_data_client
from content_tracing import io_attributes

REQUESTS_TIMEOUT = getattr(requests, "Timeout", TimeoutError)

# OpenTelemetry
from tracing import (
    setup_tracing,
    inject_current_context,
    attach_workflow_session,
    extract_session_id,
    workflow_session_id,
    set_current_span_attrs,
    start_activity_span,
)

# Configuration from centralized config module
PORT = config.PORT
HOST = config.HOST
LOG_LEVEL = config.LOG_LEVEL

# Configure logging
logging.basicConfig(
    level=getattr(logging, LOG_LEVEL.upper(), logging.INFO),
    format="%(asctime)s - %(name)s - %(levelname)s - %(message)s"
)
logger = logging.getLogger(__name__)

_workflow_runtime_watchdog_started = False


def _env_float(name: str, default: float) -> float:
    raw = os.environ.get(name, "").strip()
    if not raw:
        return default
    try:
        return float(raw)
    except ValueError:
        logger.warning("Invalid %s=%r; using %s", name, raw, default)
        return default


def _env_bool(name: str, default: bool) -> bool:
    raw = os.environ.get(name, "").strip().lower()
    if not raw:
        return default
    if raw in {"1", "true", "yes", "on"}:
        return True
    if raw in {"0", "false", "no", "off"}:
        return False
    logger.warning("Invalid %s=%r; using %s", name, raw, default)
    return default


def _delete_current_pod(reason: str) -> bool:
    """Ask Kubernetes to replace this pod so the Dapr sidecar restarts too."""

    host = os.environ.get("KUBERNETES_SERVICE_HOST", "").strip()
    port = os.environ.get("KUBERNETES_SERVICE_PORT", "443").strip() or "443"
    pod_name = os.environ.get("HOSTNAME", "").strip()
    namespace_path = "/var/run/secrets/kubernetes.io/serviceaccount/namespace"
    token_path = "/var/run/secrets/kubernetes.io/serviceaccount/token"
    ca_path = "/var/run/secrets/kubernetes.io/serviceaccount/ca.crt"

    if not host or not pod_name:
        return False

    try:
        with open(namespace_path, encoding="utf-8") as namespace_file:
            namespace = namespace_file.read().strip()
        with open(token_path, encoding="utf-8") as token_file:
            token = token_file.read().strip()
    except OSError as exc:
        logger.warning(
            "[Workflow Runtime Watchdog] could not read service account token: %s",
            exc,
        )
        return False

    if not namespace or not token:
        return False

    grace_seconds = max(
        0,
        int(_env_float("WORKFLOW_RUNTIME_POD_DELETE_GRACE_SECONDS", 0.0)),
    )
    url = (
        f"https://{host}:{port}/api/v1/namespaces/"
        f"{urllib.parse.quote(namespace, safe='')}/pods/"
        f"{urllib.parse.quote(pod_name, safe='')}"
    )
    try:
        response = requests.delete(
            url,
            headers={"Authorization": f"Bearer {token}"},
            json={
                "apiVersion": "v1",
                "kind": "DeleteOptions",
                "gracePeriodSeconds": grace_seconds,
            },
            timeout=5,
            verify=ca_path if os.path.exists(ca_path) else True,
        )
    except Exception as exc:
        logger.warning(
            "[Workflow Runtime Watchdog] pod self-delete request failed: %s",
            exc,
        )
        return False

    if response.status_code in {200, 202, 404}:
        logger.error(
            "[Workflow Runtime Watchdog] requested pod replacement for %s/%s "
            "after %s",
            namespace,
            pod_name,
            reason,
        )
        return True

    logger.warning(
        "[Workflow Runtime Watchdog] pod self-delete denied: status=%s body=%s",
        response.status_code,
        response.text[:500],
    )
    return False


def _start_workflow_runtime_watchdog() -> None:
    """Restart the pod when the Dapr workflow worker disconnects permanently."""

    global _workflow_runtime_watchdog_started
    if _workflow_runtime_watchdog_started:
        return
    if not _env_bool("WORKFLOW_RUNTIME_WATCHDOG_ENABLED", True):
        logger.info("[Workflow Runtime Watchdog] disabled")
        return

    restart_after_seconds = _env_float(
        "WORKFLOW_RUNTIME_ZERO_WORKER_RESTART_SECONDS",
        90.0,
    )
    if restart_after_seconds <= 0:
        logger.info("[Workflow Runtime Watchdog] restart threshold disabled")
        return

    interval_seconds = max(
        1.0,
        _env_float("WORKFLOW_RUNTIME_WATCHDOG_INTERVAL_SECONDS", 10.0),
    )
    startup_grace_seconds = max(
        0.0,
        _env_float("WORKFLOW_RUNTIME_WATCHDOG_STARTUP_GRACE_SECONDS", 60.0),
    )
    _workflow_runtime_watchdog_started = True

    def run_watchdog() -> None:
        started_at = time.monotonic()
        zero_worker_since: float | None = None
        while True:
            time.sleep(interval_seconds)
            now = time.monotonic()
            if now - started_at < startup_grace_seconds:
                continue

            try:
                _ready, status = _get_workflow_runtime_status(
                    timeout_seconds=1.0,
                    include_taskhub=False,
                    require_metadata=True,
                    require_workflow_workers=True,
                )
            except Exception as exc:
                logger.warning(
                    "[Workflow Runtime Watchdog] readiness probe failed: %s",
                    exc,
                )
                continue

            raw_workers = status.get("workflowConnectedWorkers")
            try:
                connected_workers = int(raw_workers) if raw_workers is not None else 0
            except (TypeError, ValueError):
                connected_workers = 0

            if connected_workers >= 1:
                if zero_worker_since is not None:
                    logger.info(
                        "[Workflow Runtime Watchdog] Dapr workflow worker reconnected"
                    )
                zero_worker_since = None
                continue

            if zero_worker_since is None:
                zero_worker_since = now
                logger.warning(
                    "[Workflow Runtime Watchdog] no connected Dapr workflow workers; "
                    "will restart after %.1fs if unchanged",
                    restart_after_seconds,
                )
                continue

            disconnected_for = now - zero_worker_since
            if disconnected_for >= restart_after_seconds:
                logger.error(
                    "[Workflow Runtime Watchdog] no connected Dapr workflow workers "
                    "for %.1fs; replacing pod to restart Dapr sidecar. status=%s",
                    disconnected_for,
                    status,
                )
                if _delete_current_pod(
                    f"workflow runtime had no connected workers for "
                    f"{disconnected_for:.1f}s"
                ):
                    time.sleep(30)
                os._exit(1)

    threading.Thread(
        target=run_watchdog,
        name="workflow-runtime-watchdog",
        daemon=True,
    ).start()
    logger.info(
        "[Workflow Runtime Watchdog] started interval=%.1fs startup_grace=%.1fs "
        "restart_after=%.1fs",
        interval_seconds,
        startup_grace_seconds,
        restart_after_seconds,
    )


def _otel_context_from_headers(request: Request) -> dict[str, str]:
    carrier: dict[str, str] = {}
    traceparent = request.headers.get("traceparent")
    tracestate = request.headers.get("tracestate")
    baggage = request.headers.get("baggage")
    workflow_session_id_header = request.headers.get("x-workflow-session-id")
    if traceparent:
        carrier["traceparent"] = traceparent
    if tracestate:
        carrier["tracestate"] = tracestate
    if baggage:
        carrier["baggage"] = baggage
    if workflow_session_id_header:
        carrier["x-workflow-session-id"] = workflow_session_id_header
    return carrier


def _current_trace_context() -> dict[str, str]:
    try:
        from opentelemetry import trace as ot_trace

        span = ot_trace.get_current_span()
        if span is None:
            return {}
        span_context = span.get_span_context()
        if span_context is None or not getattr(span_context, "is_valid", False):
            return {}
        return {
            "traceparent": (
                f"00-{span_context.trace_id:032x}-{span_context.span_id:016x}-01"
            ),
            "traceId": f"{span_context.trace_id:032x}",
        }
    except Exception:
        return {}


def _current_otel_span() -> Any | None:
    try:
        from opentelemetry import trace as ot_trace

        return ot_trace.get_current_span()
    except Exception:
        return None


def _set_span_attrs(span: Any | None, attributes: dict[str, Any] | None) -> None:
    if span is None or not attributes:
        return
    try:
        span_context = span.get_span_context()
        if span_context is None or not getattr(span_context, "is_valid", False):
            return
    except Exception:
        return
    for key, value in attributes.items():
        if value is None:
            continue
        if isinstance(value, str) and not value:
            continue
        if isinstance(value, (list, tuple)) and not value:
            continue
        try:
            span.set_attribute(str(key), value)
        except Exception:
            pass


def _generate_trace_context() -> dict[str, str]:
    trace_id = uuid.uuid4().hex
    span_id = uuid.uuid4().hex[:16]
    return {
        "traceparent": f"00-{trace_id}-{span_id}-01",
        "traceId": trace_id,
    }


def _parse_baggage(value: object) -> dict[str, str]:
    if not isinstance(value, str):
        return {}
    out: dict[str, str] = {}
    for part in value.split(","):
        if "=" not in part:
            continue
        key, raw_value = part.split("=", 1)
        key = key.strip()
        if not key:
            continue
        out[key] = raw_value.strip()
    return out


def _merge_otel_context(
    request: Request | None = None,
    *,
    isolate_trace: bool = False,
) -> dict[str, str]:
    inherited = inject_current_context()
    if not inherited.get("traceparent"):
        inherited.update(_current_trace_context())
    if request is not None:
        inherited.update(_otel_context_from_headers(request))

    if isolate_trace:
        merged = _generate_trace_context()
        parent_trace_id = _trace_id_from_traceparent(inherited.get("traceparent"))
        if parent_trace_id:
            merged["parentTraceId"] = parent_trace_id
        for key in ("baggage", "x-workflow-session-id"):
            if inherited.get(key):
                merged[key] = inherited[key]
    else:
        merged = inherited
        if not merged.get("traceparent"):
            merged.update(_generate_trace_context())

    if not merged.get("traceId"):
        trace_id = _trace_id_from_traceparent(merged.get("traceparent"))
        if trace_id:
            merged["traceId"] = trace_id
    session_id = extract_session_id(merged)
    if session_id:
        merged["sessionId"] = session_id
        merged["session.id"] = session_id
    baggage = _parse_baggage(merged.get("baggage"))
    for key in (
        "workflow.execution.id",
        "workflow.id",
        "dapr.workflow.instance_id",
        "workflow_builder.trace_group_id",
    ):
        value = baggage.get(key)
        if value:
            merged[key] = value
    if "workflow.execution.id" not in merged and session_id:
        merged["workflow.execution.id"] = session_id
    if "workflow_builder.trace_group_id" not in merged and merged.get("workflow.execution.id"):
        merged["workflow_builder.trace_group_id"] = merged["workflow.execution.id"]
    return merged


def _trace_id_from_traceparent(traceparent: object) -> str | None:
    if not isinstance(traceparent, str):
        return None
    parts = traceparent.strip().split("-")
    if len(parts) != 4:
        return None
    trace_id = parts[1].strip().lower()
    if len(trace_id) != 32:
        return None
    try:
        int(trace_id, 16)
    except ValueError:
        return None
    return trace_id


def _is_native_agent_child_workflow_id(workflow_id: object) -> bool:
    if not isinstance(workflow_id, str):
        return False
    return "__msagent__" in workflow_id or "__dapr__" in workflow_id


# --- Runtime capability checks ---

def _parse_semver(version: str | None) -> tuple[int, int, int]:
    text = str(version or "").strip().lstrip("v")
    parts = text.split(".", 2)
    major = int(parts[0]) if len(parts) > 0 and parts[0].isdigit() else 0
    minor = int(parts[1]) if len(parts) > 1 and parts[1].isdigit() else 0
    patch_part = parts[2] if len(parts) > 2 else "0"
    patch_digits = ""
    for ch in patch_part:
        if ch.isdigit():
            patch_digits += ch
        else:
            break
    patch = int(patch_digits or "0")
    return (major, minor, patch)


def _is_truthy(value: str | None) -> bool:
    return str(value or "").strip().lower() in {"1", "true", "yes", "on"}


def _check_min_dapr_runtime_version() -> None:
    """
    Verify sidecar runtime version for workflow features introduced in Dapr 1.17.
    """
    min_version = config.MIN_DAPR_RUNTIME_VERSION
    enforce = _is_truthy(config.ENFORCE_MIN_DAPR_VERSION)
    metadata_url = f"http://{config.DAPR_HOST}:{config.DAPR_HTTP_PORT}/v1.0/metadata"
    try:
        response = requests.get(metadata_url, timeout=5)
        response.raise_for_status()
        payload = response.json() if response.content else {}
        runtime_version = str(payload.get("runtimeVersion") or "")
        if _parse_semver(runtime_version) < _parse_semver(min_version):
            message = (
                "[Workflow Orchestrator] Dapr runtime version "
                f"{runtime_version or '<unknown>'} is below minimum required {min_version}."
            )
            if enforce:
                raise RuntimeError(message)
            logger.warning(message)
        else:
            logger.info(
                "[Workflow Orchestrator] Dapr runtime version %s satisfies minimum %s",
                runtime_version,
                min_version,
            )
    except Exception as e:
        message = (
            "[Workflow Orchestrator] Failed to verify Dapr runtime version "
            f"(minimum {min_version}): {e}"
        )
        if enforce:
            raise RuntimeError(message) from e
        logger.warning(message)


_WORKFLOW_RUNTIME_PROBE_INSTANCE_ID = "__workflow_runtime_probe__"
_TRANSIENT_WORKFLOW_RUNTIME_ERROR_MARKERS = (
    "the state store is not configured to use the actor runtime",
    "socket closed",
    "failed to connect to all addresses",
    "connection refused",
    "workflow engine",
    "statuscode.unavailable",
    "deadline exceeded",
)
WORKFLOW_ACTOR_TYPE = "dapr.internal.workflow-builder.workflow-orchestrator.workflow"


def _dapr_http_sidecar_url() -> str:
    endpoint = os.environ.get("DAPR_HTTP_ENDPOINT", "").strip()
    if endpoint:
        return endpoint.rstrip("/")
    return f"http://{config.DAPR_HOST}:{config.DAPR_HTTP_PORT}"


def _workflow_http_timeout_seconds() -> float:
    try:
        return max(
            0.5,
            float(os.environ.get("DAPR_WORKFLOW_HTTP_TIMEOUT_SECONDS", "15")),
        )
    except ValueError:
        return 15.0


def _workflow_terminate_client_fallback_timeout_seconds() -> int:
    try:
        raw_timeout = os.environ.get(
            "WORKFLOW_TERMINATE_CLIENT_FALLBACK_TIMEOUT_SECONDS",
            "5",
        )
        return max(
            1,
            int(raw_timeout),
        )
    except ValueError:
        return 5


def _workflow_http_url(instance_id: str, suffix: str = "") -> str:
    encoded_id = urllib.parse.quote(instance_id, safe="")
    return f"{_dapr_http_sidecar_url()}/v1.0/workflows/dapr/{encoded_id}{suffix}"


def _actor_reminder_http_url(
    actor_type: str,
    actor_id: str,
    reminder_name: str,
) -> str:
    encoded_type = urllib.parse.quote(actor_type, safe="")
    encoded_id = urllib.parse.quote(actor_id, safe="")
    encoded_name = urllib.parse.quote(reminder_name, safe="")
    return (
        f"{_dapr_http_sidecar_url()}/v1.0/actors/"
        f"{encoded_type}/{encoded_id}/reminders/{encoded_name}"
    )


def _workflow_http_error_is_missing(status_code: int, detail: str) -> bool:
    if status_code == 404:
        return True
    lowered = detail.lower()
    return (
        "no such instance" in lowered
        or "not found" in lowered
        or "does not exist" in lowered
        or "no workflow" in lowered
    )


def _dapr_api_token_headers() -> dict[str, str]:
    token = str(getattr(config, "DAPR_API_TOKEN", "") or "").strip()
    if not token:
        token = str(os.environ.get("DAPR_API_TOKEN") or "").strip()
    return {"dapr-api-token": token} if token else {}


def _workflow_http_get_instance(instance_id: str) -> dict[str, Any] | None:
    response = requests.get(
        _workflow_http_url(instance_id),
        headers=_dapr_api_token_headers(),
        timeout=_workflow_http_timeout_seconds(),
    )
    if response.status_code == 404:
        return None
    if not response.ok:
        detail = response.text or ""
        if _workflow_http_error_is_missing(response.status_code, detail):
            return None
        raise RuntimeError(
            "Dapr workflow status failed with HTTP "
            f"{response.status_code}: {detail[:500]}"
        )
    if not response.content:
        return {}
    payload = response.json()
    return payload if isinstance(payload, dict) else {}


def _workflow_http_post(
    instance_id: str,
    suffix: str,
    params: dict[str, str] | None = None,
) -> None:
    response = requests.post(
        _workflow_http_url(instance_id, suffix),
        headers=_dapr_api_token_headers(),
        timeout=_workflow_http_timeout_seconds(),
        params=params or None,
    )
    if response.ok:
        return
    detail = response.text or ""
    if _workflow_http_error_is_missing(response.status_code, detail):
        raise FileNotFoundError(detail or f"Workflow {instance_id} not found")
    raise RuntimeError(
        "Dapr workflow "
        f"{suffix.strip('/')} failed with HTTP {response.status_code}: {detail[:500]}"
    )


def _is_workflow_terminate_status_unknown_error(error: Exception) -> bool:
    message = str(error).lower()
    return (
        "dapr workflow terminate failed with http 500" in message
        or "dapr workflow terminate failed with http 503" in message
        or "dapr workflow terminate failed with http 504" in message
    )


def _workflow_dict_value(payload: dict[str, Any], *keys: str) -> Any:
    for key in keys:
        if key in payload:
            return payload.get(key)
    return None


def _get_workflow_runtime_status(
    timeout_seconds: float = 2.0,
    *,
    include_taskhub: bool = True,
    require_metadata: bool = False,
    require_workflow_workers: bool = False,
) -> tuple[bool, dict[str, Any]]:
    """
    Probe the local Dapr sidecar and workflow task hub before serving traffic.
    """
    details: dict[str, Any] = {
        "daprHost": config.DAPR_HOST,
        "daprHttpPort": config.DAPR_HTTP_PORT,
        "daprGrpcPort": config.DAPR_GRPC_PORT,
    }
    errors: list[str] = []
    warnings: list[str] = []

    try:
        health_response = requests.get(
            f"http://{config.DAPR_HOST}:{config.DAPR_HTTP_PORT}/v1.0/healthz/outbound",
            timeout=timeout_seconds,
        )
        details["sidecarOutboundStatusCode"] = health_response.status_code
        details["sidecarOutboundHealthy"] = health_response.ok
        if not health_response.ok:
            errors.append(
                f"sidecar outbound health returned {health_response.status_code}"
            )
    except Exception as exc:
        details["sidecarOutboundHealthy"] = False
        details["sidecarOutboundError"] = str(exc)
        errors.append(f"sidecar outbound health check failed: {exc}")

    try:
        metadata_response = requests.get(
            f"http://{config.DAPR_HOST}:{config.DAPR_HTTP_PORT}/v1.0/metadata",
            timeout=timeout_seconds,
        )
        metadata_response.raise_for_status()
        metadata_payload = metadata_response.json() if metadata_response.content else {}
        details["runtimeVersion"] = metadata_payload.get("runtimeVersion")
        details["appId"] = metadata_payload.get("id")
        workflows_metadata = metadata_payload.get("workflows") or {}
        connected_workers = 0
        if isinstance(workflows_metadata, dict):
            raw_workers = workflows_metadata.get("connectedWorkers")
            try:
                connected_workers = (
                    int(raw_workers) if raw_workers is not None else 0
                )
            except (TypeError, ValueError):
                connected_workers = 0
        details["workflowConnectedWorkers"] = connected_workers
        if require_workflow_workers and connected_workers < 1:
            errors.append("workflow runtime has no connected Dapr workflow workers")
        elif connected_workers < 1:
            warnings.append(
                "workflow metadata did not report connected Dapr workflow workers"
            )
    except Exception as exc:
        details["metadataError"] = str(exc)
        if require_metadata:
            errors.append(f"metadata probe failed: {exc}")
        else:
            warnings.append(f"metadata probe failed: {exc}")

    if include_taskhub:
        try:
            response = _taskhub_call(
                "GetInstance",
                pb.GetInstanceRequest(
                    instanceId=_WORKFLOW_RUNTIME_PROBE_INSTANCE_ID,
                    getInputsAndOutputs=False,
                ),
            )
            details["taskhubReady"] = True
            details["taskhubProbeExists"] = bool(getattr(response, "exists", False))
        except Exception as exc:
            details["taskhubReady"] = False
            details["taskhubError"] = str(exc)
            errors.append(f"taskhub probe failed: {exc}")

    details["errors"] = errors
    details["warnings"] = warnings
    return (len(errors) == 0, details)


def _raise_workflow_route_error(operation: str, error: Exception) -> None:
    """
    Prefer a clear 503 when Dapr workflow runtime is the actual failing dependency.
    """
    error_message = str(error)
    lowered = error_message.lower()
    runtime_ready, runtime_status = _get_workflow_runtime_status(timeout_seconds=1.0)

    if (not runtime_ready) or any(
        marker in lowered for marker in _TRANSIENT_WORKFLOW_RUNTIME_ERROR_MARKERS
    ):
        detail = {
            "code": "workflow_runtime_unavailable",
            "error": "Dapr workflow runtime is not ready",
            "operation": operation,
            "runtimeStatus": runtime_status,
            "rawError": error_message,
        }
        logger.warning(
            "[Workflow Routes] %s failed while workflow runtime unavailable: %s",
            operation,
            detail,
        )
        raise HTTPException(status_code=503, detail=detail)

    raise HTTPException(status_code=500, detail=error_message)


# --- TaskHub gRPC helpers (workflow management APIs) ---

_taskhub_channel: grpc.Channel | None = None
_taskhub_stub: pb_grpc.TaskHubSidecarServiceStub | None = None
SW_WORKFLOW_NAME = "sw_workflow_v1"


def _taskhub_metadata() -> list[tuple[str, str]] | None:
    token = str(getattr(config, "DAPR_API_TOKEN", "") or "").strip()
    if token:
        return [("dapr-api-token", token)]
    env_token = str(os.environ.get("DAPR_API_TOKEN") or "").strip()
    if env_token:
        return [("dapr-api-token", env_token)]
    return None


def _get_taskhub_stub() -> pb_grpc.TaskHubSidecarServiceStub:
    global _taskhub_channel, _taskhub_stub
    if _taskhub_stub is not None:
        return _taskhub_stub
    target = f"{config.DAPR_HOST}:{config.DAPR_GRPC_PORT}"
    try:
        max_message_bytes = max(
            1,
            int(
                os.environ.get(
                    "DAPR_WORKFLOW_GRPC_MAX_MESSAGE_BYTES",
                    str(16 * 1024 * 1024),
                )
            ),
        )
    except ValueError:
        max_message_bytes = 16 * 1024 * 1024
    _taskhub_channel = grpc.insecure_channel(
        target,
        options=[
            ("grpc.max_receive_message_length", max_message_bytes),
            ("grpc.max_send_message_length", max_message_bytes),
        ],
    )
    _taskhub_stub = pb_grpc.TaskHubSidecarServiceStub(_taskhub_channel)
    return _taskhub_stub


def _taskhub_call(method: str, request: Any) -> Any:
    stub = _get_taskhub_stub()
    rpc = getattr(stub, method)
    metadata = _taskhub_metadata()
    timeout_seconds = max(float(config.TASKHUB_RPC_TIMEOUT_SECONDS), 0.1)
    if metadata:
        return rpc(request, metadata=metadata, timeout=timeout_seconds)
    return rpc(request, timeout=timeout_seconds)


def _list_instance_ids(
    *,
    continuation_token: str | None = None,
    page_size: int = 200,
) -> tuple[list[str], str | None]:
    """List workflow IDs using Dapr's Task Hub management protocol."""
    request = pb.ListInstanceIDsRequest(pageSize=page_size)
    if continuation_token:
        request.continuationToken = continuation_token
    response = _taskhub_call("ListInstanceIDs", request)
    next_token = str(getattr(response, "continuationToken", "") or "") or None
    return list(getattr(response, "instanceIds", []) or []), next_token


def _schedule_new_workflow_instance(
    workflow_name: str,
    instance_id: str,
    workflow_input: dict[str, Any],
    *,
    workflow_version: str | None = None,
    parent_trace_context: dict[str, str] | None = None,
) -> str:
    request = pb.CreateInstanceRequest(
        instanceId=instance_id,
        name=workflow_name,
        input=wrappers_pb2.StringValue(value=json.dumps(workflow_input)),
    )
    # Propagate W3C trace context into the Dapr workflow span tree.
    # The sidecar uses parentTraceContext to connect workflow/activity spans
    # under the caller's trace (Dapr 1.17+ / durabletask-go TraceContext proto).
    if parent_trace_context and parent_trace_context.get("traceparent"):
        trace_ctx = pb.TraceContext(
            traceParent=parent_trace_context["traceparent"],
        )
        trace_state = parent_trace_context.get("tracestate", "")
        if trace_state:
            trace_ctx.traceState.CopyFrom(wrappers_pb2.StringValue(value=trace_state))
        request.parentTraceContext.CopyFrom(trace_ctx)
    if workflow_version:
        request.version.CopyFrom(wrappers_pb2.StringValue(value=workflow_version))
    # Dapr 1.18 REMOVED orchestrationIdReusePolicy from CreateInstanceRequest (the
    # `dapr.ext.workflow._durabletask` vendored proto reserves field 6; there is no
    # IGNORE policy any more). Idempotent dedup is now handled entirely by
    # _idempotent_schedule's get_workflow_state precheck + state-based
    # purge-before-reuse — StartInstance over an active instance returns the
    # existing instance (verified against live daprd 1.18). (wfb Dapr-1.18 Stage 2.)
    response = _taskhub_call("StartInstance", request)
    result_id = str(getattr(response, "instanceId", "") or "").strip()
    if not result_id:
        raise RuntimeError("workflow runtime returned an empty instance ID")
    return result_id


def _normalize_workflow_runtime_status(value: Any) -> str:
    text = str(value or "").strip().upper()
    if "." in text:
        text = text.rsplit(".", 1)[-1]
    for prefix in ("ORCHESTRATION_STATUS_", "WORKFLOW_RUNTIME_STATUS_"):
        if text.startswith(prefix):
            return text[len(prefix):]
    return text


def _idempotent_schedule(
    workflow_name: str,
    instance_id: str,
    workflow_input: dict[str, Any],
    *,
    workflow_version: str | None = None,
    parent_trace_context: dict[str, str] | None = None,
) -> str:
    """Schedule a workflow instance idempotently.

    Dapr 1.18 removed ``OrchestrationIdReusePolicy``/``IGNORE`` from the SDK, so
    dedup is done explicitly here: a ``get_workflow_state`` precheck returns the
    existing ID for a live RUNNING/PENDING/SUSPENDED instance, purges + reschedules
    on the DB-terminal-but-Dapr-non-terminal zombie divergence, and purges a
    terminal instance before scheduling fresh. A residual schedule-failure path
    re-fetches state and resolves the same way (by state, not exception type).
    """
    client = get_workflow_client()
    try:
        existing = client.get_workflow_state(instance_id=instance_id, fetch_payloads=False)
    except Exception:
        existing = None

    if existing is not None:
        status_name = _normalize_workflow_runtime_status(
            getattr(existing, "runtime_status", "")
        )
        if status_name in {"RUNNING", "PENDING", "SUSPENDED"}:
            # Zombie-reuse guard: only purge-before-reuse on the DB-terminal-but-
            # Dapr-non-terminal divergence. A legitimately live run (DB also
            # non-terminal) is returned untouched.
            db_status = _db_execution_status_for_instance(instance_id)
            if db_status in {"completed", "failed", "error", "cancelled", "terminated"}:
                logger.warning(
                    "[Idempotent Schedule] Divergence for %s: Dapr=%s but DB=%s; "
                    "terminating+purging zombie before reuse",
                    instance_id,
                    status_name,
                    db_status,
                )
                _terminate_and_purge_for_reuse(client, instance_id)
                # fall through to schedule a fresh instance below
            else:
                logger.info(
                    "[Idempotent Schedule] Instance %s exists (status=%s), returning existing",
                    instance_id,
                    status_name,
                )
                return instance_id
        if status_name in {"COMPLETED", "FAILED", "TERMINATED"}:
            try:
                client.purge_workflow(instance_id=instance_id)
                logger.info(
                    "[Idempotent Schedule] Purged terminal instance %s (status=%s)",
                    instance_id,
                    status_name,
                )
            except Exception as purge_err:
                logger.warning("[Idempotent Schedule] Purge failed: %s", purge_err)

    try:
        return _schedule_new_workflow_instance(
            workflow_name=workflow_name,
            instance_id=instance_id,
            workflow_input=workflow_input,
            workflow_version=workflow_version,
            parent_trace_context=parent_trace_context,
        )
    except Exception as schedule_err:
        # Schedule raised (e.g. an un-purged terminal instance, or the empty-ID
        # RuntimeError) -- re-fetch state and resolve by state (NOT by exception
        # type: the broad except must also catch the empty-instance-ID error).
        # Try purging and retrying.
        try:
            existing = client.get_workflow_state(
                instance_id=instance_id, fetch_payloads=False
            )
        except Exception:
            existing = None

        if existing is None:
            raise schedule_err

        status_name = _normalize_workflow_runtime_status(
            getattr(existing, "runtime_status", "")
        )
        logger.info(
            "[Idempotent Schedule] Instance %s exists (status=%s)",
            instance_id,
            status_name,
        )

        if status_name in ("COMPLETED", "FAILED", "TERMINATED"):
            try:
                client.purge_workflow(instance_id=instance_id)
                logger.info("[Idempotent Schedule] Purged terminal instance %s", instance_id)
            except Exception as purge_err:
                logger.warning("[Idempotent Schedule] Purge failed: %s", purge_err)
            return _schedule_new_workflow_instance(
                workflow_name=workflow_name,
                instance_id=instance_id,
                workflow_input=workflow_input,
                workflow_version=workflow_version,
                parent_trace_context=parent_trace_context,
            )

        # Instance is RUNNING/PENDING/SUSPENDED — return existing
        return instance_id


def _clone_json_value(value: Any) -> Any:
    return json.loads(json.dumps(value))


def _build_definition_from_workflow_record(workflow_row: dict[str, Any]) -> dict[str, Any]:
    raw_nodes = workflow_row["nodes"]
    raw_edges = workflow_row["edges"]
    lowered_nodes, lowered_edges = _lower_while_nodes(raw_nodes, raw_edges)

    exec_nodes = [
        n
        for n in lowered_nodes
        if n.get("type") != "add" and n.get("data", {}).get("type") != "add"
    ]
    serialized_nodes = [_serialize_node(n) for n in exec_nodes]
    node_ids = {n["id"] for n in exec_nodes}
    serialized_edges = [
        {
            "id": e["id"],
            "source": e["source"],
            "target": e["target"],
            "sourceHandle": e.get("sourceHandle"),
            "targetHandle": e.get("targetHandle"),
        }
        for e in lowered_edges
        if e["source"] in node_ids and e["target"] in node_ids
    ]
    execution_order = _topological_sort(
        [{"id": n["id"], "type": n["type"]} for n in serialized_nodes],
        serialized_edges,
    )
    now = datetime.now(timezone.utc).isoformat()
    return {
        "id": workflow_row["id"],
        "name": workflow_row["name"],
        "version": "1.0.0",
        "nodes": serialized_nodes,
        "edges": serialized_edges,
        "executionOrder": execution_order,
        "createdAt": now,
        "updatedAt": now,
    }


def _extract_published_runtime(spec: Any) -> dict[str, Any] | None:
    if not isinstance(spec, dict):
        return None
    metadata = spec.get("metadata")
    if not isinstance(metadata, dict):
        return None
    published_runtime = metadata.get("publishedRuntime")
    if not isinstance(published_runtime, dict):
        return None
    if str(published_runtime.get("status") or "").strip().lower() != "published":
        return None
    return published_runtime


def _extract_published_revisions(
    workflow_row: dict[str, Any],
) -> tuple[str | None, str | None, list[dict[str, Any]]]:
    published_runtime = _extract_published_runtime(workflow_row.get("spec"))
    workflow_name = str(
        workflow_row.get("daprWorkflowName")
        or (published_runtime or {}).get("workflowName")
        or ""
    ).strip() or None
    latest_version = str(
        (published_runtime or {}).get("latestVersion") or ""
    ).strip() or None
    revisions_raw = (
        published_runtime.get("revisions")
        if isinstance(published_runtime, dict)
        else None
    )
    revisions: list[dict[str, Any]] = []
    if isinstance(revisions_raw, list):
        for revision in revisions_raw:
            if not isinstance(revision, dict):
                continue
            version = str(revision.get("version") or "").strip()
            definition = revision.get("definition")
            if not version or not isinstance(definition, dict):
                continue
            revisions.append(
                {
                    "version": version,
                    "publishedAt": str(revision.get("publishedAt") or "").strip() or None,
                    "definition": _clone_json_value(definition),
                    "specVersion": str(revision.get("specVersion") or "").strip() or None,
                }
            )
    if workflow_name and latest_version and not revisions:
        revisions.append(
            {
                "version": latest_version,
                "publishedAt": None,
                "definition": _build_definition_from_workflow_record(workflow_row),
                "specVersion": (
                    str(workflow_row.get("specVersion") or "").strip() or None
                ),
            }
        )
    return workflow_name, latest_version, revisions


# --- Lifecycle ---

@asynccontextmanager
async def lifespan(app: FastAPI):
    """
    Manage Dapr Workflow Runtime lifecycle.

    Registers workflows and activities, then starts/stops the runtime.
    """
    logger.info("=== Workflow Orchestrator Service (Python) ===")
    logger.info(f"Log Level: {LOG_LEVEL}")

    _check_min_dapr_runtime_version()
    _assert_execution_read_model_columns()

    # Capability-honesty boot guard: fail fast if any runtime descriptor in the
    # registry violates the structural capability invariants (roadmap item 6).
    from core.conformance import assert_descriptor_consistency

    _conformant_runtimes = assert_descriptor_consistency()
    logger.info(
        "[Workflow Orchestrator] Runtime capability conformance guard passed: %d runtimes",
        _conformant_runtimes,
    )

    # Register all activities from the canonical ACTIVITIES list.
    # To add a new activity, update activities/__init__.py — no changes needed here.
    from activities import ACTIVITIES
    for fn in ACTIVITIES:
        _register_activity(fn)

    logger.info("[Workflow Orchestrator] Registered all activities")

    # Register the only supported workflow interpreter: CNCF Serverless Workflow 1.0.
    wfr.register_versioned_workflow(
        sw_workflow,
        name=SW_WORKFLOW_NAME,
        version_name="1.0.0",
        is_latest=True,
    )
    logger.info(
        "[Workflow Orchestrator] Registered workflows: %s@1.0.0",
        SW_WORKFLOW_NAME,
    )

    # Start the workflow runtime
    wfr.start()
    logger.info("[Workflow Orchestrator] Dapr Workflow Runtime started")
    _start_workflow_runtime_watchdog()

    # Cleanup stale workflow instances without blocking readiness.
    _start_startup_cleanup_thread()

    yield

    # Shutdown
    global _taskhub_channel, _taskhub_stub
    if _taskhub_channel is not None:
        try:
            _taskhub_channel.close()
        except Exception:
            pass
        _taskhub_channel = None
        _taskhub_stub = None
    wfr.shutdown()
    logger.info("[Workflow Orchestrator] Dapr Workflow Runtime stopped")


# Create FastAPI app
app = FastAPI(
    title="Workflow Orchestrator",
    description="Dapr Workflow orchestrator for dynamic workflow execution with child workflow support",
    version="1.0.0",
    lifespan=lifespan,
)

# Enable CORS
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["GET", "POST", "DELETE", "OPTIONS"],
    allow_headers=["*"],
)

# Initialize OpenTelemetry before the ASGI middleware stack is built so
# FastAPI inbound spans exist for request handlers.
setup_tracing("workflow-orchestrator", app)


# --- Request / Response Models ---

class StartWorkflowResponse(BaseModel):
    """Response from starting a workflow."""
    instanceId: str
    workflowId: str
    status: str = "started"
    workflowVersion: str | None = None


class RaiseEventRequest(BaseModel):
    """Request to raise an event."""
    eventName: str
    eventData: Any = None


class TerminateRequest(BaseModel):
    """Request to terminate a workflow."""
    reason: str | None = None


class CloudEvent(BaseModel):
    """CloudEvent schema for pub/sub messages."""
    type: str
    source: str
    specversion: str = "1.0"
    data: dict[str, Any] = Field(default_factory=dict)
    id: str | None = None
    time: str | None = None
    datacontenttype: str = "application/json"


class WorkflowStatusResponse(BaseModel):
    """Workflow status response."""
    instanceId: str
    workflowId: str
    workflowName: str | None = None
    workflowVersion: str | None = None
    workflowNameVersioned: str | None = None
    runtimeStatus: str
    traceId: str | None = None
    phase: str | None = None
    progress: int = 0
    message: str | None = None
    currentNodeId: str | None = None
    currentNodeName: str | None = None
    approvalEventName: str | None = None
    outputs: dict[str, Any] | None = None
    error: str | None = None
    stackTrace: str | None = None
    parentInstanceId: str | None = None
    startedAt: str | None = None
    completedAt: str | None = None


class WorkflowListItemResponse(BaseModel):
    """Workflow list item response."""
    instanceId: str
    workflowId: str
    workflowName: str | None = None
    workflowVersion: str | None = None
    workflowNameVersioned: str | None = None
    runtimeStatus: str
    traceId: str | None = None
    phase: str | None = None
    progress: int = 0
    message: str | None = None
    currentNodeId: str | None = None
    currentNodeName: str | None = None
    error: str | None = None
    startedAt: str | None = None
    completedAt: str | None = None


class WorkflowListResponse(BaseModel):
    """Workflow list response."""
    workflows: list[WorkflowListItemResponse]
    total: int
    limit: int
    offset: int


class WorkflowHistoryEventResponse(BaseModel):
    """Workflow history event response."""
    eventId: int | None = None
    eventType: str
    timestamp: str | None = None
    name: str | None = None
    input: Any = None
    output: Any = None
    metadata: dict[str, Any] | None = None
    raw: dict[str, Any] | None = None


class WorkflowHistoryResponse(BaseModel):
    """Workflow history response."""
    instanceId: str
    events: list[WorkflowHistoryEventResponse]


class RerunWorkflowRequest(BaseModel):
    """Request to rerun a workflow from a specific history event."""
    fromEventId: int = Field(
        default=0,
        description="History event ID to rerun from. 0 means from start.",
    )
    newInstanceId: str | None = Field(
        default=None,
        description="Optional explicit Dapr instance ID for the rerun.",
    )
    input: Any = Field(
        default=None,
        description=(
            "Optional replacement input for the rerun target. Only sent to "
            "Dapr when overwriteInput is true."
        ),
    )
    overwriteInput: bool = Field(
        default=False,
        description=(
            "When true, pass input to Dapr's RerunWorkflowFromEvent request. "
            "Leave false to match Dapr CLI's default history replay behavior."
        ),
    )
    reason: str | None = None


class ResumeWorkflowRequest(BaseModel):
    """Resume a workflow run from a specific NODE (not a raw history event).

    Node-aware wrapper over Dapr's RerunWorkflowFromEvent: maps a top-level SW node
    id to the history event at which that node started (its `update_execution_node`
    TaskScheduled event), then reruns from there. Completed nodes before the resume
    point replay from the parent history as cached results (validated: durable/run
    sub-orchestrations are NOT re-dispatched); the resume node onward re-executes.
    """
    fromNodeId: str | None = Field(
        default=None,
        description=(
            "Top-level node id to resume from. None or '__failed__' auto-locates the "
            "last node that started (the node in-flight when the run stopped)."
        ),
    )
    input: Any = Field(
        default=None,
        description=(
            "Replacement workflow input (e.g. the edited spec). When provided it is "
            "sent with overwriteInput so the resume node onward runs the fix. The "
            "replayed prefix uses cached results, so earlier-node edits are ignored."
        ),
    )
    newInstanceId: str | None = None
    reason: str | None = None


class RuntimeRegistrationResponse(BaseModel):
    """Runtime introspection response for debug UIs."""
    service: str
    version: str
    runtime: str
    ready: bool
    runtimeStatus: dict[str, Any]
    features: list[str]
    registeredWorkflows: list[dict[str, Any]]
    registeredActivities: list[dict[str, Any]]
    errors: list[str] = Field(default_factory=list)
    additional: dict[str, Any] = Field(default_factory=dict)


# --- Helper Functions ---

def get_workflow_client() -> DaprWorkflowClient:
    """Get a Dapr workflow client."""
    return DaprWorkflowClient()


# Activity registry — populated by _register_activity() during startup.
_activity_registry: list[Any] = []
_activity_registry_seen: set[str] = set()


def _activity_with_content_io(fn: Any) -> Any:
    """Enrich durabletask's outer activity span with activity input/output."""

    @wraps(fn)
    def wrapped(*args: Any, **kwargs: Any):
        data = args[1] if len(args) > 1 else kwargs.get("data", kwargs.get("input_data"))
        set_current_span_attrs(io_attributes("input", data))
        try:
            result = fn(*args, **kwargs)
        except Exception as exc:
            set_current_span_attrs(
                io_attributes(
                    "output",
                    {
                        "error": str(exc),
                        "errorType": exc.__class__.__name__,
                    },
                )
            )
            raise
        set_current_span_attrs(io_attributes("output", result))
        return result

    return wrapped


def _register_activity(fn: Any) -> None:
    """Register an activity with both Dapr and the introspection registry."""
    wfr.register_activity(_activity_with_content_io(fn))
    if fn.__name__ not in _activity_registry_seen:
        _activity_registry_seen.add(fn.__name__)
        _activity_registry.append(fn)


def _registered_activity_functions() -> list[Any]:
    """Return the list of registered activity function objects."""
    return _activity_registry


def _registered_activity_names() -> list[str]:
    return [fn.__name__ for fn in _activity_registry]


def _get_activity_source(fn: Any) -> str | None:
    """Return the source code of an activity function, or None on failure."""
    try:
        return inspect.getsource(fn)
    except (OSError, TypeError):
        return None


def _get_activity_doc(fn: Any) -> str | None:
    """Return the formatted docstring of an activity function."""
    return inspect.getdoc(fn)


def _annotation_text(annotation: object) -> str:
    if annotation is inspect._empty:
        return "Any"
    if getattr(annotation, "__module__", "") == "typing":
        return str(annotation).replace("typing.", "")
    if isinstance(annotation, type):
        return annotation.__name__
    return getattr(annotation, "__name__", None) or str(annotation)


def _activity_signature(fn: Callable[..., Any]) -> dict[str, Any]:
    try:
        signature = inspect.signature(fn)
    except (TypeError, ValueError):
        return {"parameters": [], "returnType": None}

    parameters = []
    for param in signature.parameters.values():
        parameters.append({
            "name": param.name,
            "kind": str(param.kind),
            "annotation": _annotation_text(param.annotation),
            "hasDefault": param.default is not inspect._empty,
            "default": None if param.default is inspect._empty else repr(param.default),
        })

    return {
        "parameters": parameters,
        "returnType": _annotation_text(signature.return_annotation),
    }


def _activity_sw_compatibility(fn: Callable[..., Any]) -> dict[str, Any]:
    metadata = get_activity_metadata(fn)
    signature = _activity_signature(fn)
    param_count = len(signature["parameters"])
    reasons: list[str] = []
    action_name = metadata.sw_name if metadata and metadata.sw_name else fn.__name__
    call_target = f"workflow-orchestrator/{action_name}"

    if metadata and metadata.public_callable:
        status = "compatible"
        projection = {
            "functionRefName": action_name,
            "call": call_target,
            "inputShape": "object",
        }
    elif param_count == 2:
        status = "inspect-only"
        reasons.append("activity is discoverable but not explicitly marked public-callable")
        projection = {
            "functionRefName": action_name,
            "call": call_target,
            "inputShape": "object",
        }
    else:
        status = "incompatible"
        reasons.append("activity signature does not match the expected Dapr activity shape")
        projection = None

    return {
        "status": status,
        "reasons": reasons,
        "projection": projection,
    }


def _orchestrator_service_url() -> str:
    return (
        os.environ.get("WORKFLOW_ORCHESTRATOR_URL")
        or os.environ.get("ORCHESTRATOR_URL")
        or f"http://workflow-orchestrator.workflow-builder.svc.cluster.local:{config.PORT}"
    )


def _activity_io_schema(
    fn: Callable[..., Any],
    metadata: Any | None,
    *,
    kind: str,
) -> dict[str, Any]:
    schema = None
    if metadata is not None:
        if kind == "input":
            schema = getattr(metadata, "input_schema", None)
        else:
            schema = getattr(metadata, "output_schema", None)
    if isinstance(schema, dict) and schema:
        return schema
    description = inspect.getdoc(fn) or None
    return {
        "type": "object",
        "description": description,
        "properties": {},
        "additionalProperties": True,
    }


def _activity_execution_definition(fn: Callable[..., Any]) -> dict[str, Any]:
    metadata = get_activity_metadata(fn)
    action_name = metadata.sw_name if metadata and metadata.sw_name else fn.__name__
    task_call = f"workflow-orchestrator/{action_name}"
    endpoint_uri = f"{_orchestrator_service_url()}/api/metadata/actions/{action_name}/invoke"
    input_schema = _activity_io_schema(fn, metadata, kind="input")
    output_schema = _activity_io_schema(fn, metadata, kind="output")
    description = (
        metadata.description
        if metadata and metadata.description
        else (inspect.getdoc(fn) or "")
    )

    task_config = {
        "call": task_call,
        "with": {
            "body": {
                "input": {},
                "metadata": {
                    "service": "workflow-orchestrator",
                    "actionId": fn.__name__,
                    "actionName": action_name,
                    "displayName": metadata.display_name if metadata and metadata.display_name else fn.__name__,
                    "visibility": metadata.visibility if metadata else "inspect-only",
                },
            },
        },
        "input": {
            "schema": {
                "format": "json",
                "document": input_schema,
            },
        },
        "output": {
            "schema": {
                "format": "json",
                "document": output_schema,
            },
        },
    }

    sw_definition = {
        "call": task_call,
        "with": task_config["with"],
    }

    return {
        "definition": sw_definition,
        "taskConfig": task_config,
        "inputSchema": input_schema,
        "outputSchema": output_schema,
        "endpointUri": endpoint_uri,
        "description": description,
        "functionRefName": action_name,
        "displayName": metadata.display_name if metadata and metadata.display_name else fn.__name__,
        "visibility": metadata.visibility if metadata else "inspect-only",
        "insertable": bool(metadata and metadata.public_callable),
    }


def _activity_metadata_payload(fn: Callable[..., Any]) -> dict[str, Any]:
    metadata = get_activity_metadata(fn)
    signature = _activity_signature(fn)
    sw_compatibility = _activity_sw_compatibility(fn)
    execution = _activity_execution_definition(fn) if metadata and metadata.public_callable else None
    input_schema = execution["inputSchema"] if execution else _activity_io_schema(fn, metadata, kind="input")
    output_schema = execution["outputSchema"] if execution else _activity_io_schema(fn, metadata, kind="output")

    sw_payload = {
        "functionName": execution["functionRefName"] if execution else (metadata.sw_name if metadata and metadata.sw_name else fn.__name__),
        "definition": execution["definition"] if execution else None,
        "taskConfig": execution["taskConfig"] if execution else None,
        "warnings": sw_compatibility["reasons"],
    }

    if execution and sw_compatibility.get("projection"):
        sw_compatibility["projection"] = {
            **sw_compatibility["projection"],
            "endpointUri": execution["endpointUri"],
            "inputSchema": input_schema,
        }

    if metadata and metadata.public_callable and not execution:
        sw_compatibility["reasons"].append("public-callable activity is missing executable projection metadata")

    if metadata and metadata.public_callable and not metadata.input_schema:
        sw_compatibility["reasons"].append("public-callable activity uses a generic input schema")

    return {
        "id": fn.__name__,
        "name": execution["functionRefName"] if execution else (metadata.sw_name if metadata and metadata.sw_name else fn.__name__),
        "displayName": execution["displayName"] if execution else (metadata.display_name if metadata and metadata.display_name else fn.__name__),
        "description": execution["description"] if execution else (metadata.description if metadata and metadata.description else (inspect.getdoc(fn) or "")),
        "visibility": metadata.visibility if metadata else "inspect-only",
        "kind": "dapr-activity",
        "service": "workflow-orchestrator",
        "runtime": "python-dapr-workflow",
        "registered": True,
        "ready": True,
        "source": {
            "module": fn.__module__,
            "sourceCode": _get_activity_source(fn),
        },
        "signature": signature,
        "doc": _get_activity_doc(fn),
        "tags": list(metadata.tags) if metadata else [],
        "category": metadata.category if metadata else None,
        "sourceKind": "activity",
        "insertable": bool(metadata and metadata.public_callable),
        "swCompatibility": sw_compatibility,
        "inputSchema": input_schema,
        "outputSchema": output_schema,
        "definition": sw_payload["definition"],
        "taskConfig": sw_payload["taskConfig"],
        "functionRef": {
            "name": sw_payload["functionName"],
            "version": "1.0.0",
        } if metadata and metadata.public_callable else None,
        "sw": sw_payload,
    }


def _registered_workflow_descriptors() -> list[dict[str, Any]]:
    return [
        {
            "name": SW_WORKFLOW_NAME,
            "version": "1.0.0",
            "aliases": [],
            "isLatest": True,
            "source": "service-introspection",
        }
    ]


# --- Database helpers for SW workflow execution ---

_database_url: str | None = None


def _database_secret_fetch_timeout_seconds() -> float:
    return max(
        0.0,
        _env_float("DATABASE_URL_SECRET_FETCH_TIMEOUT_SECONDS", 90.0),
    )


def _database_secret_fetch_retry_interval_seconds() -> float:
    return max(
        0.1,
        _env_float("DATABASE_URL_SECRET_FETCH_RETRY_INTERVAL_SECONDS", 1.0),
    )


def _fetch_database_url_from_dapr_secret(url: str) -> str:
    response = requests.get(
        url,
        headers=_dapr_api_token_headers(),
        timeout=10,
    )
    response.raise_for_status()
    secrets = response.json() if response.content else {}
    db_url = secrets.get("DATABASE_URL") if isinstance(secrets, dict) else None
    if not db_url:
        raise RuntimeError("DATABASE_URL not found in Dapr secrets")
    return str(db_url)


def _get_database_url() -> str:
    """Resolve DATABASE_URL.

    Preview orchestrators (the dev-preview "preview set") point at their own
    `preview_<id>` database, delivered as a plain DATABASE_URL env var. So an
    explicit env wins over the Dapr kubernetes-secrets fetch (the prod path).
    """
    global _database_url
    if _database_url is not None:
        return _database_url

    env_url = os.environ.get("DATABASE_URL")
    if env_url and env_url.strip():
        _database_url = env_url.strip()
        logger.info("[Execute-By-Id] Using DATABASE_URL from environment (preview/override)")
        return _database_url

    dapr_host = config.DAPR_HOST
    dapr_port = config.DAPR_HTTP_PORT
    url = f"http://{dapr_host}:{dapr_port}/v1.0/secrets/kubernetes-secrets/workflow-builder-secrets"
    retry_deadline = time.monotonic() + _database_secret_fetch_timeout_seconds()
    retry_interval = _database_secret_fetch_retry_interval_seconds()
    attempts = 0
    last_error: Exception | None = None

    while True:
        attempts += 1
        try:
            db_url = _fetch_database_url_from_dapr_secret(url)
            _database_url = db_url
            logger.info(
                "[Execute-By-Id] Fetched DATABASE_URL from Dapr secrets after %d attempt(s)",
                attempts,
            )
            return db_url
        except Exception as e:
            last_error = e
            remaining_seconds = retry_deadline - time.monotonic()
            if remaining_seconds <= 0:
                break
            sleep_seconds = min(retry_interval, remaining_seconds)
            logger.warning(
                "[Execute-By-Id] DATABASE_URL secret fetch failed on attempt %d; "
                "retrying in %.1fs: %s",
                attempts,
                sleep_seconds,
                e,
            )
            time.sleep(sleep_seconds)

    raise RuntimeError(
        "Failed to fetch DATABASE_URL from Dapr secrets after "
        f"{attempts} attempt(s): {last_error}"
    ) from last_error


def _use_workflow_data_api() -> bool:
    return workflow_data_api_mode() != "postgres"


def _strict_workflow_data_api() -> bool:
    return workflow_data_api_mode() == "http"


def _log_workflow_data_fallback(operation: str, exc: Exception) -> None:
    logger.warning(
        "[Workflow Data] %s via workflow-data failed in %s mode; falling back to Postgres: %s",
        operation,
        workflow_data_api_mode(),
        exc,
    )


def _assert_execution_read_model_columns() -> None:
    """Fail startup unless the execution read-model cutover migration is applied."""
    if _use_workflow_data_api():
        try:
            workflow_data_client.assert_execution_read_model_ready()
            return
        except Exception as exc:
            if _strict_workflow_data_api():
                raise
            _log_workflow_data_fallback("read-model readiness check", exc)

    import psycopg2

    required_columns = {
        "current_node_id",
        "current_node_name",
        "primary_trace_id",
        "workflow_session_id",
        "summary_output",
    }

    db_url = _get_database_url()
    conn = psycopg2.connect(db_url)
    try:
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT column_name
                FROM information_schema.columns
                WHERE table_schema = 'public'
                  AND table_name = 'workflow_executions'
                  AND column_name = ANY(%s)
                """,
                (list(required_columns),),
            )
            existing = {row[0] for row in cur.fetchall()}
    finally:
        conn.close()

    missing = sorted(required_columns - existing)
    if missing:
        raise RuntimeError(
            "Execution read-model schema cutover is incomplete. "
            "Missing workflow_executions columns: "
            f"{', '.join(missing)}. Apply atlas/migrations/20260408120000_add_execution_read_model_columns.sql "
            "or drizzle/0024_execution_read_model.sql before starting workflow-orchestrator."
        )


def _fetch_workflow_from_db(workflow_id: str) -> dict[str, Any]:
    """Fetch a workflow definition from the database by ID."""
    if _use_workflow_data_api():
        try:
            workflow = workflow_data_client.get_workflow(workflow_id, by="id")
            if not workflow:
                raise HTTPException(status_code=404, detail=f"Workflow {workflow_id} not found")
            return workflow
        except HTTPException:
            raise
        except Exception as exc:
            if _strict_workflow_data_api():
                raise
            _log_workflow_data_fallback("workflow lookup", exc)

    import psycopg2

    db_url = _get_database_url()
    conn = psycopg2.connect(db_url)
    try:
        cur = conn.cursor()
        cur.execute(
            """
            SELECT id, name, description, user_id, project_id, nodes, edges, spec, spec_version, dapr_workflow_name
            FROM workflows
            WHERE id = %s
            """,
            (workflow_id,),
        )
        row = cur.fetchone()
        if not row:
            raise HTTPException(status_code=404, detail=f"Workflow {workflow_id} not found")

        (
            wf_id,
            wf_name,
            wf_description,
            user_id,
            project_id,
            nodes_json,
            edges_json,
            spec_json,
            spec_version,
            dapr_workflow_name,
        ) = row
        # JSONB columns may already be dicts/lists, or may need parsing
        nodes = json.loads(nodes_json) if isinstance(nodes_json, str) else nodes_json
        edges = json.loads(edges_json) if isinstance(edges_json, str) else edges_json
        spec = json.loads(spec_json) if isinstance(spec_json, str) else spec_json

        return {
            "id": wf_id,
            "name": wf_name,
            "description": wf_description,
            "userId": user_id,
            "projectId": project_id,
            "nodes": nodes,
            "edges": edges,
            "spec": spec,
            "specVersion": spec_version,
            "daprWorkflowName": dapr_workflow_name,
        }
    finally:
        conn.close()


def _generate_execution_id() -> str:
    """Generate a 21-char lowercase/digit execution ID (matches app conventions)."""
    import secrets
    alphabet = "0123456789abcdefghijklmnopqrstuvwxyz"
    return "".join(secrets.choice(alphabet) for _ in range(21))


def _create_workflow_execution(
    workflow_id: str,
    user_id: str,
    trigger_data: dict[str, Any],
    project_id: str | None = None,
) -> str:
    """Create a running workflow_executions row and return its ID.

    CMA alignment: execution rows carry the owning project_id so downstream
    APIs can scope by workspace without joining through workflows. The
    column was added in migration 0035 and is backfilled for historical
    rows; callers should pass workflow_record["projectId"] when available.
    """
    execution_id = _generate_execution_id()

    if _use_workflow_data_api():
        try:
            result = workflow_data_client.create_execution(
                {
                    "id": execution_id,
                    "workflowId": workflow_id,
                    "userId": user_id,
                    "projectId": project_id,
                    "status": "running",
                    "phase": "running",
                    "progress": 0,
                    "input": trigger_data or {},
                    "workflowSessionId": execution_id,
                }
            )
            result_id = str(result.get("id") or execution_id).strip()
            return result_id or execution_id
        except Exception as exc:
            if _strict_workflow_data_api():
                raise
            _log_workflow_data_fallback("workflow execution create", exc)

    import psycopg2

    db_url = _get_database_url()
    conn = psycopg2.connect(db_url)
    try:
        with conn.cursor() as cur:
            cur.execute(
                """
                INSERT INTO workflow_executions (
                    id, workflow_id, user_id, project_id, status, input, phase, progress, workflow_session_id
                )
                VALUES (%s, %s, %s, %s, %s, %s::jsonb, %s, %s, %s)
                """,
                (
                    execution_id,
                    workflow_id,
                    user_id,
                    project_id,
                    "running",
                    json.dumps(trigger_data or {}),
                    "running",
                    0,
                    execution_id,
                ),
            )
        conn.commit()
    finally:
        conn.close()
    return execution_id


def _mark_workflow_execution_started(
    execution_id: str,
    dapr_instance_id: str,
    primary_trace_id: str | None = None,
) -> None:
    """Attach dapr instance correlation to an execution row."""
    if _use_workflow_data_api():
        try:
            workflow_data_client.attach_execution_scheduler_instance(
                execution_id,
                {
                    "instanceId": dapr_instance_id,
                    "workflowSessionId": execution_id,
                    "primaryTraceId": primary_trace_id,
                },
            )
            return
        except Exception as exc:
            if _strict_workflow_data_api():
                raise
            _log_workflow_data_fallback("execution scheduler attach", exc)

    import psycopg2

    db_url = _get_database_url()
    conn = psycopg2.connect(db_url)
    try:
        with conn.cursor() as cur:
            cur.execute(
                """
                UPDATE workflow_executions
                SET dapr_instance_id = %s,
                    phase = %s,
                    progress = %s,
                    workflow_session_id = COALESCE(workflow_session_id, %s),
                    primary_trace_id = COALESCE(primary_trace_id, %s)
                WHERE id = %s
                """,
                (
                    dapr_instance_id,
                    "running",
                    0,
                    execution_id,
                    primary_trace_id,
                    execution_id,
                ),
            )
        conn.commit()
    finally:
        conn.close()


def _existing_live_execution_instance(execution_id: str) -> str | None:
    """Return the existing Dapr instance for a non-terminal DB execution row."""
    if not execution_id:
        return None

    if _use_workflow_data_api():
        try:
            instance = workflow_data_client.get_live_execution_instance(execution_id)
            if not instance:
                return None
            instance_id = str(instance.get("instanceId") or "").strip()
            return instance_id or None
        except Exception as exc:
            if _strict_workflow_data_api():
                raise
            _log_workflow_data_fallback("live execution lookup", exc)

    import psycopg2

    db_url = _get_database_url()
    conn = psycopg2.connect(db_url)
    try:
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT status, dapr_instance_id
                FROM workflow_executions
                WHERE id = %s
                """,
                (execution_id,),
            )
            row = cur.fetchone()
    finally:
        conn.close()

    if not row:
        return None

    status = str(row[0] or "").strip().lower()
    dapr_instance_id = str(row[1] or "").strip()
    if not dapr_instance_id:
        return None
    if status in {"completed", "failed", "error", "cancelled", "terminated"}:
        return None
    return dapr_instance_id


def _db_execution_status_for_instance(instance_id: str) -> str | None:
    """Return workflow_executions.status (lowercased) for a Dapr instance id, or None.

    Used by the idempotent scheduler to detect a diverged/zombie instance: the
    BFF flipped the DB row terminal but the Dapr worker never closed the
    instance. We act ONLY on that divergence -- a legitimately running instance
    (DB also non-terminal) is left untouched, so we never kill a live run.
    """
    if not instance_id:
        return None

    if _use_workflow_data_api():
        try:
            execution = workflow_data_client.get_execution_by_instance(instance_id)
            status = str((execution or {}).get("status") or "").strip().lower()
            return status or None
        except Exception as exc:
            if _strict_workflow_data_api():
                logger.warning(
                    "[Idempotent Schedule] workflow-data status lookup failed for %s: %s",
                    instance_id,
                    exc,
                )
                return None
            _log_workflow_data_fallback("execution status lookup by Dapr instance", exc)

    import psycopg2

    try:
        conn = psycopg2.connect(_get_database_url(), connect_timeout=3)
    except Exception as exc:
        logger.warning(
            "[Idempotent Schedule] DB status connect failed for %s: %s", instance_id, exc
        )
        return None
    try:
        with conn.cursor() as cur:
            cur.execute(
                "SELECT status FROM workflow_executions WHERE dapr_instance_id = %s LIMIT 1",
                (instance_id,),
            )
            row = cur.fetchone()
    except Exception as exc:
        logger.warning(
            "[Idempotent Schedule] DB status lookup failed for %s: %s", instance_id, exc
        )
        return None
    finally:
        conn.close()
    return str(row[0]).strip().lower() if row and row[0] else None


def _terminate_and_purge_for_reuse(client: DaprWorkflowClient, instance_id: str) -> None:
    """Terminate a diverged/zombie instance, wait for terminal, then purge so the
    deterministic id can be reused cleanly. Best-effort; failures are logged."""
    import time as _time

    try:
        _terminate_workflow_with_timeout(
            client, instance_id, _workflow_terminate_client_fallback_timeout_seconds()
        )
    except Exception as exc:
        logger.warning(
            "[Idempotent Schedule] terminate-for-reuse failed for %s: %s", instance_id, exc
        )
    for _ in range(20):
        try:
            state = client.get_workflow_state(instance_id=instance_id, fetch_payloads=False)
        except Exception:
            state = None
        status = (
            _normalize_workflow_runtime_status(getattr(state, "runtime_status", ""))
            if state is not None
            else ""
        )
        if status in {"COMPLETED", "FAILED", "TERMINATED", ""}:
            break
        _time.sleep(0.5)
    try:
        client.purge_workflow(instance_id=instance_id)
        logger.info("[Idempotent Schedule] Purged diverged instance %s for reuse", instance_id)
    except Exception as exc:
        logger.warning(
            "[Idempotent Schedule] purge-for-reuse failed for %s: %s", instance_id, exc
        )


def _mark_workflow_execution_failed_to_start(execution_id: str, error: str) -> None:
    """Set failure state when workflow scheduling fails before execution starts."""
    if _use_workflow_data_api():
        try:
            workflow_data_client.mark_execution_start_failed(execution_id, error)
            return
        except Exception as exc:
            if _strict_workflow_data_api():
                raise
            _log_workflow_data_fallback("execution failed-to-start update", exc)

    import psycopg2
    from datetime import datetime, timezone

    db_url = _get_database_url()
    conn = psycopg2.connect(db_url)
    try:
        with conn.cursor() as cur:
            cur.execute(
                """
                UPDATE workflow_executions
                SET status = %s,
                    phase = %s,
                    progress = %s,
                    error = %s,
                    completed_at = %s
                WHERE id = %s
                """,
                (
                    "error",
                    "failed",
                    100,
                    error,
                    datetime.now(timezone.utc),
                    execution_id,
                ),
            )
        conn.commit()
    finally:
        conn.close()


def _is_benchmark_workflow_execution(
    dapr_instance_id: str | None,
    workflow_input: Any,
) -> bool:
    if isinstance(dapr_instance_id, str) and dapr_instance_id.startswith(
        "sw-swebench-instance-exec-"
    ):
        return True
    if isinstance(workflow_input, dict):
        trigger = workflow_input.get("trigger")
        if isinstance(trigger, dict):
            data = trigger.get("data")
            if isinstance(data, dict) and data.get("runId") and data.get("instanceId"):
                return True
        if workflow_input.get("runId") and workflow_input.get("instanceId"):
            return True
    return False


def _list_stale_running_execution_rows(
    stale_threshold_minutes: int,
) -> list[tuple[str, str | None, Any]]:
    if _use_workflow_data_api():
        try:
            rows = workflow_data_client.list_stale_running_executions(
                stale_threshold_minutes
            )
            normalized_rows: list[tuple[str, str | None, Any]] = []
            for row in rows:
                execution_id = str(row.get("id") or "").strip()
                if not execution_id:
                    continue
                dapr_instance_id = str(row.get("daprInstanceId") or "").strip() or None
                normalized_rows.append(
                    (execution_id, dapr_instance_id, row.get("input"))
                )
            return normalized_rows
        except Exception as exc:
            if _strict_workflow_data_api():
                raise
            _log_workflow_data_fallback("stale running execution lookup", exc)

    import psycopg2

    db_url = _get_database_url()
    conn = psycopg2.connect(db_url)
    try:
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT id, dapr_instance_id, input
                FROM workflow_executions
                WHERE status = 'running'
                  AND started_at < NOW() - INTERVAL '%s minutes'
                """,
                (stale_threshold_minutes,),
            )
            return list(cur.fetchall())
    finally:
        conn.close()


def _cleanup_stale_instances_on_startup() -> None:
    """Terminate stale Dapr workflow instances and mark DB records on startup.

    Prevents the cascade problem where the orchestrator restart replays all
    running workflow actors from Redis, each creating new sandbox pods.
    """
    stale_threshold_minutes = int(os.environ.get("STALE_THRESHOLD_MINUTES", "60"))
    terminate_timeout_seconds = max(
        1,
        int(os.environ.get("STARTUP_CLEANUP_TERMINATE_TIMEOUT_SECONDS", "15")),
    )
    if os.environ.get("CLEANUP_STALE_ON_STARTUP", "false").lower() != "true":
        logger.info("[Startup Cleanup] Disabled via CLEANUP_STALE_ON_STARTUP=false")
        return

    logger.info(
        "[Startup Cleanup] Cleaning up stale instances older than %d minutes",
        stale_threshold_minutes,
    )

    try:
        stale_rows = _list_stale_running_execution_rows(stale_threshold_minutes)

        if not stale_rows:
            logger.info("[Startup Cleanup] No stale instances found")
            return

        logger.info("[Startup Cleanup] Found %d stale execution(s)", len(stale_rows))
        client = get_workflow_client()
        terminated_count = 0

        for execution_id, dapr_instance_id, workflow_input in stale_rows:
            if _is_benchmark_workflow_execution(dapr_instance_id, workflow_input):
                logger.info(
                    "[Startup Cleanup] Skipping benchmark workflow %s (%s)",
                    execution_id,
                    dapr_instance_id,
                )
                continue

            if dapr_instance_id:
                try:
                    _terminate_workflow_with_timeout(
                        client,
                        dapr_instance_id,
                        terminate_timeout_seconds,
                    )
                    terminated_count += 1
                    logger.info(
                        "[Startup Cleanup] Terminated Dapr instance %s (exec %s)",
                        dapr_instance_id,
                        execution_id,
                    )
                except TimeoutError:
                    logger.warning(
                        "[Startup Cleanup] Timed out terminating %s after %ss",
                        dapr_instance_id,
                        terminate_timeout_seconds,
                    )
                except Exception as term_err:
                    logger.warning(
                        "[Startup Cleanup] Failed to terminate %s: %s",
                        dapr_instance_id,
                        term_err,
                    )

            # Mark DB record as error
            try:
                _mark_workflow_execution_failed_to_start(
                    execution_id,
                    "Terminated on startup: stale instance",
                )
            except Exception as db_err:
                logger.warning(
                    "[Startup Cleanup] Failed to mark execution %s: %s",
                    execution_id,
                    db_err,
                )

        logger.info(
            "[Startup Cleanup] Done: terminated %d Dapr instance(s), "
            "cleaned %d DB record(s)",
            terminated_count,
            len(stale_rows),
        )

    except Exception as exc:
        logger.error("[Startup Cleanup] Failed: %s", exc, exc_info=True)


def _terminate_workflow_with_timeout(
    client: DaprWorkflowClient,
    instance_id: str,
    timeout_seconds: int,
) -> None:
    result: dict[str, BaseException | None] = {"error": None}

    def _terminate() -> None:
        try:
            client.terminate_workflow(instance_id=instance_id)
        except BaseException as exc:  # pragma: no cover - surfaced after join
            result["error"] = exc

    thread = threading.Thread(
        target=_terminate,
        name=f"startup-cleanup-terminate-{instance_id}",
        daemon=True,
    )
    thread.start()
    thread.join(timeout_seconds)

    if thread.is_alive():
        raise TimeoutError(
            f"Timed out terminating workflow instance {instance_id} after "
            f"{timeout_seconds}s"
        )

    if result["error"] is not None:
        raise result["error"]


def _start_startup_cleanup_thread() -> None:
    thread = threading.Thread(
        target=_cleanup_stale_instances_on_startup,
        name="startup-cleanup",
        daemon=True,
    )
    thread.start()
    logger.info("[Startup Cleanup] Background cleanup thread started")


def _topological_sort(nodes: list[dict], edges: list[dict]) -> list[str]:
    """Kahn's algorithm – returns node IDs in execution order (skips trigger/add/note)."""
    edges_by_source: dict[str, list[str]] = {}
    in_degree: dict[str, int] = {}

    for node in nodes:
        nid = node["id"]
        in_degree[nid] = 0
        edges_by_source[nid] = []

    for edge in edges:
        src, tgt = edge["source"], edge["target"]
        edges_by_source.setdefault(src, []).append(tgt)
        in_degree[tgt] = in_degree.get(tgt, 0) + 1

    from collections import deque
    queue = deque(nid for nid, deg in in_degree.items() if deg == 0)
    result: list[str] = []

    while queue:
        nid = queue.popleft()
        node = next((n for n in nodes if n["id"] == nid), None)
        if node:
            ntype = node.get("type", "")
            if ntype not in ("trigger", "add", "note"):
                result.append(nid)
        for neighbor in edges_by_source.get(nid, []):
            in_degree[neighbor] -= 1
            if in_degree[neighbor] == 0:
                queue.append(neighbor)

    return result


def _serialize_node(node: dict) -> dict[str, Any]:
    """Flatten React Flow node format to orchestrator SerializedNode format."""
    data = node.get("data", {})
    return {
        "id": node["id"],
        "type": data.get("type", node.get("type", "action")),
        "label": data.get("label", ""),
        "description": data.get("description"),
        "enabled": data.get("enabled", True),
        "position": node.get("position", {"x": 0, "y": 0}),
        "config": data.get("config", {}),
    }


def _node_type(node: dict[str, Any]) -> str:
    data = node.get("data", {}) if isinstance(node.get("data"), dict) else {}
    return str(data.get("type") or node.get("type") or "")


def _is_while_node(node: dict[str, Any]) -> bool:
    return _node_type(node) == "while"


def _is_while_body_candidate(node: dict[str, Any]) -> bool:
    if _node_type(node) != "action":
        return False
    data = node.get("data", {}) if isinstance(node.get("data"), dict) else {}
    config = data.get("config", {}) if isinstance(data.get("config"), dict) else {}
    return str(config.get("actionType") or "").strip() == "durable/run"


def _abs_position(
    node: dict[str, Any],
    by_id: dict[str, dict[str, Any]],
) -> dict[str, float]:
    x = float((node.get("position") or {}).get("x", 0))
    y = float((node.get("position") or {}).get("y", 0))
    current = node
    while current.get("parentId"):
        parent = by_id.get(str(current.get("parentId")))
        if not parent:
            break
        x += float((parent.get("position") or {}).get("x", 0))
        y += float((parent.get("position") or {}).get("y", 0))
        current = parent
    return {"x": x, "y": y}


def _next_unique_id(base: str, used: set[str]) -> str:
    if base not in used:
        return base
    i = 1
    while f"{base}-{i}" in used:
        i += 1
    return f"{base}-{i}"


def _lower_while_nodes(nodes: list[dict[str, Any]], edges: list[dict[str, Any]]) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    while_nodes = [n for n in nodes if _is_while_node(n)]
    if not while_nodes:
        return nodes, edges

    lowered_nodes = list(nodes)
    lowered_edges = list(edges)

    for while_node in while_nodes:
        while_id = str(while_node.get("id") or "")
        if not while_id:
            continue

        by_id = {
            str(node.get("id")): node
            for node in lowered_nodes
            if node.get("id") is not None
        }
        while_abs = _abs_position(while_node, by_id)
        data = while_node.get("data", {}) if isinstance(while_node.get("data"), dict) else {}
        config = data.get("config", {}) if isinstance(data.get("config"), dict) else {}
        while_expression = str(config.get("expression") or "").strip()

        max_iterations_raw = config.get("maxIterations", 20)
        delay_seconds_raw = config.get("delaySeconds", 0)
        try:
            max_iterations = max(1, int(max_iterations_raw))
        except Exception:
            max_iterations = 20
        try:
            delay_seconds = max(0, int(delay_seconds_raw))
        except Exception:
            delay_seconds = 0
        on_max_iterations = str(config.get("onMaxIterations") or "continue").strip().lower()
        if on_max_iterations not in ("continue", "fail"):
            on_max_iterations = "continue"

        children = sorted(
            [
                n
                for n in lowered_nodes
                if str(n.get("parentId") or "") == while_id
            ],
            key=lambda n: str(n.get("id") or ""),
        )
        child_ids = {str(n.get("id") or "") for n in children if n.get("id")}
        body = next((n for n in children if _is_while_body_candidate(n)), None)

        if body is None:
            lowered_nodes = [
                n
                for n in lowered_nodes
                if str(n.get("id") or "") not in child_ids or str(n.get("id") or "") == while_id
            ]
            lowered_edges = [
                e
                for e in lowered_edges
                if str(e.get("source") or "") not in child_ids
                and str(e.get("target") or "") not in child_ids
            ]

            for idx, node in enumerate(lowered_nodes):
                if str(node.get("id") or "") != while_id:
                    continue
                node_data = node.get("data", {}) if isinstance(node.get("data"), dict) else {}
                node_data["type"] = "loop-until"
                node_data["config"] = {
                    "loopStartNodeId": "",
                    "maxIterations": max_iterations,
                    "delaySeconds": delay_seconds,
                    "onMaxIterations": on_max_iterations,
                    "operator": "BOOLEAN_IS_TRUE",
                    "left": True,
                    "conditionMode": "celExpression",
                    "celExpression": f"!({while_expression})" if while_expression else "true",
                    "whileExpression": while_expression,
                }
                node["type"] = "loop-until"
                node["data"] = node_data
                lowered_nodes[idx] = node
                break
            continue

        body_id = str(body.get("id") or "")
        if not body_id:
            continue

        body_abs = _abs_position(body, by_id)
        loop_id = while_id

        incoming = [e for e in lowered_edges if str(e.get("target") or "") == while_id]
        outgoing = [e for e in lowered_edges if str(e.get("source") or "") == while_id]

        next_nodes: list[dict[str, Any]] = []
        for node in lowered_nodes:
            nid = str(node.get("id") or "")
            if nid == while_id:
                continue
            if nid in child_ids and nid != body_id:
                continue
            if nid == body_id:
                node = dict(node)
                node["position"] = body_abs
                node.pop("parentId", None)
                node.pop("extent", None)
            next_nodes.append(node)

        loop_node = {
            "id": loop_id,
            "type": "loop-until",
            "position": {
                "x": max(while_abs["x"] + 250, body_abs["x"] + 240),
                "y": body_abs["y"],
            },
            "data": {
                "label": str(data.get("label") or "While"),
                "description": str(data.get("description") or "Loop while condition is true"),
                "type": "loop-until",
                "config": {
                    "loopStartNodeId": body_id,
                    "maxIterations": max_iterations,
                    "delaySeconds": delay_seconds,
                    "onMaxIterations": on_max_iterations,
                    "operator": "BOOLEAN_IS_TRUE",
                    "left": True,
                    "conditionMode": "celExpression",
                    "celExpression": f"!({while_expression})" if while_expression else "true",
                    "whileExpression": while_expression,
                },
                "status": str(data.get("status") or "idle"),
                "enabled": bool(data.get("enabled", True)),
            },
        }
        next_nodes.append(loop_node)
        lowered_nodes = next_nodes

        lowered_edges = [
            e
            for e in lowered_edges
            if str(e.get("source") or "") != while_id
            and str(e.get("target") or "") != while_id
            and str(e.get("source") or "") not in child_ids
            and str(e.get("target") or "") not in child_ids
        ]

        used_edge_ids = {str(e.get("id") or "") for e in lowered_edges}

        def append_edge(source: str, target: str, source_handle: Any = None, target_handle: Any = None) -> None:
            base = f"{source}->{target}"
            if source_handle:
                base = f"{base}:{source_handle}"
            edge_id = _next_unique_id(base, used_edge_ids)
            used_edge_ids.add(edge_id)
            lowered_edges.append(
                {
                    "id": edge_id,
                    "source": source,
                    "target": target,
                    "sourceHandle": source_handle,
                    "targetHandle": target_handle,
                    "type": "animated",
                }
            )

        for edge in incoming:
            source = str(edge.get("source") or "")
            if source:
                append_edge(
                    source=source,
                    target=body_id,
                    source_handle=edge.get("sourceHandle"),
                    target_handle=edge.get("targetHandle"),
                )

        append_edge(source=body_id, target=loop_id)

        for edge in outgoing:
            target = str(edge.get("target") or "")
            if target:
                append_edge(
                    source=loop_id,
                    target=target,
                    source_handle=edge.get("sourceHandle"),
                    target_handle=edge.get("targetHandle"),
                )

    return lowered_nodes, lowered_edges


def map_runtime_status(dapr_status: str) -> str:
    """Map Dapr runtime status to our status format."""
    status_map = {
        "WORKFLOW_RUNTIME_STATUS_UNSPECIFIED": "UNKNOWN",
        "WORKFLOW_RUNTIME_STATUS_RUNNING": "RUNNING",
        "WORKFLOW_RUNTIME_STATUS_COMPLETED": "COMPLETED",
        "WORKFLOW_RUNTIME_STATUS_FAILED": "FAILED",
        "WORKFLOW_RUNTIME_STATUS_CANCELED": "CANCELED",
        "WORKFLOW_RUNTIME_STATUS_TERMINATED": "TERMINATED",
        "WORKFLOW_RUNTIME_STATUS_PENDING": "PENDING",
        "WORKFLOW_RUNTIME_STATUS_SUSPENDED": "SUSPENDED",
        "WORKFLOW_RUNTIME_STATUS_STALLED": "STALLED",
        # DurableTask orchestration status names (gRPC management APIs)
        "ORCHESTRATION_STATUS_RUNNING": "RUNNING",
        "ORCHESTRATION_STATUS_COMPLETED": "COMPLETED",
        "ORCHESTRATION_STATUS_FAILED": "FAILED",
        "ORCHESTRATION_STATUS_CANCELED": "CANCELED",
        "ORCHESTRATION_STATUS_TERMINATED": "TERMINATED",
        "ORCHESTRATION_STATUS_PENDING": "PENDING",
        "ORCHESTRATION_STATUS_SUSPENDED": "SUSPENDED",
        "ORCHESTRATION_STATUS_STALLED": "STALLED",
        # Handle string values
        "RUNNING": "RUNNING",
        "COMPLETED": "COMPLETED",
        "FAILED": "FAILED",
        "CANCELED": "CANCELED",
        "TERMINATED": "TERMINATED",
        "PENDING": "PENDING",
        "SUSPENDED": "SUSPENDED",
        "STALLED": "STALLED",
    }
    return status_map.get(str(dapr_status), "UNKNOWN")


def _workflow_id_from_instance(instance_id: str) -> str:
    """Extract workflow ID from instance ID.

    Supports formats:
    - Deterministic: ``{workflow_id}-exec-{execution_id}``
    - Legacy random:  ``{workflow_id}-{timestamp_ms}-{random_suffix}``
    - Child:          ``{parent_instance_id}__sub__{node_id}__{index}``
    """
    # Child workflow: strip the __sub__ suffix first
    if "__sub__" in instance_id:
        instance_id = instance_id.split("__sub__")[0]
    # Deterministic format: {workflow_id}-exec-{execution_id}
    if "-exec-" in instance_id:
        return instance_id.split("-exec-")[0]
    # Legacy format: {workflow_id}-{timestamp_ms}-{random_suffix}
    parts = instance_id.rsplit("-", 2)
    if len(parts) == 3 and parts[1].isdigit():
        return parts[0]
    return instance_id.split("-")[0]


def _parse_json_value(value: Any) -> Any:
    """Parse serialized JSON payloads from Dapr workflow state."""
    parsed = value
    while isinstance(parsed, str):
        text = parsed.strip()
        if not text:
            return parsed
        try:
            parsed = json.loads(text)
        except Exception:
            return parsed
    return parsed


def _parse_wrapped_string(wrapper: Any) -> str | None:
    if wrapper is None:
        return None
    value = getattr(wrapper, "value", None)
    if isinstance(value, str) and value:
        return value
    return None


def _timestamp_to_iso(timestamp_field: Any) -> str | None:
    if timestamp_field is None:
        return None
    try:
        seconds = int(getattr(timestamp_field, "seconds", 0) or 0)
        nanos = int(getattr(timestamp_field, "nanos", 0) or 0)
        if seconds == 0 and nanos == 0:
            return None
        return timestamp_field.ToDatetime().isoformat()
    except Exception:
        return None


def _orchestration_state_status_name(orchestration_state: Any) -> str:
    """
    Return best-effort orchestration status enum name.

    Dapr workflow wrappers expose this via WorkflowState.runtime_status, while
    TaskHub gRPC APIs expose it via orchestrationStatus.
    """
    status_attr = getattr(orchestration_state, "orchestrationStatus", None)
    if status_attr is None:
        status_attr = getattr(orchestration_state, "workflowStatus", None)
    if status_attr is None:
        status_attr = getattr(orchestration_state, "workflow_status", None)
    if status_attr is None:
        runtime_status = getattr(orchestration_state, "runtime_status", None)
        if runtime_status is not None:
            return (
                runtime_status.name
                if hasattr(runtime_status, "name")
                else str(runtime_status)
            )
        return "UNKNOWN"
    try:
        return pb.OrchestrationStatus.Name(status_attr)
    except Exception:
        return str(status_attr)


def _build_workflow_status_payload(instance_id: str, orchestration_state: Any) -> dict[str, Any]:
    """Build normalized workflow status payload from TaskHub orchestration state."""
    runtime_status = map_runtime_status(
        _orchestration_state_status_name(orchestration_state)
    )
    custom_status_raw = _parse_wrapped_string(
        getattr(orchestration_state, "customStatus", None)
    )
    custom_status = _parse_json_value(custom_status_raw)
    phase = None
    progress = 0
    message = None
    current_node_id = None
    current_node_name = None
    approval_event_name = None
    trace_id = None
    workflow_version = _parse_wrapped_string(
        getattr(orchestration_state, "version", None)
    )
    outputs = None
    error = None
    stack_trace = None
    parent_instance_id = _parse_wrapped_string(
        getattr(orchestration_state, "parentInstanceId", None)
    )

    if isinstance(custom_status, dict):
        phase = custom_status.get("phase")
        progress = custom_status.get("progress", 0)
        message = custom_status.get("message")
        current_node_id = custom_status.get("currentNodeId")
        current_node_name = custom_status.get("currentNodeName")
        approval_event_name = custom_status.get("approvalEventName")
        trace_id = custom_status.get("traceId") or custom_status.get("trace_id")
        workflow_version = (
            str(custom_status.get("workflowVersion") or "").strip()
            or workflow_version
        )

    input_payload = _parse_json_value(
        _parse_wrapped_string(getattr(orchestration_state, "input", None))
    )
    if not trace_id and isinstance(input_payload, dict):
        otel_ctx = input_payload.get("_otel")
        if isinstance(otel_ctx, dict):
            trace_id = (
                str(otel_ctx.get("traceId") or "").strip()
                or _trace_id_from_traceparent(otel_ctx.get("traceparent"))
            )

    serialized_output = _parse_json_value(
        _parse_wrapped_string(getattr(orchestration_state, "output", None))
    )
    if isinstance(serialized_output, dict):
        outputs = serialized_output
        if not trace_id:
            trace_id = str(serialized_output.get("traceId") or "").strip() or None
        nested_outputs = serialized_output.get("outputs")
        if not trace_id and isinstance(nested_outputs, dict):
            for value in nested_outputs.values():
                if not isinstance(value, dict):
                    continue
                candidate = str(
                    value.get("traceId")
                    or (
                        value.get("agentProgress", {}).get("traceId")
                        if isinstance(value.get("agentProgress"), dict)
                        else ""
                    )
                    or ""
                ).strip()
                if candidate:
                    trace_id = candidate
                    break
    elif serialized_output is not None:
        outputs = {"raw": serialized_output}

    failure_details = getattr(orchestration_state, "failureDetails", None)
    if failure_details is not None:
        failure_message = str(getattr(failure_details, "errorMessage", "") or "")
        if isinstance(failure_message, str) and failure_message:
            error = failure_message
        stack_trace = _parse_wrapped_string(getattr(failure_details, "stackTrace", None))

    started_at = _timestamp_to_iso(getattr(orchestration_state, "createdTimestamp", None))

    completed_at = None
    if runtime_status in ("COMPLETED", "FAILED", "TERMINATED"):
        completed_at = _timestamp_to_iso(
            getattr(orchestration_state, "completedTimestamp", None)
        ) or _timestamp_to_iso(getattr(orchestration_state, "lastUpdatedTimestamp", None))

    workflow_name = str(getattr(orchestration_state, "name", "") or "") or None
    workflow_name_versioned = (
        f"{workflow_name}@{workflow_version}"
        if workflow_name and workflow_version
        else workflow_name
    )

    workflow_id = _workflow_id_from_instance(instance_id)

    return {
        "instanceId": instance_id,
        "workflowId": workflow_id,
        "workflowName": workflow_name,
        "workflowVersion": workflow_version,
        "workflowNameVersioned": workflow_name_versioned,
        "runtimeStatus": runtime_status,
        "traceId": trace_id,
        "phase": phase
        or (runtime_status.lower() if runtime_status in ("RUNNING", "PENDING") else None),
        "progress": progress if isinstance(progress, int) else 0,
        "message": message,
        "currentNodeId": current_node_id,
        "currentNodeName": current_node_name,
        "approvalEventName": approval_event_name,
        "outputs": outputs,
        "error": error,
        "stackTrace": stack_trace,
        "parentInstanceId": parent_instance_id,
        "startedAt": started_at,
        "completedAt": completed_at,
    }


def _build_workflow_status_payload_from_http(
    instance_id: str,
    workflow_payload: dict[str, Any],
) -> dict[str, Any]:
    """Build normalized workflow status payload from Dapr's HTTP Workflow API."""
    runtime_status = map_runtime_status(
        str(
            _workflow_dict_value(
                workflow_payload,
                "runtimeStatus",
                "runtime_status",
            )
            or "UNKNOWN"
        ).upper()
    )
    # Try the top-level keys first, then drill into the Dapr HTTP API's
    # `properties.dapr.workflow.custom_status` field. The HTTP API always
    # nests custom_status under `properties` with a dotted key — without
    # this drill, _workflow_dict_value matches `properties` itself and
    # returns the dict, leaving custom_status empty + traceId/phase null
    # on the BFF poll path (verified live 2026-05-11 against execution
    # peb23oNs2mXUIvPS_tksF — workflow_executions.primary_trace_id was
    # null on completed runs because the orchestrator status response
    # couldn't extract traceId from the Dapr API payload).
    raw_custom_status = _workflow_dict_value(
        workflow_payload,
        "customStatus",
        "custom_status",
    )
    if raw_custom_status is None:
        props = workflow_payload.get("properties")
        if isinstance(props, dict):
            raw_custom_status = (
                props.get("dapr.workflow.custom_status")
                or props.get("dapr.workflow.customStatus")
                or props.get("custom_status")
            )
    custom_status = _parse_json_value(raw_custom_status)
    phase = None
    progress = 0
    message = None
    current_node_id = None
    current_node_name = None
    approval_event_name = None
    trace_id = None
    workflow_version = None
    outputs = None
    error = None
    stack_trace = None
    parent_instance_id = (
        _workflow_dict_value(
            workflow_payload,
            "parentInstanceId",
            "parent_instance_id",
        )
        or None
    )

    if isinstance(custom_status, dict):
        phase = custom_status.get("phase")
        progress = custom_status.get("progress", 0)
        message = custom_status.get("message")
        current_node_id = custom_status.get("currentNodeId")
        current_node_name = custom_status.get("currentNodeName")
        approval_event_name = custom_status.get("approvalEventName")
        trace_id = custom_status.get("traceId") or custom_status.get("trace_id")
        workflow_version = (
            str(custom_status.get("workflowVersion") or "").strip() or None
        )

    input_payload = _parse_json_value(
        _workflow_dict_value(
            workflow_payload,
            "input",
            "serializedInput",
            "serialized_input",
        )
    )
    if not trace_id and isinstance(input_payload, dict):
        otel_ctx = input_payload.get("_otel")
        if isinstance(otel_ctx, dict):
            trace_id = (
                str(otel_ctx.get("traceId") or "").strip()
                or _trace_id_from_traceparent(otel_ctx.get("traceparent"))
            )

    serialized_output = _parse_json_value(
        _workflow_dict_value(
            workflow_payload,
            "output",
            "serializedOutput",
            "serialized_output",
        )
    )
    if isinstance(serialized_output, dict):
        outputs = serialized_output
        if not trace_id:
            trace_id = str(serialized_output.get("traceId") or "").strip() or None
        nested_outputs = serialized_output.get("outputs")
        if not trace_id and isinstance(nested_outputs, dict):
            for value in nested_outputs.values():
                if not isinstance(value, dict):
                    continue
                agent_progress = value.get("agentProgress")
                candidate = str(
                    value.get("traceId")
                    or (
                        agent_progress.get("traceId")
                        if isinstance(agent_progress, dict)
                        else ""
                    )
                    or ""
                ).strip()
                if candidate:
                    trace_id = candidate
                    break
    elif serialized_output is not None:
        outputs = {"raw": serialized_output}

    failure_details = _workflow_dict_value(
        workflow_payload,
        "failureDetails",
        "failure_details",
    )
    if isinstance(failure_details, dict):
        error = str(
            failure_details.get("errorMessage")
            or failure_details.get("error_message")
            or ""
        ).strip() or None
        stack_trace_value = failure_details.get("stackTrace") or failure_details.get(
            "stack_trace"
        )
        if isinstance(stack_trace_value, dict):
            stack_trace_value = stack_trace_value.get("value")
        stack_trace = str(stack_trace_value).strip() if stack_trace_value else None

    started_at = _workflow_dict_value(
        workflow_payload,
        "createdAt",
        "created_at",
        "startedAt",
        "started_at",
    )
    last_updated_at = _workflow_dict_value(
        workflow_payload,
        "lastUpdatedAt",
        "last_updated_at",
        "updatedAt",
        "updated_at",
    )
    completed_at = _workflow_dict_value(
        workflow_payload,
        "completedAt",
        "completed_at",
    )
    if runtime_status in ("COMPLETED", "FAILED", "TERMINATED"):
        completed_at = completed_at or last_updated_at

    workflow_name = (
        _workflow_dict_value(workflow_payload, "name", "workflowName", "workflow_name")
        or None
    )
    if workflow_name is not None:
        workflow_name = str(workflow_name)
    workflow_name_versioned = (
        f"{workflow_name}@{workflow_version}"
        if workflow_name and workflow_version
        else workflow_name
    )
    workflow_id = _workflow_id_from_instance(instance_id)

    return {
        "instanceId": instance_id,
        "workflowId": workflow_id,
        "workflowName": workflow_name,
        "workflowVersion": workflow_version,
        "workflowNameVersioned": workflow_name_versioned,
        "runtimeStatus": runtime_status,
        "traceId": trace_id,
        "phase": phase
        or (runtime_status.lower() if runtime_status in ("RUNNING", "PENDING") else None),
        "progress": progress if isinstance(progress, int) else 0,
        "message": message,
        "currentNodeId": current_node_id,
        "currentNodeName": current_node_name,
        "approvalEventName": approval_event_name,
        "outputs": outputs,
        "error": error,
        "stackTrace": stack_trace,
        "parentInstanceId": parent_instance_id,
        "startedAt": started_at if isinstance(started_at, str) else None,
        "completedAt": completed_at if isinstance(completed_at, str) else None,
    }


def _workflow_payload_matches_filters(
    payload: dict[str, Any],
    *,
    status_filter: set[str] | None,
    search_filter: str,
) -> bool:
    runtime_status = str(payload.get("runtimeStatus") or "UNKNOWN").upper()
    if status_filter and runtime_status not in status_filter:
        return False

    if search_filter:
        fields = [
            str(payload.get("instanceId") or ""),
            str(payload.get("workflowId") or ""),
            str(payload.get("workflowName") or ""),
            str(payload.get("workflowNameVersioned") or ""),
            str(payload.get("phase") or ""),
            str(payload.get("message") or ""),
        ]
        if not any(search_filter in field.lower() for field in fields):
            return False

    return True


def _list_workflows_from_taskhub_instance_ids(
    *,
    status_filter: set[str] | None,
    search_filter: str,
    limit: int,
    offset: int,
) -> WorkflowListResponse:
    """
    List workflow instances using Dapr's Task Hub ListInstanceIDs protocol.

    QueryInstances is unimplemented in the current Dapr workflow runtime, but
    ListInstanceIDs is implemented and documented for management-tool pagination.
    Hydrate each returned ID with GetInstance so the response still contains
    normalized status, timestamps, custom status, trace IDs, and outputs.
    """
    instance_ids: list[str] = []
    continuation_token: str | None = None
    max_scan = 5000

    while len(instance_ids) < max_scan:
        page_ids, continuation_token = _list_instance_ids(
            continuation_token=continuation_token,
            page_size=200,
        )
        if not page_ids:
            break
        instance_ids.extend(page_ids)
        if not continuation_token:
            break

    items: list[dict[str, Any]] = []

    for instance_id in instance_ids[:max_scan]:
        response = _taskhub_call(
            "GetInstance",
            pb.GetInstanceRequest(instanceId=instance_id, getInputsAndOutputs=True),
        )
        if not getattr(response, "exists", False):
            continue

        orchestration_state_missing = object()
        orchestration_state = getattr(
            response, "orchestrationState", orchestration_state_missing
        )
        if orchestration_state is orchestration_state_missing:
            orchestration_state = getattr(
                response, "orchestration_state", orchestration_state_missing
            )
        if orchestration_state is orchestration_state_missing:
            orchestration_state = getattr(
                response, "workflowState", orchestration_state_missing
            )
        if orchestration_state is orchestration_state_missing:
            orchestration_state = getattr(
                response, "workflow_state", orchestration_state_missing
            )
        if orchestration_state is orchestration_state_missing:
            raise AttributeError(
                "GetInstance response did not include orchestration state"
            )
        payload = _build_workflow_status_payload(instance_id, orchestration_state)
        if _workflow_payload_matches_filters(
            payload,
            status_filter=status_filter,
            search_filter=search_filter,
        ):
            items.append(payload)

    items.sort(
        key=lambda item: str(item.get("startedAt") or ""),
        reverse=True,
    )
    total = len(items)
    page = items[offset : offset + limit]
    workflows = [WorkflowListItemResponse(**item) for item in page]

    return WorkflowListResponse(
        workflows=workflows,
        total=total,
        limit=limit,
        offset=offset,
    )


def _normalize_history_event(event: Any) -> dict[str, Any]:
    """Normalize a durabletask HistoryEvent protobuf object."""
    from google.protobuf.json_format import MessageToDict

    payload_name = "unknown"
    payload = None
    for field_descriptor, value in event.ListFields():
        if field_descriptor.name in ("eventId", "timestamp", "router"):
            continue
        payload_name = field_descriptor.name
        payload = value
        break

    payload_dict = (
        MessageToDict(payload, preserving_proto_field_name=True)
        if payload is not None
        else {}
    )

    name_value = None
    for key in ("name", "event_name", "instance_id", "task_execution_id", "task_scheduled_id"):
        value = payload_dict.get(key)
        if isinstance(value, (str, int)):
            name_value = str(value)
            break

    input_value = payload_dict.get("input")
    if isinstance(input_value, dict):
        input_value = input_value.get("value", input_value)
    output_value = payload_dict.get("result")
    if isinstance(output_value, dict):
        output_value = output_value.get("value", output_value)
    if output_value is None and "failure_details" in payload_dict:
        output_value = payload_dict.get("failure_details")

    metadata: dict[str, Any] = {}
    orchestration_status = payload_dict.get("orchestration_status") or payload_dict.get(
        "orchestrationStatus"
    )
    if orchestration_status:
        metadata["status"] = map_runtime_status(str(orchestration_status))
    task_id = payload_dict.get("task_scheduled_id") or payload_dict.get("task_execution_id")
    if isinstance(task_id, (str, int)):
        metadata["taskId"] = str(task_id)
    failure_details = payload_dict.get("failure_details") or payload_dict.get(
        "failureDetails"
    )
    if isinstance(failure_details, dict):
        error_message = failure_details.get("error_message") or failure_details.get(
            "errorMessage"
        )
        if isinstance(error_message, str) and error_message:
            metadata["error"] = error_message
        stack_trace = failure_details.get("stack_trace") or failure_details.get(
            "stackTrace"
        )
        if isinstance(stack_trace, dict):
            stack_trace = stack_trace.get("value")
        if isinstance(stack_trace, str) and stack_trace:
            metadata["stackTrace"] = stack_trace
    rerun_parent = payload_dict.get("rerun_parent_instance_info")
    if isinstance(rerun_parent, dict):
        source_instance_id = rerun_parent.get("instance_id")
        if isinstance(source_instance_id, str) and source_instance_id:
            metadata["rerunSourceInstanceId"] = source_instance_id
    version_value = payload_dict.get("version")
    if isinstance(version_value, dict):
        version_value = version_value.get("value")
    if isinstance(version_value, str) and version_value:
        metadata["version"] = version_value

    timestamp = None
    if hasattr(event, "timestamp") and event.HasField("timestamp"):
        timestamp = event.timestamp.ToDatetime().isoformat()

    event_id = int(event.eventId) if getattr(event, "eventId", 0) > 0 else None
    event_type = payload_name[0:1].upper() + payload_name[1:]

    return {
        "eventId": event_id,
        "eventType": event_type,
        "timestamp": timestamp,
        "name": name_value,
        "input": _parse_json_value(input_value),
        "output": _parse_json_value(output_value),
        "metadata": metadata or None,
        "raw": payload_dict or None,
    }


def _get_instance_history(instance_id: str) -> list[dict[str, Any]]:
    """Get workflow execution history events via Dapr 1.17 APIs."""
    response = _taskhub_call("GetInstanceHistory", pb.GetInstanceHistoryRequest(instanceId=instance_id))
    return [_normalize_history_event(event) for event in response.events]


def _workflow_failure_details_from_history(
    events: list[dict[str, Any]],
) -> tuple[str | None, str | None]:
    """Extract terminal failure details when Dapr's status API omits them."""
    for event in events:
        if str(event.get("eventType") or "") != "ExecutionCompleted":
            continue

        metadata = event.get("metadata")
        if isinstance(metadata, dict):
            error = metadata.get("error")
            stack_trace = metadata.get("stackTrace")
            if isinstance(error, str) and error.strip():
                return (
                    error.strip(),
                    stack_trace.strip()
                    if isinstance(stack_trace, str) and stack_trace.strip()
                    else None,
                )

        output = event.get("output")
        if isinstance(output, dict):
            error = output.get("error_message") or output.get("errorMessage")
            stack_trace = output.get("stack_trace") or output.get("stackTrace")
            if isinstance(stack_trace, dict):
                stack_trace = stack_trace.get("value")
            if isinstance(error, str) and error.strip():
                return (
                    error.strip(),
                    stack_trace.strip()
                    if isinstance(stack_trace, str) and stack_trace.strip()
                    else None,
                )

        raw = event.get("raw")
        if isinstance(raw, dict):
            failure_details = raw.get("failure_details") or raw.get("failureDetails")
            if isinstance(failure_details, dict):
                error = failure_details.get("error_message") or failure_details.get(
                    "errorMessage"
                )
                stack_trace = failure_details.get("stack_trace") or failure_details.get(
                    "stackTrace"
                )
                if isinstance(stack_trace, dict):
                    stack_trace = stack_trace.get("value")
                if isinstance(error, str) and error.strip():
                    return (
                        error.strip(),
                        stack_trace.strip()
                        if isinstance(stack_trace, str) and stack_trace.strip()
                        else None,
                    )

    return None, None


# --- Routes ---

class ExecuteSWWorkflowRequest(BaseModel):
    """Request body for executing a CNCF Serverless Workflow 1.0 document."""
    workflow: dict = Field(..., description="CNCF SW 1.0 workflow JSON document")
    workflowId: str | None = None
    triggerData: dict = Field(default_factory=dict)
    integrations: dict | None = None
    dbExecutionId: str | None = None
    traceContext: dict | None = None
    # Resume/fork: skip every top-level node before this one + reuse the source
    # run's /sandbox/work via the stable workspace key. Omitted for normal runs.
    resumeFromNode: str | None = None
    workspaceExecutionId: str | None = None
    # Hermetic fork: seed this run's fresh workspace from the source run's subPath.
    seedWorkspaceFrom: str | None = None


@app.post("/api/v2/sw-workflows", response_model=StartWorkflowResponse)
def execute_sw_workflow(request: ExecuteSWWorkflowRequest, http_request: Request):
    """
    Execute a CNCF Serverless Workflow 1.0 document.

    POST /api/v2/sw-workflows

    Accepts a full SW 1.0 JSON document and executes it via the
    sw_workflow_v1 Dapr workflow interpreter.
    """
    try:
        runtime_ready, runtime_status = _get_workflow_runtime_status(
            timeout_seconds=1.0,
            require_workflow_workers=True,
        )
        if not runtime_ready:
            raise HTTPException(
                status_code=503,
                detail={
                    "code": "workflow_runtime_unavailable",
                    "error": "Dapr workflow runtime is not ready",
                    "operation": "execute_sw_workflow",
                    "runtimeStatus": runtime_status,
                },
            )

        from core.sw_types import Workflow as SWWorkflowModel

        # Validate the workflow document
        sw_workflow_doc = SWWorkflowModel.model_validate(request.workflow)
        workflow_name = sw_workflow_doc.document.name

        db_execution_id = request.dbExecutionId
        if not db_execution_id:
            workflow_id = str(request.workflowId or "").strip()
            if not workflow_id:
                raise HTTPException(
                    status_code=400,
                    detail=(
                        "workflowId is required when dbExecutionId is omitted. "
                        "The workflow orchestrator now requires a persisted "
                        "workflow_executions row for every SW execution."
                    ),
                )

            workflow_record = _fetch_workflow_from_db(workflow_id)
            db_execution_id = _create_workflow_execution(
                workflow_id=workflow_record["id"],
                user_id=workflow_record["userId"],
                trigger_data=request.triggerData,
                project_id=workflow_record.get("projectId"),
            )

        # Each persisted SW workflow execution is its own analysis unit. Use a
        # fresh trace root so concurrent benchmark/eval items are not merged
        # into one trace solely because the start requests shared an HTTP span.
        otel_ctx = _merge_otel_context(http_request, isolate_trace=True)
        request_trace_context = (
            request.traceContext if isinstance(request.traceContext, dict) else {}
        )
        explicit_trace_id = _trace_id_from_traceparent(
            request_trace_context.get("traceparent")
        )
        if explicit_trace_id:
            for key in ("traceparent", "tracestate", "baggage"):
                value = request_trace_context.get(key)
                if isinstance(value, str) and value.strip():
                    otel_ctx[key] = value.strip()
            otel_ctx["traceId"] = explicit_trace_id
        session_id = workflow_session_id(db_execution_id) or extract_session_id(otel_ctx)
        if session_id:
            otel_ctx["sessionId"] = session_id
            otel_ctx["session.id"] = session_id
            otel_ctx["workflow.execution.id"] = session_id
        try:
            from opentelemetry import trace as ot_trace

            attach_workflow_session(ot_trace.get_current_span(), session_id)
        except Exception:
            pass

        workflow_input = {
            "workflow": request.workflow,
            "workflowId": request.workflowId,
            "triggerData": request.triggerData,
            "integrations": request.integrations,
            "dbExecutionId": db_execution_id,
            "resumeFromNode": request.resumeFromNode,
            "workspaceExecutionId": request.workspaceExecutionId,
            "seedWorkspaceFrom": request.seedWorkspaceFrom,
            "features": {},
            "_otel": otel_ctx,
        }

        import re
        safe_name = re.sub(r'[^a-z0-9-]', '-', workflow_name.lower()).strip('-')[:40]
        instance_id = f"sw-{safe_name}-exec-{db_execution_id}"

        logger.info(
            "[SW Workflow] Starting: %s (%s)",
            workflow_name,
            instance_id,
        )

        existing_instance_id = (
            _existing_live_execution_instance(db_execution_id)
            if request.dbExecutionId
            else None
        )
        if existing_instance_id:
            logger.info(
                "[SW Workflow] Execution %s already has live instance %s; returning existing",
                db_execution_id,
                existing_instance_id,
            )
            return StartWorkflowResponse(
                instanceId=existing_instance_id,
                workflowId=workflow_name,
                status="started",
                workflowVersion="1.0.0",
            )

        result_id = _idempotent_schedule(
            workflow_name=SW_WORKFLOW_NAME,
            instance_id=instance_id,
            workflow_input=workflow_input,
            workflow_version="1.0.0",
            parent_trace_context=otel_ctx,
        )

        if db_execution_id:
            _mark_workflow_execution_started(
                db_execution_id,
                result_id,
                otel_ctx.get("traceId"),
            )

        return StartWorkflowResponse(
            instanceId=result_id,
            workflowId=workflow_name,
            status="started",
            workflowVersion="1.0.0",
        )

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"[SW Workflow] Failed to execute: {e}")
        _raise_workflow_route_error("execute_sw_workflow", e)


@app.get("/api/workflows/{instance_id}")
def get_workflow_detail(instance_id: str):
    """
    Get workflow detail (delegates to status endpoint).

    GET /api/workflows/:instanceId
    """
    status = get_workflow_status(instance_id)
    data = status.model_dump() if hasattr(status, "model_dump") else status.dict()
    data["status"] = data.get("runtimeStatus", "UNKNOWN")
    return data


@app.get("/api/v2/workflows", response_model=WorkflowListResponse)
def list_workflows(
    status: str | None = None,
    search: str | None = None,
    limit: int = 50,
    offset: int = 0,
):
    """
    List workflow instances.

    GET /api/v2/workflows
    """
    try:
        normalized_limit = max(1, min(limit, 200))
        normalized_offset = max(0, offset)
        status_filter = {
            part.strip().upper()
            for part in (status or "").split(",")
            if part.strip()
        }
        search_filter = (search or "").strip().lower()
        return _list_workflows_from_taskhub_instance_ids(
            status_filter=status_filter if status_filter else None,
            search_filter=search_filter,
            limit=normalized_limit,
            offset=normalized_offset,
        )
    except Exception as e:
        logger.error(f"[Workflow Routes] Failed to list workflows: {e}")
        _raise_workflow_route_error("list_workflows", e)


@app.get("/api/v2/workflows/{instance_id}/status", response_model=WorkflowStatusResponse)
def get_workflow_status(instance_id: str):
    """
    Get workflow status.

    GET /api/v2/workflows/:instanceId/status
    """
    try:
        workflow_payload = _workflow_http_get_instance(instance_id)
        if workflow_payload is None:
            raise HTTPException(status_code=404, detail="Workflow not found")
        payload = _build_workflow_status_payload_from_http(instance_id, workflow_payload)
        if payload.get("runtimeStatus") == "FAILED" and not payload.get("error"):
            history_error, history_stack_trace = _workflow_failure_details_from_history(
                _get_instance_history(instance_id)
            )
            if history_error:
                payload["error"] = history_error
            if history_stack_trace and not payload.get("stackTrace"):
                payload["stackTrace"] = history_stack_trace
        return WorkflowStatusResponse(**payload)

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"[Workflow Routes] Failed to get workflow status: {e}")
        _raise_workflow_route_error("get_workflow_status", e)


@app.get("/api/v2/workflows/{instance_id}/history", response_model=WorkflowHistoryResponse)
def get_workflow_history(instance_id: str):
    """
    Get workflow execution history.

    GET /api/v2/workflows/:instanceId/history
    """
    try:
        response = _taskhub_call(
            "GetInstance",
            pb.GetInstanceRequest(instanceId=instance_id, getInputsAndOutputs=False),
        )
        if not getattr(response, "exists", False):
            raise HTTPException(status_code=404, detail="Workflow not found")

        events = _get_instance_history(instance_id)
        events.sort(key=lambda item: str(item.get("timestamp") or ""), reverse=True)

        return WorkflowHistoryResponse(
            instanceId=instance_id,
            events=[WorkflowHistoryEventResponse(**event) for event in events],
        )
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"[Workflow Routes] Failed to get workflow history: {e}")
        _raise_workflow_route_error("get_workflow_history", e)


@app.post("/api/v2/workflows/{instance_id}/rerun")
def rerun_workflow(instance_id: str, request: RerunWorkflowRequest = RerunWorkflowRequest()):
    """
    Rerun a workflow from a specific history event.

    POST /api/v2/workflows/:instanceId/rerun
    """
    try:
        state_response = _taskhub_call(
            "GetInstance",
            pb.GetInstanceRequest(instanceId=instance_id, getInputsAndOutputs=False),
        )
        if not getattr(state_response, "exists", False):
            raise HTTPException(status_code=404, detail="Workflow not found")

        event_id = max(0, int(request.fromEventId))
        rerun_request = pb.RerunWorkflowFromEventRequest(
            sourceInstanceID=instance_id,
            eventID=event_id,
        )
        new_instance_id_requested = str(request.newInstanceId or "").strip()
        if new_instance_id_requested:
            rerun_request.newInstanceID = new_instance_id_requested
        if request.overwriteInput:
            rerun_request.overwriteInput = True
            rerun_request.input.CopyFrom(
                wrappers_pb2.StringValue(
                    value=json.dumps(jsonable_encoder(request.input)),
                )
            )
        rerun_response = _taskhub_call("RerunWorkflowFromEvent", rerun_request)
        new_instance_id = str(getattr(rerun_response, "newInstanceID", "") or "")
        if not new_instance_id:
            raise RuntimeError("Rerun succeeded but no newInstanceID was returned")

        logger.info(
            "[Workflow Routes] Rerun scheduled: source=%s event_id=%s new=%s reason=%s",
            instance_id,
            event_id,
            new_instance_id,
            request.reason,
        )

        return {
            "success": True,
            "sourceInstanceId": instance_id,
            "fromEventId": event_id,
            "newInstanceId": new_instance_id,
        }
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"[Workflow Routes] Failed to rerun workflow: {e}")
        _raise_workflow_route_error("rerun_workflow", e)


def _resolve_resume_event(
    events: list[dict[str, Any]], from_node_id: str | None
) -> tuple[int, str]:
    """Map a node id (or auto-failed) to the history eventId to rerun from.

    Thin wrapper over the pure `core.resume_event_resolver` (unit-tested standalone):
    maps its `ResumeEventResolutionError` onto an HTTPException with the same status.
    """
    try:
        return resolve_resume_event(events, from_node_id)
    except ResumeEventResolutionError as exc:
        raise HTTPException(status_code=exc.status_code, detail=exc.detail) from exc


@app.post("/api/v2/workflows/{instance_id}/resume")
def resume_workflow(instance_id: str, request: ResumeWorkflowRequest = ResumeWorkflowRequest()):
    """
    Resume a workflow run from a NODE (node-aware rerun-from-event).

    POST /api/v2/workflows/:instanceId/resume
    """
    try:
        state_response = _taskhub_call(
            "GetInstance",
            pb.GetInstanceRequest(instanceId=instance_id, getInputsAndOutputs=False),
        )
        if not getattr(state_response, "exists", False):
            raise HTTPException(status_code=404, detail="Workflow not found")

        events = _get_instance_history(instance_id)
        event_id, resolved_node_id = _resolve_resume_event(events, request.fromNodeId)

        rerun_request = pb.RerunWorkflowFromEventRequest(
            sourceInstanceID=instance_id,
            eventID=event_id,
        )
        new_instance_id_requested = str(request.newInstanceId or "").strip()
        if new_instance_id_requested:
            rerun_request.newInstanceID = new_instance_id_requested
        # The whole point of resume is to apply the edited spec from the resume node
        # onward, so overwrite the input whenever one is supplied.
        if request.input is not None:
            rerun_request.overwriteInput = True
            rerun_request.input.CopyFrom(
                wrappers_pb2.StringValue(
                    value=json.dumps(jsonable_encoder(request.input)),
                )
            )
        rerun_response = _taskhub_call("RerunWorkflowFromEvent", rerun_request)
        new_instance_id = str(getattr(rerun_response, "newInstanceID", "") or "")
        if not new_instance_id:
            raise RuntimeError("Resume succeeded but no newInstanceID was returned")

        logger.info(
            "[Workflow Routes] Resume scheduled: source=%s node=%s event_id=%s new=%s reason=%s",
            instance_id,
            resolved_node_id,
            event_id,
            new_instance_id,
            request.reason,
        )

        return {
            "success": True,
            "sourceInstanceId": instance_id,
            "fromNodeId": resolved_node_id,
            "fromEventId": event_id,
            "newInstanceId": new_instance_id,
        }
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"[Workflow Routes] Failed to resume workflow: {e}")
        _raise_workflow_route_error("resume_workflow", e)


@app.post("/api/v2/workflows/{instance_id}/events")
def raise_event(instance_id: str, request: RaiseEventRequest):
    """
    Raise an external event to a workflow.

    POST /api/v2/workflows/:instanceId/events
    """
    try:
        client = get_workflow_client()

        event_data = request.eventData if isinstance(request.eventData, dict) else {}
        workflow_id = (
            event_data.get("workflow_id")
            or event_data.get("workflowId")
            or event_data.get("agentWorkflowId")
        )
        if request.eventName.startswith("agent_completed_") and _is_native_agent_child_workflow_id(workflow_id):
            logger.info(
                "[Workflow Routes] Ignoring bridged completion event for native child workflow: %s",
                workflow_id,
            )
            return {
                "success": True,
                "instanceId": instance_id,
                "eventName": request.eventName,
                "ignored": True,
                "reason": "native-child-workflow",
            }

        logger.info(
            f"[Workflow Routes] Raising event \"{request.eventName}\" for workflow: {instance_id}"
        )

        client.raise_workflow_event(
            instance_id=instance_id,
            event_name=request.eventName,
            data=request.eventData,
        )

        return {
            "success": True,
            "instanceId": instance_id,
            "eventName": request.eventName,
        }

    except Exception as e:
        logger.error(f"[Workflow Routes] Failed to raise event: {e}")
        _raise_workflow_route_error("raise_event", e)


@app.post("/api/v2/workflows/{instance_id}/terminate")
def terminate_workflow(instance_id: str, request: TerminateRequest = TerminateRequest()):
    """
    Terminate a running workflow.

    POST /api/v2/workflows/:instanceId/terminate
    """
    try:
        logger.info(
            f"[Workflow Routes] Terminating workflow: {instance_id}"
            + (f" Reason: {request.reason}" if request.reason else "")
        )

        external_child_cleanup = None
        response_metadata = {
            "success": True,
            "instanceId": instance_id,
            "parentTerminationRequested": False,
            "clientTerminationRequested": False,
            "nativeChildCascade": True,
            "childCleanupSkippedReason": (
                "Dapr child workflows are terminated by the native parent-child cascade"
            ),
        }

        try:
            _workflow_http_post(instance_id, "/terminate")
            response_metadata["parentTerminationRequested"] = True
        except REQUESTS_TIMEOUT:
            logger.warning(
                "[Workflow Routes] Terminate request timed out for %s; polling status will confirm closure",
                instance_id,
            )
            response_metadata["parentTerminationRequested"] = True
            response_metadata["terminationStatusUnknown"] = True
        except FileNotFoundError:
            logger.info(
                "[Workflow Routes] Terminate skipped for %s: already gone",
                instance_id,
            )
            response_metadata["alreadyGone"] = True
        except Exception as terminate_err:
            if _is_workflow_terminate_status_unknown_error(terminate_err):
                logger.warning(
                    "[Workflow Routes] Terminate returned a transient workflow error for %s; polling status will confirm closure: %s",
                    instance_id,
                    terminate_err,
                )
                response_metadata["parentTerminationRequested"] = True
                response_metadata["terminationStatusUnknown"] = True
            else:
                raise

        if not response_metadata.get("alreadyGone"):
            try:
                _terminate_workflow_with_timeout(
                    get_workflow_client(),
                    instance_id,
                    _workflow_terminate_client_fallback_timeout_seconds(),
                )
                response_metadata["clientTerminationRequested"] = True
            except TimeoutError:
                logger.warning(
                    "[Workflow Routes] DaprWorkflowClient terminate timed out for %s; polling status will confirm closure",
                    instance_id,
                )
                response_metadata["clientTerminationRequested"] = True
                response_metadata["terminationStatusUnknown"] = True
            except Exception as client_err:
                if _is_workflow_instance_missing_error(client_err):
                    logger.info(
                        "[Workflow Routes] DaprWorkflowClient terminate skipped for %s: already gone",
                        instance_id,
                    )
                    response_metadata["alreadyGone"] = True
                elif _is_workflow_terminate_status_unknown_error(client_err):
                    logger.warning(
                        "[Workflow Routes] DaprWorkflowClient terminate returned a transient workflow error for %s; polling status will confirm closure: %s",
                        instance_id,
                        client_err,
                    )
                    response_metadata["clientTerminationRequested"] = True
                    response_metadata["terminationStatusUnknown"] = True
                else:
                    logger.warning(
                        "[Workflow Routes] DaprWorkflowClient terminate failed for %s after HTTP terminate request: %s",
                        instance_id,
                        client_err,
                    )
                    response_metadata["clientTerminationError"] = str(client_err)

        # Per-session agent-runtime children live under their own app-ids and are
        # terminated/purged explicitly by the BFF lifecycle controller's
        # per-app-id fan-out. The retired terminate_durable_runs_by_parent_execution
        # path (claude-code-agent only) is no longer invoked here; same-task-hub
        # child workflows are still covered by Dapr's native parent-child cascade.
        response_metadata["childTermination"] = external_child_cleanup
        response_metadata["externalChildCleanup"] = external_child_cleanup
        return response_metadata

    except Exception as e:
        logger.error(f"[Workflow Routes] Failed to terminate workflow: {e}")
        _raise_workflow_route_error("terminate_workflow", e)


@app.delete("/api/v2/workflows/{instance_id}")
def purge_workflow(
    instance_id: str,
    force: bool = False,
    recursive: bool = True,
):
    """
    Purge a workflow instance (recursive by default).

    DELETE /api/v2/workflows/:instanceId

    Forwards the recursion + force flags to Dapr: recursion cascades to child
    workflows in the same task hub (disable with recursive=false ->
    non_recursive=true), and force requests purge-force (Dapr 1.17+) so a purge
    can proceed even when the owning worker/sidecar is gone. Per-session
    agent-runtime children live under their own app-ids and are terminated/purged
    explicitly by the BFF lifecycle controller, so this no longer fans out to the
    retired claude-code-agent cleanup path.
    """
    try:
        logger.info(
            "[Workflow Routes] Purging workflow: %s force=%s recursive=%s",
            instance_id,
            force,
            recursive,
        )

        child_cleanup = None
        purge_params: dict[str, str] = {}
        if not recursive:
            purge_params["non_recursive"] = "true"
        if force:
            purge_params["force"] = "true"

        try:
            _workflow_http_post(instance_id, "/purge", purge_params)
        except FileNotFoundError:
            logger.info(
                "[Workflow Routes] Purge skipped for %s: already gone",
                instance_id,
            )
            return {
                "success": True,
                "instanceId": instance_id,
                "force": force,
                "recursive": recursive,
                "alreadyGone": True,
                "isComplete": True,
                "childCleanup": child_cleanup,
            }

        return {
            "success": True,
            "instanceId": instance_id,
            "force": force,
            "recursive": recursive,
            "purgeAccepted": True,
            "isComplete": True,
            "childCleanup": child_cleanup,
        }

    except Exception as e:
        logger.error(f"[Workflow Routes] Failed to purge workflow: {e}")
        _raise_workflow_route_error("purge_workflow", e)


@app.post("/api/v2/workflows/{instance_id}/pause")
def suspend_workflow(instance_id: str):
    """
    Suspend (pause) a running workflow.

    POST /api/v2/workflows/:instanceId/pause
    """
    try:
        client = get_workflow_client()

        logger.info(f"[Workflow Routes] Suspending workflow: {instance_id}")

        client.suspend_workflow(instance_id=instance_id)

        return {
            "success": True,
            "instanceId": instance_id,
        }

    except Exception as e:
        logger.error(f"[Workflow Routes] Failed to suspend workflow: {e}")
        _raise_workflow_route_error("suspend_workflow", e)


@app.post("/api/v2/workflows/{instance_id}/resume")
def resume_workflow(instance_id: str):
    """
    Resume a paused workflow.

    POST /api/v2/workflows/:instanceId/resume
    """
    try:
        client = get_workflow_client()

        logger.info(f"[Workflow Routes] Resuming workflow: {instance_id}")

        client.resume_workflow(instance_id=instance_id)

        return {
            "success": True,
            "instanceId": instance_id,
        }

    except Exception as e:
        logger.error(f"[Workflow Routes] Failed to resume workflow: {e}")
        _raise_workflow_route_error("resume_workflow", e)


# --- Observability Routes ---


class ObservabilityFeedbackRequest(BaseModel):
    """POST /api/v2/observability/feedback body."""

    trace_id: str = Field(..., description="Trace id")
    name: str = Field(default="user_rating")
    value: float | int | str | bool | None = None
    rationale: str | None = None
    source_type: str = Field(
        default="HUMAN",
        description="One of HUMAN, AI_JUDGE, LLM_JUDGE, CODE",
    )
    source_id: str = Field(default="anonymous")
    metadata: dict[str, Any] | None = None
    span_id: str | None = None


@app.post("/api/v2/observability/feedback")
def post_observability_feedback(request: ObservabilityFeedbackRequest):
    """Feedback persistence moved out of the orchestrator runtime."""
    _ = request
    raise HTTPException(
        status_code=410,
        detail={
            "code": "observability_feedback_removed",
            "message": "Trace feedback now belongs behind workflow-data/OpenTelemetry services.",
        },
    )


class ObservabilityJudgeRequest(BaseModel):
    """POST /api/v2/observability/judge body.

    Invokes a provider-neutral OpenAI-compatible LLM gateway against a prompt + model.
    """

    model: str = Field(..., description="LiteLLM-style model spec, e.g. 'anthropic:claude-opus-4-7'")
    prompt: str = Field(..., description="Rubric / instructions for the judge LLM")
    name: str | None = Field(default=None, description="Optional name for the assessment")
    metadata: dict[str, Any] | None = None


@app.post("/api/v2/observability/judge")
def post_observability_judge(request: ObservabilityJudgeRequest):
    """
    Invoke an LLM-as-a-judge against a rubric prompt + model.

    POST /api/v2/observability/judge

    Returns {score, rationale, raw}: score is parsed from the assistant
    response (numeric, or a GOOD/PASS=1.0 / BAD/FAIL=0.0 verdict word);
    raw carries the full gateway response payload for debugging.
    """
    import re as _re
    import urllib.request
    import urllib.error

    gateway_base = (
        os.environ.get("LLM_GATEWAY_BASE_URL")
        or os.environ.get("OPENAI_COMPATIBLE_GATEWAY_BASE_URL")
        or ""
    ).strip().rstrip("/")
    if not gateway_base:
        raise HTTPException(
            status_code=503,
            detail={"code": "llm_gateway_base_url_unset"},
        )

    # The gateway exposes an OpenAI-compatible shim at /v1/chat/completions.
    # The `model` value selects the gateway route. Caller can pass a bare route name OR
    # `provider:/model-id` and we'll extract the route from the suffix.
    route = request.model
    if ":" in route:
        # Strip a provider prefix like `anthropic:/claude-haiku-4-5` —
        # the route name itself doesn't include the colon.
        route = route.split(":", 1)[1].lstrip("/").replace("/", "-")

    rubric = (
        f"{request.prompt.strip()}\n\n"
        "Respond with EXACTLY one verdict on the FIRST line: either GOOD or BAD.\n"
        "Then on the next line, give a 1-2 sentence rationale.\n"
        "Output format:\n"
        "VERDICT: GOOD|BAD\n"
        "RATIONALE: <reason>"
    )
    body = {
        "model": route,
        "messages": [{"role": "user", "content": rubric}],
        "max_tokens": 200,
        "temperature": 0.0,
    }

    try:
        req = urllib.request.Request(
            f"{gateway_base}/v1/chat/completions",
            data=json.dumps(body).encode(),
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=30) as resp:
            raw_text = resp.read().decode()
    except urllib.error.HTTPError as exc:
        body_text = exc.read().decode() if exc.fp else ""
        logger.warning("[observability/judge] gateway HTTPError %s: %s", exc.code, body_text[:300])
        raise HTTPException(
            status_code=502,
            detail={
                "code": "llm_gateway_http_error",
                "status": exc.code,
                "body": body_text[:500],
                "model": request.model,
            },
        )
    except Exception as exc:  # noqa: BLE001
        logger.warning("[observability/judge] gateway request failed: %s", exc)
        raise HTTPException(
            status_code=502,
            detail={"code": "llm_gateway_failed", "error": str(exc), "model": request.model},
        )

    try:
        payload = json.loads(raw_text)
    except json.JSONDecodeError as exc:
        raise HTTPException(
            status_code=502,
            detail={"code": "llm_gateway_invalid_json", "error": str(exc), "body": raw_text[:300]},
        )

    content = ""
    try:
        choice = payload["choices"][0]
        msg = choice.get("message", {})
        content = msg.get("content", "") or ""
    except Exception as exc:  # noqa: BLE001
        logger.debug("[observability/judge] response shape unexpected: %s", exc)

    score: float | None = None
    rationale: str | None = None
    # Look for VERDICT: <verb> on any line; tolerant of leading whitespace.
    m = _re.search(r"VERDICT\s*[:\-]\s*(\w+)", content, flags=_re.I)
    if m:
        verdict = m.group(1).strip().upper()
        score = {"GOOD": 1.0, "PASS": 1.0, "YES": 1.0, "BAD": 0.0, "FAIL": 0.0, "NO": 0.0}.get(verdict)
    if score is None:
        # Fall back to scanning for a bare GOOD/BAD anywhere in content.
        if _re.search(r"\b(good|pass|yes)\b", content, flags=_re.I):
            score = 1.0
        elif _re.search(r"\b(bad|fail|no)\b", content, flags=_re.I):
            score = 0.0
    rm = _re.search(r"RATIONALE\s*[:\-]\s*(.*)", content, flags=_re.I | _re.S)
    if rm:
        rationale = rm.group(1).strip()
    else:
        rationale = content.strip() or None

    return {
        "score": score,
        "rationale": rationale,
        "raw": payload,
    }


class ObservabilityPromptRegisterRequest(BaseModel):
    """POST /api/v2/observability/prompts/register body.

    Retained for compatibility while prompt registry persistence moves to workflow-data.
    """

    name: str = Field(..., description="Prompt name")
    template: str = Field(..., description="The prompt template body")
    commit_message: str | None = None
    tags: dict[str, str] | None = None


@app.post("/api/v2/observability/prompts/register")
def post_observability_prompt_register(request: ObservabilityPromptRegisterRequest):
    """Prompt registry writes no longer happen in the orchestrator process."""
    _ = request
    raise HTTPException(
        status_code=410,
        detail={
            "code": "prompt_registry_removed",
            "message": "Prompt registry writes now belong behind workflow-data services.",
        },
    )


# --- Pub/Sub Subscription Routes ---

@app.post("/subscriptions/agent-events")
def agent_events_subscription(event: CloudEvent):
    """
    Handle agent completion events from pub/sub.

    This endpoint handles legacy or external completion events forwarded over
    Dapr pub/sub. Native OpenShell child workflows complete through
    child-workflow results rather than this callback path.
    """
    logger.info(f"[Subscription] Received agent event: {event.type}")
    event_payload_for_trace = jsonable_encoder(event)
    actual_event_type = event.data.get("type", event.type)
    span_attrs = {
        "messaging.system": "dapr",
        "messaging.destination.name": "workflow.stream",
        "event.type": actual_event_type,
        **io_attributes("input", event_payload_for_trace),
    }
    set_current_span_attrs(span_attrs)
    server_span = _current_otel_span()

    def traced_result(result: dict[str, Any]) -> dict[str, Any]:
        output_attrs = io_attributes("output", result)
        _set_span_attrs(server_span, output_attrs)
        set_current_span_attrs(output_attrs)
        return result

    with start_activity_span(
        "workflow-orchestrator.subscription /subscriptions/agent-events",
        _current_trace_context(),
        span_attrs,
    ):
        return _handle_agent_events_subscription(event, actual_event_type, traced_result)


def _handle_agent_events_subscription(
    event: CloudEvent,
    actual_event_type: str,
    traced_result: Callable[[dict[str, Any]], dict[str, Any]],
) -> dict[str, Any]:
    # Forward agent completion events to parent workflows
    from dapr.ext.workflow import DaprWorkflowClient

    event_data = event.data

    completion_event_types = {"agent_completed", "execution_completed"}
    if actual_event_type not in completion_event_types:
        return traced_result(
            {"status": "SUCCESS", "result": {"status": "ignored", "event_type": actual_event_type}}
        )

    try:
        inner_data = event_data.get("data", {})
        parent_execution_id = inner_data.get("parent_execution_id")

        if not parent_execution_id:
            return traced_result(
                {"status": "SUCCESS", "result": {"status": "ignored", "reason": "no_parent_execution_id"}}
            )

        workflow_id = event_data.get("workflowId", "")
        if "__msagent__" in workflow_id or "__dapr__" in workflow_id:
            return traced_result(
                {
                    "status": "SUCCESS",
                    "result": {
                        "status": "ignored",
                        "reason": "native-child-workflow",
                        "workflowId": workflow_id,
                    },
                }
            )
        external_event_name = f"agent_completed_{workflow_id}"

        event_payload = {
            "workflow_id": workflow_id,
            "phase": inner_data.get("phase", actual_event_type.replace("_completed", "")),
            "success": inner_data.get("success", True),
            "result": inner_data.get("result", {}),
            "error": inner_data.get("error"),
            "timestamp": event_data.get("timestamp"),
        }

        client = DaprWorkflowClient()
        client.raise_workflow_event(
            instance_id=parent_execution_id,
            event_name=external_event_name,
            data=event_payload,
        )

        return traced_result(
            {"status": "SUCCESS", "result": {"status": "forwarded", "event_type": actual_event_type}}
        )
    except Exception as e:
        logger.error(f"[Agent Events] Failed to handle event: {e}")
        return traced_result({"status": "SUCCESS", "result": {"status": "error", "error": str(e)}})


@app.options("/subscriptions/agent-events")
def agent_events_subscription_options():
    """CORS preflight handler for Dapr subscription endpoint."""
    return {}


PUBSUB_NAME = config.PUBSUB_NAME

@app.get("/dapr/subscribe")
def subscribe():
    """
    Declare pub/sub subscriptions for Dapr.

    This endpoint tells Dapr which topics this service subscribes to.
    """
    return [
        {
            "pubsubname": PUBSUB_NAME,
            "topic": "workflow.stream",
            "route": "/subscriptions/agent-events",
            "routes": {
                "rules": [
                    {
                        "match": "event.type == \"agent_completed\"",
                        "path": "/subscriptions/agent-events",
                    },
                    {
                        "match": "event.type == \"execution_completed\"",
                        "path": "/subscriptions/agent-events",
                    },
                ],
                "default": "/subscriptions/agent-events",
            },
        }
    ]


# --- Health Routes ---

@app.get("/healthz")
def health_check():
    """Liveness check endpoint.

    Keep this process-local so transient Dapr scheduler/placement outages remove
    the pod from service through /readyz without forcing a restart loop.
    """
    return {
        "status": "healthy",
        "service": "workflow-orchestrator",
    }


@app.get("/readyz")
def readiness_check():
    """Readiness check endpoint."""
    ready, runtime_status = _get_workflow_runtime_status(
        require_workflow_workers=True,
    )
    if not ready:
        raise HTTPException(
            status_code=503,
            detail={
                "status": "not_ready",
                "service": "workflow-orchestrator",
                "code": "workflow_runtime_unavailable",
                "runtimeStatus": runtime_status,
            },
        )
    return {
        "status": "ready",
        "service": "workflow-orchestrator",
        "runtimeStatus": runtime_status,
    }


@app.get("/config")
def get_config():
    """Get orchestrator configuration."""
    return {
        "service": "workflow-orchestrator",
        "version": "1.0.0",
        "runtime": "python-dapr-workflow",
        "features": [
            "dynamic-workflow",
            "ap-workflow",
            "child-workflows",
            "approval-gates",
            "timers",
            "function-router-integration",
        ],
    }


@app.get("/api/v2/runtime/introspect", response_model=RuntimeRegistrationResponse)
def get_runtime_introspection():
    """Expose workflow runtime registrations and readiness for debug tooling."""
    ready, runtime_status = _get_workflow_runtime_status()
    errors = []
    runtime_errors = runtime_status.get("errors")
    if isinstance(runtime_errors, list):
        errors = [str(item) for item in runtime_errors]

    return RuntimeRegistrationResponse(
        service="workflow-orchestrator",
        version="1.0.0",
        runtime="python-dapr-workflow",
        ready=ready,
        runtimeStatus=runtime_status,
        features=[
            "dynamic-workflow",
            "ap-workflow",
            "child-workflows",
            "approval-gates",
            "timers",
            "function-router-integration",
        ],
        registeredWorkflows=_registered_workflow_descriptors(),
        registeredActivities=[
            {
                "name": fn.__name__,
                "source": "service-introspection",
                "sourceCode": _get_activity_source(fn),
                "doc": _get_activity_doc(fn),
            }
            for fn in _registered_activity_functions()
        ],
        errors=errors,
        additional={
            "config": {
                "swWorkflowVersion": "1.0.0",
                "stateStoreName": config.STATE_STORE_NAME,
                "pubsubName": config.PUBSUB_NAME,
                "daprAgentPyAppId": config.DAPR_AGENT_PY_APP_ID,
                "workspaceRuntimeAppId": config.WORKSPACE_RUNTIME_APP_ID,
            },
        },
    )


@app.get("/api/metadata/actions")
def get_activity_metadata_index():
    """Return normalized activity metadata for the builder catalog."""
    actions = [_activity_metadata_payload(fn) for fn in _registered_activity_functions()]
    actions.sort(key=lambda item: str(item["displayName"]).lower())
    return {
        "service": "workflow-orchestrator",
        "runtime": "python-dapr-workflow",
        "actions": actions,
        "count": len(actions),
    }


@app.get("/api/metadata/actions/{action_id}")
def get_activity_metadata_detail(action_id: str):
    """Return normalized metadata for one activity."""
    for fn in _registered_activity_functions():
        metadata = get_activity_metadata(fn)
        if fn.__name__ == action_id or (metadata and metadata.sw_name == action_id):
            return {
                "service": "workflow-orchestrator",
                "runtime": "python-dapr-workflow",
                "action": _activity_metadata_payload(fn),
            }
    raise HTTPException(status_code=404, detail=f"Action {action_id} not found")


def _invoke_public_activity(action_id: str, payload: dict[str, Any]) -> dict[str, Any]:
    for fn in _registered_activity_functions():
        metadata = get_activity_metadata(fn)
        if fn.__name__ != action_id and (not metadata or metadata.sw_name != action_id):
            continue

        if not metadata or not metadata.public_callable:
            raise HTTPException(
                status_code=403,
                detail=f"Action {action_id} is inspect-only and cannot be invoked",
            )

        input_data: dict[str, Any]
        if (
            isinstance(payload.get("body"), dict)
            and isinstance(payload["body"].get("input"), dict)
        ):
            input_data = payload["body"]["input"]  # type: ignore[index,assignment]
        elif isinstance(payload.get("input"), dict):
            input_data = payload["input"]  # type: ignore[assignment]
        elif isinstance(payload.get("body"), dict):
            input_data = payload["body"]  # type: ignore[assignment]
        else:
            input_data = {
                key: value
                for key, value in payload.items()
                if key not in {"metadata", "actionId", "actionName", "body", "input"}
            }

        started = time.perf_counter()
        try:
            result = fn(None, input_data)
        except Exception as exc:
            logger.exception("[Workflow Orchestrator] Activity %s failed", action_id)
            raise HTTPException(status_code=500, detail=str(exc)) from exc
        duration_ms = int((time.perf_counter() - started) * 1000)

        return {
            "success": True,
            "action": _activity_metadata_payload(fn),
            "data": jsonable_encoder(result),
            "duration_ms": duration_ms,
        }

    raise HTTPException(status_code=404, detail=f"Action {action_id} not found")


@app.post("/api/metadata/actions/{action_id}/invoke")
async def invoke_activity(action_id: str, request: Request):
    """Invoke a public-callable activity directly for safe testing."""
    try:
        payload = await request.json()
    except Exception:
        payload = {}

    if not isinstance(payload, dict):
        raise HTTPException(status_code=400, detail="Request body must be a JSON object")

    return _invoke_public_activity(action_id, payload)


@app.post("/api/metadata/actions/{action_id}/test")
async def test_activity(action_id: str, request: Request):
    """Alias for the safe invoke endpoint used by the builder test UI."""
    return await invoke_activity(action_id, request)


@app.post("/execute")
async def execute_public_activity(request: Request):
    """OpenFunction-style executor for public-callable workflow activities."""
    try:
        payload = await request.json()
    except Exception:
        payload = {}

    if not isinstance(payload, dict):
        raise HTTPException(status_code=400, detail="Request body must be a JSON object")

    raw_step = payload.get("step")
    if not isinstance(raw_step, str) or not raw_step.strip():
        raise HTTPException(status_code=400, detail="step is required")

    action_id = raw_step.strip().split("/")[-1]
    input_payload = payload.get("input")
    if not isinstance(input_payload, dict):
        input_payload = {}

    return _invoke_public_activity(action_id, input_payload)


# Entry point for uvicorn
if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host=HOST, port=PORT)

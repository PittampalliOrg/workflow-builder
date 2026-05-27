from __future__ import annotations

import hashlib
import json
import logging
import os
import pathlib
import re
import threading
import time
from contextlib import asynccontextmanager
from datetime import timedelta
from functools import wraps
from typing import Any
from urllib.parse import quote

import requests
from dapr.ext import workflow as wf
from dapr.ext.workflow import DaprWorkflowClient
from fastapi import FastAPI, HTTPException, Request
from pydantic import BaseModel

from src.concurrency import (
    bounded_swebench_run_concurrency,
    bounded_swebench_evaluation_concurrency,
    instance_start_batch_delay_seconds,
    instance_start_batch_size,
)
from src.content_tracing import content_span, set_current_span_io, set_span_io

try:
    from dapr.ext.workflow import when_all as wf_when_all
except Exception:  # pragma: no cover - depends on dapr-ext-workflow version
    wf_when_all = None

try:
    from dapr.ext.workflow import when_any as wf_when_any
except Exception:  # pragma: no cover - depends on dapr-ext-workflow version
    wf_when_any = None

logger = logging.getLogger("swebench-coordinator")
logging.basicConfig(
    level=os.environ.get("LOG_LEVEL", "INFO").upper(),
    format="%(asctime)s %(levelname)s %(name)s %(message)s",
)

_otel_ready = False


def _env_flag_enabled(name: str) -> bool:
    return os.environ.get(name, "").strip().lower() in {"1", "true", "yes", "on"}


def _otel_disabled_by() -> str | None:
    if _env_flag_enabled("OTEL_SDK_DISABLED"):
        return "OTEL_SDK_DISABLED"
    traces_exporter = os.environ.get("OTEL_TRACES_EXPORTER", "").strip().lower()
    if traces_exporter in {"none", "false", "off", "disabled"}:
        return "OTEL_TRACES_EXPORTER"
    return None


def _otel_trace_endpoint(endpoint: str) -> str:
    trimmed = endpoint.rstrip("/")
    if trimmed.endswith("/v1/traces"):
        return trimmed
    return f"{trimmed}/v1/traces"


def _otel_resource_attributes() -> dict[str, str]:
    attributes: dict[str, str] = {}
    raw = os.environ.get("OTEL_RESOURCE_ATTRIBUTES", "")
    for part in raw.split(","):
        if "=" not in part:
            continue
        key, value = part.split("=", 1)
        key = key.strip()
        value = value.strip()
        if key and value:
            attributes[key] = value
    attributes.setdefault(
        "service.name", os.environ.get("OTEL_SERVICE_NAME", "swebench-coordinator")
    )
    attributes.setdefault("service.namespace", "workflow-builder")
    attributes.setdefault("openinference.project.name", "workflow-builder")
    return attributes


def _init_otel() -> None:
    global _otel_ready
    disabled_by = _otel_disabled_by()
    if disabled_by:
        logger.info("%s disables tracing, skipping OpenTelemetry", disabled_by)
        return
    endpoint = os.environ.get("OTEL_EXPORTER_OTLP_ENDPOINT", "").strip()
    if not endpoint:
        logger.info("OTEL_EXPORTER_OTLP_ENDPOINT not set, skipping tracing")
        return
    try:
        from opentelemetry import trace
        from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter
        from opentelemetry.instrumentation.requests import RequestsInstrumentor
        from opentelemetry.sdk.resources import Resource
        from opentelemetry.sdk.trace import TracerProvider
        from opentelemetry.sdk.trace.export import BatchSpanProcessor

        provider = TracerProvider(resource=Resource.create(_otel_resource_attributes()))
        provider.add_span_processor(
            BatchSpanProcessor(OTLPSpanExporter(endpoint=_otel_trace_endpoint(endpoint)))
        )
        trace.set_tracer_provider(provider)
        RequestsInstrumentor().instrument()
        _otel_ready = True
        logger.info("OpenTelemetry tracing initialized -> %s", endpoint)
    except Exception as exc:
        logger.warning("OpenTelemetry init failed: %s", exc)


_init_otel()

WORKFLOW_BUILDER_URL = os.environ.get(
    "WORKFLOW_BUILDER_URL",
    "http://workflow-builder.workflow-builder.svc.cluster.local:3000",
).rstrip("/")
INTERNAL_API_TOKEN = os.environ.get("INTERNAL_API_TOKEN", "")
INTERNAL_API_SECRET_NAME = os.environ.get(
    "INTERNAL_API_SECRET_NAME",
    "workflow-builder-secrets",
)
INTERNAL_API_SECRET_KEY = os.environ.get(
    "INTERNAL_API_SECRET_KEY",
    "INTERNAL_API_TOKEN",
)
ARTIFACT_ROOT = pathlib.Path(os.environ.get("SWEBENCH_ARTIFACT_ROOT", "/artifacts"))
EVALUATOR_ARTIFACT_MODE = (
    os.environ.get("SWEBENCH_EVALUATOR_ARTIFACT_MODE", "pvc").strip().lower() or "pvc"
)
EVALUATOR_NAMESPACE = os.environ.get("SWEBENCH_EVALUATOR_NAMESPACE", "workflow-builder")
EVALUATOR_IMAGE = os.environ.get(
    "SWEBENCH_EVALUATOR_IMAGE", "ghcr.io/pittampalliorg/swebench-evaluator:latest"
)
SWEBENCH_PIPELINE_NAMESPACE = os.environ.get(
    "SWEBENCH_PIPELINE_NAMESPACE", "workflow-builder"
)
SWEBENCH_PIPELINE_REF = os.environ.get("SWEBENCH_PIPELINE_REF", "swebench-eval")
SWEBENCH_PACKAGE_REF = os.environ.get(
    "SWEBENCH_PACKAGE_REF",
    "git+https://github.com/PittampalliOrg/SWE-bench.git@main",
)
# Forwarded into the evaluator Job so entrypoint.taskrun_execution_spec()
# (running inside that Job) can enroll the eval TaskRun pods into Kueue.
# Cluster-specific, so no baked default — empty disables Kueue gating.
SWEBENCH_TEKTON_KUEUE_QUEUE_NAME = os.environ.get(
    "SWEBENCH_TEKTON_KUEUE_QUEUE_NAME", ""
)
SWEBENCH_TEKTON_KUEUE_PRIORITY_CLASS = os.environ.get(
    "SWEBENCH_TEKTON_KUEUE_PRIORITY_CLASS", ""
)
MLFLOW_TRACKING_URI = os.environ.get("MLFLOW_TRACKING_URI", "").strip()
EVALUATION_RESULTS_EVENT = "swebench.evaluation.results"
EVALUATION_FAILED_EVENT = "swebench.evaluation.failed"
EVALUATION_POLL_SECONDS = int(os.environ.get("SWEBENCH_EVALUATION_POLL_SECONDS", "60"))
PREFLIGHT_POLL_SECONDS = int(os.environ.get("SWEBENCH_PREFLIGHT_POLL_SECONDS", "30"))
PREFLIGHT_TIMEOUT_SECONDS = int(
    os.environ.get("SWEBENCH_PREFLIGHT_TIMEOUT_SECONDS", "14400")
)
LEASE_RETRY_SECONDS = int(os.environ.get("SWEBENCH_LEASE_RETRY_SECONDS", "15"))
RUN_TERMINAL_STATUSES = {"completed", "failed", "cancelled"}
INSTANCE_TERMINAL_STATUSES = {"resolved", "failed", "error", "timeout", "cancelled"}
ACTIVE_EVALUATION_STATUSES = {"queued", "inferencing", "inferred", "evaluating"}
SWEBENCH_COORDINATOR_APP_ID = (
    os.environ.get("APP_ID", "swebench-coordinator").strip()
    or "swebench-coordinator"
)
REGISTERED_COORDINATOR_WORKFLOWS = {
    "swebench_environment_preflight_workflow",
    "swebench_instance_workflow",
    "swebench_evaluation_workflow",
}

DEFAULT_WORKFLOW_GRPC_MAX_MESSAGE_BYTES = 16 * 1024 * 1024
DEFAULT_MAX_CONCURRENT_ORCHESTRATIONS = 128
DEFAULT_MAX_CONCURRENT_ACTIVITIES = 192
DEFAULT_MAX_THREAD_POOL_WORKERS = 64


def _int_env(name: str, default: int, *, minimum: int = 1) -> int:
    try:
        return max(minimum, int(os.environ.get(name, str(default))))
    except (TypeError, ValueError):
        return max(minimum, default)


def _configure_workflow_runtime_grpc_limits(runtime: wf.WorkflowRuntime) -> None:
    max_message_bytes = _int_env(
        "DAPR_WORKFLOW_GRPC_MAX_MESSAGE_BYTES",
        DEFAULT_WORKFLOW_GRPC_MAX_MESSAGE_BYTES,
    )
    worker = getattr(runtime, "_WorkflowRuntime__worker", None)
    if worker is None:
        return
    existing_options = list(getattr(worker, "_channel_options", None) or [])
    merged_options = {
        str(key): value
        for key, value in existing_options
        if isinstance(key, str) and key
    }
    merged_options.setdefault("grpc.max_receive_message_length", max_message_bytes)
    merged_options.setdefault("grpc.max_send_message_length", max_message_bytes)
    setattr(worker, "_channel_options", list(merged_options.items()))


def _new_workflow_runtime() -> wf.WorkflowRuntime:
    kwargs = {
        "maximum_concurrent_orchestration_work_items": _int_env(
            "DAPR_WORKFLOW_MAX_CONCURRENT_ORCHESTRATIONS",
            DEFAULT_MAX_CONCURRENT_ORCHESTRATIONS,
        ),
        "maximum_concurrent_activity_work_items": _int_env(
            "DAPR_WORKFLOW_MAX_CONCURRENT_ACTIVITIES",
            DEFAULT_MAX_CONCURRENT_ACTIVITIES,
        ),
        "maximum_thread_pool_workers": _int_env(
            "DAPR_WORKFLOW_MAX_THREAD_POOL_WORKERS",
            DEFAULT_MAX_THREAD_POOL_WORKERS,
        ),
    }
    try:
        runtime = wf.WorkflowRuntime(**kwargs)
    except TypeError:
        runtime = wf.WorkflowRuntime()
    _configure_workflow_runtime_grpc_limits(runtime)
    return runtime


wfr = _new_workflow_runtime()


EVALUATOR_RESOURCE_PROFILES: dict[str, dict[str, dict[str, dict[str, str]]]] = {
    # The evaluator is a thin PipelineRun dispatcher (no docker-in-docker
    # anymore) — per-instance grading happens in dedicated TaskRun pods. The
    # dispatcher container only needs enough headroom for the kubernetes
    # client + watch loop + a handful of MLflow logs.
    "standard": {
        "evaluator": {
            "requests": {"cpu": "50m", "memory": "128Mi"},
            "limits": {"cpu": "1", "memory": "512Mi"},
        },
    },
    "large": {
        "evaluator": {
            "requests": {"cpu": "100m", "memory": "256Mi"},
            "limits": {"cpu": "1", "memory": "1Gi"},
        },
    },
    "xlarge": {
        "evaluator": {
            "requests": {"cpu": "250m", "memory": "512Mi"},
            "limits": {"cpu": "2", "memory": "2Gi"},
        },
    },
}


class StartRunRequest(BaseModel):
    runId: str


class CancelRunRequest(BaseModel):
    reason: str | None = None
    instanceIds: list[str] | None = None


class EvaluationEventRequest(BaseModel):
    eventType: str
    jobName: str | None = None
    error: str | None = None
    postedAt: str | None = None


def _dump_model(model: Any, *, exclude_none: bool = False) -> dict[str, Any]:
    if hasattr(model, "model_dump"):
        return model.model_dump(exclude_none=exclude_none)
    return model.dict(exclude_none=exclude_none)


def _require_internal(request: Request) -> None:
    token = request.headers.get("x-internal-token") or request.headers.get(
        "authorization", ""
    ).removeprefix("Bearer ")
    if not INTERNAL_API_TOKEN or token != INTERNAL_API_TOKEN:
        raise HTTPException(status_code=401, detail="invalid or missing internal token")


def _bff(
    method: str,
    path: str,
    *,
    json_body: dict[str, Any] | None = None,
    timeout: int = 60,
) -> Any:
    if not INTERNAL_API_TOKEN:
        raise RuntimeError("INTERNAL_API_TOKEN is required")
    with content_span(f"coordinator.bff {method} {path}") as _sp:
        set_span_io(_sp, "input", {"method": method, "path": path, "body": json_body})
        res = requests.request(
            method,
            f"{WORKFLOW_BUILDER_URL}{path}",
            headers={
                "X-Internal-Token": INTERNAL_API_TOKEN,
                "Content-Type": "application/json",
            },
            json=json_body,
            timeout=timeout,
        )
        if res.status_code >= 400:
            set_span_io(_sp, "output", {"status": res.status_code, "error": res.text[:800]})
            raise RuntimeError(
                f"BFF {method} {path} failed ({res.status_code}): {res.text[:800]}"
            )
        result = {} if not res.text else res.json()
        set_span_io(_sp, "output", result)
        return result


def _bff_text(method: str, path: str, *, timeout: int = 60) -> str:
    if not INTERNAL_API_TOKEN:
        raise RuntimeError("INTERNAL_API_TOKEN is required")
    with content_span(f"coordinator.bff {method} {path}") as _sp:
        set_span_io(_sp, "input", {"method": method, "path": path})
        res = requests.request(
            method,
            f"{WORKFLOW_BUILDER_URL}{path}",
            headers={"X-Internal-Token": INTERNAL_API_TOKEN},
            timeout=timeout,
        )
        if res.status_code >= 400:
            set_span_io(_sp, "output", {"status": res.status_code, "error": res.text[:800]})
            raise RuntimeError(
                f"BFF {method} {path} failed ({res.status_code}): {res.text[:800]}"
            )
        set_span_io(_sp, "output", res.text)
        return res.text


def _bff_retry_settings(
    *, attempts: int | None = None, delay_seconds: float | None = None
) -> tuple[int, float]:
    raw_attempts = os.environ.get("SWEBENCH_BFF_MAX_RETRIES", "").strip()
    raw_delay = os.environ.get("SWEBENCH_BFF_RETRY_DELAY_SECONDS", "").strip()
    resolved_attempts = attempts if attempts is not None else 6
    resolved_delay = delay_seconds if delay_seconds is not None else 10.0
    if raw_attempts:
        try:
            resolved_attempts = max(1, min(20, int(raw_attempts)))
        except ValueError:
            pass
    if raw_delay:
        try:
            resolved_delay = max(0.1, min(120.0, float(raw_delay)))
        except ValueError:
            pass
    return resolved_attempts, resolved_delay


def _bff_with_retry(
    method: str,
    path: str,
    *,
    json_body: dict[str, Any] | None = None,
    timeout: int = 60,
    attempts: int | None = None,
    delay_seconds: float | None = None,
) -> Any:
    resolved_attempts, resolved_delay = _bff_retry_settings(
        attempts=attempts, delay_seconds=delay_seconds
    )
    last_error: Exception | None = None
    for attempt in range(1, resolved_attempts + 1):
        try:
            return _bff(method, path, json_body=json_body, timeout=timeout)
        except Exception as exc:
            last_error = exc
            if attempt >= resolved_attempts:
                break
            logger.warning(
                "BFF %s %s failed on attempt %s/%s; retrying in %.1fs: %s",
                method,
                path,
                attempt,
                resolved_attempts,
                resolved_delay,
                exc,
            )
            time.sleep(resolved_delay)
    raise last_error or RuntimeError(f"BFF {method} {path} failed")


def _bff_text_with_retry(
    method: str,
    path: str,
    *,
    timeout: int = 60,
    attempts: int | None = None,
    delay_seconds: float | None = None,
) -> str:
    resolved_attempts, resolved_delay = _bff_retry_settings(
        attempts=attempts, delay_seconds=delay_seconds
    )
    last_error: Exception | None = None
    for attempt in range(1, resolved_attempts + 1):
        try:
            return _bff_text(method, path, timeout=timeout)
        except Exception as exc:
            last_error = exc
            if attempt >= resolved_attempts:
                break
            logger.warning(
                "BFF %s %s failed on attempt %s/%s; retrying in %.1fs: %s",
                method,
                path,
                attempt,
                resolved_attempts,
                resolved_delay,
                exc,
            )
            time.sleep(resolved_delay)
    raise last_error or RuntimeError(f"BFF {method} {path} failed")


def _load_run(run_id: str) -> dict[str, Any]:
    return _bff_with_retry(
        "GET", f"/api/internal/benchmarks/runs/{run_id}/status", timeout=60
    )["run"]


def _compact_run_for_workflow(run: dict[str, Any]) -> dict[str, Any]:
    summary = run.get("summary") if isinstance(run.get("summary"), dict) else {}
    capacity = summary.get("capacity") if isinstance(summary, dict) else None
    compact: dict[str, Any] = {
        "id": run.get("id"),
        "status": run.get("status"),
        "suiteSlug": run.get("suiteSlug"),
        "suiteName": run.get("suiteName"),
        "datasetName": run.get("datasetName"),
        "selectedInstanceIds": run.get("selectedInstanceIds") or [],
        "concurrency": run.get("concurrency"),
        "evaluationConcurrency": run.get("evaluationConcurrency"),
        "timeoutSeconds": run.get("timeoutSeconds"),
        "modelNameOrPath": run.get("modelNameOrPath"),
        "mlflowRunId": run.get("mlflowRunId"),
        "mlflowDatasetId": run.get("mlflowDatasetId"),
        "mlflowEvalRunId": run.get("mlflowEvalRunId"),
        "mlflowTraceExperimentName": run.get("mlflowTraceExperimentName"),
        "mlflowTraceExperimentId": run.get("mlflowTraceExperimentId"),
        "evaluatorResourceClass": run.get("evaluatorResourceClass"),
        "tags": run.get("tags") if isinstance(run.get("tags"), list) else [],
        "summary": {"capacity": capacity} if isinstance(capacity, dict) else {},
    }
    instances = run.get("instances") if isinstance(run.get("instances"), list) else []
    compact["instances"] = [
        _compact_instance_for_workflow(instance, include_preflight_metadata=True)
        for instance in instances
        if isinstance(instance, dict)
    ]
    return compact


def _compact_instance_for_workflow(
    instance: dict[str, Any], *, include_preflight_metadata: bool = False
) -> dict[str, Any]:
    compact = {
        "id": instance.get("id"),
        "instanceId": instance.get("instanceId"),
        "status": instance.get("status"),
        "inferenceStatus": instance.get("inferenceStatus"),
        "evaluationStatus": instance.get("evaluationStatus"),
        "sessionId": instance.get("sessionId"),
        "workflowExecutionId": instance.get("workflowExecutionId"),
        "daprInstanceId": instance.get("daprInstanceId"),
        "mlflowRunId": instance.get("mlflowRunId"),
        "mlflowTraceId": instance.get("mlflowTraceId"),
        "mlflowDatasetId": instance.get("mlflowDatasetId"),
        "mlflowDatasetRecordId": instance.get("mlflowDatasetRecordId"),
        "sandboxName": instance.get("sandboxName"),
        "workspaceRef": instance.get("workspaceRef"),
        "patchBytes": instance.get("patchBytes"),
        "error": instance.get("error"),
        "inferenceError": instance.get("inferenceError"),
        "evaluationError": instance.get("evaluationError"),
    }
    if include_preflight_metadata:
        compact.update(
            {
                "repo": instance.get("repo"),
                "baseCommit": instance.get("baseCommit"),
                "testMetadata": instance.get("testMetadata")
                if isinstance(instance.get("testMetadata"), dict)
                else {},
                "inferenceEnvironment": instance.get("inferenceEnvironment")
                if isinstance(instance.get("inferenceEnvironment"), dict)
                else {},
            }
        )
    return compact


def _compact_bff_response(response: Any) -> dict[str, Any]:
    if not isinstance(response, dict):
        return {"success": True}
    compact: dict[str, Any] = {
        "success": response.get("success", True),
    }
    for key in (
        "runId",
        "status",
        "appliedInstances",
        "executionId",
        "daprInstanceId",
        "skipped",
        "reason",
        "admitted",
        "holderId",
        "retryable",
        "retryAfterSeconds",
        "blockedBy",
        "released",
        "releasedCount",
        "timedOut",
    ):
        if key in response:
            compact[key] = response[key]
    run = response.get("run")
    if isinstance(run, dict):
        compact["run"] = {
            "id": run.get("id"),
            "status": run.get("status"),
            "error": run.get("error"),
        }
    return compact


def _is_retryable_instance_start_error(exc: Exception) -> bool:
    message = str(exc)
    return (
        "BFF POST" in message
        and "/start failed (503)" in message
        and (
            "workflow-orchestrator" in message
            or "workflow_runtime_unavailable" in message
        )
    )


def _orchestrator_not_ready_retry_seconds() -> int:
    raw = os.environ.get("SWEBENCH_ORCHESTRATOR_NOT_READY_RETRY_SECONDS", "").strip()
    if not raw:
        return LEASE_RETRY_SECONDS
    try:
        return max(1, int(raw))
    except ValueError:
        logger.warning(
            "Invalid SWEBENCH_ORCHESTRATOR_NOT_READY_RETRY_SECONDS=%r; using %s",
            raw,
            LEASE_RETRY_SECONDS,
        )
        return LEASE_RETRY_SECONDS


def _load_run_activity(ctx, data: dict[str, Any]) -> dict[str, Any]:
    return _compact_run_for_workflow(_load_run(data["runId"]))


def _activity_with_content_io(fn: Any) -> Any:
    """Enrich durabletask's outer activity span with activity input/output."""

    @wraps(fn)
    def wrapped(*args: Any, **kwargs: Any):
        data = args[1] if len(args) > 1 else kwargs.get("data", kwargs.get("input_data"))
        set_current_span_io("input", data)
        try:
            result = fn(*args, **kwargs)
        except Exception as exc:
            set_current_span_io(
                "output",
                {
                    "error": str(exc),
                    "errorType": exc.__class__.__name__,
                },
            )
            raise
        set_current_span_io("output", result)
        return result

    return wrapped


def _mlflow_enabled() -> bool:
    enabled = os.environ.get("MLFLOW_ENABLED", "").strip().lower()
    if enabled in {"0", "false", "no", "off"}:
        return False
    return bool(MLFLOW_TRACKING_URI)


def _mlflow_artifact_timeout_seconds() -> float:
    raw = os.environ.get("MLFLOW_ARTIFACT_TIMEOUT_SECONDS", "").strip()
    if not raw:
        raw = os.environ.get("MLFLOW_HTTP_REQUEST_TIMEOUT", "10").strip()
    try:
        return max(0.1, min(60.0, float(raw)))
    except ValueError:
        return 10.0


def _mlflow_log_artifact_sync(
    run_id: Any, path: pathlib.Path, artifact_path: str
) -> None:
    import mlflow

    mlflow.set_tracking_uri(MLFLOW_TRACKING_URI)
    with mlflow.start_run(run_id=run_id):
        mlflow.log_artifact(str(path), artifact_path=artifact_path)


def _mlflow_log_artifact(
    run_id: Any,
    path: pathlib.Path,
    artifact_path: str,
    *,
    wait_for_completion: bool = True,
) -> None:
    if (
        not _mlflow_enabled()
        or not isinstance(run_id, str)
        or not run_id
        or not path.exists()
    ):
        return
    timeout_seconds = _mlflow_artifact_timeout_seconds()
    done = threading.Event()
    error: list[BaseException] = []

    def _target() -> None:
        try:
            _mlflow_log_artifact_sync(run_id, path, artifact_path)
        except BaseException as exc:  # noqa: BLE001 - best-effort background upload
            error.append(exc)
        finally:
            done.set()

    thread = threading.Thread(
        target=_target,
        name=f"mlflow-artifact-{path.name}",
        daemon=True,
    )
    thread.start()
    if not wait_for_completion:
        return
    if not done.wait(timeout_seconds):
        logger.warning(
            "Best-effort MLflow artifact log timed out after %.1fs for %s",
            timeout_seconds,
            path,
        )
        return
    if error:
        logger.warning("Best-effort MLflow artifact log failed for %s: %s", path, error[0])



def _mlflow_log_text(
    run_id: Any,
    text: Any,
    file_path: pathlib.Path,
    artifact_path: str,
    *,
    wait_for_completion: bool = True,
) -> None:
    if not _mlflow_enabled() or not isinstance(text, str) or not text:
        return
    file_path.parent.mkdir(parents=True, exist_ok=True)
    file_path.write_text(text, encoding="utf-8")
    _mlflow_log_artifact(
        run_id,
        file_path,
        artifact_path,
        wait_for_completion=wait_for_completion,
    )


def _write_jsonl_preview_artifact(jsonl_path: pathlib.Path) -> pathlib.Path | None:
    if not jsonl_path.exists():
        return None
    rows: list[Any] = []
    try:
        for line in jsonl_path.read_text(encoding="utf-8").splitlines():
            if line.strip():
                rows.append(json.loads(line))
    except Exception as exc:
        logger.warning("Failed to build JSONL preview artifact for %s: %s", jsonl_path, exc)
        return None
    preview_path = jsonl_path.with_suffix(".preview.json")
    preview_path.write_text(json.dumps(rows, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    return preview_path


def _mlflow_instance_run_map(run: dict[str, Any]) -> dict[str, str]:
    out: dict[str, str] = {}
    for instance in run.get("instances") or []:
        if not isinstance(instance, dict):
            continue
        instance_id = instance.get("instanceId")
        mlflow_run_id = instance.get("mlflowRunId")
        if (
            isinstance(instance_id, str)
            and isinstance(mlflow_run_id, str)
            and mlflow_run_id
        ):
            out[instance_id] = mlflow_run_id
    return out


def _mlflow_genai_eval_enabled() -> bool:
    if not _mlflow_enabled():
        return False
    enabled = (
        os.environ.get("SWEBENCH_MLFLOW_GENAI_EVAL_ENABLED", "true")
        .strip()
        .lower()
    )
    return enabled not in {"0", "false", "no", "off"}


def _mlflow_eval_timeout_seconds() -> float:
    raw = os.environ.get("SWEBENCH_MLFLOW_EVAL_TIMEOUT_SECONDS", "180").strip()
    try:
        return max(1.0, min(1800.0, float(raw)))
    except ValueError:
        return 180.0


def _normalize_mlflow_trace_id(value: Any) -> str | None:
    if not isinstance(value, str):
        return None
    raw = value.strip().lower()
    if not raw:
        return None
    match = re.match(r"^00-([a-f0-9]{32})-[a-f0-9]{16}-[a-f0-9]{2}$", raw)
    if match:
        return f"tr-{match.group(1)}"
    trace_hex = raw[3:] if raw.startswith("tr-") else raw
    if re.match(r"^[a-f0-9]{32}$", trace_hex) and trace_hex != "0" * 32:
        return f"tr-{trace_hex}"
    return None


def _mlflow_eval_trace_ids(data: list[dict[str, Any]]) -> list[str]:
    seen: set[str] = set()
    trace_ids: list[str] = []
    for row in data:
        metadata = row.get("metadata") if isinstance(row.get("metadata"), dict) else {}
        outputs = row.get("outputs") if isinstance(row.get("outputs"), dict) else {}
        candidates: list[Any] = [
            metadata.get("mlflow_trace_id"),
            outputs.get("mlflow_trace_id"),
        ]
        if isinstance(outputs.get("trace_ids"), list):
            candidates.extend(outputs["trace_ids"])
        for candidate in candidates:
            trace_id = _normalize_mlflow_trace_id(candidate)
            if trace_id and trace_id not in seen:
                seen.add(trace_id)
                trace_ids.append(trace_id)
    return trace_ids


def _mlflow_eval_trace_row_lookup(
    data: list[dict[str, Any]],
) -> dict[str, dict[str, Any]]:
    rows: dict[str, dict[str, Any]] = {}
    for row in data:
        if not isinstance(row, dict):
            continue
        metadata = row.get("metadata") if isinstance(row.get("metadata"), dict) else {}
        outputs = row.get("outputs") if isinstance(row.get("outputs"), dict) else {}
        candidates: list[Any] = [
            metadata.get("mlflow_trace_id"),
            outputs.get("mlflow_trace_id"),
        ]
        if isinstance(outputs.get("trace_ids"), list):
            candidates.extend(outputs["trace_ids"])
        for candidate in candidates:
            trace_id = _normalize_mlflow_trace_id(candidate)
            if trace_id and trace_id not in rows:
                rows[trace_id] = row
    return rows


def _mlflow_trace_request_id(trace: Any) -> str | None:
    def read(value: Any, key: str) -> Any:
        if isinstance(value, dict):
            return value.get(key)
        get = getattr(value, "get", None)
        if callable(get):
            try:
                return get(key)
            except Exception:
                return None
        return getattr(value, key, None)

    candidates: list[Any] = []
    for key in ("request_id", "trace_id", "trace.request_id"):
        candidates.append(read(trace, key))
    info = read(trace, "info")
    if info is not None:
        for key in ("request_id", "trace_id"):
            candidates.append(read(info, key))
    for candidate in candidates:
        trace_id = _normalize_mlflow_trace_id(candidate)
        if trace_id:
            return trace_id
    return None


def _mlflow_eval_row_for_trace(
    trace: Any,
    row_by_trace_id: dict[str, dict[str, Any]],
    summary: dict[str, Any],
) -> dict[str, Any] | None:
    trace_id = _mlflow_trace_request_id(trace)
    if trace_id and trace_id in row_by_trace_id:
        return row_by_trace_id[trace_id]
    missing = summary.setdefault("missingNativeTraceRowIds", [])
    if isinstance(missing, list):
        missing_id = trace_id or "<unknown>"
        if missing_id not in missing:
            missing.append(missing_id)
    summary["missingNativeTraceRowCount"] = (
        len(missing) if isinstance(missing, list) else 1
    )
    return None


def _mlflow_trace_tag_value(value: Any, max_length: int = 250) -> str:
    text = "" if value is None else str(value)
    return text[:max_length]


def _mlflow_benchmark_comparison_tags(run: dict[str, Any]) -> dict[str, str]:
    raw_tags = run.get("tags") if isinstance(run.get("tags"), list) else []
    normalized: list[str] = []
    seen: set[str] = set()
    out: dict[str, str] = {}
    for item in raw_tags:
        if not isinstance(item, str):
            continue
        tag = item.strip().lower()[:64]
        if not tag or tag in seen:
            continue
        seen.add(tag)
        normalized.append(tag)
        suffix = re.sub(r"[^a-z0-9_.-]+", "_", tag).strip("_")[:80]
        if suffix:
            out[f"workflow_builder.benchmark_tag.{suffix}"] = "true"
    if normalized:
        out["workflow_builder.benchmark_tags"] = ",".join(normalized)
    return out


def _mlflow_link_traces_to_runs(
    client: Any,
    trace_ids: list[str],
    run_ids: list[str],
    summary: dict[str, Any],
    *,
    summary_prefix: str = "linkedEvalTrace",
) -> None:
    normalized_trace_ids: list[str] = []
    seen_trace_ids: set[str] = set()
    for trace_id in trace_ids:
        normalized = _normalize_mlflow_trace_id(trace_id)
        if normalized and normalized not in seen_trace_ids:
            seen_trace_ids.add(normalized)
            normalized_trace_ids.append(normalized)
    normalized_run_ids = [
        str(run_id).strip()
        for run_id in run_ids
        if isinstance(run_id, str) and run_id.strip()
    ]
    if not normalized_trace_ids or not normalized_run_ids:
        return

    linked_run_ids: list[str] = []
    errors: list[str] = []
    for run_id in normalized_run_ids:
        try:
            for start in range(0, len(normalized_trace_ids), 100):
                batch = normalized_trace_ids[start : start + 100]
                try:
                    client.link_traces_to_run(trace_ids=batch, run_id=run_id)
                except Exception:
                    _mlflow_link_traces_to_run_rest(batch, run_id)
            linked_run_ids.append(run_id)
        except Exception as exc:  # noqa: BLE001 - optional MLflow association path
            errors.append(f"{run_id}: {exc}")

    if linked_run_ids:
        existing_run_ids = summary.get(f"{summary_prefix}RunIds")
        all_run_ids = (
            list(existing_run_ids) if isinstance(existing_run_ids, list) else []
        )
        for run_id in linked_run_ids:
            if run_id not in all_run_ids:
                all_run_ids.append(run_id)
        existing_trace_ids = summary.get(f"{summary_prefix}Ids")
        all_trace_ids = (
            list(existing_trace_ids) if isinstance(existing_trace_ids, list) else []
        )
        for trace_id in normalized_trace_ids:
            if trace_id not in all_trace_ids:
                all_trace_ids.append(trace_id)
        summary[f"{summary_prefix}RunIds"] = all_run_ids
        summary[f"{summary_prefix}Ids"] = all_trace_ids
    if errors:
        summary[f"{summary_prefix}Errors"] = errors[:5]


def _mlflow_link_traces_to_run_rest(trace_ids: list[str], run_id: str) -> None:
    tracking_uri = str(MLFLOW_TRACKING_URI or "").rstrip("/")
    if not tracking_uri:
        raise RuntimeError("MLFLOW_TRACKING_URI is not configured")
    response = requests.post(
        f"{tracking_uri}/api/2.0/mlflow/traces/link-to-run",
        json={"trace_ids": trace_ids, "run_id": run_id},
        timeout=10,
    )
    if response.status_code >= 400:
        raise RuntimeError(
            f"MLflow trace link REST failed: HTTP {response.status_code} {response.text[:300]}"
        )


def _mlflow_dataframe_empty(value: Any) -> bool:
    if value is None:
        return True
    empty = getattr(value, "empty", None)
    if isinstance(empty, bool):
        return empty
    try:
        return len(value) == 0
    except Exception:
        return False


def _mlflow_eval_search_experiment_ids(
    mlflow_module: Any,
    parent_experiment_id: str,
    run: dict[str, Any],
    summary: dict[str, Any],
) -> list[str]:
    experiment_ids: list[str] = []

    def add(value: Any) -> None:
        if value is None:
            return
        experiment_id = str(value).strip()
        if experiment_id and experiment_id not in experiment_ids:
            experiment_ids.append(experiment_id)

    add(parent_experiment_id)
    add(run.get("mlflowTraceExperimentId"))

    trace_experiment_name = str(run.get("mlflowTraceExperimentName") or "").strip()
    if trace_experiment_name:
        try:
            experiment = mlflow_module.get_experiment_by_name(trace_experiment_name)
            add(getattr(experiment, "experiment_id", None))
        except Exception as exc:  # noqa: BLE001 - MLflow client differences
            summary["mlflowTraceExperimentLookupError"] = str(exc)

    summary["nativeTraceSearchExperimentIds"] = experiment_ids
    return experiment_ids


def _mlflow_search_traces(
    mlflow_module: Any,
    experiment_ids: list[str],
    filter_string: str,
    *,
    include_spans: bool | None = None,
) -> Any:
    kwargs: dict[str, Any] = {
        "locations": experiment_ids,
        "filter_string": filter_string,
    }
    if include_spans is not None:
        kwargs["include_spans"] = include_spans
    try:
        return mlflow_module.search_traces(**kwargs)
    except TypeError as exc:
        if "locations" not in str(exc):
            raise
        kwargs.pop("locations", None)
        kwargs["experiment_ids"] = experiment_ids
        return mlflow_module.search_traces(**kwargs)


def _search_mlflow_eval_traces(
    mlflow_module: Any,
    experiment_id: str,
    run: dict[str, Any],
    data: list[dict[str, Any]],
    summary: dict[str, Any],
) -> Any | None:
    trace_ids = _mlflow_eval_trace_ids(data)
    summary["nativeTraceIds"] = trace_ids
    if not trace_ids:
        summary["mlflowGenaiEvaluateSkippedReason"] = "missing-native-trace-ids"
        return None

    experiment_ids = _mlflow_eval_search_experiment_ids(
        mlflow_module, experiment_id, run, summary
    )
    if not experiment_ids:
        summary["mlflowGenaiEvaluateSkippedReason"] = "missing-trace-experiment"
        return None

    frames: list[Any] = []
    filters: list[tuple[str, str]] = list(
        (f"{field} = '{trace_id}'", trace_id)
        for trace_id in trace_ids
        for field in ("request_id", "trace.request_id")
    )

    errors: list[str] = []
    found_trace_ids: set[str] = set()
    for filter_string, trace_id in filters:
        if trace_id and trace_id in found_trace_ids:
            continue
        try:
            traces = _mlflow_search_traces(
                mlflow_module,
                experiment_ids,
                filter_string,
                include_spans=True,
            )
        except Exception as exc:  # noqa: BLE001 - search syntax differs by MLflow version
            errors.append(f"{filter_string}: {exc}")
            continue
        if not _mlflow_dataframe_empty(traces):
            frames.append(traces)
            found_trace_ids.add(trace_id)

    if not frames:
        summary["nativeTraceCount"] = 0
        summary["mlflowTraceSearchErrors"] = errors[:5]
        summary["mlflowGenaiEvaluateSkippedReason"] = "native-traces-not-found"
        return None

    summary["nativeTraceCount"] = len(frames)
    if len(frames) == 1:
        return frames[0]
    try:
        import pandas as pd  # type: ignore[import-not-found]

        merged = pd.concat(frames, ignore_index=True)
        if "trace_id" in merged:
            merged = merged.drop_duplicates(subset=["trace_id"])
        return merged
    except Exception:
        return frames[0]


def _mlflow_create_eval_trace_proxies(
    mlflow_module: Any,
    client: Any,
    experiment_id: str,
    parent_run_id: str,
    eval_run_id: str,
    data: list[dict[str, Any]],
    row_by_trace_id: dict[str, dict[str, Any]],
    summary: dict[str, Any],
) -> Any | None:
    source_trace_ids = _mlflow_eval_trace_ids(data)
    if not source_trace_ids:
        return None

    proxy_trace_ids: list[str] = []
    proxy_frames: list[Any] = []
    errors: list[str] = []
    for source_trace_id in source_trace_ids:
        row = row_by_trace_id.get(source_trace_id)
        if row is None:
            continue
        metadata = row.get("metadata") if isinstance(row.get("metadata"), dict) else {}
        outputs = row.get("outputs") if isinstance(row.get("outputs"), dict) else {}
        inputs = row.get("inputs") if isinstance(row.get("inputs"), dict) else {}
        instance_id = str(metadata.get("instance_id") or source_trace_id)
        try:
            root_span = client.start_trace(
                name=f"swebench-eval/{instance_id}",
                span_type="CHAIN",
                inputs={
                    "source_mlflow_trace_id": source_trace_id,
                    "problem": inputs.get("problem_statement") or "",
                    "repo": inputs.get("repo") or "",
                    "base_commit": inputs.get("base_commit") or "",
                },
                attributes={
                    "workflow_builder.source_mlflow_trace_id": source_trace_id,
                    "workflow_builder.benchmark_run_id": metadata.get("run_id") or "",
                    "workflow_builder.run_instance_id": metadata.get("run_instance_id")
                    or "",
                    "workflow_builder.instance_id": instance_id,
                    "workflow_builder.source_mlflow_run_id": metadata.get("mlflow_run_id")
                    or "",
                },
                tags={
                    "workflow_builder.kind": "swebench_eval_trace_proxy",
                    "workflow_builder.source_mlflow_trace_id": _mlflow_trace_tag_value(
                        source_trace_id
                    ),
                    "workflow_builder.benchmark_run_id": _mlflow_trace_tag_value(
                        metadata.get("run_id")
                    ),
                    "workflow_builder.run_instance_id": _mlflow_trace_tag_value(
                        metadata.get("run_instance_id")
                    ),
                    "workflow_builder.instance_id": _mlflow_trace_tag_value(instance_id),
                },
                experiment_id=experiment_id,
            )
            proxy_trace_id = _normalize_mlflow_trace_id(root_span.trace_id)
            if not proxy_trace_id:
                raise RuntimeError("MLflow returned an invalid proxy trace id")
            client.end_trace(
                proxy_trace_id,
                outputs={
                    "source_mlflow_trace_id": source_trace_id,
                    "status": outputs.get("status"),
                    "evaluation_status": outputs.get("evaluation_status"),
                    "patch_present": bool(
                        isinstance(outputs.get("model_patch"), str)
                        and outputs.get("model_patch").strip()
                    ),
                },
                status="OK",
            )
            flush_traces = getattr(mlflow_module, "flush_trace_async_logging", None)
            if callable(flush_traces):
                flush_traces()
            _mlflow_link_traces_to_runs(
                client,
                [proxy_trace_id],
                [eval_run_id, parent_run_id],
                summary,
                summary_prefix="linkedEvalProxyTrace",
            )
            row_by_trace_id[proxy_trace_id] = row
            proxy_trace_ids.append(proxy_trace_id)
            traces = None
            for _attempt in range(5):
                traces = _mlflow_search_traces(
                    mlflow_module,
                    [experiment_id],
                    f"request_id = '{proxy_trace_id}'",
                    include_spans=True,
                )
                if not _mlflow_dataframe_empty(traces):
                    break
                time.sleep(0.5)
            if not _mlflow_dataframe_empty(traces):
                proxy_frames.append(traces)
        except Exception as exc:  # noqa: BLE001 - proxy traces are optional projection
            errors.append(f"{source_trace_id}: {exc}")

    if proxy_trace_ids:
        summary["evalProxyTraceIds"] = proxy_trace_ids
        summary["evalProxyTraceExperimentId"] = experiment_id
    if errors:
        summary["evalProxyTraceErrors"] = errors[:5]
    if not proxy_frames:
        return None
    if len(proxy_frames) == 1:
        return proxy_frames[0]
    try:
        import pandas as pd  # type: ignore[import-not-found]

        merged = pd.concat(proxy_frames, ignore_index=True)
        if "trace_id" in merged:
            merged = merged.drop_duplicates(subset=["trace_id"])
        return merged
    except Exception:
        return proxy_frames[0]


def _read_trace_bundle_from_disk(run_id: str, instance_id: str) -> dict[str, Any] | None:
    path = (
        ARTIFACT_ROOT
        / run_id
        / "traces"
        / _safe_artifact_name(instance_id)
        / "trace-bundle.json"
    )
    if not path.exists():
        return None
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
        return value if isinstance(value, dict) else None
    except Exception as exc:
        logger.warning("Failed to read trace bundle %s: %s", path, exc)
        return None


def _mlflow_eval_input_row(
    run: dict[str, Any], instance: dict[str, Any]
) -> dict[str, Any]:
    instance_id = str(instance.get("instanceId") or instance.get("instance_id") or "")
    test_metadata = instance.get("testMetadata")
    if not isinstance(test_metadata, dict):
        test_metadata = {}
    inference_environment = instance.get("inferenceEnvironment")
    if not isinstance(inference_environment, dict):
        inference_environment = {}
    trace_bundle = _read_trace_bundle_from_disk(str(run.get("id") or ""), instance_id)
    trace_ids = (
        instance.get("traceIds") if isinstance(instance.get("traceIds"), list) else []
    )
    mlflow_trace_id = _normalize_mlflow_trace_id(instance.get("mlflowTraceId"))
    if not mlflow_trace_id:
        for trace_id in trace_ids:
            mlflow_trace_id = _normalize_mlflow_trace_id(trace_id)
            if mlflow_trace_id:
                break
    harness_result = instance.get("harnessResult")
    if not isinstance(harness_result, dict):
        harness_result = {}
    model_patch = instance.get("modelPatch")
    if not isinstance(model_patch, str):
        model_patch = ""
    return {
        "inputs": {
            "problem_statement": instance.get("problemStatement") or "",
            "repo": instance.get("repo") or "",
            "base_commit": instance.get("baseCommit") or "",
            "hints": test_metadata.get("hints_text") or test_metadata.get("hints") or "",
            "environment": inference_environment,
        },
        "outputs": {
            "model_patch": model_patch,
            "status": instance.get("status"),
            "evaluation_status": instance.get("evaluationStatus"),
            "harness_result": harness_result,
            "trace_bundle": trace_bundle,
            "trace_ids": trace_ids,
            "mlflow_trace_id": mlflow_trace_id,
        },
        "expectations": {
            "resolved": instance.get("status") == "resolved",
            "FAIL_TO_PASS": test_metadata.get("FAIL_TO_PASS")
            or test_metadata.get("fail_to_pass")
            or [],
            "PASS_TO_PASS": test_metadata.get("PASS_TO_PASS")
            or test_metadata.get("pass_to_pass")
            or [],
            "has_internal_gold_patch": bool(test_metadata.get("patch")),
        },
        "metadata": {
            "run_id": run.get("id"),
            "run_instance_id": instance.get("id"),
            "instance_id": instance_id,
            "mlflow_trace_id": mlflow_trace_id,
            "mlflow_dataset_id": instance.get("mlflowDatasetId")
            or run.get("mlflowDatasetId"),
            "mlflow_dataset_record_id": instance.get("mlflowDatasetRecordId"),
            "suite": run.get("suiteSlug"),
            "dataset": run.get("datasetName"),
            "agent_id": run.get("agentId"),
            "agent_version": run.get("agentVersion"),
            "agent_runtime": run.get("agentRuntimeAppId"),
            "model": run.get("modelNameOrPath"),
            "benchmark_tags": run.get("tags") if isinstance(run.get("tags"), list) else [],
            "session_id": instance.get("sessionId"),
            "workflow_execution_id": instance.get("workflowExecutionId"),
            "mlflow_run_id": instance.get("mlflowRunId"),
        },
    }


def _patch_files(patch: str) -> list[str]:
    files: list[str] = []
    for match in re.finditer(r"^diff --git a/(.*?) b/(.*?)$", patch, re.MULTILINE):
        files.append(match.group(2))
    return files


def _contains_environment_mutation(text: str) -> bool:
    patterns = [
        r"\bpip\s+install\b",
        r"\bconda\s+(install|env|create)\b",
        r"\bpython\s+setup\.py\s+build_ext\b",
        r"\bgit\s+stash\b",
        r"\bgit\s+reset\b",
        r"\bgit\s+clean\b",
    ]
    return any(re.search(pattern, text, flags=re.IGNORECASE) for pattern in patterns)


def _row_scorer_values(row: dict[str, Any]) -> dict[str, bool]:
    outputs = row.get("outputs") if isinstance(row.get("outputs"), dict) else {}
    patch = (
        outputs.get("model_patch")
        if isinstance(outputs.get("model_patch"), str)
        else ""
    )
    files = _patch_files(patch)
    trace_bundle = (
        outputs.get("trace_bundle")
        if isinstance(outputs.get("trace_bundle"), dict)
        else {}
    )
    required_context = (
        trace_bundle.get("requiredContext")
        if isinstance(trace_bundle.get("requiredContext"), dict)
        else {}
    )
    trace_text = json.dumps(trace_bundle, sort_keys=True) if trace_bundle else ""
    non_impl_patterns = (
        "test/",
        "tests/",
        "testing/",
        "docs/",
        "doc/",
        ".github/",
        "fixtures/",
        "benchmark",
    )
    impl_files = [
        path
        for path in files
        if not path.endswith((".md", ".rst", ".txt", ".yml", ".yaml", ".json"))
        and not path.startswith(non_impl_patterns)
        and "/tests/" not in path
        and "/test/" not in path
        and "/fixtures/" not in path
    ]
    diff_stat_mentions = len(
        re.findall(r"git\s+diff\s+--stat", trace_text, re.IGNORECASE)
    )
    later_validation_mentions = len(
        re.findall(
            r"(pytest|tox|unittest|npm\s+test|mvn\s+test|cargo\s+test)",
            trace_text,
            re.IGNORECASE,
        )
    )
    return {
        "swebench_harness_resolved": outputs.get("status") == "resolved",
        "patch_present_and_well_formed": bool(patch.strip())
        and outputs.get("evaluation_status") != "empty_patch"
        and (not patch.strip().startswith("diff --git") or len(files) > 0),
        "implementation_only_patch": len(impl_files) > 0,
        "no_environment_mutation": not _contains_environment_mutation(patch)
        and not _contains_environment_mutation(trace_text),
        "trace_health": bool(
            required_context.get("rootPresent")
            and required_context.get("statusFinalized")
            and required_context.get("llmToolSpansPresent")
        )
        if required_context
        else bool(outputs.get("trace_ids")),
        "agent_efficiency": len(
            re.findall(
                r"(build_ext|conda|pip\s+install|apt-get|apk\s+add)",
                trace_text,
                re.IGNORECASE,
            )
        )
        <= 3,
        "diff_stop_compliance": not (
            diff_stat_mentions > 0 and later_validation_mentions > 2
        ),
    }


def _summarize_mlflow_eval_rows(data: list[dict[str, Any]]) -> dict[str, Any]:
    scorer_names = [
        "swebench_harness_resolved",
        "patch_present_and_well_formed",
        "implementation_only_patch",
        "no_environment_mutation",
        "trace_health",
        "agent_efficiency",
        "diff_stop_compliance",
    ]
    counts = {name: 0 for name in scorer_names}
    row_scores: list[dict[str, Any]] = []
    for row in data:
        scores = _row_scorer_values(row)
        for name, value in scores.items():
            if value:
                counts[name] += 1
        row_scores.append(
            {
                "instanceId": (row.get("metadata") or {}).get("instance_id")
                if isinstance(row.get("metadata"), dict)
                else None,
                "scores": scores,
            }
        )
    total = len(data)
    return {
        "version": 1,
        "generatedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "rowCount": total,
        "scorers": {
            name: {
                "passing": counts[name],
                "failing": max(0, total - counts[name]),
                "mean": (counts[name] / total) if total else 0,
            }
            for name in scorer_names
        },
        "rows": row_scores,
    }


def _mlflow_genai_evaluate_sync(
    parent_run_id: str,
    run: dict[str, Any],
    data: list[dict[str, Any]],
    summary: dict[str, Any],
) -> str:
    # The coordinator itself runs with OTLP env configured so Dapr workflow logs can
    # forward normally. Post-hoc MLflow eval traces must be written directly to
    # the parent run experiment, otherwise MLflow's OTLP exporter sends proxy
    # traces to the trace experiment and the evaluation run cannot display them.
    os.environ["MLFLOW_ENABLE_OTLP_EXPORTER"] = "false"
    import mlflow
    from mlflow.genai import scorer

    mlflow.set_tracking_uri(MLFLOW_TRACKING_URI)
    client = mlflow.tracking.MlflowClient()
    parent = client.get_run(parent_run_id)
    experiment_id = parent.info.experiment_id
    try:
        mlflow.set_experiment(experiment_id=experiment_id)
    except Exception as exc:  # noqa: BLE001 - start_run still uses explicit experiment_id
        summary["mlflowSetExperimentError"] = str(exc)
    row_by_trace_id = _mlflow_eval_trace_row_lookup(data)
    summary["nativeTraceRowIds"] = sorted(row_by_trace_id.keys())

    def score_row_for_trace(trace: Any, scorer_name: str) -> bool:
        row = _mlflow_eval_row_for_trace(trace, row_by_trace_id, summary)
        if row is None:
            return False
        if scorer_name == "trace_health":
            return True
        return _row_scorer_values(row)[scorer_name]

    @scorer
    def swebench_harness_resolved(outputs=None, trace=None):
        return score_row_for_trace(trace, "swebench_harness_resolved")

    @scorer
    def patch_present_and_well_formed(outputs=None, trace=None):
        return score_row_for_trace(trace, "patch_present_and_well_formed")

    @scorer
    def implementation_only_patch(outputs=None, trace=None):
        return score_row_for_trace(trace, "implementation_only_patch")

    @scorer
    def no_environment_mutation(outputs=None, trace=None):
        return score_row_for_trace(trace, "no_environment_mutation")

    @scorer
    def trace_health(outputs=None, trace=None):
        return score_row_for_trace(trace, "trace_health")

    @scorer
    def agent_efficiency(outputs=None, trace=None):
        return score_row_for_trace(trace, "agent_efficiency")

    @scorer
    def diff_stop_compliance(outputs=None, trace=None):
        return score_row_for_trace(trace, "diff_stop_compliance")

    with mlflow.start_run(
        experiment_id=experiment_id,
        run_name=f"swebench-mlflow-eval/{str(run.get('id') or '')[:12]}",
        tags={
            "mlflow.parentRunId": parent_run_id,
            "workflow_builder.kind": "swebench_mlflow_eval",
            "workflow_builder.benchmark_run_id": str(run.get("id") or ""),
            "swebench.suite": str(run.get("suiteSlug") or ""),
            "agent.id": str(run.get("agentId") or ""),
            "agent.version": str(run.get("agentVersion") or ""),
            "agent.runtime": str(run.get("agentRuntimeAppId") or ""),
            "model.name_or_path": str(run.get("modelNameOrPath") or ""),
            **_mlflow_benchmark_comparison_tags(run),
        },
    ) as eval_run:
        eval_run_id = eval_run.info.run_id
        try:
            eval_data = _search_mlflow_eval_traces(
                mlflow, experiment_id, run, data, summary
            )
            if eval_data is None:
                mlflow.set_tag(
                    "workflow_builder.mlflow_genai_evaluate_skipped_reason",
                    str(summary.get("mlflowGenaiEvaluateSkippedReason") or "no-native-traces"),
                )
            else:
                source_trace_ids = _mlflow_eval_trace_ids(data)
                _mlflow_link_traces_to_runs(
                    client,
                    source_trace_ids,
                    [eval_run_id, parent_run_id],
                    summary,
                    summary_prefix="linkedNativeTrace",
                )
                proxy_eval_data = _mlflow_create_eval_trace_proxies(
                    mlflow,
                    client,
                    experiment_id,
                    parent_run_id,
                    eval_run_id,
                    data,
                    row_by_trace_id,
                    summary,
                )
                if proxy_eval_data is not None:
                    eval_data = proxy_eval_data
                mlflow.genai.evaluate(
                    data=eval_data,
                    scorers=[
                        swebench_harness_resolved,
                        patch_present_and_well_formed,
                        implementation_only_patch,
                        no_environment_mutation,
                        trace_health,
                        agent_efficiency,
                        diff_stop_compliance,
                    ],
                )
        except Exception as exc:
            # Keep the MLflow projection recoverable when the optional GenAI
            # evaluator cannot score a row, for example while traces are still
            # propagating to the tracking store.
            logger.warning("MLflow GenAI evaluation call failed: %s", exc)
            summary["mlflowGenaiEvaluateError"] = str(exc)
            mlflow.set_tag("workflow_builder.mlflow_genai_evaluate_error", str(exc))
        mlflow.log_dict(summary, "swebench/mlflow-eval-summary.json")
        for name, value in summary.get("scorers", {}).items():
            if isinstance(value, dict):
                mlflow.log_metric(f"{name}_mean", float(value.get("mean") or 0))

    with mlflow.start_run(run_id=parent_run_id):
        mlflow.set_tag("workflow_builder.mlflow_eval_run_id", eval_run_id)
        mlflow.log_dict(summary, "swebench/mlflow-eval-summary.json")
        for name, value in summary.get("scorers", {}).items():
            if isinstance(value, dict):
                mlflow.log_metric(
                    f"mlflow_eval_{name}_mean", float(value.get("mean") or 0)
                )
    return eval_run_id


def _run_mlflow_swebench_eval(ctx, data: dict[str, Any]) -> dict[str, Any]:
    run_id = data["runId"]
    if not _mlflow_genai_eval_enabled():
        return {"success": True, "skipped": True, "reason": "mlflow-genai-eval-disabled"}
    try:
        run = _load_run(run_id)
        parent_run_id = run.get("mlflowRunId")
        if not isinstance(parent_run_id, str) or not parent_run_id:
            return {"success": True, "skipped": True, "reason": "missing-parent-mlflow-run"}
        instances = run.get("instances") if isinstance(run.get("instances"), list) else []
        rows = [
            _mlflow_eval_input_row(run, instance)
            for instance in instances
            if isinstance(instance, dict) and instance.get("status") in INSTANCE_TERMINAL_STATUSES
        ]
        if not rows:
            return {"success": True, "skipped": True, "reason": "no-terminal-instances"}

        input_path = ARTIFACT_ROOT / run_id / "mlflow-eval-input.jsonl"
        input_path.parent.mkdir(parents=True, exist_ok=True)
        input_path.write_text(
            "".join(json.dumps(row, sort_keys=True) + "\n" for row in rows),
            encoding="utf-8",
        )
        _mlflow_log_artifact(parent_run_id, input_path, "swebench")

        summary = _summarize_mlflow_eval_rows(rows)
        summary["runId"] = run_id
        summary_path = ARTIFACT_ROOT / run_id / "mlflow-eval-summary.json"
        summary_path.write_text(
            json.dumps(summary, sort_keys=True, indent=2) + "\n",
            encoding="utf-8",
        )
        _mlflow_log_artifact(parent_run_id, summary_path, "swebench")

        result: dict[str, Any] = {}
        done = threading.Event()
        error: list[BaseException] = []

        def _target() -> None:
            try:
                eval_run_id = _mlflow_genai_evaluate_sync(parent_run_id, run, rows, summary)
                summary["mlflowEvalRunId"] = eval_run_id
                result["mlflowEvalRunId"] = eval_run_id
            except BaseException as exc:  # noqa: BLE001 - best-effort projection
                error.append(exc)
            finally:
                done.set()

        thread = threading.Thread(
            target=_target,
            name=f"mlflow-swebench-eval-{run_id}",
            daemon=True,
        )
        thread.start()
        if not done.wait(_mlflow_eval_timeout_seconds()):
            logger.warning(
                "Best-effort MLflow GenAI evaluation timed out for %s", run_id
            )
            return {
                "success": True,
                "skipped": True,
                "reason": "mlflow-genai-eval-timeout",
                "summary": summary,
            }
        if error:
            logger.warning(
                "Best-effort MLflow GenAI evaluation failed for %s: %s",
                run_id,
                error[0],
            )
            return {
                "success": True,
                "skipped": True,
                "reason": "mlflow-genai-eval-failed",
                "error": str(error[0]),
                "summary": summary,
            }
        if result.get("mlflowEvalRunId"):
            summary["mlflowEvalRunId"] = result["mlflowEvalRunId"]
            try:
                _bff_with_retry(
                    "POST",
                    f"/api/internal/benchmarks/runs/{run_id}/mlflow-evaluation",
                    json_body={
                        "mlflowEvalRunId": result["mlflowEvalRunId"],
                        "summary": summary,
                    },
                    timeout=30,
                    attempts=3,
                    delay_seconds=5,
                )
            except Exception as exc:
                logger.warning(
                    "Failed to persist MLflow eval summary for %s: %s", run_id, exc
                )
        return {"success": True, **result, "summary": summary}
    except Exception as exc:
        logger.warning(
            "Best-effort MLflow SWE-bench eval activity failed for %s: %s",
            run_id,
            exc,
        )
        return {
            "success": True,
            "skipped": True,
            "reason": "activity-failed",
            "error": str(exc),
        }


def _child_otel_env(client: Any, run_id: str) -> list[Any]:
    env: list[Any] = []
    for name in (
        "OTEL_EXPORTER_OTLP_ENDPOINT",
        "OTEL_EXPORTER_OTLP_PROTOCOL",
        "OTEL_PROPAGATORS",
        "OTEL_TRACES_EXPORTER",
    ):
        value = os.environ.get(name, "").strip()
        if value:
            env.append(client.V1EnvVar(name=name, value=value))
    resource_attributes = os.environ.get("OTEL_RESOURCE_ATTRIBUTES", "").strip()
    extra_attributes = f"benchmark.run_id={run_id},workflow_builder.benchmark_run_id={run_id}"
    env.append(
        client.V1EnvVar(
            name="OTEL_RESOURCE_ATTRIBUTES",
            value=(
                f"{resource_attributes},{extra_attributes}"
                if resource_attributes
                else extra_attributes
            ),
        )
    )
    return env


def _load_evaluation_progress(ctx, data: dict[str, Any]) -> dict[str, Any]:
    run = _load_run(data["runId"])
    instances = run.get("instances") if isinstance(run.get("instances"), list) else []
    summary = run.get("summary") if isinstance(run.get("summary"), dict) else {}
    capacity = summary.get("capacity") if isinstance(summary, dict) else None
    active_instances = [
        instance
        for instance in instances
        if isinstance(instance, dict)
        and instance.get("status") in ACTIVE_EVALUATION_STATUSES
    ]
    terminal_instances = [
        instance
        for instance in instances
        if isinstance(instance, dict)
        and instance.get("status") in INSTANCE_TERMINAL_STATUSES
    ]
    return {
        "runId": run.get("id") or data["runId"],
        "runStatus": run.get("status"),
        "summary": {"capacity": capacity} if isinstance(capacity, dict) else {},
        "activeEvaluationRows": len(active_instances),
        "activeInstanceIds": [
            instance.get("instanceId")
            for instance in active_instances
            if isinstance(instance.get("instanceId"), str)
        ],
        "terminalEvaluationRows": len(terminal_instances),
        "terminalInstanceIds": [
            instance.get("instanceId")
            for instance in terminal_instances
            if isinstance(instance.get("instanceId"), str)
        ],
        "selectedInstanceIds": run.get("selectedInstanceIds") or [],
    }


def _mark_run_status(ctx, data: dict[str, Any]) -> dict[str, Any]:
    run_id = data["runId"]
    payload = {"status": data["status"]}
    for key in ("error", "evaluatorJobName", "predictionsPath"):
        if data.get(key) is not None:
            payload[key] = data[key]
    return _compact_bff_response(
        _bff_with_retry(
            "POST",
            f"/api/internal/benchmarks/runs/{run_id}/status",
            json_body=payload,
        )
    )


def _status_from_mark_result(result: Any) -> str | None:
    if not isinstance(result, dict):
        return None
    run = result.get("run")
    if isinstance(run, dict) and isinstance(run.get("status"), str):
        return run["status"]
    if isinstance(result.get("status"), str):
        return result["status"]
    return None


def _validate_instance_metadata(ctx, data: dict[str, Any]) -> dict[str, Any]:
    run = _load_run(data["runId"])
    instance_ids = list(run.get("selectedInstanceIds") or [])
    if not instance_ids:
        return {"validated": 0}
    instances = run.get("instances") if isinstance(run.get("instances"), list) else []
    by_instance_id = {
        instance.get("instanceId"): instance
        for instance in instances
        if isinstance(instance, dict) and isinstance(instance.get("instanceId"), str)
    }
    missing = []
    for instance_id in instance_ids:
        instance = by_instance_id.get(instance_id)
        if not isinstance(instance, dict):
            missing.append(instance_id)
            continue
        if (
            not instance.get("repo")
            or not instance.get("baseCommit")
            or not instance.get("problemStatement")
        ):
            missing.append(instance_id)
    if missing:
        raise RuntimeError(
            "SWE-bench metadata must be imported before run start. "
            f"Missing metadata for {len(missing)} instance(s): {', '.join(missing[:20])}"
        )
    return {"validated": len(instance_ids), "dataset": run.get("suiteName")}


def _prepare_instance_environment(ctx, data: dict[str, Any]) -> dict[str, Any]:
    payload = {
        "dataset": "swebench",
        "datasetName": data["datasetName"],
        "suiteSlug": data["suiteSlug"],
        "instanceId": data["instanceId"],
        "repo": data["repo"],
        "baseCommit": data["baseCommit"],
        "testMetadata": data.get("testMetadata") or {},
        "allowBuild": True,
        "forceRefreshLegacyStatic": True,
    }
    return _bff_with_retry(
        "POST",
        "/api/internal/environments/ensure",
        json_body=payload,
        timeout=120,
        attempts=3,
        delay_seconds=10,
    )


def _load_environment_status(ctx, data: dict[str, Any]) -> dict[str, Any]:
    payload = {
        "buildId": data.get("buildId"),
        "envSpecHash": data.get("envSpecHash"),
        "environmentKey": data.get("environmentKey"),
    }
    return _bff(
        "POST",
        "/api/internal/environments/status",
        json_body=payload,
        timeout=120,
    )


def _persist_preflight_results(ctx, data: dict[str, Any]) -> dict[str, Any]:
    run_id = data["runId"]
    response = _bff(
        "POST",
        f"/api/internal/benchmarks/runs/{run_id}/preflight",
        json_body={
            "inferenceEnvironmentsByInstanceId": data[
                "inferenceEnvironmentsByInstanceId"
            ],
            "preflightSummary": data.get("preflightSummary") or {},
            "capacitySnapshot": data.get("capacitySnapshot") or {},
        },
        timeout=120,
    )
    compact = _compact_bff_response(response)
    compact["appliedInstances"] = len(
        data.get("inferenceEnvironmentsByInstanceId") or {}
    )
    return compact


def _check_capacity_gate(ctx, data: dict[str, Any]) -> dict[str, Any]:
    run_id = data["runId"]
    try:
        return _compact_bff_response(
            _bff_with_retry(
                "GET",
                f"/api/internal/benchmarks/runs/{run_id}/capacity-gate",
                timeout=30,
                attempts=2,
                delay_seconds=5,
            )
        )
    except Exception as exc:
        return {
            "admitNewStarts": False,
            "reason": "capacity_gate_unavailable",
            "retryAfterSeconds": LEASE_RETRY_SECONDS,
            "error": str(exc)[:800],
        }


def _acquire_instance_leases(ctx, data: dict[str, Any]) -> dict[str, Any]:
    run_id = data["runId"]
    instance_id = data["instanceId"]
    return _compact_bff_response(
        _bff(
            "POST",
            f"/api/internal/benchmarks/runs/{run_id}/leases",
            json_body={
                "action": "acquire",
                "instanceId": instance_id,
                "phase": "inference",
                "metadata": {"source": "swebench-coordinator"},
            },
            timeout=60,
        )
    )


def _release_instance_leases(ctx, data: dict[str, Any]) -> dict[str, Any]:
    run_id = data["runId"]
    return _compact_bff_response(
        _bff_with_retry(
            "POST",
            f"/api/internal/benchmarks/runs/{run_id}/leases",
            json_body={
                "action": "release",
                "instanceId": data.get("instanceId"),
                "holderId": data.get("holderId"),
                "phase": data.get("phase") or "inference",
                "reason": data.get("reason") or "instance workflow completed",
            },
            timeout=60,
        )
    )


def _release_run_leases(ctx, data: dict[str, Any]) -> dict[str, Any]:
    run_id = data["runId"]
    return _compact_bff_response(
        _bff_with_retry(
            "POST",
            f"/api/internal/benchmarks/runs/{run_id}/leases",
            json_body={
                "action": "release",
                "reason": data.get("reason") or "benchmark phase completed",
            },
            timeout=60,
        )
    )


def _retry_run_terminal_cleanup(ctx, data: dict[str, Any]) -> dict[str, Any]:
    run_id = data["runId"]
    return _compact_bff_response(
        _bff_with_retry(
            "POST",
            f"/api/internal/benchmarks/runs/{run_id}/cleanup",
            json_body={"background": True},
            timeout=30,
            attempts=3,
            delay_seconds=5,
        )
    )


def _start_instance(ctx, data: dict[str, Any]) -> dict[str, Any]:
    run_id = data["runId"]
    instance_id = data["instanceId"]
    try:
        return _compact_bff_response(
            _bff_with_retry(
                "POST",
                f"/api/internal/benchmarks/runs/{run_id}/instances/{instance_id}/start",
                json_body={},
                timeout=90,
                attempts=3,
                delay_seconds=20,
            )
        )
    except Exception as exc:
        if _is_retryable_instance_start_error(exc):
            return {
                "success": False,
                "retryable": True,
                "reason": "workflow_orchestrator_not_ready",
                "retryAfterSeconds": _orchestrator_not_ready_retry_seconds(),
                "error": str(exc)[:800],
            }
        raise


def _admit_and_start_instance(ctx, data: dict[str, Any]) -> dict[str, Any]:
    run_id = data["runId"]
    instance_id = data["instanceId"]
    admission = _acquire_instance_leases(ctx, data)
    if not isinstance(admission, dict) or not admission.get("admitted"):
        return {
            "success": False,
            "instanceId": instance_id,
            "admission": admission,
            "start": None,
        }
    start = _start_instance(ctx, data)
    return {
        "success": True,
        "instanceId": instance_id,
        "admission": admission,
        "start": start,
        "holderId": admission.get("holderId"),
    }


def _sync_instance(ctx, data: dict[str, Any]) -> dict[str, Any]:
    run_id = data["runId"]
    instance_id = data["instanceId"]
    response = _bff_with_retry(
        "POST",
        f"/api/internal/benchmarks/runs/{run_id}/instances/{instance_id}/sync",
        json_body={},
        timeout=90,
    )
    instance = response.get("instance") if isinstance(response, dict) else None
    if isinstance(instance, dict):
        patch = instance.get("modelPatch")
        mlflow_run_id = instance.get("mlflowRunId")
        patch_path = (
            ARTIFACT_ROOT
            / run_id
            / "patches"
            / f"{_safe_artifact_name(instance_id)}.patch"
        )
        _mlflow_log_text(
            mlflow_run_id,
            patch,
            patch_path,
            "patches",
            wait_for_completion=False,
        )
    if isinstance(instance, dict):
        return {"success": True, "instance": _compact_instance_for_workflow(instance)}
    return _compact_bff_response(response)


def _mark_instance_inference_failure(ctx, data: dict[str, Any]) -> dict[str, Any]:
    run_id = data["runId"]
    instance_id = data["instanceId"]
    return _compact_bff_response(
        _bff_with_retry(
            "POST",
            f"/api/internal/benchmarks/runs/{run_id}/instances/{instance_id}/inference-failure",
            json_body={
                "status": data.get("status") or "error",
                "error": data.get("error") or "Inference failed before patch extraction",
            },
            timeout=60,
        )
    )


def _write_predictions(ctx, data: dict[str, Any]) -> dict[str, Any]:
    run = _load_run(data["runId"])
    path = ARTIFACT_ROOT / run["id"] / "predictions.jsonl"
    path.parent.mkdir(parents=True, exist_ok=True)
    model_name = run["modelNameOrPath"]
    with path.open("w", encoding="utf-8") as f:
        for instance in run.get("instances") or []:
            f.write(
                json.dumps(
                    {
                        "instance_id": instance["instanceId"],
                        "model_name_or_path": model_name,
                        "model_patch": instance.get("modelPatch") or "",
                    }
                )
                + "\n"
            )
    if _object_artifact_mode():
        _put_bff_artifact(
            run["id"],
            "predictions.jsonl",
            path.read_bytes(),
            kind="predictions_jsonl",
            content_type="application/jsonl; charset=utf-8",
        )
        _bff_with_retry(
            "POST",
            f"/api/internal/benchmarks/runs/{run['id']}/status",
            json_body={
                "status": run.get("status") or "inferencing",
                "predictionsPath": str(path),
            },
        )
    else:
        _bff_with_retry(
            "POST",
            f"/api/internal/benchmarks/runs/{run['id']}/predictions-artifact",
            json_body={"path": str(path)},
        )
    _mlflow_log_artifact(run.get("mlflowRunId"), path, "swebench")
    preview_path = _write_jsonl_preview_artifact(path)
    if preview_path is not None:
        _mlflow_log_artifact(run.get("mlflowRunId"), preview_path, "swebench")
    return {
        "path": str(path),
        "artifactPath": "predictions.jsonl",
        "bytes": path.stat().st_size,
    }


def _write_evaluation_dataset(ctx, data: dict[str, Any]) -> dict[str, Any]:
    run_id = data["runId"]
    path = ARTIFACT_ROOT / run_id / "dataset.jsonl"
    path.parent.mkdir(parents=True, exist_ok=True)
    jsonl = _bff_text_with_retry(
        "GET",
        f"/api/internal/benchmarks/runs/{run_id}/dataset.jsonl",
        timeout=120,
    )
    path.write_text(jsonl, encoding="utf-8")
    if _object_artifact_mode():
        _put_bff_artifact(
            run_id,
            "dataset.jsonl",
            path.read_bytes(),
            kind="dataset_jsonl",
            content_type="application/jsonl; charset=utf-8",
        )
    else:
        _bff_with_retry(
            "POST",
            f"/api/internal/benchmarks/runs/{run_id}/dataset-artifact",
            json_body={"path": str(path)},
        )
    if _mlflow_enabled():
        try:
            refreshed_run = _load_run(run_id)
            _mlflow_log_artifact(refreshed_run.get("mlflowRunId"), path, "swebench")
        except Exception as exc:
            logger.warning(
                "Best-effort MLflow dataset artifact lookup failed for %s: %s",
                run_id,
                exc,
            )
    preview_path = _write_jsonl_preview_artifact(path)
    if preview_path is not None and _mlflow_enabled():
        try:
            refreshed_run = _load_run(run_id)
            _mlflow_log_artifact(refreshed_run.get("mlflowRunId"), preview_path, "swebench")
        except Exception as exc:
            logger.warning(
                "Best-effort MLflow dataset preview artifact lookup failed for %s: %s",
                run_id,
                exc,
            )
    return {
        "path": str(path),
        "artifactPath": "dataset.jsonl",
        "bytes": path.stat().st_size,
    }


def _object_artifact_mode() -> bool:
    return EVALUATOR_ARTIFACT_MODE in {"object", "object-api", "api", "blob"}


def _put_bff_artifact(
    run_id: str,
    artifact_path: str,
    body: bytes,
    *,
    kind: str | None = None,
    instance_id: str | None = None,
    content_type: str = "application/octet-stream",
) -> dict[str, Any]:
    encoded_path = quote(artifact_path.strip("/"), safe="/")
    headers = {
        "X-Internal-Token": INTERNAL_API_TOKEN,
        "Content-Type": content_type,
    }
    if kind:
        headers["X-Benchmark-Artifact-Kind"] = kind
    if instance_id:
        headers["X-Benchmark-Instance-Id"] = instance_id
    response = requests.put(
        f"{WORKFLOW_BUILDER_URL}/api/internal/benchmarks/runs/{run_id}/artifacts/{encoded_path}",
        headers=headers,
        data=body,
        timeout=120,
    )
    response.raise_for_status()
    try:
        return response.json()
    except Exception:
        return {"success": True}


def _evaluation_max_parallel(run: dict[str, Any]) -> int:
    capacity = _capacity_snapshot(run)
    return bounded_swebench_evaluation_concurrency(
        run.get("evaluationConcurrency")
        or capacity.get("effectiveEvaluationConcurrency")
        or os.environ.get("SWEBENCH_EVAL_MAX_PARALLEL")
        or os.environ.get("SWEBENCH_MAX_WORKERS")
    )


def _requested_evaluation_max_parallel(run: dict[str, Any]) -> int:
    capacity = _capacity_snapshot(run)
    return bounded_swebench_evaluation_concurrency(
        capacity.get("requestedEvaluationConcurrency")
        or run.get("evaluationConcurrency")
        or os.environ.get("SWEBENCH_EVAL_MAX_PARALLEL")
        or os.environ.get("SWEBENCH_MAX_WORKERS")
    )


def _evaluation_batch_count(
    *, instance_count: int, evaluation_max_parallel: int
) -> int:
    if instance_count <= 0:
        return 1
    return max(
        1, (instance_count + evaluation_max_parallel - 1) // evaluation_max_parallel
    )


def _evaluation_deadline_seconds(
    *,
    instance_count: int,
    evaluation_max_parallel: int,
    timeout_seconds: int,
) -> int:
    batch_count = _evaluation_batch_count(
        instance_count=instance_count,
        evaluation_max_parallel=evaluation_max_parallel,
    )
    # The dispatcher now launches run-instance TaskRuns in bounded batches.
    # The per-instance timeout still applies inside each TaskRun, so the Job
    # and workflow deadline must cover the worst-case number of batches.
    return max(600, (timeout_seconds + 600) * batch_count + 600)


def _ensure_evaluator_job(ctx, data: dict[str, Any]) -> dict[str, Any]:
    run = _load_run(data["runId"])
    predictions_path = data["predictionsPath"]
    dataset_path = data.get("datasetPath")
    if not isinstance(dataset_path, str) or not dataset_path.strip():
        raise RuntimeError("datasetPath is required for DB-backed SWE-bench evaluation")
    job_name = _evaluator_job_name(run["id"])
    if run.get("status") in RUN_TERMINAL_STATUSES:
        logger.info(
            "Skipping evaluator job %s because run %s is already %s",
            job_name,
            run["id"],
            run.get("status"),
        )
        return {
            "jobName": job_name,
            "skipped": True,
            "reason": "run-terminal",
            "runStatus": run.get("status"),
        }
    instance_ids = run.get("selectedInstanceIds") or []
    resource_profile = _evaluator_resource_profile(run.get("evaluatorResourceClass"))
    evaluation_timeout_seconds = max(60, int(run.get("timeoutSeconds") or 7200))
    evaluation_max_parallel = _evaluation_max_parallel(run)
    requested_evaluation_max_parallel = _requested_evaluation_max_parallel(run)
    evaluation_capacity = _capacity_snapshot(run).get("evaluatorCapacity") or {}
    evaluation_capacity_reason = _capacity_snapshot(run).get("evaluationConcurrencyReason")
    job_deadline_seconds = _evaluation_deadline_seconds(
        instance_count=len(instance_ids),
        evaluation_max_parallel=evaluation_max_parallel,
        timeout_seconds=evaluation_timeout_seconds,
    )
    logger.info(
        "SWE-bench evaluator concurrency for run %s: requested=%s effective=%s reason=%s",
        run["id"],
        requested_evaluation_max_parallel,
        evaluation_max_parallel,
        evaluation_capacity_reason or "none",
    )
    instance_image_map = _instance_image_map_for_run(run, instance_ids)
    # Stamp the Kueue evaluator-Job intent for the Service Graph drawer.
    set_current_span_io(
        "input",
        {
            "runId": run["id"],
            "jobName": job_name,
            "instanceCount": len(instance_ids),
            "instanceIds": instance_ids,
            "resourceProfile": resource_profile,
            "predictionsPath": predictions_path,
            "datasetPath": dataset_path,
            "evaluationMaxParallel": evaluation_max_parallel,
            "requestedEvaluationMaxParallel": requested_evaluation_max_parallel,
            "evaluationConcurrencyReason": evaluation_capacity_reason,
            "evaluationCapacity": evaluation_capacity,
            "jobDeadlineSeconds": job_deadline_seconds,
            "kueueQueueName": os.environ.get("SWEBENCH_TEKTON_KUEUE_QUEUE_NAME"),
        },
    )
    try:
        from kubernetes.client.rest import ApiException

        client, batch, _core = _load_kubernetes_clients()
        env = [
            client.V1EnvVar(name="DATASET_NAME", value=dataset_path),
            client.V1EnvVar(name="DATASET_SPLIT", value="test"),
            client.V1EnvVar(name="PREDICTIONS_PATH", value=predictions_path),
            client.V1EnvVar(name="RUN_ID", value=run["id"]),
            client.V1EnvVar(name="INSTANCE_IDS", value=" ".join(instance_ids)),
            client.V1EnvVar(
                name="INSTANCE_IMAGE_MAP_JSON",
                value=json.dumps(instance_image_map, sort_keys=True),
            ),
            client.V1EnvVar(name="WORKFLOW_BUILDER_URL", value=WORKFLOW_BUILDER_URL),
            client.V1EnvVar(
                name="MLFLOW_ENABLED", value=os.environ.get("MLFLOW_ENABLED", "true")
            ),
            client.V1EnvVar(name="MLFLOW_TRACKING_URI", value=MLFLOW_TRACKING_URI),
            client.V1EnvVar(
                name="MLFLOW_HTTP_REQUEST_TIMEOUT",
                value=os.environ.get("MLFLOW_HTTP_REQUEST_TIMEOUT", "10"),
            ),
            client.V1EnvVar(
                name="MLFLOW_RUN_ID", value=str(run.get("mlflowRunId") or "")
            ),
            client.V1EnvVar(name="SWEBENCH_EVALUATOR_IMAGE", value=EVALUATOR_IMAGE),
            client.V1EnvVar(name="SWEBENCH_EVALUATOR_TASK_IMAGE", value=EVALUATOR_IMAGE),
            client.V1EnvVar(
                name="MLFLOW_INSTANCE_RUNS_JSON",
                value=json.dumps(_mlflow_instance_run_map(run), sort_keys=True),
            ),
            *_child_otel_env(client, run["id"]),
            client.V1EnvVar(
                name="INTERNAL_API_TOKEN",
                value_from=client.V1EnvVarSource(
                    secret_key_ref=client.V1SecretKeySelector(
                        name=INTERNAL_API_SECRET_NAME,
                        key=INTERNAL_API_SECRET_KEY,
                    ),
                ),
            ),
            client.V1EnvVar(name="SWEBENCH_EVALUATOR_JOB_NAME", value=job_name),
            client.V1EnvVar(
                name="SWEBENCH_PIPELINE_NAMESPACE", value=SWEBENCH_PIPELINE_NAMESPACE
            ),
            client.V1EnvVar(name="SWEBENCH_PIPELINE_REF", value=SWEBENCH_PIPELINE_REF),
            client.V1EnvVar(name="SWEBENCH_PACKAGE_REF", value=SWEBENCH_PACKAGE_REF),
            client.V1EnvVar(
                name="SWEBENCH_TEKTON_KUEUE_QUEUE_NAME",
                value=SWEBENCH_TEKTON_KUEUE_QUEUE_NAME,
            ),
            client.V1EnvVar(
                name="SWEBENCH_TEKTON_KUEUE_PRIORITY_CLASS",
                value=SWEBENCH_TEKTON_KUEUE_PRIORITY_CLASS,
            ),
            client.V1EnvVar(
                name="SWEBENCH_EVALUATION_TIMEOUT_SECONDS",
                value=str(evaluation_timeout_seconds),
            ),
            client.V1EnvVar(
                name="SWEBENCH_EVAL_MAX_PARALLEL",
                value=str(evaluation_max_parallel),
            ),
            client.V1EnvVar(
                name="SWEBENCH_EVAL_REQUESTED_MAX_PARALLEL",
                value=str(requested_evaluation_max_parallel),
            ),
            client.V1EnvVar(
                name="SWEBENCH_EVAL_CAPACITY_REASON",
                value=str(evaluation_capacity_reason or ""),
            ),
            client.V1EnvVar(
                name="SWEBENCH_EVALUATOR_ARTIFACT_MODE",
                value=EVALUATOR_ARTIFACT_MODE,
            ),
        ]
        container = client.V1Container(
            name="evaluator",
            image=EVALUATOR_IMAGE,
            env=env,
            resources=client.V1ResourceRequirements(
                requests=resource_profile["evaluator"]["requests"],
                limits=resource_profile["evaluator"]["limits"],
            ),
        )
        volumes = None
        if not _object_artifact_mode():
            container.volume_mounts = [
                client.V1VolumeMount(name="artifacts", mount_path=str(ARTIFACT_ROOT)),
            ]
            volumes = [
                client.V1Volume(
                    name="artifacts",
                    persistent_volume_claim=client.V1PersistentVolumeClaimVolumeSource(
                        claim_name=os.environ.get(
                            "SWEBENCH_ARTIFACTS_PVC", "swebench-artifacts"
                        )
                    ),
                ),
            ]
        run_id_label = _safe_label_value(run["id"])
        pod = client.V1PodTemplateSpec(
            metadata=client.V1ObjectMeta(
                labels={"app": "swebench-evaluator", "benchmark-run-id": run_id_label}
            ),
            spec=client.V1PodSpec(
                restart_policy="Never",
                service_account_name="swebench-coordinator",
                image_pull_secrets=[
                    client.V1LocalObjectReference(name="ghcr-pull-credentials")
                ],
                containers=[container],
                volumes=volumes,
            ),
        )
        job = client.V1Job(
            metadata=client.V1ObjectMeta(
                name=job_name,
                labels={"app": "swebench-evaluator", "benchmark-run-id": run_id_label},
            ),
            spec=client.V1JobSpec(
                active_deadline_seconds=job_deadline_seconds,
                backoff_limit=0,
                template=pod,
                ttl_seconds_after_finished=3600,
            ),
        )
        already_exists = False
        try:
            batch.create_namespaced_job(namespace=EVALUATOR_NAMESPACE, body=job)
        except ApiException as exc:
            if getattr(exc, "status", None) != 409:
                raise
            already_exists = True
            logger.info(
                "Evaluator job %s already exists; treating ensure as success", job_name
            )
        marked = _mark_run_status(
            ctx,
            {"runId": run["id"], "status": "evaluating", "evaluatorJobName": job_name},
        )
        marked_status = _status_from_mark_result(marked)
        if marked_status and marked_status != "evaluating":
            if marked_status in RUN_TERMINAL_STATUSES:
                delete_result = _delete_evaluator_job(
                    ctx, {"runId": run["id"], "jobName": job_name}
                )
                logger.info(
                    "Deleted evaluator job %s after run %s remained terminal (%s): %s",
                    job_name,
                    run["id"],
                    marked_status,
                    delete_result,
                )
                return {
                    "jobName": job_name,
                    "skipped": True,
                    "reason": "run-terminal-after-job-create",
                    "runStatus": marked_status,
                    "deleteResult": delete_result,
                    "alreadyExists": already_exists,
                }
            raise RuntimeError(
                f"mark evaluating returned unexpected run status {marked_status}"
            )
        return {
            "jobName": job_name,
            "alreadyExists": already_exists,
            "evaluationMaxParallel": evaluation_max_parallel,
            "activeDeadlineSeconds": job_deadline_seconds,
        }
    except Exception as exc:
        raise RuntimeError(f"failed to ensure evaluator job: {exc}") from exc


def _get_evaluator_job_status(ctx, data: dict[str, Any]) -> dict[str, Any]:
    run_id = data["runId"]
    job_name = data.get("jobName") or _evaluator_job_name(run_id)
    try:
        from kubernetes.client.rest import ApiException

        _client, batch, core = _load_kubernetes_clients()
        try:
            job = batch.read_namespaced_job_status(
                name=job_name, namespace=EVALUATOR_NAMESPACE
            )
        except ApiException as exc:
            if getattr(exc, "status", None) == 404:
                return {"jobName": job_name, "exists": False, "notFound": True}
            raise
        status = job.status
        conditions = status.conditions or []
        complete_condition = _job_condition(conditions, "Complete")
        failed_condition = _job_condition(conditions, "Failed")
        pod_phases: dict[str, int] = {}
        try:
            pods = core.list_namespaced_pod(
                namespace=EVALUATOR_NAMESPACE,
                label_selector=f"job-name={job_name}",
            )
            for pod in pods.items:
                phase = str(getattr(pod.status, "phase", None) or "Unknown")
                pod_phases[phase] = pod_phases.get(phase, 0) + 1
        except Exception as pod_exc:
            logger.warning(
                "Failed to list evaluator pods for %s: %s", job_name, pod_exc
            )
        return {
            "jobName": job_name,
            "exists": True,
            "active": int(status.active or 0),
            "succeededCount": int(status.succeeded or 0),
            "failedCount": int(status.failed or 0),
            "succeeded": bool(complete_condition or (status.succeeded or 0) > 0),
            "failed": bool(failed_condition),
            "reason": _condition_field(failed_condition, "reason"),
            "message": _condition_field(failed_condition, "message"),
            "podPhases": pod_phases,
        }
    except Exception as exc:
        logger.warning("Failed to inspect evaluator job %s: %s", job_name, exc)
        return {"jobName": job_name, "exists": None, "unknown": True, "error": str(exc)}


def _mark_evaluation_timeout(ctx, data: dict[str, Any]) -> dict[str, Any]:
    run_id = data["runId"]
    progress = _load_evaluation_progress(ctx, {"runId": run_id})
    active_instance_ids = progress.get("activeInstanceIds") or []
    if not active_instance_ids:
        return {"success": True, "timedOut": 0, "progress": progress}
    message = (
        data.get("error")
        or "SWE-bench evaluation timed out before all active rows completed"
    )
    results = [
        {
            "instance_id": instance_id,
            "resolved": False,
            "status": "timeout",
            "error": message,
            "harness_result": {
                "timeout": True,
                "message": message,
                "source": "swebench_evaluation_workflow",
                "jobName": data.get("jobName"),
            },
        }
        for instance_id in active_instance_ids
    ]
    response = _bff(
        "POST",
        f"/api/internal/benchmarks/runs/{run_id}/evaluation-results",
        json_body={"results": results, "error": message},
        timeout=90,
    )
    return {
        "success": True,
        "timedOut": len(results),
        "response": _compact_bff_response(response),
    }


def _mark_evaluation_failure(ctx, data: dict[str, Any]) -> dict[str, Any]:
    run_id = data["runId"]
    progress = _load_evaluation_progress(ctx, {"runId": run_id})
    if progress.get("runStatus") in RUN_TERMINAL_STATUSES:
        return {
            "success": True,
            "skipped": True,
            "reason": "run-terminal",
            "progress": progress,
        }
    if int(progress.get("terminalEvaluationRows") or 0) > 0:
        return {
            "success": True,
            "skipped": True,
            "reason": "partial-terminal-results",
            "progress": progress,
        }
    message = (
        data.get("error")
        or "SWE-bench evaluator job failed before any terminal results were persisted"
    )
    run = _mark_run_status(ctx, {"runId": run_id, "status": "failed", "error": message})
    return {"success": True, "failed": True, "run": run, "progress": progress}


def _delete_evaluator_job(ctx, data: dict[str, Any]) -> dict[str, Any]:
    run_id = data["runId"]
    job_name = data.get("jobName") or _evaluator_job_name(run_id)
    try:
        from kubernetes.client.rest import ApiException

        _client, batch, _core = _load_kubernetes_clients()
        try:
            batch.delete_namespaced_job(
                name=job_name,
                namespace=EVALUATOR_NAMESPACE,
                propagation_policy="Background",
            )
        except ApiException as exc:
            if getattr(exc, "status", None) == 404:
                return {
                    "success": True,
                    "jobName": job_name,
                    "deleted": False,
                    "notFound": True,
                }
            raise
        return {"success": True, "jobName": job_name, "deleted": True}
    except Exception as exc:
        logger.warning(
            "Best-effort evaluator job delete failed for %s: %s", job_name, exc
        )
        return {"success": False, "jobName": job_name, "error": str(exc)}


def _evaluator_resource_profile(
    resource_class: Any,
) -> dict[str, dict[str, dict[str, str]]]:
    key = str(resource_class or "standard").strip().lower()
    return EVALUATOR_RESOURCE_PROFILES.get(key, EVALUATOR_RESOURCE_PROFILES["standard"])


def _evaluator_workflow_id(run_id: str) -> str:
    return f"swebench-eval-{run_id}"


def _run_workflow_id(run_id: str) -> str:
    return f"swebench-run-{run_id}"


def _child_instance_workflow_id(run_id: str, instance_id: str) -> str:
    return _hash_suffixed_name("swebench-inst-", [run_id, instance_id], max_length=100)


def _cancel_child_instance_workflows(
    client: DaprWorkflowClient,
    run_id: str,
    reason: str,
    instance_ids: list[str] | None = None,
) -> dict[str, Any]:
    selected_ids = [
        value.strip()
        for value in (instance_ids or [])
        if isinstance(value, str) and value.strip()
    ]
    explicit_workflow_ids: list[str] = []
    load_error: str | None = None
    try:
        run = _load_run(run_id)
        if not selected_ids:
            selected_ids = [
                value.strip()
                for value in (run.get("selectedInstanceIds") or [])
                if isinstance(value, str) and value.strip()
            ]
        selected_set = set(selected_ids)
        instances = run.get("instances")
        if isinstance(instances, list):
            fallback_selected_ids: list[str] = []
            for instance in instances:
                if not isinstance(instance, dict):
                    continue
                instance_id = ""
                for key in ("instanceId", "instance_id"):
                    value = instance.get(key)
                    if isinstance(value, str) and value.strip():
                        instance_id = value.strip()
                        break
                if instance_id:
                    fallback_selected_ids.append(instance_id)
                if selected_set and instance_id not in selected_set:
                    continue
                for key in (
                    "workflowExecutionId",
                    "workflow_execution_id",
                    "daprInstanceId",
                    "dapr_instance_id",
                ):
                    value = instance.get(key)
                    if isinstance(value, str) and value.strip():
                        explicit_workflow_ids.append(value.strip())
            if not selected_ids:
                selected_ids = fallback_selected_ids
    except Exception as exc:
        load_error = str(exc)

    termination_errors: dict[str, str] = {}
    terminated: list[str] = []
    workflow_ids = list(dict.fromkeys(explicit_workflow_ids))
    workflow_ids.extend(
        _child_instance_workflow_id(run_id, instance_id)
        for instance_id in dict.fromkeys(selected_ids)
    )
    for workflow_id in dict.fromkeys(workflow_ids):
        try:
            client.terminate_workflow(instance_id=workflow_id, output=reason)
            terminated.append(workflow_id)
        except Exception as exc:
            if _workflow_event_already_closed(exc):
                continue
            termination_errors[workflow_id] = str(exc)
            logger.warning(
                "Best-effort child terminate failed for %s: %s", workflow_id, exc
            )

    return {
        "selectedInstanceCount": len(selected_ids),
        "workflowExecutionCount": len(dict.fromkeys(workflow_ids)),
        "terminated": len(terminated),
        "executionIds": terminated,
        "terminationErrors": termination_errors,
        "loadError": load_error,
    }


def _evaluator_job_name(run_id: str) -> str:
    return _hash_suffixed_name("swebench-eval-", [run_id], max_length=63)


def _instance_image_map_for_run(
    run: dict[str, Any],
    instance_ids: list[str],
) -> dict[str, str]:
    instances = run.get("instances") or []
    by_id: dict[str, dict[str, Any]] = {}
    for inst in instances:
        if isinstance(inst, dict):
            iid = inst.get("instanceId") or inst.get("instance_id")
            if isinstance(iid, str):
                by_id[iid] = inst
    image_map: dict[str, str] = {}
    missing: list[str] = []
    for iid in instance_ids:
        inst = by_id.get(iid) or {}
        env = inst.get("inferenceEnvironment") if isinstance(inst, dict) else None
        sandbox_image = env.get("sandboxImage") if isinstance(env, dict) else None
        if isinstance(sandbox_image, str) and sandbox_image.strip():
            image_map[iid] = sandbox_image.strip()
        else:
            missing.append(iid)
    if missing:
        raise RuntimeError(
            "swebench evaluator: missing inferenceEnvironment.sandboxImage for "
            f"instances: {missing}. Inference image build must complete before grading."
        )
    return image_map


def _hash_suffixed_name(
    prefix: str,
    parts: list[str],
    *,
    max_length: int,
    hash_length: int = 12,
) -> str:
    suffix = _short_hash(parts, length=hash_length)
    readable_budget = max_length - len(prefix) - len(suffix) - 1
    readable = _safe_name_prefix("-".join(parts), readable_budget)
    return f"{prefix}{readable}-{suffix}"[:max_length].rstrip("-")


def _safe_name_prefix(value: str, max_length: int) -> str:
    normalized = "".join(char if char.isalnum() else "-" for char in value.lower())
    while "--" in normalized:
        normalized = normalized.replace("--", "-")
    normalized = normalized.strip("-") or "run"
    return normalized[:max_length].rstrip("-") or "run"


def _safe_artifact_name(value: str) -> str:
    return (
        "".join(
            char if char.isalnum() or char in {"-", "_", "."} else "_" for char in value
        )[:180]
        or "artifact"
    )


def _safe_label_value(value: str) -> str:
    # K8s label values must match (([A-Za-z0-9][-A-Za-z0-9_.]*)?[A-Za-z0-9])?
    # — alphanumeric start/end, length ≤ 63. Nanoid-generated run IDs can
    # legally end in `_` or `-`, which fails this regex; trim outer
    # non-alphanumerics and fall back to "unknown" if empty.
    sanitized = "".join(
        c if c.isalnum() or c in {"-", "_", "."} else "_" for c in value
    )
    sanitized = sanitized.strip("._-")[:63]
    return sanitized or "unknown"


def _short_hash(value: Any, *, length: int = 12) -> str:
    payload = json.dumps(value, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()[:length]


def _workflow_already_exists(exc: Exception) -> bool:
    text = str(exc).lower()
    return any(
        phrase in text
        for phrase in (
            "already exists",
            "already started",
            "already running",
            "already_created",
            "alreadyexists",
            "already_exists",
            "duplicate",
            "status code 409",
            "status=409",
            "conflict",
        )
    )


def _load_kubernetes_clients():
    from kubernetes import client, config

    try:
        config.load_incluster_config()
    except Exception:
        config.load_kube_config()
    return client, client.BatchV1Api(), client.CoreV1Api()


def _job_condition(conditions: list[Any], condition_type: str) -> Any | None:
    for condition in conditions:
        if (
            getattr(condition, "type", None) == condition_type
            and str(getattr(condition, "status", "")).lower() == "true"
        ):
            return condition
    return None


def _condition_field(condition: Any | None, field: str) -> str | None:
    if condition is None:
        return None
    value = getattr(condition, field, None)
    return str(value) if value else None


def _evaluation_progress_is_terminal(progress: dict[str, Any]) -> bool:
    if progress.get("runStatus") in RUN_TERMINAL_STATUSES:
        return True
    return int(progress.get("activeEvaluationRows") or 0) == 0


def _workflow_event_already_closed(exc: Exception) -> bool:
    text = str(exc).lower()
    return any(
        phrase in text
        for phrase in (
            "completed",
            "terminated",
            "not found",
            "no such instance",
            "does not exist",
            "not running",
            "closed",
        )
    )


def _preflight_workflow_id(run_id: str) -> str:
    return _hash_suffixed_name("swebench-preflight-", [run_id], max_length=100)


def _registered_child_workflow_name(name: str) -> str:
    if name not in REGISTERED_COORDINATOR_WORKFLOWS:
        raise RuntimeError(
            f"unregistered SWE-bench child workflow target: {name}"
        )
    return name


def _registered_child_workflow_app_id(app_id: str | None) -> str:
    cleaned = str(app_id or "").strip()
    if not cleaned:
        raise RuntimeError("missing Dapr app id for SWE-bench child workflow target")
    return cleaned


def _call_registered_child_workflow(
    ctx: wf.DaprWorkflowContext,
    workflow_name: str,
    *,
    input: dict[str, Any],
    instance_id: str,
    app_id: str | None = SWEBENCH_COORDINATOR_APP_ID,
):
    return ctx.call_child_workflow(
        _registered_child_workflow_name(workflow_name),
        input=input,
        instance_id=instance_id,
        app_id=_registered_child_workflow_app_id(app_id),
    )


def _selected_run_instances(run: dict[str, Any]) -> list[dict[str, Any]]:
    suite_slug = run.get("suiteSlug")
    dataset_name = run.get("datasetName")
    if not isinstance(suite_slug, str) or not suite_slug:
        raise RuntimeError("SWE-bench run is missing suiteSlug for preflight")
    if not isinstance(dataset_name, str) or not dataset_name:
        raise RuntimeError("SWE-bench run is missing datasetName for preflight")
    selected_ids = list(run.get("selectedInstanceIds") or [])
    instances = run.get("instances") if isinstance(run.get("instances"), list) else []
    by_id = {
        instance.get("instanceId"): instance
        for instance in instances
        if isinstance(instance, dict) and isinstance(instance.get("instanceId"), str)
    }
    missing: list[str] = []
    selected: list[dict[str, Any]] = []
    for instance_id in selected_ids:
        instance = by_id.get(instance_id)
        if not isinstance(instance, dict):
            missing.append(str(instance_id))
            continue
        repo = instance.get("repo")
        base_commit = instance.get("baseCommit")
        if not isinstance(repo, str) or not repo or not isinstance(base_commit, str) or not base_commit:
            missing.append(str(instance_id))
            continue
        selected.append(
            {
                "suiteSlug": suite_slug,
                "datasetName": dataset_name,
                "instanceId": instance_id,
                "repo": repo,
                "baseCommit": base_commit,
                "testMetadata": instance.get("testMetadata")
                if isinstance(instance.get("testMetadata"), dict)
                else {},
            }
        )
    if missing:
        raise RuntimeError(
            "SWE-bench preflight could not resolve metadata for "
            f"{len(missing)} instance(s): {', '.join(missing[:20])}"
        )
    return selected


def _environment_status_request(result: dict[str, Any]) -> dict[str, Any]:
    return {
        "buildId": result.get("buildId"),
        "envSpecHash": result.get("envSpecHash"),
        "environmentKey": result.get("environmentKey"),
    }


def _environment_group_key(result: dict[str, Any]) -> str:
    build_id = result.get("buildId")
    env_spec_hash = result.get("envSpecHash")
    environment_key = result.get("environmentKey")
    if isinstance(build_id, str) and build_id:
        return f"build:{build_id}"
    if isinstance(env_spec_hash, str) and env_spec_hash:
        return f"spec:{env_spec_hash}"
    if isinstance(environment_key, str) and environment_key:
        return f"env:{environment_key}"
    raise RuntimeError(f"environment result is missing a durable identity: {result}")


def _validated_environment(
    result: dict[str, Any], *, instance_id: str
) -> dict[str, Any] | None:
    status = result.get("environmentStatus")
    if status == "validated":
        environment = result.get("environment")
        sandbox_image = (
            environment.get("sandboxImage") if isinstance(environment, dict) else None
        )
        if isinstance(environment, dict) and isinstance(sandbox_image, str) and sandbox_image:
            return environment
        raise RuntimeError(
            f"SWE-bench preflight validated {instance_id} without a sandbox image"
        )
    if status == "building":
        return None
    reason = result.get("reason") or result.get("error") or status or "unknown"
    raise RuntimeError(
        f"SWE-bench preflight requires a validated inference image for {instance_id}; got {reason}"
    )


def _capacity_snapshot(run: dict[str, Any]) -> dict[str, Any]:
    summary = run.get("summary") if isinstance(run.get("summary"), dict) else {}
    capacity = summary.get("capacity") if isinstance(summary, dict) else None
    snapshot = dict(capacity) if isinstance(capacity, dict) else {}
    concurrency = bounded_swebench_run_concurrency(run)
    burst_size = instance_start_batch_size(concurrency)
    stagger_seconds = instance_start_batch_delay_seconds()
    snapshot["startupBurst"] = {
        "requestedConcurrency": snapshot.get("requestedConcurrency")
        or run.get("concurrency"),
        "effectiveConcurrency": concurrency,
        "coordinatorBurstSize": burst_size,
        "startStaggerSeconds": stagger_seconds,
        "selectedInstanceCount": len(run.get("selectedInstanceIds") or []),
        "launchMode": "full_concurrency"
        if burst_size >= concurrency and stagger_seconds == 0
        else "paced",
    }
    return snapshot


def _preflight_summary(
    *,
    run: dict[str, Any],
    prepared: dict[str, dict[str, Any]],
) -> dict[str, Any]:
    groups: dict[str, dict[str, Any]] = {}
    for instance_id, environment in prepared.items():
        key = (
            str(environment.get("buildId") or "")
            or str(environment.get("envSpecHash") or "")
            or str(environment.get("environmentKey") or "")
            or instance_id
        )
        group = groups.setdefault(
            key,
            {
                "environmentKey": environment.get("environmentKey"),
                "envSpecHash": environment.get("envSpecHash"),
                "buildId": environment.get("buildId"),
                "sandboxImage": environment.get("sandboxImage"),
                "validationStatus": environment.get("validationStatus"),
                "pipelineRunName": environment.get("pipelineRunName"),
                "pipelineRunNamespace": environment.get("pipelineRunNamespace"),
                "instanceIds": [],
            },
        )
        group["instanceIds"].append(instance_id)
    return {
        "status": "validated",
        "instanceCount": len(prepared),
        "groupCount": len(groups),
        "groups": sorted(
            groups.values(),
            key=lambda group: (
                str(group.get("environmentKey") or ""),
                str(group.get("envSpecHash") or ""),
            ),
        ),
        "capacitySnapshot": _capacity_snapshot(run),
    }


def swebench_environment_preflight_workflow(
    ctx: wf.DaprWorkflowContext, data: dict[str, Any]
):
    run_id = data["runId"]
    run = yield ctx.call_activity(_load_run_activity, input={"runId": run_id})
    yield ctx.call_activity(_validate_instance_metadata, input={"runId": run_id})
    run = yield ctx.call_activity(_load_run_activity, input={"runId": run_id})
    instance_inputs = _selected_run_instances(run)
    prepared: dict[str, dict[str, Any]] = {}
    pending_groups: dict[str, dict[str, Any]] = {}

    for instance_input in instance_inputs:
        result = yield ctx.call_activity(
            _prepare_instance_environment, input=instance_input
        )
        instance_id = instance_input["instanceId"]
        validated = _validated_environment(result, instance_id=instance_id)
        if validated is not None:
            prepared[instance_id] = validated
            continue
        group_key = _environment_group_key(result)
        group = pending_groups.setdefault(
            group_key,
            {
                "statusRequest": _environment_status_request(result),
                "instanceIds": [],
            },
        )
        group["instanceIds"].append(instance_id)

    preflight_deadline = (
        ctx.current_utc_datetime + timedelta(seconds=PREFLIGHT_TIMEOUT_SECONDS)
        if pending_groups
        else None
    )
    while pending_groups:
        if (
            preflight_deadline is not None
            and ctx.current_utc_datetime >= preflight_deadline
        ):
            pending_instances = sorted(
                {
                    instance_id
                    for group in pending_groups.values()
                    for instance_id in group["instanceIds"]
                }
            )
            raise RuntimeError(
                "SWE-bench preflight timed out waiting for validated inference "
                f"images for {len(pending_instances)} instance(s): "
                f"{', '.join(pending_instances[:20])}"
            )
        wait_seconds = PREFLIGHT_POLL_SECONDS
        if preflight_deadline is not None:
            wait_seconds = max(
                1,
                min(
                    PREFLIGHT_POLL_SECONDS,
                    int((preflight_deadline - ctx.current_utc_datetime).total_seconds()),
                ),
            )
        yield ctx.create_timer(timedelta(seconds=wait_seconds))
        next_pending: dict[str, dict[str, Any]] = {}
        for group_key, group in pending_groups.items():
            status = yield ctx.call_activity(
                _load_environment_status, input=group["statusRequest"]
            )
            validated = _validated_environment(
                status, instance_id=",".join(group["instanceIds"])
            )
            if validated is not None:
                for instance_id in group["instanceIds"]:
                    prepared[instance_id] = validated
                continue
            next_pending[group_key] = group
        pending_groups = next_pending

    preflight_summary = _preflight_summary(run=run, prepared=prepared)
    persisted = yield ctx.call_activity(
        _persist_preflight_results,
        input={
            "runId": run_id,
            "inferenceEnvironmentsByInstanceId": prepared,
            "preflightSummary": preflight_summary,
            "capacitySnapshot": _capacity_snapshot(run),
        },
    )
    return {
        "runId": run_id,
        "validatedInstances": len(prepared),
        "preflightSummary": preflight_summary,
        "persisted": persisted,
    }


def swebench_instance_workflow(ctx: wf.DaprWorkflowContext, data: dict[str, Any]):
    run_id = data["runId"]
    instance_id = data["instanceId"]
    try:
        yield ctx.call_activity(
            _start_instance, input={"runId": run_id, "instanceId": instance_id}
        )
        deadline = ctx.current_utc_datetime + timedelta(
            seconds=int(data.get("timeoutSeconds") or 7200) + 300
        )
        while ctx.current_utc_datetime < deadline:
            sync = yield ctx.call_activity(
                _sync_instance, input={"runId": run_id, "instanceId": instance_id}
            )
            instance = sync.get("instance") if isinstance(sync, dict) else {}
            status = instance.get("status") if isinstance(instance, dict) else None
            if status in ("inferred", "error", "timeout", "cancelled"):
                return instance
            yield ctx.create_timer(timedelta(seconds=30))
        final_sync = yield ctx.call_activity(
            _sync_instance, input={"runId": run_id, "instanceId": instance_id}
        )
        if isinstance(final_sync, dict) and isinstance(
            final_sync.get("instance"), dict
        ):
            instance = final_sync["instance"]
            if isinstance(instance, dict) and instance.get("status") in (
                "queued",
                "inferencing",
            ):
                try:
                    yield ctx.call_activity(
                        _mark_instance_inference_failure,
                        input={
                            "runId": run_id,
                            "instanceId": instance_id,
                            "status": "timeout",
                            "error": "Inference timed out before patch extraction",
                        },
                    )
                except Exception as mark_exc:
                    logger.warning(
                        "Failed to persist inference timeout for %s: %s",
                        instance_id,
                        mark_exc,
                    )
                return {
                    **instance,
                    "status": "timeout",
                    "error": "Inference timed out before patch extraction",
                }
            return instance
        return final_sync
    except Exception as exc:
        try:
            yield ctx.call_activity(
                _mark_instance_inference_failure,
                input={
                    "runId": run_id,
                    "instanceId": instance_id,
                    "status": "error",
                    "error": str(exc),
                },
            )
        except Exception as mark_exc:
            logger.warning(
                "Failed to persist inference failure for %s: %s", instance_id, mark_exc
            )
        return {"instanceId": instance_id, "status": "error", "error": str(exc)}


def swebench_evaluation_workflow(ctx: wf.DaprWorkflowContext, data: dict[str, Any]):
    run_id = data["runId"]
    timeout_seconds = max(60, int(data.get("timeoutSeconds") or 7200))
    evaluation_max_parallel = bounded_swebench_evaluation_concurrency(
        data.get("evaluationMaxParallel")
    )
    instance_count = max(0, int(data.get("instanceCount") or 0))
    job: dict[str, Any] | None = None
    try:
        job = yield ctx.call_activity(
            _ensure_evaluator_job,
            input={
                "runId": run_id,
                "predictionsPath": data["predictionsPath"],
                "datasetPath": data["datasetPath"],
            },
        )
        job_name = job.get("jobName") or _evaluator_job_name(run_id)
        deadline = ctx.current_utc_datetime + timedelta(
            seconds=_evaluation_deadline_seconds(
                instance_count=instance_count,
                evaluation_max_parallel=evaluation_max_parallel,
                timeout_seconds=timeout_seconds,
            )
        )
        while ctx.current_utc_datetime < deadline:
            progress = yield ctx.call_activity(
                _load_evaluation_progress, input={"runId": run_id}
            )
            if _evaluation_progress_is_terminal(progress):
                delete_result = yield ctx.call_activity(
                    _delete_evaluator_job,
                    input={
                        "runId": run_id,
                        "jobName": job_name,
                        "reason": "evaluation rows reached terminal state",
                    },
                )
                mlflow_eval = yield ctx.call_activity(
                    _run_mlflow_swebench_eval, input={"runId": run_id}
                )
                return {
                    "success": True,
                    "jobName": job_name,
                    "progress": progress,
                    "deleteResult": delete_result,
                    "mlflowEvaluation": mlflow_eval,
                }

            job_status = yield ctx.call_activity(
                _get_evaluator_job_status,
                input={"runId": run_id, "jobName": job_name},
            )
            if isinstance(job_status, dict) and job_status.get("failed"):
                message = (
                    job_status.get("message")
                    or job_status.get("reason")
                    or "SWE-bench evaluator job failed"
                )
                failure = yield ctx.call_activity(
                    _mark_evaluation_failure,
                    input={"runId": run_id, "jobName": job_name, "error": message},
                )
                if isinstance(failure, dict) and failure.get("failed"):
                    return failure
                progress_after_failure = yield ctx.call_activity(
                    _load_evaluation_progress, input={"runId": run_id}
                )
                if _evaluation_progress_is_terminal(progress_after_failure):
                    delete_result = yield ctx.call_activity(
                        _delete_evaluator_job,
                        input={
                            "runId": run_id,
                            "jobName": job_name,
                            "reason": "evaluation rows reached terminal state after job failure",
                        },
                    )
                    mlflow_eval = yield ctx.call_activity(
                        _run_mlflow_swebench_eval, input={"runId": run_id}
                    )
                    return {
                        "success": True,
                        "jobName": job_name,
                        "progress": progress_after_failure,
                        "deleteResult": delete_result,
                        "mlflowEvaluation": mlflow_eval,
                    }
                timeout_result = yield ctx.call_activity(
                    _mark_evaluation_timeout,
                    input={
                        "runId": run_id,
                        "jobName": job_name,
                        "error": "SWE-bench evaluator job failed before all active rows completed",
                    },
                )
                delete_result = yield ctx.call_activity(
                    _delete_evaluator_job,
                    input={
                        "runId": run_id,
                        "jobName": job_name,
                        "reason": "evaluation job failed after partial results",
                    },
                )
                if isinstance(timeout_result, dict):
                    return {**timeout_result, "deleteResult": delete_result}
                return {"success": True, "timeout": timeout_result, "deleteResult": delete_result}

            wait_seconds = max(
                1,
                min(
                    EVALUATION_POLL_SECONDS,
                    int((deadline - ctx.current_utc_datetime).total_seconds()),
                ),
            )
            wait_delta = timedelta(seconds=wait_seconds)
            if wf_when_any is not None:
                results_event = ctx.wait_for_external_event(EVALUATION_RESULTS_EVENT)
                failed_event = ctx.wait_for_external_event(EVALUATION_FAILED_EVENT)
                timer = ctx.create_timer(wait_delta)
                yield wf_when_any([results_event, failed_event, timer])
            else:
                try:
                    yield ctx.wait_for_external_event(
                        EVALUATION_RESULTS_EVENT, timeout=wait_delta
                    )
                except TimeoutError:
                    pass

        return (
            yield ctx.call_activity(
                _mark_evaluation_timeout,
                input={
                    "runId": run_id,
                    "jobName": (job or {}).get("jobName")
                    or _evaluator_job_name(run_id),
                    "error": "SWE-bench evaluation workflow timed out waiting for terminal results",
                },
            )
        )
    except Exception as exc:
        yield ctx.call_activity(
            _mark_run_status,
            input={"runId": run_id, "status": "failed", "error": str(exc)},
        )
        raise


def swebench_run_workflow(ctx: wf.DaprWorkflowContext, data: dict[str, Any]):
    run_id = data["runId"]
    try:
        yield _call_registered_child_workflow(
            ctx,
            "swebench_environment_preflight_workflow",
            input={"runId": run_id},
            instance_id=_preflight_workflow_id(run_id),
        )
        run = yield ctx.call_activity(_load_run_activity, input={"runId": run_id})
        mark_result = yield ctx.call_activity(
            _mark_run_status, input={"runId": run_id, "status": "inferencing"}
        )
        marked_status = _status_from_mark_result(mark_result)
        if marked_status in RUN_TERMINAL_STATUSES:
            return {
                "success": False,
                "skipped": True,
                "reason": "run-terminal",
                "runStatus": marked_status,
            }
        if marked_status and marked_status != "inferencing":
            raise RuntimeError(
                "SWE-bench run did not enter inferencing state; "
                f"current status is {marked_status}"
            )
        instance_ids = list(run.get("selectedInstanceIds") or [])
        concurrency = bounded_swebench_run_concurrency(run)
        start_batch_size = instance_start_batch_size(concurrency)
        start_batch_delay_seconds = instance_start_batch_delay_seconds()
        timeout_seconds = int(run.get("timeoutSeconds") or 7200)
        deadline = ctx.current_utc_datetime + timedelta(seconds=timeout_seconds + 300)
        results: list[Any] = []
        pending_instance_ids = list(instance_ids)
        active_instances: list[dict[str, Any]] = []
        starts_in_batch = 0
        while pending_instance_ids or active_instances:
            while pending_instance_ids and len(active_instances) < concurrency:
                gate = yield ctx.call_activity(
                    _check_capacity_gate,
                    input={"runId": run_id},
                )
                if isinstance(gate, dict) and not gate.get("admitNewStarts", True):
                    try:
                        retry_seconds = max(
                            1,
                            int(gate.get("retryAfterSeconds") or LEASE_RETRY_SECONDS),
                        )
                    except (TypeError, ValueError):
                        retry_seconds = LEASE_RETRY_SECONDS
                    yield ctx.create_timer(timedelta(seconds=retry_seconds))
                    continue
                available_slots = max(1, concurrency - len(active_instances))
                batch_count = min(
                    available_slots,
                    len(pending_instance_ids),
                    max(1, start_batch_size),
                )
                start_outcomes: list[dict[str, Any]] = []
                if wf_when_all is not None and batch_count > 1:
                    batch_instance_ids = pending_instance_ids[:batch_count]
                    pending_instance_ids = pending_instance_ids[batch_count:]
                    tasks = [
                        ctx.call_activity(
                            _admit_and_start_instance,
                            input={"runId": run_id, "instanceId": instance_id},
                        )
                        for instance_id in batch_instance_ids
                    ]
                    batch_results = yield wf_when_all(tasks)
                    for instance_id, outcome in zip(batch_instance_ids, batch_results):
                        if isinstance(outcome, dict):
                            start_outcomes.append(outcome)
                        else:
                            start_outcomes.append(
                                {
                                    "success": False,
                                    "instanceId": instance_id,
                                    "admission": None,
                                    "start": None,
                                }
                            )
                else:
                    instance_id = pending_instance_ids.pop(0)
                    admission = yield ctx.call_activity(
                        _acquire_instance_leases,
                        input={"runId": run_id, "instanceId": instance_id},
                    )
                    if isinstance(admission, dict) and admission.get("admitted"):
                        start_result = yield ctx.call_activity(
                            _start_instance,
                            input={"runId": run_id, "instanceId": instance_id},
                        )
                    else:
                        start_result = None
                    start_outcomes.append(
                        {
                            "success": bool(
                                isinstance(admission, dict)
                                and admission.get("admitted")
                            ),
                            "instanceId": instance_id,
                            "admission": admission,
                            "start": start_result,
                            "holderId": admission.get("holderId")
                            if isinstance(admission, dict)
                            else None,
                        }
                    )

                retry_after_seconds = 0
                for outcome in start_outcomes:
                    instance_id = str(outcome.get("instanceId") or "")
                    admission = (
                        outcome.get("admission")
                        if isinstance(outcome.get("admission"), dict)
                        else {}
                    )
                    start_result = (
                        outcome.get("start")
                        if isinstance(outcome.get("start"), dict)
                        else {}
                    )
                    if not admission.get("admitted"):
                        reason = admission.get("reason") or "admission_failed"
                        if isinstance(reason, str) and reason.startswith("benchmark_run_"):
                            raise RuntimeError(
                                f"SWE-bench run stopped before admitting {instance_id}: {reason}"
                            )
                        try:
                            retry_after_seconds = max(
                                retry_after_seconds,
                                max(
                                    1,
                                    int(
                                        admission.get("retryAfterSeconds")
                                        or LEASE_RETRY_SECONDS
                                    ),
                                ),
                            )
                        except (TypeError, ValueError):
                            retry_after_seconds = max(
                                retry_after_seconds, LEASE_RETRY_SECONDS
                            )
                        if instance_id:
                            pending_instance_ids.insert(0, instance_id)
                        continue

                    reason = str(start_result.get("reason") or "")
                    if reason.startswith("benchmark_run_"):
                        raise RuntimeError(
                            f"SWE-bench run stopped before starting {instance_id}: {reason}"
                        )
                    if start_result.get("skipped"):
                        results.append(
                            {
                                "instanceId": instance_id,
                                "status": "cancelled",
                                "error": reason or "benchmark instance start skipped",
                            }
                        )
                        yield ctx.call_activity(
                            _release_instance_leases,
                            input={
                                "runId": run_id,
                                "instanceId": instance_id,
                                "holderId": admission.get("holderId"),
                                "phase": "inference",
                                "reason": reason or "benchmark instance start skipped",
                            },
                        )
                        continue
                    if start_result.get("retryable"):
                        retry_after_seconds = max(
                            retry_after_seconds,
                            int(
                                start_result.get("retryAfterSeconds")
                                or LEASE_RETRY_SECONDS
                            ),
                        )
                        if instance_id:
                            pending_instance_ids.insert(0, instance_id)
                        yield ctx.call_activity(
                            _release_instance_leases,
                            input={
                                "runId": run_id,
                                "instanceId": instance_id,
                                "holderId": admission.get("holderId"),
                                "phase": "inference",
                                "reason": reason or "benchmark instance start retryable",
                            },
                        )
                        continue
                    active_instances.append(
                        {
                            "instanceId": instance_id,
                            "holderId": admission.get("holderId"),
                        }
                    )
                    starts_in_batch += 1

                if retry_after_seconds > 0:
                    yield ctx.create_timer(timedelta(seconds=retry_after_seconds))
                    if active_instances:
                        break
                    continue
                if (
                    pending_instance_ids
                    and len(active_instances) < concurrency
                    and starts_in_batch >= start_batch_size
                ):
                    starts_in_batch = 0
                    if start_batch_delay_seconds > 0:
                        yield ctx.create_timer(
                            timedelta(seconds=start_batch_delay_seconds)
                        )

            if not active_instances:
                continue

            next_active_instances: list[dict[str, Any]] = []
            for entry in active_instances:
                instance_id = str(entry["instanceId"])
                sync = yield ctx.call_activity(
                    _sync_instance, input={"runId": run_id, "instanceId": instance_id}
                )
                instance = sync.get("instance") if isinstance(sync, dict) else {}
                status = instance.get("status") if isinstance(instance, dict) else None
                if status in ("inferred", "error", "timeout", "cancelled"):
                    results.append(instance)
                    yield ctx.call_activity(
                        _release_instance_leases,
                        input={
                            "runId": run_id,
                            "instanceId": instance_id,
                            "holderId": entry.get("holderId"),
                            "phase": "inference",
                            "reason": "instance workflow completed",
                        },
                    )
                    continue
                if status == "queued":
                    if instance_id and instance_id not in pending_instance_ids:
                        pending_instance_ids.insert(0, instance_id)
                    yield ctx.call_activity(
                        _release_instance_leases,
                        input={
                            "runId": run_id,
                            "instanceId": instance_id,
                            "holderId": entry.get("holderId"),
                            "phase": "inference",
                            "reason": "instance workflow requeued",
                        },
                    )
                    continue
                if ctx.current_utc_datetime >= deadline:
                    try:
                        yield ctx.call_activity(
                            _mark_instance_inference_failure,
                            input={
                                "runId": run_id,
                                "instanceId": instance_id,
                                "status": "timeout",
                                "error": "Inference timed out before patch extraction",
                            },
                        )
                    except Exception as mark_exc:
                        logger.warning(
                            "Failed to persist inference timeout for %s: %s",
                            instance_id,
                            mark_exc,
                        )
                    results.append(
                        {
                            "instanceId": instance_id,
                            "status": "timeout",
                            "error": "Inference timed out before patch extraction",
                        }
                    )
                    yield ctx.call_activity(
                        _release_instance_leases,
                        input={
                            "runId": run_id,
                            "instanceId": instance_id,
                            "holderId": entry.get("holderId"),
                            "phase": "inference",
                            "reason": "instance workflow timed out",
                        },
                    )
                    continue
                next_active_instances.append(entry)
            active_instances = next_active_instances
            if pending_instance_ids or active_instances:
                yield ctx.create_timer(timedelta(seconds=30))
        failed_instances = [
            result
            for result in results
            if not isinstance(result, dict) or result.get("status") != "inferred"
        ]
        if failed_instances:
            logger.warning(
                "Inference failed or produced no terminal patch for %d SWE-bench instance(s); writing empty predictions and continuing to the official evaluator",
                len(failed_instances),
            )
        yield ctx.call_activity(
            _release_run_leases,
            input={"runId": run_id, "reason": "inference fan-out completed"},
        )
        run_after_inference = yield ctx.call_activity(
            _load_run_activity, input={"runId": run_id}
        )
        if run_after_inference.get("status") in RUN_TERMINAL_STATUSES:
            logger.info(
                "Skipping SWE-bench evaluation for %s because run is already %s",
                run_id,
                run_after_inference.get("status"),
            )
            return {
                "success": False,
                "instances": len(results),
                "failedInferenceInstances": len(failed_instances),
                "skippedEvaluation": True,
                "runStatus": run_after_inference.get("status"),
            }
        predictions = yield ctx.call_activity(
            _write_predictions, input={"runId": run_id}
        )
        dataset = yield ctx.call_activity(
            _write_evaluation_dataset, input={"runId": run_id}
        )
        evaluation_max_parallel = _evaluation_max_parallel(run)
        evaluation = yield _call_registered_child_workflow(
            ctx,
            "swebench_evaluation_workflow",
            input={
                "runId": run_id,
                "predictionsPath": predictions["path"],
                "datasetPath": dataset["path"],
                "timeoutSeconds": timeout_seconds,
                "evaluationMaxParallel": evaluation_max_parallel,
                "instanceCount": len(instance_ids),
            },
            instance_id=_evaluator_workflow_id(run_id),
        )
        return {
            "success": True,
            "instances": len(results),
            "failedInferenceInstances": len(failed_instances),
            "predictionsPath": predictions["path"],
            "datasetPath": dataset["path"],
            "evaluation": evaluation,
        }
    except Exception as exc:
        yield ctx.call_activity(
            _mark_run_status,
            input={"runId": run_id, "status": "failed", "error": str(exc)},
        )
        raise


def _format_inference_failures(results: list[Any]) -> str:
    summaries: list[str] = []
    for result in results[:5]:
        if not isinstance(result, dict):
            summaries.append(f"unknown instance returned {type(result).__name__}")
            continue
        instance_id = result.get("instanceId") or result.get("instance_id") or "unknown"
        status = result.get("status") or "unknown"
        error_text = str(result.get("error") or "").strip()
        if error_text:
            summaries.append(f"{instance_id}: {status}: {error_text[:300]}")
        else:
            summaries.append(f"{instance_id}: {status}")
    suffix = "" if len(results) <= 5 else f"; and {len(results) - 5} more"
    return f"Inference failed for {len(results)} SWE-bench instance(s): {'; '.join(summaries)}{suffix}"


@asynccontextmanager
async def lifespan(app: FastAPI):
    wfr.register_workflow(swebench_environment_preflight_workflow)
    wfr.register_workflow(swebench_run_workflow)
    wfr.register_workflow(swebench_instance_workflow)
    wfr.register_workflow(swebench_evaluation_workflow)
    for activity in (
        _mark_run_status,
        _load_run_activity,
        _load_evaluation_progress,
        _validate_instance_metadata,
        _prepare_instance_environment,
        _load_environment_status,
        _persist_preflight_results,
        _check_capacity_gate,
        _acquire_instance_leases,
        _release_instance_leases,
        _release_run_leases,
        _start_instance,
        _admit_and_start_instance,
        _sync_instance,
        _mark_instance_inference_failure,
        _write_predictions,
        _write_evaluation_dataset,
        _ensure_evaluator_job,
        _get_evaluator_job_status,
        _mark_evaluation_timeout,
        _mark_evaluation_failure,
        _delete_evaluator_job,
        _run_mlflow_swebench_eval,
    ):
        wfr.register_activity(_activity_with_content_io(activity))
    wfr.start()
    logger.info("SWE-bench coordinator workflow runtime started")
    yield
    wfr.shutdown()


app = FastAPI(title="swebench-coordinator", lifespan=lifespan)

if _otel_ready:
    try:
        from opentelemetry.instrumentation.fastapi import FastAPIInstrumentor

        FastAPIInstrumentor.instrument_app(app, excluded_urls="healthz")
        logger.info("FastAPI OpenTelemetry instrumentation applied")
    except Exception as exc:
        logger.warning("FastAPI OpenTelemetry instrumentation failed: %s", exc)


@app.get("/healthz")
def healthz():
    return {"ok": True}


@app.post("/api/v1/benchmark-runs")
def start_benchmark_run(body: StartRunRequest, request: Request):
    _require_internal(request)
    set_current_span_io("input", _dump_model(body))
    instance_id = _run_workflow_id(body.runId)
    try:
        DaprWorkflowClient().schedule_new_workflow(
            workflow=swebench_run_workflow,
            input={"runId": body.runId, "requestedAt": time.time()},
            instance_id=instance_id,
        )
    except Exception as exc:
        if _workflow_already_exists(exc):
            logger.info(
                "SWE-bench run workflow %s is already started; treating start as idempotent",
                instance_id,
            )
            response = {
                "success": True,
                "executionId": instance_id,
                "alreadyStarted": True,
            }
            set_current_span_io("output", response)
            return response
        logger.exception("Failed to schedule SWE-bench run workflow %s", instance_id)
        set_current_span_io(
            "output",
            {"success": False, "executionId": instance_id, "error": str(exc)},
        )
        raise HTTPException(status_code=500, detail=str(exc)) from exc
    response = {"success": True, "executionId": instance_id}
    set_current_span_io("output", response)
    return response


@app.post("/api/v1/benchmark-runs/{run_id}/cancel")
def cancel_benchmark_run(
    run_id: str, request: Request, body: CancelRunRequest = CancelRunRequest()
):
    _require_internal(request)
    set_current_span_io("input", {"runId": run_id, "body": _dump_model(body) if body else {}})
    run_instance_id = _run_workflow_id(run_id)
    preflight_instance_id = _preflight_workflow_id(run_id)
    evaluation_instance_id = _evaluator_workflow_id(run_id)
    reason = body.reason if body else "cancelled"
    client = DaprWorkflowClient()
    termination_errors: dict[str, str] = {}
    status_result: dict[str, Any] = {"success": False}
    lease_release: dict[str, Any] = {
        "success": True,
        "skipped": True,
        "reason": "handled_by_bff_terminal_cleanup",
    }
    for instance_id in (run_instance_id, preflight_instance_id, evaluation_instance_id):
        try:
            client.terminate_workflow(instance_id=instance_id, output=reason)
        except Exception as exc:
            if _workflow_event_already_closed(exc):
                logger.debug(
                    "Workflow %s already closed during cancellation: %s",
                    instance_id,
                    exc,
                )
            else:
                termination_errors[instance_id] = str(exc)
                logger.warning(
                    "Best-effort terminate failed for %s: %s", instance_id, exc
                )
    child_termination = _cancel_child_instance_workflows(
        client,
        run_id,
        reason,
        getattr(body, "instanceIds", None) if body else None,
    )
    delete_result = _delete_evaluator_job(None, {"runId": run_id})
    try:
        status_result = _mark_run_status(
            None,
            {
                "runId": run_id,
                "status": "cancelled",
                "error": reason,
            },
        )
    except Exception as exc:
        status_result = {"success": False, "error": str(exc)}
        logger.warning(
            "Best-effort cancelled status update failed for %s: %s", run_id, exc
        )
    try:
        lease_release = _retry_run_terminal_cleanup(None, {"runId": run_id})
    except Exception as exc:
        lease_release = {"success": False, "error": str(exc)}
        logger.warning(
            "Best-effort terminal cleanup failed for cancelled run %s: %s",
            run_id,
            exc,
        )
    response = {
        "success": True,
        "executionId": run_instance_id,
        "preflightExecutionId": preflight_instance_id,
        "evaluationExecutionId": evaluation_instance_id,
        "terminationErrors": termination_errors,
        "childTermination": child_termination,
        "deleteEvaluatorJob": delete_result,
        "statusUpdate": status_result,
        "leaseRelease": lease_release,
    }
    set_current_span_io("output", response)
    return response


@app.post("/api/v1/benchmark-runs/{run_id}/evaluation-events")
def post_evaluation_event(run_id: str, body: EvaluationEventRequest, request: Request):
    _require_internal(request)
    set_current_span_io("input", {"runId": run_id, "body": _dump_model(body)})
    if body.eventType not in {"results", "failed"}:
        set_current_span_io(
            "output",
            {"success": False, "error": "eventType must be results or failed"},
        )
        raise HTTPException(
            status_code=400, detail="eventType must be results or failed"
        )
    event_name = (
        EVALUATION_RESULTS_EVENT
        if body.eventType == "results"
        else EVALUATION_FAILED_EVENT
    )
    instance_id = _evaluator_workflow_id(run_id)
    payload = _dump_model(body, exclude_none=True)
    payload["runId"] = run_id
    try:
        DaprWorkflowClient().raise_workflow_event(
            instance_id=instance_id,
            event_name=event_name,
            data=payload,
        )
    except Exception as exc:
        if _workflow_event_already_closed(exc):
            logger.debug(
                "Ignoring event %s for already-closed evaluation workflow %s: %s",
                event_name,
                instance_id,
                exc,
            )
            response = {
                "success": True,
                "instanceId": instance_id,
                "eventName": event_name,
                "ignored": True,
            }
            set_current_span_io("output", response)
            return response
        logger.exception(
            "Failed to raise evaluation event %s for %s", event_name, instance_id
        )
        set_current_span_io(
            "output",
            {
                "success": False,
                "instanceId": instance_id,
                "eventName": event_name,
                "error": str(exc),
            },
        )
        raise HTTPException(status_code=500, detail=str(exc)) from exc
    response = {"success": True, "instanceId": instance_id, "eventName": event_name}
    set_current_span_io("output", response)
    return response

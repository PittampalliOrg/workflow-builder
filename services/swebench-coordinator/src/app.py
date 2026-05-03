from __future__ import annotations

import hashlib
import json
import logging
import os
import pathlib
import time
from contextlib import asynccontextmanager
from datetime import timedelta
from typing import Any

import requests
from dapr.ext import workflow as wf
from dapr.ext.workflow import DaprWorkflowClient
from fastapi import FastAPI, HTTPException, Request
from pydantic import BaseModel

from src.concurrency import (
    bounded_swebench_concurrency,
    bounded_swebench_evaluation_concurrency,
)

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
MLFLOW_TRACKING_URI = os.environ.get("MLFLOW_TRACKING_URI", "").strip()
EVALUATION_RESULTS_EVENT = "swebench.evaluation.results"
EVALUATION_FAILED_EVENT = "swebench.evaluation.failed"
EVALUATION_POLL_SECONDS = int(os.environ.get("SWEBENCH_EVALUATION_POLL_SECONDS", "60"))
PREFLIGHT_POLL_SECONDS = int(os.environ.get("SWEBENCH_PREFLIGHT_POLL_SECONDS", "30"))
PREFLIGHT_TIMEOUT_SECONDS = int(
    os.environ.get("SWEBENCH_PREFLIGHT_TIMEOUT_SECONDS", "14400")
)
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

wfr = wf.WorkflowRuntime()


EVALUATOR_RESOURCE_PROFILES: dict[str, dict[str, dict[str, dict[str, str]]]] = {
    # The evaluator is a thin PipelineRun dispatcher (no docker-in-docker
    # anymore) — per-instance grading happens in dedicated TaskRun pods. The
    # dispatcher container only needs enough headroom for the kubernetes
    # client + watch loop + a handful of MLflow logs.
    "standard": {
        "evaluator": {
            "requests": {"cpu": "0", "memory": "0"},
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


class EvaluationEventRequest(BaseModel):
    eventType: str
    jobName: str | None = None
    error: str | None = None
    postedAt: str | None = None


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
        raise RuntimeError(
            f"BFF {method} {path} failed ({res.status_code}): {res.text[:800]}"
        )
    if not res.text:
        return {}
    return res.json()


def _bff_text(method: str, path: str, *, timeout: int = 60) -> str:
    if not INTERNAL_API_TOKEN:
        raise RuntimeError("INTERNAL_API_TOKEN is required")
    res = requests.request(
        method,
        f"{WORKFLOW_BUILDER_URL}{path}",
        headers={"X-Internal-Token": INTERNAL_API_TOKEN},
        timeout=timeout,
    )
    if res.status_code >= 400:
        raise RuntimeError(
            f"BFF {method} {path} failed ({res.status_code}): {res.text[:800]}"
        )
    return res.text


def _bff_with_retry(
    method: str,
    path: str,
    *,
    json_body: dict[str, Any] | None = None,
    timeout: int = 60,
    attempts: int = 3,
    delay_seconds: float = 15,
) -> Any:
    last_error: Exception | None = None
    for attempt in range(1, attempts + 1):
        try:
            return _bff(method, path, json_body=json_body, timeout=timeout)
        except Exception as exc:
            last_error = exc
            if attempt >= attempts:
                break
            logger.warning(
                "BFF %s %s failed on attempt %s/%s; retrying in %.1fs: %s",
                method,
                path,
                attempt,
                attempts,
                delay_seconds,
                exc,
            )
            time.sleep(delay_seconds)
    raise last_error or RuntimeError(f"BFF {method} {path} failed")


def _load_run(run_id: str) -> dict[str, Any]:
    return _bff("GET", f"/api/internal/benchmarks/runs/{run_id}/status")["run"]


def _load_run_activity(ctx, data: dict[str, Any]) -> dict[str, Any]:
    return _load_run(data["runId"])


def _mlflow_enabled() -> bool:
    enabled = os.environ.get("MLFLOW_ENABLED", "").strip().lower()
    if enabled in {"0", "false", "no", "off"}:
        return False
    return bool(MLFLOW_TRACKING_URI)


def _mlflow_log_artifact(run_id: Any, path: pathlib.Path, artifact_path: str) -> None:
    if (
        not _mlflow_enabled()
        or not isinstance(run_id, str)
        or not run_id
        or not path.exists()
    ):
        return
    try:
        import mlflow

        mlflow.set_tracking_uri(MLFLOW_TRACKING_URI)
        with mlflow.start_run(run_id=run_id):
            mlflow.log_artifact(str(path), artifact_path=artifact_path)
    except Exception as exc:
        logger.warning("Best-effort MLflow artifact log failed for %s: %s", path, exc)


def _mlflow_log_text(
    run_id: Any, text: Any, file_path: pathlib.Path, artifact_path: str
) -> None:
    if not _mlflow_enabled() or not isinstance(text, str) or not text:
        return
    file_path.parent.mkdir(parents=True, exist_ok=True)
    file_path.write_text(text, encoding="utf-8")
    _mlflow_log_artifact(run_id, file_path, artifact_path)


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


def _load_evaluation_progress(ctx, data: dict[str, Any]) -> dict[str, Any]:
    run = _load_run(data["runId"])
    instances = run.get("instances") if isinstance(run.get("instances"), list) else []
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
        "run": run,
        "runId": run.get("id") or data["runId"],
        "runStatus": run.get("status"),
        "summary": run.get("summary") or {},
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
    return _bff(
        "POST", f"/api/internal/benchmarks/runs/{run_id}/status", json_body=payload
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
    return _bff(
        "POST",
        f"/api/internal/benchmarks/runs/{run_id}/preflight",
        json_body={
            "inferenceEnvironmentsByInstanceId": data["inferenceEnvironmentsByInstanceId"],
            "preflightSummary": data.get("preflightSummary") or {},
            "capacitySnapshot": data.get("capacitySnapshot") or {},
        },
        timeout=120,
    )


def _start_instance(ctx, data: dict[str, Any]) -> dict[str, Any]:
    run_id = data["runId"]
    instance_id = data["instanceId"]
    return _bff_with_retry(
        "POST",
        f"/api/internal/benchmarks/runs/{run_id}/instances/{instance_id}/start",
        json_body={},
        timeout=90,
        attempts=3,
        delay_seconds=20,
    )


def _sync_instance(ctx, data: dict[str, Any]) -> dict[str, Any]:
    run_id = data["runId"]
    instance_id = data["instanceId"]
    response = _bff(
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
        _mlflow_log_text(mlflow_run_id, patch, patch_path, "patches")
    return response


def _mark_instance_inference_failure(ctx, data: dict[str, Any]) -> dict[str, Any]:
    run_id = data["runId"]
    instance_id = data["instanceId"]
    return _bff(
        "POST",
        f"/api/internal/benchmarks/runs/{run_id}/instances/{instance_id}/inference-failure",
        json_body={
            "status": data.get("status") or "error",
            "error": data.get("error") or "Inference failed before patch extraction",
        },
        timeout=60,
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
    _bff(
        "POST",
        f"/api/internal/benchmarks/runs/{run['id']}/predictions-artifact",
        json_body={"path": str(path)},
    )
    _mlflow_log_artifact(run.get("mlflowRunId"), path, "swebench")
    return {"path": str(path), "bytes": path.stat().st_size}


def _write_evaluation_dataset(ctx, data: dict[str, Any]) -> dict[str, Any]:
    run_id = data["runId"]
    path = ARTIFACT_ROOT / run_id / "dataset.jsonl"
    path.parent.mkdir(parents=True, exist_ok=True)
    jsonl = _bff_text(
        "GET",
        f"/api/internal/benchmarks/runs/{run_id}/dataset.jsonl",
        timeout=120,
    )
    path.write_text(jsonl, encoding="utf-8")
    _bff(
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
    return {"path": str(path), "bytes": path.stat().st_size}


def _evaluation_max_parallel(run: dict[str, Any]) -> int:
    return bounded_swebench_evaluation_concurrency(
        run.get("evaluationConcurrency")
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
    instance_ids = run.get("selectedInstanceIds") or []
    resource_profile = _evaluator_resource_profile(run.get("evaluatorResourceClass"))
    evaluation_timeout_seconds = max(60, int(run.get("timeoutSeconds") or 7200))
    evaluation_max_parallel = _evaluation_max_parallel(run)
    job_deadline_seconds = _evaluation_deadline_seconds(
        instance_count=len(instance_ids),
        evaluation_max_parallel=evaluation_max_parallel,
        timeout_seconds=evaluation_timeout_seconds,
    )
    instance_image_map = _instance_image_map_for_run(run, instance_ids)
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
            client.V1EnvVar(
                name="MLFLOW_INSTANCE_RUNS_JSON",
                value=json.dumps(_mlflow_instance_run_map(run), sort_keys=True),
            ),
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
                name="SWEBENCH_EVALUATION_TIMEOUT_SECONDS",
                value=str(evaluation_timeout_seconds),
            ),
            client.V1EnvVar(
                name="SWEBENCH_EVAL_MAX_PARALLEL",
                value=str(evaluation_max_parallel),
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
            volume_mounts=[
                client.V1VolumeMount(name="artifacts", mount_path=str(ARTIFACT_ROOT)),
            ],
        )
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
                volumes=[
                    client.V1Volume(
                        name="artifacts",
                        persistent_volume_claim=client.V1PersistentVolumeClaimVolumeSource(
                            claim_name=os.environ.get(
                                "SWEBENCH_ARTIFACTS_PVC", "swebench-artifacts"
                            )
                        ),
                    ),
                ],
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
        _mark_run_status(
            ctx,
            {"runId": run["id"], "status": "evaluating", "evaluatorJobName": job_name},
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
    return {"success": True, "timedOut": len(results), "response": response}


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
    return capacity if isinstance(capacity, dict) else {}


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
                return {"success": True, "jobName": job_name, "progress": progress}

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
                    return {
                        "success": True,
                        "jobName": job_name,
                        "progress": progress_after_failure,
                    }
                return (
                    yield ctx.call_activity(
                        _mark_evaluation_timeout,
                        input={
                            "runId": run_id,
                            "jobName": job_name,
                            "error": "SWE-bench evaluator job failed before all active rows completed",
                        },
                    )
                )

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
        concurrency = bounded_swebench_concurrency(run.get("concurrency"))
        timeout_seconds = int(run.get("timeoutSeconds") or 7200)
        results: list[Any] = []
        for offset in range(0, len(instance_ids), concurrency):
            chunk = instance_ids[offset : offset + concurrency]
            tasks = [
                _call_registered_child_workflow(
                    ctx,
                    "swebench_instance_workflow",
                    input={
                        "runId": run_id,
                        "instanceId": instance_id,
                        "timeoutSeconds": timeout_seconds,
                    },
                    instance_id=_child_instance_workflow_id(run_id, instance_id),
                )
                for instance_id in chunk
            ]
            if wf_when_all is not None:
                chunk_results = yield wf_when_all(tasks)
                results.extend(chunk_results)
            else:
                for task in tasks:
                    results.append((yield task))
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
        _start_instance,
        _sync_instance,
        _mark_instance_inference_failure,
        _write_predictions,
        _write_evaluation_dataset,
        _ensure_evaluator_job,
        _get_evaluator_job_status,
        _mark_evaluation_timeout,
        _mark_evaluation_failure,
        _delete_evaluator_job,
    ):
        wfr.register_activity(activity)
    wfr.start()
    logger.info("SWE-bench coordinator workflow runtime started")
    yield
    wfr.shutdown()


app = FastAPI(title="swebench-coordinator", lifespan=lifespan)


@app.get("/healthz")
def healthz():
    return {"ok": True}


@app.post("/api/v1/benchmark-runs")
def start_benchmark_run(body: StartRunRequest, request: Request):
    _require_internal(request)
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
            return {"success": True, "executionId": instance_id, "alreadyStarted": True}
        logger.exception("Failed to schedule SWE-bench run workflow %s", instance_id)
        raise HTTPException(status_code=500, detail=str(exc)) from exc
    return {"success": True, "executionId": instance_id}


@app.post("/api/v1/benchmark-runs/{run_id}/cancel")
def cancel_benchmark_run(
    run_id: str, request: Request, body: CancelRunRequest = CancelRunRequest()
):
    _require_internal(request)
    run_instance_id = _run_workflow_id(run_id)
    preflight_instance_id = _preflight_workflow_id(run_id)
    evaluation_instance_id = _evaluator_workflow_id(run_id)
    reason = body.reason if body else "cancelled"
    client = DaprWorkflowClient()
    termination_errors: dict[str, str] = {}
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
    delete_result = _delete_evaluator_job(None, {"runId": run_id})
    return {
        "success": True,
        "executionId": run_instance_id,
        "preflightExecutionId": preflight_instance_id,
        "evaluationExecutionId": evaluation_instance_id,
        "terminationErrors": termination_errors,
        "deleteEvaluatorJob": delete_result,
    }


@app.post("/api/v1/benchmark-runs/{run_id}/evaluation-events")
def post_evaluation_event(run_id: str, body: EvaluationEventRequest, request: Request):
    _require_internal(request)
    if body.eventType not in {"results", "failed"}:
        raise HTTPException(
            status_code=400, detail="eventType must be results or failed"
        )
    event_name = (
        EVALUATION_RESULTS_EVENT
        if body.eventType == "results"
        else EVALUATION_FAILED_EVENT
    )
    instance_id = _evaluator_workflow_id(run_id)
    if hasattr(body, "model_dump"):
        payload = body.model_dump(exclude_none=True)
    else:  # pragma: no cover - pydantic v1 compatibility
        payload = body.dict(exclude_none=True)
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
            return {
                "success": True,
                "instanceId": instance_id,
                "eventName": event_name,
                "ignored": True,
            }
        logger.exception(
            "Failed to raise evaluation event %s for %s", event_name, instance_id
        )
        raise HTTPException(status_code=500, detail=str(exc)) from exc
    return {"success": True, "instanceId": instance_id, "eventName": event_name}

from __future__ import annotations

import json
import os
import re
from datetime import UTC, datetime
from hashlib import sha256
from typing import Any
from uuid import uuid4

from fastapi import FastAPI, HTTPException, Request, status
from pydantic import BaseModel, Field

KUEUE_QUEUE_LABEL = "kueue.x-k8s.io/queue-name"
DEFAULT_NODE_SELECTOR = {"stacks.io/swebench-pool": "dev-benchmark"}
DEFAULT_JOB_TTL_SECONDS = 300
WORKER_ENV_PASSTHROUGH = (
    "SANDBOX_EXECUTION_CALLBACK_ATTEMPTS",
    "SANDBOX_EXECUTION_CALLBACK_BACKOFF_SECONDS",
    "SANDBOX_EXECUTION_WORKER_POLL_SECONDS",
    "SANDBOX_EXECUTION_WORKFLOW_START_ATTEMPTS",
    "SANDBOX_EXECUTION_WORKFLOW_START_BACKOFF_SECONDS",
    "SANDBOX_EXECUTION_WORKFLOW_START_MAX_BACKOFF_SECONDS",
    "SANDBOX_EXECUTION_WORKFLOW_START_STAGGER_SECONDS",
    "SANDBOX_EXECUTION_WORKFLOW_START_TIMEOUT_SECONDS",
)
DEFAULT_WORKER_IMAGE = "ghcr.io/pittampalliorg/sandbox-execution-api:latest"

app = FastAPI(title="sandbox-execution-api")


class ExecutionCallback(BaseModel):
    path: str


class ExecutionRequest(BaseModel):
    kind: str = Field(default="swebench-instance")
    runId: str
    instanceId: str
    workflowId: str
    workflowExecutionId: str
    executionClass: str = Field(default="benchmark-fast")
    timeoutSeconds: int = Field(default=7200, ge=60, le=86400)
    workflow: dict[str, Any]
    triggerData: dict[str, Any] = Field(default_factory=dict)
    inferenceEnvironment: dict[str, Any] = Field(default_factory=dict)
    callback: ExecutionCallback


class ExecutionClassConfig(BaseModel):
    localQueue: str
    runtimeClassName: str | None = None
    workerImage: str = DEFAULT_WORKER_IMAGE
    serviceAccountName: str = "sandbox-execution-worker"
    imagePullSecrets: list[str] = Field(default_factory=lambda: ["ghcr-pull-credentials"])
    nodeSelector: dict[str, str] = Field(
        default_factory=lambda: DEFAULT_NODE_SELECTOR.copy()
    )
    cpu: str = "100m"
    memory: str = "256Mi"
    ephemeralStorage: str = "1Gi"
    ttlSecondsAfterFinished: int | None = Field(default=None, ge=0, le=86400)


def _safe_name(value: str, *, max_length: int = 52) -> str:
    normalized = re.sub(r"[^a-z0-9-]+", "-", value.lower()).strip("-")
    return (normalized or "execution")[:max_length].strip("-") or "execution"


def _safe_resource_name(value: str, *, max_length: int = 63) -> str:
    normalized = re.sub(r"[^a-z0-9-]+", "-", value.lower()).strip("-") or "execution"
    if len(normalized) <= max_length:
        return normalized
    digest = sha256(normalized.encode("utf-8")).hexdigest()[:10]
    prefix_length = max_length - len(digest) - 1
    prefix = normalized[:prefix_length].strip("-") or "execution"
    return f"{prefix}-{digest}"


def _load_execution_classes() -> dict[str, ExecutionClassConfig]:
    defaults = {
        "benchmark-fast": ExecutionClassConfig(localQueue="benchmark-fast"),
        "secure-gvisor": ExecutionClassConfig(
            localQueue="secure-gvisor",
            runtimeClassName=os.environ.get(
                "SANDBOX_EXECUTION_GVISOR_RUNTIME_CLASS",
                "secure-gvisor",
            ),
        ),
    }
    raw = os.environ.get("SANDBOX_EXECUTION_CLASSES_JSON", "").strip()
    if not raw:
        return defaults
    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError:
        return defaults
    if not isinstance(parsed, dict):
        return defaults
    merged = defaults.copy()
    for name, value in parsed.items():
        if not isinstance(name, str) or not isinstance(value, dict):
            continue
        base = merged.get(name, ExecutionClassConfig(localQueue=_safe_name(name)))
        merged[name] = base.model_copy(update=value)
    return merged


def _job_ttl_seconds(class_config: ExecutionClassConfig) -> int:
    if class_config.ttlSecondsAfterFinished is not None:
        return class_config.ttlSecondsAfterFinished
    raw = os.environ.get(
        "SANDBOX_EXECUTION_JOB_TTL_SECONDS",
        str(DEFAULT_JOB_TTL_SECONDS),
    )
    try:
        ttl = int(raw)
    except ValueError:
        return DEFAULT_JOB_TTL_SECONDS
    return max(0, min(86400, ttl))


def _worker_payload(request: ExecutionRequest, execution_id: str) -> dict[str, Any]:
    return {
        "executionId": execution_id,
        "kind": request.kind,
        "runId": request.runId,
        "instanceId": request.instanceId,
        "workflowId": request.workflowId,
        "workflowExecutionId": request.workflowExecutionId,
        "executionClass": request.executionClass,
        "timeoutSeconds": request.timeoutSeconds,
        "workflow": request.workflow,
        "triggerData": request.triggerData,
        "inferenceEnvironment": request.inferenceEnvironment,
        "callback": request.callback.model_dump(),
    }


def _payload_configmap_name(request: ExecutionRequest, execution_id: str) -> str:
    return _safe_resource_name(
        f"sandbox-payload-{request.runId}-{request.instanceId}-{execution_id}",
        max_length=63,
    )


def build_payload_configmap_manifest(
    request: ExecutionRequest,
    *,
    execution_id: str,
    namespace: str,
) -> dict[str, Any]:
    run_label = _safe_name(request.runId, max_length=63)
    instance_label = _safe_name(request.instanceId, max_length=63)
    payload = json.dumps(_worker_payload(request, execution_id), separators=(",", ":"))
    return {
        "apiVersion": "v1",
        "kind": "ConfigMap",
        "metadata": {
            "name": _payload_configmap_name(request, execution_id),
            "namespace": namespace,
            "labels": {
                "app": "sandbox-execution-worker",
                "benchmark-run-id": run_label,
                "benchmark-instance-id": instance_label,
                "sandbox-execution-class": _safe_name(request.executionClass),
            },
        },
        "data": {"request.json": payload},
    }


def build_job_manifest(
    request: ExecutionRequest,
    *,
    execution_id: str,
    namespace: str,
    class_config: ExecutionClassConfig,
) -> dict[str, Any]:
    run_label = _safe_name(request.runId, max_length=63)
    instance_label = _safe_name(request.instanceId, max_length=63)
    job_name = _safe_resource_name(
        f"sandbox-{request.runId}-{request.instanceId}-{execution_id}",
        max_length=63,
    )
    payload_configmap_name = _payload_configmap_name(request, execution_id)
    payload_path = "/var/run/sandbox-execution/request.json"
    worker_env: list[dict[str, Any]] = [
        {"name": "EXECUTION_REQUEST_PATH", "value": payload_path},
        {
            "name": "WORKFLOW_BUILDER_URL",
            "value": os.environ.get("WORKFLOW_BUILDER_URL", ""),
        },
        {
            "name": "WORKFLOW_ORCHESTRATOR_URL",
            "value": os.environ.get(
                "WORKFLOW_ORCHESTRATOR_URL",
                "http://workflow-orchestrator.workflow-builder.svc.cluster.local:8080",
            ),
        },
        {
            "name": "INTERNAL_API_TOKEN",
            "valueFrom": {
                "secretKeyRef": {
                    "name": os.environ.get(
                        "INTERNAL_API_SECRET_NAME",
                        "workflow-builder-secrets",
                    ),
                    "key": os.environ.get(
                        "INTERNAL_API_SECRET_KEY",
                        "INTERNAL_API_TOKEN",
                    ),
                }
            },
        },
    ]
    for env_name in WORKER_ENV_PASSTHROUGH:
        env_value = os.environ.get(env_name)
        if env_value:
            worker_env.append({"name": env_name, "value": env_value})
    pod_spec: dict[str, Any] = {
        "restartPolicy": "Never",
        "serviceAccountName": class_config.serviceAccountName,
        "nodeSelector": class_config.nodeSelector,
        "topologySpreadConstraints": [
            {
                "maxSkew": 1,
                "topologyKey": "kubernetes.io/hostname",
                "whenUnsatisfiable": "ScheduleAnyway",
                "labelSelector": {
                    "matchLabels": {
                        "app": "sandbox-execution-worker",
                        "benchmark-run-id": run_label,
                    }
                },
            }
        ],
        "containers": [
            {
                "name": "worker",
                "image": class_config.workerImage,
                "command": ["python", "-m", "src.worker"],
                "env": worker_env,
                "volumeMounts": [
                    {
                        "name": "execution-request",
                        "mountPath": payload_path,
                        "subPath": "request.json",
                        "readOnly": True,
                    }
                ],
                "resources": {
                    "requests": {
                        "cpu": class_config.cpu,
                        "memory": class_config.memory,
                        "ephemeral-storage": class_config.ephemeralStorage,
                    }
                },
            }
        ],
        "volumes": [
            {
                "name": "execution-request",
                "configMap": {
                    "name": payload_configmap_name,
                    "items": [{"key": "request.json", "path": "request.json"}],
                },
            }
        ],
    }
    if class_config.imagePullSecrets:
        pod_spec["imagePullSecrets"] = [
            {"name": name} for name in class_config.imagePullSecrets if name
        ]
    if class_config.runtimeClassName:
        pod_spec["runtimeClassName"] = class_config.runtimeClassName
    return {
        "apiVersion": "batch/v1",
        "kind": "Job",
        "metadata": {
            "name": job_name,
            "namespace": namespace,
            "labels": {
                "app": "sandbox-execution-worker",
                KUEUE_QUEUE_LABEL: class_config.localQueue,
                "benchmark-run-id": run_label,
                "benchmark-instance-id": instance_label,
                "sandbox-execution-class": _safe_name(request.executionClass),
            },
        },
        "spec": {
            "backoffLimit": 0,
            "activeDeadlineSeconds": request.timeoutSeconds + 300,
            "ttlSecondsAfterFinished": _job_ttl_seconds(class_config),
            "template": {
                "metadata": {
                    "labels": {
                        "app": "sandbox-execution-worker",
                        "benchmark-run-id": run_label,
                        "benchmark-instance-id": instance_label,
                    }
                },
                "spec": pod_spec,
            },
        },
    }


def _load_k8s_clients():
    from kubernetes import client, config

    try:
        config.load_incluster_config()
    except Exception:
        config.load_kube_config()
    return client.BatchV1Api(), client.CoreV1Api()


def _require_internal(request: Request) -> None:
    expected = os.environ.get("SANDBOX_EXECUTION_API_TOKEN") or os.environ.get(
        "INTERNAL_API_TOKEN"
    )
    if not expected:
        return
    token = request.headers.get("authorization", "").removeprefix("Bearer ").strip()
    if token != expected:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="invalid token")


@app.get("/healthz")
def healthz() -> dict[str, Any]:
    return {"ok": True, "time": datetime.now(UTC).isoformat()}


@app.post("/api/v1/executions", status_code=status.HTTP_202_ACCEPTED)
def submit_execution(request: Request, body: ExecutionRequest) -> dict[str, Any]:
    _require_internal(request)
    classes = _load_execution_classes()
    class_config = classes.get(body.executionClass)
    if class_config is None:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"unsupported executionClass {body.executionClass}",
        )
    namespace = os.environ.get("SANDBOX_EXECUTION_NAMESPACE", "sandbox-execution")
    execution_id = f"hexec-{uuid4().hex[:16]}"
    payload_manifest = build_payload_configmap_manifest(
        body,
        execution_id=execution_id,
        namespace=namespace,
    )
    manifest = build_job_manifest(
        body,
        execution_id=execution_id,
        namespace=namespace,
        class_config=class_config,
    )
    if os.environ.get("SANDBOX_EXECUTION_DRY_RUN", "").lower() not in {
        "1",
        "true",
        "yes",
    }:
        batch, core = _load_k8s_clients()
        core.create_namespaced_config_map(namespace=namespace, body=payload_manifest)
        try:
            job = batch.create_namespaced_job(namespace=namespace, body=manifest)
        except Exception:
            try:
                core.delete_namespaced_config_map(
                    name=payload_manifest["metadata"]["name"],
                    namespace=namespace,
                )
            except Exception:
                pass
            raise
        job_uid = getattr(getattr(job, "metadata", None), "uid", None)
        if job_uid:
            core.patch_namespaced_config_map(
                name=payload_manifest["metadata"]["name"],
                namespace=namespace,
                body={
                    "metadata": {
                        "ownerReferences": [
                            {
                                "apiVersion": "batch/v1",
                                "kind": "Job",
                                "name": manifest["metadata"]["name"],
                                "uid": job_uid,
                                "controller": False,
                                "blockOwnerDeletion": False,
                            }
                        ]
                    }
                },
            )
    return {
        "executionId": execution_id,
        "jobName": manifest["metadata"]["name"],
        "status": "queued",
        "executionClass": body.executionClass,
        "localQueue": class_config.localQueue,
        "runtimeClassName": class_config.runtimeClassName,
    }

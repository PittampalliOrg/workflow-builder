from __future__ import annotations

import json
import logging
import os
import re
import time
from datetime import UTC, datetime
from hashlib import sha256
from typing import Any
from uuid import uuid4

from fastapi import FastAPI, HTTPException, Request, status
from pydantic import BaseModel, Field

KUEUE_QUEUE_LABEL = "kueue.x-k8s.io/queue-name"
DEFAULT_NODE_SELECTOR = {"stacks.io/swebench-pool": "dev-benchmark"}
DEFAULT_JOB_TTL_SECONDS = 300
DEFAULT_AGENT_HOST_IMAGE = "ghcr.io/pittampalliorg/dapr-agent-py-sandbox:latest"
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

logger = logging.getLogger("sandbox-execution-api")
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
    agentHostImage: str = DEFAULT_AGENT_HOST_IMAGE
    agentHostCpu: str = "500m"
    agentHostMemory: str = "1Gi"
    agentHostEphemeralStorage: str = "2Gi"
    ttlSecondsAfterFinished: int | None = Field(default=None, ge=0, le=86400)


class AgentWorkflowHostRequest(BaseModel):
    sessionId: str
    agentAppId: str
    runId: str | None = None
    instanceId: str | None = None
    executionClass: str = Field(default="benchmark-fast")
    timeoutSeconds: int = Field(default=7200, ge=60, le=86400)
    agentImage: str | None = None
    waitReadySeconds: int = Field(default=0, ge=0, le=300)


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


def _load_k8s_custom_objects_client():
    from kubernetes import client, config

    try:
        config.load_incluster_config()
    except Exception:
        config.load_kube_config()
    return client.CustomObjectsApi()


def _require_internal(request: Request) -> None:
    expected = os.environ.get("SANDBOX_EXECUTION_API_TOKEN") or os.environ.get(
        "INTERNAL_API_TOKEN"
    )
    if not expected:
        return
    token = request.headers.get("authorization", "").removeprefix("Bearer ").strip()
    if token != expected:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="invalid token")


def _openshell_seed_init_container(image: str) -> dict[str, Any]:
    return {
        "name": "seed-openshell-config",
        "image": image,
        "imagePullPolicy": "IfNotPresent",
        "command": ["sh", "-c"],
        "args": [
            """
set -eu
CONFIG_ROOT="${XDG_CONFIG_HOME}/openshell"
GATEWAY_DIR="${CONFIG_ROOT}/gateways/${OPENSHELL_GATEWAY_NAME}"
MTLS_DIR="${GATEWAY_DIR}/mtls"

install -d -m 700 "${MTLS_DIR}"
cat >"${GATEWAY_DIR}/metadata.json" <<EOF
{
  "name": "${OPENSHELL_GATEWAY_NAME}",
  "gateway_endpoint": "${OPENSHELL_GATEWAY_URL}",
  "is_remote": false,
  "gateway_port": ${OPENSHELL_GATEWAY_PORT},
  "auth_mode": "mtls"
}
EOF
printf '%s\n' "${OPENSHELL_GATEWAY_NAME}" > "${CONFIG_ROOT}/active_gateway"

cp /etc/openshell-tls/client/tls.crt "${MTLS_DIR}/tls.crt"
cp /etc/openshell-tls/client/tls.key "${MTLS_DIR}/tls.key"
if [ -f /etc/openshell-tls/client/ca.crt ]; then
  cp /etc/openshell-tls/client/ca.crt "${MTLS_DIR}/ca.crt"
else
  cp /etc/openshell-tls/client-ca/tls.crt "${MTLS_DIR}/ca.crt"
fi

chmod 644 "${MTLS_DIR}/ca.crt" "${MTLS_DIR}/tls.crt"
chmod 600 "${MTLS_DIR}/tls.key"
""".strip()
        ],
        "env": [
            {"name": "XDG_CONFIG_HOME", "value": "/root/.config"},
            {
                "name": "OPENSHELL_GATEWAY_URL",
                "value": os.environ.get(
                    "OPENSHELL_GATEWAY_URL",
                    "https://openshell.openshell.svc.cluster.local:8080",
                ),
            },
            {
                "name": "OPENSHELL_GATEWAY_NAME",
                "value": os.environ.get("OPENSHELL_GATEWAY_NAME", "dev-internal"),
            },
            {
                "name": "OPENSHELL_GATEWAY_PORT",
                "value": os.environ.get("OPENSHELL_GATEWAY_PORT", "8080"),
            },
        ],
        "resources": {
            "requests": {"memory": "64Mi", "cpu": "50m"},
            "limits": {"memory": "256Mi", "cpu": "250m"},
        },
        "volumeMounts": [
            {"name": "openshell-config", "mountPath": "/root/.config"},
            {
                "name": "openshell-client-tls",
                "mountPath": "/etc/openshell-tls/client",
                "readOnly": True,
            },
            {
                "name": "openshell-client-ca",
                "mountPath": "/etc/openshell-tls/client-ca",
                "readOnly": True,
            },
        ],
    }


def _agent_host_job_name(agent_app_id: str) -> str:
    return _safe_resource_name(f"agent-host-{agent_app_id}", max_length=63)


def _agent_host_backoff_limit() -> int:
    try:
        return max(
            0,
            int(os.environ.get("SANDBOX_EXECUTION_AGENT_HOST_BACKOFF_LIMIT", "1")),
        )
    except ValueError:
        return 1


def build_agent_workflow_host_job_manifest(
    request: AgentWorkflowHostRequest,
    *,
    namespace: str,
    class_config: ExecutionClassConfig,
) -> dict[str, Any]:
    run_label = _safe_name(request.runId or "manual", max_length=63)
    instance_label = _safe_name(request.instanceId or request.sessionId, max_length=63)
    app_label = _safe_name(request.agentAppId, max_length=63)
    image = request.agentImage or class_config.agentHostImage
    pod_spec: dict[str, Any] = {
        "restartPolicy": "Never",
        "serviceAccountName": class_config.serviceAccountName,
        "terminationGracePeriodSeconds": 90,
        "nodeSelector": class_config.nodeSelector,
        "topologySpreadConstraints": [
            {
                "maxSkew": 1,
                "topologyKey": "kubernetes.io/hostname",
                "whenUnsatisfiable": "ScheduleAnyway",
                "labelSelector": {
                    "matchLabels": {
                        "app": "agent-workflow-host",
                        "benchmark-run-id": run_label,
                    }
                },
            }
        ],
        "initContainers": [_openshell_seed_init_container(image)],
        "containers": [
            {
                "name": "dapr-agent-py",
                "image": image,
                "imagePullPolicy": "IfNotPresent",
                "ports": [{"name": "http", "containerPort": 8002}],
                "env": [
                    {"name": "AGENT_SERVICE_NAME", "value": request.agentAppId},
                    {"name": "AGENT_SLUG", "value": request.agentAppId},
                    {"name": "XDG_CONFIG_HOME", "value": "/root/.config"},
                    {"name": "DAPR_LLM_COMPONENT_DEFAULT", "value": "llm-anthropic-opus"},
                    {"name": "DAPR_AGENT_PY_HOOKS_ENABLED", "value": "true"},
                    {"name": "DAPR_AGENT_PY_PLUGINS_ENABLED", "value": "true"},
                    {
                        "name": "DAPR_AGENT_PY_PLUGIN_PATHS",
                        "value": "/etc/dapr-agent-py/plugins",
                    },
                    {"name": "DAPR_AGENT_PY_BOOTSTRAP_MCP_SERVERS_JSON", "value": "[]"},
                    {"name": "AGENT_CALL_AGENT_NATIVE", "value": "1"},
                    {
                        "name": "WORKFLOW_BUILDER_URL",
                        "value": os.environ.get(
                            "WORKFLOW_BUILDER_URL",
                            "http://workflow-builder.workflow-builder.svc.cluster.local:3000",
                        ),
                    },
                    {"name": "DAPR_HTTP_ENDPOINT", "value": "http://localhost:3500"},
                    {"name": "DAPR_GRPC_ENDPOINT", "value": "dns:localhost:50001"},
                    {
                        "name": "DAPR_WORKFLOW_GRPC_MAX_MESSAGE_BYTES",
                        "value": os.environ.get(
                            "DAPR_WORKFLOW_GRPC_MAX_MESSAGE_BYTES", "16777216"
                        ),
                    },
                    {
                        "name": "DAPR_WORKFLOW_MAX_CONCURRENT_ORCHESTRATIONS",
                        "value": os.environ.get(
                            "DAPR_AGENT_HOST_MAX_CONCURRENT_ORCHESTRATIONS",
                            "16",
                        ),
                    },
                    {
                        "name": "DAPR_WORKFLOW_MAX_CONCURRENT_ACTIVITIES",
                        "value": os.environ.get(
                            "DAPR_AGENT_HOST_MAX_CONCURRENT_ACTIVITIES",
                            "48",
                        ),
                    },
                    {
                        "name": "DAPR_WORKFLOW_MAX_THREAD_POOL_WORKERS",
                        "value": os.environ.get(
                            "DAPR_AGENT_HOST_MAX_THREAD_POOL_WORKERS",
                            "16",
                        ),
                    },
                    {
                        "name": "DAPR_AGENT_SESSION_HOST_INSTANCE_ID",
                        "value": request.sessionId,
                    },
                    {
                        "name": "DAPR_AGENT_SESSION_HOST_START_TIMEOUT_SECONDS",
                        "value": str(min(request.timeoutSeconds, 1800)),
                    },
                    {
                        "name": "DAPR_AGENT_SESSION_HOST_IDLE_TIMEOUT_SECONDS",
                        "value": os.environ.get(
                            "DAPR_AGENT_SESSION_HOST_IDLE_TIMEOUT_SECONDS",
                            "900",
                        ),
                    },
                    {
                        "name": "DAPR_AGENT_SESSION_HOST_MISSING_GRACE_SECONDS",
                        "value": os.environ.get(
                            "DAPR_AGENT_SESSION_HOST_MISSING_GRACE_SECONDS",
                            "60",
                        ),
                    },
                    {
                        "name": "DAPR_AGENT_SESSION_HOST_SIDECAR_READY_TIMEOUT_SECONDS",
                        "value": os.environ.get(
                            "DAPR_AGENT_SESSION_HOST_SIDECAR_READY_TIMEOUT_SECONDS",
                            "120",
                        ),
                    },
                    {
                        "name": "DAPR_AGENT_SESSION_HOST_SHUTDOWN_SIDECAR_ON_EXIT",
                        "value": os.environ.get(
                            "DAPR_AGENT_SESSION_HOST_SHUTDOWN_SIDECAR_ON_EXIT",
                            "true",
                        ),
                    },
                ],
                "envFrom": [
                    {"configMapRef": {"name": "dapr-agent-py-config", "optional": True}},
                    {"secretRef": {"name": "dapr-agent-py-secrets", "optional": True}},
                    {"secretRef": {"name": "workflow-checkpoint-gitea", "optional": True}},
                ],
                "resources": {
                    "requests": {
                        "cpu": class_config.agentHostCpu,
                        "memory": class_config.agentHostMemory,
                        "ephemeral-storage": class_config.agentHostEphemeralStorage,
                    }
                },
                "startupProbe": {
                    "httpGet": {"path": "/healthz", "port": 8002},
                    "initialDelaySeconds": 10,
                    "periodSeconds": 10,
                    "failureThreshold": 18,
                },
                "livenessProbe": {
                    "httpGet": {"path": "/healthz", "port": 8002},
                    "periodSeconds": 30,
                },
                "readinessProbe": {
                    "httpGet": {"path": "/readyz", "port": 8002},
                    "periodSeconds": 10,
                },
                "volumeMounts": [
                    {"name": "openshell-config", "mountPath": "/root/.config"},
                    {"name": "sandbox", "mountPath": "/sandbox"},
                ],
            }
        ],
        "volumes": [
            {"name": "openshell-config", "emptyDir": {}},
            {"name": "sandbox", "emptyDir": {}},
            {"name": "openshell-client-tls", "secret": {"secretName": "openshell-client-tls"}},
            {
                "name": "openshell-client-ca",
                "secret": {"secretName": "openshell-server-client-ca"},
            },
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
            "name": _agent_host_job_name(request.agentAppId),
            "namespace": namespace,
            "labels": {
                "app": "agent-workflow-host",
                KUEUE_QUEUE_LABEL: class_config.localQueue,
                "benchmark-run-id": run_label,
                "benchmark-instance-id": instance_label,
                "agent-app-id": app_label,
                "sandbox-execution-class": _safe_name(request.executionClass),
            },
        },
        "spec": {
            "backoffLimit": _agent_host_backoff_limit(),
            "activeDeadlineSeconds": request.timeoutSeconds + 600,
            "ttlSecondsAfterFinished": _job_ttl_seconds(class_config),
            "template": {
                "metadata": {
                    "labels": {
                        "app": "agent-workflow-host",
                        "benchmark-run-id": run_label,
                        "benchmark-instance-id": instance_label,
                        "agent-app-id": app_label,
                    },
                    "annotations": {
                        "dapr.io/enabled": "true",
                        "dapr.io/app-id": request.agentAppId,
                        "dapr.io/app-port": "8002",
                        "dapr.io/app-protocol": "http",
                        "dapr.io/config": os.environ.get(
                            "DAPR_AGENT_HOST_CONFIG",
                            "workflow-builder-agent-runtime",
                        ),
                        "dapr.io/enable-workflow": "true",
                        "dapr.io/enable-native-sidecar": "true",
                        "dapr.io/placement-host-address": os.environ.get(
                            "DAPR_PLACEMENT_HOST_ADDRESS",
                            "dapr-placement-server.dapr-system.svc.cluster.local:50005",
                        ),
                        "dapr.io/max-body-size": os.environ.get(
                            "DAPR_MAX_BODY_SIZE", "16Mi"
                        ),
                        "dapr.io/graceful-shutdown-seconds": "60",
                        "dapr.io/sidecar-readiness-probe-delay-seconds": "0",
                        "dapr.io/sidecar-readiness-probe-period-seconds": "1",
                        "dapr.io/sidecar-readiness-probe-timeout-seconds": "1",
                    },
                },
                "spec": pod_spec,
            },
        },
    }


def _component_scopes(
    custom: Any,
    *,
    namespace: str,
    component_name: str,
) -> list[str] | None:
    component = custom.get_namespaced_custom_object(
        group="dapr.io",
        version="v1alpha1",
        namespace=namespace,
        plural="components",
        name=component_name,
    )
    scopes = component.get("scopes")
    if scopes is None:
        return None
    if not isinstance(scopes, list):
        return []
    return [entry for entry in scopes if isinstance(entry, str)]


def _patch_component_scope(namespace: str, component_name: str, app_id: str) -> None:
    custom = _load_k8s_custom_objects_client()
    for _attempt in range(5):
        scopes = _component_scopes(
            custom,
            namespace=namespace,
            component_name=component_name,
        )
        if scopes is None or app_id in scopes:
            return
        patch = [{"op": "add", "path": "/scopes/-", "value": app_id}]
        custom.api_client.call_api(
            "/apis/{group}/{version}/namespaces/{namespace}/{plural}/{name}",
            "PATCH",
            {
                "group": "dapr.io",
                "version": "v1alpha1",
                "namespace": namespace,
                "plural": "components",
                "name": component_name,
            },
            [],
            {
                "Accept": "application/json",
                "Content-Type": "application/json-patch+json",
            },
            body=patch,
            response_type="object",
            auth_settings=["BearerToken"],
            _return_http_data_only=True,
        )
        scopes = _component_scopes(
            custom,
            namespace=namespace,
            component_name=component_name,
        )
        if scopes is None or app_id in scopes:
            return
        time.sleep(0.1)
    raise RuntimeError(
        f"failed to add app id {app_id!r} to Dapr component {component_name!r} scopes"
    )


def _ensure_agent_host_component_scopes(namespace: str, app_id: str) -> None:
    raw = os.environ.get(
        "SANDBOX_EXECUTION_AGENT_HOST_SCOPED_COMPONENTS",
        "workflowstatestore,dapr-agent-py-statestore",
    )
    for component_name in [part.strip() for part in raw.split(",") if part.strip()]:
        _patch_component_scope(namespace, component_name, app_id)


def _pod_is_ready(pod: Any) -> bool:
    conditions = getattr(getattr(pod, "status", None), "conditions", None) or []
    for condition in conditions:
        if getattr(condition, "type", None) == "Ready":
            return getattr(condition, "status", None) == "True"
    return False


def _pod_failure_reason(pod: Any) -> str | None:
    status = getattr(pod, "status", None)
    phase = getattr(status, "phase", None)
    if phase == "Failed":
        return getattr(status, "reason", None) or "pod failed"
    container_statuses = getattr(status, "container_statuses", None) or []
    for container_status in container_statuses:
        state = getattr(container_status, "state", None)
        waiting = getattr(state, "waiting", None)
        if waiting and getattr(waiting, "reason", None) in {
            "CrashLoopBackOff",
            "CreateContainerConfigError",
            "CreateContainerError",
            "ErrImagePull",
            "ImagePullBackOff",
        }:
            reason = getattr(waiting, "reason", None)
            message = getattr(waiting, "message", None)
            return f"{reason}: {message}" if message else reason
        terminated = getattr(state, "terminated", None)
        if terminated and getattr(terminated, "exit_code", 0) != 0:
            reason = getattr(terminated, "reason", None) or "container terminated"
            return f"{reason}: exit {terminated.exit_code}"
    return None


def _job_failure_reason(batch: Any, *, namespace: str, job_name: str) -> str | None:
    try:
        job = batch.read_namespaced_job(name=job_name, namespace=namespace)
    except Exception:
        return None
    job_status = getattr(job, "status", None)
    conditions = getattr(job_status, "conditions", None) or []
    for condition in conditions:
        if (
            getattr(condition, "type", None) == "Failed"
            and getattr(condition, "status", None) == "True"
        ):
            reason = getattr(condition, "reason", None) or "job failed"
            message = getattr(condition, "message", None)
            return f"{reason}: {message}" if message else reason
    return None


def _wait_for_agent_host_ready(
    core: Any,
    *,
    namespace: str,
    agent_app_id: str,
    wait_seconds: int,
    batch: Any | None = None,
    job_name: str | None = None,
) -> str:
    if wait_seconds <= 0:
        return "queued"
    selector = f"app=agent-workflow-host,agent-app-id={_safe_name(agent_app_id, max_length=63)}"
    deadline = time.monotonic() + wait_seconds
    last_phase = "pending"
    last_failure: str | None = None
    while time.monotonic() < deadline:
        if batch is not None and job_name:
            job_failure = _job_failure_reason(
                batch,
                namespace=namespace,
                job_name=job_name,
            )
            if job_failure:
                raise HTTPException(
                    status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                    detail=f"agent workflow host {agent_app_id} job failed before readiness: {job_failure}",
                )
        pods = core.list_namespaced_pod(
            namespace=namespace,
            label_selector=selector,
        ).items
        for pod in pods:
            failure = _pod_failure_reason(pod)
            if failure:
                last_failure = failure
                continue
            if _pod_is_ready(pod):
                return "ready"
            phase = getattr(getattr(pod, "status", None), "phase", None)
            if phase:
                last_phase = phase
        time.sleep(1)
    logger.info(
        "agent workflow host %s was not ready after %ss; last phase %s; last failure %s",
        agent_app_id,
        wait_seconds,
        last_phase,
        last_failure,
    )
    return "queued"


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


@app.post("/api/v1/agent-workflow-hosts", status_code=status.HTTP_202_ACCEPTED)
def submit_agent_workflow_host(
    request: Request,
    body: AgentWorkflowHostRequest,
) -> dict[str, Any]:
    _require_internal(request)
    classes = _load_execution_classes()
    class_config = classes.get(body.executionClass)
    if class_config is None:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"unsupported executionClass {body.executionClass}",
        )
    namespace = os.environ.get("SANDBOX_EXECUTION_NAMESPACE", "workflow-builder")
    manifest = build_agent_workflow_host_job_manifest(
        body,
        namespace=namespace,
        class_config=class_config,
    )
    if os.environ.get("SANDBOX_EXECUTION_DRY_RUN", "").lower() not in {
        "1",
        "true",
        "yes",
    }:
        batch, core = _load_k8s_clients()
        _ensure_agent_host_component_scopes(namespace, body.agentAppId)
        try:
            batch.create_namespaced_job(namespace=namespace, body=manifest)
        except Exception as exc:
            if getattr(exc, "status", None) != 409:
                raise
        readiness_status = _wait_for_agent_host_ready(
            core,
            namespace=namespace,
            agent_app_id=body.agentAppId,
            wait_seconds=body.waitReadySeconds,
            batch=batch,
            job_name=manifest["metadata"]["name"],
        )
    else:
        readiness_status = "queued"
    return {
        "agentAppId": body.agentAppId,
        "sessionId": body.sessionId,
        "jobName": manifest["metadata"]["name"],
        "status": readiness_status,
        "executionClass": body.executionClass,
        "localQueue": class_config.localQueue,
        "runtimeClassName": class_config.runtimeClassName,
    }

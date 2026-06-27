from __future__ import annotations

import json
import logging
import os
import re
import time
from datetime import UTC, datetime, timedelta
from hashlib import sha256
from typing import Any
from uuid import uuid4

from fastapi import FastAPI, HTTPException, Request, status
from pydantic import BaseModel, Field

from src.content_tracing import set_current_span_io

KUEUE_QUEUE_LABEL = "kueue.x-k8s.io/queue-name"
KUEUE_PRIORITY_CLASS_LABEL = "kueue.x-k8s.io/priority-class"
DEFAULT_NODE_SELECTOR = {"stacks.io/swebench-pool": "dev-benchmark"}
DEFAULT_JOB_TTL_SECONDS = 300
DEFAULT_AGENT_HOST_SHUTDOWN_BUFFER_SECONDS = 1800
DEFAULT_AGENT_HOST_IMAGE = "ghcr.io/pittampalliorg/dapr-agent-py-sandbox:latest"
DEFAULT_AGENT_HOST_CONFIG_HOME = "/root/.config"
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
        "service.name", os.environ.get("OTEL_SERVICE_NAME", "sandbox-execution-api")
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
        from opentelemetry.exporter.otlp.proto.http.trace_exporter import (
            OTLPSpanExporter,
        )
        from opentelemetry.instrumentation.requests import RequestsInstrumentor
        from opentelemetry.sdk.resources import Resource
        from opentelemetry.sdk.trace import TracerProvider
        from opentelemetry.sdk.trace.export import BatchSpanProcessor

        provider = TracerProvider(resource=Resource.create(_otel_resource_attributes()))
        provider.add_span_processor(
            BatchSpanProcessor(
                OTLPSpanExporter(endpoint=_otel_trace_endpoint(endpoint))
            )
        )
        trace.set_tracer_provider(provider)
        RequestsInstrumentor().instrument()
        _otel_ready = True
        logger.info("OpenTelemetry tracing initialized -> %s", endpoint)
    except Exception as exc:
        logger.warning("OpenTelemetry init failed: %s", exc)


_init_otel()

app = FastAPI(title="sandbox-execution-api")

if _otel_ready:
    try:
        from opentelemetry.instrumentation.fastapi import FastAPIInstrumentor

        FastAPIInstrumentor.instrument_app(app, excluded_urls="healthz")
        logger.info("FastAPI OpenTelemetry instrumentation applied")
    except Exception as exc:
        logger.warning("FastAPI OpenTelemetry instrumentation failed: %s", exc)


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
    mlflowContext: dict[str, Any] | None = None
    traceContext: dict[str, str] | None = None
    inferenceEnvironment: dict[str, Any] = Field(default_factory=dict)
    # Maps to kueue.x-k8s.io/priority-class on the Job and pod template.
    priorityClass: str | None = None
    callback: ExecutionCallback


class ExecutionClassConfig(BaseModel):
    localQueue: str
    runtimeClassName: str | None = None
    priorityClass: str | None = None
    priorityClassName: str | None = None
    workerImage: str = DEFAULT_WORKER_IMAGE
    serviceAccountName: str = "sandbox-execution-worker"
    imagePullSecrets: list[str] = Field(
        default_factory=lambda: ["ghcr-pull-credentials"]
    )
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
    agentHostCpuLimit: str | None = None
    agentHostMemoryLimit: str | None = None
    agentHostEphemeralStorageLimit: str | None = None
    agentHostEnv: dict[str, str] = Field(default_factory=dict)
    agentHostNonterminalTimeoutAction: str | None = None
    ttlSecondsAfterFinished: int | None = Field(default=None, ge=0, le=86400)
    # When not None, REPLACES the hardcoded envFrom list on the agent-host
    # container verbatim. Used by classes whose pods must not see the
    # dapr-agent-py config/secrets (e.g. interactive-cli, where a leaked
    # ANTHROPIC_API_KEY would silently flip billing from subscription to API).
    agentHostEnvFrom: list[dict[str, Any]] | None = None
    # Skip the seed-openshell-config init container AND its
    # openshell-client-tls / openshell-client-ca volumes/mounts (for runtimes
    # that don't use OpenShell tools).
    omitOpenshellSeedInit: bool = False
    # Pod-level securityContext, set verbatim when provided.
    podSecurityContext: dict[str, Any] | None = None
    # Non-root home for the agent-host container. When set, HOME=<home> and
    # XDG_CONFIG_HOME=<home>/.config (and the openshell-config emptyDir mounts
    # there). Default keeps the historical /root/.config with no HOME env.
    agentHostUserHome: str | None = None
    # Per-session durable transcript store (interactive-cli runtime family).
    # When transcriptStoreCsiDriver is set, the create handler provisions a
    # static per-session PV+PVC (CSI subPath = the conversation key) and the
    # builder mounts it at transcriptStoreMountPath. cli-agent-py symlinks the
    # CLI's transcript dir into the mount, so ONLY the conversation transcript
    # persists (Postgres-backed JuiceFS); credentials/onboarding state stay on
    # the ephemeral emptyDir. The PV uses a non-`pvc-<uuid>` volumeHandle so the
    # driver treats it as static -> reclaim `Delete` is a no-op on the backing
    # data (the subtree survives in Postgres for `--resume`).
    transcriptStoreCsiDriver: str | None = None
    transcriptStoreSecretName: str | None = None
    transcriptStoreSecretNamespace: str | None = None
    transcriptStoreMountPath: str = "/sandbox/.transcripts"
    transcriptStoreCapacity: str = "10Gi"
    transcriptStoreMountOptions: list[str] = Field(
        default_factory=lambda: ["allow_other"]
    )

    # Per-EXECUTION shared workspace store (interactive-cli runtime family).
    # Mirrors the transcript store but keyed on the workflow execution
    # (request.sharedWorkspaceKey) so every CLI pod of one workflow run mounts
    # the SAME Postgres-backed JuiceFS subtree and reads/writes the SAME files
    # (e.g. a planner→generator→critic loop sharing SPEC.md + the build). Mounted
    # at sharedWorkspaceStoreMountPath, which is a SUBDIR of /sandbox (NOT
    # /sandbox itself): the CLI keeps its credential/config dirs under /sandbox
    # (CLAUDE_CONFIG_DIR=/sandbox/.claude, CODEX_HOME=/sandbox/.codex) on the
    # per-pod emptyDir, so only the build dir is shared. RWX + Retain like the
    # transcript store; PV/PVC named per-session, CSI subPath = the shared key.
    sharedWorkspaceStoreCsiDriver: str | None = None
    sharedWorkspaceStoreSecretName: str | None = None
    sharedWorkspaceStoreSecretNamespace: str | None = None
    sharedWorkspaceStoreMountPath: str = "/sandbox/work"
    sharedWorkspaceStoreCapacity: str = "10Gi"
    sharedWorkspaceStoreMountOptions: list[str] = Field(
        default_factory=lambda: ["allow_other"]
    )

    # Per-pod LOCAL (emptyDir) overlays mounted at sub-paths of the shared
    # workspace so high-churn build artifacts (node_modules, .next, target,
    # build/) live on fast NODE-LOCAL disk, never on the slow shared FS. Why a
    # real volume and not a symlink: npm's reify step DELETES a node_modules
    # *symlink* and rewrites a real dir on the shared FS, so a symlink can't
    # redirect it — but it cannot delete a bind-mounted volume. Source edits stay
    # on the shared FS (durable, cross-pod); only the build artifacts go local.
    # Safe because the agent pods that mount these (e.g. dapr-agent-py-juicefs
    # durable/run nodes) never `git clone` into the shared workspace — clone runs
    # on cliWorkspace pods, which do NOT carry these overlays, so the overlay
    # never collides with "destination not empty". Default [] = no overlay.
    localScratchMounts: list[str] = Field(default_factory=list)

    # ----- Non-agent "service" sandbox (per-run dev-server preview) -----
    # When isService is True, a Sandbox of this class runs a PLAIN long-running
    # container (e.g. `vite dev`) instead of the dapr-agent-py agent host: no
    # daprd sidecar, no app-id, no OpenShell seed, no DB/secrets envFrom. Used
    # by the dev-preview class so a workflow run can stand up its OWN throwaway
    # dev server (devspace's image-replace model, realized cluster-natively) that
    # the agent edits + /__sync-pushes to and the Playwright critic inspects at
    # the pod IP. The privileged controller provisions it; the agent needs no
    # kube creds.
    isService: bool = False
    serviceImage: str | None = None
    serviceCommand: list[str] | None = None
    serviceArgs: list[str] | None = None
    servicePort: int = 3000
    serviceCpu: str = "500m"
    serviceMemory: str = "1Gi"
    serviceCpuLimit: str | None = None
    serviceMemoryLimit: str | None = None
    serviceEphemeralStorage: str = "2Gi"
    serviceEnv: dict[str, str] = Field(default_factory=dict)
    # Language-agnostic live-sync sidecar (P3). When a dev-preview request uses
    # syncMode="sidecar", this image runs alongside the dev server, receiving
    # /__sync into a shared emptyDir the dev server watches (inotify). One image
    # for all services; the dev image is unmodified.
    syncSidecarImage: str | None = None
    serviceWorkdir: str = "/app"
    serviceHealthPath: str = "/"


class AgentWorkflowHostRequest(BaseModel):
    sessionId: str
    agentAppId: str
    runId: str | None = None
    instanceId: str | None = None
    executionClass: str = Field(default="benchmark-fast")
    timeoutSeconds: int | None = Field(default=None, ge=60, le=86400)
    agentImage: str | None = None
    waitReadySeconds: int = Field(default=0, ge=0, le=300)
    # Maps to kueue.x-k8s.io/priority-class on the pod template. Recognized
    # values: interactive-agent (1000), swebench-cohort (100), background-warm (10).
    priorityClass: str | None = None
    # Per-session credential env (e.g. CLAUDE_CODE_OAUTH_TOKEN). Delivered to
    # the agent-host container via an Opaque Secret named
    # agent-host-cred-<agent-app-id> + valueFrom.secretKeyRef — the plaintext
    # values never appear in the Sandbox CR, logs, traces, or API responses.
    sessionSecretEnv: dict[str, str] | None = None
    # Conversation key for the durable transcript store. When resuming, the BFF
    # passes the ORIGINAL session id so the new pod mounts the same Postgres
    # subtree (`--resume`); fresh sessions leave it unset (key = sessionId).
    resumeFromSessionId: str | None = None
    # Shared-workspace key for the per-EXECUTION shared workspace store. The BFF
    # passes the workflow's workspaceRef (or execution id) so every CLI pod of
    # one workflow run mounts the SAME shared subtree at
    # sharedWorkspaceStoreMountPath. Unset → no shared workspace (pod-local only).
    sharedWorkspaceKey: str | None = None
    # Hermetic fork: source workspace subPath to SEED this run's fresh workspace from.
    # When set, a read-only PV/PVC of that subPath is mounted and an init container
    # copies it into the (fresh) shared workspace once, if the shared workspace is empty.
    seedWorkspaceFrom: str | None = None


class DevPreviewRequest(BaseModel):
    """Provision a per-run ephemeral dev-server Sandbox (vite dev) for a workflow.

    Keyed on the workflow executionId so each run gets its OWN throwaway preview
    pod, torn down on run end. The agent (unprivileged) edits its workspace and
    POSTs source to the returned pod's /__sync endpoint; the Playwright critic
    inspects the same pod IP. No kube creds reach the agent — this privileged
    controller does the provisioning.
    """

    executionId: str
    executionClass: str = Field(default="dev-preview")
    image: str | None = None
    port: int = Field(default=3000, ge=1, le=65535)
    # Shared-secret echoed into WFB_DEV_SYNC_TOKEN so /__sync requires it.
    syncToken: str | None = None
    # Sandbox self-deletes after this many seconds (shutdownPolicy: Delete) as a
    # backstop if the workflow never tears it down.
    timeoutSeconds: int | None = Field(default=3600, ge=60, le=86400)
    waitReadySeconds: int = Field(default=150, ge=0, le=600)
    # Extra env merged onto the dev container (e.g. feature flags).
    env: dict[str, str] | None = None
    # ----- per-service generalization (P3) -----
    # Logical service id (workflow-builder / workflow-orchestrator / function-router);
    # stamped as the `dev-preview-service` label so a per-service tailnet LB selects it.
    service: str | None = None
    # Dev-server command/args override (else the class default / image CMD), e.g.
    # ["uvicorn","src.app:app","--reload","--reload-dir","/app","--host","0.0.0.0","--port","8080"].
    command: list[str] | None = None
    args: list[str] | None = None
    # Readiness/startup probe path (services differ: "/", "/healthz", "/readyz").
    healthPath: str = "/"
    # Service workdir (where the dev server runs + where source is synced).
    workdir: str = "/app"
    # "plugin" = the dev image hosts /__sync on the dev port (workflow-builder's
    # in-process Vite plugin). "sidecar" = a language-agnostic dev-sync-sidecar
    # receives /__sync into a shared emptyDir the dev server watches (any service).
    syncMode: str = "plugin"
    # Port the agent POSTs /__sync to. Defaults: plugin → the dev port; sidecar → 8001.
    syncPort: int | None = None
    # ----- Dapr-shadow mode (P3.1, for Dapr/DB-coupled services) -----
    # When True, the dev container gets a daprd sidecar (via standard injector
    # annotations) so services whose startup needs Dapr (secrets/state/workflow —
    # e.g. workflow-orchestrator fetches DATABASE_URL from Dapr secrets, runs
    # `wfr.start()`) can boot in the preview. Isolation is by a UNIQUE app-id
    # (own task hub + placement + actors) + a dev pubsub component (own
    # stream/consumer, set via the PUBSUB_NAME env in `env`), so the shadow runs
    # workflows with ZERO prod blast radius. The real DB is reached via daprd's
    # secret fetch — daprServiceAccount must be RBAC-bound to read the secret.
    needsDapr: bool = False
    # Unique dapr app-id for the shadow (else derived `<service>-dev-<exec-hash>`).
    daprAppId: str | None = None
    # Dapr Configuration CR for the daprd sidecar (defaults to the agent-runtime one).
    daprConfig: str | None = None
    # ServiceAccount bound to the secret-reader Role so daprd can fetch real secrets.
    daprServiceAccount: str | None = None


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


def _agent_host_start_timeout_seconds(request: AgentWorkflowHostRequest) -> str:
    if request.timeoutSeconds is None:
        return os.environ.get("DAPR_AGENT_SESSION_HOST_START_TIMEOUT_SECONDS", "900")
    return str(min(request.timeoutSeconds, 1800))


def _agent_host_resource_limits(
    class_config: ExecutionClassConfig,
) -> dict[str, str]:
    limits = {
        "memory": class_config.agentHostMemoryLimit or class_config.agentHostMemory,
        "ephemeral-storage": (
            class_config.agentHostEphemeralStorageLimit
            or class_config.agentHostEphemeralStorage
        ),
    }
    if class_config.agentHostCpuLimit:
        limits["cpu"] = class_config.agentHostCpuLimit
    return limits


def _agent_host_shutdown_buffer_seconds() -> int:
    raw = os.environ.get("SANDBOX_EXECUTION_AGENT_HOST_SHUTDOWN_BUFFER_SECONDS", "")
    try:
        value = int(raw) if raw.strip() else DEFAULT_AGENT_HOST_SHUTDOWN_BUFFER_SECONDS
    except ValueError:
        value = DEFAULT_AGENT_HOST_SHUTDOWN_BUFFER_SECONDS
    return max(0, min(86400, value))


def _agent_host_shutdown_time(request: AgentWorkflowHostRequest) -> str | None:
    if request.timeoutSeconds is None:
        return None
    shutdown_after_seconds = (
        request.timeoutSeconds + _agent_host_shutdown_buffer_seconds()
    )
    return (
        (datetime.now(UTC) + timedelta(seconds=shutdown_after_seconds))
        .replace(microsecond=0)
        .isoformat()
        .replace("+00:00", "Z")
    )


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
        "mlflowContext": request.mlflowContext,
        "traceContext": request.traceContext,
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
    if class_config.priorityClassName:
        pod_spec["priorityClassName"] = _safe_name(class_config.priorityClassName)
    kueue_labels: dict[str, str] = {
        KUEUE_QUEUE_LABEL: class_config.localQueue,
    }
    kueue_priority = request.priorityClass or class_config.priorityClass
    if kueue_priority:
        kueue_labels[KUEUE_PRIORITY_CLASS_LABEL] = _safe_name(kueue_priority)
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
                **kueue_labels,
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
                        "sandbox-execution-class": _safe_name(request.executionClass),
                        **kueue_labels,
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
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED, detail="invalid token"
        )


def _agent_workflow_host_namespace() -> str:
    return os.environ.get("AGENT_WORKFLOW_HOST_NAMESPACE") or os.environ.get(
        "WORKFLOW_BUILDER_NAMESPACE", "workflow-builder"
    )


def _image_pull_policy_for_agent_host(image: str) -> str:
    """Pull mutable agent-host images every time, keep immutable refs cached."""
    ref = (image or "").strip()
    if "@sha256:" in ref:
        return "IfNotPresent"
    last_segment = ref.rsplit("/", 1)[-1]
    if ":" not in last_segment or last_segment.rsplit(":", 1)[-1] == "latest":
        return "Always"
    return "IfNotPresent"


def _openshell_seed_init_container(image: str) -> dict[str, Any]:
    return {
        "name": "seed-openshell-config",
        "image": image,
        "imagePullPolicy": _image_pull_policy_for_agent_host(image),
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


def _agent_host_sandbox_name(agent_app_id: str) -> str:
    return _safe_resource_name(f"agent-host-{agent_app_id}", max_length=63)


def _agent_host_cred_secret_name(agent_app_id: str) -> str:
    return _safe_resource_name(f"agent-host-cred-{agent_app_id}", max_length=63)


def _redacted_host_request_dump(request: AgentWorkflowHostRequest) -> dict[str, Any]:
    """model_dump with sessionSecretEnv values masked for tracing/logging."""
    dump = request.model_dump()
    if dump.get("sessionSecretEnv"):
        dump["sessionSecretEnv"] = {key: "***" for key in dump["sessionSecretEnv"]}
    return dump


def _ensure_agent_host_cred_secret(
    core: Any,
    request: AgentWorkflowHostRequest,
    *,
    namespace: str,
) -> str | None:
    """Create (or refresh) the per-session credential Secret.

    Called BEFORE the Sandbox CR is created so the pod never races a missing
    secretKeyRef. On conflict the existing Secret's data is patched and any
    stale ownerReferences are cleared (a lingering ref to a deleted Sandbox
    uid would let the GC race-delete the Secret before the new owner is
    bound).
    """
    if not request.sessionSecretEnv:
        return None
    secret_name = _agent_host_cred_secret_name(request.agentAppId)
    labels = {
        "app": "agent-workflow-host",
        "agent-app-id": _safe_name(request.agentAppId, max_length=63),
        "workflow-builder.cnoe.io/session-id": _safe_name(
            request.sessionId, max_length=63
        ),
        "sandbox-execution-class": _safe_name(request.executionClass),
    }
    string_data = {
        key: value for key, value in request.sessionSecretEnv.items() if key
    }
    body = {
        "apiVersion": "v1",
        "kind": "Secret",
        "type": "Opaque",
        "metadata": {
            "name": secret_name,
            "namespace": namespace,
            "labels": labels,
        },
        "stringData": string_data,
    }
    try:
        core.create_namespaced_secret(namespace=namespace, body=body)
    except Exception as exc:
        if getattr(exc, "status", None) != 409:
            raise
        core.patch_namespaced_secret(
            name=secret_name,
            namespace=namespace,
            body={
                "metadata": {"labels": labels, "ownerReferences": None},
                "stringData": string_data,
            },
        )
    return secret_name


def _bind_agent_host_cred_secret_owner(
    core: Any,
    custom: Any,
    *,
    namespace: str,
    secret_name: str,
    sandbox_name: str,
    sandbox: dict[str, Any] | None,
) -> None:
    """Point the credential Secret's ownerReferences at the Sandbox CR.

    The Secret is then garbage-collected with the sandbox. `sandbox` is the
    create response when available; on the adopt-existing-CR path it is None
    and the CR is fetched for its uid. Best-effort: a failed bind leaves an
    unowned Secret that the next session for the same app-id overwrites.
    """
    uid = None
    if isinstance(sandbox, dict):
        uid = ((sandbox.get("metadata") or {}) or {}).get("uid")
    if not uid:
        try:
            existing = custom.get_namespaced_custom_object(
                group="agents.x-k8s.io",
                version="v1alpha1",
                namespace=namespace,
                plural="sandboxes",
                name=sandbox_name,
            )
            uid = ((existing or {}).get("metadata", {}) or {}).get("uid")
        except Exception as exc:
            logger.warning(
                "agent-host cred secret %s: sandbox %s read for ownerRef failed: %s",
                secret_name,
                sandbox_name,
                exc,
            )
    if not uid:
        logger.warning(
            "agent-host cred secret %s: no sandbox uid for %s; secret left unowned",
            secret_name,
            sandbox_name,
        )
        return
    owner_patch = {
        "metadata": {
            "ownerReferences": [
                {
                    "apiVersion": "agents.x-k8s.io/v1alpha1",
                    "kind": "Sandbox",
                    "name": sandbox_name,
                    "uid": uid,
                    "controller": False,
                    "blockOwnerDeletion": False,
                }
            ]
        }
    }
    try:
        core.patch_namespaced_secret(
            name=secret_name,
            namespace=namespace,
            body=owner_patch,
        )
    except Exception as exc:
        logger.warning(
            "agent-host cred secret %s: ownerRef patch failed: %s", secret_name, exc
        )


def _cli_transcript_enabled(class_config: ExecutionClassConfig) -> bool:
    return bool(class_config.transcriptStoreCsiDriver)


def _cli_transcript_conversation_key(request: AgentWorkflowHostRequest) -> str:
    """Subtree key that ties a pod to its Postgres-backed transcript.

    A resume passes the original session id so the new pod re-mounts the same
    subtree; a fresh session keys on its own id.
    """
    return (request.resumeFromSessionId or request.sessionId or "").strip()


def _cli_transcript_resource_name(session_id: str) -> str:
    # `cli-tx-` prefix guarantees the name never matches the driver's
    # `pvc-<uuid>` dynamic-PV regex, so DeleteVolume stays a data-safe no-op.
    return _safe_resource_name(f"cli-tx-{session_id}", max_length=63)


def _ensure_cli_transcript_volume(
    core: Any,
    request: AgentWorkflowHostRequest,
    class_config: ExecutionClassConfig,
    *,
    namespace: str,
) -> str | None:
    """Provision the per-session static PV + PVC for the durable transcript.

    Called BEFORE the Sandbox CR so the pod never races a missing PVC. The PV is
    static (custom volumeHandle) with reclaim **Retain**: deleting the PVC (on
    session purge / GC / the Sandbox ownerRef cascade) must NOT delete the
    backing conversation — verified empirically that the juicefs-csi driver
    (v0.31.x) DOES `rmr` the subPath on a `Delete`-reclaim PV removal, which
    would silently break `--resume`. With Retain the PV goes `Released` (swept by
    the cli-transcript-released-pv GC) while the subtree (keyed on the
    conversation id via CSI `subPath`) persists in Postgres indefinitely for
    `--resume`/resume-anytime. Idempotent: a 409 on either object is
    already-provisioned.
    """
    if not _cli_transcript_enabled(class_config):
        return None
    conversation_key = _cli_transcript_conversation_key(request)
    if not conversation_key:
        return None
    # PV/PVC are named per-session (unique per attempt) while the CSI subPath is
    # the conversation key, so a resume gets a fresh PV bound to the SAME data.
    name = _cli_transcript_resource_name(request.sessionId)
    secret_namespace = class_config.transcriptStoreSecretNamespace or namespace
    labels = {
        "app": "cli-transcript",
        "agent-app-id": _safe_name(request.agentAppId, max_length=63),
        "workflow-builder.cnoe.io/session-id": _safe_name(
            request.sessionId, max_length=63
        ),
        "workflow-builder.cnoe.io/conversation-key": _safe_name(
            conversation_key, max_length=63
        ),
    }
    pv_body = {
        "apiVersion": "v1",
        "kind": "PersistentVolume",
        "metadata": {"name": name, "labels": labels},
        "spec": {
            "capacity": {"storage": class_config.transcriptStoreCapacity},
            "accessModes": ["ReadWriteMany"],
            # Retain (NOT Delete): the v0.31.x juicefs-csi driver rmr's the
            # subPath on a Delete-reclaim PV removal, which would wipe the
            # durable conversation when the session's PVC is GC'd. Retain keeps
            # the data; the Released PV object is swept separately.
            "persistentVolumeReclaimPolicy": "Retain",
            "storageClassName": "",
            "mountOptions": list(class_config.transcriptStoreMountOptions or []),
            "volumeMode": "Filesystem",
            "csi": {
                "driver": class_config.transcriptStoreCsiDriver,
                "fsType": "juicefs",
                "volumeHandle": name,
                "nodePublishSecretRef": {
                    "name": class_config.transcriptStoreSecretName,
                    "namespace": secret_namespace,
                },
                "volumeAttributes": {"subPath": conversation_key},
            },
        },
    }
    pvc_body = {
        "apiVersion": "v1",
        "kind": "PersistentVolumeClaim",
        "metadata": {"name": name, "namespace": namespace, "labels": labels},
        "spec": {
            "accessModes": ["ReadWriteMany"],
            "storageClassName": "",
            "volumeName": name,
            "resources": {
                "requests": {"storage": class_config.transcriptStoreCapacity}
            },
        },
    }
    try:
        core.create_persistent_volume(body=pv_body)
    except Exception as exc:
        if getattr(exc, "status", None) != 409:
            raise
        # A Retain PV with this name already exists. If it's Released (a prior
        # attempt of the SAME session id; resume uses a fresh id so it never
        # hits this), clear its claimRef so the fresh PVC below can re-bind it —
        # else the PVC stays Pending against a Released volume. Data-safe: this
        # touches only the binding, and the subPath data persists in Postgres.
        try:
            existing = core.read_persistent_volume(name=name)
            phase = getattr(getattr(existing, "status", None), "phase", None)
            if phase in ("Released", "Available"):
                core.patch_persistent_volume(name=name, body={"spec": {"claimRef": None}})
        except Exception as patch_exc:  # best-effort; bind may still succeed
            logger.warning(
                "cli-transcript pv %s: claimRef clear failed: %s", name, patch_exc
            )
    try:
        core.create_namespaced_persistent_volume_claim(
            namespace=namespace, body=pvc_body
        )
    except Exception as exc:
        if getattr(exc, "status", None) != 409:
            raise
    return name


def _bind_cli_transcript_pvc_owner(
    core: Any,
    custom: Any,
    *,
    namespace: str,
    pvc_name: str,
    sandbox_name: str,
    sandbox: dict[str, Any] | None,
) -> None:
    """ownerRef the transcript PVC at the Sandbox CR so it GCs with the pod.

    The PVC's `pvc-protection` finalizer holds it until the pod exits; reclaim
    `Delete` then removes the (static, data-safe) PV. Best-effort.
    """
    uid = None
    if isinstance(sandbox, dict):
        uid = ((sandbox.get("metadata") or {}) or {}).get("uid")
    if not uid:
        try:
            existing = custom.get_namespaced_custom_object(
                group="agents.x-k8s.io",
                version="v1alpha1",
                namespace=namespace,
                plural="sandboxes",
                name=sandbox_name,
            )
            uid = ((existing or {}).get("metadata", {}) or {}).get("uid")
        except Exception as exc:
            logger.warning(
                "cli-transcript pvc %s: sandbox %s read for ownerRef failed: %s",
                pvc_name,
                sandbox_name,
                exc,
            )
    if not uid:
        logger.warning(
            "cli-transcript pvc %s: no sandbox uid for %s; pvc left unowned",
            pvc_name,
            sandbox_name,
        )
        return
    owner_patch = {
        "metadata": {
            "ownerReferences": [
                {
                    "apiVersion": "agents.x-k8s.io/v1alpha1",
                    "kind": "Sandbox",
                    "name": sandbox_name,
                    "uid": uid,
                    "controller": False,
                    "blockOwnerDeletion": False,
                }
            ]
        }
    }
    try:
        core.patch_namespaced_persistent_volume_claim(
            name=pvc_name,
            namespace=namespace,
            body=owner_patch,
        )
    except Exception as exc:
        logger.warning(
            "cli-transcript pvc %s: ownerRef patch failed: %s", pvc_name, exc
        )


def _cli_shared_workspace_enabled(class_config: ExecutionClassConfig) -> bool:
    return bool(class_config.sharedWorkspaceStoreCsiDriver)


def _cli_shared_workspace_resource_name(session_id: str) -> str:
    # `cli-ws-` prefix keeps the name off the driver's `pvc-<uuid>` dynamic-PV
    # regex, so DeleteVolume stays a data-safe no-op (same as cli-tx-).
    return _safe_resource_name(f"cli-ws-{session_id}", max_length=63)


def _ensure_cli_shared_workspace_volume(
    core: Any,
    request: AgentWorkflowHostRequest,
    class_config: ExecutionClassConfig,
    *,
    namespace: str,
) -> str | None:
    """Provision the per-EXECUTION static PV + PVC for the shared workspace.

    Identical lifecycle to the transcript store (static PV, custom volumeHandle,
    reclaim **Retain**, RWX), but the CSI `subPath` is the SHARED key
    (`request.sharedWorkspaceKey`, e.g. the workflow execution / workspaceRef) so
    every CLI pod of one workflow run binds the SAME Postgres-backed subtree and
    sees the SAME files. PV/PVC are named per-session (unique per pod) and
    ownerRef'd to the pod's Sandbox; the data persists across pod GC via
    Retain + the shared subPath in Postgres. Idempotent (409 = already there).
    """
    if not _cli_shared_workspace_enabled(class_config):
        return None
    shared_key = (request.sharedWorkspaceKey or "").strip()
    if not shared_key:
        return None
    name = _cli_shared_workspace_resource_name(request.sessionId)
    secret_namespace = class_config.sharedWorkspaceStoreSecretNamespace or namespace
    labels = {
        "app": "cli-shared-workspace",
        "agent-app-id": _safe_name(request.agentAppId, max_length=63),
        "workflow-builder.cnoe.io/session-id": _safe_name(
            request.sessionId, max_length=63
        ),
        "workflow-builder.cnoe.io/shared-workspace-key": _safe_name(
            shared_key, max_length=63
        ),
    }
    pv_body = {
        "apiVersion": "v1",
        "kind": "PersistentVolume",
        "metadata": {"name": name, "labels": labels},
        "spec": {
            "capacity": {"storage": class_config.sharedWorkspaceStoreCapacity},
            "accessModes": ["ReadWriteMany"],
            # Retain: the shared build must survive each pod's GC during the loop
            # (the next role's pod re-binds the same subPath). Released PVs are
            # swept separately; the subtree persists in Postgres.
            "persistentVolumeReclaimPolicy": "Retain",
            "storageClassName": "",
            "mountOptions": list(class_config.sharedWorkspaceStoreMountOptions or []),
            "volumeMode": "Filesystem",
            "csi": {
                "driver": class_config.sharedWorkspaceStoreCsiDriver,
                "fsType": "juicefs",
                "volumeHandle": name,
                "nodePublishSecretRef": {
                    "name": class_config.sharedWorkspaceStoreSecretName,
                    "namespace": secret_namespace,
                },
                "volumeAttributes": {"subPath": shared_key},
            },
        },
    }
    pvc_body = {
        "apiVersion": "v1",
        "kind": "PersistentVolumeClaim",
        "metadata": {"name": name, "namespace": namespace, "labels": labels},
        "spec": {
            "accessModes": ["ReadWriteMany"],
            "storageClassName": "",
            "volumeName": name,
            "resources": {
                "requests": {"storage": class_config.sharedWorkspaceStoreCapacity}
            },
        },
    }
    try:
        core.create_persistent_volume(body=pv_body)
    except Exception as exc:
        if getattr(exc, "status", None) != 409:
            raise
        try:
            existing = core.read_persistent_volume(name=name)
            phase = getattr(getattr(existing, "status", None), "phase", None)
            if phase in ("Released", "Available"):
                core.patch_persistent_volume(name=name, body={"spec": {"claimRef": None}})
        except Exception as patch_exc:
            logger.warning(
                "cli-shared-workspace pv %s: claimRef clear failed: %s", name, patch_exc
            )
    try:
        core.create_namespaced_persistent_volume_claim(
            namespace=namespace, body=pvc_body
        )
    except Exception as exc:
        if getattr(exc, "status", None) != 409:
            raise
    return name


# JuiceFS exposes virtual control files (.accesslog / .config / .stats) in EVERY mount
# and subPath, so a naive `ls -A` never sees a fresh fork subPath as empty (→ the seed
# copy is wrongly skipped as "already-populated"). These helpers filter the magic files
# both when deciding emptiness AND when copying (`cp -a /seed/.` chokes on the 0-byte
# virtual files and would report failure even after a good data copy).
_JFS_MAGIC_FILTER = r"grep -vxE '\.(accesslog|config|stats)'"


def _seed_copy_cmd(empty_label: str) -> str:
    """A busybox `sh -c` body: copy /seed → /work when /work has no REAL content.

    `empty_label` is echoed when the dest already holds real data (copy skipped).
    Echoes `seeded` / `copy-failed` otherwise. Idempotent (copy-if-empty)."""
    return (
        'r() { ls -A "$1" 2>/dev/null | ' + _JFS_MAGIC_FILTER + "; }; "
        'if [ -z "$(r /work)" ]; then '
        "find /seed -maxdepth 1 -mindepth 1 "
        "! -name .accesslog ! -name .config ! -name .stats "
        "-exec cp -a {} /work/ \\; 2>/dev/null; "
        'if [ -n "$(r /work)" ]; then echo seeded; else echo copy-failed; fi; '
        "else echo " + empty_label + "; fi; true"
    )


def _seed_clone_cmd() -> str:
    """A juicefs `sh -c` body for the orchestrator seed Job: COW-clone a source workspace
    subPath into a fork's fresh subPath, both visible under one ROOT JuiceFS mount at /jfs.

    `juicefs clone` is metadata-only copy-on-write — it never copies file DATA, so a repo
    with thousands of tiny .git objects clones in ~one metadata pass instead of a
    file-by-file `cp` (≈7x faster here; instant once metadata moves off Postgres). Reads
    $SRC_SUB / $DST_SUB from the container env. Copy-if-empty (magic-file-aware).

    Build artifacts (node_modules/.svelte-kit/build/dist/.next/.cache/.turbo) are EXCLUDED
    one level under each top-level dir (i.e. `repo/node_modules`). Two reasons: (1) a stale
    seeded `node_modules` makes the agent build IN PLACE on the slow JuiceFS workspace
    (the SSR build then hangs) instead of copying to local scratch + installing fresh; and
    (2) a 89MB+ node_modules dominates both the clone and the post-clone chmod (turning a
    ~2min seed into ~9min). Source (incl. .git for diffs) is kept; deps are reinstalled on
    local scratch by the critic/publish_shot. Exits non-zero on failure → Job status.failed."""
    excl = "node_modules .svelte-kit build dist .next .cache .turbo .vite"
    return (
        'r() { ls -A "$1" 2>/dev/null | ' + _JFS_MAGIC_FILTER + "; }; "
        'S="/jfs/$SRC_SUB"; D="/jfs/$DST_SUB"; '
        '[ -d "$S" ] || { echo source-missing; exit 1; }; '
        'mkdir -p "$D"; '
        'if [ -n "$(r "$D")" ]; then echo already-populated; exit 0; fi; '
        'EXCL="' + excl + '"; '
        'skip() { for x in $EXCL; do [ "$1" = "$x" ] && return 0; done; return 1; }; '
        "rc=0; "
        # Top-level files clone directly; top-level DIRS clone child-by-child so we can
        # prune build-artifact subdirs (kept children still clone via recursive CoW).
        'for f in $(r "$S"); do '
        'if [ -d "$S/$f" ]; then mkdir -p "$D/$f"; '
        'for g in $(r "$S/$f"); do skip "$g" && continue; juicefs clone "$S/$f/$g" "$D/$f/$g" || rc=1; done; '
        'else juicefs clone "$S/$f" "$D/$f" || rc=1; fi; '
        'done; '
        # `mkdir -p` makes dirs root-owned 0755 and `juicefs clone` doesn't restore the
        # source's mode, so the cloned workspace is read-only to the NON-root sandbox pods
        # (a fresh workspace is 0777) → EACCES on any write (`mkdir /sandbox/work/vid`,
        # screenshot/verdict files). Make the cloned tree world-writable (cheap now that
        # node_modules is excluded) so any runtime uid can write, like a fresh workspace.
        '[ "$rc" = 0 ] && chmod -R a+rwX "$D" 2>/dev/null; '
        'if [ "$rc" = 0 ] && [ -n "$(r "$D")" ]; then echo seeded; else echo clone-failed; exit 1; fi'
    )


def _ensure_cli_seed_workspace_volume(
    core: Any,
    request: AgentWorkflowHostRequest,
    class_config: ExecutionClassConfig,
    *,
    namespace: str,
) -> str | None:
    """Provision a static PV+PVC for the SOURCE workspace subPath of a hermetic fork
    (`request.seedWorkspaceFrom`), mounted READ-ONLY in the pod so the seed-workspace
    init container can copy it into the fork's fresh shared workspace. Same CSI shape
    as the shared workspace; distinct (`cli-seed-`) name. Idempotent (409 = present)."""
    if not _cli_shared_workspace_enabled(class_config):
        return None
    seed_key = (request.seedWorkspaceFrom or "").strip()
    if not seed_key:
        return None
    name = f"cli-seed-{_safe_name(request.sessionId, max_length=55)}"
    secret_namespace = class_config.sharedWorkspaceStoreSecretNamespace or namespace
    labels = {
        "app": "cli-seed-workspace",
        "workflow-builder.cnoe.io/session-id": _safe_name(request.sessionId, max_length=63),
        "workflow-builder.cnoe.io/seed-workspace-key": _safe_name(seed_key, max_length=63),
    }
    pv_body = {
        "apiVersion": "v1",
        "kind": "PersistentVolume",
        "metadata": {"name": name, "labels": labels},
        "spec": {
            "capacity": {"storage": class_config.sharedWorkspaceStoreCapacity},
            "accessModes": ["ReadWriteMany"],
            "persistentVolumeReclaimPolicy": "Retain",
            "storageClassName": "",
            "mountOptions": list(class_config.sharedWorkspaceStoreMountOptions or []),
            "volumeMode": "Filesystem",
            "csi": {
                "driver": class_config.sharedWorkspaceStoreCsiDriver,
                "fsType": "juicefs",
                "volumeHandle": name,
                "nodePublishSecretRef": {
                    "name": class_config.sharedWorkspaceStoreSecretName,
                    "namespace": secret_namespace,
                },
                "volumeAttributes": {"subPath": seed_key},
            },
        },
    }
    pvc_body = {
        "apiVersion": "v1",
        "kind": "PersistentVolumeClaim",
        "metadata": {"name": name, "namespace": namespace, "labels": labels},
        "spec": {
            "accessModes": ["ReadWriteMany"],
            "storageClassName": "",
            "volumeName": name,
            "resources": {
                "requests": {"storage": class_config.sharedWorkspaceStoreCapacity}
            },
        },
    }
    try:
        core.create_persistent_volume(body=pv_body)
    except Exception as exc:
        if getattr(exc, "status", None) != 409:
            raise
        try:
            existing = core.read_persistent_volume(name=name)
            phase = getattr(getattr(existing, "status", None), "phase", None)
            if phase in ("Released", "Available"):
                core.patch_persistent_volume(name=name, body={"spec": {"claimRef": None}})
        except Exception as patch_exc:
            logger.warning("cli-seed pv %s claimRef clear failed: %s", name, patch_exc)
    try:
        core.create_namespaced_persistent_volume_claim(namespace=namespace, body=pvc_body)
    except Exception as exc:
        if getattr(exc, "status", None) != 409:
            raise
    return name


TRACEPARENT_ANNOTATION = "workflow-builder.cnoe.io/traceparent"
TRACESTATE_ANNOTATION = "workflow-builder.cnoe.io/tracestate"
BAGGAGE_ANNOTATION = "workflow-builder.cnoe.io/baggage"
# Full (untruncated) owner-run identity stamped on each agent-host Sandbox CR so
# a create-409 can distinguish adopt-same-run from a stale name reused by a
# different run (delete + recreate, no inherited pod state).
OWNER_RUN_ID_ANNOTATION = "agents.workflow-builder.cnoe.io/owner-run-id"


def _agent_host_owner_run_id(request: AgentWorkflowHostRequest) -> str:
    return f"{(request.sessionId or '').strip()}|{(request.runId or '').strip()}"


def _agent_host_cr_owner_matches(
    custom: Any, namespace: str, name: str, want_owner: str
) -> bool:
    """True if the existing agent-host CR belongs to the same run.

    A legacy CR without an owner annotation is adopted (return True) to avoid
    disrupting in-flight pre-upgrade runs; only a present-and-different owner
    triggers delete + recreate.
    """
    try:
        existing = custom.get_namespaced_custom_object(
            group="agents.x-k8s.io",
            version="v1alpha1",
            namespace=namespace,
            plural="sandboxes",
            name=name,
        )
    except Exception as exc:
        logger.warning("agent-host CR %s read failed during 409 check: %s", name, exc)
        return True
    annotations = ((existing or {}).get("metadata", {}) or {}).get("annotations", {}) or {}
    existing_owner = annotations.get(OWNER_RUN_ID_ANNOTATION)
    if not existing_owner:
        return True
    return existing_owner == want_owner


def _delete_agent_host_cr_and_wait(
    custom: Any, namespace: str, name: str, timeout_s: float = 30.0
) -> None:
    try:
        custom.delete_namespaced_custom_object(
            group="agents.x-k8s.io",
            version="v1alpha1",
            namespace=namespace,
            plural="sandboxes",
            name=name,
            body={
                "apiVersion": "v1",
                "kind": "DeleteOptions",
                "propagationPolicy": "Foreground",
            },
        )
    except Exception as exc:
        if getattr(exc, "status", None) != 404:
            logger.warning("agent-host CR %s delete failed: %s", name, exc)
    deadline = time.time() + timeout_s
    while time.time() < deadline:
        try:
            custom.get_namespaced_custom_object(
                group="agents.x-k8s.io",
                version="v1alpha1",
                namespace=namespace,
                plural="sandboxes",
                name=name,
            )
        except Exception as exc:
            if getattr(exc, "status", None) == 404:
                return
        time.sleep(1.0)
    logger.warning(
        "agent-host CR %s still present after %ss; proceeding to recreate", name, timeout_s
    )


def build_agent_workflow_host_sandbox_manifest(
    request: AgentWorkflowHostRequest,
    *,
    namespace: str,
    class_config: ExecutionClassConfig,
    trace_context: dict[str, str] | None = None,
) -> dict[str, Any]:
    run_label = _safe_name(request.runId or "manual", max_length=63)
    instance_label = _safe_name(request.instanceId or request.sessionId, max_length=63)
    app_label = _safe_name(request.agentAppId, max_length=63)
    # `agent-app-id` is the deterministic SHA-derived join key for sessions →
    # workloads. The raw session id is also stamped here so an operator
    # reading the Workload YAML can grep for the session without recomputing
    # the hash. UI cross-feature lookup still uses `agent-app-id`.
    session_label = _safe_name(request.sessionId, max_length=63)
    image = request.agentImage or class_config.agentHostImage
    image_pull_policy = _image_pull_policy_for_agent_host(image)
    class_agent_host_env = [
        {"name": key, "value": value}
        for key, value in sorted(class_config.agentHostEnv.items())
        if key and value is not None
    ]
    if class_config.agentHostEnvFrom is not None:
        # Class-declared envFrom REPLACES the default list verbatim (e.g.
        # interactive-cli must not see dapr-agent-py-secrets).
        env_from = [dict(entry) for entry in class_config.agentHostEnvFrom]
    else:
        env_from = [
            {"configMapRef": {"name": "dapr-agent-py-config", "optional": True}},
        ]
        if "adk-agent-py" in image:
            env_from.append(
                {"configMapRef": {"name": "adk-agent-py-config", "optional": True}}
            )
        if "claude-agent-py" in image:
            env_from.append(
                {"configMapRef": {"name": "claude-agent-py-config", "optional": True}}
            )
        env_from.extend(
            [
                {"secretRef": {"name": "dapr-agent-py-secrets", "optional": True}},
                {"secretRef": {"name": "workflow-checkpoint-gitea", "optional": True}},
            ]
        )
    user_home = (class_config.agentHostUserHome or "").rstrip("/") or None
    config_home = (
        f"{user_home}/.config" if user_home else DEFAULT_AGENT_HOST_CONFIG_HOME
    )
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
                "imagePullPolicy": image_pull_policy,
                "ports": [{"name": "http", "containerPort": 8002}],
                "env": [
                    {"name": "AGENT_SERVICE_NAME", "value": request.agentAppId},
                    {"name": "AGENT_SLUG", "value": request.agentAppId},
                    {"name": "XDG_CONFIG_HOME", "value": config_home},
                    {
                        "name": "DAPR_LLM_COMPONENT_DEFAULT",
                        "value": "llm-anthropic-opus",
                    },
                    {"name": "DAPR_AGENT_PY_HOOKS_ENABLED", "value": "false"},
                    {"name": "DAPR_AGENT_PY_PLUGINS_ENABLED", "value": "false"},
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
                        "name": "DAPR_AGENT_SESSION_HOST_BENCHMARK_RUN_ID",
                        "value": request.runId or "",
                    },
                    {
                        "name": "DAPR_AGENT_SESSION_HOST_BENCHMARK_INSTANCE_ID",
                        "value": request.instanceId or "",
                    },
                    {
                        "name": "DAPR_AGENT_SESSION_HOST_START_TIMEOUT_SECONDS",
                        "value": _agent_host_start_timeout_seconds(request),
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
                    {
                        "name": "DAPR_AGENT_SESSION_HOST_TERMINAL_HOLD_SECONDS",
                        "value": os.environ.get(
                            "SANDBOX_EXECUTION_AGENT_HOST_TERMINAL_HOLD_SECONDS",
                            "0",
                        ),
                    },
                    {
                        "name": "DAPR_AGENT_SESSION_HOST_NONTERMINAL_TIMEOUT_ACTION",
                        "value": class_config.agentHostNonterminalTimeoutAction
                        or os.environ.get(
                            "DAPR_AGENT_SESSION_HOST_NONTERMINAL_TIMEOUT_ACTION",
                            "warn",
                        ),
                    },
                    # W3C trace-context, sourced from the parent BFF request
                    # via Sandbox metadata.annotations. dapr-agent-py reads
                    # this and uses it as the parent context for spans the
                    # session_workflow emits, stitching the trace from
                    # ensure-for-workflow -> agent_workflow.
                    {
                        "name": "WORKFLOW_BUILDER_TRACEPARENT",
                        "valueFrom": {
                            "fieldRef": {
                                "fieldPath": (
                                    f"metadata.annotations['{TRACEPARENT_ANNOTATION}']"
                                ),
                            },
                        },
                    },
                    {
                        "name": "WORKFLOW_BUILDER_TRACESTATE",
                        "valueFrom": {
                            "fieldRef": {
                                "fieldPath": (
                                    f"metadata.annotations['{TRACESTATE_ANNOTATION}']"
                                ),
                            },
                        },
                    },
                    {
                        "name": "WORKFLOW_BUILDER_BAGGAGE",
                        "valueFrom": {
                            "fieldRef": {
                                "fieldPath": (
                                    f"metadata.annotations['{BAGGAGE_ANNOTATION}']"
                                ),
                            },
                        },
                    },
                    # MLflow tracing destination — per-cluster experiment id
                    # from the mlflow-workflow-builder-experiment ConfigMap
                    # (3=dev, 6=ryzen, 7=staging) so providers.py can call
                    # mlflow.tracing.set_destination(MlflowExperiment(...))
                    # at startup. The CM is mirrored from observability into
                    # workflow-builder ns by the bootstrap Job's PostSync
                    # hook (Phase 3 of the MLflow cutover).
                    {
                        "name": "MLFLOW_TRACE_EXPERIMENT_ID",
                        "valueFrom": {
                            "configMapKeyRef": {
                                "name": "mlflow-workflow-builder-experiment",
                                "key": "MLFLOW_EXPERIMENT_ID",
                                "optional": True,
                            },
                        },
                    },
                ],
                "envFrom": env_from,
                "resources": {
                    "requests": {
                        "cpu": class_config.agentHostCpu,
                        "memory": class_config.agentHostMemory,
                        "ephemeral-storage": class_config.agentHostEphemeralStorage,
                    },
                    "limits": _agent_host_resource_limits(class_config),
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
                    {"name": "openshell-config", "mountPath": config_home},
                    {"name": "sandbox", "mountPath": "/sandbox"},
                ],
            }
        ],
        "volumes": [
            {"name": "openshell-config", "emptyDir": {}},
            {"name": "sandbox", "emptyDir": {}},
            {
                "name": "openshell-client-tls",
                "secret": {"secretName": "openshell-client-tls"},
            },
            {
                "name": "openshell-client-ca",
                "secret": {"secretName": "openshell-server-client-ca"},
            },
        ],
    }
    if user_home:
        # Insert HOME right after XDG_CONFIG_HOME so the agent process resolves
        # its config under the non-root home.
        env_list = pod_spec["containers"][0]["env"]
        xdg_index = next(
            (
                index
                for index, entry in enumerate(env_list)
                if entry.get("name") == "XDG_CONFIG_HOME"
            ),
            len(env_list) - 1,
        )
        env_list.insert(xdg_index + 1, {"name": "HOME", "value": user_home})
    if class_config.omitOpenshellSeedInit:
        pod_spec.pop("initContainers", None)
        pod_spec["volumes"] = [
            volume
            for volume in pod_spec["volumes"]
            if volume.get("name") not in {"openshell-client-tls", "openshell-client-ca"}
        ]
    if _cli_transcript_enabled(class_config):
        # Per-session durable transcript subtree. The PVC is provisioned by the
        # create handler (_ensure_cli_transcript_volume) and mounted at a path
        # SIBLING to the CLI config dir; cli-agent-py symlinks the CLI's
        # transcript dir into it (CLI_TRANSCRIPT_MOUNT) so only the transcript
        # persists and all credential state stays on the ephemeral emptyDir.
        transcript_pvc = _cli_transcript_resource_name(request.sessionId)
        mount_path = class_config.transcriptStoreMountPath
        pod_spec["volumes"].append(
            {
                "name": "cli-transcripts",
                "persistentVolumeClaim": {"claimName": transcript_pvc},
            }
        )
        pod_spec["containers"][0]["volumeMounts"].append(
            {"name": "cli-transcripts", "mountPath": mount_path}
        )
        pod_spec["containers"][0]["env"].append(
            {"name": "CLI_TRANSCRIPT_MOUNT", "value": mount_path}
        )
    if _cli_shared_workspace_enabled(class_config) and (request.sharedWorkspaceKey or "").strip():
        # Per-EXECUTION shared workspace, mounted at a SUBDIR of /sandbox (the
        # emptyDir provides /sandbox + the CLI's config dirs; this PVC overlays
        # only the build subdir, shared across the workflow's CLI pods). Nested
        # mount: kubelet mounts the parent emptyDir before this child path.
        shared_pvc = _cli_shared_workspace_resource_name(request.sessionId)
        shared_mount_path = class_config.sharedWorkspaceStoreMountPath
        pod_spec["volumes"].append(
            {
                "name": "cli-shared-workspace",
                "persistentVolumeClaim": {"claimName": shared_pvc},
            }
        )
        pod_spec["containers"][0]["volumeMounts"].append(
            {"name": "cli-shared-workspace", "mountPath": shared_mount_path}
        )
        pod_spec["containers"][0]["env"].append(
            {"name": "CLI_SHARED_WORKSPACE_MOUNT", "value": shared_mount_path}
        )
        # Hermetic fork: mount the SOURCE workspace subPath read-only + an init
        # container that COPIES it into this fork's fresh shared workspace, once, if
        # the shared workspace is still empty (the first session pod seeds it; later
        # pods of the same fork see it populated and no-op). Source is small (build
        # artifacts live on localScratch, not the shared FS).
        if (request.seedWorkspaceFrom or "").strip():
            seed_pvc = f"cli-seed-{_safe_name(request.sessionId, max_length=55)}"
            pod_spec["volumes"].append(
                {
                    "name": "cli-seed-workspace",
                    "persistentVolumeClaim": {"claimName": seed_pvc, "readOnly": True},
                }
            )
            seed_init = {
                "name": "seed-workspace",
                "image": "busybox:1.36",
                "command": ["sh", "-c", _seed_copy_cmd("work-not-empty")],
                "volumeMounts": [
                    {"name": "cli-shared-workspace", "mountPath": "/work"},
                    {"name": "cli-seed-workspace", "mountPath": "/seed", "readOnly": True},
                ],
            }
            pod_spec.setdefault("initContainers", []).insert(0, seed_init)
    for idx, raw_path in enumerate(class_config.localScratchMounts or []):
        # Fast node-local emptyDir overlay for a build-artifact subdir of the
        # shared workspace (e.g. /sandbox/work/repo/node_modules). Appended AFTER
        # the shared-workspace mount; kubelet mounts by path depth so the deeper
        # overlay nests inside the (already-mounted) shared FS. npm/pnpm/builds
        # write here at local-disk speed; durable source stays on the shared FS.
        scratch_path = str(raw_path or "").strip()
        if not scratch_path.startswith("/"):
            continue
        vol_name = f"local-scratch-{idx}"
        pod_spec["volumes"].append({"name": vol_name, "emptyDir": {}})
        pod_spec["containers"][0]["volumeMounts"].append(
            {"name": vol_name, "mountPath": scratch_path}
        )
    if class_config.podSecurityContext is not None:
        pod_spec["securityContext"] = dict(class_config.podSecurityContext)
    if class_config.imagePullSecrets:
        pod_spec["imagePullSecrets"] = [
            {"name": name} for name in class_config.imagePullSecrets if name
        ]
    if class_config.runtimeClassName:
        pod_spec["runtimeClassName"] = class_config.runtimeClassName
    if class_config.priorityClassName:
        pod_spec["priorityClassName"] = _safe_name(class_config.priorityClassName)
    if request.timeoutSeconds is not None:
        pod_spec["activeDeadlineSeconds"] = request.timeoutSeconds + 600
    if class_agent_host_env:
        overridden = {entry["name"] for entry in class_agent_host_env}
        base_env = [
            entry
            for entry in pod_spec["containers"][0]["env"]
            if entry.get("name") not in overridden
        ]
        pod_spec["containers"][0]["env"] = [*base_env, *class_agent_host_env]
    if request.sessionSecretEnv:
        # Inject per-session credentials as secretKeyRef only — the plaintext
        # value must never be embedded in the Sandbox CR manifest.
        secret_name = _agent_host_cred_secret_name(request.agentAppId)
        session_secret_env = [
            {
                "name": key,
                "valueFrom": {"secretKeyRef": {"name": secret_name, "key": key}},
            }
            for key in sorted(request.sessionSecretEnv)
            if key
        ]
        secret_overridden = {entry["name"] for entry in session_secret_env}
        base_env = [
            entry
            for entry in pod_spec["containers"][0]["env"]
            if entry.get("name") not in secret_overridden
        ]
        pod_spec["containers"][0]["env"] = [*base_env, *session_secret_env]
    pod_labels: dict[str, str] = {
        "app": "agent-workflow-host",
        KUEUE_QUEUE_LABEL: class_config.localQueue,
        "benchmark-run-id": run_label,
        "benchmark-instance-id": instance_label,
        "agent-app-id": app_label,
        "workflow-builder.cnoe.io/session-id": session_label,
    }
    if request.priorityClass:
        pod_labels[KUEUE_PRIORITY_CLASS_LABEL] = _safe_name(request.priorityClass)
    # Capture inbound W3C trace-context. Stamp on BOTH:
    #   - Sandbox CR metadata.annotations (for operator visibility)
    #   - Pod template metadata.annotations (so the pod's downward-API
    #     fieldRef on metadata.annotations['workflow-builder.cnoe.io/traceparent']
    #     actually resolves — the agent-sandbox controller propagates pod-template
    #     annotations to the pod, but does NOT propagate the parent Sandbox's
    #     metadata.annotations).
    sandbox_metadata_annotations: dict[str, str] = {}
    pod_trace_annotations: dict[str, str] = {}
    if trace_context:
        traceparent = trace_context.get("traceparent") or ""
        if traceparent:
            sandbox_metadata_annotations[TRACEPARENT_ANNOTATION] = traceparent
            pod_trace_annotations[TRACEPARENT_ANNOTATION] = traceparent
        tracestate = trace_context.get("tracestate") or ""
        if tracestate:
            sandbox_metadata_annotations[TRACESTATE_ANNOTATION] = tracestate
            pod_trace_annotations[TRACESTATE_ANNOTATION] = tracestate
        baggage = trace_context.get("baggage") or ""
        if baggage:
            sandbox_metadata_annotations[BAGGAGE_ANNOTATION] = baggage
            pod_trace_annotations[BAGGAGE_ANNOTATION] = baggage
    pod_annotations: dict[str, str] = {
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
        "dapr.io/internal-grpc-port": os.environ.get(
            "DAPR_AGENT_HOST_INTERNAL_GRPC_PORT",
            "3502",
        ),
        "dapr.io/placement-host-address": os.environ.get(
            "DAPR_PLACEMENT_HOST_ADDRESS",
            "dapr-placement-server.dapr-system.svc.cluster.local:50005",
        ),
        "dapr.io/max-body-size": os.environ.get("DAPR_MAX_BODY_SIZE", "16Mi"),
        "dapr.io/graceful-shutdown-seconds": "60",
        "dapr.io/sidecar-readiness-probe-delay-seconds": "0",
        "dapr.io/sidecar-readiness-probe-period-seconds": "1",
        "dapr.io/sidecar-readiness-probe-timeout-seconds": "1",
        # Make the Dapr sidecar's :9090 metrics endpoint scrapeable. The
        # OTEL collector's prometheus/dapr receiver targets dapr.io/enabled
        # pods directly; these annotations are a fallback path for any
        # prometheus.io-style scraper deployed alongside.
        "prometheus.io/scrape": "true",
        "prometheus.io/port": "9090",
        "prometheus.io/path": "/",
    }
    # Merge trace-context annotations onto the pod template so the downward-API
    # fieldRef on metadata.annotations['workflow-builder.cnoe.io/traceparent']
    # resolves to the value forwarded from the BFF.
    pod_annotations.update(pod_trace_annotations)
    sandbox_metadata: dict[str, Any] = {
        "name": _agent_host_sandbox_name(request.agentAppId),
        "namespace": namespace,
        "labels": {
            "app": "agent-workflow-host",
            "benchmark-run-id": run_label,
            "benchmark-instance-id": instance_label,
            "agent-app-id": app_label,
            "sandbox-execution-class": _safe_name(request.executionClass),
            "workflow-builder.cnoe.io/session-id": session_label,
        },
    }
    sandbox_metadata["annotations"] = {
        **(sandbox_metadata_annotations or {}),
        OWNER_RUN_ID_ANNOTATION: _agent_host_owner_run_id(request),
    }
    sandbox_spec: dict[str, Any] = {
        "replicas": 1,
        "podTemplate": {
            "metadata": {
                "labels": pod_labels,
                "annotations": pod_annotations,
            },
            "spec": pod_spec,
        },
    }
    shutdown_time = _agent_host_shutdown_time(request)
    if shutdown_time:
        sandbox_spec["shutdownPolicy"] = "Delete"
        sandbox_spec["shutdownTime"] = shutdown_time
    return {
        "apiVersion": "agents.x-k8s.io/v1alpha1",
        "kind": "Sandbox",
        "metadata": sandbox_metadata,
        "spec": sandbox_spec,
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
    # DISABLED by default. The target stores (workflowstatestore,
    # dapr-agent-py-statestore) ship intentionally UNSCOPED (scopes:null →
    # visible to all in-namespace apps), so per-session pods already reach them
    # without any patch — and `_patch_component_scope` no-ops on unscoped
    # components anyway. The patch is a latent footgun: if a target ever acquired
    # a `scopes` list, appending each ephemeral agent-session-<sha20> app-id
    # would SCOPE the shared store to individual sessions and break other apps —
    # a risk that grows with prewarm's earlier/heavier create volume. Invariant:
    # workflowstatestore is the only actorStateStore=true and stays unscoped.
    # Re-enable only with explicit opt-in (and only if a target is deliberately
    # scoped). Default off.
    if os.environ.get("SANDBOX_EXECUTION_PATCH_COMPONENT_SCOPES", "false").strip().lower() not in {
        "1",
        "true",
        "yes",
        "on",
    }:
        return
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


def _sandbox_failure_reason(
    custom: Any, *, namespace: str, sandbox_name: str
) -> str | None:
    try:
        sandbox = custom.get_namespaced_custom_object(
            group="agents.x-k8s.io",
            version="v1alpha1",
            namespace=namespace,
            plural="sandboxes",
            name=sandbox_name,
        )
    except Exception:
        return None
    status_obj = sandbox.get("status") if isinstance(sandbox, dict) else None
    if not isinstance(status_obj, dict):
        return None
    for condition in status_obj.get("conditions", []) or []:
        if not isinstance(condition, dict):
            continue
        ctype = condition.get("type")
        cstatus = condition.get("status")
        if ctype in {"Failed", "Degraded"} and cstatus == "True":
            reason = condition.get("reason") or "sandbox failed"
            message = condition.get("message")
            return f"{reason}: {message}" if message else reason
    return None


def _agent_host_provisioning_phase(
    core: Any,
    *,
    namespace: str,
    agent_app_id: str,
) -> str:
    """Granular provisioning phase for the readiness response.

    - ``queued``: no pod yet (Kueue Workload not Admitted / sandbox controller
      hasn't created it), or the pod exists but is unscheduled
      (PodScheduled != True, which covers SchedulingGated).
    - ``starting``: pod is scheduled onto a node but not Ready yet.
    - ``ready``: pod reports the Ready condition.
    """
    selector = (
        f"app=agent-workflow-host,agent-app-id="
        f"{_safe_name(agent_app_id, max_length=63)}"
    )
    try:
        pods = core.list_namespaced_pod(
            namespace=namespace,
            label_selector=selector,
        ).items
    except Exception as exc:
        logger.warning(
            "agent workflow host %s phase probe failed: %s", agent_app_id, exc
        )
        return "queued"
    phase = "queued"
    for pod in pods:
        if _pod_is_ready(pod):
            return "ready"
        conditions = getattr(getattr(pod, "status", None), "conditions", None) or []
        for condition in conditions:
            if (
                getattr(condition, "type", None) == "PodScheduled"
                and getattr(condition, "status", None) == "True"
            ):
                phase = "starting"
    return phase


def _wait_for_agent_host_ready(
    core: Any,
    *,
    namespace: str,
    agent_app_id: str,
    wait_seconds: int,
    failure_probe: Any | None = None,
) -> str:
    """Poll the per-app pod selector until ready or `wait_seconds` elapses.

    `failure_probe`, if provided, is called each tick with no args and must
    return either ``None`` (no failure) or a string describing the failure;
    when it returns a string we surface a 503 and stop polling.
    """
    if wait_seconds <= 0:
        return "queued"
    selector = f"app=agent-workflow-host,agent-app-id={_safe_name(agent_app_id, max_length=63)}"
    deadline = time.monotonic() + wait_seconds
    last_phase = "pending"
    last_failure: str | None = None
    while time.monotonic() < deadline:
        if failure_probe is not None:
            host_failure = failure_probe()
            if host_failure:
                raise HTTPException(
                    status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                    detail=f"agent workflow host {agent_app_id} failed before readiness: {host_failure}",
                )
        pods = core.list_namespaced_pod(
            namespace=namespace,
            label_selector=selector,
        ).items
        for pod in pods:
            failure = _pod_failure_reason(pod)
            if failure:
                last_failure = failure
                phase = getattr(getattr(pod, "status", None), "phase", None)
                if phase == "Failed":
                    raise HTTPException(
                        status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                        detail=f"agent workflow host {agent_app_id} failed before readiness: {failure}",
                    )
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
    if last_failure:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail=f"agent workflow host {agent_app_id} failed before readiness: {last_failure}",
        )
    return "queued"


@app.get("/healthz")
def healthz() -> dict[str, Any]:
    return {"ok": True, "time": datetime.now(UTC).isoformat()}


@app.post("/api/v1/executions", status_code=status.HTTP_202_ACCEPTED)
def submit_execution(request: Request, body: ExecutionRequest) -> dict[str, Any]:
    _require_internal(request)
    set_current_span_io("input", body.model_dump())
    classes = _load_execution_classes()
    class_config = classes.get(body.executionClass)
    if class_config is None:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"unsupported executionClass {body.executionClass}",
        )
    inbound_trace_context = {
        "traceparent": request.headers.get("traceparent", "") or "",
        "tracestate": request.headers.get("tracestate", "") or "",
        "baggage": request.headers.get("baggage", "") or "",
    }
    trace_context = body.traceContext or {
        key: value for key, value in inbound_trace_context.items() if value
    }
    body = body.model_copy(update={"traceContext": trace_context or None})
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
    response = {
        "executionId": execution_id,
        "jobName": manifest["metadata"]["name"],
        "status": "queued",
        "executionClass": body.executionClass,
        "localQueue": class_config.localQueue,
        "runtimeClassName": class_config.runtimeClassName,
    }
    set_current_span_io("output", response)
    return response


DEFAULT_DEV_PREVIEW_IMAGE = os.environ.get(
    "DEV_PREVIEW_DEFAULT_IMAGE",
    "ghcr.io/pittampalliorg/workflow-builder-dev:latest",
)


def _dev_preview_sandbox_name(execution_id: str) -> str:
    return _safe_resource_name(f"wfb-dev-preview-{execution_id}", max_length=63)


def _dev_preview_dapr_app_id(request: DevPreviewRequest) -> str:
    """Unique Dapr app-id for a Dapr-shadow preview.

    A UNIQUE app-id is the core isolation guarantee: Dapr keys the workflow task
    hub, placement registration, and actor partitions by app-id, so a unique id
    gives the shadow its OWN task hub (no prod task execution leaks in/out). Keyed
    on (service, executionId) so re-provisioning the same run is stable. Must be a
    valid Dapr app-id (DNS-label-ish, ≤63).
    """
    if request.daprAppId:
        return _safe_name(request.daprAppId, max_length=63)
    service = _safe_name(request.service or "service", max_length=24)
    digest = sha256(request.executionId.encode("utf-8")).hexdigest()[:10]
    return _safe_name(f"{service}-dev-{digest}", max_length=63)


def _dev_preview_shutdown_time(timeout_seconds: int | None) -> str | None:
    if timeout_seconds is None:
        return None
    shutdown_after = timeout_seconds + _agent_host_shutdown_buffer_seconds()
    return (
        (datetime.now(UTC) + timedelta(seconds=shutdown_after))
        .replace(microsecond=0)
        .isoformat()
        .replace("+00:00", "Z")
    )


def build_dev_preview_sandbox_manifest(
    request: DevPreviewRequest,
    *,
    namespace: str,
    class_config: ExecutionClassConfig,
) -> dict[str, Any]:
    """A PLAIN single-container `vite dev` Sandbox (no daprd/app-id/OpenShell).

    The Playwright critic and the agent's /__sync push reach this pod directly at
    its pod IP:port; no Dapr service invocation, no DB, no secrets.
    """
    exec_label = _safe_name(request.executionId, max_length=63)
    image = request.image or class_config.serviceImage or DEFAULT_DEV_PREVIEW_IMAGE
    port = request.port or class_config.servicePort or 3000
    workdir = (request.workdir or class_config.serviceWorkdir or "/app").rstrip("/") or "/app"
    health_path = request.healthPath or class_config.serviceHealthPath or "/"
    sync_mode = (request.syncMode or "plugin").lower()
    use_sidecar = sync_mode == "sidecar"
    sync_port = request.syncPort or (8001 if use_sidecar else port)
    service_label = _safe_name(request.service or "workflow-builder", max_length=63)
    command = request.command or class_config.serviceCommand
    args = request.args or class_config.serviceArgs

    # Main dev-server env. workflow-builder's in-process Vite /__sync plugin reads
    # WFB_DEV_SYNC_* (plugin mode only); other services use the sidecar and don't.
    env: list[dict[str, str]] = [{"name": "NODE_ENV", "value": "development"}]
    if not use_sidecar:
        env.append({"name": "WFB_DEV_SYNC_ENABLED", "value": "true"})
        env.append(
            {"name": "WORKFLOW_BUILDER_SKIP_STARTUP_MIGRATIONS", "value": "true"}
        )
        if request.syncToken:
            env.append({"name": "WFB_DEV_SYNC_TOKEN", "value": request.syncToken})
    # Dapr-shadow defaults (P3.1): lowest priority, so request.env can override.
    # These GUARANTEE isolation even if a caller forgets to pass them:
    #   - DAPR_CONFIG_STORE=disabled-dev → forces core/config.py to fall back to
    #     env (the Dapr Configuration store wins over env, so we must disable it,
    #     else a prod-store PUBSUB_NAME would leak the shadow onto prod pubsub).
    #   - PUBSUB_NAME=pubsub-dev → the orchestrator publishes/consumes on the
    #     isolated dev pubsub component (own JetStream stream + consumer group).
    #   - APP_ID=<unique> → informational; the authoritative app-id is the
    #     dapr.io/app-id annotation below.
    dapr_app_id = _dev_preview_dapr_app_id(request) if request.needsDapr else None
    dapr_defaults: dict[str, str] = {}
    if request.needsDapr:
        dapr_defaults = {
            "DAPR_CONFIG_STORE": "disabled-dev",
            "PUBSUB_NAME": "pubsub-dev",
            "APP_ID": dapr_app_id or "",
        }
    merged_env: dict[str, str] = {}
    for key, value in {
        **dapr_defaults,
        **class_config.serviceEnv,
        **(request.env or {}),
    }.items():
        if key and value is not None:
            merged_env[key] = value
    overridden = {entry["name"] for entry in env}
    env.extend(
        {"name": key, "value": value}
        for key, value in sorted(merged_env.items())
        if key not in overridden
    )
    container: dict[str, Any] = {
        "name": "dev",
        "image": image,
        "imagePullPolicy": _image_pull_policy_for_agent_host(image),
        "ports": [{"name": "http", "containerPort": port}],
        "env": env,
        "resources": {
            "requests": {
                "cpu": class_config.serviceCpu,
                "memory": class_config.serviceMemory,
                "ephemeral-storage": class_config.serviceEphemeralStorage,
            },
            "limits": {
                **(
                    {"cpu": class_config.serviceCpuLimit}
                    if class_config.serviceCpuLimit
                    else {}
                ),
                "memory": class_config.serviceMemoryLimit or class_config.serviceMemory,
                "ephemeral-storage": class_config.serviceEphemeralStorage,
            },
        },
        "startupProbe": {
            "httpGet": {"path": health_path, "port": port},
            "initialDelaySeconds": 5,
            "periodSeconds": 5,
            "timeoutSeconds": 5,
            "failureThreshold": 60,
        },
        "readinessProbe": {
            "httpGet": {"path": health_path, "port": port},
            "periodSeconds": 10,
            "timeoutSeconds": 5,
        },
    }
    if command:
        container["command"] = list(command)
    if args:
        container["args"] = list(args)

    # Dapr-shadow: bind to the secret-reader SA so daprd can fetch the real
    # DATABASE_URL secret (else class default).
    service_account = class_config.serviceAccountName
    if request.needsDapr:
        service_account = (
            request.daprServiceAccount
            or os.environ.get("DEV_PREVIEW_DAPR_SERVICE_ACCOUNT")
            or "dev-preview-dapr"
        )
    pod_spec: dict[str, Any] = {
        "restartPolicy": "Never",
        "serviceAccountName": service_account,
        "terminationGracePeriodSeconds": 30,
        "containers": [container],
    }
    # Pod-level securityContext: explicit class config wins, else default to root
    # for plain previews (vite/uvicorn/tsx run as the image's root user). For
    # needsDapr we must NOT set a pod-level runAsUser:0 — the Dapr injector gives
    # the daprd native sidecar `runAsNonRoot: true` (no explicit runAsUser), so a
    # pod-level runAsUser:0 makes the effective uid root and the kubelet rejects
    # daprd ("runAsUser breaks non-root policy"). Strip runAsUser/runAsGroup for
    # needsDapr (mirrors the working agent-host pods, whose pod securityContext is
    # empty); the dev/seed/sync containers still run as their image's root user.
    if class_config.podSecurityContext is not None:
        pod_security = dict(class_config.podSecurityContext)
    elif not request.needsDapr:
        pod_security = {"runAsUser": 0}
    else:
        pod_security = {}
    if request.needsDapr:
        pod_security.pop("runAsUser", None)
        pod_security.pop("runAsGroup", None)
    if pod_security:
        pod_spec["securityContext"] = pod_security

    # ----- sidecar mode (language-agnostic live-sync for any service) -----
    # A shared emptyDir at the workdir (local disk → inotify works). An init
    # container seeds it from the dev image's baked workdir (deps + source), so
    # the emptyDir mount doesn't mask node_modules/.venv. The dev server (main)
    # runs from the emptyDir; the dev-sync-sidecar untars /__sync pushes into the
    # SAME emptyDir → the dev server's watcher hot-reloads.
    if use_sidecar:
        sidecar_image = (
            class_config.syncSidecarImage
            or os.environ.get(
                "DEV_SYNC_SIDECAR_IMAGE",
                "ghcr.io/pittampalliorg/dev-sync-sidecar:latest",
            )
        )
        pod_spec["volumes"] = [{"name": "dev-workdir", "emptyDir": {}}]
        container.setdefault("volumeMounts", []).append(
            {"name": "dev-workdir", "mountPath": workdir}
        )
        pod_spec["initContainers"] = [
            {
                "name": "seed-workdir",
                "image": image,
                "imagePullPolicy": _image_pull_policy_for_agent_host(image),
                "command": ["sh", "-c"],
                # Copy the baked workdir (deps+source) into the emptyDir so the
                # mount doesn't hide it. cp the contents (incl dotfiles via /.).
                "args": [
                    f"cp -a {workdir}/. /seed/ 2>/dev/null || true; "
                    "echo seeded $(ls /seed | wc -l) entries"
                ],
                "volumeMounts": [{"name": "dev-workdir", "mountPath": "/seed"}],
            }
        ]
        sidecar_env = [
            {"name": "DEV_SYNC_PORT", "value": str(sync_port)},
            {"name": "DEV_SYNC_DEST", "value": workdir},
        ]
        if request.syncToken:
            sidecar_env.append({"name": "DEV_SYNC_TOKEN", "value": request.syncToken})
        pod_spec["containers"].append(
            {
                "name": "dev-sync",
                "image": sidecar_image,
                "imagePullPolicy": _image_pull_policy_for_agent_host(sidecar_image),
                "ports": [{"name": "sync", "containerPort": sync_port}],
                "env": sidecar_env,
                "resources": {
                    "requests": {"cpu": "25m", "memory": "64Mi"},
                    "limits": {"memory": "256Mi"},
                },
                "volumeMounts": [{"name": "dev-workdir", "mountPath": workdir}],
                "readinessProbe": {
                    "httpGet": {"path": "/healthz", "port": sync_port},
                    "periodSeconds": 10,
                },
            }
        )

    if class_config.nodeSelector:
        pod_spec["nodeSelector"] = class_config.nodeSelector
    if class_config.imagePullSecrets:
        pod_spec["imagePullSecrets"] = [
            {"name": name} for name in class_config.imagePullSecrets if name
        ]
    if class_config.priorityClassName:
        pod_spec["priorityClassName"] = _safe_name(class_config.priorityClassName)
    if request.timeoutSeconds is not None:
        pod_spec["activeDeadlineSeconds"] = request.timeoutSeconds + 600
    pod_labels = {
        "app": "wfb-dev-preview",
        "dev-preview-service": service_label,
        KUEUE_QUEUE_LABEL: class_config.localQueue,
        "workflow-execution-id": exec_label,
    }
    pod_template_metadata: dict[str, Any] = {"labels": pod_labels}
    # Dapr-shadow: stamp the standard injector annotations so the daprd sidecar is
    # added (mirrors build_agent_workflow_host_sandbox_manifest). The UNIQUE app-id
    # isolates the task hub/placement/actors; enable-workflow lets `wfr.start()`
    # run; the daprd attaches to the SAME single workflowstatestore under its own
    # app-id partition (does NOT add a 2nd actorStateStore=true component).
    if request.needsDapr:
        pod_template_metadata["annotations"] = {
            "dapr.io/enabled": "true",
            "dapr.io/app-id": dapr_app_id,
            "dapr.io/app-port": str(port),
            "dapr.io/app-protocol": "http",
            "dapr.io/config": (
                request.daprConfig
                or os.environ.get(
                    "DAPR_AGENT_HOST_CONFIG", "workflow-builder-agent-runtime"
                )
            ),
            "dapr.io/enable-workflow": "true",
            "dapr.io/enable-native-sidecar": "true",
            "dapr.io/internal-grpc-port": os.environ.get(
                "DAPR_AGENT_HOST_INTERNAL_GRPC_PORT", "3502"
            ),
            "dapr.io/placement-host-address": os.environ.get(
                "DAPR_PLACEMENT_HOST_ADDRESS",
                "dapr-placement-server.dapr-system.svc.cluster.local:50005",
            ),
            "dapr.io/max-body-size": os.environ.get("DAPR_MAX_BODY_SIZE", "16Mi"),
            "dapr.io/graceful-shutdown-seconds": "60",
        }
    sandbox_spec: dict[str, Any] = {
        "replicas": 1,
        "podTemplate": {
            "metadata": pod_template_metadata,
            "spec": pod_spec,
        },
    }
    shutdown_time = _dev_preview_shutdown_time(request.timeoutSeconds)
    if shutdown_time:
        sandbox_spec["shutdownPolicy"] = "Delete"
        sandbox_spec["shutdownTime"] = shutdown_time
    return {
        "apiVersion": "agents.x-k8s.io/v1alpha1",
        "kind": "Sandbox",
        "metadata": {
            "name": _dev_preview_sandbox_name(request.executionId),
            "namespace": namespace,
            "labels": {
                "app": "wfb-dev-preview",
                "dev-preview-service": service_label,
                "workflow-execution-id": exec_label,
                "sandbox-execution-class": _safe_name(request.executionClass),
            },
        },
        "spec": sandbox_spec,
    }


def _wait_for_dev_preview_ready(
    core: Any,
    *,
    namespace: str,
    execution_id: str,
    wait_seconds: int,
    failure_probe: Any | None = None,
) -> tuple[str, str | None]:
    """Poll the dev-preview pod until Ready; return ``(status, podIP|None)``."""
    selector = (
        f"app=wfb-dev-preview,workflow-execution-id="
        f"{_safe_name(execution_id, max_length=63)}"
    )

    def _pod_ip() -> str | None:
        try:
            pods = core.list_namespaced_pod(
                namespace=namespace, label_selector=selector
            ).items
        except Exception:
            return None
        for pod in pods:
            ip = getattr(getattr(pod, "status", None), "pod_ip", None)
            if ip:
                return ip
        return None

    if wait_seconds <= 0:
        return "queued", _pod_ip()
    deadline = time.monotonic() + wait_seconds
    last_failure: str | None = None
    while time.monotonic() < deadline:
        if failure_probe is not None:
            failed = failure_probe()
            if failed:
                raise HTTPException(
                    status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                    detail=f"dev-preview {execution_id} failed before readiness: {failed}",
                )
        pods = core.list_namespaced_pod(
            namespace=namespace, label_selector=selector
        ).items
        for pod in pods:
            failure = _pod_failure_reason(pod)
            if failure:
                last_failure = failure
                if getattr(getattr(pod, "status", None), "phase", None) == "Failed":
                    raise HTTPException(
                        status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                        detail=f"dev-preview {execution_id} failed before readiness: {failure}",
                    )
                continue
            if _pod_is_ready(pod):
                return "ready", getattr(getattr(pod, "status", None), "pod_ip", None)
        time.sleep(1)
    if last_failure:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail=f"dev-preview {execution_id} not ready: {last_failure}",
        )
    return "queued", _pod_ip()


@app.post("/api/v1/agent-workflow-hosts", status_code=status.HTTP_202_ACCEPTED)
def submit_agent_workflow_host(
    request: Request,
    body: AgentWorkflowHostRequest,
) -> dict[str, Any]:
    _require_internal(request)
    # sessionSecretEnv carries plaintext credentials — never trace/log it raw.
    set_current_span_io("input", _redacted_host_request_dump(body))
    classes = _load_execution_classes()
    class_config = classes.get(body.executionClass)
    if class_config is None:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"unsupported executionClass {body.executionClass}",
        )
    namespace = _agent_workflow_host_namespace()
    trace_context = {
        "traceparent": request.headers.get("traceparent", "") or "",
        "tracestate": request.headers.get("tracestate", "") or "",
        "baggage": request.headers.get("baggage", "") or "",
    }
    manifest = build_agent_workflow_host_sandbox_manifest(
        body,
        namespace=namespace,
        class_config=class_config,
        trace_context=trace_context,
    )
    sandbox_name = manifest["metadata"]["name"]
    if os.environ.get("SANDBOX_EXECUTION_DRY_RUN", "").lower() not in {
        "1",
        "true",
        "yes",
    }:
        _, core = _load_k8s_clients()
        custom = _load_k8s_custom_objects_client()
        _ensure_agent_host_component_scopes(namespace, body.agentAppId)
        # Per-session credential Secret must exist BEFORE the Sandbox CR so the
        # pod's secretKeyRef env never races CreateContainerConfigError.
        cred_secret_name = _ensure_agent_host_cred_secret(
            core, body, namespace=namespace
        )
        # Per-session durable transcript PV+PVC, also before the Sandbox CR so
        # the pod's PVC mount never races a missing claim.
        transcript_pvc_name = _ensure_cli_transcript_volume(
            core, body, class_config, namespace=namespace
        )
        # Per-EXECUTION shared workspace PV+PVC (also before the Sandbox CR).
        shared_workspace_pvc_name = _ensure_cli_shared_workspace_volume(
            core, body, class_config, namespace=namespace
        )
        # Hermetic fork: RO seed PV/PVC of the source workspace subPath (if requested).
        seed_workspace_pvc_name = _ensure_cli_seed_workspace_volume(
            core, body, class_config, namespace=namespace
        )
        created_sandbox: dict[str, Any] | None = None
        try:
            created_sandbox = custom.create_namespaced_custom_object(
                group="agents.x-k8s.io",
                version="v1alpha1",
                namespace=namespace,
                plural="sandboxes",
                body=manifest,
            )
        except Exception as exc:
            if getattr(exc, "status", None) != 409:
                raise
            # The deterministic CR name already exists. Adopt it only if it
            # belongs to the SAME logical run; otherwise it is a stale CR whose
            # name was reused -- delete it and recreate so the new run gets a
            # clean sandbox instead of inheriting the prior pod's state.
            want_owner = _agent_host_owner_run_id(body)
            if _agent_host_cr_owner_matches(custom, namespace, sandbox_name, want_owner):
                logger.info(
                    "agent-host CR %s already exists for the same run (%s); adopting",
                    sandbox_name,
                    want_owner,
                )
            else:
                logger.warning(
                    "agent-host CR %s exists for a different run; deleting + recreating "
                    "for owner=%s",
                    sandbox_name,
                    want_owner,
                )
                _delete_agent_host_cr_and_wait(custom, namespace, sandbox_name)
                if cred_secret_name:
                    # The old CR's foreground delete may have GC'd the Secret
                    # (it was owned by that CR) — re-ensure before recreating.
                    cred_secret_name = _ensure_agent_host_cred_secret(
                        core, body, namespace=namespace
                    )
                if transcript_pvc_name:
                    # Likewise the PVC was ownerRef'd to the old CR; re-ensure.
                    transcript_pvc_name = _ensure_cli_transcript_volume(
                        core, body, class_config, namespace=namespace
                    )
                if shared_workspace_pvc_name:
                    shared_workspace_pvc_name = _ensure_cli_shared_workspace_volume(
                        core, body, class_config, namespace=namespace
                    )
                if seed_workspace_pvc_name:
                    seed_workspace_pvc_name = _ensure_cli_seed_workspace_volume(
                        core, body, class_config, namespace=namespace
                    )
                created_sandbox = custom.create_namespaced_custom_object(
                    group="agents.x-k8s.io",
                    version="v1alpha1",
                    namespace=namespace,
                    plural="sandboxes",
                    body=manifest,
                )
        if cred_secret_name:
            _bind_agent_host_cred_secret_owner(
                core,
                custom,
                namespace=namespace,
                secret_name=cred_secret_name,
                sandbox_name=sandbox_name,
                sandbox=created_sandbox,
            )
        if transcript_pvc_name:
            _bind_cli_transcript_pvc_owner(
                core,
                custom,
                namespace=namespace,
                pvc_name=transcript_pvc_name,
                sandbox_name=sandbox_name,
                sandbox=created_sandbox,
            )
        if shared_workspace_pvc_name:
            # Same generic PVC-ownerRef patch (GC the PVC with the pod; the PV is
            # Retain so the shared subtree survives for the next role's pod).
            _bind_cli_transcript_pvc_owner(
                core,
                custom,
                namespace=namespace,
                pvc_name=shared_workspace_pvc_name,
                sandbox_name=sandbox_name,
                sandbox=created_sandbox,
            )
        if seed_workspace_pvc_name:
            # GC the seed PVC with the pod (the PV is Retain; the source subtree it
            # points at is the SOURCE run's, untouched — read-only).
            _bind_cli_transcript_pvc_owner(
                core,
                custom,
                namespace=namespace,
                pvc_name=seed_workspace_pvc_name,
                sandbox_name=sandbox_name,
                sandbox=created_sandbox,
            )
        readiness_status = _wait_for_agent_host_ready(
            core,
            namespace=namespace,
            agent_app_id=body.agentAppId,
            wait_seconds=body.waitReadySeconds,
            failure_probe=lambda: _sandbox_failure_reason(
                custom, namespace=namespace, sandbox_name=sandbox_name
            ),
        )
        provisioning_phase = (
            "ready"
            if readiness_status == "ready"
            else _agent_host_provisioning_phase(
                core, namespace=namespace, agent_app_id=body.agentAppId
            )
        )
    else:
        readiness_status = "queued"
        provisioning_phase = "queued"
    response = {
        "agentAppId": body.agentAppId,
        "sessionId": body.sessionId,
        "sandboxName": sandbox_name,
        # Back-compat: callers (BFF, orchestrator) still read `jobName` until
        # arc 1.5 lands the shared dispatcher rename. Keep both keys until then.
        "jobName": sandbox_name,
        "status": readiness_status,
        # Additive: distinguishes Kueue-queued/unscheduled (`queued`) from
        # scheduled-but-booting (`starting`) and Ready (`ready`).
        "phase": provisioning_phase,
        "executionClass": body.executionClass,
        "localQueue": class_config.localQueue,
        "runtimeClassName": class_config.runtimeClassName,
    }
    set_current_span_io("output", response)
    return response


@app.post("/internal/dev-preview", status_code=status.HTTP_202_ACCEPTED)
def provision_dev_preview(request: Request, body: DevPreviewRequest) -> dict[str, Any]:
    _require_internal(request)
    set_current_span_io("input", body.model_dump())
    classes = _load_execution_classes()
    class_config = classes.get(body.executionClass)
    if class_config is None:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"unsupported executionClass {body.executionClass}",
        )
    namespace = _agent_workflow_host_namespace()
    manifest = build_dev_preview_sandbox_manifest(
        body, namespace=namespace, class_config=class_config
    )
    sandbox_name = manifest["metadata"]["name"]
    pod_ip: str | None = None
    readiness_status = "queued"
    if os.environ.get("SANDBOX_EXECUTION_DRY_RUN", "").lower() not in {
        "1",
        "true",
        "yes",
    }:
        _, core = _load_k8s_clients()
        custom = _load_k8s_custom_objects_client()
        try:
            custom.create_namespaced_custom_object(
                group="agents.x-k8s.io",
                version="v1alpha1",
                namespace=namespace,
                plural="sandboxes",
                body=manifest,
            )
        except Exception as exc:
            if getattr(exc, "status", None) != 409:
                raise
            # Deterministic per-execution name already exists → idempotent adopt
            # (same run re-requesting its own preview).
            logger.info("dev-preview CR %s already exists; adopting", sandbox_name)
        readiness_status, pod_ip = _wait_for_dev_preview_ready(
            core,
            namespace=namespace,
            execution_id=body.executionId,
            wait_seconds=body.waitReadySeconds,
            failure_probe=lambda: _sandbox_failure_reason(
                custom, namespace=namespace, sandbox_name=sandbox_name
            ),
        )
    port = body.port or class_config.servicePort or 3000
    use_sidecar = (body.syncMode or "plugin").lower() == "sidecar"
    sync_port = body.syncPort or (8001 if use_sidecar else port)
    url = f"http://{pod_ip}:{port}" if pod_ip else None
    sync_url = f"http://{pod_ip}:{sync_port}/__sync" if pod_ip else None
    response = {
        "sandboxName": sandbox_name,
        "executionId": body.executionId,
        "service": body.service or "workflow-builder",
        "status": readiness_status,
        "ready": readiness_status == "ready",
        "podIP": pod_ip,
        "port": port,
        "syncPort": sync_port,
        "url": url,
        "syncUrl": sync_url,
        "executionClass": body.executionClass,
        # Dapr-shadow: surface the isolated app-id so callers can prove isolation.
        "needsDapr": body.needsDapr,
        "daprAppId": _dev_preview_dapr_app_id(body) if body.needsDapr else None,
    }
    set_current_span_io("output", response)
    return response


@app.delete("/internal/dev-preview/{name}")
def teardown_dev_preview(request: Request, name: str) -> dict[str, Any]:
    _require_internal(request)
    namespace = _agent_workflow_host_namespace()
    safe_name = _safe_resource_name(name, max_length=63)
    if os.environ.get("SANDBOX_EXECUTION_DRY_RUN", "").lower() not in {
        "1",
        "true",
        "yes",
    }:
        custom = _load_k8s_custom_objects_client()
        _delete_agent_host_cr_and_wait(custom, namespace, safe_name)
    return {"sandboxName": safe_name, "deleted": True}


class PurgeWorkspaceDataRequest(BaseModel):
    """Purge the DATA of one retained JuiceFS shared workspace (subPath)."""

    workspaceExecutionId: str
    executionClass: str | None = None


def _resolve_juicefs_class(execution_class: str | None) -> ExecutionClassConfig | None:
    """Pick a juicefs-shared execution class (explicit, else the first one configured)."""
    classes = _load_execution_classes()
    if execution_class:
        cfg = classes.get(execution_class)
        if cfg and cfg.sharedWorkspaceStoreCsiDriver:
            return cfg
    for cfg in classes.values():
        if cfg.sharedWorkspaceStoreCsiDriver:
            return cfg
    return None


@app.post("/internal/workspace/purge-data", status_code=status.HTTP_202_ACCEPTED)
def purge_workspace_data(
    request: Request, body: PurgeWorkspaceDataRequest
) -> dict[str, Any]:
    """Reclaim an abandoned retained workspace by deleting its JuiceFS subPath data.

    The resume/fork feature retains resumable workspaces past run end; the
    abandoned-workspace reaper calls this to free the data. Spawns a one-shot Job that
    mounts ONLY that subPath (RWX, via a temp static PV+PVC reusing the shared-workspace
    CSI shape) and deletes its contents — JuiceFS then reclaims the blocks via gc/trash.
    Idempotent (deterministic PV/PVC name; missing data = no-op).
    """
    _require_internal(request)
    shared_key = (body.workspaceExecutionId or "").strip()
    if not shared_key:
        raise HTTPException(status_code=400, detail="workspaceExecutionId required")
    class_config = _resolve_juicefs_class(body.executionClass)
    if class_config is None:
        raise HTTPException(
            status_code=409, detail="no juicefs-shared execution class configured"
        )

    namespace = _agent_workflow_host_namespace()
    secret_namespace = class_config.sharedWorkspaceStoreSecretNamespace or namespace
    mount_path = class_config.sharedWorkspaceStoreMountPath or "/sandbox/work"
    # Hash the (long) workspace key into resource names so the Job + its auto-injected
    # `job-name` pod label stay within k8s' 63-char limit. Full key in an annotation.
    digest = sha256(shared_key.encode()).hexdigest()[:16]
    name = f"wspurge-{digest}"
    labels = {"app": "workspace-purge"}
    key_anno = {"workflow-builder.cnoe.io/shared-workspace-key": shared_key}
    pv_body = {
        "apiVersion": "v1",
        "kind": "PersistentVolume",
        "metadata": {"name": name, "labels": labels, "annotations": key_anno},
        "spec": {
            "capacity": {"storage": class_config.sharedWorkspaceStoreCapacity},
            "accessModes": ["ReadWriteMany"],
            "persistentVolumeReclaimPolicy": "Retain",
            "storageClassName": "",
            "mountOptions": list(class_config.sharedWorkspaceStoreMountOptions or []),
            "volumeMode": "Filesystem",
            "csi": {
                "driver": class_config.sharedWorkspaceStoreCsiDriver,
                "fsType": "juicefs",
                "volumeHandle": name,
                "nodePublishSecretRef": {
                    "name": class_config.sharedWorkspaceStoreSecretName,
                    "namespace": secret_namespace,
                },
                "volumeAttributes": {"subPath": shared_key},
            },
        },
    }
    pvc_body = {
        "apiVersion": "v1",
        "kind": "PersistentVolumeClaim",
        "metadata": {"name": name, "namespace": namespace, "labels": labels},
        "spec": {
            "accessModes": ["ReadWriteMany"],
            "storageClassName": "",
            "volumeName": name,
            "resources": {
                "requests": {"storage": class_config.sharedWorkspaceStoreCapacity}
            },
        },
    }
    job_name = f"{name}-{uuid4().hex[:6]}"
    purge_cmd = (
        f"find {mount_path} -mindepth 1 -delete 2>/dev/null; "
        f"rm -rf {mount_path}/* {mount_path}/.[!.]* 2>/dev/null; echo purged; true"
    )
    job_body = {
        "apiVersion": "batch/v1",
        "kind": "Job",
        "metadata": {"name": job_name, "namespace": namespace, "labels": labels},
        "spec": {
            "backoffLimit": 1,
            "ttlSecondsAfterFinished": 600,
            "template": {
                "metadata": {"labels": labels},
                "spec": {
                    "restartPolicy": "Never",
                    "containers": [
                        {
                            "name": "purge",
                            "image": "busybox:1.36",
                            "command": ["sh", "-c", purge_cmd],
                            "volumeMounts": [{"name": "work", "mountPath": mount_path}],
                        }
                    ],
                    "volumes": [
                        {"name": "work", "persistentVolumeClaim": {"claimName": name}}
                    ],
                },
            },
        },
    }

    if os.environ.get("SANDBOX_EXECUTION_DRY_RUN", "").lower() in {"1", "true", "yes"}:
        return {"dryRun": True, "job": job_name, "subPath": shared_key}

    batch, core = _load_k8s_clients()
    try:
        core.create_persistent_volume(body=pv_body)
    except Exception as exc:
        if getattr(exc, "status", None) != 409:
            raise
        try:
            existing = core.read_persistent_volume(name=name)
            phase = getattr(getattr(existing, "status", None), "phase", None)
            if phase in ("Released", "Available"):
                core.patch_persistent_volume(name=name, body={"spec": {"claimRef": None}})
        except Exception as patch_exc:
            logger.warning("wspurge pv %s claimRef clear failed: %s", name, patch_exc)
    try:
        core.create_namespaced_persistent_volume_claim(namespace=namespace, body=pvc_body)
    except Exception as exc:
        if getattr(exc, "status", None) != 409:
            raise
    batch.create_namespaced_job(namespace=namespace, body=job_body)
    return {"success": True, "job": job_name, "subPath": shared_key}


def _ensure_temp_subpath_pv(
    core: Any,
    *,
    name: str,
    sub_path: str,
    class_config: ExecutionClassConfig,
    namespace: str,
) -> None:
    """Create a temp static PV+PVC (RWX, Retain) bound to one JuiceFS subPath, reusing
    the shared-workspace CSI shape. Idempotent (409 = present; clears released claimRef)."""
    secret_namespace = class_config.sharedWorkspaceStoreSecretNamespace or namespace
    pv_body = {
        "apiVersion": "v1",
        "kind": "PersistentVolume",
        "metadata": {
            "name": name,
            "labels": {"app": "workspace-seed"},
            "annotations": {"workflow-builder.cnoe.io/shared-workspace-key": sub_path},
        },
        "spec": {
            "capacity": {"storage": class_config.sharedWorkspaceStoreCapacity},
            "accessModes": ["ReadWriteMany"],
            "persistentVolumeReclaimPolicy": "Retain",
            "storageClassName": "",
            "mountOptions": list(class_config.sharedWorkspaceStoreMountOptions or []),
            "volumeMode": "Filesystem",
            "csi": {
                "driver": class_config.sharedWorkspaceStoreCsiDriver,
                "fsType": "juicefs",
                "volumeHandle": name,
                "nodePublishSecretRef": {
                    "name": class_config.sharedWorkspaceStoreSecretName,
                    "namespace": secret_namespace,
                },
                "volumeAttributes": {"subPath": sub_path},
            },
        },
    }
    pvc_body = {
        "apiVersion": "v1",
        "kind": "PersistentVolumeClaim",
        "metadata": {"name": name, "namespace": namespace, "labels": {"app": "workspace-seed"}},
        "spec": {
            "accessModes": ["ReadWriteMany"],
            "storageClassName": "",
            "volumeName": name,
            "resources": {"requests": {"storage": class_config.sharedWorkspaceStoreCapacity}},
        },
    }
    try:
        core.create_persistent_volume(body=pv_body)
    except Exception as exc:
        if getattr(exc, "status", None) != 409:
            raise
        try:
            existing = core.read_persistent_volume(name=name)
            phase = getattr(getattr(existing, "status", None), "phase", None)
            if phase in ("Released", "Available"):
                core.patch_persistent_volume(name=name, body={"spec": {"claimRef": None}})
        except Exception as patch_exc:
            logger.warning("wsseed pv %s claimRef clear failed: %s", name, patch_exc)
    try:
        core.create_namespaced_persistent_volume_claim(namespace=namespace, body=pvc_body)
    except Exception as exc:
        if getattr(exc, "status", None) != 409:
            raise


def _ensure_root_pv(
    core: Any,
    *,
    name: str,
    class_config: ExecutionClassConfig,
    namespace: str,
) -> None:
    """Create a static PV+PVC bound to the JuiceFS volume ROOT (no subPath) so a single
    pod can see ALL run subPaths at once — required for `juicefs clone` (source + dest
    must live under ONE mount). Reused across clone Jobs (idempotent). Blast radius: the
    clone Job sees every workspace, acceptable for a short-lived internal-only Job."""
    secret_namespace = class_config.sharedWorkspaceStoreSecretNamespace or namespace
    pv_body = {
        "apiVersion": "v1",
        "kind": "PersistentVolume",
        "metadata": {"name": name, "labels": {"app": "workspace-seed"}},
        "spec": {
            "capacity": {"storage": class_config.sharedWorkspaceStoreCapacity},
            "accessModes": ["ReadWriteMany"],
            "persistentVolumeReclaimPolicy": "Retain",
            "storageClassName": "",
            "mountOptions": list(class_config.sharedWorkspaceStoreMountOptions or []),
            "volumeMode": "Filesystem",
            "csi": {
                "driver": class_config.sharedWorkspaceStoreCsiDriver,
                "fsType": "juicefs",
                "volumeHandle": name,
                "nodePublishSecretRef": {
                    "name": class_config.sharedWorkspaceStoreSecretName,
                    "namespace": secret_namespace,
                },
                # No subPath → mount the JuiceFS root.
                "volumeAttributes": {},
            },
        },
    }
    pvc_body = {
        "apiVersion": "v1",
        "kind": "PersistentVolumeClaim",
        "metadata": {"name": name, "namespace": namespace, "labels": {"app": "workspace-seed"}},
        "spec": {
            "accessModes": ["ReadWriteMany"],
            "storageClassName": "",
            "volumeName": name,
            "resources": {"requests": {"storage": class_config.sharedWorkspaceStoreCapacity}},
        },
    }
    try:
        core.create_persistent_volume(body=pv_body)
    except Exception as exc:
        if getattr(exc, "status", None) != 409:
            raise
        try:
            existing = core.read_persistent_volume(name=name)
            phase = getattr(getattr(existing, "status", None), "phase", None)
            if phase in ("Released", "Available"):
                core.patch_persistent_volume(name=name, body={"spec": {"claimRef": None}})
        except Exception as patch_exc:
            logger.warning("wsseed root pv %s claimRef clear failed: %s", name, patch_exc)
    try:
        core.create_namespaced_persistent_volume_claim(namespace=namespace, body=pvc_body)
    except Exception as exc:
        if getattr(exc, "status", None) != 409:
            raise


class SeedWorkspaceDataRequest(BaseModel):
    """Seed (copy) one JuiceFS workspace subPath from another (hermetic fork)."""

    workspaceExecutionId: str  # destination (the fork's fresh workspace key)
    seedWorkspaceFrom: str  # source (the run being forked from)
    executionClass: str | None = None


@app.post("/internal/workspace/seed-data", status_code=status.HTTP_200_OK)
def seed_workspace_data(
    request: Request, body: SeedWorkspaceDataRequest
) -> dict[str, Any]:
    """Start an ASYNC CoW-clone Job to seed a fork's fresh workspace from the source run's
    subPath (node-type-agnostic — works whether or not the resumed node runs in an agent
    pod). Returns IMMEDIATELY with the Job name; the caller polls `/seed-data/status`.

    Async because cloning a many-small-file workspace (repo/.git) is metadata-bound on a
    Postgres-backed JuiceFS — `juicefs clone` is ~7x faster than `cp` but still O(files),
    so a synchronous wait blew the HTTP/Node request-timeout budget (504 → fork errored).
    The Job ROOT-mounts the JuiceFS volume (source + dest under one mount) and CoW-clones.
    Idempotent (copy-if-empty)."""
    _require_internal(request)
    dest = (body.workspaceExecutionId or "").strip()
    src = (body.seedWorkspaceFrom or "").strip()
    if not dest or not src:
        raise HTTPException(
            status_code=400, detail="workspaceExecutionId + seedWorkspaceFrom required"
        )
    if dest == src:
        return {"success": True, "skipped": "same_subpath", "done": True}
    class_config = _resolve_juicefs_class(body.executionClass)
    if class_config is None:
        raise HTTPException(
            status_code=409, detail="no juicefs-shared execution class configured"
        )

    namespace = _agent_workflow_host_namespace()
    root_pvc = "wsseed-root"
    job_name = f"wsseed-{sha256(dest.encode()).hexdigest()[:12]}-{uuid4().hex[:6]}"
    seed_image = os.environ.get("WORKSPACE_SEED_JUICEFS_IMAGE", "juicedata/mount:ce-v1.3.1")
    job_body = {
        "apiVersion": "batch/v1",
        "kind": "Job",
        "metadata": {"name": job_name, "namespace": namespace, "labels": {"app": "workspace-seed"}},
        "spec": {
            "backoffLimit": 1,
            "ttlSecondsAfterFinished": 600,
            "template": {
                "metadata": {"labels": {"app": "workspace-seed"}},
                "spec": {
                    "restartPolicy": "Never",
                    "containers": [
                        {
                            "name": "seed",
                            "image": seed_image,
                            "command": ["sh", "-c", _seed_clone_cmd()],
                            "env": [
                                {"name": "SRC_SUB", "value": src},
                                {"name": "DST_SUB", "value": dest},
                            ],
                            "volumeMounts": [{"name": "root", "mountPath": "/jfs"}],
                        }
                    ],
                    "volumes": [
                        {"name": "root", "persistentVolumeClaim": {"claimName": root_pvc}},
                    ],
                },
            },
        },
    }

    if os.environ.get("SANDBOX_EXECUTION_DRY_RUN", "").lower() in {"1", "true", "yes"}:
        return {"dryRun": True, "job": job_name, "dest": dest, "source": src}

    batch, core = _load_k8s_clients()
    _ensure_root_pv(core, name=root_pvc, class_config=class_config, namespace=namespace)
    batch.create_namespaced_job(namespace=namespace, body=job_body)
    return {"success": True, "job": job_name, "namespace": namespace, "status": "running", "done": False}


class SeedWorkspaceStatusRequest(BaseModel):
    job: str
    namespace: str | None = None


@app.post("/internal/workspace/seed-data/status", status_code=status.HTTP_200_OK)
def seed_workspace_data_status(
    request: Request, body: SeedWorkspaceStatusRequest
) -> dict[str, Any]:
    """Poll a seed clone Job (started by /seed-data). Returns {done, succeeded, failed}."""
    _require_internal(request)
    job_name = (body.job or "").strip()
    if not job_name:
        raise HTTPException(status_code=400, detail="job required")
    namespace = (body.namespace or "").strip() or _agent_workflow_host_namespace()
    batch, _core = _load_k8s_clients()
    try:
        st = batch.read_namespaced_job_status(name=job_name, namespace=namespace).status
    except Exception as exc:
        if getattr(exc, "status", None) == 404:
            # TTL-reaped after success, or never created — treat as not-found.
            raise HTTPException(status_code=404, detail=f"seed job {job_name} not found")
        raise
    succeeded = bool(getattr(st, "succeeded", None))
    failed = bool(getattr(st, "failed", None))
    return {
        "job": job_name,
        "done": succeeded or failed,
        "succeeded": succeeded,
        "failed": failed,
        "active": int(getattr(st, "active", 0) or 0),
    }

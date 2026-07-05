from __future__ import annotations

import json
import logging
import os
import re
import secrets
import threading
import time
from contextlib import asynccontextmanager
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
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


@asynccontextmanager
async def _lifespan(_app: "FastAPI"):
    # Start the A3 warm-pool reconcile thread iff enabled (VCLUSTER_PREVIEW_POOL_SIZE>0); a no-op
    # otherwise. Defined here so it runs under uvicorn (not on bare import in tests).
    try:
        _start_pool_manager()
    except Exception as exc:  # pragma: no cover - never block startup on the optional pool
        logger.warning("pool-manager: startup failed: %s", exc)
    # A4 lifecycle reaper (sleep/TTL/capacity) — a no-op unless one of its flags is set
    # (VCLUSTER_PREVIEW_SLEEP_AFTER_MINUTES / _TTL_HOURS / _TOTAL_MAX > 0).
    try:
        _start_lifecycle_reaper()
    except Exception as exc:  # pragma: no cover - never block startup on the reaper
        logger.warning("lifecycle-reaper: startup failed: %s", exc)
    yield


app = FastAPI(title="sandbox-execution-api", lifespan=_lifespan)

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
    # envFrom sources (configMapRef/secretRef) applied verbatim to the dev
    # container — lets a functional preview reuse the prod app's config + secrets
    # (e.g. workflow-builder-secrets carrying DATABASE_URL) without copying
    # plaintext into the Sandbox CR. Per-service envFrom is normally supplied on
    # the request (from the dev-preview registry), not the shared class.
    serviceEnvFrom: list[dict[str, Any]] | None = None


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
    # Named-command allowlist for the sidecar's POST /__run (sidecar mode only).
    # Stamped verbatim into the pod's DEV_SYNC_COMMANDS_JSON env; the sidecar runs
    # ONLY these named commands in the workdir (never an arbitrary request string).
    # `deps` is reserved for the dependency reinstall; other names are test lanes
    # (e.g. `contract`). Populated by the BFF from the dev-preview registry.
    devSyncCommands: dict[str, str] | None = None
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
    # Apply the orchestrator-specific Dapr-shadow env knobs
    # (DAPR_CONFIG_STORE=disabled-dev, PUBSUB_NAME=pubsub-dev). Correct for the
    # workflow-orchestrator shadow; OFF for app services (e.g. the BFF) that just
    # need a daprd sidecar and would be mis-pointed by these.
    applyDaprShadowDefaults: bool = True
    # envFrom sources (configMapRef/secretRef) for the dev container — used by a
    # functional preview to reuse the prod app's config + secrets.
    envFrom: list[dict[str, Any]] | None = None
    # Per-preview secret values (e.g. DATABASE_URL pointing at the preview's own
    # database). Stored in a per-preview Secret (never plaintext in the CR) and
    # envFrom'd LAST so they override the reused prod secret.
    serviceSecretEnv: dict[str, str] | None = None
    # ----- preview-native adopt mode (in-preview agentic dev loop, P1) -----
    # When True this dev-server pod REPLACES a running prod Deployment INSIDE a
    # Tier-2 vcluster preview: it ADOPTS the preview's own Service (so the preview's
    # existing tailnet URL serves the live-edited build) and reuses the preview's
    # own DB/secrets (via envFrom) instead of a throwaway preview DB + Dapr-shadow.
    # The vcluster IS the isolation boundary, so no nested DB/shadow is needed.
    previewNative: bool = False
    # Service whose `.spec.selector` the dev pod adopts so the Service routes to it.
    # SEA reads the live selector (privileged) and merges it onto the pod labels
    # (the selector wins on key collisions, e.g. `app`).
    adoptService: str | None = None
    # Deployment scaled to 0 on provision (frees the Service endpoints + the prod
    # Dapr app-id so the dev pod can claim it) and restored to its original replica
    # count on teardown. The prior replica count is stashed in a Deployment
    # annotation so teardown survives an SEA restart.
    adoptDeployment: str | None = None
    # When True (preview-native BFF adopt over HTTPS), co-locate an nginx
    # tls-terminator sidecar (https-tls:8443 → 127.0.0.1:<port>) using the wildcard
    # cert, so the adopted dev pod serves HTTPS at the preview's tailnet URL exactly
    # like the prod BFF it replaces. The prod tls-terminator sidecar is NOT otherwise
    # copied into the dev Sandbox, so without this the prod LB (targetPort https-tls)
    # finds no endpoint → 502.
    adoptTlsTerminator: bool = False
    # Inline container env inherited from the adopted prod Deployment (set
    # server-side by provision via _adopt_read_identity, not by the caller). Merged as
    # the BASE of the dev pod's env (the dev-specific env overrides), so the adopted
    # BFF carries the prod CLI-runtime app-ids/images + DAPR_* knobs needed to
    # dispatch CLI agent sandboxes (else interactive CLI sessions wedge).
    adoptInheritedEnv: list[dict[str, Any]] | None = None


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


def _agent_host_topic_env(agent_app_id: str) -> list[dict[str, str]]:
    prefix = os.environ.get("SANDBOX_EXECUTION_AGENT_TOPIC_PREFIX", "").strip().strip(".")
    if not prefix:
        return []
    return [
        {"name": "AGENT_TOPIC", "value": f"{prefix}.{agent_app_id}.requests"},
        {
            "name": "AGENT_BROADCAST_TOPIC",
            "value": f"{prefix}.{agent_app_id}.broadcast",
        },
    ]


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
    # An EMPTY localQueue opts the class OUT of Kueue (no queue-name label → the pod
    # is not gated and schedules directly). Required for vcluster-synced preview pods:
    # the host Kueue plain-pod webhook fights the vcluster pod-syncer over the gate and
    # churns the pod (validated). Such previews bound capacity by vcluster-count, not Kueue.
    kueue_labels: dict[str, str] = {}
    if class_config.localQueue:
        kueue_labels[KUEUE_QUEUE_LABEL] = class_config.localQueue
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


def _load_k8s_apps_client():
    from kubernetes import client, config

    try:
        config.load_incluster_config()
    except Exception:
        config.load_kube_config()
    return client.AppsV1Api()


# Stashes a Deployment's replica count before preview-native adopt scales it to 0,
# so teardown can restore it (survives an SEA restart — state lives on the object).
DEV_PREVIEW_ORIGINAL_REPLICAS_ANNOTATION = "wfb-dev-preview/original-replicas"


def _adopt_read_identity(
    apps: Any, *, namespace: str, name: str
) -> dict[str, Any] | None:
    """Read the prod Deployment's pod identity (ServiceAccount + Dapr
    app-id/config/app-port) so the dev pod can FAITHFULLY assume it instead of
    guessing. Read-only. Returns the identity, or None if the Deployment is absent.
    """
    try:
        dep = apps.read_namespaced_deployment(name=name, namespace=namespace)
    except Exception as exc:
        if getattr(exc, "status", None) == 404:
            logger.info("adopt: deployment %s not found; no identity", name)
            return None
        raise
    spec = dep.spec
    template = spec.template if spec else None
    tmpl_meta = template.metadata if template else None
    tmpl_spec = template.spec if template else None
    pod_annotations = (tmpl_meta.annotations or {}) if tmpl_meta else {}
    # Inherit the prod app container's INLINE env so the dev pod that REPLACES it is a
    # faithful stand-in. This is essential for the BFF: it carries the CLI-runtime
    # app-ids/images (CLAUDE_CODE_CLI_APP_ID, AGENT_RUNTIME_*_DEFAULT_IMAGE) + the
    # DAPR_* secret/config-store knobs the BFF needs to dispatch CLI agent sandboxes;
    # without them the adopted dev BFF wedges interactive CLI sessions. envFrom is
    # already reused via the descriptor; only the inline env was missing.
    container_env: list[dict[str, Any]] | None = None
    if tmpl_spec and tmpl_spec.containers:
        main = next(
            (c for c in tmpl_spec.containers if c.name == name),
            tmpl_spec.containers[0],
        )
        if main.env:
            try:
                container_env = apps.api_client.sanitize_for_serialization(main.env)
            except Exception as exc:  # noqa: BLE001 — best-effort; fall back to envFrom only
                logger.warning("adopt: failed to read %s container env: %s", name, exc)
                container_env = None
    return {
        "serviceAccountName": (tmpl_spec.service_account_name if tmpl_spec else None),
        "daprAppId": pod_annotations.get("dapr.io/app-id"),
        "daprConfig": pod_annotations.get("dapr.io/config"),
        "daprAppPort": pod_annotations.get("dapr.io/app-port"),
        "containerEnv": container_env,
    }


def _adopt_scale_deployment_down(apps: Any, *, namespace: str, name: str) -> None:
    """Scale the adopted Deployment to 0 (freeing the Service endpoints), stashing
    its prior replica count in an annotation so teardown can restore it. Idempotent."""
    try:
        dep = apps.read_namespaced_deployment(name=name, namespace=namespace)
    except Exception as exc:
        if getattr(exc, "status", None) == 404:
            logger.info("adopt: deployment %s not found; skip scale-down", name)
            return
        raise
    dep_annotations = (dep.metadata.annotations or {}) if dep.metadata else {}
    current = dep.spec.replicas if dep.spec and dep.spec.replicas is not None else 1
    stashed = dep_annotations.get(DEV_PREVIEW_ORIGINAL_REPLICAS_ANNOTATION)
    original = stashed if stashed is not None else (str(current) if current > 0 else "1")
    apps.patch_namespaced_deployment(
        name=name,
        namespace=namespace,
        body={
            "metadata": {
                "annotations": {DEV_PREVIEW_ORIGINAL_REPLICAS_ANNOTATION: original}
            },
            "spec": {"replicas": 0},
        },
    )
    logger.info("adopt: scaled deployment %s to 0 (original=%s)", name, original)


def _dev_pod_has_daprd(pod: Any) -> bool:
    """True if the pod carries an injected daprd sidecar.

    daprd can be a NATIVE sidecar (an init container with restartPolicy: Always) OR a
    classic sidecar (a regular container); the injector also stamps the
    `dapr.io/sidecar-injected=true` label. Check all three — auditing only
    `.spec.containers` misses the native-sidecar case."""
    status = getattr(pod, "status", None)
    for statuses in (
        getattr(status, "init_container_statuses", None),
        getattr(status, "container_statuses", None),
    ):
        if any(getattr(cs, "name", "") == "daprd" for cs in (statuses or [])):
            return True
    meta = getattr(pod, "metadata", None)
    labels = (getattr(meta, "labels", None) or {}) if meta else {}
    return labels.get("dapr.io/sidecar-injected") == "true"


def _wait_for_dapr_injector_available(apps: Any, *, timeout_seconds: int = 60) -> bool:
    """Best-effort: wait for the (in-vcluster) Dapr sidecar-injector Deployment to be
    Available BEFORE creating a needsDapr Sandbox. The injector webhook is FAIL-OPEN
    (failurePolicy: Ignore), so a pod created while the injector is down comes up with
    NO daprd (cold-start race). Returns True once available; False on timeout (the
    caller proceeds anyway — the deferred daprd-present assert is the backstop, and a
    hard-fail here would block provisioning if the RBAC/name assumptions are wrong)."""
    ns = os.environ.get("DAPR_SIDECAR_INJECTOR_NAMESPACE", "dapr-system")
    name = os.environ.get("DAPR_SIDECAR_INJECTOR_DEPLOYMENT", "dapr-sidecar-injector")
    deadline = time.monotonic() + max(timeout_seconds, 0)
    while True:
        try:
            dep = apps.read_namespaced_deployment(name=name, namespace=ns)
            available = (
                getattr(getattr(dep, "status", None), "available_replicas", None) or 0
            )
            if available >= 1:
                return True
        except Exception as exc:
            logger.info("dapr injector availability check error: %s", exc)
        if time.monotonic() >= deadline:
            logger.warning(
                "dapr injector %s/%s not Available within %ss; provisioning anyway "
                "(deferred daprd-present assert is the backstop)",
                ns,
                name,
                timeout_seconds,
            )
            return False
        time.sleep(2)


def _adopt_deferred_scale_down(
    *,
    namespace: str,
    deployment: str,
    execution_id: str,
    wait_seconds: int,
    service: str | None = None,
    needs_dapr: bool = False,
) -> None:
    """Background target: wait for the dev pod to be Ready, THEN scale the prod
    Deployment to 0. Deferring is REQUIRED when the dev pod adopts the BFF's own
    Service: scaling the BFF to 0 during the provision request would kill the very
    pod serving it (→ 502). By the time this runs, the provision response has long
    returned through the still-up prod pod. Only scales once the dev pod is Ready,
    so there is NO downtime; if the dev pod never becomes Ready, the prod Deployment
    is LEFT UP (failsafe — the preview keeps serving)."""
    import time

    try:
        apps = _load_k8s_apps_client()
        _, core = _load_k8s_clients()
    except Exception as exc:
        logger.warning("adopt: deferred scale-down could not load clients: %s", exc)
        return
    # Scope to (execution, service): with N dev pods sharing one execution, an
    # execution-id-only selector would scale service B's prod Deployment to 0 the
    # moment service A's dev pod became Ready. `dev-preview-service` is stamped on
    # every dev pod (build_dev_preview_sandbox_manifest) and never appears in a
    # Service selector, so it survives the adopt-selector merge.
    selector = (
        f"workflow-execution-id={_safe_name(execution_id, max_length=63)},"
        f"dev-preview-service={_dev_preview_service_label(service)}"
    )
    # Generous: the full BFF vite dev server can cold-boot well past waitReadySeconds.
    # Until the dev pod is Ready the prod Deployment is LEFT UP, so over-waiting only
    # delays the cutover; it never causes downtime.
    recreated = False
    deadline = time.monotonic() + max(wait_seconds, 600)
    while time.monotonic() < deadline:
        try:
            pods = core.list_namespaced_pod(
                namespace=namespace, label_selector=selector
            ).items
            ready_pod = next(
                (
                    p
                    for p in pods
                    if any(
                        cs.name == "dev" and cs.ready
                        for cs in (p.status.container_statuses or [])
                    )
                ),
                None,
            )
            if ready_pod is not None:
                # Defense-in-depth (the Dapr injector is FAIL-OPEN — failurePolicy
                # Ignore): a needsDapr adopt pod can come up Ready with NO daprd
                # (cold-start injection race). Scaling the prod Deployment to 0 into a
                # daprd-less adopt would break BFF→orchestrator invocation with no
                # failsafe. So assert daprd is present; if missing, delete the pod ONCE
                # to force a fresh injection (the Sandbox controller recreates it, the
                # injector now warm); if STILL missing, LEAVE PROD UP (the preview keeps
                # serving via prod — a degraded but working state).
                if needs_dapr and not _dev_pod_has_daprd(ready_pod):
                    if not recreated:
                        recreated = True
                        logger.warning(
                            "adopt: dev pod %s Ready but NO daprd (fail-open injector "
                            "race); deleting to force re-injection (exec %s)",
                            ready_pod.metadata.name,
                            execution_id,
                        )
                        try:
                            core.delete_namespaced_pod(
                                name=ready_pod.metadata.name, namespace=namespace
                            )
                        except Exception as exc:
                            logger.warning(
                                "adopt: daprd-retry pod delete failed: %s", exc
                            )
                        time.sleep(10)
                        continue
                    logger.error(
                        "adopt: dev pod for exec %s Ready but STILL no daprd after "
                        "recreate; leaving %s UP (failsafe — preview serves via prod)",
                        execution_id,
                        deployment,
                    )
                    return
                # Grace so the provision HTTP response (which returns when the dev
                # pod is Ready) fully propagates orchestrator←router←BFF BEFORE we
                # scale the BFF to 0 — otherwise the scale could still kill the pod
                # mid-response.
                time.sleep(15)
                _adopt_scale_deployment_down(
                    apps, namespace=namespace, name=deployment
                )
                logger.info(
                    "adopt: dev pod ready (daprd ok) → scaled %s to 0 (exec %s)",
                    deployment,
                    execution_id,
                )
                return
        except Exception as exc:
            logger.warning("adopt: deferred scale-down poll error: %s", exc)
        time.sleep(5)
    logger.warning(
        "adopt: dev pod for exec %s not Ready within %ss; leaving %s UP (failsafe)",
        execution_id,
        wait_seconds,
        deployment,
    )


def _adopt_restore_deployment(apps: Any, *, namespace: str, name: str) -> None:
    """Restore a Deployment scaled down by preview-native adopt to its original
    replica count (from the stashed annotation; default 1). Best-effort."""
    try:
        dep = apps.read_namespaced_deployment(name=name, namespace=namespace)
    except Exception as exc:
        if getattr(exc, "status", None) == 404:
            logger.info("adopt: deployment %s gone; nothing to restore", name)
            return
        raise
    annotations = (dep.metadata.annotations or {}) if dep.metadata else {}
    try:
        replicas = int(annotations.get(DEV_PREVIEW_ORIGINAL_REPLICAS_ANNOTATION, "1"))
    except (TypeError, ValueError):
        replicas = 1
    apps.patch_namespaced_deployment(
        name=name,
        namespace=namespace,
        body={
            "metadata": {
                "annotations": {DEV_PREVIEW_ORIGINAL_REPLICAS_ANNOTATION: None}
            },
            "spec": {"replicas": max(replicas, 1)},
        },
    )
    logger.info("adopt: restored deployment %s to %s replicas", name, max(replicas, 1))


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
                    *_agent_host_topic_env(request.agentAppId),
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
        "benchmark-run-id": run_label,
        "benchmark-instance-id": instance_label,
        "agent-app-id": app_label,
        "workflow-builder.cnoe.io/session-id": session_label,
    }
    # Empty localQueue → no Kueue gate (vcluster-synced preview pods; see _job manifest
    # builder). The kueue priority-class label is meaningful only when Kueue manages the pod.
    if class_config.localQueue:
        pod_labels[KUEUE_QUEUE_LABEL] = class_config.localQueue
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


def _dev_preview_service_label(service: str | None) -> str:
    """The `dev-preview-service` label value stamped on every dev-preview pod/CR/Secret.

    Single source of truth so the readiness/scale-down/teardown SELECTORS match what
    `build_dev_preview_sandbox_manifest` stamps. Defaults to `workflow-builder` for
    back-compat with the single-service path (which never sent a `service`)."""
    return _safe_name(service or "workflow-builder", max_length=63)


def _dev_preview_sandbox_name(execution_id: str, service: str | None = None) -> str:
    # Scope the deterministic name by (execution, service) so N dev pods can share one
    # execution without colliding on the CR name (the 409 idempotency then keys per
    # service). A falsy `service` keeps the legacy `wfb-dev-preview-<exec>` name so
    # in-flight single-service sessions torn down by name still resolve.
    if service:
        return _safe_resource_name(
            f"wfb-dev-preview-{_safe_name(service, max_length=24)}-{execution_id}",
            max_length=63,
        )
    return _safe_resource_name(f"wfb-dev-preview-{execution_id}", max_length=63)


def _dev_preview_secret_name(execution_id: str, service: str | None = None) -> str:
    if service:
        return _safe_resource_name(
            f"dev-preview-secret-{_safe_name(service, max_length=24)}-{execution_id}",
            max_length=63,
        )
    return _safe_resource_name(f"dev-preview-secret-{execution_id}", max_length=63)


def _ensure_dev_preview_secret(
    core: Any, request: DevPreviewRequest, *, namespace: str
) -> str | None:
    """Create/refresh the per-preview Secret (e.g. the preview's DATABASE_URL).

    Created BEFORE the Sandbox CR so the pod never races a missing secretRef.
    Keeps preview secrets out of the Sandbox CR / pod spec plaintext.
    """
    if not request.serviceSecretEnv:
        return None
    secret_name = _dev_preview_secret_name(request.executionId, request.service)
    labels = {
        "app": "wfb-dev-preview",
        "workflow-execution-id": _safe_name(request.executionId, max_length=63),
        # Service-scoped so tearing down one service deletes only ITS secret, not a
        # sibling service's secret sharing the same execution id.
        "dev-preview-service": _dev_preview_service_label(request.service),
    }
    string_data = {k: v for k, v in request.serviceSecretEnv.items() if k}
    body = {
        "apiVersion": "v1",
        "kind": "Secret",
        "type": "Opaque",
        "metadata": {"name": secret_name, "namespace": namespace, "labels": labels},
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
            body={"metadata": {"labels": labels}, "stringData": string_data},
        )
    return secret_name


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
    adopt_selector: dict[str, str] | None = None,
) -> dict[str, Any]:
    """A PLAIN single-container `vite dev` Sandbox (no daprd/app-id/OpenShell).

    The Playwright critic and the agent's /__sync push reach this pod directly at
    its pod IP:port; no Dapr service invocation, no DB, no secrets.

    In preview-native adopt mode (`request.previewNative`), the pod additionally
    carries `adopt_selector` labels (the target Service's selector) so the preview's
    own Service routes to it, and the Sandbox CR records the adopted Deployment so
    teardown can restore it.
    """
    exec_label = _safe_name(request.executionId, max_length=63)
    image = request.image or class_config.serviceImage or DEFAULT_DEV_PREVIEW_IMAGE
    port = request.port or class_config.servicePort or 3000
    workdir = (request.workdir or class_config.serviceWorkdir or "/app").rstrip("/") or "/app"
    health_path = request.healthPath or class_config.serviceHealthPath or "/"
    sync_mode = (request.syncMode or "plugin").lower()
    use_sidecar = sync_mode == "sidecar"
    sync_port = request.syncPort or (8001 if use_sidecar else port)
    service_label = _dev_preview_service_label(request.service)
    command = request.command or class_config.serviceCommand
    args = request.args or class_config.serviceArgs

    # Main dev-server env. workflow-builder's in-process Vite /__sync plugin reads
    # WFB_DEV_SYNC_* (plugin mode only); other services use the sidecar and don't.
    # A "functional" preview wires the app's config/secrets + its own DB (envFrom
    # / serviceSecretEnv). UI-only previews have neither → skip startup migrations
    # (no DB); functional previews self-migrate their empty preview DB on boot.
    functional = bool(
        request.envFrom or request.serviceSecretEnv or class_config.serviceEnvFrom
    )
    env: list[dict[str, str]] = [{"name": "NODE_ENV", "value": "development"}]
    if not use_sidecar:
        env.append({"name": "WFB_DEV_SYNC_ENABLED", "value": "true"})
        if not functional:
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
        # APP_ID is informational on every shadow; the orchestrator-only isolation
        # knobs are gated so they don't mis-point app services like the BFF.
        dapr_defaults["APP_ID"] = dapr_app_id or ""
        if request.applyDaprShadowDefaults:
            dapr_defaults["DAPR_CONFIG_STORE"] = "disabled-dev"
            dapr_defaults["PUBSUB_NAME"] = "pubsub-dev"
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
    # Preview-native adopt: merge the inherited prod Deployment inline env UNDERNEATH
    # the dev env above (deduped by name; the dev env wins on collisions like
    # NODE_ENV=development). This carries the prod CLI-runtime app-ids/images +
    # DAPR_* secret/config-store knobs so the adopted BFF can dispatch CLI agent
    # sandboxes instead of wedging interactive sessions. Preserves valueFrom entries.
    if request.adoptInheritedEnv:
        by_name: dict[str, dict[str, Any]] = {}
        for entry in request.adoptInheritedEnv:
            if isinstance(entry, dict) and entry.get("name"):
                by_name[entry["name"]] = entry
        for entry in env:  # dev env overrides the inherited prod env
            if entry.get("name"):
                by_name[entry["name"]] = entry
        env = list(by_name.values())
    # envFrom (configMapRef/secretRef) for a functional preview that reuses the
    # prod app's config + secrets. Explicit `env` (above) overrides envFrom, so a
    # per-preview DATABASE_URL passed via request.env wins over the shared secret.
    env_from = list(request.envFrom or class_config.serviceEnvFrom or [])
    container: dict[str, Any] = {
        "name": "dev",
        "image": image,
        "imagePullPolicy": _image_pull_policy_for_agent_host(image),
        "ports": [{"name": "http", "containerPort": port}],
        "env": env,
        **({"envFrom": env_from} if env_from else {}),
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

    init_containers: list[dict[str, Any]] = []
    # Functional preview: clone the dev schema into the per-preview database with
    # `pg_dump --schema-only | psql` before the dev server starts. We use pg_dump
    # (not drizzle-kit, whose tsconfig `$lib` aliases don't resolve, nor the
    # runtime images, which don't ship atlas/migrations) because it always
    # reflects the CURRENT dev schema, works while the source DB has live
    # connections, and needs no maintained template. DATABASE_URL (target) +
    # PREVIEW_SOURCE_DATABASE_URL (source) come from the per-preview Secret.
    # Preview-native adopt reuses the PREVIEW's already-migrated DB (no throwaway
    # DB, no source set) → skip the clone init entirely.
    if functional and not request.previewNative:
        init_containers.append(
            {
                "name": "db-clone",
                "image": os.environ.get(
                    "DEV_PREVIEW_PG_IMAGE",
                    "docker.io/library/postgres:15.3-alpine3.18",
                ),
                "command": [
                    "sh",
                    "-c",
                    'set -e; if [ -z "$PREVIEW_SOURCE_DATABASE_URL" ]; then '
                    'echo "no source DB; skipping schema clone"; exit 0; fi; '
                    'pg_dump --schema-only --no-owner --no-privileges '
                    '"$PREVIEW_SOURCE_DATABASE_URL" | psql -v ON_ERROR_STOP=0 '
                    '"$DATABASE_URL"; echo "schema clone done"',
                ],
                **({"envFrom": env_from} if env_from else {}),
                "resources": {
                    "requests": {"cpu": "100m", "memory": "256Mi"},
                    "limits": {"memory": "512Mi"},
                },
            }
        )

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
        init_containers.append(
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
        )
        sidecar_env = [
            {"name": "DEV_SYNC_PORT", "value": str(sync_port)},
            {"name": "DEV_SYNC_DEST", "value": workdir},
        ]
        if request.syncToken:
            sidecar_env.append({"name": "DEV_SYNC_TOKEN", "value": request.syncToken})
        # /__run allowlist: the named deps/test commands from the dev-preview
        # registry. The sidecar parses this ONCE at boot; only these names run.
        if request.devSyncCommands:
            sidecar_env.append(
                {
                    "name": "DEV_SYNC_COMMANDS_JSON",
                    "value": json.dumps(request.devSyncCommands, sort_keys=True),
                }
            )
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

    if init_containers:
        pod_spec["initContainers"] = init_containers
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
    # Preview-native BFF adopt over HTTPS: co-locate the SAME nginx tls-terminator
    # the prod Deployment uses (https-tls:8443 → 127.0.0.1:<port>), so the prod
    # tailnet LB (targetPort https-tls) serves this dev pod over HTTPS with the
    # wildcard cert — making the adopt Sandbox a faithful dev replica of the prod BFF.
    if request.adoptTlsTerminator:
        tls_image = os.environ.get(
            "DEV_PREVIEW_TLS_TERMINATOR_IMAGE",
            "docker.io/nginxinc/nginx-unprivileged:1.27-alpine",
        )
        tls_secret = os.environ.get("DEV_PREVIEW_TLS_SECRET", "tailnet-wildcard-tls")
        tls_conf_cm = os.environ.get(
            "DEV_PREVIEW_TLS_CONF_CONFIGMAP", "workflow-builder-tls-terminator"
        )
        pod_spec["containers"].append(
            {
                "name": "tls-terminator",
                "image": tls_image,
                "imagePullPolicy": "IfNotPresent",
                "ports": [{"name": "https-tls", "containerPort": 8443}],
                "volumeMounts": [
                    {
                        "name": "tailnet-wildcard-tls",
                        "mountPath": "/etc/nginx/tls",
                        "readOnly": True,
                    },
                    {
                        "name": "tls-terminator-conf",
                        "mountPath": "/etc/nginx/conf.d",
                        "readOnly": True,
                    },
                ],
                "resources": {
                    "requests": {"cpu": "10m", "memory": "32Mi"},
                    "limits": {"memory": "128Mi"},
                },
            }
        )
        pod_spec.setdefault("volumes", []).extend(
            [
                {
                    "name": "tailnet-wildcard-tls",
                    "secret": {"secretName": tls_secret},
                },
                {
                    "name": "tls-terminator-conf",
                    "configMap": {"name": tls_conf_cm},
                },
            ]
        )
    pod_labels = {
        "app": "wfb-dev-preview",
        "dev-preview-service": service_label,
        "workflow-execution-id": exec_label,
    }
    # Preview-native adopt: merge the target Service's selector LAST so it wins on
    # collisions (e.g. `app` flips from `wfb-dev-preview` to the prod value) and the
    # preview's own Service routes to this dev pod. `workflow-execution-id` is never
    # in a Service selector, so it survives → readiness/teardown still find the pod.
    if request.previewNative and adopt_selector:
        for key, value in adopt_selector.items():
            if key and value is not None:
                pod_labels[key] = value
    # Empty localQueue → no Kueue gate (vcluster-synced preview pods).
    if class_config.localQueue:
        pod_labels[KUEUE_QUEUE_LABEL] = class_config.localQueue
    pod_template_metadata: dict[str, Any] = {"labels": pod_labels}
    # Dapr-shadow: stamp the standard injector annotations so the daprd sidecar is
    # added (mirrors build_agent_workflow_host_sandbox_manifest). The UNIQUE app-id
    # isolates the task hub/placement/actors; enable-workflow lets `wfr.start()`
    # run; the daprd attaches to the SAME single workflowstatestore under its own
    # app-id partition (does NOT add a 2nd actorStateStore=true component).
    if request.needsDapr:
        dapr_annotations = {
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
            # Native sidecar (daprd init container, restartPolicy: Always) — parity with
            # build_agent_workflow_host_sandbox_manifest. Native injection works in the
            # vcluster (confirmed: the adopt pod comes up with daprd in initContainers +
            # dapr.io/sidecar-injected=true); the fail-open injector cold-start race is
            # handled by the injector-Availability gate + the deferred daprd-present
            # assert, NOT by dropping native-sidecar.
            "dapr.io/enable-native-sidecar": "true",
            "dapr.io/placement-host-address": os.environ.get(
                "DAPR_PLACEMENT_HOST_ADDRESS",
                "dapr-placement-server.dapr-system.svc.cluster.local:50005",
            ),
            "dapr.io/max-body-size": os.environ.get("DAPR_MAX_BODY_SIZE", "16Mi"),
            "dapr.io/graceful-shutdown-seconds": "60",
            # Aggressive daprd readiness probe (agent-host parity — same 0/1/1 tuning as
            # build_agent_workflow_host_sandbox_manifest). daprd reports Ready ASAP so
            # the pod is not Ready-with-daprd-not-yet-up during the fail-open injector
            # cold-start window (the fn-system dapr-race mitigation).
            "dapr.io/sidecar-readiness-probe-delay-seconds": "0",
            "dapr.io/sidecar-readiness-probe-period-seconds": "1",
            "dapr.io/sidecar-readiness-probe-timeout-seconds": "1",
        }
        # Dapr internal-grpc-port is APP-LEVEL contract — it's the port daprd dials on a
        # PEER for service invocation, and Dapr uses the CALLER's configured value (it
        # assumes a cluster-uniform port). A preview-native adopt pod REPLACES a prod
        # Deployment and must service-invoke NON-adopted prod peers (e.g. the adopted
        # orchestrator → the still-prod function-router); prod sets no override (Dapr
        # default), so the adopt pod must match it, else the invoke hits
        # `connection refused` on 3502 (ERR_DIRECT_INVOKE). Agent-host dispatch is a
        # child WORKFLOW (ctx.call_child_workflow), which is placement-routed to the
        # target's REGISTERED port and so is unaffected by this. The host Dapr-shadow
        # path keeps the 3502 override (it is isolated + agent-host-parity).
        if not request.previewNative:
            dapr_annotations["dapr.io/internal-grpc-port"] = os.environ.get(
                "DAPR_AGENT_HOST_INTERNAL_GRPC_PORT", "3502"
            )
        pod_template_metadata["annotations"] = dapr_annotations
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
    cr_metadata: dict[str, Any] = {
        "name": _dev_preview_sandbox_name(request.executionId, request.service),
        "namespace": namespace,
        "labels": {
            "app": "wfb-dev-preview",
            "dev-preview-service": service_label,
            "workflow-execution-id": exec_label,
            "sandbox-execution-class": _safe_name(request.executionClass),
        },
    }
    # Record the adopted Deployment so teardown can restore it without the caller
    # re-supplying it (teardown only receives the Sandbox name).
    if request.previewNative and request.adoptDeployment:
        cr_metadata["annotations"] = {
            "wfb-dev-preview/adopt-deployment": _safe_resource_name(
                request.adoptDeployment
            )
        }
    return {
        "apiVersion": "agents.x-k8s.io/v1alpha1",
        "kind": "Sandbox",
        "metadata": cr_metadata,
        "spec": sandbox_spec,
    }


def _wait_for_dev_preview_ready(
    core: Any,
    *,
    namespace: str,
    execution_id: str,
    wait_seconds: int,
    service: str | None = None,
    failure_probe: Any | None = None,
) -> tuple[str, str | None]:
    """Poll the dev-preview pod until Ready; return ``(status, podIP|None)``."""
    # Scope to (execution, service): with N dev pods sharing one execution, an
    # execution-id-only selector could return the WRONG service's pod IP. Key on
    # workflow-execution-id + dev-preview-service — both stamped on every dev pod and
    # never in a Service selector, so they survive the preview-native adopt-selector
    # merge (which overwrites `app`).
    selector = (
        f"workflow-execution-id={_safe_name(execution_id, max_length=63)},"
        f"dev-preview-service={_dev_preview_service_label(service)}"
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
    # Preview-native runs REAL app-ids inside a Tier-2 vcluster (the vcluster IS the
    # isolation boundary). The Dapr-shadow defaults (PUBSUB_NAME=pubsub-dev,
    # DAPR_CONFIG_STORE=disabled-dev) are a HOST-only hack; injected here they point
    # the pod at a `pubsub-dev` component that does not exist in the preview (its
    # component is named `pubsub`) → silently dead subscriptions. Force them OFF
    # server-side no matter what the caller sent (the BFF also sends false; this is
    # the defense-in-depth backstop).
    if body.previewNative:
        body.applyDaprShadowDefaults = False
    classes = _load_execution_classes()
    class_config = classes.get(body.executionClass)
    if class_config is None:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"unsupported executionClass {body.executionClass}",
        )
    namespace = _agent_workflow_host_namespace()
    # Per-preview secret (e.g. DATABASE_URL → the preview's own DB): create it +
    # envFrom it LAST so it overrides the reused prod secret. Append the secretRef
    # to envFrom BEFORE building the manifest so the dev container picks it up.
    preview_secret_name = (
        _dev_preview_secret_name(body.executionId, body.service)
        if body.serviceSecretEnv
        else None
    )
    if preview_secret_name:
        body.envFrom = list(body.envFrom or []) + [
            {"secretRef": {"name": preview_secret_name}}
        ]
    sandbox_name = _dev_preview_sandbox_name(body.executionId, body.service)
    adopt_selector: dict[str, str] | None = None
    pod_ip: str | None = None
    readiness_status = "queued"
    dry_run = os.environ.get("SANDBOX_EXECUTION_DRY_RUN", "").lower() in {
        "1",
        "true",
        "yes",
    }
    if not dry_run:
        apps = _load_k8s_apps_client()
        _, core = _load_k8s_clients()
        custom = _load_k8s_custom_objects_client()
        # Gate needsDapr provisions on the Dapr sidecar-injector being Available: the
        # injector webhook is fail-open, so creating the pod while it is still cold
        # yields NO daprd. Best-effort wait (the deferred daprd-present assert is the
        # backstop; never hard-fails provisioning).
        if body.needsDapr:
            _wait_for_dapr_injector_available(
                apps,
                timeout_seconds=int(
                    os.environ.get("DEV_PREVIEW_INJECTOR_WAIT_SECONDS", "60")
                ),
            )
        # Preview-native adopt (in a Tier-2 vcluster preview): read the target
        # Service's selector so the dev pod can adopt it (the Service then routes to
        # the dev pod). Read-only here — the prod Deployment scale-to-0 is DEFERRED
        # to a background thread (below) because the adopted service is usually the
        # BFF ITSELF: scaling it to 0 during this request would kill the pod serving
        # it (→ 502). The Dapr app-id may be held by multiple replicas, so no
        # exclusivity problem with the prod pod lingering briefly.
        if body.previewNative and body.adoptService:
            try:
                svc = core.read_namespaced_service(
                    name=_safe_resource_name(body.adoptService), namespace=namespace
                )
                adopt_selector = dict(svc.spec.selector or {}) if svc.spec else None
                logger.info(
                    "adopt: service %s selector=%s", body.adoptService, adopt_selector
                )
            except Exception as exc:
                logger.warning(
                    "adopt: failed reading service %s selector: %s",
                    body.adoptService,
                    exc,
                )
        if body.previewNative and body.adoptDeployment:
            # Faithfully assume the prod pod's identity (don't override an explicit
            # caller value). Critical when needsDapr: the dev pod must use the SAME
            # SA (RBAC-bound for daprd) + Dapr config the prod BFF used, and the
            # prod app-id.
            identity = _adopt_read_identity(
                apps, namespace=namespace, name=_safe_resource_name(body.adoptDeployment)
            )
            if identity:
                if identity.get("serviceAccountName") and not body.daprServiceAccount:
                    body.daprServiceAccount = identity["serviceAccountName"]
                if identity.get("daprConfig") and not body.daprConfig:
                    body.daprConfig = identity["daprConfig"]
                if identity.get("daprAppId") and not body.daprAppId:
                    body.daprAppId = identity["daprAppId"]
                # Inherit the prod container's inline env so the adopted BFF can
                # dispatch CLI agent sandboxes (CLI app-ids/images + DAPR_* knobs);
                # the dev-specific env (NODE_ENV=development, WFB_DEV_SYNC*) overrides.
                if identity.get("containerEnv") and not body.adoptInheritedEnv:
                    body.adoptInheritedEnv = identity["containerEnv"]
        manifest = build_dev_preview_sandbox_manifest(
            body,
            namespace=namespace,
            class_config=class_config,
            adopt_selector=adopt_selector,
        )
        if preview_secret_name:
            _ensure_dev_preview_secret(core, body, namespace=namespace)
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
        # Preview-native: DEFER the prod Deployment scale-to-0 to a background thread
        # that waits for the dev pod to be Ready (+grace) then scales. Doing it now
        # would kill the BFF pod serving this very request (the BFF adopts its own
        # Service) → 502. Started right after CR creation so it races the readiness
        # wait below but only scales once the dev pod can take over (no downtime).
        if body.previewNative and body.adoptDeployment:
            import threading

            threading.Thread(
                target=_adopt_deferred_scale_down,
                kwargs={
                    "namespace": namespace,
                    "deployment": _safe_resource_name(body.adoptDeployment),
                    "execution_id": body.executionId,
                    "wait_seconds": body.waitReadySeconds,
                    "service": body.service,
                    "needs_dapr": body.needsDapr,
                },
                daemon=True,
            ).start()
        readiness_status, pod_ip = _wait_for_dev_preview_ready(
            core,
            namespace=namespace,
            execution_id=body.executionId,
            wait_seconds=body.waitReadySeconds,
            service=body.service,
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
        # Clean up the per-preview Secret (labeled by exec id on the CR) before
        # removing the Sandbox. Best-effort; the GC reaper is the backstop. Also
        # capture the adopted Deployment (preview-native mode) so we restore it
        # AFTER the dev pod is gone (avoids two pods sharing one Dapr app-id).
        adopt_deployment: str | None = None
        try:
            _, core = _load_k8s_clients()
            cr = custom.get_namespaced_custom_object(
                group="agents.x-k8s.io",
                version="v1alpha1",
                namespace=namespace,
                plural="sandboxes",
                name=safe_name,
            )
            cr_metadata = (cr.get("metadata", {}) or {}) if cr else {}
            cr_labels = cr_metadata.get("labels", {}) or {}
            exec_label = cr_labels.get("workflow-execution-id")
            service_label = cr_labels.get("dev-preview-service")
            adopt_deployment = (cr_metadata.get("annotations", {}) or {}).get(
                "wfb-dev-preview/adopt-deployment"
            )
            if exec_label:
                # Scope the secret cleanup to THIS service so tearing down one dev
                # pod doesn't delete a sibling service's per-preview Secret sharing the
                # execution id. Old CRs predate the label → fall back to the
                # exec-only selector (single-service, so nothing else to protect).
                secret_selector = (
                    f"app=wfb-dev-preview,workflow-execution-id={exec_label}"
                )
                if service_label:
                    secret_selector += f",dev-preview-service={service_label}"
                core.delete_collection_namespaced_secret(
                    namespace=namespace,
                    label_selector=secret_selector,
                )
        except Exception as exc:
            logger.info("dev-preview secret cleanup skipped: %s", exc)
        _delete_agent_host_cr_and_wait(custom, namespace, safe_name)
        # Preview-native adopt: the dev pod is gone → restore the prod Deployment to
        # its original replica count (it reclaims the Service + its Dapr app-id).
        if adopt_deployment:
            try:
                apps = _load_k8s_apps_client()
                _adopt_restore_deployment(
                    apps, namespace=namespace, name=adopt_deployment
                )
            except Exception as exc:
                logger.warning(
                    "adopt: failed restoring deployment %s: %s", adopt_deployment, exc
                )
    return {"sandboxName": safe_name, "deleted": True}


@app.get("/internal/dev-previews")
def list_dev_previews(request: Request, executionId: str) -> dict[str, Any]:
    """Per-service dev-preview status for one workflow execution (Dev-hub polling).

    Mirrors the /internal/vcluster-previews list pattern. With N dev pods per
    execution (multi-service adopt) this returns one entry per `dev-preview-service`
    — the Sandbox name, the adopted Deployment (if any), readiness and pod IP — joined
    from the Sandbox CRs and their pods (both labeled workflow-execution-id +
    dev-preview-service, which survive the preview-native adopt-selector merge)."""
    _require_internal(request)
    namespace = _agent_workflow_host_namespace()
    exec_label = _safe_name(executionId, max_length=63)
    services: list[dict[str, Any]] = []
    if os.environ.get("SANDBOX_EXECUTION_DRY_RUN", "").lower() not in {
        "1",
        "true",
        "yes",
    }:
        custom = _load_k8s_custom_objects_client()
        _, core = _load_k8s_clients()
        selector = f"workflow-execution-id={exec_label}"
        # First pod per service (readiness/IP). The `app` label is overwritten by the
        # adopted Service selector, so key on the two labels that survive.
        pod_by_service: dict[str, Any] = {}
        try:
            pods = core.list_namespaced_pod(
                namespace=namespace, label_selector=selector
            ).items
        except Exception as exc:
            logger.warning("dev-previews: pod list failed: %s", exc)
            pods = []
        for pod in pods:
            labels = (pod.metadata.labels or {}) if pod.metadata else {}
            svc = labels.get("dev-preview-service")
            if svc and svc not in pod_by_service:
                pod_by_service[svc] = pod
        try:
            crs = custom.list_namespaced_custom_object(
                group="agents.x-k8s.io",
                version="v1alpha1",
                namespace=namespace,
                plural="sandboxes",
                label_selector=selector,
            ).get("items", [])
        except Exception as exc:
            logger.warning("dev-previews: sandbox list failed: %s", exc)
            crs = []
        for cr in crs:
            meta = cr.get("metadata", {}) or {}
            labels = meta.get("labels", {}) or {}
            svc = labels.get("dev-preview-service") or "workflow-builder"
            pod = pod_by_service.get(svc)
            services.append(
                {
                    "service": svc,
                    "sandboxName": meta.get("name"),
                    "adoptDeployment": (meta.get("annotations", {}) or {}).get(
                        "wfb-dev-preview/adopt-deployment"
                    ),
                    "ready": _pod_is_ready(pod) if pod is not None else False,
                    "podIP": (
                        getattr(getattr(pod, "status", None), "pod_ip", None)
                        if pod is not None
                        else None
                    ),
                }
            )
    return {"executionId": executionId, "services": services}


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


# ---------------------------------------------------------------------------
# Tier-2 full-isolation previews (vcluster). The BFF (unprivileged) asks this
# privileged service to create a Job that runs /config/runner.sh as the
# cluster-admin `vcluster-preview-provisioner` SA: vcluster create + Dapr +
# agent-sandbox + app-stack deploy + tailnet exposure (ACTION=up), or teardown
# (ACTION=down). The runner blocks until rollouts are ready, so Job success ==
# environment ready. See stacks .../workflow-builder-preview-vcluster/.
# ---------------------------------------------------------------------------

_VCLUSTER_PREVIEW_TAILNET_SUFFIX = os.environ.get(
    "VCLUSTER_PREVIEW_TAILNET_SUFFIX", "tail286401.ts.net"
)


def _vcluster_preview_max() -> int:
    """Max concurrent AWAKE preview vclusters (claimed + free-hot + regular). The A3 pool
    manager will not fill past this; the BFF 429s a cold provision past it. Matches the BFF's
    VCLUSTER_PREVIEW_MAX (default 6)."""
    try:
        n = int(os.environ.get("VCLUSTER_PREVIEW_MAX", "6"))
    except (TypeError, ValueError):
        n = 6
    return n if n > 0 else 6


def _vcluster_preview_pool_size() -> int:
    """Target number of FREE (baked, claimable) warm-pool members. 0 (default) = pool OFF —
    the whole A3 path stays dormant and previews cold-provision as before."""
    try:
        n = int(os.environ.get("VCLUSTER_PREVIEW_POOL_SIZE", "0"))
    except (TypeError, ValueError):
        n = 0
    return max(0, n)


def _env_int(name: str, default: int, *, minimum: int = 0) -> int:
    try:
        n = int(os.environ.get(name, str(default)) or default)
    except (TypeError, ValueError):
        n = default
    return max(minimum, n)


def _vcluster_preview_sleep_after_minutes() -> int:
    """A4: sleep an ACTIVITY-TRACKED preview after this many idle minutes (per its
    vcluster-preview-last-active annotation). 0 (default) = sleep OFF."""
    return _env_int("VCLUSTER_PREVIEW_SLEEP_AFTER_MINUTES", 0)


def _vcluster_preview_ttl_hours() -> int:
    """A4: tear a preview down this many hours after creation (or at its explicit
    vcluster-preview-expires-at annotation, whichever is SOONER). 0 (default) = the
    global creation-TTL is OFF; an explicit expires-at annotation is still honored
    by any reap pass (it is a per-preview opt-in marker, e.g. a PR preview's ttlHours)."""
    return _env_int("VCLUSTER_PREVIEW_TTL_HOURS", 0)


def _vcluster_preview_total_max() -> int:
    """A4: hard cap on ALL preview vclusters (awake + slept). 0 (default) = unlimited.
    VCLUSTER_PREVIEW_MAX stays the AWAKE-only cap (slept previews don't count against it)."""
    return _env_int("VCLUSTER_PREVIEW_TOTAL_MAX", 0)


def _vcluster_preview_active_minutes() -> int:
    """A4: a preview touched within this window counts as ACTIVE — the eviction
    selector never picks it, whatever its origin."""
    return _env_int("VCLUSTER_PREVIEW_ACTIVE_MINUTES", 30, minimum=1)


class VclusterPreviewRequest(BaseModel):
    """Provision (or tear down) a Tier-2 full-isolation preview vcluster."""

    name: str = Field(min_length=1, max_length=40)
    action: str = Field(default="up")  # up | down
    daprVersion: str | None = None
    tailnetHost: str | None = None
    previewDb: str | None = None
    # ENROLL_MODE=agent → deploy the BFF + run migrate/seed via a hub-authored
    # argocd-agent Application (GitOps-native) instead of the imperative runner deploy.
    # Defaults from env so it can be flipped cluster-wide without an API change.
    enrollMode: str | None = None  # imperative | agent
    targetRevision: str | None = None  # git ref the in-vcluster controller fetches
    # PREVIEW_DB_MODE=cnpg → per-preview isolated CloudNativePG Postgres inside the
    # vcluster (no shared host-Postgres connection ceiling). Defaults from env so it
    # can be flipped cluster-wide without an API change. cnpg | shared
    previewDbMode: str | None = None
    # PREVIEW_DEV_MODE=true → interactive dev preview: the dev image replaces the prod
    # BFF in-place via the adopt:true dev-preview Sandbox; the runner forces
    # EXPOSE_DEV_POD=false so the prod tailnet LB fronts the adopted dev pod (its
    # tls-terminator) over HTTPS. Defaults from env so it can be flipped without an API change.
    previewDevMode: bool | None = None
    # PREVIEW_OBSERVABILITY=disabled|async → disabled (default) keeps previews behavior-
    # identical to today (OTEL SDK off); async re-enables async OTLP export to the host
    # otel-collector replicated into the vcluster. Defaults from env so it can be flipped
    # cluster-wide without an API change.
    previewObservability: str | None = None
    # PREVIEW_PARALLEL_BRINGUP=true → runner backgrounds the independent infra installs
    # (Dapr/CNPG-operator/agent-sandbox/NATS) behind a hard barrier. Default false = serial.
    # A2, flagged default-off; env-defaulted for a cluster-wide flip without an API change.
    previewParallelBringup: bool | None = None
    # PREVIEW_DB_BOOTSTRAP=migrate|template → template clones the pre-seeded host
    # `preview_template` DB via CNPG import (cnpg mode) instead of empty-migrate+seed.
    # A2, flagged default-off (migrate); env-defaulted.
    previewDbBootstrap: str | None = None
    # POOL=true (A3) → bake a GENERIC warm-pool member: the runner labels the host ns
    # `vcluster-preview-pool=free`, records its image pins, and skips the (user-specific) CLI-
    # cred copy (deferred to claim). Set only by the SEA pool manager, never by a user request.
    pool: bool = False
    # ---- D1 lifecycle contract (all optional; absent = the legacy/human preview shape) ----
    # origin: who this preview belongs to — "user" (a human asked for it) or "pr" (a PR-preview
    # automation asked for it). Stamped as the `vcluster-preview-origin` ns label; PR-origin
    # previews are EVICTABLE by the A4 capacity logic, human ones are not.
    origin: str | None = None  # user | pr
    # prNumber: the GitHub PR a pr-origin preview serves; stamped as `vcluster-preview-pr`.
    prNumber: int | None = None
    # ttlHours: per-preview lifetime. SEA computes now+ttlHours and stamps it as the
    # `vcluster-preview-expires-at` RFC3339 ns annotation; any reap pass tears the preview
    # down once past it (independent of the global VCLUSTER_PREVIEW_TTL_HOURS flag).
    ttlHours: int | None = None


class VclusterPreviewClaimRequest(BaseModel):
    """Claim a pre-baked warm-pool member for a user (A3). `name` is the user's requested
    preview name (becomes the alias + the wfb-<name> tailnet host); `devMode` optionally wires
    the claim so the adopt:true dev image can replace the prod BFF; `user` is recorded on the
    claimed namespace for attribution. origin/prNumber/ttlHours mirror VclusterPreviewRequest
    (D1) — a PR preview claimed from the pool must carry the same lifecycle markers as a
    cold-provisioned one."""

    name: str = Field(min_length=1, max_length=40)
    devMode: bool | None = None
    user: str | None = None
    origin: str | None = None  # user | pr
    prNumber: int | None = None
    ttlHours: int | None = None


def _vcluster_preview_job_name(name: str, action: str) -> str:
    return _safe_resource_name(f"vcpreview-{action}-{name}", max_length=63)


def _vcluster_preview_tailnet_host(req: VclusterPreviewRequest) -> str:
    return req.tailnetHost or f"wfb-{req.name}"


def _vcluster_preview_job_manifest(
    req: VclusterPreviewRequest, *, namespace: str
) -> dict[str, Any]:
    job_name = _vcluster_preview_job_name(req.name, req.action)
    image = os.environ.get("VCLUSTER_PREVIEW_RUNNER_IMAGE", "alpine/k8s:1.31.0")
    env = [
        {"name": "NAME", "value": req.name},
        {"name": "ACTION", "value": req.action},
        {"name": "TS_HOST", "value": _vcluster_preview_tailnet_host(req)},
    ]
    if req.daprVersion:
        env.append({"name": "DAPR_VERSION", "value": req.daprVersion})
    if req.previewDb:
        env.append({"name": "PREVIEW_DB", "value": req.previewDb})
    # Agent-mode (GitOps deploy via argocd-agent): pass ENROLL_MODE + the git ref the
    # in-vcluster controller fetches the overlay/bootstrap from. Both env-defaulted.
    enroll_mode = req.enrollMode or os.environ.get(
        "VCLUSTER_PREVIEW_ENROLL_MODE", "imperative"
    )
    env.append({"name": "ENROLL_MODE", "value": enroll_mode})
    # Per-preview DB backend (cnpg = isolated CloudNativePG inside the vcluster).
    preview_db_mode = req.previewDbMode or os.environ.get(
        "VCLUSTER_PREVIEW_DB_MODE", "shared"
    )
    env.append({"name": "PREVIEW_DB_MODE", "value": preview_db_mode})
    # Preview observability mode (disabled = OTEL off, behavior-identical to today; async =
    # re-enable async OTLP export to the replicated host otel-collector). Env-defaulted for a
    # cluster-wide flip. The runner stages a preview-observability ConfigMap from this value.
    preview_observability = req.previewObservability or os.environ.get(
        "VCLUSTER_PREVIEW_OBSERVABILITY", "disabled"
    )
    env.append(
        {"name": "PREVIEW_OBSERVABILITY", "value": preview_observability}
    )
    # A2 cold-boot flags (default-off; env-defaulted for a cluster-wide flip). Parallel
    # bringup backgrounds the runner's independent infra installs; db-bootstrap=template
    # clones the pre-seeded host preview_template DB via CNPG import instead of migrate+seed.
    preview_parallel = req.previewParallelBringup
    if preview_parallel is None:
        preview_parallel = (
            os.environ.get("VCLUSTER_PREVIEW_PARALLEL_BRINGUP", "false") == "true"
        )
    env.append(
        {
            "name": "PREVIEW_PARALLEL_BRINGUP",
            "value": "true" if preview_parallel else "false",
        }
    )
    preview_db_bootstrap = req.previewDbBootstrap or os.environ.get(
        "VCLUSTER_PREVIEW_DB_BOOTSTRAP", "migrate"
    )
    env.append({"name": "PREVIEW_DB_BOOTSTRAP", "value": preview_db_bootstrap})
    # Interactive dev preview (adopt:true dev image replaces the prod BFF): thread
    # PREVIEW_DEV_MODE so the runner wires the prod LB to the adopted dev pod
    # (EXPOSE_DEV_POD=false). Defaults from env for a cluster-wide flip.
    preview_dev_mode = req.previewDevMode
    if preview_dev_mode is None:
        preview_dev_mode = (
            os.environ.get("VCLUSTER_PREVIEW_DEV_MODE", "false") == "true"
        )
    env.append(
        {"name": "PREVIEW_DEV_MODE", "value": "true" if preview_dev_mode else "false"}
    )
    # A3 warm pool: bake a generic free member (runner labels the ns free + skips cred-copy).
    if req.pool:
        env.append({"name": "POOL", "value": "true"})
    # D1 lifecycle metadata → the runner stamps these on the host preview ns at bringup
    # (SEA can't stamp a COLD provision itself — the ns doesn't exist yet at accept time;
    # the CLAIM path stamps them SEA-side inside the atomic label flip instead). The expiry
    # is computed HERE (Python) so the runner never does busybox date math.
    if req.origin in ("user", "pr"):
        env.append({"name": "ORIGIN", "value": req.origin})
    if req.prNumber is not None and req.prNumber > 0:
        env.append({"name": "PR_NUMBER", "value": str(req.prNumber)})
    if req.ttlHours is not None and req.ttlHours > 0:
        expires_at = (
            datetime.now(UTC) + timedelta(hours=req.ttlHours)
        ).isoformat(timespec="seconds")
        env.append({"name": "EXPIRES_AT", "value": expires_at})
    if enroll_mode == "agent":
        env.append(
            {
                "name": "TARGET_REVISION",
                "value": req.targetRevision
                or os.environ.get("VCLUSTER_PREVIEW_TARGET_REVISION", "main"),
            }
        )
        bff_image = os.environ.get("VCLUSTER_PREVIEW_BFF_IMAGE")
        if bff_image:
            env.append({"name": "BFF_IMAGE", "value": bff_image})
    return {
        "apiVersion": "batch/v1",
        "kind": "Job",
        "metadata": {
            "name": job_name,
            "namespace": namespace,
            "labels": {
                "app": "vcluster-preview",
                "vcluster-preview-name": _safe_resource_name(req.name),
                "vcluster-preview-action": req.action,
            },
        },
        "spec": {
            "backoffLimit": 0,
            "ttlSecondsAfterFinished": 1800,
            # Teardown must reclaim its slot promptly, so a wedged down-Job gets a much shorter
            # deadline than a provision (task #25 — a hung teardown was silently holding a
            # preview slot for the full 30 min). runner.sh ACTION=down now bounds each hang-prone
            # step with `timeout`; this deadline is the last-resort backstop. A4 sleep/resume
            # Jobs are quick edge operations (scale + pod delete / scale + rollout wait) and get
            # correspondingly tight deadlines.
            "activeDeadlineSeconds": {"down": 900, "sleep": 600, "resume": 900}.get(
                req.action, 1800
            ),
            "template": {
                "metadata": {"labels": {"app": "vcluster-preview"}},
                "spec": {
                    "restartPolicy": "Never",
                    "serviceAccountName": "vcluster-preview-provisioner",
                    # The custom runner image (with argocd-agentctl, for agent mode) is a
                    # PRIVATE ghcr package — stock alpine/k8s was public, so the Job had no
                    # pull secret. Harmless for the public default image.
                    "imagePullSecrets": [{"name": "ghcr-pull-credentials"}],
                    "containers": [
                        {
                            "name": "runner",
                            "image": image,
                            "command": ["bash", "/config/runner.sh"],
                            "env": env,
                            "volumeMounts": [
                                {"name": "runner", "mountPath": "/config"}
                            ],
                        }
                    ],
                    "volumes": [
                        {
                            "name": "runner",
                            "configMap": {"name": "vcluster-preview-runner"},
                        }
                    ],
                },
            },
        },
    }


def _create_preview_job(
    batch, *, namespace: str, manifest: dict[str, Any]
) -> None:
    """Idempotently (re)create a preview provisioning/claim/teardown Job: clear a prior
    same-name Job, wait for it to clear, then create. Shared by provision, claim, and the
    A3 pool manager so all three get the same 409-safe delete→settle→create behavior."""
    job_name = manifest["metadata"]["name"]
    try:
        batch.delete_namespaced_job(
            name=job_name, namespace=namespace, propagation_policy="Background"
        )
    except Exception as exc:
        if getattr(exc, "status", None) not in (404, None):
            logger.info("preview job prior delete: %s", exc)
    # Brief settle so the recreate doesn't 409 on a terminating job.
    for _ in range(20):
        try:
            batch.read_namespaced_job(name=job_name, namespace=namespace)
            time.sleep(0.5)
        except Exception as exc:
            if getattr(exc, "status", None) == 404:
                break
    try:
        batch.create_namespaced_job(namespace=namespace, body=manifest)
    except Exception as exc:
        if getattr(exc, "status", None) != 409:
            raise


@app.post("/internal/vcluster-preview", status_code=status.HTTP_202_ACCEPTED)
def provision_vcluster_preview(
    request: Request, body: VclusterPreviewRequest
) -> dict[str, Any]:
    _require_internal(request)
    set_current_span_io("input", body.model_dump())
    if body.action not in {"up", "down"}:
        raise HTTPException(status_code=400, detail="action must be up|down")
    namespace = _agent_workflow_host_namespace()
    manifest = _vcluster_preview_job_manifest(body, namespace=namespace)
    job_name = manifest["metadata"]["name"]
    tailnet_host = _vcluster_preview_tailnet_host(body)
    url = f"https://{tailnet_host}.{_VCLUSTER_PREVIEW_TAILNET_SUFFIX}"
    if os.environ.get("SANDBOX_EXECUTION_DRY_RUN", "").lower() not in {
        "1",
        "true",
        "yes",
    }:
        batch, _ = _load_k8s_clients()
        _create_preview_job(batch, namespace=namespace, manifest=manifest)
    response = {
        "name": body.name,
        "action": body.action,
        "job": job_name,
        "status": "provisioning" if body.action == "up" else "terminating",
        "tailnetHost": tailnet_host,
        "url": url if body.action == "up" else None,
    }
    set_current_span_io("output", response)
    return response


def _vcluster_preview_phase(
    batch, core, name: str, request_timeout: float | None = None
) -> tuple[str, int, int, int]:
    """Phase keyed on the DURABLE vcluster (its host namespace), so a ready preview
    survives the provisioning Job's TTL GC. Readiness is the ACTUAL stack: a synced
    `workflow-builder-*` (BFF) pod reporting Ready in the `vcluster-<name>` host ns —
    NOT mere namespace existence (an empty/half-up ns is not ready).

    `request_timeout` (seconds) bounds each K8s call so one slow/hung preview can't
    stall the caller (the list endpoint probes previews concurrently and treats a
    timed-out probe as not-ready rather than sinking the whole list)."""
    namespace = _agent_workflow_host_namespace()
    job_name = _vcluster_preview_job_name(name, "up")
    active = succeeded = failed = 0
    try:
        st = batch.read_namespaced_job_status(
            name=job_name, namespace=namespace, _request_timeout=request_timeout
        ).status
        active = int(getattr(st, "active", 0) or 0)
        succeeded = int(getattr(st, "succeeded", 0) or 0)
        failed = int(getattr(st, "failed", 0) or 0)
    except Exception as exc:
        if getattr(exc, "status", None) != 404:
            raise
    ns_exists = False
    bff_ready = False
    try:
        pods = core.list_namespaced_pod(
            namespace=f"vcluster-{name}", _request_timeout=request_timeout
        )
        ns_exists = True
        for p in pods.items:
            if not (p.metadata.name or "").startswith("workflow-builder-"):
                continue
            conds = (p.status.conditions or []) if p.status else []
            if any(
                getattr(c, "type", "") == "Ready" and getattr(c, "status", "") == "True"
                for c in conds
            ):
                bff_ready = True
                break
    except Exception as exc:
        if getattr(exc, "status", None) != 404:
            raise
    if bff_ready:
        phase = "ready"  # BFF is up — stays ready even after the Job is GC'd
    elif active:
        phase = "provisioning"
    elif failed:
        phase = "failed"
    elif ns_exists:
        phase = "provisioning"  # ns up but BFF not Ready yet (or stuck)
    else:
        phase = "absent"
    return phase, active, succeeded, failed


def _vcluster_preview_boot_seconds(core, name: str) -> int | None:
    """Boot duration (seconds) the provisioning runner stamped on the host preview
    namespace as the `vcluster-preview-boot-seconds` annotation (A0 instrumentation),
    or None if not yet recorded / the ns is absent. Additive telemetry — never raises
    for a missing ns."""
    try:
        ns = core.read_namespace(name=f"vcluster-{name}")
    except Exception as exc:
        if getattr(exc, "status", None) != 404:
            raise
        return None
    annotations = (ns.metadata.annotations or {}) if ns.metadata else {}
    raw = annotations.get("vcluster-preview-boot-seconds")
    if raw is None:
        return None
    try:
        return int(float(str(raw).strip()))
    except (TypeError, ValueError):
        return None


def _resolve_preview_realname(core, name: str) -> str:
    """Map a user-facing preview name to its ns-backing member id: a claimed pool member's ALIAS
    resolves to its pool-<n> (whose ns is vcluster-pool-<n>); a normal preview resolves to
    itself. Best-effort — a lookup failure falls back to the name as-is."""
    try:
        nss = core.list_namespace(
            label_selector=f"{_VCLUSTER_PREVIEW_ALIAS_LABEL}={_safe_resource_name(name, max_length=40)}"
        )
    except Exception as exc:
        logger.warning("resolve preview alias %s failed: %s", name, exc)
        return name
    for ns in nss.items:
        if _preview_ns_is_terminating(ns):
            continue
        return _preview_realname_from_ns(ns)
    return name


@app.get("/internal/vcluster-preview/{name}")
def get_vcluster_preview(request: Request, name: str) -> dict[str, Any]:
    _require_internal(request)
    # `name` may be a user's alias for a claimed pool member — probe its backing member id but
    # report the user's requested name + its wfb-<name> host.
    tailnet_host = f"wfb-{name}"
    url = f"https://{tailnet_host}.{_VCLUSTER_PREVIEW_TAILNET_SUFFIX}"
    phase = "unknown"
    active = succeeded = failed = 0
    boot_seconds: int | None = None
    real_name = name
    lifecycle: dict[str, Any] = {}
    if os.environ.get("SANDBOX_EXECUTION_DRY_RUN", "").lower() not in {
        "1",
        "true",
        "yes",
    }:
        batch, core = _load_k8s_clients()
        real_name = _resolve_preview_realname(core, name)
        member: PreviewMember | None = None
        try:
            member = _preview_member_from_ns(
                core.read_namespace(name=f"vcluster-{real_name}")
            )
        except Exception as exc:
            if getattr(exc, "status", None) != 404:
                raise
        if member is not None and member.slept:
            # A slept preview's pods are DELIBERATELY gone — probing would misreport
            # "provisioning"; surface the slept state instead (A4 contract).
            phase = "slept"
        else:
            phase, active, succeeded, failed = _vcluster_preview_phase(
                batch, core, real_name
            )
        boot_seconds = _vcluster_preview_boot_seconds(core, real_name)
        if member is not None:
            lifecycle = _preview_lifecycle_fields(member)
    result = {
        "name": name,
        "job": _vcluster_preview_job_name(real_name, "up"),
        "phase": phase,
        "ready": phase == "ready",
        "active": active,
        "succeeded": succeeded,
        "failed": failed,
        "tailnetHost": tailnet_host,
        "url": url,
        "bootSeconds": boot_seconds,
        **lifecycle,
    }
    if real_name != name:
        result["pool"] = real_name
    return result


def _read_preview_member(core, name: str) -> PreviewMember:
    """Resolve a user-facing name (alias or real) to its PreviewMember, 404-ing on
    anything that is not a live preview vcluster namespace. The app=vcluster-preview
    label check is the HARD safety rule: lifecycle endpoints can never act on an
    arbitrary namespace."""
    real_name = _resolve_preview_realname(core, name)
    try:
        ns = core.read_namespace(name=f"vcluster-{real_name}")
    except Exception as exc:
        if getattr(exc, "status", None) == 404:
            raise HTTPException(status_code=404, detail="preview not found") from exc
        raise
    labels = (ns.metadata.labels or {}) if ns.metadata else {}
    if labels.get("app") != "vcluster-preview":
        raise HTTPException(status_code=404, detail="not a preview vcluster")
    member = _preview_member_from_ns(ns)
    if member.terminating:
        raise HTTPException(status_code=409, detail="preview is terminating")
    return member


@app.post("/internal/vcluster-preview/{name}/touch")
def touch_vcluster_preview(request: Request, name: str) -> dict[str, Any]:
    """A4 activity ping: stamp vcluster-preview-last-active=now on the preview's host ns.
    The BFF calls this from the points where a preview is actively USED (launch, dev-preview
    provision) — reads/list/status never touch. Touching a SLEPT preview wakes it (resume-Job);
    the caller should poll GET /internal/vcluster-preview/{name} until ready."""
    _require_internal(request)
    if os.environ.get("SANDBOX_EXECUTION_DRY_RUN", "").lower() in {"1", "true", "yes"}:
        return {"name": name, "state": "hot", "lastActive": None, "resuming": False}
    batch, core = _load_k8s_clients()
    member = _read_preview_member(core, name)
    now_iso = datetime.now(UTC).isoformat(timespec="seconds")
    resuming = False
    if member.slept:
        resuming = _resume_member(batch, core, member, _agent_workflow_host_namespace())
    else:
        try:
            core.patch_namespace(
                name=member.ns_name,
                body={
                    "metadata": {
                        "annotations": {
                            _VCLUSTER_PREVIEW_LAST_ACTIVE_ANNOTATION: now_iso
                        }
                    }
                },
            )
        except Exception as exc:
            logger.warning("touch: last-active stamp %s failed: %s", member.real_name, exc)
            raise HTTPException(status_code=500, detail="touch failed") from exc
    _invalidate_previews_cache()
    result = {
        "name": name,
        "state": "resuming" if resuming else "hot",
        "lastActive": now_iso,
        "resuming": resuming,
    }
    if member.real_name != name:
        result["pool"] = member.real_name
    return result


@app.post("/internal/vcluster-preview/{name}/sleep")
def sleep_vcluster_preview(request: Request, name: str) -> dict[str, Any]:
    """A4 explicit sleep (the reaper's mechanism, callable directly — e.g. the lead's live
    validation, or a BFF 'sleep now' affordance). Free/recycling pool members and protected
    previews refuse with 409."""
    _require_internal(request)
    if os.environ.get("SANDBOX_EXECUTION_DRY_RUN", "").lower() in {"1", "true", "yes"}:
        return {"name": name, "state": "slept", "job": None}
    batch, core = _load_k8s_clients()
    member = _read_preview_member(core, name)
    if member.protected:
        raise HTTPException(status_code=409, detail="preview is protected")
    if member.pool_state in ("free", "recycling"):
        raise HTTPException(
            status_code=409, detail="free pool members stay claim-ready (never slept)"
        )
    if member.slept:
        return {"name": name, "state": "slept", "job": None, "alreadySlept": True}
    if not _sleep_member(batch, core, member, _agent_workflow_host_namespace()):
        raise HTTPException(status_code=500, detail="sleep failed")
    _invalidate_previews_cache()
    result = {
        "name": name,
        "state": "slept",
        "job": _vcluster_preview_job_name(member.real_name, "sleep"),
    }
    if member.real_name != name:
        result["pool"] = member.real_name
    return result


class VclusterPreviewReapRequest(BaseModel):
    """Optional body for the reap endpoint. needRoom asks the pass to ALSO evict this many
    members (beyond TTL/TOTAL_MAX work) via the locked eviction order — the D1 PR-preview
    consumer uses it to make room before provisioning when capacity is full."""

    needRoom: int | None = None


@app.post("/internal/vcluster-preview/reap")
def reap_vcluster_previews(
    request: Request, body: VclusterPreviewReapRequest | None = None
) -> dict[str, Any]:
    """Run ONE A4 reaper pass synchronously (TTL teardown → capacity eviction → sleep) and
    return its stats. The suspended preview-lifecycle-reap CronJob curls this every 30 min
    as the belt-and-suspenders backstop against SEA thread death; it is also the manual
    lever for live validation. Inert while all lifecycle flags are 0 (only explicit
    per-preview expires-at markers are acted on)."""
    _require_internal(request)
    if os.environ.get("SANDBOX_EXECUTION_DRY_RUN", "").lower() in {"1", "true", "yes"}:
        return {
            "total": 0,
            "awake": 0,
            "slept": 0,
            "reapedExpired": 0,
            "evicted": 0,
            "sleptNow": 0,
        }
    batch, core = _load_k8s_clients()
    need_room = body.needRoom if body and body.needRoom and body.needRoom > 0 else 0
    stats = _lifecycle_reap_once(batch, core, need_room=need_room)
    set_current_span_io("output", stats)
    return stats


@app.delete("/internal/vcluster-preview/{name}")
def teardown_vcluster_preview(request: Request, name: str) -> dict[str, Any]:
    _require_internal(request)
    # Teardown == an ACTION=down Job (drops the per-preview DB + vcluster delete). Resolve an
    # alias to its backing pool member so tearing down a claimed preview reaps pool-<n>.
    real_name = name
    if os.environ.get("SANDBOX_EXECUTION_DRY_RUN", "").lower() not in {
        "1",
        "true",
        "yes",
    }:
        _, core = _load_k8s_clients()
        real_name = _resolve_preview_realname(core, name)
    body = VclusterPreviewRequest(name=real_name, action="down")
    return provision_vcluster_preview(request, body)


# Short burst cache for the preview list. The E1 Dev-hub feed re-scans every 20s
# AND the dashboard UI polls, so concurrent/rapid callers used to each trigger a
# full cluster scan; combined with the serial per-preview probe below that made the
# list degrade badly under back-to-back calls (14s -> 60s timeout). The cache
# collapses bursts into one scan; the periodic re-scan still refreshes (TTL << 20s).
_VCLUSTER_PREVIEWS_CACHE_TTL = float(
    os.environ.get("VCLUSTER_PREVIEWS_CACHE_TTL_SECONDS", "8") or 8
)
_vcluster_previews_cache: dict[str, Any] = {"at": 0.0, "data": None}
_vcluster_previews_cache_lock = threading.Lock()


def _invalidate_previews_cache() -> None:
    """Drop the burst cache so a claim (or pool change) is reflected on the next list rather
    than after the ≤8s TTL — the claimed member's alias/host must appear promptly."""
    with _vcluster_previews_cache_lock:
        _vcluster_previews_cache["at"] = 0.0
        _vcluster_previews_cache["data"] = None
# Per-preview K8s-call timeout (seconds) so one slow/hung preview can't stall the list.
_VCLUSTER_PREVIEW_PROBE_TIMEOUT = float(
    os.environ.get("VCLUSTER_PREVIEW_PROBE_TIMEOUT_SECONDS", "10") or 10
)

# ---- A3 warm-pool label/annotation contract (shared by list + claim + pool manager) ----
# The runner stamps these on the DURABLE host preview namespace (vcluster-<name>):
_VCLUSTER_PREVIEW_NAME_LABEL = "vcluster-preview-name"  # the ns-backing member id
# vcluster-preview-pool: free (baked, claimable) | claimed (personalized) | recycling
# (being torn down by the recycler; excluded from claims). Absent = a normal (non-pool) preview.
_VCLUSTER_PREVIEW_POOL_LABEL = "vcluster-preview-pool"
_VCLUSTER_PREVIEW_ALIAS_LABEL = "vcluster-preview-alias"  # a claimed member's user-facing name
_VCLUSTER_PREVIEW_CLAIMED_BY_ANNOTATION = "vcluster-preview-claimed-by"
_VCLUSTER_PREVIEW_CLAIMED_AT_ANNOTATION = "vcluster-preview-claimed-at"
# Baked image-pin signature (bff=…;orch=…;fr=…;sea=…) the recycler diffs vs the live host images.
_VCLUSTER_PREVIEW_IMAGE_PINS_ANNOTATION = "vcluster-preview-image-pins"

# ---- A4/D1 lifecycle contract (labels + annotations on the host preview ns) ----
# vcluster-preview-state: absent/hot = running; slept = control plane + workloads scaled
# down by an A4 sleep-Job (PVCs + tailnet hostname persist; a resume-Job wakes it).
_VCLUSTER_PREVIEW_STATE_LABEL = "vcluster-preview-state"
# vcluster-preview-origin: user | pr (absent = legacy/human preview predating D1). PR-origin
# previews are evictable; human ones never are.
_VCLUSTER_PREVIEW_ORIGIN_LABEL = "vcluster-preview-origin"
_VCLUSTER_PREVIEW_PR_LABEL = "vcluster-preview-pr"  # the GitHub PR number (origin=pr)
# vcluster-preview-protected=true: a hard operator exemption — the reaper/eviction/sleep
# logic NEVER touches a protected preview (the lead's tool for the standing gan-* previews).
_VCLUSTER_PREVIEW_PROTECTED_LABEL = "vcluster-preview-protected"
# vcluster-preview-last-active: RFC3339 — stamped by the touch endpoint + at provision/claim.
# ABSENT = the preview is not activity-tracked and the sleep reaper never considers it.
_VCLUSTER_PREVIEW_LAST_ACTIVE_ANNOTATION = "vcluster-preview-last-active"
# vcluster-preview-expires-at: RFC3339 — explicit per-preview expiry (from ttlHours); any
# reap pass tears the preview down once past it, independent of the global TTL flag.
_VCLUSTER_PREVIEW_EXPIRES_AT_ANNOTATION = "vcluster-preview-expires-at"
_VCLUSTER_PREVIEW_SLEPT_AT_ANNOTATION = "vcluster-preview-slept-at"


def _preview_realname_from_ns(ns) -> str:
    """The ns-backing member id: the vcluster-preview-name label, else the ns name with the
    `vcluster-` prefix stripped."""
    labels = (ns.metadata.labels or {}) if ns.metadata else {}
    name = labels.get(_VCLUSTER_PREVIEW_NAME_LABEL)
    if name:
        return name
    nsname = (ns.metadata.name or "") if ns.metadata else ""
    return nsname[len("vcluster-") :] if nsname.startswith("vcluster-") else nsname


def _preview_ns_is_terminating(ns) -> bool:
    return bool(ns.status and getattr(ns.status, "phase", "") == "Terminating")


def _parse_rfc3339(raw: Any) -> datetime | None:
    """Lenient RFC3339 parse (the annotations are stamped by us, but a hand-edited or
    truncated value must never crash a reap pass — unparseable = absent)."""
    if not raw:
        return None
    try:
        dt = datetime.fromisoformat(str(raw).strip().replace("Z", "+00:00"))
    except (TypeError, ValueError):
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=UTC)
    return dt


@dataclass
class PreviewMember:
    """One preview vcluster's lifecycle-relevant state, parsed off its host namespace.
    A plain value object so the A4 selection logic (`_select_preview_evictions`,
    `_member_is_expired`, …) stays PURE and exhaustively unit-testable."""

    real_name: str
    ns_name: str
    pool_state: str | None = None  # free | claimed | recycling | None (non-pool)
    alias: str | None = None
    slept: bool = False
    origin: str | None = None  # user | pr | None (legacy/human)
    pr_number: int | None = None
    protected: bool = False
    terminating: bool = False
    created_at: datetime | None = None
    last_active: datetime | None = None
    expires_at: datetime | None = None  # the EXPLICIT annotation only


def _preview_member_from_ns(ns) -> PreviewMember:
    meta = getattr(ns, "metadata", None)
    labels = getattr(meta, "labels", None) or {}
    annotations = getattr(meta, "annotations", None) or {}
    pr_raw = labels.get(_VCLUSTER_PREVIEW_PR_LABEL)
    try:
        pr_number = int(pr_raw) if pr_raw is not None else None
    except (TypeError, ValueError):
        pr_number = None
    created = getattr(meta, "creation_timestamp", None)
    if created is not None and created.tzinfo is None:
        created = created.replace(tzinfo=UTC)
    return PreviewMember(
        real_name=_preview_realname_from_ns(ns),
        ns_name=getattr(meta, "name", None) or "",
        pool_state=labels.get(_VCLUSTER_PREVIEW_POOL_LABEL),
        alias=labels.get(_VCLUSTER_PREVIEW_ALIAS_LABEL),
        slept=labels.get(_VCLUSTER_PREVIEW_STATE_LABEL) == "slept",
        origin=labels.get(_VCLUSTER_PREVIEW_ORIGIN_LABEL),
        pr_number=pr_number,
        protected=labels.get(_VCLUSTER_PREVIEW_PROTECTED_LABEL) == "true",
        terminating=_preview_ns_is_terminating(ns),
        created_at=created,
        last_active=_parse_rfc3339(
            annotations.get(_VCLUSTER_PREVIEW_LAST_ACTIVE_ANNOTATION)
        ),
        expires_at=_parse_rfc3339(
            annotations.get(_VCLUSTER_PREVIEW_EXPIRES_AT_ANNOTATION)
        ),
    )


def _member_effective_expiry(
    member: PreviewMember, *, ttl_hours: int
) -> datetime | None:
    """The moment this member expires: the SOONER of its explicit expires-at annotation
    (honored whenever present — it is a per-preview opt-in marker) and creation+TTL when
    the global VCLUSTER_PREVIEW_TTL_HOURS flag is on. None = never expires."""
    candidates: list[datetime] = []
    if member.expires_at:
        candidates.append(member.expires_at)
    if ttl_hours > 0 and member.created_at:
        candidates.append(member.created_at + timedelta(hours=ttl_hours))
    return min(candidates) if candidates else None


def _member_is_expired(
    member: PreviewMember, *, now: datetime, ttl_hours: int
) -> bool:
    expiry = _member_effective_expiry(member, ttl_hours=ttl_hours)
    return bool(expiry and now >= expiry)


def _member_recently_active(
    member: PreviewMember, *, now: datetime, active_minutes: int
) -> bool:
    return bool(
        member.last_active
        and (now - member.last_active) < timedelta(minutes=active_minutes)
    )


def _select_preview_evictions(
    members: list[PreviewMember],
    *,
    need: int,
    pool_size: int,
    now: datetime,
    ttl_hours: int,
    active_minutes: int,
) -> list[PreviewMember]:
    """A4 eviction selector — PURE (no k8s, no env, no clock reads; everything injected).

    Returns up to `need` members to tear down, most-evictable first, in the locked order:
      1. free-slept        — slept free pool members (only exist after a manual force-sleep;
                             the reaper never sleeps free members), oldest first
      2. free-hot surplus  — free hot pool members BEYOND the pool_size target (the pool
                             keeps its claim-ready quota), oldest first
      3. TTL-expired       — expired non-free members (explicit expires-at, or creation+TTL
                             when the global flag is on), soonest-expired first
      4. PR-origin         — non-expired origin=pr previews, oldest-created first

    NEVER returned, in any bucket: protected members, terminating members, members already
    recycling, RECENTLY-ACTIVE members (touched within active_minutes), and human previews
    (origin absent or "user") that are not expired."""
    if need <= 0:
        return []
    eligible = [
        m
        for m in members
        if not m.terminating
        and not m.protected
        and m.pool_state != "recycling"
        and not _member_recently_active(m, now=now, active_minutes=active_minutes)
    ]
    created_key = lambda m: m.created_at or now  # noqa: E731 - local sort key

    free_slept = sorted(
        (m for m in eligible if m.pool_state == "free" and m.slept), key=created_key
    )
    free_hot = sorted(
        (m for m in eligible if m.pool_state == "free" and not m.slept),
        key=created_key,
    )
    # Keep pool_size free-hot members claim-ready; only the oldest surplus is evictable.
    free_hot_surplus = free_hot[: max(0, len(free_hot) - pool_size)]

    non_free = [m for m in eligible if m.pool_state != "free"]
    expired = sorted(
        (m for m in non_free if _member_is_expired(m, now=now, ttl_hours=ttl_hours)),
        key=lambda m: _member_effective_expiry(m, ttl_hours=ttl_hours) or now,
    )
    expired_names = {m.real_name for m in expired}
    pr_origin = sorted(
        (
            m
            for m in non_free
            if m.origin == "pr" and m.real_name not in expired_names
        ),
        key=created_key,
    )
    ordered = free_slept + free_hot_surplus + expired + pr_origin
    return ordered[:need]


def _preview_lifecycle_fields(member: PreviewMember) -> dict[str, Any]:
    """The A4/D1 lifecycle fields surfaced on the list + get endpoints (contract with the
    BFF PR-preview consumer): origin, prNumber, expiresAt, state (hot|slept), lastActive."""
    return {
        "state": "slept" if member.slept else "hot",
        "origin": member.origin,
        "prNumber": member.pr_number,
        "expiresAt": member.expires_at.isoformat(timespec="seconds")
        if member.expires_at
        else None,
        "lastActive": member.last_active.isoformat(timespec="seconds")
        if member.last_active
        else None,
    }


def _compute_vcluster_previews() -> dict[str, Any]:
    items: list[dict[str, Any]] = []
    counts = {"awake": 0, "slept": 0, "total": 0, "free": 0, "claimed": 0, "recycling": 0}
    counts["max"] = _vcluster_preview_max()
    counts["totalMax"] = _vcluster_preview_total_max()
    counts["poolSize"] = _vcluster_preview_pool_size()
    if os.environ.get("SANDBOX_EXECUTION_DRY_RUN", "").lower() in {
        "1",
        "true",
        "yes",
    }:
        return {"previews": items, "counts": counts}

    batch, core = _load_k8s_clients()
    # Durable: enumerate the preview VCLUSTER NAMESPACES (labeled by the runner),
    # not the TTL-GC'd provisioning Jobs.
    nss = core.list_namespace(label_selector="app=vcluster-preview")
    # A claimed pool member is shown under the user's ALIAS but PROBED under its real member id
    # (its ns is vcluster-<real>); a FREE/recycling member is a pool slot, hidden from the user
    # list but counted for capacity. A4: `awake` counts only HOT members — a slept preview
    # (control plane scaled down) holds no capacity, so it doesn't gate cold provisions;
    # `total` (and totalMax) count everything.
    visible: list[tuple[PreviewMember, str, str]] = []  # (member, display_name, host)
    for ns in nss.items:
        if _preview_ns_is_terminating(ns):
            continue
        member = _preview_member_from_ns(ns)
        counts["total"] += 1
        if member.slept:
            counts["slept"] += 1
        else:
            counts["awake"] += 1
        if member.pool_state in counts:
            counts[member.pool_state] += 1
        if member.pool_state in ("free", "recycling"):
            continue  # a pool slot, not a user-facing preview
        display_name = (
            member.alias
            if (member.pool_state == "claimed" and member.alias)
            else member.real_name
        )
        host = f"wfb-{display_name}"
        visible.append((member, display_name, host))

    # Each _vcluster_preview_phase does 2 serial K8s reads (job status + pod list); probe them
    # concurrently keyed on the real member id — the k8s client pool is thread-safe for reads.
    # A slept member is not probed at all: its pods are DELIBERATELY gone, so the probe would
    # just read "provisioning" (misleading) at the cost of 2 API calls — report phase "slept".
    def _probe(entry: tuple[PreviewMember, str, str]) -> tuple[PreviewMember, str, str, str]:
        member, display_name, host = entry
        if member.slept:
            return member, display_name, host, "slept"
        try:
            phase, _a, _s, _f = _vcluster_preview_phase(
                batch,
                core,
                member.real_name,
                request_timeout=_VCLUSTER_PREVIEW_PROBE_TIMEOUT,
            )
            return member, display_name, host, phase
        except Exception as exc:
            logger.warning(
                "vcluster-previews: phase probe for %s failed: %s", member.real_name, exc
            )
            return member, display_name, host, "absent"

    probed: list[tuple[PreviewMember, str, str, str]] = []
    if visible:
        with ThreadPoolExecutor(max_workers=min(8, len(visible))) as pool:
            probed = list(pool.map(_probe, visible))

    for member, display_name, host, phase in probed:
        if phase == "absent":
            continue
        item = {
            "name": display_name,
            "phase": phase,
            "ready": phase == "ready",
            "tailnetHost": host,
            "url": f"https://{host}.{_VCLUSTER_PREVIEW_TAILNET_SUFFIX}",
            **_preview_lifecycle_fields(member),
        }
        if member.real_name != display_name:
            item["pool"] = member.real_name  # the backing member id for claimed previews
        items.append(item)
    return {"previews": items, "counts": counts}


@app.get("/internal/vcluster-previews")
def list_vcluster_previews(request: Request) -> dict[str, Any]:
    _require_internal(request)
    now = time.monotonic()
    with _vcluster_previews_cache_lock:
        cached = _vcluster_previews_cache
        if (
            _VCLUSTER_PREVIEWS_CACHE_TTL > 0
            and cached["data"] is not None
            and (now - cached["at"]) < _VCLUSTER_PREVIEWS_CACHE_TTL
        ):
            return cached["data"]

    result = _compute_vcluster_previews()

    with _vcluster_previews_cache_lock:
        _vcluster_previews_cache["at"] = time.monotonic()
        _vcluster_previews_cache["data"] = result
    return result


# ===========================================================================
# A3 warm vcluster pool: bake generic free members, claim one atomically for a
# user (<90s — skips the whole cold path), and keep the pool full + fresh via a
# background reconcile. Everything gates on VCLUSTER_PREVIEW_POOL_SIZE (default 0
# = OFF); at 0 none of this runs and previews cold-provision exactly as before.
# ===========================================================================

# Read→compare-and-swap retry budget for a claim (a 409 = a concurrent claim won that member).
_VCLUSTER_PREVIEW_CLAIM_ATTEMPTS = int(
    os.environ.get("VCLUSTER_PREVIEW_CLAIM_ATTEMPTS", "6") or 6
)


def _claim_bump_stale_enabled() -> bool:
    """Re-author a claimed member's Application with current host images if it drifted. OFF by
    default: it triggers a rollout (slow), and the recycler already keeps free members fresh."""
    return os.environ.get("VCLUSTER_PREVIEW_CLAIM_BUMP_STALE", "false").lower() == "true"


def _pool_recycle_deadline_seconds() -> int:
    try:
        return int(os.environ.get("VCLUSTER_PREVIEW_POOL_RECYCLE_DEADLINE", "900") or 900)
    except (TypeError, ValueError):
        return 900


def _deploy_container_image(apps, namespace: str, name: str) -> str:
    """The image of the like-named container in Deployment `name` (mirrors the runner's
    jsonpath `containers[?(@.name=="name")].image`); "" if unreadable."""
    try:
        dep = apps.read_namespaced_deployment(name=name, namespace=namespace)
    except Exception:
        return ""
    spec = dep.spec.template.spec if dep.spec and dep.spec.template else None
    if not spec or not spec.containers:
        return ""
    main = next((c for c in spec.containers if c.name == name), spec.containers[0])
    return main.image or ""


def _host_image_pins(apps) -> str | None:
    """The live host image-pin signature (bff=…;orch=…;fr=…;sea=…) — the CONTRACT string the
    runner stamps on each baked member (preview_image_pins). None if any of the 4 can't be read,
    so the recycler never false-recycles on a transient API error."""
    ns = _agent_workflow_host_namespace()
    bff = _deploy_container_image(apps, ns, "workflow-builder")
    orch = _deploy_container_image(apps, ns, "workflow-orchestrator")
    fr = _deploy_container_image(apps, ns, "function-router")
    sea = _deploy_container_image(apps, ns, "sandbox-execution-api")
    if not (bff and orch and fr and sea):
        return None
    return f"bff={bff};orch={orch};fr={fr};sea={sea}"


def _member_image_pins(core, real_name: str) -> str | None:
    try:
        ns = core.read_namespace(name=f"vcluster-{real_name}")
    except Exception:
        return None
    ann = (ns.metadata.annotations or {}) if ns.metadata else {}
    return ann.get(_VCLUSTER_PREVIEW_IMAGE_PINS_ANNOTATION)


def _member_is_stale(core, apps, real_name: str) -> bool:
    host = _host_image_pins(apps)
    member = _member_image_pins(core, real_name)
    return bool(host and member and host != member)


def _claim_free_member(
    core,
    *,
    alias: str,
    claim_user: str,
    origin: str | None = None,
    pr_number: int | None = None,
    ttl_hours: int | None = None,
) -> str | None:
    """Atomically hand a FREE warm-pool member to a claim. Returns the member's real id
    (pool-<n>) or None if none free. Idempotent: an alias already claimed reuses that member.
    The flip free→claimed is a resourceVersion-guarded replace, so two concurrent claims for
    different members can't both win the SAME member (the loser 409s and takes the next one).
    A4/D1: the SAME atomic replace stamps the lifecycle contract (origin/pr labels,
    last-active + expires-at annotations) — no separate patch to race with."""
    # Idempotent re-claim: this alias is already claimed (or provisioning) → reuse it.
    try:
        existing = core.list_namespace(
            label_selector=f"{_VCLUSTER_PREVIEW_ALIAS_LABEL}={alias}"
        )
        for ns in existing.items:
            if not _preview_ns_is_terminating(ns):
                return _preview_realname_from_ns(ns)
    except Exception as exc:
        logger.warning("claim: alias lookup for %s failed: %s", alias, exc)

    # A COLD (non-pool) preview already literally named `alias` occupies vcluster-<alias> — do NOT
    # claim a fresh member aliased to it (that would double-allocate). Return None so the BFF
    # re-provisions that existing preview via the cold path instead.
    try:
        cold = core.read_namespace(name=f"vcluster-{alias}")
        if not _preview_ns_is_terminating(cold):
            return None
    except Exception as exc:
        if getattr(exc, "status", None) != 404:
            logger.warning("claim: cold-name check for %s failed: %s", alias, exc)

    claimed_at = datetime.now(UTC).isoformat()
    for _ in range(_VCLUSTER_PREVIEW_CLAIM_ATTEMPTS):
        try:
            free = core.list_namespace(
                label_selector=f"{_VCLUSTER_PREVIEW_POOL_LABEL}=free"
            )
        except Exception as exc:
            logger.warning("claim: free-member list failed: %s", exc)
            return None
        candidates = [
            ns
            for ns in free.items
            if not _preview_ns_is_terminating(ns)
            # A SLEPT free member is not claimable (its control plane is down; the claim
            # Job's connect would fail). The reaper never sleeps free members, so this
            # only guards against a manual force-sleep.
            and ((ns.metadata.labels or {}) if ns.metadata else {}).get(
                _VCLUSTER_PREVIEW_STATE_LABEL
            )
            != "slept"
        ]
        if not candidates:
            return None
        # Oldest first — drain aging members before freshly-baked ones.
        candidates.sort(
            key=lambda ns: (ns.metadata.creation_timestamp or datetime.now(UTC))
        )
        for ns in candidates:
            real_name = _preview_realname_from_ns(ns)
            meta = ns.metadata
            labels = dict(meta.labels or {})
            labels[_VCLUSTER_PREVIEW_POOL_LABEL] = "claimed"
            labels[_VCLUSTER_PREVIEW_ALIAS_LABEL] = alias
            if origin in ("user", "pr"):
                labels[_VCLUSTER_PREVIEW_ORIGIN_LABEL] = origin
            if pr_number is not None and pr_number > 0:
                labels[_VCLUSTER_PREVIEW_PR_LABEL] = str(pr_number)
            meta.labels = labels
            annotations = dict(meta.annotations or {})
            annotations[_VCLUSTER_PREVIEW_CLAIMED_BY_ANNOTATION] = claim_user
            annotations[_VCLUSTER_PREVIEW_CLAIMED_AT_ANNOTATION] = claimed_at
            annotations[_VCLUSTER_PREVIEW_LAST_ACTIVE_ANNOTATION] = claimed_at
            if ttl_hours is not None and ttl_hours > 0:
                annotations[_VCLUSTER_PREVIEW_EXPIRES_AT_ANNOTATION] = (
                    datetime.now(UTC) + timedelta(hours=ttl_hours)
                ).isoformat(timespec="seconds")
            meta.annotations = annotations
            try:
                # meta.resource_version guards the CAS: if a concurrent claim already flipped
                # this member the replace 409s → try the next candidate.
                core.replace_namespace(name=meta.name, body=ns)
                logger.info(
                    "claim: member %s → alias=%s by %s", real_name, alias, claim_user
                )
                return real_name
            except Exception as exc:
                if getattr(exc, "status", None) == 409:
                    continue  # lost the race for this member; try another
                logger.warning("claim: replace %s failed: %s", meta.name, exc)
                continue
    return None


def _vcluster_claim_job_manifest(
    pool_name: str,
    alias: str,
    claim_user: str,
    *,
    dev_mode: bool | None,
    bump_images: bool,
    namespace: str,
) -> dict[str, Any]:
    """The ACTION=claim Job manifest. Reuses the up-Job's env defaulting (ENROLL_MODE/
    PREVIEW_DB_MODE/TARGET_REVISION/PREVIEW_DEV_MODE/…) so the runner resolves the member's DB +
    (optionally) re-authors it, then appends the claim-specific env."""
    req = VclusterPreviewRequest(name=pool_name, action="claim", previewDevMode=dev_mode)
    manifest = _vcluster_preview_job_manifest(req, namespace=namespace)
    env = manifest["spec"]["template"]["spec"]["containers"][0]["env"]
    env.extend(
        [
            {"name": "POOL_NAME", "value": pool_name},
            {"name": "ALIAS", "value": alias},
            {"name": "CLAIM_USER", "value": claim_user},
            {"name": "CLAIM_BUMP_IMAGES", "value": "true" if bump_images else "false"},
        ]
    )
    return manifest


@app.post("/internal/vcluster-preview/claim", status_code=status.HTTP_202_ACCEPTED)
def claim_vcluster_preview(
    request: Request, body: VclusterPreviewClaimRequest
) -> dict[str, Any]:
    """Claim a pre-baked warm-pool member for a user (A3). 404 when the pool is empty/off — the
    BFF then falls back to a cold provision. A claim consumes an already-awake member (no new
    capacity), so it is NOT gated by VCLUSTER_PREVIEW_MAX."""
    _require_internal(request)
    set_current_span_io("input", body.model_dump())
    alias = _safe_resource_name(body.name, max_length=40)
    claim_user = (body.user or "unknown").strip() or "unknown"
    namespace = _agent_workflow_host_namespace()
    tailnet_host = f"wfb-{alias}"
    url = f"https://{tailnet_host}.{_VCLUSTER_PREVIEW_TAILNET_SUFFIX}"
    if os.environ.get("SANDBOX_EXECUTION_DRY_RUN", "").lower() in {"1", "true", "yes"}:
        # No real vclusters in dry-run → behave as an empty pool (BFF cold-path also dry-runs).
        raise HTTPException(status_code=404, detail="warm pool unavailable (dry-run)")
    batch, core = _load_k8s_clients()
    pool_name = _claim_free_member(
        core,
        alias=alias,
        claim_user=claim_user,
        origin=body.origin,
        pr_number=body.prNumber,
        ttl_hours=body.ttlHours,
    )
    if not pool_name:
        raise HTTPException(
            status_code=404, detail="no free warm-pool member available"
        )
    # A4: an IDEMPOTENT re-claim can resolve to an already-claimed member that has since
    # been put to sleep — wake it instead of running the claim personalization again (the
    # claim-Job's vcluster connect would fail against a scaled-down control plane; the
    # member already carries its alias/LB/creds from the original claim).
    try:
        member_ns = core.read_namespace(name=f"vcluster-{pool_name}")
        member = _preview_member_from_ns(member_ns)
    except Exception:
        member = None
    if member is not None and member.slept:
        _resume_member(batch, core, member, namespace)
        _invalidate_previews_cache()
        response = {
            "name": alias,
            "pool": pool_name,
            "pooled": True,
            "action": "resume",
            "job": _vcluster_preview_job_name(pool_name, "resume"),
            "status": "resuming",
            "tailnetHost": tailnet_host,
            "url": url,
        }
        set_current_span_io("output", response)
        return response
    bump = False
    if _claim_bump_stale_enabled():
        try:
            bump = _member_is_stale(core, _load_k8s_apps_client(), pool_name)
        except Exception as exc:
            logger.warning("claim: staleness check for %s failed: %s", pool_name, exc)
    manifest = _vcluster_claim_job_manifest(
        pool_name,
        alias,
        claim_user,
        dev_mode=body.devMode,
        bump_images=bump,
        namespace=namespace,
    )
    _create_preview_job(batch, namespace=namespace, manifest=manifest)
    _invalidate_previews_cache()
    response = {
        "name": alias,
        "pool": pool_name,
        "pooled": True,
        "action": "claim",
        "job": manifest["metadata"]["name"],
        "status": "claiming",
        "tailnetHost": tailnet_host,
        "url": url,
    }
    set_current_span_io("output", response)
    return response


def _recycle_free_member(batch, core, ns, real_name: str, namespace: str) -> bool:
    """Recycle one pin-drifted free member: EXCLUDE it from claims first (flip free→recycling),
    THEN create a deadline-bounded down-Job. Order matters — a claim must never grab a member
    whose teardown is already in flight."""
    try:
        core.patch_namespace(
            name=ns.metadata.name,
            body={"metadata": {"labels": {_VCLUSTER_PREVIEW_POOL_LABEL: "recycling"}}},
        )
    except Exception as exc:
        logger.warning("pool: recycle relabel %s failed: %s", real_name, exc)
        return False
    req = VclusterPreviewRequest(name=real_name, action="down")
    manifest = _vcluster_preview_job_manifest(req, namespace=namespace)
    # Scoped subset of the teardown-watchdog gap (#25): a recycler down-Job gets a TIGHTER
    # deadline than the default 1800s so a hung teardown can't wedge a pool slot for 30 minutes.
    manifest["spec"]["activeDeadlineSeconds"] = _pool_recycle_deadline_seconds()
    try:
        _create_preview_job(batch, namespace=namespace, manifest=manifest)
    except Exception as exc:
        logger.warning("pool: recycle down-job %s failed: %s", real_name, exc)
        return False
    logger.info("pool: recycling stale member %s (image-pin drift)", real_name)
    return True


# ===========================================================================
# A4 lifecycle: touch/last-active, sleep/resume, TTL teardown, capacity
# eviction. All flag-gated (VCLUSTER_PREVIEW_SLEEP_AFTER_MINUTES /
# VCLUSTER_PREVIEW_TTL_HOURS / VCLUSTER_PREVIEW_TOTAL_MAX default 0 = OFF): with
# the flags at 0 no reaper thread starts and a reap pass only honors EXPLICIT
# per-preview expires-at markers — merging this is inert for the live fleet.
# ===========================================================================


def _lifecycle_job(batch, member: PreviewMember, namespace: str, action: str) -> bool:
    """Create a sleep/resume Job for a member (the runner is the mechanism; SEA only
    decides). Returns False (logged) on failure — callers revert their label flip."""
    req = VclusterPreviewRequest(name=member.real_name, action=action)
    manifest = _vcluster_preview_job_manifest(req, namespace=namespace)
    try:
        _create_preview_job(batch, namespace=namespace, manifest=manifest)
    except Exception as exc:
        logger.warning("lifecycle: %s job for %s failed: %s", action, member.real_name, exc)
        return False
    return True


def _sleep_member(batch, core, member: PreviewMember, namespace: str) -> bool:
    """Sleep one preview: flip the state label FIRST (claims/touch must see the transition
    immediately — mirrors the recycler's exclude-then-teardown order), then create the
    sleep-Job. A failed Job create reverts the label so a preview never reads slept while
    its pods still run."""
    slept_at = datetime.now(UTC).isoformat(timespec="seconds")
    try:
        core.patch_namespace(
            name=member.ns_name,
            body={
                "metadata": {
                    "labels": {_VCLUSTER_PREVIEW_STATE_LABEL: "slept"},
                    "annotations": {
                        _VCLUSTER_PREVIEW_SLEPT_AT_ANNOTATION: slept_at
                    },
                }
            },
        )
    except Exception as exc:
        logger.warning("lifecycle: sleep relabel %s failed: %s", member.real_name, exc)
        return False
    if not _lifecycle_job(batch, member, namespace, "sleep"):
        try:
            core.patch_namespace(
                name=member.ns_name,
                body={"metadata": {"labels": {_VCLUSTER_PREVIEW_STATE_LABEL: "hot"}}},
            )
        except Exception as exc:
            logger.warning(
                "lifecycle: sleep revert relabel %s failed: %s", member.real_name, exc
            )
        return False
    logger.info("lifecycle: sleeping idle preview %s", member.real_name)
    return True


def _resume_member(batch, core, member: PreviewMember, namespace: str) -> bool:
    """Wake a slept preview: flip the state label to hot + stamp last-active (the resume
    IS activity), then create the resume-Job. A failed Job create reverts the label to
    slept — otherwise the preview would READ hot while actually down and a later
    touch/claim would never retry the resume."""
    now_iso = datetime.now(UTC).isoformat(timespec="seconds")
    try:
        core.patch_namespace(
            name=member.ns_name,
            body={
                "metadata": {
                    "labels": {_VCLUSTER_PREVIEW_STATE_LABEL: "hot"},
                    "annotations": {
                        _VCLUSTER_PREVIEW_LAST_ACTIVE_ANNOTATION: now_iso
                    },
                }
            },
        )
    except Exception as exc:
        logger.warning("lifecycle: resume relabel %s failed: %s", member.real_name, exc)
    if not _lifecycle_job(batch, member, namespace, "resume"):
        try:
            core.patch_namespace(
                name=member.ns_name,
                body={"metadata": {"labels": {_VCLUSTER_PREVIEW_STATE_LABEL: "slept"}}},
            )
        except Exception as exc:
            logger.warning(
                "lifecycle: resume revert relabel %s failed: %s", member.real_name, exc
            )
        return False
    logger.info("lifecycle: resuming slept preview %s", member.real_name)
    return True


def _reap_teardown_member(
    batch, core, member: PreviewMember, namespace: str, *, reason: str
) -> bool:
    """Tear one member down for the reaper (TTL-expired or capacity eviction). Pool
    members (free OR claimed) are excluded from claims FIRST (flip to recycling — the
    proven recycler order), then a deadline-bounded down-Job does the teardown."""
    if member.pool_state in ("free", "claimed"):
        try:
            core.patch_namespace(
                name=member.ns_name,
                body={
                    "metadata": {
                        "labels": {_VCLUSTER_PREVIEW_POOL_LABEL: "recycling"}
                    }
                },
            )
        except Exception as exc:
            logger.warning(
                "lifecycle: reap relabel %s failed: %s", member.real_name, exc
            )
            return False
    req = VclusterPreviewRequest(name=member.real_name, action="down")
    manifest = _vcluster_preview_job_manifest(req, namespace=namespace)
    manifest["spec"]["activeDeadlineSeconds"] = _pool_recycle_deadline_seconds()
    try:
        _create_preview_job(batch, namespace=namespace, manifest=manifest)
    except Exception as exc:
        logger.warning(
            "lifecycle: reap down-job %s failed: %s", member.real_name, exc
        )
        return False
    logger.info("lifecycle: tearing down preview %s (%s)", member.real_name, reason)
    return True


def _preview_jobs_in_flight(batch, namespace: str) -> set[str]:
    """Members with an ACTIVE down/sleep/resume Job — the reaper skips them for the tick
    (never stack a second transition on an in-flight one). Keyed on the Job's labels +
    active status, like the #33 bake counter: survives an SEA restart and self-clears."""
    names: set[str] = set()
    try:
        jobs = batch.list_namespaced_job(
            namespace=namespace, label_selector="app=vcluster-preview"
        )
    except Exception as exc:
        logger.warning("lifecycle: in-flight job list failed: %s", exc)
        return names
    for j in jobs.items:
        labels = getattr(getattr(j, "metadata", None), "labels", None) or {}
        if labels.get("vcluster-preview-action") not in ("down", "sleep", "resume"):
            continue
        if int(getattr(j.status, "active", 0) or 0) > 0:
            name = labels.get(_VCLUSTER_PREVIEW_NAME_LABEL)
            if name:
                names.add(name)
    return names


def _lifecycle_reap_once(batch, core, *, need_room: int = 0) -> dict[str, int]:
    """One A4 reaper pass, in leverage order:
      1. TTL teardown  — members past their effective expiry (explicit expires-at always;
                         creation+VCLUSTER_PREVIEW_TTL_HOURS only when that flag is on)
      2. capacity      — evict (via the PURE selector) down to VCLUSTER_PREVIEW_TOTAL_MAX,
                         plus any explicit need_room the caller asked for
      3. sleep         — activity-tracked members idle past VCLUSTER_PREVIEW_SLEEP_AFTER_MINUTES
                         (free/recycling pool members and untracked previews are exempt)
    HARD RULES enforced here + in the selector: only namespaces labeled app=vcluster-preview
    are ever considered; protected members are never touched; members with an in-flight
    down/sleep/resume Job are skipped for the tick. Returns a stats dict (endpoint + tests)."""
    stats = {
        "total": 0,
        "awake": 0,
        "slept": 0,
        "reapedExpired": 0,
        "evicted": 0,
        "sleptNow": 0,
    }
    namespace = _agent_workflow_host_namespace()
    now = datetime.now(UTC)
    ttl_hours = _vcluster_preview_ttl_hours()
    sleep_after = _vcluster_preview_sleep_after_minutes()
    total_max = _vcluster_preview_total_max()
    active_minutes = _vcluster_preview_active_minutes()
    pool_size = _vcluster_preview_pool_size()

    nss = core.list_namespace(label_selector="app=vcluster-preview")
    live = [
        m
        for m in (_preview_member_from_ns(ns) for ns in nss.items)
        if not m.terminating
    ]
    stats["total"] = len(live)
    stats["slept"] = sum(1 for m in live if m.slept)
    stats["awake"] = stats["total"] - stats["slept"]

    in_flight = _preview_jobs_in_flight(batch, namespace)
    reaped: set[str] = set()

    # 1) TTL teardown.
    for m in live:
        if m.protected or m.real_name in in_flight:
            continue
        if _member_is_expired(m, now=now, ttl_hours=ttl_hours):
            if _reap_teardown_member(batch, core, m, namespace, reason="ttl-expired"):
                stats["reapedExpired"] += 1
                reaped.add(m.real_name)

    # 2) Capacity eviction: TOTAL_MAX overflow + explicit need_room (both via the pure
    # selector, so the locked eviction order is the ONLY order).
    remaining = [
        m for m in live if m.real_name not in reaped and m.real_name not in in_flight
    ]
    overflow = (len(remaining) - total_max) if total_max > 0 else 0
    need = max(0, overflow) + max(0, need_room)
    if need > 0:
        for m in _select_preview_evictions(
            remaining,
            need=need,
            pool_size=pool_size,
            now=now,
            ttl_hours=ttl_hours,
            active_minutes=active_minutes,
        ):
            if _reap_teardown_member(batch, core, m, namespace, reason="capacity"):
                stats["evicted"] += 1
                reaped.add(m.real_name)

    # 3) Sleep idle activity-tracked previews. Free members stay claim-ready (a slept
    # member would blow the <90s claim budget on an unexpected cold resume); previews
    # WITHOUT a last-active annotation (legacy/human, e.g. the standing gan-*) are not
    # activity-tracked and are never slept.
    if sleep_after > 0:
        idle = timedelta(minutes=sleep_after)
        for m in live:
            if m.real_name in reaped or m.real_name in in_flight:
                continue
            if m.protected or m.slept or m.terminating:
                continue
            if m.pool_state in ("free", "recycling"):
                continue
            if m.last_active is None:
                continue
            if now - m.last_active >= idle:
                if _sleep_member(batch, core, m, namespace):
                    stats["sleptNow"] += 1

    if stats["reapedExpired"] or stats["evicted"] or stats["sleptNow"]:
        _invalidate_previews_cache()
    return stats


_lifecycle_reaper_started = False
_lifecycle_reaper_lock = threading.Lock()


def _lifecycle_enabled() -> bool:
    return (
        _vcluster_preview_sleep_after_minutes() > 0
        or _vcluster_preview_ttl_hours() > 0
        or _vcluster_preview_total_max() > 0
    )


def _lifecycle_reaper_loop() -> None:
    interval = float(
        os.environ.get("VCLUSTER_PREVIEW_LIFECYCLE_RECONCILE_SECONDS", "60") or 60
    )
    time.sleep(min(interval, 15.0))  # let app startup settle before the first pass
    logger.info(
        "lifecycle-reaper: started (sleepAfterMin=%d ttlHours=%d totalMax=%d interval=%.0fs)",
        _vcluster_preview_sleep_after_minutes(),
        _vcluster_preview_ttl_hours(),
        _vcluster_preview_total_max(),
        interval,
    )
    while True:
        try:
            batch, core = _load_k8s_clients()
            _lifecycle_reap_once(batch, core)
        except Exception as exc:
            logger.warning("lifecycle-reaper: pass failed: %s", exc)
        time.sleep(interval)


def _start_lifecycle_reaper() -> None:
    """Start the singleton reaper thread iff any A4 lifecycle flag is on and not dry-run.
    Mirrors _start_pool_manager (SEA is replicas=1 — the thread is the whole coordinator;
    the suspended GC CronJob calling POST /internal/vcluster-preview/reap is the
    belt-and-suspenders backstop against thread death)."""
    if not _lifecycle_enabled():
        return
    if os.environ.get("SANDBOX_EXECUTION_DRY_RUN", "").lower() in {"1", "true", "yes"}:
        return
    global _lifecycle_reaper_started
    with _lifecycle_reaper_lock:
        if _lifecycle_reaper_started:
            return
        _lifecycle_reaper_started = True
        threading.Thread(
            target=_lifecycle_reaper_loop, daemon=True, name="vcluster-lifecycle-reaper"
        ).start()


def _pool_reconcile_once(batch, core, apps) -> dict[str, int]:
    """One reconcile pass: recycle pin-drifted free members, then top the pool up toward
    VCLUSTER_PREVIEW_POOL_SIZE — bounded by VCLUSTER_PREVIEW_MAX awake and the per-tick fill
    batch. Returns a small stats dict (used by tests)."""
    stats = {"awake": 0, "free": 0, "baking": 0, "created": 0, "recycled": 0}
    pool_size = _vcluster_preview_pool_size()
    if pool_size <= 0:
        return stats
    max_awake = _vcluster_preview_max()
    try:
        fill_batch = int(os.environ.get("VCLUSTER_PREVIEW_POOL_FILL_BATCH", "1") or 1)
    except (TypeError, ValueError):
        fill_batch = 1
    recycle_on = (
        os.environ.get("VCLUSTER_PREVIEW_POOL_RECYCLE", "true").lower() != "false"
    )
    namespace = _agent_workflow_host_namespace()

    nss = core.list_namespace(label_selector="app=vcluster-preview")
    free_members = []
    awake = 0
    free = 0
    for ns in nss.items:
        if _preview_ns_is_terminating(ns):
            continue
        labels = (ns.metadata.labels or {}) if ns.metadata else {}
        # A4: a SLEPT preview holds no compute — it doesn't count against the awake cap,
        # so the pool can keep filling while user previews sleep. (A slept FREE member —
        # manual force-sleep only — still counts as free to avoid an overshoot when it
        # wakes; claims skip it.)
        if labels.get(_VCLUSTER_PREVIEW_STATE_LABEL) != "slept":
            awake += 1
        if labels.get(_VCLUSTER_PREVIEW_POOL_LABEL) == "free":
            free += 1
            free_members.append(ns)

    recycled = 0
    if recycle_on and free_members:
        host_pins = _host_image_pins(apps)
        if host_pins:
            for ns in free_members:
                ann = (ns.metadata.annotations or {}) if ns.metadata else {}
                member_pins = ann.get(_VCLUSTER_PREVIEW_IMAGE_PINS_ANNOTATION)
                if member_pins and member_pins != host_pins:
                    real_name = _preview_realname_from_ns(ns)
                    if _recycle_free_member(batch, core, ns, real_name, namespace):
                        recycled += 1
                        free -= 1  # no longer claimable (relabeled recycling); still awake

    # In-flight bakes: pool up-Jobs still Running. A baking member is counted in `awake` but NOT
    # in `free` (the free label lands only at the END of its ~277s bringup), so without counting
    # these the fill below would relaunch a redundant bake every reconcile tick during that window
    # and overshoot pool_size (task #33). Keying on the Job's `active` status (not a namespace
    # label) is the robust signal: it survives an SEA restart (the Job persists, so a fresh pool
    # manager still sees the in-flight bake) and self-clears on a failed bake (a labelless
    # half-baked namespace would otherwise count as in-flight forever → permanent under-fill).
    baking = 0
    try:
        jobs = batch.list_namespaced_job(
            namespace=namespace, label_selector="vcluster-preview-action=up"
        )
        for j in jobs.items:
            jname = (j.metadata.name or "") if j.metadata else ""
            if jname.startswith("vcpreview-up-pool-") and int(
                getattr(j.status, "active", 0) or 0
            ) > 0:
                baking += 1
    except Exception as exc:
        # Fail-open toward the pre-#33 behavior (may overshoot, never under-fill).
        logger.warning("pool: in-flight bake count failed: %s", exc)
        baking = 0

    # Fill: aim for pool_size free members, counting in-flight bakes so we don't over-provision;
    # never past max_awake, and at most fill_batch per tick (bounds the IO/enrollment burst).
    need = pool_size - (free + baking)
    room = max_awake - awake
    to_create = max(0, min(need, room, fill_batch))
    created = 0
    for _ in range(to_create):
        name = f"pool-{secrets.token_hex(2)}"
        req = VclusterPreviewRequest(name=name, action="up", pool=True)
        manifest = _vcluster_preview_job_manifest(req, namespace=namespace)
        try:
            _create_preview_job(batch, namespace=namespace, manifest=manifest)
            created += 1
            logger.info(
                "pool: baking member %s (free=%d baking=%d awake=%d target=%d max=%d)",
                name,
                free,
                baking,
                awake,
                pool_size,
                max_awake,
            )
        except Exception as exc:
            logger.warning("pool: failed to create member %s: %s", name, exc)

    if created or recycled:
        _invalidate_previews_cache()
    stats.update(
        awake=awake, free=free, baking=baking, created=created, recycled=recycled
    )
    return stats


_pool_manager_started = False
_pool_manager_lock = threading.Lock()


def _pool_manager_loop() -> None:
    interval = float(
        os.environ.get("VCLUSTER_PREVIEW_POOL_RECONCILE_SECONDS", "60") or 60
    )
    time.sleep(min(interval, 15.0))  # let app startup settle before the first pass
    logger.info(
        "pool-manager: started (size=%d max=%d interval=%.0fs)",
        _vcluster_preview_pool_size(),
        _vcluster_preview_max(),
        interval,
    )
    while True:
        try:
            batch, core = _load_k8s_clients()
            apps = _load_k8s_apps_client()
            _pool_reconcile_once(batch, core, apps)
        except Exception as exc:
            logger.warning("pool-manager: reconcile failed: %s", exc)
        time.sleep(interval)


def _start_pool_manager() -> None:
    """Start the singleton reconcile thread iff the pool is enabled (size>0) and not dry-run.
    SEA runs replicas=1 so a single in-process thread is the whole coordinator — no Lease
    needed; the module-level guard keeps a double startup event from spawning two."""
    if _vcluster_preview_pool_size() <= 0:
        return
    if os.environ.get("SANDBOX_EXECUTION_DRY_RUN", "").lower() in {"1", "true", "yes"}:
        return
    global _pool_manager_started
    with _pool_manager_lock:
        if _pool_manager_started:
            return
        _pool_manager_started = True
        threading.Thread(
            target=_pool_manager_loop, daemon=True, name="vcluster-pool-manager"
        ).start()

from __future__ import annotations

import json
import logging
import os
import posixpath
import re
import secrets
import threading
import time
from contextlib import ExitStack, asynccontextmanager, contextmanager
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from hashlib import sha256
from pathlib import Path
from typing import Any
from uuid import uuid4

from fastapi import FastAPI, HTTPException, Query, Request, Response, status
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict, Field, ValidationError

from src.content_tracing import set_current_span_io
from src.preview_runner_identity import (
    RUNNER_GENERATION_ANNOTATION,
    PreviewRunnerIdentityAdapter,
    PreviewRunnerIdentityError,
    preview_runner_identity_name,
)

KUEUE_QUEUE_LABEL = "kueue.x-k8s.io/queue-name"
KUEUE_PRIORITY_CLASS_LABEL = "kueue.x-k8s.io/priority-class"
DEFAULT_NODE_SELECTOR = {"stacks.io/swebench-pool": "dev-benchmark"}
DEFAULT_JOB_TTL_SECONDS = 300
DEFAULT_AGENT_HOST_SHUTDOWN_BUFFER_SECONDS = 1800
# Pod-level backstop margin BEYOND the controller's graceful shutdown window
# (timeoutSeconds + shutdown buffer). The kubelet activeDeadline must land
# strictly AFTER the Sandbox controller's shutdownTime — never before it —
# so DeadlineExceeded stays a last-resort backstop, not the de-facto
# terminator for every agent-host sandbox.
AGENT_HOST_POD_DEADLINE_MARGIN_SECONDS = 600
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
DEFAULT_MANIFEST_CANDIDATE_SURFACE_PATH = "/config/manifest-candidate-surface.json"

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
    # Compatibility tombstone: profiled preview pools are retired and the size
    # helper is hard-disabled, so this cannot start a reconcile thread.
    try:
        _start_pool_manager()
    except (
        Exception
    ) as exc:  # pragma: no cover - never block startup on the optional pool
        logger.warning("pool-manager: startup failed: %s", exc)
    # A4 lifecycle reaper (sleep/TTL/capacity) — a no-op unless one of its flags is set
    # (VCLUSTER_PREVIEW_SLEEP_AFTER_MINUTES / _TTL_HOURS / _TOTAL_MAX > 0).
    try:
        _start_lifecycle_reaper()
    except Exception as exc:  # pragma: no cover - never block startup on the reaper
        logger.warning("lifecycle-reaper: startup failed: %s", exc)
    try:
        _start_preview_identity_cleanup_controller()
    except Exception as exc:  # pragma: no cover - never block startup on cleanup
        logger.warning("preview-identity-cleanup: startup failed: %s", exc)
    try:
        _start_dev_preview_activation_recovery()
    except Exception as exc:  # pragma: no cover - never block startup on recovery
        logger.warning("dev-preview-activation: startup recovery failed: %s", exc)
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
    # static per-generation PV+PVC (CSI subPath = the conversation key) and the
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
    # transcript store; PV/PVC named per generation, CSI subPath = the shared key.
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
    # Class-wide envFrom sources (configMapRef/secretRef) appended after the
    # request's service-specific sources. A later duplicate source wins, allowing
    # preview-wide configuration to override the reused prod app config without
    # copying plaintext into the Sandbox CR.
    serviceEnvFrom: list[dict[str, Any]] | None = None
    # Git-synced image-pins ConfigMap (workflow-builder-image-pins) mounted as a
    # DIRECTORY at /etc/workflow-builder/image-pins on the dev container (files
    # classes.json + runtime-images.json). When set, the builder also stamps
    # SANDBOX_EXECUTION_CLASSES_FILE + WORKFLOW_BUILDER_IMAGE_PINS_FILE so the dev
    # pod's own app reads pins file-first (a re-provision picks up the latest pins
    # without a re-render). None (default) = today's env-only behavior.
    imagePinsConfigMap: str | None = None


class AgentWorkflowHostRequest(BaseModel):
    sessionId: str
    agentAppId: str
    runId: str | None = None
    instanceId: str | None = None
    executionClass: str = Field(default="benchmark-fast")
    timeoutSeconds: int | None = Field(default=None, ge=60, le=86400)
    # Optional create-to-activation safety window. A provisional host is born
    # with a short controller-enforced shutdownTime and becomes persistent (or
    # receives its final finite timeout) only after the owning lease is
    # durably published and the internal activation endpoint succeeds.
    provisionalTimeoutSeconds: int | None = Field(default=None, ge=60, le=3600)
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


class AgentWorkflowHostActivationRequest(BaseModel):
    sandboxName: str = Field(min_length=1, max_length=63)
    generation: str = Field(min_length=1, max_length=63)


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
    # Exact execution/service receiver leaf used by the dev-sync receiver.
    syncToken: str | None = Field(default=None, pattern=r"^[0-9a-f]{64}$")
    # Preview-scoped bearer returned to the unprivileged agent. Receivers retain
    # only its SHA256 hash, while the plaintext grants access to this dev pod.
    syncAgentToken: str | None = Field(default=None, pattern=r"^[0-9a-f]{64}$")
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
    # Stamped verbatim as DEV_SYNC_COMMANDS_JSON into BOTH the sidecar (proxy +
    # fallback allowlist) AND the app container (its /__exec bridge's own
    # fail-closed allowlist, #40); only these named commands run in the workdir
    # (never an arbitrary request string). `deps` is reserved for the dependency
    # reinstall; other names are test lanes (e.g. `contract`). Populated by the
    # BFF from the dev-preview registry.
    devSyncCommands: dict[str, str] | None = None
    # Exact receiver-owned replacement roots from the canonical service catalog.
    # Every /__sync request must declare this complete set; archive omission of a
    # root means deletion. The receiver validates path shape and exact equality.
    devSyncAllowedRoots: list[str] | None = Field(
        default=None, min_length=1, max_length=128
    )
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
    # Two-phase multi-service adoption. Stage creates and proves the exact
    # Lease/Sandbox/pod tuple but leaves every production Deployment running.
    # One later /internal/dev-previews/activate request commits the whole set.
    stageAdoption: bool = False


class DevPreviewActivationRequest(BaseModel):
    executionId: str = Field(min_length=1, max_length=256)
    sandboxNames: list[str] = Field(min_length=1, max_length=16)


class DevPreviewTeardownIntentRequest(BaseModel):
    executionId: str = Field(min_length=1, max_length=256)


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


_EXECUTION_CLASSES_FILE_WARNED = False


def _warn_execution_classes_file_once(reason: str, path: str) -> None:
    """Log a broken SANDBOX_EXECUTION_CLASSES_FILE mount ONCE (this reader runs per
    request); after the first line the caller silently falls back to the env JSON."""
    global _EXECUTION_CLASSES_FILE_WARNED
    if _EXECUTION_CLASSES_FILE_WARNED:
        return
    _EXECUTION_CLASSES_FILE_WARNED = True
    logger.warning(
        "execution classes file %s %s; falling back to SANDBOX_EXECUTION_CLASSES_JSON",
        path,
        reason,
    )


def _execution_classes_override() -> dict[str, Any] | None:
    """The execution-classes override object, file-first: the git-synced classes.json
    (env SANDBOX_EXECUTION_CLASSES_FILE) wins over the inline
    SANDBOX_EXECUTION_CLASSES_JSON env. A missing/unreadable/invalid file logs ONCE
    and falls through to the env JSON (which itself falls through to defaults when
    unset/invalid), so a broken mount degrades to today's behavior. None when neither
    source yields a JSON object."""
    path = os.environ.get("SANDBOX_EXECUTION_CLASSES_FILE", "").strip()
    if path:
        raw = ""
        try:
            raw = Path(path).read_text(encoding="utf-8").strip()
        except OSError as exc:
            _warn_execution_classes_file_once(f"unreadable ({exc})", path)
        if raw:
            try:
                parsed = json.loads(raw)
            except json.JSONDecodeError as exc:
                _warn_execution_classes_file_once(f"is invalid JSON ({exc})", path)
            else:
                if isinstance(parsed, dict):
                    return parsed
                _warn_execution_classes_file_once("is not a JSON object", path)
    raw = os.environ.get("SANDBOX_EXECUTION_CLASSES_JSON", "").strip()
    if not raw:
        return None
    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError:
        return None
    return parsed if isinstance(parsed, dict) else None


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
    parsed = _execution_classes_override()
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
    prefix = (
        os.environ.get("SANDBOX_EXECUTION_AGENT_TOPIC_PREFIX", "").strip().strip(".")
    )
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


def _agent_host_shutdown_time_after(seconds: int) -> str:
    return (
        (datetime.now(UTC) + timedelta(seconds=seconds))
        .replace(microsecond=0)
        .isoformat()
        .replace("+00:00", "Z")
    )


def _agent_host_shutdown_time(request: AgentWorkflowHostRequest) -> str | None:
    if request.timeoutSeconds is None:
        return None
    shutdown_after_seconds = (
        request.timeoutSeconds + _agent_host_shutdown_buffer_seconds()
    )
    return _agent_host_shutdown_time_after(shutdown_after_seconds)


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
                "securityContext": _restricted_container_security_context(),
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


# ---- #32: ONE Kubernetes ApiClient per process --------------------------------------
# Every `client.BatchV1Api()`-style no-arg constructor builds a private ApiClient, and
# every ApiClient builds its own urllib3 PoolManager + TLS machinery (CA-bundle load,
# fresh connections, native OpenSSL buffers). The pre-#32 loaders did exactly that on
# EVERY call — per request handler, per 60s pool-manager tick, per reaper tick — so
# under pool churn (bakes/claims/recycles + an 8s UI list poll fanning out to 8 probe
# threads) the process churned connection pools + SSL contexts continuously. The Python
# heap stayed bounded (objects were collectable) but the native allocation storm
# fragments glibc arenas, which is RSS that never returns to the OS → the observed
# OOMKills (at 512Mi 2026-07-05 ~04:0xZ; at 1Gi 06:15Z after only ~9min of extreme
# churn — the container came up 06:06Z and was OOMKilled 06:15Z).
#
# The fix: build ONE ApiClient lazily and hand every caller a thin per-call API wrapper
# (BatchV1Api(api) etc. hold no pools of their own — they are cheap). Correctness notes:
#   - urllib3's PoolManager is thread-safe; the list endpoint already shared one client
#     across its probe threads, so sharing process-wide adds no new assumption.
#   - In-cluster SA token rotation keeps working: load_incluster_config() installs
#     refresh_api_key_hook on the default Configuration, get_default_copy() deep-copies
#     it (functions are atomic under deepcopy), and the hook re-reads the projected
#     token file whenever the cached one is older than a minute.
#   - The pool must fit the list endpoint's concurrent probes (≤8) plus the background
#     threads, or urllib3 discards overflow connections (recreating the very TLS churn
#     this cache removes) — floor connection_pool_maxsize at 16.
_k8s_api_client: Any = None
_k8s_api_client_lock = threading.Lock()


def _k8s_shared_api_client():
    global _k8s_api_client
    api = _k8s_api_client
    if api is not None:
        return api
    with _k8s_api_client_lock:
        if _k8s_api_client is None:
            from kubernetes import client, config

            try:
                config.load_incluster_config()
            except Exception:
                config.load_kube_config()
            configuration = client.Configuration.get_default_copy()
            if (configuration.connection_pool_maxsize or 0) < 16:
                configuration.connection_pool_maxsize = 16
            _k8s_api_client = client.ApiClient(configuration)
        return _k8s_api_client


def _load_k8s_clients():
    from kubernetes import client

    api = _k8s_shared_api_client()
    return client.BatchV1Api(api), client.CoreV1Api(api)


def _load_k8s_custom_objects_client():
    from kubernetes import client

    return client.CustomObjectsApi(_k8s_shared_api_client())


def _load_k8s_apps_client():
    from kubernetes import client

    return client.AppsV1Api(_k8s_shared_api_client())


def _load_k8s_coordination_client():
    from kubernetes import client

    return client.CoordinationV1Api(_k8s_shared_api_client())


def _load_k8s_rbac_client():
    from kubernetes import client

    return client.RbacAuthorizationV1Api(_k8s_shared_api_client())


# Stashes a Deployment's replica count before preview-native adopt scales it to 0,
# so teardown can restore it (survives an SEA restart — state lives on the object).
DEV_PREVIEW_ORIGINAL_REPLICAS_ANNOTATION = "wfb-dev-preview/original-replicas"

# These Deployments carry the synchronous dev-preview request while SEA prepares
# their replacements. Cut them over only after the response has had time to leave
# the workload data path; every other adopted peer can be scaled down immediately.
DEV_PREVIEW_DEFERRED_CUTOVER_DEPLOYMENTS = frozenset(
    {"workflow-builder", "function-router"}
)
_DEV_PREVIEW_ADOPTION_TRANSITION_LOCKS: dict[tuple[str, str], Any] = {}
_DEV_PREVIEW_ADOPTION_TRANSITION_LOCKS_GUARD = threading.Lock()
_DEV_PREVIEW_TEARDOWN_INTENTS: set[str] = set()
_DEV_PREVIEW_TEARDOWN_INTENTS_GUARD = threading.Lock()
_DEV_PREVIEW_ACTIVATION_WORKERS: set[str] = set()
_DEV_PREVIEW_ACTIVATION_WORKERS_GUARD = threading.Lock()


def _dev_preview_adoption_transition_lock(namespace: str, deployment: str) -> Any:
    key = (namespace, deployment)
    with _DEV_PREVIEW_ADOPTION_TRANSITION_LOCKS_GUARD:
        return _DEV_PREVIEW_ADOPTION_TRANSITION_LOCKS.setdefault(
            key, threading.RLock()
        )


def _dev_preview_teardown_intended(execution_id: str) -> bool:
    with _DEV_PREVIEW_TEARDOWN_INTENTS_GUARD:
        return execution_id in _DEV_PREVIEW_TEARDOWN_INTENTS

_ADOPT_ENV_LITERAL_NAMES = frozenset(
    {
        "AGY_CLI_APP_ID",
        "CLAUDE_CODE_CLI_APP_ID",
        "CODEX_CLI_APP_ID",
        "DEV_PREVIEW_CLUSTER_NAME",
        "DEV_PREVIEW_PLATFORM_SCOPE",
        "DEV_PREVIEW_TAILNET_SUFFIX",
        "DYNAMIC_SCRIPT_ACTIONS_ENABLED",
        "DYNAMIC_SCRIPT_DEFAULT_MODEL",
        "DYNAMIC_SCRIPT_MAX_BYTES",
        "DYNAMIC_SCRIPT_MAX_CONCURRENCY",
        "FUNCTION_ROUTER_DEV_IMAGE",
        "OPENSHELL_AGENT_RUNTIME_API_BASE_URL",
        "PREVIEW_CONTROL_BROKER_URL",
        "PREVIEW_NATIVE_ACTION_SLUGS_JSON",
        "SANDBOX_EXECUTION_API_URL",
        "SANDBOX_EXECUTION_CLASSES_FILE",
        "SANDBOX_EXECUTION_CLASSES_JSON",
        "SANDBOX_TEMPLATE_IMAGES_JSON",
        "WORKFLOW_BUILDER_DEV_IMAGE",
        "WORKFLOW_BUILDER_IMAGE_PINS_FILE",
        "WORKFLOW_ORCHESTRATOR_EMIT_LIFECYCLE_EVENTS",
        "WORKFLOW_ORCHESTRATOR_EVENT_TOPIC_PREFIX",
        "WORKFLOW_ORCHESTRATOR_DEV_IMAGE",
        "WORKSPACE_RUNTIME_URL",
    }
)
_ADOPT_ENV_LITERAL_PREFIXES = (
    "AGENT_PREWARM_",
    "AGENT_RUNTIME_",
    "AGENT_WARM_POOL_",
    "AGENT_WORKFLOW_HOST_",
    "DAPR_",
)
_ADOPT_ENV_SECRET_NAMES = frozenset(
    {
        "PREVIEW_ACTION_INTERNAL_TOKEN",
        "PREVIEW_CONTROL_CAPABILITY_TOKEN",
        "PREVIEW_DEV_SYNC_MINT_TOKEN",
        "SANDBOX_EXECUTION_API_TOKEN",
    }
)
_ADOPT_ENV_EXACT_SECRET_REFS = {
    "INTERNAL_API_TOKEN": ("workflow-builder-secrets", "INTERNAL_API_TOKEN"),
}
_ADOPT_ENV_EXACT_CONFIG_MAP_REFS = {
    "APP_PUBLIC_URL": ("preview-environment-identity", "public-url"),
    "ORIGIN": ("preview-environment-identity", "public-url"),
    "PREVIEW_FUNCTION_REGISTRY_JSON": ("function-registry", "functions.json"),
}
_ADOPT_ENV_CONFIG_MAP_NAMES = frozenset(
    {
        "PREVIEW_ENVIRONMENT_CATALOG_DIGEST",
        "PREVIEW_ENVIRONMENT_NAME",
        "PREVIEW_ENVIRONMENT_PLATFORM_REVISION",
        "PREVIEW_ENVIRONMENT_REQUEST_ID",
        "PREVIEW_ENVIRONMENT_SERVICES_JSON",
        "PREVIEW_ENVIRONMENT_SOURCE_REVISION",
    }
)
_ADOPT_ENV_DEPLOYMENT_AUTHORITY_NAMES = frozenset(
    {
        "APP_PUBLIC_URL",
        "DYNAMIC_SCRIPT_ACTIONS_ENABLED",
        "DYNAMIC_SCRIPT_DEFAULT_MODEL",
        "DYNAMIC_SCRIPT_MAX_BYTES",
        "DYNAMIC_SCRIPT_MAX_CONCURRENCY",
        "ORIGIN",
        "PREVIEW_FUNCTION_REGISTRY_JSON",
        "PREVIEW_NATIVE_ACTION_SLUGS_JSON",
    }
)


def _adopt_env_key_ref(value: Any, field: str) -> dict[str, Any] | None:
    if not isinstance(value, dict) or set(value) - {field}:
        return None
    ref = value.get(field)
    if not isinstance(ref, dict) or set(ref) - {"name", "key", "optional"}:
        return None
    name = ref.get("name")
    key = ref.get("key")
    optional = ref.get("optional")
    if not isinstance(name, str) or not name or not isinstance(key, str) or not key:
        return None
    if optional is not None and not isinstance(optional, bool):
        return None
    return {
        field: {
            "name": name,
            "key": key,
            **({"optional": optional} if optional is not None else {}),
        }
    }


def _filter_adopted_container_env(
    entries: list[dict[str, Any]] | None,
) -> list[dict[str, Any]] | None:
    """Retain the adopted workload's operational config and scoped leaves only.

    Mutable preview code must never inherit a dev-sync derivation root, raw agent
    bearer, GitHub/write credential, or unrelated production capability through
    the copied Deployment template.
    """
    retained: list[dict[str, Any]] = []
    for entry in entries or []:
        if not isinstance(entry, dict):
            continue
        name = entry.get("name")
        if not isinstance(name, str) or not name:
            continue
        value = entry.get("value")
        if (
            isinstance(value, str)
            and (
                name in _ADOPT_ENV_LITERAL_NAMES
                or name.startswith(_ADOPT_ENV_LITERAL_PREFIXES)
            )
            and set(entry) <= {"name", "value"}
        ):
            retained.append({"name": name, "value": value})
            continue
        value_from = entry.get("valueFrom")
        if name in _ADOPT_ENV_SECRET_NAMES:
            safe_ref = _adopt_env_key_ref(value_from, "secretKeyRef")
        elif name in _ADOPT_ENV_EXACT_SECRET_REFS:
            safe_ref = _adopt_env_key_ref(value_from, "secretKeyRef")
            expected_name, expected_key = _ADOPT_ENV_EXACT_SECRET_REFS[name]
            if safe_ref is not None:
                ref = safe_ref["secretKeyRef"]
                if ref["name"] != expected_name or ref["key"] != expected_key:
                    safe_ref = None
        elif name in _ADOPT_ENV_EXACT_CONFIG_MAP_REFS:
            safe_ref = _adopt_env_key_ref(value_from, "configMapKeyRef")
            expected_name, expected_key = _ADOPT_ENV_EXACT_CONFIG_MAP_REFS[name]
            if safe_ref is not None:
                ref = safe_ref["configMapKeyRef"]
                if ref["name"] != expected_name or ref["key"] != expected_key:
                    safe_ref = None
        elif name in _ADOPT_ENV_CONFIG_MAP_NAMES:
            safe_ref = _adopt_env_key_ref(value_from, "configMapKeyRef")
        else:
            safe_ref = None
        if safe_ref is not None and set(entry) <= {"name", "valueFrom"}:
            retained.append({"name": name, "valueFrom": safe_ref})
    return retained or None


DEV_PREVIEW_ADOPTION_LEASE_LABEL = "wfb-dev-preview-adoption"
DEV_PREVIEW_ADOPT_DEPLOYMENT_ANNOTATION = "wfb-dev-preview/adopt-deployment"
DEV_PREVIEW_ADOPT_HOLDER_ANNOTATION = "wfb-dev-preview/adopt-holder"
DEV_PREVIEW_ADOPT_CUTOVER_CANCELLED_ANNOTATION = (
    "wfb-dev-preview/adopt-cutover-cancelled"
)
DEV_PREVIEW_ADOPT_STAGED_ANNOTATION = "wfb-dev-preview/adopt-staged"
DEV_PREVIEW_ADOPT_EXECUTION_ANNOTATION = "wfb-dev-preview/adopt-execution-id"
DEV_PREVIEW_ADOPT_SERVICE_ANNOTATION = "wfb-dev-preview/adopt-service"
DEV_PREVIEW_ADOPT_SELECTOR_ANNOTATION = "wfb-dev-preview/adopt-selector"
DEV_PREVIEW_ADOPT_GATE_KEY_ANNOTATION = "wfb-dev-preview/adopt-gate-key"
DEV_PREVIEW_ADOPT_GATE_STAGED_VALUE_ANNOTATION = (
    "wfb-dev-preview/adopt-gate-staged-value"
)
DEV_PREVIEW_ADOPT_BATCH_ID_ANNOTATION = "wfb-dev-preview/adopt-batch-id"
DEV_PREVIEW_ADOPT_BATCH_NAMES_ANNOTATION = "wfb-dev-preview/adopt-batch-names"
DEV_PREVIEW_ADOPT_BATCH_EXECUTION_ANNOTATION = (
    "wfb-dev-preview/adopt-batch-execution"
)
DEV_PREVIEW_ADOPT_BATCH_PHASE_ANNOTATION = "wfb-dev-preview/adopt-batch-phase"
DEV_PREVIEW_ADOPT_BATCH_ERROR_ANNOTATION = "wfb-dev-preview/adopt-batch-error"
DEV_PREVIEW_ADOPT_BATCH_UPDATED_ANNOTATION = "wfb-dev-preview/adopt-batch-updated-at"
DEV_PREVIEW_SECRET_NAME_ANNOTATION = "wfb-dev-preview/secret-name"
DEV_PREVIEW_MANAGED_LABEL = "preview.stacks.io/managed-by"
DEV_PREVIEW_MANAGED_VALUE = "sandbox-execution-api"
_DEV_PREVIEW_ADOPT_BATCH_PENDING_PHASES = frozenset({"scheduled", "activating"})
_DEV_PREVIEW_ADOPT_BATCH_TERMINAL_PHASES = frozenset({"active", "failed"})
_DEV_PREVIEW_ADOPTION_LEASE_SECONDS = 120


def _adopt_value(value: Any, *names: str) -> Any:
    if isinstance(value, dict):
        for name in names:
            if name in value:
                return value[name]
        return None
    for name in names:
        found = getattr(value, name, None)
        if found is not None:
            return found
    return None


def _adopt_lease_name(deployment: str) -> str:
    return _safe_resource_name(
        f"wfb-dev-adopt-{_safe_resource_name(deployment)}", max_length=63
    )


def _adopt_lease_holder(execution_id: str, service: str | None) -> str:
    service_name = _dev_preview_service_label(service)
    execution_prefix = _safe_name(execution_id, max_length=36)
    execution_digest = sha256(execution_id.encode("utf-8")).hexdigest()[:12]
    return f"adopt:{execution_prefix}:{execution_digest}:{service_name}"


def _canonical_adopt_selector(selector: Any) -> dict[str, str]:
    if not isinstance(selector, dict):
        raise ValueError("adopted Service selector must be an object")
    canonical = {
        str(key): str(value)
        for key, value in selector.items()
        if isinstance(key, str)
        and key
        and isinstance(value, str)
        and value
    }
    if not canonical or len(canonical) != len(selector):
        raise ValueError("adopted Service selector must be a non-empty string map")
    return dict(sorted(canonical.items()))


def _adopt_stage_gate_key(selector: dict[str, str]) -> str:
    # The Dapr-generated Services in this stack select `app=<app-id>`, so prefer
    # the same key when the application Service carries it. Other services use
    # their first canonical selector key (for example app.kubernetes.io/name).
    return "app" if "app" in selector else sorted(selector)[0]


def _adopt_stage_gate_value(holder: str) -> str:
    return f"wfb-stage-{sha256(holder.encode('utf-8')).hexdigest()[:12]}"


def _adopt_selector_contract(
    selector: dict[str, str] | None, *, holder: str
) -> tuple[dict[str, str], str, str]:
    active = _canonical_adopt_selector(selector)
    gate_key = _adopt_stage_gate_key(active)
    staged_value = _adopt_stage_gate_value(holder)
    if staged_value == active[gate_key]:
        raise ValueError("staged adoption gate must not match the active selector")
    return active, gate_key, staged_value


def _adopt_lease_body(
    *,
    namespace: str,
    deployment: str,
    execution_id: str,
    service: str | None,
) -> dict[str, Any]:
    deployment_name = _safe_resource_name(deployment)
    service_name = _dev_preview_service_label(service)
    holder = _adopt_lease_holder(execution_id, service_name)
    now = datetime.now(UTC).isoformat(timespec="microseconds").replace("+00:00", "Z")
    return {
        "apiVersion": "coordination.k8s.io/v1",
        "kind": "Lease",
        "metadata": {
            "name": _adopt_lease_name(deployment_name),
            "namespace": namespace,
            "labels": {
                "app": DEV_PREVIEW_ADOPTION_LEASE_LABEL,
                DEV_PREVIEW_ADOPT_DEPLOYMENT_ANNOTATION: deployment_name,
                "dev-preview-service": service_name,
            },
            "annotations": {
                DEV_PREVIEW_ADOPT_DEPLOYMENT_ANNOTATION: deployment_name,
                DEV_PREVIEW_ADOPT_HOLDER_ANNOTATION: holder,
                DEV_PREVIEW_ADOPT_EXECUTION_ANNOTATION: execution_id,
                DEV_PREVIEW_ADOPT_SERVICE_ANNOTATION: service_name,
            },
        },
        "spec": {
            "holderIdentity": holder,
            "leaseDurationSeconds": min(
                3600,
                _env_int(
                    "DEV_PREVIEW_ADOPTION_LEASE_SECONDS",
                    _DEV_PREVIEW_ADOPTION_LEASE_SECONDS,
                    minimum=30,
                ),
            ),
            "acquireTime": now,
            "renewTime": now,
        },
    }


def _adopt_lease_identity(lease: Any) -> tuple[str, str, str, str, str | None]:
    metadata = _adopt_value(lease, "metadata")
    annotations = _adopt_value(metadata, "annotations") or {}
    spec = _adopt_value(lease, "spec")
    return (
        str(_adopt_value(metadata, "name") or ""),
        str(_adopt_value(spec, "holder_identity", "holderIdentity") or ""),
        str(annotations.get(DEV_PREVIEW_ADOPT_DEPLOYMENT_ANNOTATION) or ""),
        str(annotations.get(DEV_PREVIEW_ADOPT_EXECUTION_ANNOTATION) or ""),
        _adopt_value(metadata, "resource_version", "resourceVersion"),
    )


def _acquire_dev_preview_adoption_lease(
    coordination: Any,
    *,
    namespace: str,
    deployment: str,
    execution_id: str,
    service: str | None,
) -> str:
    """Atomically reserve an adopted Deployment for one execution/service."""
    body = _adopt_lease_body(
        namespace=namespace,
        deployment=deployment,
        execution_id=execution_id,
        service=service,
    )
    name = body["metadata"]["name"]
    holder = body["spec"]["holderIdentity"]
    try:
        coordination.create_namespaced_lease(namespace=namespace, body=body)
        return holder
    except Exception as exc:
        if getattr(exc, "status", None) != 409:
            raise HTTPException(
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                detail=f"could not reserve adopted Deployment {deployment}",
            ) from exc
    try:
        existing = coordination.read_namespaced_lease(name=name, namespace=namespace)
    except Exception as exc:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=f"adopted Deployment {deployment} already has an owner",
        ) from exc
    existing_name, existing_holder, existing_deployment, existing_execution, _ = (
        _adopt_lease_identity(existing)
    )
    existing_metadata = _adopt_value(existing, "metadata")
    existing_annotations = _adopt_value(existing_metadata, "annotations") or {}
    existing_labels = _adopt_value(existing_metadata, "labels") or {}
    service_name = _dev_preview_service_label(service)
    if (
        existing_name == name
        and _adopt_value(existing_metadata, "namespace") == namespace
        and existing_holder == holder
        and existing_deployment == _safe_resource_name(deployment)
        and existing_execution == execution_id
        and existing_annotations.get(DEV_PREVIEW_ADOPT_HOLDER_ANNOTATION) == holder
        and existing_annotations.get(DEV_PREVIEW_ADOPT_SERVICE_ANNOTATION)
        == service_name
        and existing_labels.get("app") == DEV_PREVIEW_ADOPTION_LEASE_LABEL
        and existing_labels.get(DEV_PREVIEW_ADOPT_DEPLOYMENT_ANNOTATION)
        == _safe_resource_name(deployment)
        and existing_labels.get("dev-preview-service") == service_name
    ):
        return holder
    raise HTTPException(
        status_code=status.HTTP_409_CONFLICT,
        detail=f"adopted Deployment {deployment} is owned by another dev preview",
    )


def _delete_dev_preview_adoption_lease(
    coordination: Any,
    *,
    namespace: str,
    deployment: str,
    holder: str,
    timeout_s: float = 30.0,
) -> bool:
    """Delete only the exact holder's Lease and observe its absence."""
    name = _adopt_lease_name(deployment)
    try:
        lease = coordination.read_namespaced_lease(name=name, namespace=namespace)
    except Exception as exc:
        if getattr(exc, "status", None) == 404:
            return True
        logger.warning("adopt: failed reading Lease %s for cleanup: %s", name, exc)
        return False
    (
        existing_name,
        existing_holder,
        existing_deployment,
        _execution,
        resource_version,
    ) = _adopt_lease_identity(lease)
    metadata = _adopt_value(lease, "metadata")
    annotations = _adopt_value(metadata, "annotations") or {}
    if (
        existing_name != name
        or _adopt_value(metadata, "namespace") != namespace
        or existing_holder != holder
        or existing_deployment != _safe_resource_name(deployment)
        or annotations.get(DEV_PREVIEW_ADOPT_HOLDER_ANNOTATION) != holder
        or not resource_version
    ):
        logger.warning("adopt: refusing mismatched Lease cleanup for %s", deployment)
        return False
    try:
        coordination.delete_namespaced_lease(
            name=name,
            namespace=namespace,
            body={
                "apiVersion": "v1",
                "kind": "DeleteOptions",
                "preconditions": {"resourceVersion": resource_version},
            },
        )
    except Exception as exc:
        if getattr(exc, "status", None) == 404:
            return True
        logger.warning("adopt: failed deleting Lease %s: %s", name, exc)
        return False
    deadline = time.monotonic() + max(timeout_s, 0)
    while True:
        try:
            observed = coordination.read_namespaced_lease(
                name=name, namespace=namespace
            )
        except Exception as exc:
            if getattr(exc, "status", None) == 404:
                return True
            logger.warning(
                "adopt: failed proving Lease %s absence: %s", name, exc
            )
            return False
        (
            observed_name,
            observed_holder,
            observed_deployment,
            _observed_execution,
            _observed_resource_version,
        ) = _adopt_lease_identity(observed)
        if (
            observed_name != name
            or observed_holder != holder
            or observed_deployment != _safe_resource_name(deployment)
        ):
            logger.warning(
                "adopt: Lease %s changed identity before deletion was observed", name
            )
            return False
        if time.monotonic() >= deadline:
            logger.warning("adopt: Lease %s deletion was not observed", name)
            return False
        time.sleep(0.1)


def _canonical_absolute_posix_path(value: str, *, field: str) -> str:
    """Return one absolute, non-root POSIX path or reject the attachment."""
    if not isinstance(value, str) or not value.startswith("/") or "\x00" in value:
        raise ValueError(f"{field} must be an absolute POSIX path")
    normalized = posixpath.normpath(f"/{value.lstrip('/')}")
    if normalized == "/":
        raise ValueError(f"{field} must not be the filesystem root")
    return normalized


def _adopt_read_identity(
    apps: Any, *, namespace: str, name: str
) -> dict[str, Any] | None:
    """Read the prod Deployment identity that an adopted dev pod must preserve.

    Inline env and read-only ConfigMap mounts are copied from the selected app
    container. Secret, projected, PVC, hostPath, and writable mounts are never
    inherited through this adapter.
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
    config_map_mounts: list[dict[str, Any]] = []
    if tmpl_spec and tmpl_spec.containers:
        main = next(
            (c for c in tmpl_spec.containers if c.name == name),
            tmpl_spec.containers[0],
        )
        if main.env:
            try:
                container_env = _filter_adopted_container_env(
                    apps.api_client.sanitize_for_serialization(main.env)
                )
            except Exception as exc:  # noqa: BLE001 — best-effort; fall back to envFrom only
                logger.warning("adopt: failed to read %s container env: %s", name, exc)
                container_env = None
        try:
            serialized_mounts = apps.api_client.sanitize_for_serialization(
                main.volume_mounts or []
            )
            serialized_volumes = apps.api_client.sanitize_for_serialization(
                tmpl_spec.volumes or []
            )
            volumes_by_name = {
                volume.get("name"): volume
                for volume in serialized_volumes
                if isinstance(volume, dict) and volume.get("name")
            }
            for mount in serialized_mounts:
                if not isinstance(mount, dict):
                    continue
                volume = volumes_by_name.get(mount.get("name"))
                raw_mount_path = mount.get("mountPath")
                try:
                    mount_path = _canonical_absolute_posix_path(
                        raw_mount_path, field="adopted ConfigMap mountPath"
                    )
                except ValueError:
                    continue
                if (
                    not isinstance(volume, dict)
                    or not isinstance(volume.get("configMap"), dict)
                ):
                    continue
                inherited_mount = {
                    "name": mount["name"],
                    "mountPath": mount_path,
                    "readOnly": True,
                }
                for key in ("subPath", "subPathExpr"):
                    if isinstance(mount.get(key), str) and mount[key]:
                        inherited_mount[key] = mount[key]
                config_map_mounts.append(
                    {
                        "volume": {
                            "name": volume["name"],
                            "configMap": volume["configMap"],
                        },
                        "mount": inherited_mount,
                    }
                )
        except Exception as exc:  # noqa: BLE001 - parity enrichment is best-effort
            logger.warning(
                "adopt: failed to read %s ConfigMap mounts: %s", name, exc
            )
            config_map_mounts = []
    return {
        "serviceAccountName": (tmpl_spec.service_account_name if tmpl_spec else None),
        "daprAppId": pod_annotations.get("dapr.io/app-id"),
        "daprConfig": pod_annotations.get("dapr.io/config"),
        "daprAppPort": pod_annotations.get("dapr.io/app-port"),
        "containerEnv": container_env,
        "configMapMounts": config_map_mounts,
    }


def _adopt_scale_deployment_down(
    apps: Any, *, namespace: str, name: str, timeout_s: float = 30.0
) -> None:
    """Scale the adopted Deployment to 0 (freeing the Service endpoints), stashing
    its prior replica count in an annotation so teardown can restore it. Idempotent."""
    try:
        dep = apps.read_namespaced_deployment(name=name, namespace=namespace)
    except Exception as exc:
        if getattr(exc, "status", None) == 404:
            raise RuntimeError(f"adopted deployment {name} was not found") from exc
        raise
    dep_annotations = (dep.metadata.annotations or {}) if dep.metadata else {}
    current = dep.spec.replicas if dep.spec and dep.spec.replicas is not None else 1
    stashed = dep_annotations.get(DEV_PREVIEW_ORIGINAL_REPLICAS_ANNOTATION)
    original = (
        stashed if stashed is not None else (str(current) if current > 0 else "1")
    )
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
    deadline = time.monotonic() + max(timeout_s, 0)
    while True:
        observed = apps.read_namespaced_deployment(name=name, namespace=namespace)
        observed_annotations = (
            observed.metadata.annotations or {}
        ) if observed.metadata else {}
        observed_replicas = (
            observed.spec.replicas
            if observed.spec and observed.spec.replicas is not None
            else 1
        )
        observed_status = getattr(observed, "status", None)
        available_replicas = getattr(observed_status, "available_replicas", None)
        ready_replicas = getattr(observed_status, "ready_replicas", None)
        if (
            observed_replicas == 0
            and observed_annotations.get(DEV_PREVIEW_ORIGINAL_REPLICAS_ANNOTATION)
            == original
            and (available_replicas is None or available_replicas == 0)
            and (ready_replicas is None or ready_replicas == 0)
        ):
            break
        if time.monotonic() >= deadline:
            raise RuntimeError(f"deployment {name} scale-down was not observed")
        time.sleep(0.1)
    logger.info("adopt: scaled deployment %s to 0 (original=%s)", name, original)


def _dev_pod_has_daprd(pod: Any) -> bool:
    """True only if the injected daprd container is present and Ready.

    daprd can be a NATIVE sidecar (an init container with restartPolicy: Always) OR a
    classic sidecar (a regular container). The injector label alone is not readiness
    evidence; auditing only `.spec.containers` misses the native-sidecar case."""
    status = getattr(pod, "status", None)
    for statuses in (
        getattr(status, "init_container_statuses", None),
        getattr(status, "container_statuses", None),
    ):
        if any(
            getattr(cs, "name", "") == "daprd"
            and getattr(cs, "ready", False) is True
            for cs in (statuses or [])
        ):
            return True
    return False


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
    sandbox_name: str | None = None,
    holder: str | None = None,
    service: str | None = None,
    needs_dapr: bool = False,
) -> None:
    """Background target: wait for the dev pod to be Ready, THEN scale the prod
    Deployment to 0. Deferring is REQUIRED when the dev pod adopts a Deployment on
    the synchronous response path (the BFF or function-router): scaling it to 0
    during provisioning would kill the request carrying the result. By the time this
    runs, the response has left the still-up prod pod. Only scales once the dev pod
    is Ready, so there is NO downtime; if the dev pod never becomes Ready, the prod
    Deployment is LEFT UP (failsafe — the preview keeps serving)."""
    import time

    try:
        apps = _load_k8s_apps_client()
        _, core = _load_k8s_clients()
        custom = _load_k8s_custom_objects_client() if sandbox_name and holder else None
        coordination = (
            _load_k8s_coordination_client() if sandbox_name and holder else None
        )
    except Exception as exc:
        logger.warning("adopt: deferred scale-down could not load clients: %s", exc)
        return
    # Scope to (execution, service): with N dev pods sharing one execution, an
    # execution-id-only selector would scale service B's prod Deployment to 0 the
    # moment service A's dev pod became Ready. `dev-preview-service` is stamped on
    # every dev pod (build_dev_preview_sandbox_manifest) and never appears in a
    # Service selector, so it survives the adopt-selector merge.
    selector = (
        f"{DEV_PREVIEW_MANAGED_LABEL}={DEV_PREVIEW_MANAGED_VALUE},"
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
                # pod is Ready) fully propagates orchestrator<-router<-BFF BEFORE we
                # scale a response-path Deployment to 0.
                time.sleep(15)
                with _dev_preview_adoption_transition_lock(namespace, deployment):
                    if (
                        sandbox_name
                        and holder
                        and custom is not None
                        and coordination is not None
                        and not _dev_preview_adoption_is_current(
                            custom,
                            coordination,
                            namespace=namespace,
                            sandbox_name=sandbox_name,
                            deployment=deployment,
                            holder=holder,
                        )
                    ):
                        logger.info(
                            "adopt: cutover for %s was cancelled before scale-down",
                            sandbox_name,
                        )
                        return
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


def _adopt_restore_deployment(
    apps: Any, *, namespace: str, name: str, timeout_s: float = 30.0
) -> None:
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
    original = annotations.get(DEV_PREVIEW_ORIGINAL_REPLICAS_ANNOTATION)
    if original is None:
        logger.info(
            "adopt: deployment %s was never scaled down; leaving replicas unchanged",
            name,
        )
        return
    try:
        replicas = int(original)
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
    target = max(replicas, 1)
    deadline = time.monotonic() + max(timeout_s, 0)
    while True:
        observed = apps.read_namespaced_deployment(name=name, namespace=namespace)
        observed_annotations = (
            observed.metadata.annotations or {}
        ) if observed.metadata else {}
        observed_replicas = (
            observed.spec.replicas
            if observed.spec and observed.spec.replicas is not None
            else 1
        )
        observed_status = getattr(observed, "status", None)
        available_replicas = getattr(observed_status, "available_replicas", None)
        if (
            observed_replicas == target
            and DEV_PREVIEW_ORIGINAL_REPLICAS_ANNOTATION not in observed_annotations
            and (available_replicas is None or available_replicas >= target)
        ):
            break
        if time.monotonic() >= deadline:
            raise RuntimeError(f"deployment {name} restoration was not observed")
        time.sleep(0.1)
    logger.info("adopt: restored deployment %s to %s replicas", name, target)


def _dev_preview_adoption_is_current(
    custom: Any,
    coordination: Any,
    *,
    namespace: str,
    sandbox_name: str,
    deployment: str,
    holder: str,
) -> bool:
    """Re-read both ownership objects immediately before a deferred cutover."""
    try:
        if (
            _dev_preview_cr_adoption_holder(custom, namespace, sandbox_name)
            != holder
        ):
            return False
        lease = coordination.read_namespaced_lease(
            name=_adopt_lease_name(deployment), namespace=namespace
        )
    except Exception:
        return False
    (
        lease_name,
        lease_holder,
        lease_deployment,
        _lease_execution,
        _resource_version,
    ) = _adopt_lease_identity(lease)
    return (
        lease_name == _adopt_lease_name(deployment)
        and lease_holder == holder
        and lease_deployment == _safe_resource_name(deployment)
    )


def _adopt_cleanup_stale_leases(
    coordination: Any,
    *,
    custom: Any,
    namespace: str,
    claimed_holders: dict[str, set[str]],
    blocked_releases: set[str],
    now: datetime | None = None,
) -> list[str]:
    try:
        leases = coordination.list_namespaced_lease(
            namespace=namespace,
            label_selector=f"app={DEV_PREVIEW_ADOPTION_LEASE_LABEL}",
        )
    except Exception as exc:
        logger.warning("adopt: stale Lease sweep skipped (list failed): %s", exc)
        return []
    released: list[str] = []
    current_time = now or datetime.now(UTC)
    for lease in _adopt_value(leases, "items") or []:
        metadata = _adopt_value(lease, "metadata")
        annotations = _adopt_value(metadata, "annotations") or {}
        labels = _adopt_value(metadata, "labels") or {}
        spec = _adopt_value(lease, "spec")
        name, holder, deployment, execution_id, _resource_version = (
            _adopt_lease_identity(lease)
        )
        service = str(annotations.get(DEV_PREVIEW_ADOPT_SERVICE_ANNOTATION) or "")
        annotated_holder = str(
            annotations.get(DEV_PREVIEW_ADOPT_HOLDER_ANNOTATION) or ""
        )
        duration = int(
            _adopt_value(spec, "lease_duration_seconds", "leaseDurationSeconds")
            or _DEV_PREVIEW_ADOPTION_LEASE_SECONDS
        )
        renewed = _lease_timestamp(
            _adopt_value(spec, "renew_time", "renewTime")
            or _adopt_value(spec, "acquire_time", "acquireTime")
        )
        if (
            not name
            or name != _adopt_lease_name(deployment)
            or _adopt_value(metadata, "namespace") != namespace
            or not holder
            or holder != annotated_holder
            or not execution_id
            or not service
            or holder != _adopt_lease_holder(execution_id, service)
            or labels.get("app") != DEV_PREVIEW_ADOPTION_LEASE_LABEL
            or labels.get(DEV_PREVIEW_ADOPT_DEPLOYMENT_ANNOTATION) != deployment
            or labels.get("dev-preview-service") != service
            or renewed is None
            or duration < 30
        ):
            logger.warning("adopt: refusing malformed stale Lease cleanup for %s", name)
            continue
        if deployment in claimed_holders:
            continue
        if deployment in blocked_releases:
            continue
        if current_time < renewed + timedelta(seconds=duration):
            continue
        with _dev_preview_adoption_transition_lock(namespace, deployment):
            try:
                current_crs = custom.list_namespaced_custom_object(
                    group="agents.x-k8s.io",
                    version="v1alpha1",
                    namespace=namespace,
                    plural="sandboxes",
                )
            except Exception as exc:
                logger.warning(
                    "adopt: stale Lease cleanup could not recheck claims for %s: %s",
                    deployment,
                    exc,
                )
                continue
            if any(
                ((item.get("metadata") or {}).get("annotations") or {}).get(
                    DEV_PREVIEW_ADOPT_DEPLOYMENT_ANNOTATION
                )
                == deployment
                for item in (current_crs.get("items") or [])
                if isinstance(item, dict)
            ):
                continue
            if _delete_dev_preview_adoption_lease(
                coordination,
                namespace=namespace,
                deployment=deployment,
                holder=holder,
            ):
                released.append(name)
    return released


def _adopt_restore_orphans(
    apps: Any,
    custom: Any,
    *,
    namespace: str,
    coordination: Any | None = None,
) -> dict[str, Any]:
    """B5 restore-all sweep: restore every Deployment still carrying the
    original-replicas annotation AT 0 REPLICAS that no live Sandbox CR claims
    (via its wfb-dev-preview/adopt-deployment annotation). Covers orphans the
    per-Sandbox teardown restore can't see — e.g. SEA restarted between the
    deferred scale-down and CR creation, or a CR reaped out-of-band.

    Deliberately conservative:
      - a Deployment claimed by ANY live Sandbox CR is left alone (another
        session's adopt is in flight);
      - a Deployment with the annotation but replicas > 0 is left alone
        (restoring would rewrite live scale from a stale stash);
      - if the Sandbox CR list cannot be read, NOTHING is restored (better to
        leave an orphan at 0 than to break an active adopt).
    """
    try:
        crs = custom.list_namespaced_custom_object(
            group="agents.x-k8s.io",
            version="v1alpha1",
            namespace=namespace,
            plural="sandboxes",
        )
    except Exception as exc:
        logger.warning("adopt: orphan sweep skipped (sandbox list failed): %s", exc)
        return {"restored": [], "skipped": "sandbox-list-failed"}
    claimed: set[str] = set()
    claimed_holders: dict[str, set[str]] = {}
    for item in (crs.get("items") or []) if isinstance(crs, dict) else []:
        metadata = (item.get("metadata") or {}) if isinstance(item, dict) else {}
        annotations = metadata.get("annotations") or {}
        dep_name = annotations.get(DEV_PREVIEW_ADOPT_DEPLOYMENT_ANNOTATION)
        if dep_name:
            claimed.add(dep_name)
            claimed_holders.setdefault(dep_name, set())
            holder = annotations.get(
                DEV_PREVIEW_ADOPT_HOLDER_ANNOTATION
            ) or annotations.get(DEV_PREVIEW_ADOPT_CUTOVER_CANCELLED_ANNOTATION)
            if isinstance(holder, str) and holder:
                claimed_holders[dep_name].add(holder)
    try:
        deployments = apps.list_namespaced_deployment(namespace=namespace)
    except Exception as exc:
        logger.warning("adopt: orphan sweep skipped (deployment list failed): %s", exc)
        return {"restored": [], "skipped": "deployment-list-failed"}
    restored: list[str] = []
    blocked_releases: set[str] = set()
    for dep in getattr(deployments, "items", None) or []:
        metadata = getattr(dep, "metadata", None)
        name = getattr(metadata, "name", None)
        annotations = (getattr(metadata, "annotations", None) or {}) if metadata else {}
        if not name or DEV_PREVIEW_ORIGINAL_REPLICAS_ANNOTATION not in annotations:
            continue
        if name in claimed:
            continue
        replicas = getattr(getattr(dep, "spec", None), "replicas", None)
        if replicas not in (0, None):
            continue
        try:
            with _dev_preview_adoption_transition_lock(namespace, name):
                current_crs = custom.list_namespaced_custom_object(
                    group="agents.x-k8s.io",
                    version="v1alpha1",
                    namespace=namespace,
                    plural="sandboxes",
                )
                if any(
                    ((item.get("metadata") or {}).get("annotations") or {}).get(
                        DEV_PREVIEW_ADOPT_DEPLOYMENT_ANNOTATION
                    )
                    == name
                    for item in (current_crs.get("items") or [])
                    if isinstance(item, dict)
                ):
                    continue
                current_dep = apps.read_namespaced_deployment(
                    name=name, namespace=namespace
                )
                current_metadata = getattr(current_dep, "metadata", None)
                current_annotations = (
                    getattr(current_metadata, "annotations", None) or {}
                )
                current_replicas = getattr(
                    getattr(current_dep, "spec", None), "replicas", None
                )
                if (
                    DEV_PREVIEW_ORIGINAL_REPLICAS_ANNOTATION
                    not in current_annotations
                    or current_replicas not in (0, None)
                ):
                    continue
                _adopt_restore_deployment(apps, namespace=namespace, name=name)
                restored.append(name)
        except Exception as exc:
            blocked_releases.add(name)
            logger.warning("adopt: orphan restore failed for %s: %s", name, exc)
    if restored:
        logger.info("adopt: orphan sweep restored %s", restored)
    released_leases = (
        _adopt_cleanup_stale_leases(
            coordination,
            custom=custom,
            namespace=namespace,
            claimed_holders=claimed_holders,
            blocked_releases=blocked_releases,
        )
        if coordination is not None
        else []
    )
    return {"restored": restored, "releasedLeases": released_leases}


def _require_internal(request: Request) -> None:
    expected = (os.environ.get("SANDBOX_EXECUTION_API_TOKEN") or "").strip()
    if not expected:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="sandbox execution API token is not configured",
        )
    token = request.headers.get("authorization", "").removeprefix("Bearer ").strip()
    if token != expected:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED, detail="invalid token"
        )


def _agent_workflow_host_namespace() -> str:
    return os.environ.get("AGENT_WORKFLOW_HOST_NAMESPACE") or os.environ.get(
        "WORKFLOW_BUILDER_NAMESPACE", "workflow-builder"
    )


def _vcluster_preview_control_namespace() -> str:
    """Namespace for bounded preview runners and their coordination objects.

    The workload namespace remains ``workflow-builder``. Keeping this separately
    configurable lets dev run the broker-owned control plane in
    ``preview-control-system`` without changing persistent agent-host behavior.
    """
    return (
        os.environ.get("VCLUSTER_PREVIEW_CONTROL_NAMESPACE") or "preview-control-system"
    ).strip() or "preview-control-system"


def _image_pull_policy_for_agent_host(image: str) -> str:
    """Pull mutable agent-host images every time, keep immutable refs cached."""
    ref = (image or "").strip()
    if "@sha256:" in ref:
        return "IfNotPresent"
    last_segment = ref.rsplit("/", 1)[-1]
    if ":" not in last_segment or last_segment.rsplit(":", 1)[-1] == "latest":
        return "Always"
    return "IfNotPresent"


def _restricted_container_security_context() -> dict[str, Any]:
    return {
        "allowPrivilegeEscalation": False,
        "capabilities": {"drop": ["ALL"]},
    }


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
        "securityContext": _restricted_container_security_context(),
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


def _redacted_dev_preview_request_dump(request: DevPreviewRequest) -> dict[str, Any]:
    """Mask credentials and caller-controlled environment values in telemetry."""

    dump = request.model_dump()
    for field in ("syncToken", "syncAgentToken"):
        if dump.get(field):
            dump[field] = "***"
    for field in ("env", "serviceSecretEnv"):
        if isinstance(dump.get(field), dict):
            dump[field] = {key: "***" for key in dump[field]}
    if isinstance(dump.get("adoptInheritedEnv"), list):
        dump["adoptInheritedEnv"] = "***"
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
    string_data = {key: value for key, value in request.sessionSecretEnv.items() if key}
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


def _agent_host_sandbox_uid(
    custom: Any,
    *,
    namespace: str,
    sandbox_name: str,
    generation: str,
    sandbox: dict[str, Any] | None,
) -> str | None:
    """Return the UID only for the exact Sandbox generation being bound.

    A create response is preferred, but an adoption path fetches the exact CR.
    Pre-upgrade, non-provisional hosts are accepted when their exact name and
    agent-app-id label match; a provisional or explicitly generated host must
    carry the immutable generation annotation.
    """

    def _uid_if_exact(candidate: Any) -> str | None:
        if not isinstance(candidate, dict):
            return None
        metadata = candidate.get("metadata") or {}
        if metadata.get("name") != sandbox_name:
            return None
        labels = metadata.get("labels") or {}
        if labels.get("agent-app-id") != _safe_name(generation, max_length=63):
            return None
        annotations = metadata.get("annotations") or {}
        observed_generation = annotations.get(AGENT_HOST_GENERATION_ANNOTATION)
        lifecycle = annotations.get(AGENT_HOST_LIFECYCLE_ANNOTATION)
        if observed_generation != generation:
            if observed_generation is not None or lifecycle is not None:
                return None
        uid = metadata.get("uid")
        return uid if isinstance(uid, str) and uid else None

    uid = _uid_if_exact(sandbox)
    if uid:
        return uid
    try:
        existing = custom.get_namespaced_custom_object(
            group="agents.x-k8s.io",
            version="v1alpha1",
            namespace=namespace,
            plural="sandboxes",
            name=sandbox_name,
        )
    except Exception as exc:
        logger.warning(
            "agent-host sandbox %s read for ownerRef failed: %s",
            sandbox_name,
            exc,
        )
        return None
    uid = _uid_if_exact(existing)
    if not uid:
        logger.warning(
            "agent-host sandbox %s identity mismatch for generation %s; ownerRef skipped",
            sandbox_name,
            generation,
        )
    return uid


def _bind_agent_host_cred_secret_owner(
    core: Any,
    custom: Any,
    *,
    namespace: str,
    secret_name: str,
    sandbox_name: str,
    generation: str,
    sandbox: dict[str, Any] | None,
) -> None:
    """Point the credential Secret's ownerReferences at the Sandbox CR.

    The Secret is then garbage-collected with the sandbox. `sandbox` is the
    create response when available; on the adopt-existing-CR path it is None
    and the CR is fetched for its uid. Best-effort: a failed bind leaves an
    unowned Secret that the next session for the same app-id overwrites.
    """
    uid = _agent_host_sandbox_uid(
        custom,
        namespace=namespace,
        sandbox_name=sandbox_name,
        generation=generation,
        sandbox=sandbox,
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


@dataclass(frozen=True)
class PreviewStorageContext:
    scope_id: str
    storage_class: str
    local_storage_class: str


_PREVIEW_IDENTITY_ENV = (
    "PREVIEW_ENVIRONMENT_NAME",
    "PREVIEW_ENVIRONMENT_REQUEST_ID",
    "PREVIEW_ENVIRONMENT_PLATFORM_REVISION",
    "PREVIEW_ENVIRONMENT_SOURCE_REVISION",
    "PREVIEW_ENVIRONMENT_CATALOG_DIGEST",
    "PREVIEW_ENVIRONMENT_SERVICES_JSON",
)


def _preview_storage_context() -> PreviewStorageContext | None:
    """Read the host-issued, non-secret preview storage binding.

    A partial preview identity fails closed. The host runner derives ``scope_id``
    from the tuple-bound storage capability and creates the matching StorageClass;
    virtual workloads receive neither that capability nor the JuiceFS Secret.
    """
    storage_markers = _PREVIEW_IDENTITY_ENV + (
        "PREVIEW_STORAGE_SCOPE_ID",
        "PREVIEW_STORAGE_CLASS",
    )
    values = {name: (os.environ.get(name) or "").strip() for name in storage_markers}
    if not any(values.values()):
        return None
    missing = [name for name in storage_markers if not values[name]]
    if missing:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail=f"preview storage identity is incomplete: {', '.join(missing)}",
        )
    if not re.fullmatch(
        r"[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?", values["PREVIEW_ENVIRONMENT_NAME"]
    ):
        raise HTTPException(status_code=503, detail="preview storage name is invalid")
    if not re.fullmatch(
        r"[A-Za-z0-9][A-Za-z0-9._:-]{0,255}", values["PREVIEW_ENVIRONMENT_REQUEST_ID"]
    ):
        raise HTTPException(
            status_code=503, detail="preview storage request id is invalid"
        )
    for key in (
        "PREVIEW_ENVIRONMENT_PLATFORM_REVISION",
        "PREVIEW_ENVIRONMENT_SOURCE_REVISION",
    ):
        if not re.fullmatch(r"[0-9a-f]{40}", values[key]):
            raise HTTPException(status_code=503, detail=f"{key} is invalid")
    if not re.fullmatch(
        r"sha256:[0-9a-f]{64}", values["PREVIEW_ENVIRONMENT_CATALOG_DIGEST"]
    ):
        raise HTTPException(
            status_code=503, detail="preview storage catalog digest is invalid"
        )
    try:
        services = json.loads(values["PREVIEW_ENVIRONMENT_SERVICES_JSON"])
    except json.JSONDecodeError as exc:
        raise HTTPException(
            status_code=503, detail="preview storage services are invalid"
        ) from exc
    if (
        not isinstance(services, list)
        or len(services) > 16
        or services != sorted(set(services))
        or any(
            not isinstance(service, str)
            or not re.fullmatch(r"[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?", service)
            for service in services
        )
    ):
        raise HTTPException(
            status_code=503, detail="preview storage services are invalid"
        )
    scope_id = values["PREVIEW_STORAGE_SCOPE_ID"]
    if not re.fullmatch(r"[0-9a-f]{32}", scope_id):
        raise HTTPException(
            status_code=503, detail="preview storage scope id is invalid"
        )
    expected_class = f"preview-jfs-{scope_id}"
    if values["PREVIEW_STORAGE_CLASS"] != expected_class:
        raise HTTPException(
            status_code=503,
            detail="preview storage class does not match the issued scope id",
        )
    return PreviewStorageContext(
        scope_id=scope_id,
        storage_class=expected_class,
        local_storage_class=f"preview-local-{scope_id}",
    )


def _preview_storage_logical_key(value: str | None, *, field: str) -> str:
    key = (value or "").strip()
    if (
        not key
        or len(key) > 256
        or key in {".", ".."}
        or "/" in key
        or "\\" in key
        or key.lower().startswith("previews")
        or not re.fullmatch(r"[A-Za-z0-9_-][A-Za-z0-9_.:@-]{0,255}", key)
    ):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"{field} must be an unprefixed logical key without path syntax",
        )
    return key


def _preview_storage_pvc_name(kind: str, logical_key: str) -> str:
    prefix = {"transcript": "ptx", "workspace": "pws"}.get(kind)
    if prefix is None:
        raise ValueError(f"unsupported preview storage kind {kind}")
    return f"{prefix}-{sha256(logical_key.encode()).hexdigest()[:32]}"


def _preview_dynamic_pvc_body(
    *,
    name: str,
    namespace: str,
    context: PreviewStorageContext,
    kind: str,
    capacity: str,
) -> dict[str, Any]:
    return {
        "apiVersion": "v1",
        "kind": "PersistentVolumeClaim",
        "metadata": {
            "name": name,
            "namespace": namespace,
            "labels": {
                "preview.stacks.io/storage-scope": context.scope_id,
                "preview.stacks.io/storage-kind": kind,
            },
        },
        "spec": {
            "accessModes": ["ReadWriteMany"],
            "storageClassName": context.storage_class,
            "resources": {"requests": {"storage": capacity}},
        },
    }


def _ensure_preview_dynamic_pvc(
    core: Any,
    *,
    namespace: str,
    context: PreviewStorageContext,
    kind: str,
    logical_key: str,
    capacity: str,
    create: bool = True,
) -> str:
    name = _preview_storage_pvc_name(kind, logical_key)
    body = _preview_dynamic_pvc_body(
        name=name,
        namespace=namespace,
        context=context,
        kind=kind,
        capacity=capacity,
    )
    if create:
        try:
            core.create_namespaced_persistent_volume_claim(
                namespace=namespace, body=body
            )
            return name
        except Exception as exc:
            if getattr(exc, "status", None) != 409:
                raise
    try:
        existing = core.read_namespaced_persistent_volume_claim(
            name=name, namespace=namespace
        )
    except Exception as exc:
        if getattr(exc, "status", None) == 404:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail=f"preview {kind} source does not exist",
            ) from exc
        raise
    spec = getattr(existing, "spec", None)
    storage_class = (
        getattr(spec, "storage_class_name", None)
        or getattr(spec, "storageClassName", None)
        or (spec.get("storageClassName") if isinstance(spec, dict) else None)
    )
    metadata = getattr(existing, "metadata", None)
    labels = getattr(metadata, "labels", None) or (
        metadata.get("labels", {}) if isinstance(metadata, dict) else {}
    )
    if (
        storage_class != context.storage_class
        or labels.get("preview.stacks.io/storage-scope") != context.scope_id
        or labels.get("preview.stacks.io/storage-kind") != kind
    ):
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="preview storage PVC identity conflict",
        )
    return name


def _cli_transcript_conversation_key(request: AgentWorkflowHostRequest) -> str:
    """Subtree key that ties a pod to its Postgres-backed transcript.

    A resume passes the original session id so the new pod re-mounts the same
    subtree; a fresh session keys on its own id.
    """
    return (request.resumeFromSessionId or request.sessionId or "").strip()


def _cli_transcript_resource_name(agent_app_id: str) -> str:
    # `cli-tx-` prefix guarantees the name never matches the driver's
    # `pvc-<uuid>` dynamic-PV regex, so DeleteVolume stays a data-safe no-op.
    # agentAppId is the immutable provisioning generation, keeping a late
    # request from binding or mutating a newer generation's Kubernetes object.
    return _safe_resource_name(f"cli-tx-{agent_app_id}", max_length=63)


def _cli_transcript_claim_name(
    request: AgentWorkflowHostRequest,
    preview_storage: PreviewStorageContext | None,
) -> str:
    if preview_storage is not None:
        logical_key = _preview_storage_logical_key(
            _cli_transcript_conversation_key(request), field="conversation key"
        )
        return _preview_storage_pvc_name("transcript", logical_key)
    return _cli_transcript_resource_name(request.agentAppId)


def _ensure_cli_transcript_volume(
    core: Any,
    request: AgentWorkflowHostRequest,
    class_config: ExecutionClassConfig,
    *,
    namespace: str,
) -> str | None:
    """Provision the per-generation static PV + PVC for the durable transcript.

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
    preview_storage = _preview_storage_context()
    if preview_storage is not None:
        logical_key = _preview_storage_logical_key(
            conversation_key, field="conversation key"
        )
        return _ensure_preview_dynamic_pvc(
            core,
            namespace=namespace,
            context=preview_storage,
            kind="transcript",
            logical_key=logical_key,
            capacity=class_config.transcriptStoreCapacity,
        )
    # PV/PVC are named per provisioning generation while the CSI subPath is the
    # conversation key, so a resume gets a fresh PV bound to the SAME data.
    name = _cli_transcript_resource_name(request.agentAppId)
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
                core.patch_persistent_volume(
                    name=name, body={"spec": {"claimRef": None}}
                )
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
    generation: str,
    sandbox: dict[str, Any] | None,
) -> None:
    """ownerRef the transcript PVC at the Sandbox CR so it GCs with the pod.

    The PVC's `pvc-protection` finalizer holds it until the pod exits; reclaim
    `Delete` then removes the (static, data-safe) PV. Best-effort.
    """
    if _preview_storage_context() is not None:
        # Dynamic preview PVCs persist for resume within the environment and are
        # reclaimed with the host-enforced per-preview scope on teardown.
        return
    uid = _agent_host_sandbox_uid(
        custom,
        namespace=namespace,
        sandbox_name=sandbox_name,
        generation=generation,
        sandbox=sandbox,
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


def _pydantic_scratch_enabled(image: str) -> bool:
    """Per-sandbox durable scratch for the pod-local pydantic-ai runtime.

    When on, the pod's /sandbox workspace rides a small per-sandbox RWO PVC
    instead of an emptyDir, so an evicted/rescheduled pod resumes with its
    files (StatefulSet-like volume identity — the volumeClaimTemplates
    pattern from upstream agent-sandbox docs, done via the platform's
    direct-PVC+ownerRef lane; see docs/agent-sandbox-v0.5.0-upgrade-evaluation.md §6).
    The PVC is ownerRef'd to the Sandbox CR so it GCs with the session.
    """
    if "pydantic-ai-agent-py" not in (image or ""):
        return False
    return os.environ.get("SANDBOX_PYDANTIC_SCRATCH_ENABLED", "true").lower() not in {
        "0",
        "false",
        "no",
    }


def _pydantic_scratch_claim_name(request: AgentWorkflowHostRequest) -> str:
    return _safe_resource_name(f"pyd-scratch-{request.agentAppId}", max_length=63)


def _ensure_pydantic_scratch_pvc(
    core: Any,
    request: AgentWorkflowHostRequest,
    class_config: ExecutionClassConfig,
    *,
    namespace: str,
) -> str | None:
    image = request.agentImage or class_config.agentHostImage
    if not _pydantic_scratch_enabled(image):
        return None
    name = _pydantic_scratch_claim_name(request)
    spec: dict[str, Any] = {
        "accessModes": ["ReadWriteOnce"],
        "resources": {
            "requests": {
                "storage": os.environ.get("SANDBOX_PYDANTIC_SCRATCH_SIZE", "2Gi")
            }
        },
    }
    configured_storage_class = os.environ.get(
        "SANDBOX_PYDANTIC_SCRATCH_STORAGE_CLASS", ""
    ).strip()
    preview_storage = _preview_storage_context()
    if preview_storage is not None:
        if (
            configured_storage_class
            and configured_storage_class != preview_storage.local_storage_class
        ):
            raise HTTPException(
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                detail="Pydantic scratch storage class conflicts with preview storage identity",
            )
        storage_class = preview_storage.local_storage_class
    else:
        storage_class = configured_storage_class
    if storage_class:
        spec["storageClassName"] = storage_class
    body = {
        "apiVersion": "v1",
        "kind": "PersistentVolumeClaim",
        "metadata": {
            "name": name,
            "namespace": namespace,
            "labels": {
                "app": "pydantic-ai-scratch",
                "agent-app-id": _safe_name(request.agentAppId, max_length=63),
                "workflow-builder.cnoe.io/session-id": _safe_name(
                    request.sessionId, max_length=63
                ),
            },
        },
        "spec": spec,
    }
    try:
        core.create_namespaced_persistent_volume_claim(namespace=namespace, body=body)
    except Exception as exc:
        if getattr(exc, "status", None) != 409:
            raise
    return name


def _cli_shared_workspace_enabled(class_config: ExecutionClassConfig) -> bool:
    return bool(class_config.sharedWorkspaceStoreCsiDriver)


def _cli_shared_workspace_resource_name(agent_app_id: str) -> str:
    # `cli-ws-` prefix keeps the name off the driver's `pvc-<uuid>` dynamic-PV
    # regex, so DeleteVolume stays a data-safe no-op (same as cli-tx-).
    return _safe_resource_name(f"cli-ws-{agent_app_id}", max_length=63)


def _cli_shared_workspace_claim_name(
    request: AgentWorkflowHostRequest,
    preview_storage: PreviewStorageContext | None,
) -> str:
    if preview_storage is not None:
        logical_key = _preview_storage_logical_key(
            request.sharedWorkspaceKey, field="shared workspace key"
        )
        return _preview_storage_pvc_name("workspace", logical_key)
    return _cli_shared_workspace_resource_name(request.agentAppId)


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
    sees the SAME files. PV/PVC are named per generation (unique per pod) and
    ownerRef'd to the pod's Sandbox; the data persists across pod GC via
    Retain + the shared subPath in Postgres. Idempotent (409 = already there).
    """
    if not _cli_shared_workspace_enabled(class_config):
        return None
    shared_key = (request.sharedWorkspaceKey or "").strip()
    if not shared_key:
        return None
    preview_storage = _preview_storage_context()
    if preview_storage is not None:
        logical_key = _preview_storage_logical_key(
            shared_key, field="shared workspace key"
        )
        return _ensure_preview_dynamic_pvc(
            core,
            namespace=namespace,
            context=preview_storage,
            kind="workspace",
            logical_key=logical_key,
            capacity=class_config.sharedWorkspaceStoreCapacity,
        )
    name = _cli_shared_workspace_resource_name(request.agentAppId)
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
                core.patch_persistent_volume(
                    name=name, body={"spec": {"claimRef": None}}
                )
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
        "done; "
        # `mkdir -p` makes dirs root-owned 0755 and `juicefs clone` doesn't restore the
        # source's mode, so the cloned workspace is read-only to the NON-root sandbox pods
        # (a fresh workspace is 0777) → EACCES on any write (`mkdir /sandbox/work/vid`,
        # screenshot/verdict files). Make the cloned tree world-writable (cheap now that
        # node_modules is excluded) so any runtime uid can write, like a fresh workspace.
        '[ "$rc" = 0 ] && chmod -R a+rwX "$D" 2>/dev/null; '
        'if [ "$rc" = 0 ] && [ -n "$(r "$D")" ]; then echo seeded; else echo clone-failed; exit 1; fi'
    )


# Node-boundary workspace snapshots (durability phase 3). As each top-level node of a
# resumable run completes, its `/sandbox/work` is CoW-cloned into `.snapshots/<key>/<nodeId>`
# so a later fork-from-node-N can seed from the workspace as it was AT node N (consistent)
# instead of the run's END state. Snapshots live at the JuiceFS ROOT next to the per-run
# subPaths, so one root mount reaches both source and snapshot (same as the seed clone).
_SNAPSHOTS_ROOT_DIR = ".snapshots"
_SNAPSHOT_MAX_PER_KEY = 20
# A snapshot key is a workspace key (a Dapr instance id) and a snapshot id is a top-level
# node id — each indexes ONE filesystem path segment, so validate strictly: a single
# segment, no separators or traversal, bounded charset + length.
_SNAPSHOT_COMPONENT_RE = re.compile(r"[A-Za-z0-9_][A-Za-z0-9_.@:-]{0,200}")


def _validate_snapshot_component(value: str | None, *, field: str) -> str:
    v = (value or "").strip()
    if (
        not v
        or v in {".", ".."}
        or "/" in v
        or "\\" in v
        or not _SNAPSHOT_COMPONENT_RE.fullmatch(v)
    ):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"{field} must be a single path segment without path syntax",
        )
    return v


def _snapshot_subpath(shared_key: str, snapshot_id: str) -> str:
    """Root-relative subPath of one node snapshot (call with VALIDATED components).

    This is the value the BFF threads as `seedWorkspaceFrom` when forking from a node
    whose snapshot exists — the existing seed-clone path root-mounts and clones
    `/jfs/<this>` into the fork's fresh workspace, so no seed-side change is needed."""
    return f"{_SNAPSHOTS_ROOT_DIR}/{shared_key}/{snapshot_id}"


def _snapshot_clone_cmd() -> str:
    """A juicefs `sh -c` body for the root-mounted snapshot Job: CoW-clone a run's live
    workspace `/jfs/$KEY` into `/jfs/.snapshots/$KEY/$SNAP`.

    Idempotent: an existing snapshot dir is a no-op success (a node id is snapshotted at
    most once). `juicefs clone` is metadata-only CoW; when the FUSE clone ioctl does not
    pass through the CSI bind mount it fails per-file → fall back to `cp --reflink=auto`
    then a plain `cp -a` (clone failure is EXPECTED, not an error). Build-artifact dirs are
    pruned one level under each top-level dir (same set as the seed clone) so a snapshot is
    source-only and cheap. The clone stages into a hidden temp dir and `mv`s into place so a
    fork never observes a half-written snapshot as complete. After writing, if more than
    $CAP snapshots exist for the key, the oldest (by mtime) are pruned in the same Job.
    Missing source (no workspace yet) is a no-op success."""
    excl = "node_modules .svelte-kit build dist .next .cache .turbo .vite"
    return (
        'r() { ls -A "$1" 2>/dev/null | ' + _JFS_MAGIC_FILTER + "; }; "
        'c() { juicefs clone "$1" "$2" 2>/dev/null || cp -a --reflink=auto "$1" "$2" 2>/dev/null || cp -a "$1" "$2"; }; '
        'S="/jfs/$KEY"; SNAPDIR="/jfs/' + _SNAPSHOTS_ROOT_DIR + '/$KEY"; D="$SNAPDIR/$SNAP"; '
        '[ -d "$S" ] || { echo source-missing; exit 0; }; '
        'mkdir -p "$SNAPDIR"; '
        'if [ -d "$D" ]; then echo already-exists; else '
        'TMP="$SNAPDIR/.tmp-$SNAP.$$"; rm -rf "$TMP"; mkdir -p "$TMP"; '
        'EXCL="' + excl + '"; '
        'skip() { for x in $EXCL; do [ "$1" = "$x" ] && return 0; done; return 1; }; '
        "rc=0; "
        'for f in $(r "$S"); do '
        'if [ -d "$S/$f" ]; then mkdir -p "$TMP/$f"; '
        'for g in $(r "$S/$f"); do skip "$g" && continue; c "$S/$f/$g" "$TMP/$f/$g" || rc=1; done; '
        'else c "$S/$f" "$TMP/$f" || rc=1; fi; '
        "done; "
        '[ "$rc" = 0 ] && mv "$TMP" "$D" || { rm -rf "$TMP"; echo snapshot-failed; exit 1; }; '
        "echo snapshotted; fi; "
        # Cap: keep the newest $CAP snapshot dirs for this key; prune older by mtime.
        # `ls` (no -A) skips the .tmp-* staging dirs of any concurrent Job.
        'n=$(ls -1 "$SNAPDIR" 2>/dev/null | wc -l); '
        'if [ "$n" -gt "$CAP" ]; then '
        'ls -1t "$SNAPDIR" | tail -n +$((CAP+1)) | while read old; do rm -rf "$SNAPDIR/$old"; done; '
        "fi; true"
    )


def _snapshot_prune_cmd() -> str:
    """A `sh -c` body for the root-mounted snapshot-prune Job. Removes snapshot dirs under
    `.snapshots/$KEY`. Env modes: PRUNE_ALL=1 removes the whole key dir; otherwise every id
    NOT in the space-separated KEEP list is removed. Missing dir is a no-op success."""
    return (
        'SNAPDIR="/jfs/' + _SNAPSHOTS_ROOT_DIR + '/$KEY"; '
        '[ -d "$SNAPDIR" ] || { echo nothing-to-prune; exit 0; }; '
        'if [ "${PRUNE_ALL:-0}" = "1" ]; then rm -rf "$SNAPDIR"; echo pruned-all; exit 0; fi; '
        'for d in $(ls -1 "$SNAPDIR" 2>/dev/null); do '
        'keep=0; for k in $KEEP; do [ "$d" = "$k" ] && keep=1; done; '
        '[ "$keep" = 0 ] && rm -rf "$SNAPDIR/$d"; done; echo pruned; true'
    )


# Shared root PVC name for snapshot create/prune Jobs (root mount so source + `.snapshots`
# are visible together). Distinct from the seed clone's `wsseed-root`; both are idempotent
# RWX/Retain root binds.
_SNAPSHOT_ROOT_PVC = "wssnap-root"


def _build_snapshot_job(
    *,
    name: str,
    namespace: str,
    command: str,
    command_env: dict[str, str],
    execution_id: str | None,
    action: str,
) -> dict[str, Any]:
    """Build a short-lived root-mounted snapshot Job (create or prune). Plain Job — no
    Kueue: snapshots are tiny and must run outside the sandbox admission queues."""
    seed_image = os.environ.get(
        "WORKSPACE_SEED_JUICEFS_IMAGE", "juicedata/mount:ce-v1.3.1"
    )
    try:
        ttl = int(os.environ.get("SNAPSHOT_JOB_TTL_SECONDS", "600"))
    except (TypeError, ValueError):
        ttl = 600
    labels = {
        "app": "cli-workspace-snapshot",
        "snapshot.workflow-builder.cnoe.io/action": action,
    }
    if execution_id:
        labels["workflow-builder.cnoe.io/execution-id"] = _safe_name(
            execution_id, max_length=63
        )
    return {
        "apiVersion": "batch/v1",
        "kind": "Job",
        "metadata": {"name": name, "namespace": namespace, "labels": labels},
        "spec": {
            "backoffLimit": 1,
            "ttlSecondsAfterFinished": ttl,
            "template": {
                "metadata": {"labels": labels},
                "spec": {
                    "restartPolicy": "Never",
                    "containers": [
                        {
                            "name": "snapshot",
                            "image": seed_image,
                            "command": ["sh", "-c", command],
                            "env": [
                                {"name": k, "value": v}
                                for k, v in command_env.items()
                            ],
                            "volumeMounts": [{"name": "root", "mountPath": "/jfs"}],
                        }
                    ],
                    "volumes": [
                        {
                            "name": "root",
                            "persistentVolumeClaim": {"claimName": _SNAPSHOT_ROOT_PVC},
                        }
                    ],
                },
            },
        },
    }


def _start_snapshot_prune_job(
    batch: Any,
    core: Any,
    *,
    namespace: str,
    class_config: ExecutionClassConfig,
    shared_key: str,
    keep: list[str] | None = None,
    prune_all: bool = False,
    execution_id: str | None = None,
) -> str:
    """Ensure the root PV, then submit a snapshot-prune Job. Returns the Job name.
    Caller validates `shared_key`/`keep`. Reused by the prune endpoint and workspace purge."""
    job_name = (
        f"snapx-{sha256(shared_key.encode()).hexdigest()[:12]}-{uuid4().hex[:6]}"
    )
    command_env = {"KEY": shared_key}
    if prune_all:
        command_env["PRUNE_ALL"] = "1"
    else:
        command_env["KEEP"] = " ".join(keep or [])
    job_body = _build_snapshot_job(
        name=job_name,
        namespace=namespace,
        command=_snapshot_prune_cmd(),
        command_env=command_env,
        execution_id=execution_id,
        action="prune",
    )
    _ensure_root_pv(
        core, name=_SNAPSHOT_ROOT_PVC, class_config=class_config, namespace=namespace
    )
    batch.create_namespaced_job(namespace=namespace, body=job_body)
    return job_name


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
    preview_storage = _preview_storage_context()
    if preview_storage is not None:
        logical_key = _preview_storage_logical_key(seed_key, field="seed workspace key")
        return _ensure_preview_dynamic_pvc(
            core,
            namespace=namespace,
            context=preview_storage,
            kind="workspace",
            logical_key=logical_key,
            capacity=class_config.sharedWorkspaceStoreCapacity,
            create=False,
        )
    name = _safe_resource_name(f"cli-seed-{request.agentAppId}", max_length=63)
    secret_namespace = class_config.sharedWorkspaceStoreSecretNamespace or namespace
    labels = {
        "app": "cli-seed-workspace",
        "agent-app-id": _safe_name(request.agentAppId, max_length=63),
        "workflow-builder.cnoe.io/session-id": _safe_name(
            request.sessionId, max_length=63
        ),
        "workflow-builder.cnoe.io/seed-workspace-key": _safe_name(
            seed_key, max_length=63
        ),
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
                core.patch_persistent_volume(
                    name=name, body={"spec": {"claimRef": None}}
                )
        except Exception as patch_exc:
            logger.warning("cli-seed pv %s claimRef clear failed: %s", name, patch_exc)
    try:
        core.create_namespaced_persistent_volume_claim(
            namespace=namespace, body=pvc_body
        )
    except Exception as exc:
        if getattr(exc, "status", None) != 409:
            raise
    return name


def _cli_seed_workspace_claim_name(
    request: AgentWorkflowHostRequest,
    preview_storage: PreviewStorageContext | None,
) -> str:
    if preview_storage is not None:
        logical_key = _preview_storage_logical_key(
            request.seedWorkspaceFrom, field="seed workspace key"
        )
        return _preview_storage_pvc_name("workspace", logical_key)
    return _safe_resource_name(f"cli-seed-{request.agentAppId}", max_length=63)


TRACEPARENT_ANNOTATION = "workflow-builder.cnoe.io/traceparent"
TRACESTATE_ANNOTATION = "workflow-builder.cnoe.io/tracestate"
BAGGAGE_ANNOTATION = "workflow-builder.cnoe.io/baggage"
# Full (untruncated) owner-run identity stamped on each agent-host Sandbox CR so
# a create-409 can distinguish adopt-same-run from a stale name reused by a
# different run (delete + recreate, no inherited pod state).
OWNER_RUN_ID_ANNOTATION = "agents.workflow-builder.cnoe.io/owner-run-id"
AGENT_HOST_GENERATION_ANNOTATION = "agents.workflow-builder.cnoe.io/generation"
AGENT_HOST_LIFECYCLE_ANNOTATION = "agents.workflow-builder.cnoe.io/lifecycle"
AGENT_HOST_FINAL_TIMEOUT_ANNOTATION = (
    "agents.workflow-builder.cnoe.io/final-timeout-seconds"
)
AGENT_HOST_FINAL_PERSISTENT_ANNOTATION = (
    "agents.workflow-builder.cnoe.io/final-persistent"
)
AGENT_HOST_ACTIVATED_AT_ANNOTATION = (
    "agents.workflow-builder.cnoe.io/activated-at"
)
AGENT_HOST_DELETE_SERVER_CONTRACT_SECONDS = 40.0
AGENT_HOST_DELETE_WAIT_TIMEOUT_SECONDS = 30.0
AGENT_HOST_DELETE_K8S_REQUEST_TIMEOUT_SECONDS = 3


def _agent_host_delete_request_timeout(
    deadline: float, *, reserve_seconds: float = 0.0
) -> int:
    """Return a kubernetes-python total timeout inside one absolute deadline."""
    remaining = deadline - time.monotonic() - max(0.0, reserve_seconds)
    if remaining < 1.0:
        raise TimeoutError("agent-host cleanup deadline exceeded")
    # kubernetes-python ignores a scalar float here; an int is a total timeout.
    return min(AGENT_HOST_DELETE_K8S_REQUEST_TIMEOUT_SECONDS, int(remaining))


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
    annotations = ((existing or {}).get("metadata", {}) or {}).get(
        "annotations", {}
    ) or {}
    existing_owner = annotations.get(OWNER_RUN_ID_ANNOTATION)
    if not existing_owner:
        return True
    return existing_owner == want_owner


def _delete_agent_host_cr_and_wait(
    custom: Any,
    namespace: str,
    name: str,
    timeout_s: float = AGENT_HOST_DELETE_WAIT_TIMEOUT_SECONDS,
    *,
    deadline: float | None = None,
    reserve_seconds: float = 0.0,
) -> None:
    started_at = time.monotonic()
    reserved_seconds = max(0.0, reserve_seconds)
    operation_deadline = (
        deadline
        if deadline is not None
        else started_at + max(0.0, timeout_s)
    )
    wait_budget_s = max(
        0.0, operation_deadline - started_at - reserved_seconds
    )
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
            _request_timeout=_agent_host_delete_request_timeout(
                operation_deadline, reserve_seconds=reserved_seconds
            ),
        )
    except TimeoutError:
        logger.warning("agent-host CR %s delete deadline was exhausted", name)
        return
    except Exception as exc:
        if getattr(exc, "status", None) != 404:
            logger.warning("agent-host CR %s delete failed: %s", name, exc)
    while True:
        try:
            request_timeout = _agent_host_delete_request_timeout(
                operation_deadline, reserve_seconds=reserved_seconds
            )
        except TimeoutError:
            break
        try:
            custom.get_namespaced_custom_object(
                group="agents.x-k8s.io",
                version="v1alpha1",
                namespace=namespace,
                plural="sandboxes",
                name=name,
                _request_timeout=request_timeout,
            )
        except Exception as exc:
            if getattr(exc, "status", None) == 404:
                return
        remaining = operation_deadline - time.monotonic() - reserved_seconds
        if remaining > 0:
            time.sleep(min(1.0, remaining))
    logger.warning(
        "agent-host CR %s still present after %ss; proceeding to recreate",
        name,
        wait_budget_s,
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
    class_workflow_grpc_limit = str(
        class_config.agentHostEnv.get("DAPR_WORKFLOW_GRPC_MAX_MESSAGE_BYTES") or ""
    ).strip()
    class_state_client_grpc_limit = str(
        class_config.agentHostEnv.get("DAPR_GRPC_MAX_INBOUND_MESSAGE_SIZE_BYTES")
        or ""
    ).strip()
    workflow_grpc_max_message_bytes = class_workflow_grpc_limit or (
        os.environ.get("DAPR_WORKFLOW_GRPC_MAX_MESSAGE_BYTES", "").strip()
        or "16777216"
    )
    dapr_grpc_max_inbound_message_size_bytes = (
        class_state_client_grpc_limit
        or os.environ.get("DAPR_GRPC_MAX_INBOUND_MESSAGE_SIZE_BYTES", "").strip()
        or workflow_grpc_max_message_bytes
    )
    class_agent_host_env_values = dict(class_config.agentHostEnv)
    for key in (
        "DAPR_WORKFLOW_GRPC_MAX_MESSAGE_BYTES",
        "DAPR_GRPC_MAX_INBOUND_MESSAGE_SIZE_BYTES",
    ):
        value = str(class_agent_host_env_values.get(key) or "").strip()
        if value:
            class_agent_host_env_values[key] = value
        else:
            class_agent_host_env_values.pop(key, None)
    class_agent_host_env = [
        {"name": key, "value": value}
        for key, value in sorted(class_agent_host_env_values.items())
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
        if "pydantic-ai-agent-py" in image:
            env_from.append(
                {"configMapRef": {"name": "pydantic-ai-agent-py-config", "optional": True}}
            )
        env_from.extend(
            [
                {"secretRef": {"name": "dapr-agent-py-secrets", "optional": True}},
                {"secretRef": {"name": "workflow-checkpoint-gitea", "optional": True}},
                # Phase-2 in-cluster git-checkpoint remote creds (stacks#4956). Optional so
                # pods still start before the Secret exists.
                {"secretRef": {"name": "checkpoint-git-creds", "optional": True}},
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
                        "value": "llm-kimi-k3",
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
                        "value": workflow_grpc_max_message_bytes,
                    },
                    {
                        "name": "DAPR_GRPC_MAX_INBOUND_MESSAGE_SIZE_BYTES",
                        "value": dapr_grpc_max_inbound_message_size_bytes,
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
                "securityContext": _restricted_container_security_context(),
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
    if _pydantic_scratch_enabled(image):
        # Durable per-sandbox scratch: /sandbox rides a PVC (ensured by the
        # create handler, ownerRef'd to the Sandbox CR) instead of an emptyDir,
        # so a rescheduled pod resumes with its files. Pod-local semantics are
        # unchanged — only the volume's lifetime moves from pod to sandbox.
        pod_spec["volumes"] = [
            {
                "name": "sandbox",
                "persistentVolumeClaim": {
                    "claimName": _pydantic_scratch_claim_name(request)
                },
            }
            if volume.get("name") == "sandbox"
            else volume
            for volume in pod_spec["volumes"]
        ]
    if _cli_transcript_enabled(class_config):
        # Per-session durable transcript subtree. The PVC is provisioned by the
        # create handler (_ensure_cli_transcript_volume) and mounted at a path
        # SIBLING to the CLI config dir; cli-agent-py symlinks the CLI's
        # transcript dir into it (CLI_TRANSCRIPT_MOUNT) so only the transcript
        # persists and all credential state stays on the ephemeral emptyDir.
        preview_storage = _preview_storage_context()
        transcript_pvc = _cli_transcript_claim_name(request, preview_storage)
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
    if (
        _cli_shared_workspace_enabled(class_config)
        and (request.sharedWorkspaceKey or "").strip()
    ):
        # Per-EXECUTION shared workspace, mounted at a SUBDIR of /sandbox (the
        # emptyDir provides /sandbox + the CLI's config dirs; this PVC overlays
        # only the build subdir, shared across the workflow's CLI pods). Nested
        # mount: kubelet mounts the parent emptyDir before this child path.
        preview_storage = _preview_storage_context()
        shared_pvc = _cli_shared_workspace_claim_name(request, preview_storage)
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
            seed_pvc = _cli_seed_workspace_claim_name(request, preview_storage)
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
                    {
                        "name": "cli-seed-workspace",
                        "mountPath": "/seed",
                        "readOnly": True,
                    },
                ],
                "securityContext": _restricted_container_security_context(),
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
        # Must exceed shutdownTime (timeoutSeconds + shutdown buffer): a smaller
        # deadline hard-killed the pod (phase=Failed/DeadlineExceeded) 20 min
        # before the controller's graceful Delete for every agent-host sandbox.
        # A provisional pod can spend its entire provisioning window waiting for
        # durable publication before activation starts the final timeout, so the
        # kubelet backstop includes both windows. Persistent final hosts omit the
        # deadline even when they begin provisionally.
        pod_spec["activeDeadlineSeconds"] = (
            (request.provisionalTimeoutSeconds or 0)
            + request.timeoutSeconds
            + _agent_host_shutdown_buffer_seconds()
            + AGENT_HOST_POD_DEADLINE_MARGIN_SECONDS
        )
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
        AGENT_HOST_GENERATION_ANNOTATION: request.agentAppId,
        AGENT_HOST_LIFECYCLE_ANNOTATION: (
            "provisional" if request.provisionalTimeoutSeconds is not None else "active"
        ),
        AGENT_HOST_FINAL_TIMEOUT_ANNOTATION: (
            str(request.timeoutSeconds) if request.timeoutSeconds is not None else ""
        ),
        AGENT_HOST_FINAL_PERSISTENT_ANNOTATION: (
            "true" if request.timeoutSeconds is None else "false"
        ),
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
    shutdown_time = (
        _agent_host_shutdown_time_after(request.provisionalTimeoutSeconds)
        if request.provisionalTimeoutSeconds is not None
        else _agent_host_shutdown_time(request)
    )
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
    if os.environ.get(
        "SANDBOX_EXECUTION_PATCH_COMPONENT_SCOPES", "false"
    ).strip().lower() not in {
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


@dataclass(frozen=True)
class AgentHostReadiness:
    status: str
    pod_name: str | None = None
    pod_ip: str | None = None


def _wait_for_agent_host_ready(
    core: Any,
    *,
    namespace: str,
    agent_app_id: str,
    wait_seconds: int,
    failure_probe: Any | None = None,
) -> AgentHostReadiness:
    """Poll the per-app pod selector until ready or `wait_seconds` elapses.

    `failure_probe`, if provided, is called each tick with no args and must
    return either ``None`` (no failure) or a string describing the failure;
    when it returns a string we surface a 503 and stop polling.
    """
    if wait_seconds <= 0:
        return AgentHostReadiness(status="queued")
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
                pod_status = getattr(pod, "status", None)
                pod_ip = getattr(pod_status, "pod_ip", None)
                if not isinstance(pod_ip, str) or not pod_ip:
                    last_failure = "ready pod has no pod IP"
                    continue
                pod_metadata = getattr(pod, "metadata", None)
                pod_name = getattr(pod_metadata, "name", None)
                return AgentHostReadiness(
                    status="ready",
                    pod_name=(pod_name if isinstance(pod_name, str) else None),
                    pod_ip=pod_ip,
                )
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
    return AgentHostReadiness(status="queued")


def _agent_host_base_url(pod_ip: str) -> str:
    host = f"[{pod_ip}]" if ":" in pod_ip else pod_ip
    return f"http://{host}:8002"


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

# Directory a class-declared image-pins ConfigMap is mounted at on the dev
# container; the git-synced pin files (classes.json + runtime-images.json) live
# here and the dev pod's app reads them file-first (see image-pins.ts / the
# SANDBOX_EXECUTION_CLASSES_FILE reader).
IMAGE_PINS_MOUNT_PATH = "/etc/workflow-builder/image-pins"
IMAGE_PINS_VOLUME_NAME = "image-pins"

# #40: pod-localhost port of the app-container exec bridge (the dev images'
# entrypoints start it; the dev-sync-sidecar proxies /__run there). Stamped
# into BOTH containers so the two defaults can never drift per-pod.
DEV_SYNC_EXEC_BRIDGE_PORT = int(os.environ.get("DEV_SYNC_EXEC_BRIDGE_PORT", "8002"))


def _dev_sync_bridge_token(sync_token: str) -> str:
    """Derive the pod-local exec capability without exposing the receiver leaf."""
    return sha256(f"dev-sync-bridge/v1\0{sync_token}".encode("utf-8")).hexdigest()


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
        DEV_PREVIEW_MANAGED_LABEL: DEV_PREVIEW_MANAGED_VALUE,
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


def _delete_dev_preview_secret_and_wait(
    core: Any,
    *,
    namespace: str,
    name: str,
    execution_id: str,
    service: str,
    timeout_s: float = 30.0,
) -> None:
    """Delete only the exact labeled dev-preview Secret and prove absence."""

    try:
        secret = core.read_namespaced_secret(name=name, namespace=namespace)
    except Exception as exc:
        if getattr(exc, "status", None) == 404:
            return
        raise
    metadata = _adopt_value(secret, "metadata")
    labels = _adopt_value(metadata, "labels") or {}
    uid = str(_adopt_value(metadata, "uid") or "")
    resource_version = str(
        _adopt_value(metadata, "resource_version", "resourceVersion") or ""
    )
    if (
        _adopt_value(metadata, "name") != name
        or _adopt_value(metadata, "namespace") not in (None, namespace)
        or labels.get("app") != "wfb-dev-preview"
        or labels.get(DEV_PREVIEW_MANAGED_LABEL) != DEV_PREVIEW_MANAGED_VALUE
        or labels.get("workflow-execution-id") != execution_id
        or labels.get("dev-preview-service") != service
        or not uid
        or not resource_version
    ):
        raise RuntimeError(f"dev-preview Secret ownership changed for {name}")
    try:
        core.delete_namespaced_secret(
            name=name,
            namespace=namespace,
            body={
                "apiVersion": "v1",
                "kind": "DeleteOptions",
                "preconditions": {"uid": uid, "resourceVersion": resource_version},
            },
        )
    except Exception as exc:
        if getattr(exc, "status", None) != 404:
            raise
        return
    deadline = time.monotonic() + max(timeout_s, 0)
    while True:
        try:
            core.read_namespaced_secret(name=name, namespace=namespace)
        except Exception as exc:
            if getattr(exc, "status", None) == 404:
                return
            raise
        if time.monotonic() >= deadline:
            raise RuntimeError(f"dev-preview Secret deletion was not observed for {name}")
        time.sleep(0.1)


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
    adopt_config_map_mounts: list[dict[str, Any]] | None = None,
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
    workdir = _canonical_absolute_posix_path(
        request.workdir or class_config.serviceWorkdir or "/app",
        field="dev preview workdir",
    )
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
        env.append({"name": "WFB_DEV_SYNC_SERVICE", "value": service_label})
        if request.devSyncAllowedRoots:
            env.append(
                {
                    "name": "WFB_DEV_SYNC_ALLOWED_ROOTS_JSON",
                    "value": json.dumps(sorted(request.devSyncAllowedRoots)),
                }
            )
        if not functional:
            env.append(
                {"name": "WORKFLOW_BUILDER_SKIP_STARTUP_MIGRATIONS", "value": "true"}
            )
        if request.syncToken:
            env.append({"name": "WFB_DEV_SYNC_TOKEN", "value": request.syncToken})
        if request.syncAgentToken:
            env.append(
                {
                    "name": "WFB_DEV_SYNC_AGENT_TOKEN_SHA256",
                    "value": sha256(request.syncAgentToken.encode("utf-8")).hexdigest(),
                }
            )
    else:
        # #40 app-container exec bridge: the dev images start a tiny /__exec
        # server (127.0.0.1:8002, services/dev-sync-sidecar/exec-bridge.mjs or
        # exec_bridge.py) so /__run commands execute with the APP's toolchain —
        # the node-only sidecar can't run e.g. pytest (exit 127). The bridge
        # needs a purpose-specific pod-local token + its own command allowlist;
        # mutable app code never receives the broader sync receiver leaf.
        env.append(
            {"name": "DEV_SYNC_EXEC_PORT", "value": str(DEV_SYNC_EXEC_BRIDGE_PORT)}
        )
        env.append({"name": "DEV_SYNC_DEST", "value": workdir})
        if request.syncToken:
            env.append(
                {
                    "name": "DEV_SYNC_BRIDGE_TOKEN",
                    "value": _dev_sync_bridge_token(request.syncToken),
                }
            )
        if request.devSyncCommands:
            env.append(
                {
                    "name": "DEV_SYNC_COMMANDS_JSON",
                    "value": json.dumps(request.devSyncCommands, sort_keys=True),
                }
            )
        # #41 route-add restart signal: the sidecar (a separate process) cannot
        # call the dev server's in-process restart, so it writes this file into
        # the shared workdir when a sync ADDS src/routes files; the BFF's Vite
        # plugin polls it (consume-then-restart). Python dev servers ignore it.
        env.append(
            {
                "name": "WFB_DEV_SYNC_RESTART_SIGNAL",
                "value": f"{workdir}/.dev-sync-restart-request.json",
            }
        )
    # Git-synced image-pins mount: point the dev pod's app at the mounted pin files
    # so it reads pins file-first. Added to the BASE env list here so it lands in the
    # `overridden` set below (request.env / serviceEnv can't clobber the paths) and
    # wins over any inherited prod env in the adopt merge. The volume + mount are
    # attached to the pod below.
    if class_config.imagePinsConfigMap:
        env.append(
            {
                "name": "SANDBOX_EXECUTION_CLASSES_FILE",
                "value": f"{IMAGE_PINS_MOUNT_PATH}/classes.json",
            }
        )
        env.append(
            {
                "name": "WORKFLOW_BUILDER_IMAGE_PINS_FILE",
                "value": f"{IMAGE_PINS_MOUNT_PATH}/runtime-images.json",
            }
        )
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
    # the dev env above (deduped by name; the dev env wins on ordinary collisions
    # like NODE_ENV=development). Deployment-owned public identity and capability
    # registry entries are the exception: they must remain server-derived instead
    # of accepting the caller's generic fallback. This also preserves valueFrom
    # entries instead of serializing their values into the provisioning request.
    deployment_authority = bool(request.previewNative and request.adoptDeployment)
    if request.adoptInheritedEnv or deployment_authority:
        by_name: dict[str, dict[str, Any]] = {}
        for entry in _filter_adopted_container_env(request.adoptInheritedEnv) or []:
            if isinstance(entry, dict) and entry.get("name"):
                by_name[entry["name"]] = entry
        for entry in env:
            name = entry.get("name")
            if not name:
                continue
            # Never fall back to request.env for deployment-owned authority. If
            # the live Deployment omitted or malformed one of these entries, the
            # adopted pod also omits it and its capability adapter fails closed.
            if deployment_authority and name in _ADOPT_ENV_DEPLOYMENT_AUTHORITY_NAMES:
                continue
            by_name[name] = entry
        env = list(by_name.values())
    # envFrom (configMapRef/secretRef) for a functional preview that reuses the
    # prod app's config + secrets. Request sources carry the service-specific
    # baseline; class sources are additive and intentionally land last so a
    # preview-wide source can override baseline keys. Deduplicate by Kubernetes
    # source identity while preserving the later declaration.
    combined_env_from = list(request.envFrom or []) + list(
        class_config.serviceEnvFrom or []
    )
    seen_env_from: set[tuple[str, str, str]] = set()
    env_from_reversed: list[dict[str, Any]] = []
    for entry in reversed(combined_env_from):
        ref_kind = ""
        ref_name = ""
        for candidate in ("configMapRef", "secretRef"):
            ref = entry.get(candidate)
            if isinstance(ref, dict) and isinstance(ref.get("name"), str):
                ref_kind = candidate
                ref_name = ref["name"]
                break
        key = (
            str(entry.get("prefix") or ""),
            ref_kind or "raw",
            ref_name or json.dumps(entry, sort_keys=True, separators=(",", ":")),
        )
        if key in seen_env_from:
            continue
        seen_env_from.add(key)
        env_from_reversed.append(dict(entry))
    env_from = list(reversed(env_from_reversed))
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
        **(
            {
                "securityContext": {
                    "allowPrivilegeEscalation": False,
                    "runAsNonRoot": True,
                    "runAsUser": 1001,
                    "runAsGroup": 1001,
                    "capabilities": {"drop": ["ALL"]},
                }
            }
            if request.previewNative
            else {}
        ),
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
    # Pod-level securityContext: preview-native code runs on shared dev nodes and
    # must satisfy their restricted Pod Security boundary. Host throwaway
    # previews preserve the legacy class behavior.
    # for plain previews (vite/uvicorn/tsx run as the image's root user). For
    # needsDapr we must NOT set a pod-level runAsUser:0 — the Dapr injector gives
    # the daprd native sidecar `runAsNonRoot: true` (no explicit runAsUser), so a
    # pod-level runAsUser:0 makes the effective uid root and the kubelet rejects
    # daprd ("runAsUser breaks non-root policy"). Strip runAsUser/runAsGroup for
    # needsDapr (mirrors the working agent-host pods, whose pod securityContext is
    # empty); the dev/seed/sync containers still run as their image's root user.
    if request.previewNative:
        pod_security = {
            "runAsNonRoot": True,
            "runAsUser": 1001,
            "runAsGroup": 1001,
            "fsGroup": 1001,
            "seccompProfile": {"type": "RuntimeDefault"},
        }
    elif class_config.podSecurityContext is not None:
        pod_security = dict(class_config.podSecurityContext)
    elif not request.needsDapr:
        pod_security = {"runAsUser": 0}
    else:
        pod_security = {}
    if request.needsDapr and not request.previewNative:
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
                    "pg_dump --schema-only --no-owner --no-privileges "
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
        sidecar_image = class_config.syncSidecarImage or os.environ.get(
            "DEV_SYNC_SIDECAR_IMAGE",
            "ghcr.io/pittampalliorg/dev-sync-sidecar:latest",
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
                    f"cp -R {workdir}/. /seed/; echo seeded $(ls /seed | wc -l) entries"
                ],
                "volumeMounts": [{"name": "dev-workdir", "mountPath": "/seed"}],
                **(
                    {
                        "securityContext": {
                            "allowPrivilegeEscalation": False,
                            "runAsNonRoot": True,
                            "runAsUser": 1001,
                            "runAsGroup": 1001,
                            "capabilities": {"drop": ["ALL"]},
                        }
                    }
                    if request.previewNative
                    else {}
                ),
            }
        )
        sidecar_env = [
            {"name": "DEV_SYNC_PORT", "value": str(sync_port)},
            {"name": "DEV_SYNC_DEST", "value": workdir},
            {"name": "DEV_SYNC_SERVICE", "value": service_label},
            # #40: where the app container's exec bridge listens (pod-localhost);
            # preview-native /__run fails closed when the bridge is unavailable.
            {"name": "DEV_SYNC_EXEC_PORT", "value": str(DEV_SYNC_EXEC_BRIDGE_PORT)},
        ]
        if request.syncToken:
            sidecar_env.append({"name": "DEV_SYNC_TOKEN", "value": request.syncToken})
            sidecar_env.append(
                {
                    "name": "DEV_SYNC_BRIDGE_TOKEN",
                    "value": _dev_sync_bridge_token(request.syncToken),
                }
            )
        if request.syncAgentToken:
            sidecar_env.append(
                {
                    "name": "DEV_SYNC_AGENT_TOKEN_SHA256",
                    "value": sha256(request.syncAgentToken.encode("utf-8")).hexdigest(),
                }
            )
        if request.devSyncAllowedRoots:
            sidecar_env.append(
                {
                    "name": "DEV_SYNC_ALLOWED_ROOTS_JSON",
                    "value": json.dumps(sorted(request.devSyncAllowedRoots)),
                }
            )
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
                **(
                    {
                        "securityContext": {
                            "allowPrivilegeEscalation": False,
                            "runAsNonRoot": True,
                            "runAsUser": 1001,
                            "runAsGroup": 1001,
                            "capabilities": {"drop": ["ALL"]},
                        }
                    }
                    if request.previewNative
                    else {}
                ),
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
            "docker.io/nginxinc/nginx-unprivileged@sha256:65e3e85dbaed8ba248841d9d58a899b6197106c23cb0ff1a132b7bfe0547e4c0",
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
                    "limits": {"cpu": "200m", "memory": "128Mi"},
                },
                "securityContext": {
                    "allowPrivilegeEscalation": False,
                    "runAsNonRoot": True,
                    "runAsUser": 1001,
                    "runAsGroup": 1001,
                    "capabilities": {"drop": ["ALL"]},
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
    # Git-synced image-pins ConfigMap → directory mount on the dev container (the
    # SANDBOX_EXECUTION_CLASSES_FILE / WORKFLOW_BUILDER_IMAGE_PINS_FILE env above
    # point at these files). Read-only; keys land as classes.json + runtime-images.json.
    if class_config.imagePinsConfigMap:
        container.setdefault("volumeMounts", []).append(
            {
                "name": IMAGE_PINS_VOLUME_NAME,
                "mountPath": IMAGE_PINS_MOUNT_PATH,
                "readOnly": True,
            }
        )
        pod_spec.setdefault("volumes", []).append(
            {
                "name": IMAGE_PINS_VOLUME_NAME,
                "configMap": {"name": class_config.imagePinsConfigMap},
            }
        )
    # Preserve platform-owned file configuration such as function-router's
    # strict registry. The identity adapter supplies ConfigMap-only, forced-
    # read-only attachments; caller request data cannot add mounts here.
    if adopt_config_map_mounts:
        mounts = container.setdefault("volumeMounts", [])
        volumes = pod_spec.setdefault("volumes", [])
        existing_volume_names = {item.get("name") for item in volumes}
        existing_mount_paths = {item.get("mountPath") for item in mounts}
        for attachment in adopt_config_map_mounts:
            volume = attachment.get("volume") if isinstance(attachment, dict) else None
            mount = attachment.get("mount") if isinstance(attachment, dict) else None
            if not isinstance(volume, dict) or not isinstance(mount, dict):
                continue
            name = volume.get("name")
            raw_mount_path = mount.get("mountPath")
            try:
                mount_path = _canonical_absolute_posix_path(
                    raw_mount_path, field="adopted ConfigMap mountPath"
                )
            except ValueError:
                continue
            if (
                not isinstance(name, str)
                or not name
                or not isinstance(volume.get("configMap"), dict)
            ):
                continue
            workdir_prefix = f"{workdir.rstrip('/')}/"
            mount_prefix = f"{mount_path.rstrip('/')}/"
            if (
                mount_path == workdir
                or mount_path.startswith(workdir_prefix)
                or workdir.startswith(mount_prefix)
            ):
                logger.warning(
                    "adopt: skipping ConfigMap mount %s at %s because it overlaps "
                    "the mutable dev workdir %s",
                    name,
                    mount_path,
                    workdir,
                )
                continue
            if name in existing_volume_names or mount_path in existing_mount_paths:
                continue
            volumes.append({"name": name, "configMap": volume["configMap"]})
            mounts.append(
                {
                    key: value
                    for key, value in mount.items()
                    if key in {"name", "mountPath", "subPath", "subPathExpr"}
                }
                | {"name": name, "mountPath": mount_path, "readOnly": True}
            )
            existing_volume_names.add(name)
            existing_mount_paths.add(mount_path)
    pod_labels = {
        "app": "wfb-dev-preview",
        DEV_PREVIEW_MANAGED_LABEL: DEV_PREVIEW_MANAGED_VALUE,
        "dev-preview-service": service_label,
        "workflow-execution-id": exec_label,
    }
    # Preview-native adopt: merge the target Service's selector LAST so it wins on
    # collisions. A staged batch deliberately quarantines one selector key: the pod
    # can become fully Ready (including daprd) without joining either the application
    # Service or the generated Dapr Service before the batch activation transaction.
    # agent-sandbox v0.4.5 propagates later Sandbox podTemplate label changes to the
    # existing Pod, so activation does not need direct Pod mutation privileges.
    adopt_selector_contract: tuple[dict[str, str], str, str] | None = None
    if request.previewNative and adopt_selector:
        active_selector = _canonical_adopt_selector(adopt_selector)
        selector_labels = active_selector
        if request.stageAdoption:
            holder = _adopt_lease_holder(request.executionId, request.service)
            adopt_selector_contract = _adopt_selector_contract(
                active_selector, holder=holder
            )
            active_selector, gate_key, staged_value = adopt_selector_contract
            selector_labels = {**active_selector, gate_key: staged_value}
        for key, value in selector_labels.items():
            if key and value is not None:
                pod_labels[key] = value
    # This controller-ownership label is not part of any adopted Service selector.
    # Stamp it last so inventory and destructive cleanup can never select an
    # unrelated workflow Sandbox even if a Service selector uses the same key.
    pod_labels[DEV_PREVIEW_MANAGED_LABEL] = DEV_PREVIEW_MANAGED_VALUE
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
        # Internal gRPC is a cluster-wide peer-dial contract: Dapr uses the caller's
        # configured port when invoking another app. Every host workload uses Dapr's
        # default 50002, so sandbox sidecars must omit a per-pod override too.
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
            DEV_PREVIEW_MANAGED_LABEL: DEV_PREVIEW_MANAGED_VALUE,
            "dev-preview-service": service_label,
            "workflow-execution-id": exec_label,
            "sandbox-execution-class": _safe_name(request.executionClass),
        },
    }
    # Record the adopted Deployment so teardown can restore it without the caller
    # re-supplying it (teardown only receives the Sandbox name).
    if request.previewNative and request.adoptDeployment:
        deployment_name = _safe_resource_name(request.adoptDeployment)
        holder = _adopt_lease_holder(request.executionId, request.service)
        cr_metadata["annotations"] = {
            DEV_PREVIEW_ADOPT_DEPLOYMENT_ANNOTATION: deployment_name,
            DEV_PREVIEW_ADOPT_HOLDER_ANNOTATION: holder,
            "wfb-dev-preview/adopt-lease": _adopt_lease_name(deployment_name),
            **(
                {DEV_PREVIEW_ADOPT_STAGED_ANNOTATION: holder}
                if request.stageAdoption
                else {}
            ),
            **(
                {
                    DEV_PREVIEW_ADOPT_SELECTOR_ANNOTATION: json.dumps(
                        adopt_selector_contract[0],
                        sort_keys=True,
                        separators=(",", ":"),
                    ),
                    DEV_PREVIEW_ADOPT_GATE_KEY_ANNOTATION: adopt_selector_contract[1],
                    DEV_PREVIEW_ADOPT_GATE_STAGED_VALUE_ANNOTATION: (
                        adopt_selector_contract[2]
                    ),
                }
                if adopt_selector_contract is not None
                else {}
            ),
        }
    if request.serviceSecretEnv:
        cr_metadata.setdefault("annotations", {})[
            DEV_PREVIEW_SECRET_NAME_ANNOTATION
        ] = _dev_preview_secret_name(request.executionId, request.service)
    return {
        "apiVersion": "agents.x-k8s.io/v1alpha1",
        "kind": "Sandbox",
        "metadata": cr_metadata,
        "spec": sandbox_spec,
    }


def _dev_preview_manifest_image(manifest: dict[str, Any]) -> str | None:
    """The `dev` container image in a dev-preview Sandbox manifest (the one this
    builder just produced). None if the structure is unexpected."""
    try:
        containers = manifest["spec"]["podTemplate"]["spec"]["containers"]
    except (KeyError, TypeError):
        return None
    for c in containers or []:
        if isinstance(c, dict) and c.get("name") == "dev":
            img = c.get("image")
            return img if isinstance(img, str) else None
    return None


def _delete_dev_preview_cr_and_wait(
    custom: Any,
    namespace: str,
    name: str,
    timeout_s: float = 30.0,
    *,
    uid: str | None = None,
    resource_version: str | None = None,
) -> bool:
    """Foreground-delete a dev-preview Sandbox CR and wait for it to disappear (so the
    deterministic name is free to recreate). Modeled on _delete_agent_host_cr_and_wait."""
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
                **(
                    {
                        "preconditions": {
                            **({"uid": uid} if uid else {}),
                            **(
                                {"resourceVersion": resource_version}
                                if resource_version
                                else {}
                            ),
                        }
                    }
                    if uid or resource_version
                    else {}
                ),
            },
        )
    except Exception as exc:
        if getattr(exc, "status", None) == 404:
            return True
        logger.warning("dev-preview CR %s delete failed: %s", name, exc)
        return False
    deadline = time.time() + timeout_s
    while time.time() < deadline:
        try:
            observed = custom.get_namespaced_custom_object(
                group="agents.x-k8s.io",
                version="v1alpha1",
                namespace=namespace,
                plural="sandboxes",
                name=name,
            )
        except Exception as exc:
            if getattr(exc, "status", None) == 404:
                return True
        else:
            observed_metadata = (
                (observed.get("metadata", {}) or {})
                if isinstance(observed, dict)
                else {}
            )
            if uid and observed_metadata.get("uid") not in (None, uid):
                return True
        time.sleep(1.0)
    logger.warning(
        "dev-preview CR %s still present after %ss",
        name,
        timeout_s,
    )
    return False
    raise RuntimeError(f"dev-preview CR {name} deletion was not observed")


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
        f"{DEV_PREVIEW_MANAGED_LABEL}={DEV_PREVIEW_MANAGED_VALUE},"
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


def _ready_dev_preview_pod(
    core: Any,
    *,
    namespace: str,
    execution_id: str,
    service: str | None,
    pod_ip: str | None,
) -> Any | None:
    selector = (
        f"{DEV_PREVIEW_MANAGED_LABEL}={DEV_PREVIEW_MANAGED_VALUE},"
        f"workflow-execution-id={_safe_name(execution_id, max_length=63)},"
        f"dev-preview-service={_dev_preview_service_label(service)}"
    )
    pods = core.list_namespaced_pod(namespace=namespace, label_selector=selector).items
    return next(
        (
            pod
            for pod in pods
            if _pod_is_ready(pod)
            and (
                (_adopt_value(_adopt_value(pod, "metadata"), "labels") or {}).get(
                    DEV_PREVIEW_MANAGED_LABEL
                )
                == DEV_PREVIEW_MANAGED_VALUE
            )
            and (
                pod_ip is None
                or getattr(getattr(pod, "status", None), "pod_ip", None) == pod_ip
            )
        ),
        None,
    )


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
        # Per-sandbox durable scratch PVC for the pod-local pydantic runtime
        # (also before the Sandbox CR so the pod's mount never races the claim).
        pydantic_scratch_pvc_name = _ensure_pydantic_scratch_pvc(
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
            if _agent_host_cr_owner_matches(
                custom, namespace, sandbox_name, want_owner
            ):
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
                if pydantic_scratch_pvc_name:
                    # The old CR's foreground delete GC'd the owned scratch PVC;
                    # re-ensure so the new run starts with a clean claim.
                    pydantic_scratch_pvc_name = _ensure_pydantic_scratch_pvc(
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
                generation=body.agentAppId,
                sandbox=created_sandbox,
            )
        if transcript_pvc_name:
            _bind_cli_transcript_pvc_owner(
                core,
                custom,
                namespace=namespace,
                pvc_name=transcript_pvc_name,
                sandbox_name=sandbox_name,
                generation=body.agentAppId,
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
                generation=body.agentAppId,
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
                generation=body.agentAppId,
                sandbox=created_sandbox,
            )
        if pydantic_scratch_pvc_name:
            # Same generic PVC-ownerRef patch: scratch lives exactly as long as
            # the Sandbox CR (survives pod reschedule, GCs with the session).
            _bind_cli_transcript_pvc_owner(
                core,
                custom,
                namespace=namespace,
                pvc_name=pydantic_scratch_pvc_name,
                sandbox_name=sandbox_name,
                generation=body.agentAppId,
                sandbox=created_sandbox,
            )
        readiness = _wait_for_agent_host_ready(
            core,
            namespace=namespace,
            agent_app_id=body.agentAppId,
            wait_seconds=body.waitReadySeconds,
            failure_probe=lambda: _sandbox_failure_reason(
                custom, namespace=namespace, sandbox_name=sandbox_name
            ),
        )
        readiness_status = readiness.status
        provisioning_phase = (
            "ready"
            if readiness_status == "ready"
            else _agent_host_provisioning_phase(
                core, namespace=namespace, agent_app_id=body.agentAppId
            )
        )
    else:
        readiness = AgentHostReadiness(status="queued")
        readiness_status = readiness.status
        provisioning_phase = "queued"
    response = {
        "agentAppId": body.agentAppId,
        "generation": body.agentAppId,
        "sessionId": body.sessionId,
        "sandboxName": sandbox_name,
        # Back-compat: callers (BFF, orchestrator) still read `jobName` until
        # arc 1.5 lands the shared dispatcher rename. Keep both keys until then.
        "jobName": sandbox_name,
        "status": readiness_status,
        # Additive: distinguishes Kueue-queued/unscheduled (`queued`) from
        # scheduled-but-booting (`starting`) and Ready (`ready`).
        "phase": provisioning_phase,
        "provisional": body.provisionalTimeoutSeconds is not None,
        "executionClass": body.executionClass,
        "localQueue": class_config.localQueue,
        "runtimeClassName": class_config.runtimeClassName,
    }
    if readiness.status == "ready" and readiness.pod_ip:
        response.update(
            {
                "podName": readiness.pod_name,
                "podIP": readiness.pod_ip,
                "baseUrl": _agent_host_base_url(readiness.pod_ip),
            }
        )
    set_current_span_io("output", response)
    return response


# Canonical Dapr-app-id shape for agent hosts (agent-session-<sha20> and the
# benchmark stable app ids): lowercase DNS-label, no leading/trailing dash.
_AGENT_APP_ID_PATTERN = re.compile(r"^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$")


@app.post("/api/v1/agent-workflow-hosts/{agent_app_id}/activate")
def activate_agent_workflow_host(
    request: Request,
    agent_app_id: str,
    body: AgentWorkflowHostActivationRequest,
) -> dict[str, Any]:
    """Promote one exact provisional generation to its requested final lifetime.

    The caller must present the deterministic Sandbox name and repeat the
    immutable app-id generation. The stored annotations are the authority for
    final timeout versus persistence, which makes activation retries
    idempotent and prevents them from extending an already-active host.
    """

    _require_internal(request)
    if not _AGENT_APP_ID_PATTERN.fullmatch(agent_app_id):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="invalid agent app id",
        )
    sandbox_name = _agent_host_sandbox_name(agent_app_id)
    if body.generation != agent_app_id or body.sandboxName != sandbox_name:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="agent-host activation identity mismatch",
        )

    namespace = _agent_workflow_host_namespace()
    custom = _load_k8s_custom_objects_client()

    def _read() -> dict[str, Any]:
        try:
            observed = custom.get_namespaced_custom_object(
                group="agents.x-k8s.io",
                version="v1alpha1",
                namespace=namespace,
                plural="sandboxes",
                name=sandbox_name,
            )
        except Exception as exc:
            if getattr(exc, "status", None) == 404:
                raise HTTPException(
                    status_code=status.HTTP_404_NOT_FOUND,
                    detail="agent workflow host not found",
                ) from exc
            raise HTTPException(
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                detail="agent-host lookup failed",
            ) from exc
        if not isinstance(observed, dict):
            raise HTTPException(
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                detail="agent-host lookup returned an invalid object",
            )
        return observed

    observed = _read()
    metadata = observed.get("metadata") or {}
    labels = metadata.get("labels") or {}
    annotations = metadata.get("annotations") or {}
    if (
        metadata.get("name") != sandbox_name
        or labels.get("agent-app-id")
        != _safe_name(agent_app_id, max_length=63)
    ):
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="agent-host activation Sandbox identity mismatch",
        )

    lifecycle = annotations.get(AGENT_HOST_LIFECYCLE_ANNOTATION)
    observed_generation = annotations.get(AGENT_HOST_GENERATION_ANNOTATION)
    # Rollout compatibility: pre-upgrade hosts were born active and have no
    # generation/lifecycle annotations. Exact Sandbox name + app-id label are
    # sufficient for a no-op acknowledgement, but they can never enter the
    # provisional activation path.
    if lifecycle is None and observed_generation is None:
        response = {
            "agentAppId": agent_app_id,
            "sandboxName": sandbox_name,
            "generation": agent_app_id,
            "outcome": "already-active",
            "legacy": True,
        }
        set_current_span_io("output", response)
        return response
    if observed_generation != agent_app_id:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="agent-host activation generation mismatch",
        )
    if lifecycle == "active":
        response = {
            "agentAppId": agent_app_id,
            "sandboxName": sandbox_name,
            "generation": agent_app_id,
            "outcome": "already-active",
            "legacy": False,
        }
        set_current_span_io("output", response)
        return response
    if lifecycle != "provisional":
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="agent-host activation lifecycle mismatch",
        )

    persistent_raw = annotations.get(AGENT_HOST_FINAL_PERSISTENT_ANNOTATION)
    timeout_raw = annotations.get(AGENT_HOST_FINAL_TIMEOUT_ANNOTATION)
    if persistent_raw not in {"true", "false"}:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="agent-host final persistence annotation is invalid",
        )
    persistent = persistent_raw == "true"
    final_timeout: int | None = None
    if persistent:
        if timeout_raw not in {None, ""}:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail="persistent agent-host carries a finite timeout",
            )
    else:
        try:
            final_timeout = int(timeout_raw or "")
        except ValueError as exc:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail="agent-host final timeout annotation is invalid",
            ) from exc
        if not 60 <= final_timeout <= 86400:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail="agent-host final timeout annotation is out of bounds",
            )

    activated_at = (
        datetime.now(UTC)
        .replace(microsecond=0)
        .isoformat()
        .replace("+00:00", "Z")
    )
    spec_patch: dict[str, Any]
    final_shutdown_time: str | None
    if persistent:
        final_shutdown_time = None
        spec_patch = {"shutdownPolicy": None, "shutdownTime": None}
    else:
        assert final_timeout is not None
        final_shutdown_time = _agent_host_shutdown_time_after(
            final_timeout + _agent_host_shutdown_buffer_seconds()
        )
        spec_patch = {
            "shutdownPolicy": "Delete",
            "shutdownTime": final_shutdown_time,
        }
    metadata_patch: dict[str, Any] = {
        "annotations": {
            AGENT_HOST_LIFECYCLE_ANNOTATION: "active",
            AGENT_HOST_ACTIVATED_AT_ANNOTATION: activated_at,
        }
    }
    resource_version = metadata.get("resourceVersion")
    if not isinstance(resource_version, str) or not resource_version:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="agent-host activation cannot establish object version",
        )
    # Make delete/recreate between verification and patch conflict instead of
    # activating a replacement object with the same DNS name.
    metadata_patch["resourceVersion"] = resource_version
    try:
        custom.patch_namespaced_custom_object(
            group="agents.x-k8s.io",
            version="v1alpha1",
            namespace=namespace,
            plural="sandboxes",
            name=sandbox_name,
            body={"metadata": metadata_patch, "spec": spec_patch},
        )
    except Exception as exc:
        if getattr(exc, "status", None) == 409:
            current = _read()
            current_annotations = (
                ((current.get("metadata") or {}).get("annotations") or {})
            )
            if (
                current_annotations.get(AGENT_HOST_GENERATION_ANNOTATION)
                == agent_app_id
                and current_annotations.get(AGENT_HOST_LIFECYCLE_ANNOTATION)
                == "active"
            ):
                response = {
                    "agentAppId": agent_app_id,
                    "sandboxName": sandbox_name,
                    "generation": agent_app_id,
                    "outcome": "already-active",
                    "legacy": False,
                }
                set_current_span_io("output", response)
                return response
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="agent-host activation patch failed",
        ) from exc

    response = {
        "agentAppId": agent_app_id,
        "sandboxName": sandbox_name,
        "generation": agent_app_id,
        "outcome": "activated",
        "legacy": False,
        "persistent": persistent,
        "shutdownTime": final_shutdown_time,
    }
    set_current_span_io("output", response)
    return response


@app.delete("/api/v1/agent-workflow-hosts/{agent_app_id}")
def delete_agent_workflow_host(
    request: Request,
    agent_app_id: str,
) -> dict[str, Any]:
    """Authoritative teardown of a per-session agent-host Sandbox CR.

    The BFF / preview-control broker service accounts have no RBAC on
    sandboxes.agents.x-k8s.io (and the broker mounts no SA token at all), so
    their direct kube deletes always failed and helper sandboxes lingered
    until shutdownTime. SEA is the privileged controller: the foreground CR
    delete here also GCs the ownerRef'd cred Secret + PVCs. Idempotent —
    deleting an absent host reports outcome="not-found" (HTTP 200).
    """
    _require_internal(request)
    if not _AGENT_APP_ID_PATTERN.fullmatch(agent_app_id):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="invalid agent app id",
        )
    namespace = _agent_workflow_host_namespace()
    sandbox_name = _agent_host_sandbox_name(agent_app_id)
    receipt: dict[str, Any] = {
        "agentAppId": agent_app_id,
        "sandboxName": sandbox_name,
        "namespace": namespace,
    }
    if os.environ.get("SANDBOX_EXECUTION_DRY_RUN", "").lower() in {
        "1",
        "true",
        "yes",
    }:
        return {**receipt, "outcome": "deleted"}
    cleanup_deadline = (
        time.monotonic() + AGENT_HOST_DELETE_SERVER_CONTRACT_SECONDS
    )
    custom = _load_k8s_custom_objects_client()

    def _sandbox_exists() -> bool:
        try:
            custom.get_namespaced_custom_object(
                group="agents.x-k8s.io",
                version="v1alpha1",
                namespace=namespace,
                plural="sandboxes",
                name=sandbox_name,
                _request_timeout=_agent_host_delete_request_timeout(
                    cleanup_deadline
                ),
            )
        except TimeoutError as exc:
            raise HTTPException(
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                detail="agent-host cleanup deadline exceeded",
            ) from exc
        except Exception as exc:
            if getattr(exc, "status", None) == 404:
                return False
            raise HTTPException(
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                detail="agent-host lookup failed",
            ) from exc
        return True

    if not _sandbox_exists():
        response = {**receipt, "outcome": "not-found"}
        set_current_span_io("output", response)
        return response
    _delete_agent_host_cr_and_wait(
        custom,
        namespace,
        sandbox_name,
        deadline=cleanup_deadline,
        reserve_seconds=AGENT_HOST_DELETE_K8S_REQUEST_TIMEOUT_SECONDS,
    )
    # _delete_agent_host_cr_and_wait tolerates a slow foreground delete; verify
    # so a still-terminating CR is reported instead of claimed deleted.
    if _sandbox_exists():
        response = {
            **receipt,
            "outcome": "error",
            "message": "sandbox delete requested but the CR is still terminating",
        }
    else:
        response = {**receipt, "outcome": "deleted"}
    set_current_span_io("output", response)
    return response


@app.post("/internal/dev-preview", status_code=status.HTTP_202_ACCEPTED)
def provision_dev_preview(request: Request, body: DevPreviewRequest) -> dict[str, Any]:
    _require_internal(request)
    set_current_span_io("input", _redacted_dev_preview_request_dump(body))
    if _dev_preview_teardown_intended(body.executionId):
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="dev-preview teardown has already been requested for this execution",
        )
    # This field is controller-owned. Never accept caller-provided valueFrom refs.
    body.adoptInheritedEnv = None
    if body.stageAdoption:
        service = _dev_preview_service_label(body.service)
        if (
            not body.previewNative
            or not body.service
            or body.service != service
            or _safe_resource_name(body.adoptService or "") != service
            or _safe_resource_name(body.adoptDeployment or "") != service
        ):
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=(
                    "stageAdoption requires an exact previewNative "
                    "service/adoptService/adoptDeployment tuple"
                ),
            )
    if body.previewNative and (
        os.environ.get("DEV_PREVIEW_PLATFORM_SCOPE", "").strip().lower() != "vcluster"
    ):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="previewNative dev adoption is allowed only inside a vCluster",
        )
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
    adopt_config_map_mounts: list[dict[str, Any]] = []
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
            if body.stageAdoption:
                try:
                    _canonical_adopt_selector(adopt_selector)
                except ValueError as exc:
                    raise HTTPException(
                        status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                        detail="staged adoption could not establish the Service selector",
                    ) from exc
        if body.previewNative and body.adoptDeployment:
            # Faithfully assume the prod pod's identity (don't override an explicit
            # caller value). Critical when needsDapr: the dev pod must use the SAME
            # SA (RBAC-bound for daprd) + Dapr config the prod BFF used, and the
            # prod app-id.
            identity = _adopt_read_identity(
                apps,
                namespace=namespace,
                name=_safe_resource_name(body.adoptDeployment),
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
                if identity.get("containerEnv"):
                    body.adoptInheritedEnv = identity["containerEnv"]
                adopt_config_map_mounts = list(identity.get("configMapMounts") or [])
        manifest = build_dev_preview_sandbox_manifest(
            body,
            namespace=namespace,
            class_config=class_config,
            adopt_selector=adopt_selector,
            adopt_config_map_mounts=adopt_config_map_mounts,
        )
        adoption_coordination: Any | None = None
        adoption_holder: str | None = None
        adoption_deployment: str | None = None
        if body.previewNative and body.adoptDeployment:
            adoption_deployment = _safe_resource_name(body.adoptDeployment)
            adoption_coordination = _load_k8s_coordination_client()
        with ExitStack() as creation_locks:
            if adoption_deployment:
                creation_locks.enter_context(
                    _dev_preview_adoption_transition_lock(
                        namespace, adoption_deployment
                    )
                )
            creation_locks.enter_context(_DEV_PREVIEW_TEARDOWN_INTENTS_GUARD)
            if body.executionId in _DEV_PREVIEW_TEARDOWN_INTENTS:
                raise HTTPException(
                    status_code=status.HTTP_409_CONFLICT,
                    detail="dev-preview teardown began before Sandbox creation",
                )
            try:
                if adoption_deployment and adoption_coordination:
                    adoption_holder = _acquire_dev_preview_adoption_lease(
                        adoption_coordination,
                        namespace=namespace,
                        deployment=adoption_deployment,
                        execution_id=body.executionId,
                        service=body.service,
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
                    try:
                        existing_cr = custom.get_namespaced_custom_object(
                            group="agents.x-k8s.io",
                            version="v1alpha1",
                            namespace=namespace,
                            plural="sandboxes",
                            name=sandbox_name,
                        )
                    except Exception as read_exc:
                        raise HTTPException(
                            status_code=status.HTTP_409_CONFLICT,
                            detail="existing Sandbox ownership could not be proven",
                        ) from read_exc
                    existing_metadata = (
                        (existing_cr.get("metadata", {}) or {})
                        if isinstance(existing_cr, dict)
                        else {}
                    )
                    existing_labels = existing_metadata.get("labels", {}) or {}
                    if (
                        existing_metadata.get("name") not in (None, sandbox_name)
                        or existing_metadata.get("namespace") not in (None, namespace)
                        or existing_labels.get("app") != "wfb-dev-preview"
                        or existing_labels.get(DEV_PREVIEW_MANAGED_LABEL)
                        != DEV_PREVIEW_MANAGED_VALUE
                        or existing_labels.get("workflow-execution-id")
                        != _safe_name(body.executionId, max_length=63)
                        or existing_labels.get("dev-preview-service")
                        != _dev_preview_service_label(body.service)
                    ):
                        raise HTTPException(
                            status_code=status.HTTP_409_CONFLICT,
                            detail="existing Sandbox is not the exact managed dev preview",
                        )
                    if adoption_holder is not None:
                        existing_holder = _dev_preview_cr_adoption_holder(
                            custom, namespace, sandbox_name
                        )
                        if existing_holder != adoption_holder:
                            raise HTTPException(
                                status_code=status.HTTP_409_CONFLICT,
                                detail=(
                                    "existing dev preview does not own the adoption Lease"
                                ),
                            )
                        existing_staged = _dev_preview_cr_annotation(
                            custom,
                            namespace,
                            sandbox_name,
                            DEV_PREVIEW_ADOPT_STAGED_ANNOTATION,
                        )
                        if (existing_staged and not body.stageAdoption) or (
                            body.stageAdoption and existing_staged != adoption_holder
                        ):
                            raise HTTPException(
                                status_code=status.HTTP_409_CONFLICT,
                                detail=(
                                    "existing staged dev preview must be committed by "
                                    "the batch activation endpoint"
                                ),
                            )
                    # A deterministic name is idempotent only while its image agrees.
                    requested_image = _dev_preview_manifest_image(manifest)
                    existing_image = _dev_preview_manifest_image(existing_cr)
                    if (
                        requested_image
                        and existing_image
                        and existing_image != requested_image
                    ):
                        if (
                            adoption_deployment
                            in DEV_PREVIEW_DEFERRED_CUTOVER_DEPLOYMENTS
                        ):
                            raise HTTPException(
                                status_code=status.HTTP_409_CONFLICT,
                                detail=(
                                    f"adopted {adoption_deployment} image replacement "
                                    "is not synchronous; launch a fresh acceptance preview"
                                ),
                            )
                        logger.warning(
                            "dev-preview image drift: existing=%s requested=%s; recreating %s",
                            existing_image,
                            requested_image,
                            sandbox_name,
                        )
                        if not _delete_dev_preview_cr_and_wait(
                            custom, namespace, sandbox_name
                        ):
                            raise RuntimeError(
                                f"stale dev-preview deletion was not proven for {sandbox_name}"
                            )
                        # The teardown-intent guard remains held across delete/create.
                        custom.create_namespaced_custom_object(
                            group="agents.x-k8s.io",
                            version="v1alpha1",
                            namespace=namespace,
                            plural="sandboxes",
                            body=manifest,
                        )
                    else:
                        logger.info(
                            "dev-preview CR %s already exists; adopting", sandbox_name
                        )
            except Exception:
                # Compensate each support resource unless an exact managed Sandbox
                # claims it. Ambiguous reads retain both as fail-closed evidence.
                secret_claimed = True
                lease_claimed = True
                try:
                    observed_cr = custom.get_namespaced_custom_object(
                        group="agents.x-k8s.io",
                        version="v1alpha1",
                        namespace=namespace,
                        plural="sandboxes",
                        name=sandbox_name,
                    )
                    observed_metadata = (
                        (observed_cr.get("metadata", {}) or {})
                        if isinstance(observed_cr, dict)
                        else {}
                    )
                    observed_labels = observed_metadata.get("labels", {}) or {}
                    observed_annotations = (
                        observed_metadata.get("annotations", {}) or {}
                    )
                    managed_exact = (
                        observed_labels.get("app") == "wfb-dev-preview"
                        and observed_labels.get(DEV_PREVIEW_MANAGED_LABEL)
                        == DEV_PREVIEW_MANAGED_VALUE
                        and observed_labels.get("workflow-execution-id")
                        == _safe_name(body.executionId, max_length=63)
                        and observed_labels.get("dev-preview-service")
                        == _dev_preview_service_label(body.service)
                    )
                    secret_claimed = managed_exact and (
                        not preview_secret_name
                        or observed_annotations.get(
                            DEV_PREVIEW_SECRET_NAME_ANNOTATION
                        )
                        == preview_secret_name
                    )
                    observed_holder = observed_annotations.get(
                        DEV_PREVIEW_ADOPT_HOLDER_ANNOTATION
                    ) or observed_annotations.get(
                        DEV_PREVIEW_ADOPT_CUTOVER_CANCELLED_ANNOTATION
                    )
                    lease_claimed = managed_exact and (
                        not adoption_holder or observed_holder == adoption_holder
                    )
                except Exception as read_exc:
                    if getattr(read_exc, "status", None) == 404:
                        secret_claimed = False
                        lease_claimed = False
                if preview_secret_name and not secret_claimed:
                    _delete_dev_preview_secret_and_wait(
                        core,
                        namespace=namespace,
                        name=preview_secret_name,
                        execution_id=_safe_name(body.executionId, max_length=63),
                        service=_dev_preview_service_label(body.service),
                    )
                if (
                    adoption_holder
                    and adoption_coordination
                    and adoption_deployment
                    and not lease_claimed
                    and not _delete_dev_preview_adoption_lease(
                        adoption_coordination,
                        namespace=namespace,
                        deployment=adoption_deployment,
                        holder=adoption_holder,
                    )
                ):
                    raise RuntimeError(
                        f"failed provisioning cleanup retained adoption Lease for {adoption_deployment}"
                    )
                raise
        try:
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
            if body.previewNative and body.adoptDeployment:
                if readiness_status != "ready" or not pod_ip:
                    raise HTTPException(
                        status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                        detail=(
                            f"adopted dev-preview {body.executionId}/{body.service or 'workflow-builder'} "
                            "did not become ready; the Sandbox was removed without cutover"
                        ),
                    )
                ready_pod = _ready_dev_preview_pod(
                    core,
                    namespace=namespace,
                    execution_id=body.executionId,
                    service=body.service,
                    pod_ip=pod_ip,
                )
                if ready_pod is None or (
                    body.needsDapr and not _dev_pod_has_daprd(ready_pod)
                ):
                    raise HTTPException(
                        status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                        detail=(
                            f"adopted dev-preview {body.executionId}/{body.service or 'workflow-builder'} "
                            "did not satisfy the complete readiness contract; the Sandbox was removed without cutover"
                        ),
                    )
                # Response-path Deployments cut over after the response grace below.
                # Other peers stay synchronous so the batch coordinator never sees
                # success for a merely scheduled cutover that can race compensation.
                if (
                    not body.stageAdoption
                    and adoption_deployment
                    not in DEV_PREVIEW_DEFERRED_CUTOVER_DEPLOYMENTS
                ):
                    with _dev_preview_adoption_transition_lock(
                        namespace, adoption_deployment
                    ):
                        if (
                            adoption_holder is None
                            or adoption_coordination is None
                            or not _dev_preview_adoption_is_current(
                                custom,
                                adoption_coordination,
                                namespace=namespace,
                                sandbox_name=sandbox_name,
                                deployment=adoption_deployment,
                                holder=adoption_holder,
                            )
                        ):
                            raise RuntimeError(
                                "adoption ownership changed before synchronous cutover"
                            )
                        _adopt_scale_deployment_down(
                            apps,
                            namespace=namespace,
                            name=adoption_deployment,
                        )
        except Exception as readiness_error:
            if body.previewNative and body.adoptDeployment:
                try:
                    context = _dev_preview_teardown_context(
                        custom,
                        namespace=namespace,
                        sandbox_name=sandbox_name,
                        requested_execution_id=body.executionId,
                        requested_service=_dev_preview_service_label(body.service),
                    )
                    _teardown_dev_preview_resources(
                        namespace=namespace,
                        sandbox_name=sandbox_name,
                        context=context,
                    )
                except Exception as cleanup_error:
                    raise HTTPException(
                        status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                        detail=(
                            "adopted dev-preview readiness failed and compensating "
                            "teardown could not be proven"
                        ),
                    ) from cleanup_error
            if isinstance(readiness_error, HTTPException):
                raise readiness_error
            raise HTTPException(
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                detail="dev-preview readiness check failed before cutover",
            ) from readiness_error

        # Start cutover only after the synchronous request has proved the exact dev
        # pod Ready (and daprd-present when required). A queued/timed-out request can
        # therefore never cut production over minutes after its caller saw failure.
        if (
            body.previewNative
            and not body.stageAdoption
            and adoption_deployment in DEV_PREVIEW_DEFERRED_CUTOVER_DEPLOYMENTS
            and adoption_holder is not None
        ):
            threading.Thread(
                target=_adopt_deferred_scale_down,
                kwargs={
                    "namespace": namespace,
                    "deployment": adoption_deployment,
                    "execution_id": body.executionId,
                    "sandbox_name": sandbox_name,
                    "holder": adoption_holder,
                    "wait_seconds": body.waitReadySeconds,
                    "service": body.service,
                    "needs_dapr": body.needsDapr,
                },
                daemon=True,
                name=f"dev-preview-cutover-{sandbox_name}",
            ).start()
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
        "staged": bool(body.stageAdoption and readiness_status == "ready"),
    }
    set_current_span_io("output", response)
    return response


@dataclass(frozen=True)
class _DevPreviewRoutingSurface:
    name: str
    selector: tuple[tuple[str, str], ...]


@dataclass(frozen=True)
class _StagedDevPreviewAdoption:
    execution_id: str
    sandbox_name: str
    service: str
    deployment: str
    holder: str
    needs_dapr: bool
    active_selector: tuple[tuple[str, str], ...]
    routing_surfaces: tuple[_DevPreviewRoutingSurface, ...]
    gate_key: str
    staged_gate_value: str
    pod_name: str
    pod_ip: str
    gate_active: bool


def _staged_member_selector(member: _StagedDevPreviewAdoption) -> dict[str, str]:
    return dict(member.active_selector)


def _staged_member_routing_surfaces(
    member: _StagedDevPreviewAdoption,
) -> tuple[_DevPreviewRoutingSurface, ...]:
    if not member.routing_surfaces:
        raise RuntimeError(f"routing surfaces are missing for {member.sandbox_name}")
    return member.routing_surfaces


def _read_dev_preview_routing_surfaces(
    core: Any,
    *,
    namespace: str,
    service: str,
    pod_annotations: dict[str, Any],
    active_selector: dict[str, str],
    gate_key: str,
) -> tuple[_DevPreviewRoutingSurface, ...]:
    names = [service]
    if pod_annotations.get("dapr.io/enabled") == "true":
        dapr_app_id = pod_annotations.get("dapr.io/app-id")
        if (
            not isinstance(dapr_app_id, str)
            or dapr_app_id != service
            or _safe_name(dapr_app_id, max_length=63) != dapr_app_id
        ):
            raise ValueError("adopted Dapr app-id is not the canonical service")
        names.append(_safe_resource_name(f"{dapr_app_id}-dapr"))
    surfaces: list[_DevPreviewRoutingSurface] = []
    for name in dict.fromkeys(names):
        observed = core.read_namespaced_service(name=name, namespace=namespace)
        selector = _canonical_adopt_selector(
            dict(observed.spec.selector or {}) if observed.spec else None
        )
        if selector.get(gate_key) != active_selector[gate_key]:
            raise ValueError(
                f"routing Service {name} is not controlled by the staged gate"
            )
        surfaces.append(
            _DevPreviewRoutingSurface(
                name=name,
                selector=tuple(selector.items()),
            )
        )
    return tuple(surfaces)


def _dev_preview_batch_id(execution_id: str, sandbox_names: list[str]) -> str:
    payload = json.dumps(
        {"executionId": execution_id, "sandboxNames": sorted(sandbox_names)},
        sort_keys=True,
        separators=(",", ":"),
    )
    return f"sha256:{sha256(payload.encode('utf-8')).hexdigest()}"


def _dev_preview_batch_anchor(
    members: tuple[_StagedDevPreviewAdoption, ...],
) -> _StagedDevPreviewAdoption:
    if not members:
        raise ValueError("activation batch requires at least one member")
    return min(members, key=lambda member: member.sandbox_name)


def _validate_staged_dev_preview_batch(
    custom: Any,
    coordination: Any,
    core: Any,
    *,
    namespace: str,
    execution_id: str,
    sandbox_names: list[str] | tuple[str, ...],
) -> tuple[_StagedDevPreviewAdoption, ...]:
    """Validate the complete staged set without mutating any workload."""

    requested = tuple(sorted(sandbox_names))
    if len(set(requested)) != len(requested) or any(
        not name or _safe_resource_name(name, max_length=63) != name
        for name in requested
    ):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="activation sandboxNames must be unique exact resource names",
        )

    execution_label = _safe_name(execution_id, max_length=63)
    try:
        listed = custom.list_namespaced_custom_object(
            group="agents.x-k8s.io",
            version="v1alpha1",
            namespace=namespace,
            plural="sandboxes",
            label_selector=(
                f"app=wfb-dev-preview,"
                f"{DEV_PREVIEW_MANAGED_LABEL}={DEV_PREVIEW_MANAGED_VALUE},"
                f"workflow-execution-id={execution_label}"
            ),
        )
    except Exception as exc:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="could not enumerate the staged dev-preview batch",
        ) from exc
    actual_staged: list[str] = []
    for item in (listed.get("items") or []) if isinstance(listed, dict) else []:
        metadata = (item.get("metadata", {}) or {}) if isinstance(item, dict) else {}
        annotations = metadata.get("annotations", {}) or {}
        name = metadata.get("name")
        if annotations.get(DEV_PREVIEW_ADOPT_STAGED_ANNOTATION) and isinstance(
            name, str
        ):
            actual_staged.append(name)
    if tuple(sorted(actual_staged)) != requested:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="activation sandboxNames do not match the complete staged set",
        )

    members: list[_StagedDevPreviewAdoption] = []
    for sandbox_name in requested:
        try:
            cr = custom.get_namespaced_custom_object(
                group="agents.x-k8s.io",
                version="v1alpha1",
                namespace=namespace,
                plural="sandboxes",
                name=sandbox_name,
            )
        except Exception as exc:
            code = (
                status.HTTP_409_CONFLICT
                if getattr(exc, "status", None) == 404
                else status.HTTP_503_SERVICE_UNAVAILABLE
            )
            raise HTTPException(
                status_code=code,
                detail=f"could not read staged dev preview {sandbox_name}",
            ) from exc
        metadata = (cr.get("metadata", {}) or {}) if isinstance(cr, dict) else {}
        labels = metadata.get("labels", {}) or {}
        annotations = metadata.get("annotations", {}) or {}
        service = labels.get("dev-preview-service")
        if not isinstance(service, str) or service != _dev_preview_service_label(service):
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail=f"staged dev preview {sandbox_name} has an invalid service",
            )
        holder = _adopt_lease_holder(execution_id, service)
        deployment = annotations.get(DEV_PREVIEW_ADOPT_DEPLOYMENT_ANNOTATION)
        expected_name = _dev_preview_sandbox_name(execution_id, service)
        if (
            metadata.get("name") != sandbox_name
            or metadata.get("namespace") not in (None, namespace)
            or labels.get("app") != "wfb-dev-preview"
            or labels.get(DEV_PREVIEW_MANAGED_LABEL) != DEV_PREVIEW_MANAGED_VALUE
            or labels.get("workflow-execution-id") != execution_label
            or sandbox_name != expected_name
            or deployment != _safe_resource_name(service)
            or annotations.get(DEV_PREVIEW_ADOPT_HOLDER_ANNOTATION) != holder
            or annotations.get(DEV_PREVIEW_ADOPT_STAGED_ANNOTATION) != holder
            or annotations.get(DEV_PREVIEW_ADOPT_CUTOVER_CANCELLED_ANNOTATION)
            or annotations.get("wfb-dev-preview/adopt-lease")
            != _adopt_lease_name(deployment or "")
        ):
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail=f"staged dev preview {sandbox_name} has a mismatched tuple",
            )

        try:
            stored_selector = _canonical_adopt_selector(
                json.loads(
                    str(
                        annotations.get(DEV_PREVIEW_ADOPT_SELECTOR_ANNOTATION) or ""
                    )
                )
            )
        except (TypeError, ValueError, json.JSONDecodeError) as exc:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail=f"staged dev preview {sandbox_name} has an invalid selector contract",
            ) from exc
        gate_key = annotations.get(DEV_PREVIEW_ADOPT_GATE_KEY_ANNOTATION)
        staged_gate_value = annotations.get(
            DEV_PREVIEW_ADOPT_GATE_STAGED_VALUE_ANNOTATION
        )
        if (
            not isinstance(gate_key, str)
            or gate_key not in stored_selector
            or not isinstance(staged_gate_value, str)
            or not staged_gate_value
            or staged_gate_value == stored_selector[gate_key]
        ):
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail=f"staged dev preview {sandbox_name} has an invalid selector gate",
            )
        cr_spec = (cr.get("spec") or {}) if isinstance(cr, dict) else {}
        pod_template = cr_spec.get("podTemplate") or {}
        pod_metadata = pod_template.get("metadata") or {}
        pod_annotations = pod_metadata.get("annotations") or {}
        needs_dapr = pod_annotations.get("dapr.io/enabled") == "true"
        try:
            routing_surfaces = _read_dev_preview_routing_surfaces(
                core,
                namespace=namespace,
                service=service,
                pod_annotations=pod_annotations,
                active_selector=stored_selector,
                gate_key=gate_key,
            )
        except ValueError as exc:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail=f"adopted routing Service contract drifted for {sandbox_name}",
            ) from exc
        except Exception as exc:
            raise HTTPException(
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                detail=f"could not verify adopted routing Services for {sandbox_name}",
            ) from exc
        if dict(routing_surfaces[0].selector) != stored_selector:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail=f"adopted Service selector drifted for {sandbox_name}",
            )

        try:
            lease = coordination.read_namespaced_lease(
                name=_adopt_lease_name(deployment), namespace=namespace
            )
        except Exception as exc:
            code = (
                status.HTTP_409_CONFLICT
                if getattr(exc, "status", None) == 404
                else status.HTTP_503_SERVICE_UNAVAILABLE
            )
            raise HTTPException(
                status_code=code,
                detail=f"could not read staged adoption Lease for {sandbox_name}",
            ) from exc
        lease_name, lease_holder, lease_deployment, lease_execution, lease_rv = (
            _adopt_lease_identity(lease)
        )
        lease_metadata = _adopt_value(lease, "metadata")
        lease_annotations = _adopt_value(lease_metadata, "annotations") or {}
        lease_labels = _adopt_value(lease_metadata, "labels") or {}
        if (
            lease_name != _adopt_lease_name(deployment)
            or _adopt_value(lease_metadata, "namespace") != namespace
            or lease_holder != holder
            or lease_deployment != deployment
            or lease_execution != execution_id
            or not lease_rv
            or lease_annotations.get(DEV_PREVIEW_ADOPT_HOLDER_ANNOTATION) != holder
            or lease_annotations.get(DEV_PREVIEW_ADOPT_SERVICE_ANNOTATION) != service
            or lease_labels.get("app") != DEV_PREVIEW_ADOPTION_LEASE_LABEL
            or lease_labels.get(DEV_PREVIEW_ADOPT_DEPLOYMENT_ANNOTATION)
            != deployment
            or lease_labels.get("dev-preview-service") != service
        ):
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail=f"staged adoption Lease for {sandbox_name} is mismatched",
            )

        try:
            ready_pod = _ready_dev_preview_pod(
                core,
                namespace=namespace,
                execution_id=execution_id,
                service=service,
                pod_ip=None,
            )
        except Exception as exc:
            raise HTTPException(
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                detail=f"could not verify staged pod readiness for {sandbox_name}",
            ) from exc
        if ready_pod is None or (needs_dapr and not _dev_pod_has_daprd(ready_pod)):
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail=f"staged dev preview {sandbox_name} is not fully ready",
            )
        ready_metadata = _adopt_value(ready_pod, "metadata")
        ready_labels = _adopt_value(ready_metadata, "labels") or {}
        pod_name = str(_adopt_value(ready_metadata, "name") or "")
        pod_status = _adopt_value(ready_pod, "status")
        pod_ip = str(_adopt_value(pod_status, "pod_ip", "podIP") or "")
        gate_value = ready_labels.get(gate_key)
        for surface in routing_surfaces:
            for key, value in surface.selector:
                if key != gate_key and ready_labels.get(key) != value:
                    raise HTTPException(
                        status_code=status.HTTP_409_CONFLICT,
                        detail=(
                            f"staged dev preview {sandbox_name} has routing selector drift"
                        ),
                    )
        if gate_value not in (staged_gate_value, stored_selector[gate_key]):
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail=f"staged dev preview {sandbox_name} has an invalid live gate",
            )
        if not pod_name or not pod_ip:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail=f"staged dev preview {sandbox_name} has no exact ready pod identity",
            )
        members.append(
            _StagedDevPreviewAdoption(
                execution_id=execution_id,
                sandbox_name=sandbox_name,
                service=service,
                deployment=deployment,
                holder=holder,
                needs_dapr=needs_dapr,
                active_selector=tuple(stored_selector.items()),
                routing_surfaces=routing_surfaces,
                gate_key=gate_key,
                staged_gate_value=staged_gate_value,
                pod_name=pod_name,
                pod_ip=pod_ip,
                gate_active=gate_value == stored_selector[gate_key],
            )
        )
    return tuple(members)


def _dev_preview_batch_annotations(
    *,
    execution_id: str,
    sandbox_names: list[str],
    batch_id: str,
    phase: str,
    error_code: str | None = None,
) -> dict[str, str | None]:
    return {
        DEV_PREVIEW_ADOPT_BATCH_ID_ANNOTATION: batch_id,
        DEV_PREVIEW_ADOPT_BATCH_NAMES_ANNOTATION: json.dumps(
            sorted(sandbox_names), separators=(",", ":")
        ),
        DEV_PREVIEW_ADOPT_BATCH_EXECUTION_ANNOTATION: execution_id,
        DEV_PREVIEW_ADOPT_BATCH_PHASE_ANNOTATION: phase,
        DEV_PREVIEW_ADOPT_BATCH_ERROR_ANNOTATION: error_code,
        DEV_PREVIEW_ADOPT_BATCH_UPDATED_ANNOTATION: datetime.now(UTC)
        .isoformat(timespec="seconds")
        .replace("+00:00", "Z"),
    }


def _read_dev_preview_batch_phase(
    custom: Any,
    *,
    namespace: str,
    members: tuple[_StagedDevPreviewAdoption, ...],
    execution_id: str,
    sandbox_names: list[str],
    batch_id: str,
) -> tuple[str | None, str | None]:
    anchor = _dev_preview_batch_anchor(members)
    cr = custom.get_namespaced_custom_object(
        group="agents.x-k8s.io",
        version="v1alpha1",
        namespace=namespace,
        plural="sandboxes",
        name=anchor.sandbox_name,
    )
    metadata = (cr.get("metadata", {}) or {}) if isinstance(cr, dict) else {}
    annotations = metadata.get("annotations", {}) or {}
    if (
        annotations.get(DEV_PREVIEW_ADOPT_HOLDER_ANNOTATION) != anchor.holder
        or annotations.get(DEV_PREVIEW_ADOPT_STAGED_ANNOTATION) != anchor.holder
    ):
        raise RuntimeError("activation anchor ownership changed")
    phase = annotations.get(DEV_PREVIEW_ADOPT_BATCH_PHASE_ANNOTATION)
    observed_batch_id = annotations.get(DEV_PREVIEW_ADOPT_BATCH_ID_ANNOTATION)
    if phase is None and observed_batch_id is None:
        return None, None
    try:
        observed_names = json.loads(
            str(annotations.get(DEV_PREVIEW_ADOPT_BATCH_NAMES_ANNOTATION) or "")
        )
    except json.JSONDecodeError as exc:
        raise RuntimeError("activation anchor has malformed batch names") from exc
    if (
        observed_batch_id != batch_id
        or annotations.get(DEV_PREVIEW_ADOPT_BATCH_EXECUTION_ANNOTATION)
        != execution_id
        or observed_names != sorted(sandbox_names)
        or phase
        not in (
            _DEV_PREVIEW_ADOPT_BATCH_PENDING_PHASES
            | _DEV_PREVIEW_ADOPT_BATCH_TERMINAL_PHASES
        )
    ):
        raise RuntimeError("activation anchor batch identity changed")
    error_code = annotations.get(DEV_PREVIEW_ADOPT_BATCH_ERROR_ANNOTATION)
    return str(phase), str(error_code) if error_code else None


def _set_dev_preview_batch_phase(
    custom: Any,
    *,
    namespace: str,
    members: tuple[_StagedDevPreviewAdoption, ...],
    execution_id: str,
    sandbox_names: list[str],
    batch_id: str,
    phase: str,
    allowed_from: set[str | None],
    error_code: str | None = None,
    attempts: int = 5,
) -> None:
    if phase not in (
        _DEV_PREVIEW_ADOPT_BATCH_PENDING_PHASES
        | _DEV_PREVIEW_ADOPT_BATCH_TERMINAL_PHASES
    ):
        raise ValueError(f"unsupported activation phase {phase}")
    anchor = _dev_preview_batch_anchor(members)
    for _attempt in range(max(attempts, 1)):
        cr = custom.get_namespaced_custom_object(
            group="agents.x-k8s.io",
            version="v1alpha1",
            namespace=namespace,
            plural="sandboxes",
            name=anchor.sandbox_name,
        )
        metadata = (cr.get("metadata", {}) or {}) if isinstance(cr, dict) else {}
        annotations = metadata.get("annotations", {}) or {}
        resource_version = metadata.get("resourceVersion")
        if (
            annotations.get(DEV_PREVIEW_ADOPT_HOLDER_ANNOTATION) != anchor.holder
            or annotations.get(DEV_PREVIEW_ADOPT_STAGED_ANNOTATION) != anchor.holder
            or not isinstance(resource_version, str)
            or not resource_version
        ):
            raise RuntimeError("activation anchor ownership is not exact")
        current_phase = annotations.get(DEV_PREVIEW_ADOPT_BATCH_PHASE_ANNOTATION)
        current_batch_id = annotations.get(DEV_PREVIEW_ADOPT_BATCH_ID_ANNOTATION)
        if current_phase == phase and current_batch_id == batch_id:
            return
        if current_phase not in allowed_from:
            raise RuntimeError(
                f"activation phase transition {current_phase!r} -> {phase!r} is not allowed"
            )
        if current_batch_id not in (None, "", batch_id):
            raise RuntimeError("activation anchor is owned by another batch")
        try:
            custom.patch_namespaced_custom_object(
                group="agents.x-k8s.io",
                version="v1alpha1",
                namespace=namespace,
                plural="sandboxes",
                name=anchor.sandbox_name,
                body={
                    "metadata": {
                        "resourceVersion": resource_version,
                        "annotations": _dev_preview_batch_annotations(
                            execution_id=execution_id,
                            sandbox_names=sandbox_names,
                            batch_id=batch_id,
                            phase=phase,
                            error_code=error_code,
                        ),
                    }
                },
            )
            observed_phase, observed_error = _read_dev_preview_batch_phase(
                custom,
                namespace=namespace,
                members=members,
                execution_id=execution_id,
                sandbox_names=sandbox_names,
                batch_id=batch_id,
            )
            if observed_phase == phase and observed_error == error_code:
                return
            raise RuntimeError("activation phase mutation was not observed")
        except Exception as exc:
            if getattr(exc, "status", None) == 409:
                continue
            raise
    raise RuntimeError("activation phase update conflicted repeatedly")


def _ready_endpoint_identities(endpoints: Any) -> set[tuple[str, str]]:
    identities: set[tuple[str, str]] = set()
    subsets = _adopt_value(endpoints, "subsets") or []
    for subset in subsets:
        for address in _adopt_value(subset, "addresses") or []:
            target = _adopt_value(address, "target_ref", "targetRef")
            identities.add(
                (
                    str(_adopt_value(target, "name") or ""),
                    str(_adopt_value(address, "ip") or ""),
                )
            )
    return identities


def _wait_for_adopted_service_endpoints(
    core: Any,
    *,
    namespace: str,
    service: str,
    expected_pod: tuple[str, str] | None,
    require_any: bool = False,
    timeout_s: float = 30.0,
) -> None:
    deadline = time.monotonic() + max(timeout_s, 0)
    while True:
        endpoints = core.read_namespaced_endpoints(name=service, namespace=namespace)
        identities = _ready_endpoint_identities(endpoints)
        if (
            expected_pod is None
            and not require_any
            and not identities
        ) or (
            expected_pod is not None and identities == {expected_pod}
        ) or (require_any and bool(identities)):
            return
        if time.monotonic() >= deadline:
            expectation = (
                "the dev pod"
                if expected_pod is not None
                else "at least one Ready endpoint"
                if require_any
                else "no Ready endpoint"
            )
            raise RuntimeError(
                f"Service {service} did not converge to {expectation}"
            )
        time.sleep(0.1)


def _wait_for_service_without_managed_dev_preview_endpoints(
    core: Any,
    *,
    namespace: str,
    service: str,
    active_selector: dict[str, str],
    timeout_s: float = 30.0,
) -> None:
    """Allow current production endpoints, but reject managed or stale dev pods."""

    label_selector = ",".join(
        f"{key}={value}" for key, value in sorted(active_selector.items())
    )
    deadline = time.monotonic() + max(timeout_s, 0)
    while True:
        selected_pods = core.list_namespaced_pod(
            namespace=namespace, label_selector=label_selector
        ).items
        allowed: set[tuple[str, str]] = set()
        for pod in selected_pods:
            metadata = _adopt_value(pod, "metadata")
            labels = _adopt_value(metadata, "labels") or {}
            status_value = _adopt_value(pod, "status")
            identity = (
                str(_adopt_value(metadata, "name") or ""),
                str(_adopt_value(status_value, "pod_ip", "podIP") or ""),
            )
            if (
                labels.get(DEV_PREVIEW_MANAGED_LABEL)
                != DEV_PREVIEW_MANAGED_VALUE
                and all(identity)
            ):
                allowed.add(identity)
        endpoints = core.read_namespaced_endpoints(
            name=service, namespace=namespace
        )
        identities = _ready_endpoint_identities(endpoints)
        if identities <= allowed:
            return
        if time.monotonic() >= deadline:
            raise RuntimeError(
                f"Service {service} retained a managed or stale dev-preview endpoint"
            )
        time.sleep(0.1)


def _set_staged_dev_preview_gate(
    custom: Any,
    core: Any,
    *,
    namespace: str,
    member: _StagedDevPreviewAdoption,
    active: bool,
    require_exact_pod: bool = True,
    timeout_s: float = 30.0,
) -> None:
    selector = _staged_member_selector(member)
    target_value = (
        selector[member.gate_key] if active else member.staged_gate_value
    )
    for _attempt in range(5):
        cr = custom.get_namespaced_custom_object(
            group="agents.x-k8s.io",
            version="v1alpha1",
            namespace=namespace,
            plural="sandboxes",
            name=member.sandbox_name,
        )
        metadata = (cr.get("metadata", {}) or {}) if isinstance(cr, dict) else {}
        annotations = metadata.get("annotations", {}) or {}
        resource_version = metadata.get("resourceVersion")
        observed_holder = annotations.get(
            DEV_PREVIEW_ADOPT_HOLDER_ANNOTATION
        ) or annotations.get(DEV_PREVIEW_ADOPT_CUTOVER_CANCELLED_ANNOTATION)
        if (
            observed_holder != member.holder
            or annotations.get(DEV_PREVIEW_ADOPT_SELECTOR_ANNOTATION)
            != json.dumps(selector, sort_keys=True, separators=(",", ":"))
            or annotations.get(DEV_PREVIEW_ADOPT_GATE_KEY_ANNOTATION)
            != member.gate_key
            or annotations.get(DEV_PREVIEW_ADOPT_GATE_STAGED_VALUE_ANNOTATION)
            != member.staged_gate_value
            or not isinstance(resource_version, str)
            or not resource_version
        ):
            raise RuntimeError(f"selector ownership changed for {member.sandbox_name}")
        pod_template = ((cr.get("spec") or {}).get("podTemplate") or {})
        template_labels = ((pod_template.get("metadata") or {}).get("labels") or {})
        if template_labels.get(member.gate_key) != target_value:
            try:
                custom.patch_namespaced_custom_object(
                    group="agents.x-k8s.io",
                    version="v1alpha1",
                    namespace=namespace,
                    plural="sandboxes",
                    name=member.sandbox_name,
                    body={
                        "metadata": {"resourceVersion": resource_version},
                        "spec": {
                            "podTemplate": {
                                "metadata": {
                                    "labels": {member.gate_key: target_value}
                                }
                            }
                        },
                    },
                )
            except Exception as exc:
                if getattr(exc, "status", None) == 409:
                    continue
                raise
        break
    else:
        raise RuntimeError(f"selector gate update conflicted for {member.sandbox_name}")

    deadline = time.monotonic() + max(timeout_s, 0)
    while True:
        pods = core.list_namespaced_pod(
            namespace=namespace,
            label_selector=(
                f"{DEV_PREVIEW_MANAGED_LABEL}={DEV_PREVIEW_MANAGED_VALUE},"
                f"workflow-execution-id={_safe_name(member.execution_id, max_length=63)},"
                f"dev-preview-service={member.service}"
            ),
        ).items
        observed = next(
            (
                pod
                for pod in pods
                if str(_adopt_value(_adopt_value(pod, "metadata"), "name") or "")
                == member.pod_name
            ),
            None,
        )
        observed_labels = (
            _adopt_value(_adopt_value(observed, "metadata"), "labels") or {}
            if observed is not None
            else {}
        )
        managed_pods_converged = all(
            (
                (
                    _adopt_value(_adopt_value(pod, "metadata"), "labels") or {}
                ).get(DEV_PREVIEW_MANAGED_LABEL)
                == DEV_PREVIEW_MANAGED_VALUE
                and (
                    _adopt_value(_adopt_value(pod, "metadata"), "labels") or {}
                ).get(member.gate_key)
                == target_value
            )
            for pod in pods
        )
        if (
            require_exact_pod
            and observed_labels.get(DEV_PREVIEW_MANAGED_LABEL)
            == DEV_PREVIEW_MANAGED_VALUE
            and observed_labels.get(member.gate_key) == target_value
        ) or (not require_exact_pod and managed_pods_converged):
            break
        if time.monotonic() >= deadline:
            raise RuntimeError(
                f"selector gate did not propagate for {member.sandbox_name}"
            )
        time.sleep(0.1)

    if not active:
        # A staged template can still have a lagging Endpoint for a deleted active
        # pod. Permit only live non-managed pods, which preserves an already-running
        # production Deployment without accepting a stale dev endpoint.
        for surface in _staged_member_routing_surfaces(member):
            _wait_for_service_without_managed_dev_preview_endpoints(
                core,
                namespace=namespace,
                service=surface.name,
                active_selector=dict(surface.selector),
                timeout_s=timeout_s,
            )
    elif require_exact_pod:
        for surface in _staged_member_routing_surfaces(member):
            _wait_for_adopted_service_endpoints(
                core,
                namespace=namespace,
                service=surface.name,
                expected_pod=(member.pod_name, member.pod_ip),
                timeout_s=timeout_s,
            )


def _activate_staged_dev_preview_batch(
    *,
    namespace: str,
    execution_id: str,
    sandbox_names: list[str],
    batch_id: str,
) -> None:
    """Converge one durable staged batch to active or a proven failed rollback."""

    delay = _env_int("DEV_PREVIEW_BATCH_ACTIVATION_DELAY_SECONDS", 15, minimum=1)
    time.sleep(delay)
    try:
        apps = _load_k8s_apps_client()
        _, core = _load_k8s_clients()
        custom = _load_k8s_custom_objects_client()
        coordination = _load_k8s_coordination_client()
    except Exception as exc:
        logger.warning("adopt: batch activation could not load clients: %s", exc)
        # The durable scheduled/activating phase remains retryable. A later
        # idempotent POST or the next SEA startup will redrive it.
        return

    try:
        initial = _validate_staged_dev_preview_batch(
            custom,
            coordination,
            core,
            namespace=namespace,
            execution_id=execution_id,
            sandbox_names=sandbox_names,
        )
    except Exception as exc:
        logger.warning("adopt: batch activation could not revalidate: %s", exc)
        return

    with ExitStack() as locks:
        for deployment in sorted({member.deployment for member in initial}):
            locks.enter_context(
                _dev_preview_adoption_transition_lock(namespace, deployment)
            )
        try:
            current = _validate_staged_dev_preview_batch(
                custom,
                coordination,
                core,
                namespace=namespace,
                execution_id=execution_id,
                sandbox_names=sandbox_names,
            )
            phase, _error_code = _read_dev_preview_batch_phase(
                custom,
                namespace=namespace,
                members=current,
                execution_id=execution_id,
                sandbox_names=sandbox_names,
                batch_id=batch_id,
            )
            if phase == "active":
                return
            if phase == "failed":
                return
            if phase == "scheduled":
                _set_dev_preview_batch_phase(
                    custom,
                    namespace=namespace,
                    members=current,
                    execution_id=execution_id,
                    sandbox_names=sandbox_names,
                    batch_id=batch_id,
                    phase="activating",
                    allowed_from={"scheduled"},
                )
            elif phase != "activating":
                raise RuntimeError("staged batch was not durably scheduled")

            fully_released = phase == "activating" and all(
                member.gate_active for member in current
            )
            if fully_released:
                # A crash can occur after every gate reaches the live Service but
                # before the terminal phase patch. Prove the exact endpoints and
                # persist completion without draining a working batch again.
                for member in current:
                    for surface in _staged_member_routing_surfaces(member):
                        _wait_for_adopted_service_endpoints(
                            core,
                            namespace=namespace,
                            service=surface.name,
                            expected_pod=(member.pod_name, member.pod_ip),
                        )
            else:
                # A crash during gate release can leave a partial new service set.
                # Quarantine those endpoints before replaying the complete cutover.
                for member in current:
                    if member.gate_active:
                        _set_staged_dev_preview_gate(
                            custom,
                            core,
                            namespace=namespace,
                            member=member,
                            active=False,
                        )

                # The initiating BFF/router request has already returned. Drain the
                # complete old service set before exposing any staged pod, then use
                # Sandbox metadata reconciliation to release every gate.
                for member in current:
                    _adopt_scale_deployment_down(
                        apps, namespace=namespace, name=member.deployment
                    )
                for member in current:
                    for surface in _staged_member_routing_surfaces(member):
                        _wait_for_adopted_service_endpoints(
                            core,
                            namespace=namespace,
                            service=surface.name,
                            expected_pod=None,
                        )
                for member in current:
                    _set_staged_dev_preview_gate(
                        custom,
                        core,
                        namespace=namespace,
                        member=member,
                        active=True,
                    )
        except Exception as exc:
            logger.warning("adopt: batch activation failed for %s: %s", execution_id, exc)
            rollback_errors: list[str] = []
            rollback_members = current if "current" in locals() else initial
            quarantined_members: list[_StagedDevPreviewAdoption] = []
            # Remove every new endpoint before restoring the old Deployments. This
            # deliberately prefers a short isolated-preview outage over mixed code.
            for member in rollback_members:
                try:
                    _set_staged_dev_preview_gate(
                        custom,
                        core,
                        namespace=namespace,
                        member=member,
                        active=False,
                    )
                    quarantined_members.append(member)
                except Exception as quarantine_error:
                    rollback_errors.append(member.service)
                    logger.warning(
                        "adopt: batch rollback failed quarantining %s: %s",
                        member.sandbox_name,
                        quarantine_error,
                    )
            # Never restore an old Deployment beside an unproven dev endpoint.
            # An incomplete quarantine leaves that one Service unavailable and
            # preserves a terminal receipt for operator recovery instead of mixing
            # two code versions behind the same selector.
            for member in quarantined_members:
                try:
                    _adopt_restore_deployment(
                        apps, namespace=namespace, name=member.deployment
                    )
                    for surface in _staged_member_routing_surfaces(member):
                        _wait_for_adopted_service_endpoints(
                            core,
                            namespace=namespace,
                            service=surface.name,
                            expected_pod=None,
                            require_any=True,
                        )
                except Exception as restore_error:
                    rollback_errors.append(member.deployment)
                    logger.warning(
                        "adopt: batch rollback failed restoring %s: %s",
                        member.deployment,
                        restore_error,
                    )
            try:
                _set_dev_preview_batch_phase(
                    custom,
                    namespace=namespace,
                    members=rollback_members,
                    execution_id=execution_id,
                    sandbox_names=sandbox_names,
                    batch_id=batch_id,
                    phase="failed",
                    allowed_from={"scheduled", "activating"},
                    error_code=(
                        "activation-rollback-incomplete"
                        if rollback_errors
                        else "activation-rolled-back"
                    ),
                )
            except Exception as state_error:
                logger.warning(
                    "adopt: batch failure state could not be persisted for %s: %s",
                    execution_id,
                    state_error,
                )
            return
        try:
            _set_dev_preview_batch_phase(
                custom,
                namespace=namespace,
                members=current,
                execution_id=execution_id,
                sandbox_names=sandbox_names,
                batch_id=batch_id,
                phase="active",
                allowed_from={"activating"},
            )
        except Exception as exc:
            # Do not roll a working batch back only because its receipt patch raced a
            # status update. The durable `activating` phase is idempotently redriven.
            logger.warning(
                "adopt: activated batch %s but could not persist completion: %s",
                execution_id,
                exc,
            )
            return
    logger.info(
        "adopt: activated staged batch %s (%s services)", execution_id, len(current)
    )


def _dev_preview_activation_receipt(
    *,
    execution_id: str,
    sandbox_names: list[str],
    batch_id: str,
    phase: str,
) -> dict[str, Any]:
    active = phase == "active"
    pending = phase in _DEV_PREVIEW_ADOPT_BATCH_PENDING_PHASES
    return {
        "executionId": execution_id,
        "sandboxNames": sorted(sandbox_names),
        "batchId": batch_id,
        "activationPhase": phase,
        "accepted": active or pending,
        "complete": active,
        "pending": pending,
        "activated": active,
    }


def _start_dev_preview_activation_worker(
    *, namespace: str, execution_id: str, sandbox_names: list[str], batch_id: str
) -> None:
    with _DEV_PREVIEW_ACTIVATION_WORKERS_GUARD:
        if batch_id in _DEV_PREVIEW_ACTIVATION_WORKERS:
            return
        _DEV_PREVIEW_ACTIVATION_WORKERS.add(batch_id)

    def run() -> None:
        try:
            _activate_staged_dev_preview_batch(
                namespace=namespace,
                execution_id=execution_id,
                sandbox_names=sorted(sandbox_names),
                batch_id=batch_id,
            )
        finally:
            with _DEV_PREVIEW_ACTIVATION_WORKERS_GUARD:
                _DEV_PREVIEW_ACTIVATION_WORKERS.discard(batch_id)

    worker = threading.Thread(
        target=run,
        daemon=True,
        name=f"dev-preview-activate-{_safe_name(execution_id)}",
    )
    try:
        worker.start()
    except Exception:
        with _DEV_PREVIEW_ACTIVATION_WORKERS_GUARD:
            _DEV_PREVIEW_ACTIVATION_WORKERS.discard(batch_id)
        raise


def _resume_pending_dev_preview_activations() -> None:
    """One-shot restart recovery for the single-replica development POC."""
    if os.environ.get("SANDBOX_EXECUTION_DRY_RUN", "").lower() in {
        "1",
        "true",
        "yes",
    }:
        return
    try:
        namespace = _agent_workflow_host_namespace()
        custom = _load_k8s_custom_objects_client()
        listed = custom.list_namespaced_custom_object(
            group="agents.x-k8s.io",
            version="v1alpha1",
            namespace=namespace,
            plural="sandboxes",
            label_selector=(
                f"app=wfb-dev-preview,"
                f"{DEV_PREVIEW_MANAGED_LABEL}={DEV_PREVIEW_MANAGED_VALUE}"
            ),
        )
    except Exception as exc:
        logger.warning("adopt: activation recovery scan failed: %s", exc)
        return
    recovered: set[str] = set()
    for item in (listed.get("items") or []) if isinstance(listed, dict) else []:
        metadata = (item.get("metadata", {}) or {}) if isinstance(item, dict) else {}
        annotations = metadata.get("annotations", {}) or {}
        phase = annotations.get(DEV_PREVIEW_ADOPT_BATCH_PHASE_ANNOTATION)
        if phase not in _DEV_PREVIEW_ADOPT_BATCH_PENDING_PHASES:
            continue
        execution_id = annotations.get(DEV_PREVIEW_ADOPT_BATCH_EXECUTION_ANNOTATION)
        batch_id = annotations.get(DEV_PREVIEW_ADOPT_BATCH_ID_ANNOTATION)
        try:
            sandbox_names = json.loads(
                str(annotations.get(DEV_PREVIEW_ADOPT_BATCH_NAMES_ANNOTATION) or "")
            )
        except json.JSONDecodeError:
            continue
        if (
            not isinstance(execution_id, str)
            or not execution_id
            or not isinstance(batch_id, str)
            or not isinstance(sandbox_names, list)
            or not sandbox_names
            or any(not isinstance(name, str) or not name for name in sandbox_names)
            or sandbox_names != sorted(set(sandbox_names))
            or metadata.get("name") != min(sandbox_names)
            or batch_id != _dev_preview_batch_id(execution_id, sandbox_names)
            or batch_id in recovered
        ):
            logger.warning(
                "adopt: refusing malformed activation recovery anchor %s",
                metadata.get("name"),
            )
            continue
        recovered.add(batch_id)
        try:
            _start_dev_preview_activation_worker(
                namespace=namespace,
                execution_id=execution_id,
                sandbox_names=sandbox_names,
                batch_id=batch_id,
            )
        except Exception as exc:
            logger.warning(
                "adopt: activation recovery worker failed to start for %s: %s",
                execution_id,
                exc,
            )


def _start_dev_preview_activation_recovery() -> None:
    threading.Thread(
        target=_resume_pending_dev_preview_activations,
        daemon=True,
        name="dev-preview-activation-recovery",
    ).start()


@app.post("/internal/dev-previews/activate", status_code=status.HTTP_202_ACCEPTED)
def activate_dev_previews(
    request: Request, body: DevPreviewActivationRequest, response_status: Response
) -> dict[str, Any]:
    _require_internal(request)
    response_status.status_code = status.HTTP_202_ACCEPTED
    set_current_span_io("input", body.model_dump())
    names = sorted(body.sandboxNames)
    if os.environ.get("SANDBOX_EXECUTION_DRY_RUN", "").lower() in {
        "1",
        "true",
        "yes",
    }:
        response = _dev_preview_activation_receipt(
            execution_id=body.executionId,
            sandbox_names=names,
            batch_id=_dev_preview_batch_id(body.executionId, names),
            phase="active",
        )
        response_status.status_code = status.HTTP_200_OK
        set_current_span_io("output", response)
        return response
    namespace = _agent_workflow_host_namespace()
    batch_id = _dev_preview_batch_id(body.executionId, names)
    try:
        custom = _load_k8s_custom_objects_client()
        coordination = _load_k8s_coordination_client()
        _, core = _load_k8s_clients()
        expected = _validate_staged_dev_preview_batch(
            custom,
            coordination,
            core,
            namespace=namespace,
            execution_id=body.executionId,
            sandbox_names=names,
        )
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="could not validate staged dev-preview activation",
        ) from exc
    with ExitStack() as locks:
        for deployment in sorted({member.deployment for member in expected}):
            locks.enter_context(
                _dev_preview_adoption_transition_lock(namespace, deployment)
            )
        try:
            expected = _validate_staged_dev_preview_batch(
                custom,
                coordination,
                core,
                namespace=namespace,
                execution_id=body.executionId,
                sandbox_names=names,
            )
            phase, error_code = _read_dev_preview_batch_phase(
                custom,
                namespace=namespace,
                members=expected,
                execution_id=body.executionId,
                sandbox_names=names,
                batch_id=batch_id,
            )
            if phase is None:
                _set_dev_preview_batch_phase(
                    custom,
                    namespace=namespace,
                    members=expected,
                    execution_id=body.executionId,
                    sandbox_names=names,
                    batch_id=batch_id,
                    phase="scheduled",
                    allowed_from={None},
                )
                phase = "scheduled"
            if phase == "failed":
                raise HTTPException(
                    status_code=status.HTTP_409_CONFLICT,
                    detail=(
                        "staged dev-preview activation failed"
                        + (f" ({error_code})" if error_code else "")
                    ),
                )
            if phase == "active":
                response = _dev_preview_activation_receipt(
                    execution_id=body.executionId,
                    sandbox_names=names,
                    batch_id=batch_id,
                    phase=phase,
                )
                response_status.status_code = status.HTTP_200_OK
                set_current_span_io("output", response)
                return response
            try:
                _start_dev_preview_activation_worker(
                    namespace=namespace,
                    execution_id=body.executionId,
                    sandbox_names=names,
                    batch_id=batch_id,
                )
            except Exception as exc:
                try:
                    _set_dev_preview_batch_phase(
                        custom,
                        namespace=namespace,
                        members=expected,
                        execution_id=body.executionId,
                        sandbox_names=names,
                        batch_id=batch_id,
                        phase="failed",
                        allowed_from={"scheduled", "activating"},
                        error_code="activation-worker-not-started",
                    )
                except Exception as state_error:
                    logger.warning(
                        "adopt: could not persist worker-start failure: %s", state_error
                    )
                raise HTTPException(
                    status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                    detail="staged dev-preview activation was not scheduled",
                ) from exc
        except HTTPException:
            raise
        except Exception as exc:
            raise HTTPException(
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                detail="could not establish staged dev-preview activation state",
            ) from exc
    response = _dev_preview_activation_receipt(
        execution_id=body.executionId,
        sandbox_names=names,
        batch_id=batch_id,
        phase=phase,
    )
    set_current_span_io("output", response)
    return response


def _cancel_dev_preview_deferred_cutover(
    custom: Any,
    *,
    namespace: str,
    sandbox_name: str,
    holder: str,
    attempts: int = 3,
) -> bool:
    """Revoke a pending response-path cutover before acknowledging teardown.

    The active holder is moved, rather than discarded, so a later retry can still
    release the exact Lease if SEA restarts after accepting deferred cleanup.
    Including resourceVersion makes each patch a compare-and-swap against the CR
    revision that carried the expected holder.
    """
    for _attempt in range(max(attempts, 1)):
        try:
            cr = custom.get_namespaced_custom_object(
                group="agents.x-k8s.io",
                version="v1alpha1",
                namespace=namespace,
                plural="sandboxes",
                name=sandbox_name,
            )
        except Exception as exc:
            if getattr(exc, "status", None) == 404:
                return True
            logger.warning(
                "adopt: could not read %s for cutover cancellation: %s",
                sandbox_name,
                exc,
            )
            return False
        metadata = (cr.get("metadata", {}) or {}) if isinstance(cr, dict) else {}
        annotations = metadata.get("annotations", {}) or {}
        active_holder = annotations.get(DEV_PREVIEW_ADOPT_HOLDER_ANNOTATION)
        cancelled_holder = annotations.get(
            DEV_PREVIEW_ADOPT_CUTOVER_CANCELLED_ANNOTATION
        )
        if not active_holder:
            return cancelled_holder == holder
        if active_holder != holder or cancelled_holder not in (None, "", holder):
            logger.warning(
                "adopt: refusing mismatched cutover cancellation for %s", sandbox_name
            )
            return False
        resource_version = metadata.get("resourceVersion")
        if not isinstance(resource_version, str) or not resource_version:
            logger.warning(
                "adopt: refusing cutover cancellation without resourceVersion for %s",
                sandbox_name,
            )
            return False
        try:
            custom.patch_namespaced_custom_object(
                group="agents.x-k8s.io",
                version="v1alpha1",
                namespace=namespace,
                plural="sandboxes",
                name=sandbox_name,
                body={
                    "metadata": {
                        "resourceVersion": resource_version,
                        "annotations": {
                            DEV_PREVIEW_ADOPT_HOLDER_ANNOTATION: None,
                            DEV_PREVIEW_ADOPT_CUTOVER_CANCELLED_ANNOTATION: holder,
                        },
                    }
                },
            )
        except Exception as exc:
            if getattr(exc, "status", None) == 409:
                continue
            if getattr(exc, "status", None) == 404:
                return True
            logger.warning(
                "adopt: cutover cancellation failed for %s: %s", sandbox_name, exc
            )
            return False
        try:
            observed = custom.get_namespaced_custom_object(
                group="agents.x-k8s.io",
                version="v1alpha1",
                namespace=namespace,
                plural="sandboxes",
                name=sandbox_name,
            )
        except Exception as exc:
            if getattr(exc, "status", None) == 404:
                return True
            logger.warning(
                "adopt: could not prove cutover cancellation for %s: %s",
                sandbox_name,
                exc,
            )
            return False
        observed_metadata = (
            (observed.get("metadata", {}) or {})
            if isinstance(observed, dict)
            else {}
        )
        observed_annotations = observed_metadata.get("annotations", {}) or {}
        if (
            not observed_annotations.get(DEV_PREVIEW_ADOPT_HOLDER_ANNOTATION)
            and observed_annotations.get(
                DEV_PREVIEW_ADOPT_CUTOVER_CANCELLED_ANNOTATION
            )
            == holder
        ):
            return True
        logger.warning(
            "adopt: cutover cancellation was not observed for %s", sandbox_name
        )
        return False
    logger.warning(
        "adopt: cutover cancellation conflicted repeatedly for %s", sandbox_name
    )
    return False


def _dev_preview_teardown_context(
    custom: Any,
    *,
    namespace: str,
    sandbox_name: str,
    requested_execution_id: str | None = None,
    requested_service: str | None = None,
) -> dict[str, str | None]:
    try:
        cr = custom.get_namespaced_custom_object(
            group="agents.x-k8s.io",
            version="v1alpha1",
            namespace=namespace,
            plural="sandboxes",
            name=sandbox_name,
        )
    except Exception as exc:
        if getattr(exc, "status", None) == 404:
            return {
                "execution": None,
                "service": None,
                "deployment": None,
                "holder": None,
                "secret": None,
                "uid": None,
                "resourceVersion": None,
                "requestedExecution": requested_execution_id,
                "requestedService": requested_service,
            }
        raise
    metadata = (cr.get("metadata", {}) or {}) if isinstance(cr, dict) else {}
    labels = metadata.get("labels", {}) or {}
    annotations = metadata.get("annotations", {}) or {}
    if (
        labels.get("app") != "wfb-dev-preview"
        or labels.get(DEV_PREVIEW_MANAGED_LABEL) != DEV_PREVIEW_MANAGED_VALUE
    ):
        raise RuntimeError("Sandbox is not managed by dev-preview teardown")
    holder = annotations.get(DEV_PREVIEW_ADOPT_HOLDER_ANNOTATION) or annotations.get(
        DEV_PREVIEW_ADOPT_CUTOVER_CANCELLED_ANNOTATION
    )
    return {
        "execution": labels.get("workflow-execution-id"),
        "service": labels.get("dev-preview-service"),
        "deployment": annotations.get(DEV_PREVIEW_ADOPT_DEPLOYMENT_ANNOTATION),
        "holder": holder,
        "secret": annotations.get(DEV_PREVIEW_SECRET_NAME_ANNOTATION),
        "uid": metadata.get("uid"),
        "resourceVersion": metadata.get("resourceVersion"),
        "requestedExecution": requested_execution_id,
        "requestedService": requested_service,
    }


def _validate_dev_preview_teardown_context(
    context: dict[str, str | None], *, execution_id: str, service: str
) -> None:
    expected_holder = _adopt_lease_holder(execution_id, service)
    deployment = context.get("deployment")
    holder = context.get("holder")
    secret = context.get("secret")
    if (
        not context.get("uid")
        or not context.get("resourceVersion")
        or context.get("execution") != _safe_name(execution_id, max_length=63)
        or context.get("service") != service
        or deployment not in (None, service)
        or (deployment is not None and holder != expected_holder)
        or (deployment is None and holder is not None)
        or secret not in (None, _dev_preview_secret_name(execution_id, service))
    ):
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="dev-preview teardown identity does not match the managed Sandbox",
        )


def _prove_dev_preview_teardown_owner(
    custom: Any,
    coordination: Any,
    *,
    namespace: str,
    sandbox_name: str,
    expected: dict[str, str | None],
) -> tuple[dict[str, Any], Any | None] | None:
    expected_uid = expected.get("uid")
    if not expected_uid:
        return None
    try:
        cr = custom.get_namespaced_custom_object(
            group="agents.x-k8s.io",
            version="v1alpha1",
            namespace=namespace,
            plural="sandboxes",
            name=sandbox_name,
        )
    except Exception as exc:
        if getattr(exc, "status", None) == 404:
            return None
        raise
    metadata = (cr.get("metadata", {}) or {}) if isinstance(cr, dict) else {}
    labels = metadata.get("labels", {}) or {}
    annotations = metadata.get("annotations", {}) or {}
    observed_holder = annotations.get(
        DEV_PREVIEW_ADOPT_HOLDER_ANNOTATION
    ) or annotations.get(DEV_PREVIEW_ADOPT_CUTOVER_CANCELLED_ANNOTATION)
    if (
        metadata.get("uid") != expected_uid
        or labels.get("app") != "wfb-dev-preview"
        or labels.get(DEV_PREVIEW_MANAGED_LABEL) != DEV_PREVIEW_MANAGED_VALUE
        or labels.get("workflow-execution-id") != expected.get("execution")
        or labels.get("dev-preview-service") != expected.get("service")
        or annotations.get(DEV_PREVIEW_ADOPT_DEPLOYMENT_ANNOTATION)
        != expected.get("deployment")
        or observed_holder != expected.get("holder")
        or annotations.get(DEV_PREVIEW_SECRET_NAME_ANNOTATION)
        != expected.get("secret")
    ):
        raise RuntimeError("dev-preview teardown ownership changed")
    deployment = expected.get("deployment")
    holder = expected.get("holder")
    if not deployment or not holder:
        return cr, None
    try:
        lease = coordination.read_namespaced_lease(
            name=_adopt_lease_name(deployment), namespace=namespace
        )
    except Exception as exc:
        if getattr(exc, "status", None) == 404:
            return cr, None
        raise
    lease_name, lease_holder, lease_deployment, _execution, _rv = (
        _adopt_lease_identity(lease)
    )
    if (
        lease_name != _adopt_lease_name(deployment)
        or lease_holder != holder
        or lease_deployment != deployment
    ):
        raise RuntimeError("dev-preview teardown Lease ownership changed")
    return cr, lease


def _dev_preview_gate_member_for_teardown(
    core: Any,
    *,
    namespace: str,
    cr: dict[str, Any],
    context: dict[str, str | None],
) -> _StagedDevPreviewAdoption | None:
    metadata = cr.get("metadata", {}) or {}
    annotations = metadata.get("annotations", {}) or {}
    selector_raw = annotations.get(DEV_PREVIEW_ADOPT_SELECTOR_ANNOTATION)
    if not selector_raw:
        return None
    try:
        selector = _canonical_adopt_selector(json.loads(str(selector_raw)))
    except (TypeError, ValueError, json.JSONDecodeError) as exc:
        raise RuntimeError("dev-preview teardown selector contract is invalid") from exc
    gate_key = annotations.get(DEV_PREVIEW_ADOPT_GATE_KEY_ANNOTATION)
    staged_value = annotations.get(DEV_PREVIEW_ADOPT_GATE_STAGED_VALUE_ANNOTATION)
    execution = context.get("execution")
    service = context.get("service")
    deployment = context.get("deployment")
    holder = context.get("holder")
    if (
        not isinstance(gate_key, str)
        or gate_key not in selector
        or not isinstance(staged_value, str)
        or not staged_value
        or not execution
        or not service
        or not deployment
        or not holder
    ):
        raise RuntimeError("dev-preview teardown selector identity is incomplete")
    pod_template = ((cr.get("spec") or {}).get("podTemplate") or {})
    pod_metadata = pod_template.get("metadata") or {}
    template_labels = pod_metadata.get("labels") or {}
    pod_annotations = pod_metadata.get("annotations") or {}
    template_gate_value = template_labels.get(gate_key)
    if template_gate_value not in (staged_value, selector[gate_key]):
        raise RuntimeError("dev-preview teardown selector gate is invalid")
    routing_surfaces = _read_dev_preview_routing_surfaces(
        core,
        namespace=namespace,
        service=service,
        pod_annotations=pod_annotations,
        active_selector=selector,
        gate_key=gate_key,
    )
    pods = core.list_namespaced_pod(
        namespace=namespace,
        label_selector=(
            f"{DEV_PREVIEW_MANAGED_LABEL}={DEV_PREVIEW_MANAGED_VALUE},"
            f"workflow-execution-id={execution},dev-preview-service={service}"
        ),
    ).items
    pod = next(iter(pods), None)
    pod_metadata = _adopt_value(pod, "metadata") if pod is not None else None
    pod_status = _adopt_value(pod, "status") if pod is not None else None
    pod_name = str(_adopt_value(pod_metadata, "name") or "")
    pod_ip = str(_adopt_value(pod_status, "pod_ip", "podIP") or "")
    return _StagedDevPreviewAdoption(
        execution_id=execution,
        sandbox_name=str(metadata.get("name") or ""),
        service=service,
        deployment=deployment,
        holder=holder,
        needs_dapr=pod_annotations.get("dapr.io/enabled") == "true",
        active_selector=tuple(selector.items()),
        routing_surfaces=routing_surfaces,
        gate_key=gate_key,
        staged_gate_value=staged_value,
        pod_name=pod_name,
        pod_ip=pod_ip,
        gate_active=template_gate_value == selector[gate_key],
    )


def _cleanup_dev_preview_support_resources_without_cr(
    core: Any,
    coordination: Any,
    *,
    namespace: str,
    execution_id: str,
    service: str,
) -> None:
    """Remove only support objects whose exact Sandbox owner is already absent."""

    _delete_dev_preview_secret_and_wait(
        core,
        namespace=namespace,
        name=_dev_preview_secret_name(execution_id, service),
        execution_id=_safe_name(execution_id, max_length=63),
        service=service,
    )
    if not _delete_dev_preview_adoption_lease(
        coordination,
        namespace=namespace,
        deployment=service,
        holder=_adopt_lease_holder(execution_id, service),
    ):
        raise RuntimeError(
            f"dev-preview adoption Lease cleanup was not proven for {service}"
        )


def _teardown_dev_preview_resources_locked(
    *,
    namespace: str,
    sandbox_name: str,
    context: dict[str, str | None],
) -> None:
    custom = _load_k8s_custom_objects_client()
    _, core = _load_k8s_clients()
    coordination = _load_k8s_coordination_client()
    execution = context.get("execution")
    service = context.get("service")
    deployment = context.get("deployment")
    holder = context.get("holder")
    secret_name = context.get("secret")

    proved = _prove_dev_preview_teardown_owner(
        custom,
        coordination,
        namespace=namespace,
        sandbox_name=sandbox_name,
        expected=context,
    )
    if proved is None:
        requested_execution = context.get("requestedExecution")
        requested_service = context.get("requestedService")
        if requested_execution and requested_service:
            _cleanup_dev_preview_support_resources_without_cr(
                core,
                coordination,
                namespace=namespace,
                execution_id=requested_execution,
                service=requested_service,
            )
        return
    cr, lease = proved

    # Preserve the Sandbox CR (and therefore its exact ownership tuple) until
    # restoration and Lease release both succeed. Deleting it first turns a
    # transient restore error into an ambiguous orphan with no retry context.
    if deployment:
        apps = _load_k8s_apps_client()
        gate_member = _dev_preview_gate_member_for_teardown(
            core, namespace=namespace, cr=cr, context=context
        )
        if gate_member is not None:
            _set_staged_dev_preview_gate(
                custom,
                core,
                namespace=namespace,
                member=gate_member,
                active=False,
                require_exact_pod=False,
            )
        _adopt_restore_deployment(apps, namespace=namespace, name=deployment)
        restore_surfaces = (
            _staged_member_routing_surfaces(gate_member)
            if gate_member is not None
            else (
                _DevPreviewRoutingSurface(
                    name=service or deployment,
                    selector=(),
                ),
            )
        )
        for surface in restore_surfaces:
            _wait_for_adopted_service_endpoints(
                core,
                namespace=namespace,
                service=surface.name,
                expected_pod=None,
                require_any=True,
            )

    # Secrets have no owner reference. Delete and prove them while the exact CR
    # and Lease still preserve retryable execution/service ownership evidence.
    if secret_name:
        if not execution or not service:
            raise RuntimeError("dev-preview Secret identity is incomplete")
        _delete_dev_preview_secret_and_wait(
            core,
            namespace=namespace,
            name=secret_name,
            execution_id=execution,
            service=service,
        )

    # Gate/restore patches update resourceVersion. Re-prove the same UID/holder
    # immediately before the preconditioned delete so a delayed duplicate worker
    # can never touch a newer adoption with the same deterministic name.
    reproved = _prove_dev_preview_teardown_owner(
        custom,
        coordination,
        namespace=namespace,
        sandbox_name=sandbox_name,
        expected=context,
    )
    if reproved is None:
        requested_execution = context.get("requestedExecution")
        requested_service = context.get("requestedService")
        if requested_execution and requested_service:
            _cleanup_dev_preview_support_resources_without_cr(
                core,
                coordination,
                namespace=namespace,
                execution_id=requested_execution,
                service=requested_service,
            )
        return
    current_cr, current_lease = reproved
    if lease is not None and current_lease is None:
        raise RuntimeError("adoption Lease disappeared before Sandbox deletion")
    current_metadata = current_cr.get("metadata", {}) or {}
    if not _delete_dev_preview_cr_and_wait(
        custom,
        namespace,
        sandbox_name,
        uid=str(current_metadata.get("uid") or "") or None,
        resource_version=(
            str(current_metadata.get("resourceVersion") or "") or None
        ),
    ):
        raise RuntimeError(f"dev-preview Sandbox deletion was not proven for {sandbox_name}")
    # The Lease remains the exclusivity fence until CR absence is observed. A
    # stale Lease after this point blocks availability but cannot mix owners and
    # is safely reclaimable by the stale-Lease sweep.
    if deployment and holder and current_lease is not None:
        if not _delete_dev_preview_adoption_lease(
            coordination,
            namespace=namespace,
            deployment=deployment,
            holder=holder,
        ):
            raise RuntimeError(
                f"adoption Lease release was not proven for {deployment}"
            )


def _teardown_dev_preview_resources(
    *,
    namespace: str,
    sandbox_name: str,
    context: dict[str, str | None],
) -> None:
    deployment = context.get("deployment")
    if deployment:
        with _dev_preview_adoption_transition_lock(namespace, deployment):
            _teardown_dev_preview_resources_locked(
                namespace=namespace,
                sandbox_name=sandbox_name,
                context=context,
            )
        return
    _teardown_dev_preview_resources_locked(
        namespace=namespace,
        sandbox_name=sandbox_name,
        context=context,
    )


def _deferred_dev_preview_teardown(
    *,
    namespace: str,
    sandbox_name: str,
    context: dict[str, str | None],
) -> None:
    delay = _env_int("DEV_PREVIEW_SELF_TEARDOWN_DELAY_SECONDS", 15, minimum=1)
    time.sleep(delay)
    try:
        deployment = context.get("deployment")
        if deployment:
            with _dev_preview_adoption_transition_lock(namespace, deployment):
                _teardown_dev_preview_resources(
                    namespace=namespace,
                    sandbox_name=sandbox_name,
                    context=context,
                )
        else:
            _teardown_dev_preview_resources(
                namespace=namespace,
                sandbox_name=sandbox_name,
                context=context,
            )
    except Exception as exc:
        logger.warning(
            "dev-preview deferred teardown failed for %s: %s", sandbox_name, exc
        )


@app.delete("/internal/dev-preview/{name}", response_model=None)
def teardown_dev_preview(
    request: Request,
    name: str,
    execution_id: str = Query(
        ..., alias="executionId", min_length=1, max_length=256
    ),
    service: str = Query(..., min_length=1, max_length=63),
) -> dict[str, Any] | JSONResponse:
    _require_internal(request)
    canonical_service = _dev_preview_service_label(service)
    expected_name = _dev_preview_sandbox_name(execution_id, canonical_service)
    if service != canonical_service:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="dev-preview teardown service must be canonical",
        )
    if name != expected_name:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="dev-preview teardown name does not match execution/service",
        )
    namespace = _agent_workflow_host_namespace()
    if os.environ.get("SANDBOX_EXECUTION_DRY_RUN", "").lower() in {
        "1",
        "true",
        "yes",
    }:
        return {
            "sandboxName": expected_name,
            "accepted": True,
            "deleted": True,
            "deferred": False,
        }
    custom = _load_k8s_custom_objects_client()
    try:
        with _dev_preview_adoption_transition_lock(namespace, canonical_service):
            context = _dev_preview_teardown_context(
                custom,
                namespace=namespace,
                sandbox_name=expected_name,
                requested_execution_id=execution_id,
                requested_service=canonical_service,
            )
            if context.get("uid") is None:
                _, core = _load_k8s_clients()
                coordination = _load_k8s_coordination_client()
                _cleanup_dev_preview_support_resources_without_cr(
                    core,
                    coordination,
                    namespace=namespace,
                    execution_id=execution_id,
                    service=canonical_service,
                )
                return {
                    "sandboxName": expected_name,
                    "accepted": True,
                    "deleted": True,
                    "deferred": False,
                }

            _validate_dev_preview_teardown_context(
                context, execution_id=execution_id, service=canonical_service
            )
            deployment = context.get("deployment")
            self_adopt = (
                canonical_service == deployment
                and deployment in DEV_PREVIEW_DEFERRED_CUTOVER_DEPLOYMENTS
            )
            if self_adopt:
                holder = context.get("holder")
                if not holder:
                    raise HTTPException(
                        status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                        detail="could not establish response-path cutover ownership",
                    )
                if not _cancel_dev_preview_deferred_cutover(
                    custom,
                    namespace=namespace,
                    sandbox_name=expected_name,
                    holder=holder,
                ):
                    raise HTTPException(
                        status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                        detail="could not prove response-path cutover cancellation",
                    )
                try:
                    threading.Thread(
                        target=_deferred_dev_preview_teardown,
                        kwargs={
                            "namespace": namespace,
                            "sandbox_name": expected_name,
                            "context": context,
                        },
                        daemon=True,
                        name=f"dev-preview-teardown-{expected_name}",
                    ).start()
                except Exception as exc:
                    raise HTTPException(
                        status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                        detail="response-path teardown was cancelled but not scheduled",
                    ) from exc
                return JSONResponse(
                    status_code=status.HTTP_202_ACCEPTED,
                    content={
                        "sandboxName": expected_name,
                        "accepted": True,
                        "deleted": False,
                        "deferred": True,
                    },
                )

            _teardown_dev_preview_resources_locked(
                namespace=namespace,
                sandbox_name=expected_name,
                context=context,
            )
    except Exception as exc:
        if isinstance(exc, HTTPException):
            raise
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="dev-preview teardown could not be proven",
        ) from exc
    return {
        "sandboxName": expected_name,
        "accepted": True,
        "deleted": True,
        "deferred": False,
    }


@app.post("/internal/dev-preview/restore-orphans")
def restore_dev_preview_orphans(request: Request) -> dict[str, Any]:
    """B5 restore-all sweep as a standalone call (SEA-restart resilience): the
    BFF fires this after its per-Sandbox teardown loop so Deployments orphaned
    at 0 replicas WITHOUT a Sandbox CR (nothing left for the per-CR restore to
    key on) still come back. Conservative by construction — see
    _adopt_restore_orphans."""
    _require_internal(request)
    namespace = _agent_workflow_host_namespace()
    if os.environ.get("SANDBOX_EXECUTION_DRY_RUN", "").lower() in {
        "1",
        "true",
        "yes",
    }:
        return {"restored": [], "skipped": "dry-run"}
    return _adopt_restore_orphans(
        _load_k8s_apps_client(),
        _load_k8s_custom_objects_client(),
        namespace=namespace,
        coordination=_load_k8s_coordination_client(),
    )


@app.post("/internal/dev-previews/teardown-intent")
def establish_dev_preview_teardown_intent(
    request: Request, body: DevPreviewTeardownIntentRequest
) -> dict[str, Any]:
    """Fence future creates before an execution-wide product teardown inventories.

    The development POC runs one SEA replica. Holding the same process lock across
    this write and Sandbox creation closes the provision-vs-teardown interleaving;
    a durable/multi-replica intent controller remains post-POC hardening.
    """

    _require_internal(request)
    with _DEV_PREVIEW_TEARDOWN_INTENTS_GUARD:
        _DEV_PREVIEW_TEARDOWN_INTENTS.add(body.executionId)
    return {"accepted": True, "executionId": body.executionId}


@app.get("/internal/dev-previews/teardown-intent")
def read_dev_preview_teardown_intent(
    request: Request,
    executionId: str = Query(min_length=1, max_length=256),
) -> dict[str, Any]:
    """Confirm whether execution-wide teardown won the provision race.

    Provision persists its product row before this final confirmation. Therefore,
    teardown either inventories the row or this read observes the intent fence.
    The process-local fence is sufficient for the single-replica development POC.
    """

    _require_internal(request)
    return {
        "executionId": executionId,
        "teardownIntent": _dev_preview_teardown_intended(executionId),
    }


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
        selector = (
            f"{DEV_PREVIEW_MANAGED_LABEL}={DEV_PREVIEW_MANAGED_VALUE},"
            f"workflow-execution-id={exec_label}"
        )
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
            raise HTTPException(
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                detail="dev-preview Sandbox inventory could not be established",
            ) from exc
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
    return {"executionId": executionId, "complete": True, "services": services}


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


def _dev_preview_cr_annotation(
    custom: Any, namespace: str, name: str, annotation: str
) -> str | None:
    """Read one CR annotation, distinguishing absence from API ambiguity."""
    try:
        existing = custom.get_namespaced_custom_object(
            group="agents.x-k8s.io",
            version="v1alpha1",
            namespace=namespace,
            plural="sandboxes",
            name=name,
        )
    except Exception as exc:
        if getattr(exc, "status", None) == 404:
            return None
        raise
    annotations = ((existing or {}).get("metadata", {}) or {}).get(
        "annotations", {}
    ) or {}
    value = annotations.get(annotation)
    return value if isinstance(value, str) and value else ""


def _dev_preview_cr_adoption_holder(
    custom: Any, namespace: str, name: str
) -> str | None:
    """Read the exact adoption holder, distinguishing absence from API ambiguity."""
    return _dev_preview_cr_annotation(
        custom, namespace, name, DEV_PREVIEW_ADOPT_HOLDER_ANNOTATION
    )


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
    preview_storage = _preview_storage_context()
    if preview_storage is not None:
        logical_key = _preview_storage_logical_key(
            shared_key, field="workspaceExecutionId"
        )
        pvc_name = _preview_storage_pvc_name("workspace", logical_key)
        job_name = (
            f"wspurge-{sha256(logical_key.encode()).hexdigest()[:16]}-{uuid4().hex[:6]}"
        )
        mount_path = class_config.sharedWorkspaceStoreMountPath or "/sandbox/work"
        purge_cmd = (
            f"find {mount_path} -mindepth 1 -delete 2>/dev/null; "
            f"rm -rf {mount_path}/* {mount_path}/.[!.]* 2>/dev/null; echo purged; true"
        )
        job_body = {
            "apiVersion": "batch/v1",
            "kind": "Job",
            "metadata": {
                "name": job_name,
                "namespace": namespace,
                "labels": {
                    "app": "workspace-purge",
                    "preview.stacks.io/storage-scope": preview_storage.scope_id,
                },
            },
            "spec": {
                "backoffLimit": 1,
                "ttlSecondsAfterFinished": 600,
                "template": {
                    "metadata": {
                        "labels": {
                            "app": "workspace-purge",
                            "preview.stacks.io/storage-scope": preview_storage.scope_id,
                        }
                    },
                    "spec": {
                        "restartPolicy": "Never",
                        "containers": [
                            {
                                "name": "purge",
                                "image": "busybox:1.36",
                                "command": ["sh", "-c", purge_cmd],
                                "volumeMounts": [
                                    {"name": "work", "mountPath": mount_path}
                                ],
                            }
                        ],
                        "volumes": [
                            {
                                "name": "work",
                                "persistentVolumeClaim": {"claimName": pvc_name},
                            }
                        ],
                    },
                },
            },
        }
        if os.environ.get("SANDBOX_EXECUTION_DRY_RUN", "").lower() in {
            "1",
            "true",
            "yes",
        }:
            return {"dryRun": True, "job": job_name}
        batch, core = _load_k8s_clients()
        try:
            _ensure_preview_dynamic_pvc(
                core,
                namespace=namespace,
                context=preview_storage,
                kind="workspace",
                logical_key=logical_key,
                capacity=class_config.sharedWorkspaceStoreCapacity,
                create=False,
            )
        except HTTPException as exc:
            if exc.status_code == status.HTTP_409_CONFLICT and "does not exist" in str(
                exc.detail
            ):
                return {"success": True, "skipped": "workspace_absent"}
            raise
        batch.create_namespaced_job(namespace=namespace, body=job_body)
        return {"success": True, "job": job_name}

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
                core.patch_persistent_volume(
                    name=name, body={"spec": {"claimRef": None}}
                )
        except Exception as patch_exc:
            logger.warning("wspurge pv %s claimRef clear failed: %s", name, patch_exc)
    try:
        core.create_namespaced_persistent_volume_claim(
            namespace=namespace, body=pvc_body
        )
    except Exception as exc:
        if getattr(exc, "status", None) != 409:
            raise
    batch.create_namespaced_job(namespace=namespace, body=job_body)
    # Reap this workspace's node-boundary snapshots alongside the workspace data (they
    # live at the ROOT `.snapshots/<key>/`, which the subPath-mounted purge Job above
    # can't reach). Best-effort: a failed prune must never fail the purge.
    snapshot_prune_job: str | None = None
    try:
        snapshot_prune_job = _start_snapshot_prune_job(
            batch,
            core,
            namespace=namespace,
            class_config=class_config,
            shared_key=shared_key,
            prune_all=True,
        )
    except Exception as exc:
        logger.warning("snapshot prune on purge failed for %s: %s", shared_key, exc)
    result: dict[str, Any] = {"success": True, "job": job_name, "subPath": shared_key}
    if snapshot_prune_job:
        result["snapshotPruneJob"] = snapshot_prune_job
    return result


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
    if _preview_storage_context() is not None:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="preview storage forbids static subPath PVs",
        )
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
        "metadata": {
            "name": name,
            "namespace": namespace,
            "labels": {"app": "workspace-seed"},
        },
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
                core.patch_persistent_volume(
                    name=name, body={"spec": {"claimRef": None}}
                )
        except Exception as patch_exc:
            logger.warning("wsseed pv %s claimRef clear failed: %s", name, patch_exc)
    try:
        core.create_namespaced_persistent_volume_claim(
            namespace=namespace, body=pvc_body
        )
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
    if _preview_storage_context() is not None:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="preview storage forbids root volume mounts",
        )
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
        "metadata": {
            "name": name,
            "namespace": namespace,
            "labels": {"app": "workspace-seed"},
        },
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
                core.patch_persistent_volume(
                    name=name, body={"spec": {"claimRef": None}}
                )
        except Exception as patch_exc:
            logger.warning(
                "wsseed root pv %s claimRef clear failed: %s", name, patch_exc
            )
    try:
        core.create_namespaced_persistent_volume_claim(
            namespace=namespace, body=pvc_body
        )
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
    preview_storage = _preview_storage_context()
    if preview_storage is not None:
        dest_key = _preview_storage_logical_key(dest, field="workspaceExecutionId")
        source_key = _preview_storage_logical_key(src, field="seedWorkspaceFrom")
        source_pvc = _preview_storage_pvc_name("workspace", source_key)
        dest_pvc = _preview_storage_pvc_name("workspace", dest_key)
        job_name = (
            f"wsseed-{sha256(dest_key.encode()).hexdigest()[:12]}-{uuid4().hex[:6]}"
        )
        job_body = {
            "apiVersion": "batch/v1",
            "kind": "Job",
            "metadata": {
                "name": job_name,
                "namespace": namespace,
                "labels": {
                    "app": "workspace-seed",
                    "preview.stacks.io/storage-scope": preview_storage.scope_id,
                },
            },
            "spec": {
                "backoffLimit": 1,
                "ttlSecondsAfterFinished": 600,
                "template": {
                    "metadata": {
                        "labels": {
                            "app": "workspace-seed",
                            "preview.stacks.io/storage-scope": preview_storage.scope_id,
                        }
                    },
                    "spec": {
                        "restartPolicy": "Never",
                        "containers": [
                            {
                                "name": "seed",
                                "image": "busybox:1.36",
                                "command": [
                                    "sh",
                                    "-c",
                                    _seed_copy_cmd("already-populated"),
                                ],
                                "volumeMounts": [
                                    {
                                        "name": "seed",
                                        "mountPath": "/seed",
                                        "readOnly": True,
                                    },
                                    {"name": "work", "mountPath": "/work"},
                                ],
                            }
                        ],
                        "volumes": [
                            {
                                "name": "seed",
                                "persistentVolumeClaim": {
                                    "claimName": source_pvc,
                                    "readOnly": True,
                                },
                            },
                            {
                                "name": "work",
                                "persistentVolumeClaim": {"claimName": dest_pvc},
                            },
                        ],
                    },
                },
            },
        }
        if os.environ.get("SANDBOX_EXECUTION_DRY_RUN", "").lower() in {
            "1",
            "true",
            "yes",
        }:
            return {"dryRun": True, "job": job_name}
        batch, core = _load_k8s_clients()
        _ensure_preview_dynamic_pvc(
            core,
            namespace=namespace,
            context=preview_storage,
            kind="workspace",
            logical_key=source_key,
            capacity=class_config.sharedWorkspaceStoreCapacity,
            create=False,
        )
        _ensure_preview_dynamic_pvc(
            core,
            namespace=namespace,
            context=preview_storage,
            kind="workspace",
            logical_key=dest_key,
            capacity=class_config.sharedWorkspaceStoreCapacity,
        )
        batch.create_namespaced_job(namespace=namespace, body=job_body)
        return {
            "success": True,
            "job": job_name,
            "namespace": namespace,
            "status": "running",
            "done": False,
        }

    root_pvc = "wsseed-root"
    job_name = f"wsseed-{sha256(dest.encode()).hexdigest()[:12]}-{uuid4().hex[:6]}"
    seed_image = os.environ.get(
        "WORKSPACE_SEED_JUICEFS_IMAGE", "juicedata/mount:ce-v1.3.1"
    )
    job_body = {
        "apiVersion": "batch/v1",
        "kind": "Job",
        "metadata": {
            "name": job_name,
            "namespace": namespace,
            "labels": {"app": "workspace-seed"},
        },
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
                        {
                            "name": "root",
                            "persistentVolumeClaim": {"claimName": root_pvc},
                        },
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
    return {
        "success": True,
        "job": job_name,
        "namespace": namespace,
        "status": "running",
        "done": False,
    }


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
    if (
        _preview_storage_context() is not None
        and namespace != _agent_workflow_host_namespace()
    ):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="preview seed status cannot target another namespace",
        )
    batch, _core = _load_k8s_clients()
    try:
        st = batch.read_namespaced_job_status(name=job_name, namespace=namespace).status
    except Exception as exc:
        if getattr(exc, "status", None) == 404:
            # TTL-reaped after success, or never created — treat as not-found.
            raise HTTPException(
                status_code=404, detail=f"seed job {job_name} not found"
            )
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
# Node-boundary CLI-workspace snapshots (durability phase 3). See
# `_snapshot_clone_cmd` above for the mechanism.
# ---------------------------------------------------------------------------


class CliWorkspaceSnapshotRequest(BaseModel):
    """Create one node-boundary snapshot of a run's CLI shared workspace."""

    sharedWorkspaceKey: str
    snapshotId: str
    executionId: str | None = None
    executionClass: str | None = None


class CliWorkspaceSnapshotPruneRequest(BaseModel):
    """Prune snapshots for one workspace key. `all` wins over `keep`."""

    sharedWorkspaceKey: str
    keep: list[str] | None = None
    all: bool = False
    executionId: str | None = None
    executionClass: str | None = None


def _juicefs_webdav_config() -> tuple[str, str, str] | None:
    """(base_url, user, password) for the in-cluster juicefs-webdav gateway, or None when
    no password is resolvable. The password mirrors the BFF derivation
    (`sha256("webdav:wfbcli:<DATABASE_URL>")[:32]`) so the two agree without extra config."""
    base = os.environ.get(
        "JUICEFS_WEBDAV_URL",
        "http://juicefs-webdav.workflow-builder.svc.cluster.local:9007",
    ).rstrip("/")
    user = os.environ.get("JUICEFS_WEBDAV_USER", "wfbwebdav")
    password = os.environ.get("JUICEFS_WEBDAV_PASSWORD", "")
    if not password:
        db = os.environ.get("DATABASE_URL", "")
        if db:
            password = sha256(f"webdav:wfbcli:{db}".encode()).hexdigest()[:32]
    if not password:
        return None
    return base, user, password


def _parse_webdav_child_dir_names(xml_text: str, *, self_path: str) -> list[str]:
    """Pull immediate child directory names out of a `PROPFIND Depth:1` multistatus body.
    `self_path` is the collection's own decoded path (excluded from the result)."""
    from urllib.parse import unquote

    names: list[str] = []
    self_norm = "/" + self_path.strip("/") + "/"
    for raw in re.findall(r"<[a-zA-Z]*:?href>([^<]*)</[a-zA-Z]*:?href>", xml_text):
        try:
            href = unquote(raw)
        except Exception:
            href = raw
        path = href.split("://", 1)[-1]
        path = path[path.index("/"):] if "/" in path else path
        norm = "/" + path.strip("/") + "/"
        if norm == self_norm:
            continue
        if not norm.startswith(self_norm):
            continue
        leaf = norm[len(self_norm):].strip("/")
        if leaf and "/" not in leaf:
            names.append(leaf)
    return names


@app.post("/internal/cli-workspace/snapshots", status_code=status.HTTP_200_OK)
def create_cli_workspace_snapshot(
    request: Request, body: CliWorkspaceSnapshotRequest
) -> dict[str, Any]:
    """Create (idempotently) a node-boundary CoW snapshot of a run's CLI shared workspace at
    `.snapshots/<key>/<snapshotId>`. Returns immediately with the Job name; the Job is
    fire-and-forget (the orchestrator does not poll — a missing snapshot only costs a
    fallback to end-state seeding). Idempotent: a re-POST for an existing snapshot no-ops."""
    _require_internal(request)
    shared_key = _validate_snapshot_component(
        body.sharedWorkspaceKey, field="sharedWorkspaceKey"
    )
    snapshot_id = _validate_snapshot_component(body.snapshotId, field="snapshotId")
    class_config = _resolve_juicefs_class(body.executionClass)
    if class_config is None:
        raise HTTPException(
            status_code=409, detail="no juicefs-shared execution class configured"
        )
    if _preview_storage_context() is not None:
        # Snapshots need a root mount, which preview storage forbids (and a preview seed
        # PV cannot express a nested subPath). Previews fall back to end-state seeding.
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="snapshots unavailable under preview storage",
        )
    namespace = _agent_workflow_host_namespace()
    job_name = (
        "snap-"
        f"{sha256(f'{shared_key}/{snapshot_id}'.encode()).hexdigest()[:12]}"
        f"-{uuid4().hex[:6]}"
    )
    job_body = _build_snapshot_job(
        name=job_name,
        namespace=namespace,
        command=_snapshot_clone_cmd(),
        command_env={
            "KEY": shared_key,
            "SNAP": snapshot_id,
            "CAP": str(_SNAPSHOT_MAX_PER_KEY),
        },
        execution_id=body.executionId,
        action="create",
    )
    if os.environ.get("SANDBOX_EXECUTION_DRY_RUN", "").lower() in {"1", "true", "yes"}:
        return {
            "dryRun": True,
            "job": job_name,
            "key": shared_key,
            "snapshotId": snapshot_id,
        }
    batch, core = _load_k8s_clients()
    _ensure_root_pv(
        core, name=_SNAPSHOT_ROOT_PVC, class_config=class_config, namespace=namespace
    )
    batch.create_namespaced_job(namespace=namespace, body=job_body)
    return {
        "success": True,
        "job": job_name,
        "namespace": namespace,
        "key": shared_key,
        "snapshotId": snapshot_id,
    }


@app.get(
    "/internal/cli-workspace/snapshots/{shared_workspace_key}",
    status_code=status.HTTP_200_OK,
)
def list_cli_workspace_snapshots(
    request: Request, shared_workspace_key: str
) -> dict[str, Any]:
    """List the snapshot ids recorded for a workspace key. Read-only + Job-free: PROPFINDs
    `.snapshots/<key>/` on the juicefs-webdav gateway (Depth:1). `available:false` (never an
    error) when the gateway is unconfigured/unreachable so callers fall back to end-state
    seeding rather than fail the fork."""
    _require_internal(request)
    import requests  # noqa: PLC0415 — optional/lazy; only this read path needs it

    key = _validate_snapshot_component(
        shared_workspace_key, field="sharedWorkspaceKey"
    )
    cfg = _juicefs_webdav_config()
    if cfg is None:
        return {"key": key, "snapshots": [], "available": False}
    base, user, password = cfg
    rel = f"{_SNAPSHOTS_ROOT_DIR}/{key}/"
    url = f"{base}/{rel}"
    try:
        resp = requests.request(
            "PROPFIND",
            url,
            headers={"Depth": "1"},
            auth=(user, password),
            timeout=15,
        )
    except Exception as exc:
        logger.warning("snapshot list PROPFIND failed for %s: %s", key, exc)
        return {"key": key, "snapshots": [], "available": False}
    if resp.status_code == 404:
        return {"key": key, "snapshots": [], "available": True}
    if resp.status_code >= 400:
        logger.warning(
            "snapshot list PROPFIND %s → HTTP %s", key, resp.status_code
        )
        return {"key": key, "snapshots": [], "available": False}
    ids = _parse_webdav_child_dir_names(resp.text, self_path=rel)
    return {"key": key, "snapshots": sorted(ids), "available": True}


@app.post("/internal/cli-workspace/snapshots/prune", status_code=status.HTTP_200_OK)
def prune_cli_workspace_snapshots(
    request: Request, body: CliWorkspaceSnapshotPruneRequest
) -> dict[str, Any]:
    """Prune snapshots for a workspace key: `all=true` drops every snapshot, else every id
    NOT in `keep` is removed. Starts a short root-mounted Job; returns its name."""
    _require_internal(request)
    shared_key = _validate_snapshot_component(
        body.sharedWorkspaceKey, field="sharedWorkspaceKey"
    )
    keep = [
        _validate_snapshot_component(k, field="keep entry") for k in (body.keep or [])
    ]
    class_config = _resolve_juicefs_class(body.executionClass)
    if class_config is None:
        raise HTTPException(
            status_code=409, detail="no juicefs-shared execution class configured"
        )
    if _preview_storage_context() is not None:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="snapshots unavailable under preview storage",
        )
    namespace = _agent_workflow_host_namespace()
    if os.environ.get("SANDBOX_EXECUTION_DRY_RUN", "").lower() in {"1", "true", "yes"}:
        return {
            "dryRun": True,
            "key": shared_key,
            "all": bool(body.all),
            "keep": keep,
        }
    batch, core = _load_k8s_clients()
    job_name = _start_snapshot_prune_job(
        batch,
        core,
        namespace=namespace,
        class_config=class_config,
        shared_key=shared_key,
        keep=keep,
        prune_all=bool(body.all),
        execution_id=body.executionId,
    )
    return {"success": True, "job": job_name, "namespace": namespace, "key": shared_key}


# ---------------------------------------------------------------------------
# Tier-2 full-isolation previews (vcluster). The BFF asks the SEA controller to
# establish one exact `vcpreview-<name>` identity and submit /config/runner.sh.
# That identity is limited to the matching preview namespace and bounded control
# resources; it is removed only after down succeeds and the namespace is absent.
# The runner blocks until rollouts are ready, so Job success == environment ready.
# See stacks .../workflow-builder-preview-vcluster/.
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
    """PreviewEnvironment is cold-only; the legacy vCluster pool is retired."""
    return 0


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


class PreviewEnvironmentOwnerRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    kind: str
    id: str


class PreviewEnvironmentOriginRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    kind: str
    reference: str | None = None


class VclusterPreviewRuntimeIdentityGuard(BaseModel):
    """Immutable preview identity supplied by an authorized internal caller."""

    model_config = ConfigDict(extra="forbid")

    previewName: str = Field(
        min_length=1,
        max_length=40,
        pattern=r"^[a-z0-9](?:[-a-z0-9]*[a-z0-9])?$",
    )
    environmentRequestId: str = Field(
        min_length=1,
        max_length=256,
        pattern=r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$",
    )
    environmentPlatformRevision: str = Field(pattern=r"^[0-9a-f]{40}$")
    environmentSourceRevision: str = Field(pattern=r"^[0-9a-f]{40}$")
    catalogDigest: str = Field(pattern=r"^sha256:[0-9a-f]{64}$")


class PreviewCapabilityBundleRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    controlToken: str = Field(pattern=r"^[0-9a-f]{64}$")
    syncToken: str = Field(pattern=r"^[0-9a-f]{64}$")
    actionToken: str = Field(pattern=r"^[0-9a-f]{64}$")
    sandboxToken: str = Field(pattern=r"^[0-9a-f]{64}$")
    runtimeToken: str = Field(pattern=r"^[0-9a-f]{64}$")
    storageToken: str = Field(pattern=r"^[0-9a-f]{64}$")


class VclusterPreviewRequest(BaseModel):
    """Provision (or tear down) a Tier-2 full-isolation preview vcluster."""

    model_config = ConfigDict(extra="forbid")

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
    # New PreviewEnvironment contract. `platformRevision` is the immutable stacks
    # commit that owns the preview baseline; targetRevision remains a legacy alias
    # during the delivery cutover. sourceRevision identifies application source
    # that may subsequently be live-synced into adopted dev pods.
    platformRevision: str | None = None
    sourceRevision: str | None = None
    catalogDigest: str | None = None
    candidatePaths: list[str] = Field(default_factory=list, max_length=64)
    delivery: str | None = None  # imperative | reconciler
    profile: str | None = None  # app-live | manifest-candidate | host-candidate
    lane: str | None = None  # application | management
    mode: str | None = None  # live | reconciled
    allocation: dict[str, str] | None = None
    imageOverrides: dict[str, str] = Field(default_factory=dict, max_length=16)
    lifecycle: str | None = None
    owner: PreviewEnvironmentOwnerRequest | str | None = None
    origin: PreviewEnvironmentOriginRequest | str | None = None
    services: list[str] = Field(default_factory=list, max_length=16)
    provenance: dict[str, Any] | None = None
    trustedCode: bool = False
    capabilityBundle: PreviewCapabilityBundleRequest | None = None
    # Fresh reconciled candidates must never adopt or replace a previous preview.
    # The SEA creates their provisioning Job without the legacy delete/recreate path,
    # making the Kubernetes Job name an additional atomic reservation.
    createOnly: bool = False
    # Internal-only stable-alias teardown fence. DELETE populates these after
    # validating the live PreviewEnvironment identity; the runner rechecks them.
    teardownExpectedRequestId: str | None = None
    teardownExpectedSourceRevision: str | None = None
    teardownExpectedPlatformRevision: str | None = Field(
        default=None, pattern=r"^[0-9a-f]{40}$"
    )
    teardownExpectedCatalogDigest: str | None = Field(
        default=None, pattern=r"^sha256:[0-9a-f]{64}$"
    )
    teardownDeletionTimestamp: str | None = Field(
        default=None, min_length=1, max_length=64
    )
    teardownProtectedRequestId: str | None = None
    teardownEnvironmentUid: str | None = Field(
        default=None,
        pattern=r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$",
    )
    teardownIntentId: str | None = Field(default=None, pattern=r"^sha256:[0-9a-f]{64}$")
    # PREVIEW_DB_MODE=cnpg → per-preview isolated CloudNativePG Postgres inside the
    # vcluster (no shared host-Postgres connection ceiling). Defaults from env so it
    # can be flipped cluster-wide without an API change. cnpg | shared
    previewDbMode: str | None = None
    # Legacy unprofiled callers may select disabled|async. Profiled previews derive this
    # from platform policy so a candidate cannot suppress its own telemetry.
    previewObservability: str | None = None
    # PREVIEW_PARALLEL_BRINGUP=true → runner backgrounds the independent infra installs
    # (Dapr/CNPG-operator/agent-sandbox/NATS) behind a hard barrier. Default false = serial.
    # A2, flagged default-off; env-defaulted for a cluster-wide flip without an API change.
    previewParallelBringup: bool | None = None
    # PREVIEW_DB_BOOTSTRAP=migrate|template → template clones the pre-seeded host
    # `preview_template` DB via CNPG import (cnpg mode) instead of empty-migrate+seed.
    # A2, flagged default-off (migrate); env-defaulted.
    previewDbBootstrap: str | None = None
    # Legacy unprofiled compatibility only. Profiled previews reject this field
    # and the pool manager is permanently disabled.
    pool: bool = False
    # ---- D1 lifecycle contract (all optional; absent = the legacy/human preview shape) ----
    # origin: who this preview belongs to — "user" (a human asked for it) or "pr" (a PR-preview
    # automation asked for it). Stamped as the `vcluster-preview-origin` ns label; PR-origin
    # previews are EVICTABLE by the A4 capacity logic, human ones are not.
    # Flat user|pr values remain accepted only for unprofiled legacy callers.
    # prNumber: the GitHub PR a pr-origin preview serves; stamped as `vcluster-preview-pr`.
    prNumber: int | None = None
    # ttlHours: per-preview lifetime. SEA computes now+ttlHours and stamps it as the
    # `vcluster-preview-expires-at` RFC3339 ns annotation; any reap pass tears the preview
    # down once past it (independent of the global VCLUSTER_PREVIEW_TTL_HOURS flag).
    ttlHours: int | None = None


class VclusterPreviewClaimRequest(BaseModel):
    """Retired claim payload retained only for an explicit fail-closed response."""

    model_config = ConfigDict(extra="forbid")

    name: str = Field(min_length=1, max_length=40)
    user: str | None = None
    prNumber: int | None = None
    ttlHours: int | None = None
    # A warm claim is valid only when the member was baked from this exact
    # immutable platform revision. These fields mirror the profiled cold-create
    # contract; Pydantic must not silently discard them at this trust boundary.
    platformRevision: str | None = None
    sourceRevision: str | None = None
    catalogDigest: str | None = None
    candidatePaths: list[str] = Field(default_factory=list, max_length=64)
    delivery: str | None = None  # imperative | reconciler
    enrollMode: str | None = None  # imperative | agent
    profile: str | None = None  # app-live only; candidates are cold
    mode: str | None = None  # live only for a warm claim
    allocation: dict[str, str] | None = None
    imageOverrides: dict[str, str] = Field(default_factory=dict, max_length=16)
    lifecycle: str | None = None
    owner: PreviewEnvironmentOwnerRequest | str | None = None
    origin: PreviewEnvironmentOriginRequest | str | None = None
    services: list[str] = Field(default_factory=list, max_length=16)
    provenance: dict[str, Any] | None = None
    trustedCode: bool = False
    createOnly: bool = False


class VclusterPreviewTeardownRequest(BaseModel):
    """Infrastructure ownership fence for stable-alias teardown."""

    model_config = ConfigDict(extra="forbid")

    expectedRequestId: str | None = Field(default=None, min_length=1, max_length=256)
    expectedSourceRevision: str | None = Field(default=None, pattern=r"^[0-9a-f]{40}$")
    platformRevision: str | None = Field(default=None, pattern=r"^[0-9a-f]{40}$")
    catalogDigest: str | None = Field(default=None, pattern=r"^sha256:[0-9a-f]{64}$")
    deletionTimestamp: str | None = Field(default=None, min_length=1, max_length=64)
    protectedRequestId: str | None = Field(default=None, min_length=1, max_length=256)
    environmentUid: str | None = Field(
        default=None,
        pattern=r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$",
    )
    deletionIntentId: str | None = Field(default=None, pattern=r"^sha256:[0-9a-f]{64}$")


@dataclass(frozen=True)
class FailedPreinitializedTeardownProof:
    """Server-generated evidence for the one controller-only teardown exception."""

    preinitialization_evidence: str
    physical_namespace_uid: str
    failed_up_job_uid: str | None
    failed_up_runner_generation: str


def _controller_deletion_intent(
    *,
    name: str,
    request_id: str | None,
    platform_revision: str | None,
    source_revision: str | None,
    catalog_digest: str | None,
    deletion_timestamp: str | None,
    environment_uid: str | None,
    intent_id: str | None,
) -> dict[str, str] | None:
    """Validate and independently recompute the hub controller's exact command."""

    extension_values = (platform_revision, catalog_digest, deletion_timestamp)
    if not any(extension_values):
        return None
    if not all(
        (
            *extension_values,
            environment_uid,
            intent_id,
            request_id,
            source_revision,
        )
    ):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="controller deletion intent fields must be supplied together",
        )
    payload = {
        "name": name,
        "environmentUid": environment_uid,
        "requestId": request_id,
        "platformRevision": platform_revision,
        "sourceRevision": source_revision,
        "catalogDigest": catalog_digest,
        "deletionTimestamp": deletion_timestamp,
    }
    canonical = json.dumps(payload, sort_keys=True, separators=(",", ":"))
    expected_id = f"sha256:{sha256(canonical.encode('utf-8')).hexdigest()}"
    if intent_id != expected_id:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="controller deletion intent id does not match its immutable fields",
        )
    return {"id": expected_id, **payload}


class VclusterPreviewCleanupReceiptReleaseRequest(BaseModel):
    """Exact completed Job identity accepted by the post-finalization pruner."""

    model_config = ConfigDict(extra="forbid")

    jobUid: str = Field(
        pattern=r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$"
    )
    runnerGeneration: str = Field(pattern=r"^op:[0-9a-f]{32}$")


def _vcluster_preview_job_name(name: str, action: str) -> str:
    return _safe_resource_name(f"vcpreview-{action}-{name}", max_length=63)


def _vcluster_preview_tailnet_host(req: VclusterPreviewRequest) -> str:
    return req.tailnetHost or f"wfb-{req.name}"


def _vcluster_preview_database_name(name: str) -> str:
    """Return the runner's only admissible shared-database name for a preview."""
    if len(name) > 40 or not re.fullmatch(r"[a-z0-9]([-a-z0-9]*[a-z0-9])?", name):
        raise HTTPException(status_code=400, detail="preview name must be a DNS label")
    database = f"preview_{re.sub(r'[^a-z0-9]', '', name)}"
    if not re.fullmatch(r"[a-z_][a-z0-9_]{0,62}", database):
        raise HTTPException(
            status_code=400, detail="derived preview database is invalid"
        )
    return database


def _preview_owner(
    value: PreviewEnvironmentOwnerRequest | str | None,
) -> PreviewEnvironmentOwnerRequest | None:
    return value if isinstance(value, PreviewEnvironmentOwnerRequest) else None


def _preview_origin(
    value: PreviewEnvironmentOriginRequest | str | None,
) -> PreviewEnvironmentOriginRequest | None:
    return value if isinstance(value, PreviewEnvironmentOriginRequest) else None


def _legacy_preview_origin(
    value: PreviewEnvironmentOriginRequest | str | None,
) -> str | None:
    if isinstance(value, str):
        return value if value in {"user", "pr"} else None
    if value is None:
        return None
    if value.kind == "pull-request":
        return "pr"
    if value.kind == "user":
        return "user"
    return None


def _vcluster_preview_job_manifest(
    req: VclusterPreviewRequest,
    *,
    namespace: str,
    operation_holder: str | None = None,
    failed_preinitialized_proof: FailedPreinitializedTeardownProof | None = None,
) -> dict[str, Any]:
    job_name = _vcluster_preview_job_name(req.name, req.action)
    preview_name = _safe_resource_name(req.name, max_length=40)
    runner_labels = {
        "app": "vcluster-preview",
        "vcluster-preview-name": preview_name,
        "vcluster-preview-action": req.action,
        "preview.stacks.io/managed": "true",
        "preview.stacks.io/preview-name": preview_name,
    }
    runner_annotations: dict[str, str] = (
        {RUNNER_GENERATION_ANNOTATION: operation_holder}
        if operation_holder is not None
        else {}
    )
    if req.action == "down":
        if req.teardownExpectedRequestId and req.teardownExpectedSourceRevision:
            runner_annotations.update(
                {
                    "preview.stacks.io/teardown-request-id": (
                        req.teardownExpectedRequestId
                    ),
                    "preview.stacks.io/teardown-source-revision": (
                        req.teardownExpectedSourceRevision
                    ),
                }
            )
        elif req.teardownProtectedRequestId:
            runner_annotations.update(
                {
                    "preview.stacks.io/teardown-protected-request-id": (
                        req.teardownProtectedRequestId
                    )
                }
            )
        if req.teardownEnvironmentUid and req.teardownIntentId:
            runner_annotations.update(
                {
                    "preview.stacks.io/teardown-environment-uid": (
                        req.teardownEnvironmentUid
                    ),
                    "preview.stacks.io/teardown-intent-id": req.teardownIntentId,
                }
            )
        if failed_preinitialized_proof is not None:
            if not all(
                (
                    req.teardownExpectedRequestId,
                    req.teardownExpectedSourceRevision,
                    req.teardownExpectedPlatformRevision,
                    req.teardownExpectedCatalogDigest,
                    req.teardownDeletionTimestamp,
                    req.teardownEnvironmentUid,
                    req.teardownIntentId,
                )
            ):
                raise ValueError(
                    "failed preinitialized proof requires a complete controller intent"
                )
            if (
                operation_holder is not None
                and failed_preinitialized_proof.failed_up_runner_generation
                == operation_holder
            ):
                raise ValueError(
                    "failed up and current down runner generations must differ"
                )
            evidence = failed_preinitialized_proof.preinitialization_evidence
            if evidence not in {"failed-up-job-v1", "expired-reservation-v1"} or (
                (evidence == "failed-up-job-v1")
                != bool(failed_preinitialized_proof.failed_up_job_uid)
            ):
                raise ValueError("failed preinitialization evidence is invalid")
            runner_annotations.update(
                {
                    "preview.stacks.io/teardown-platform-revision": (
                        req.teardownExpectedPlatformRevision
                    ),
                    "preview.stacks.io/teardown-catalog-digest": (
                        req.teardownExpectedCatalogDigest
                    ),
                    "preview.stacks.io/teardown-deletion-timestamp": (
                        req.teardownDeletionTimestamp
                    ),
                    "preview.stacks.io/teardown-preinit-evidence": evidence,
                    "preview.stacks.io/teardown-physical-namespace-uid": (
                        failed_preinitialized_proof.physical_namespace_uid
                    ),
                    "preview.stacks.io/teardown-failed-up-runner-generation": (
                        failed_preinitialized_proof.failed_up_runner_generation
                    ),
                    **(
                        {
                            "preview.stacks.io/teardown-failed-up-job-uid": (
                                failed_preinitialized_proof.failed_up_job_uid
                            )
                        }
                        if failed_preinitialized_proof.failed_up_job_uid
                        else {}
                    ),
                }
            )
    image = os.environ.get("VCLUSTER_PREVIEW_RUNNER_IMAGE", "alpine/k8s:1.31.0")
    env = [
        {"name": "NAME", "value": req.name},
        {"name": "ACTION", "value": req.action},
        {"name": "TS_HOST", "value": _vcluster_preview_tailnet_host(req)},
        {"name": "HOME", "value": "/tmp"},
    ]
    if operation_holder:
        if not re.fullmatch(r"op:[0-9a-f]{32}", operation_holder):
            raise ValueError("preview operation holder is invalid")
        env.append({"name": "PREVIEW_OPERATION_HOLDER", "value": operation_holder})
    if req.daprVersion:
        env.append({"name": "DAPR_VERSION", "value": req.daprVersion})
    if req.action == "down":
        env.append(
            {"name": "PREVIEW_DB", "value": _vcluster_preview_database_name(req.name)}
        )
    elif req.previewDb:
        env.append({"name": "PREVIEW_DB", "value": req.previewDb})
    # Agent-mode is the default delivery path. TARGET_REVISION is meaningful only
    # while creating or personalizing a vCluster; lifecycle Jobs must not carry it.
    enroll_mode = req.enrollMode or os.environ.get(
        "VCLUSTER_PREVIEW_ENROLL_MODE", "agent"
    )
    env.append({"name": "ENROLL_MODE", "value": enroll_mode})
    if req.capabilityBundle is not None and req.action in {"up", "claim"}:
        bundle = req.capabilityBundle
        env.extend(
            [
                {
                    "name": "PREVIEW_CONTROL_CAPABILITY_TOKEN",
                    "value": bundle.controlToken,
                },
                {
                    "name": "PREVIEW_DEV_SYNC_MINT_TOKEN",
                    "value": bundle.syncToken,
                },
                {"name": "PREVIEW_ACTION_INTERNAL_TOKEN", "value": bundle.actionToken},
                {"name": "SANDBOX_EXECUTION_API_TOKEN", "value": bundle.sandboxToken},
                {
                    "name": "PREVIEW_RUNTIME_CAPABILITY_TOKEN",
                    "value": bundle.runtimeToken,
                },
                {
                    "name": "PREVIEW_STORAGE_CAPABILITY_TOKEN",
                    "value": bundle.storageToken,
                },
            ]
        )
    if req.profile:
        env.append(
            {
                "name": "PREVIEW_DELIVERY",
                "value": req.delivery
                or os.environ.get("VCLUSTER_PREVIEW_DELIVERY", "reconciler"),
            }
        )
    elif req.delivery:
        env.append({"name": "PREVIEW_DELIVERY", "value": req.delivery})
    if req.profile:
        env.append({"name": "PREVIEW_PROFILE", "value": req.profile})
    if req.lane:
        env.append({"name": "PREVIEW_LANE", "value": req.lane})
    if req.mode:
        env.append({"name": "PREVIEW_MODE", "value": req.mode})
    if req.allocation is not None:
        env.append(
            {
                "name": "PREVIEW_ALLOCATION",
                "value": json.dumps(
                    req.allocation, separators=(",", ":"), sort_keys=True
                ),
            }
        )
    if req.action == "down":
        if req.teardownExpectedRequestId:
            env.append(
                {
                    "name": "TEARDOWN_EXPECTED_REQUEST_ID",
                    "value": req.teardownExpectedRequestId,
                }
            )
        if req.teardownExpectedSourceRevision:
            env.append(
                {
                    "name": "TEARDOWN_EXPECTED_SOURCE_REVISION",
                    "value": req.teardownExpectedSourceRevision,
                }
            )
        if req.teardownProtectedRequestId:
            env.append(
                {
                    "name": "TEARDOWN_PROTECTED_REQUEST_ID",
                    "value": req.teardownProtectedRequestId,
                }
            )
        if failed_preinitialized_proof is not None:
            env.extend(
                [
                    {
                        "name": "TEARDOWN_EXPECTED_PLATFORM_REVISION",
                        "value": req.teardownExpectedPlatformRevision,
                    },
                    {
                        "name": "TEARDOWN_EXPECTED_CATALOG_DIGEST",
                        "value": req.teardownExpectedCatalogDigest,
                    },
                    {
                        "name": "TEARDOWN_DELETION_TIMESTAMP",
                        "value": req.teardownDeletionTimestamp,
                    },
                    {
                        "name": "TEARDOWN_ENVIRONMENT_UID",
                        "value": req.teardownEnvironmentUid,
                    },
                    {
                        "name": "TEARDOWN_INTENT_ID",
                        "value": req.teardownIntentId,
                    },
                    {
                        "name": "TEARDOWN_PREINIT_EVIDENCE",
                        "value": (
                            failed_preinitialized_proof.preinitialization_evidence
                        ),
                    },
                    {
                        "name": "TEARDOWN_PHYSICAL_NAMESPACE_UID",
                        "value": failed_preinitialized_proof.physical_namespace_uid,
                    },
                    {
                        "name": "TEARDOWN_FAILED_UP_RUNNER_GENERATION",
                        "value": (
                            failed_preinitialized_proof.failed_up_runner_generation
                        ),
                    },
                    *(
                        [
                            {
                                "name": "TEARDOWN_FAILED_UP_JOB_UID",
                                "value": failed_preinitialized_proof.failed_up_job_uid,
                            }
                        ]
                        if failed_preinitialized_proof.failed_up_job_uid
                        else []
                    ),
                ]
            )
    if req.imageOverrides:
        env.append(
            {
                "name": "PREVIEW_IMAGES",
                "value": json.dumps(
                    req.imageOverrides, separators=(",", ":"), sort_keys=True
                ),
            }
        )
    owner = _preview_owner(req.owner)
    if owner is not None:
        env.extend(
            [
                {"name": "PREVIEW_OWNER_KIND", "value": owner.kind},
                {"name": "PREVIEW_OWNER", "value": owner.id},
            ]
        )
    elif isinstance(req.owner, str) and req.owner:
        env.append({"name": "PREVIEW_OWNER", "value": req.owner})
    origin = _preview_origin(req.origin)
    if req.lifecycle:
        env.append({"name": "PREVIEW_LIFECYCLE", "value": req.lifecycle})
    if origin is not None:
        env.append({"name": "PREVIEW_ORIGIN_KIND", "value": origin.kind})
        if origin.reference:
            env.append({"name": "PREVIEW_ORIGIN_REFERENCE", "value": origin.reference})
    if req.catalogDigest:
        env.append({"name": "PREVIEW_CATALOG_DIGEST", "value": req.catalogDigest})
    if req.candidatePaths:
        env.append(
            {
                "name": "PREVIEW_CANDIDATE_PATHS",
                "value": json.dumps(req.candidatePaths, separators=(",", ":")),
            }
        )
    if req.provenance is not None:
        env.append(
            {
                "name": "PREVIEW_PROVENANCE",
                "value": json.dumps(
                    req.provenance, separators=(",", ":"), sort_keys=True
                ),
            }
        )
    if req.sourceRevision:
        env.append({"name": "SOURCE_REVISION", "value": req.sourceRevision})
    if req.services:
        env.append(
            {
                "name": "PREVIEW_SERVICES",
                "value": json.dumps(req.services, separators=(",", ":")),
            }
        )
    if req.profile:
        env.append(
            {
                "name": "TRUSTED_CODE",
                "value": "true" if req.trustedCode else "false",
            }
        )
    # Per-preview DB backend (cnpg = isolated CloudNativePG inside the vcluster).
    preview_db_mode = (
        "cnpg"
        if req.profile
        else req.previewDbMode or os.environ.get("VCLUSTER_PREVIEW_DB_MODE", "shared")
    )
    env.append({"name": "PREVIEW_DB_MODE", "value": preview_db_mode})
    # Profiled previews default to bounded async OTLP through their tuple-injecting physical
    # gateway. The platform environment retains a disabled rollback; callers cannot choose it.
    if req.profile:
        preview_observability = os.environ.get(
            "VCLUSTER_PREVIEW_OBSERVABILITY", "async"
        )
        if preview_observability not in {"async", "disabled"}:
            raise ValueError(
                "VCLUSTER_PREVIEW_OBSERVABILITY must be async or disabled"
            )
    else:
        preview_observability = req.previewObservability or os.environ.get(
            "VCLUSTER_PREVIEW_OBSERVABILITY", "disabled"
        )
    env.append({"name": "PREVIEW_OBSERVABILITY", "value": preview_observability})
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
    preview_db_bootstrap = (
        "migrate"
        if req.profile
        else req.previewDbBootstrap
        or os.environ.get("VCLUSTER_PREVIEW_DB_BOOTSTRAP", "migrate")
    )
    env.append({"name": "PREVIEW_DB_BOOTSTRAP", "value": preview_db_bootstrap})
    # A3 warm pool: bake a generic free member (runner labels the ns free + skips cred-copy).
    if req.pool:
        env.append({"name": "POOL", "value": "true"})
    # D1 lifecycle metadata → the runner stamps these on the host preview ns at bringup
    # (SEA can't stamp a COLD provision itself — the ns doesn't exist yet at accept time;
    # the CLAIM path stamps them SEA-side inside the atomic label flip instead). The expiry
    # is computed HERE (Python) so the runner never does busybox date math.
    legacy_origin = _legacy_preview_origin(req.origin)
    if legacy_origin is not None:
        env.append({"name": "ORIGIN", "value": legacy_origin})
    if req.prNumber is not None and req.prNumber > 0:
        env.append({"name": "PR_NUMBER", "value": str(req.prNumber)})
    if req.ttlHours is not None and 1 <= req.ttlHours <= 168:
        env.append({"name": "PREVIEW_TTL_HOURS", "value": str(req.ttlHours)})
        if req.profile and isinstance(req.provenance, dict):
            requested_at = req.provenance.get("requestedAt")
            try:
                expiry_base = datetime.fromisoformat(
                    str(requested_at).removesuffix("Z") + "+00:00"
                ).astimezone(UTC)
            except (TypeError, ValueError) as exc:
                raise HTTPException(
                    status_code=400,
                    detail=(
                        "profiled expiry requires provenance.requestedAt as an "
                        "RFC3339 UTC timestamp"
                    ),
                ) from exc
            expires_at = (
                (expiry_base + timedelta(hours=req.ttlHours))
                .isoformat()
                .replace("+00:00", "Z")
            )
        else:
            expires_at = (
                (datetime.now(UTC) + timedelta(hours=req.ttlHours))
                .isoformat(timespec="seconds")
                .replace("+00:00", "Z")
            )
        env.append({"name": "EXPIRES_AT", "value": expires_at})
    if enroll_mode == "agent" and req.action in {"up", "claim"}:
        target_revision = (
            req.platformRevision
            or req.targetRevision
            or os.environ.get("VCLUSTER_PREVIEW_TARGET_REVISION", "main")
        )
        if req.profile and not re.fullmatch(r"[0-9a-f]{40}", target_revision):
            raise HTTPException(
                status_code=400,
                detail=(
                    "profiled up/claim Jobs require TARGET_REVISION to be a full "
                    "lowercase 40-character Git SHA"
                ),
            )
        env.append(
            {
                "name": "TARGET_REVISION",
                "value": target_revision,
            }
        )
    return {
        "apiVersion": "batch/v1",
        "kind": "Job",
        "metadata": {
            "name": job_name,
            "namespace": namespace,
            "labels": dict(runner_labels),
            **({"annotations": dict(runner_annotations)} if runner_annotations else {}),
        },
        "spec": {
            "backoffLimit": 0,
            # A successful down Job is a short-lived cleanup receipt used by an
            # idempotent repeated teardown after namespace and identity deletion.
            # Keep it long enough for retries, but do not leave proof runs behind
            # indefinitely. Profiled up Jobs are immutable preinitialization
            # evidence; keep them for one day.
            "ttlSecondsAfterFinished": 1800
            if req.action == "down"
            else (86400 if req.profile else 1800),
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
                "metadata": {
                    "labels": dict(runner_labels),
                    **(
                        {"annotations": dict(runner_annotations)}
                        if runner_annotations
                        else {}
                    ),
                },
                "spec": {
                    "restartPolicy": "Never",
                    "serviceAccountName": preview_runner_identity_name(preview_name),
                    "automountServiceAccountToken": True,
                    "enableServiceLinks": False,
                    "securityContext": {
                        "runAsNonRoot": True,
                        "runAsUser": 1001,
                        "runAsGroup": 1001,
                        "fsGroup": 1001,
                        "fsGroupChangePolicy": "OnRootMismatch",
                        "seccompProfile": {"type": "RuntimeDefault"},
                    },
                    # The custom runner image (with argocd-agentctl, for agent mode) is a
                    # PRIVATE ghcr package — stock alpine/k8s was public, so the Job had no
                    # pull secret. Harmless for the public default image.
                    "imagePullSecrets": [{"name": "preview-ghcr-pull-credentials"}],
                    "containers": [
                        {
                            "name": "runner",
                            "image": image,
                            "command": [
                                "bash",
                                "/opt/preview-runner/runner.sh",
                            ],
                            "env": env,
                            "securityContext": {
                                "allowPrivilegeEscalation": False,
                                "readOnlyRootFilesystem": True,
                                "capabilities": {"drop": ["ALL"]},
                            },
                            "resources": {
                                "requests": {"cpu": "250m", "memory": "256Mi"},
                                "limits": {"cpu": "2", "memory": "1Gi"},
                            },
                            "volumeMounts": [
                                {
                                    "name": "tmp",
                                    "mountPath": "/tmp",
                                },
                                {
                                    "name": "ghcr-pull",
                                    "mountPath": (
                                        "/var/run/preview-credentials/ghcr-pull"
                                    ),
                                    "readOnly": True,
                                },
                            ],
                        }
                    ],
                    "volumes": [
                        {
                            "name": "tmp",
                            "emptyDir": {"sizeLimit": "1Gi"},
                        },
                        {
                            "name": "ghcr-pull",
                            "secret": {
                                "secretName": "preview-ghcr-pull-credentials",
                                "defaultMode": 0o400,
                                "items": [
                                    {
                                        "key": ".dockerconfigjson",
                                        "path": ".dockerconfigjson",
                                        "mode": 0o400,
                                    }
                                ],
                            },
                        },
                    ],
                },
            },
        },
    }


def _preview_job_manifest_is_subset(desired: Any, actual: Any) -> bool:
    if isinstance(desired, dict):
        return isinstance(actual, dict) and all(
            key in actual and _preview_job_manifest_is_subset(value, actual[key])
            for key, value in desired.items()
        )
    if isinstance(desired, list):
        return (
            isinstance(actual, list)
            and len(desired) == len(actual)
            and all(
                _preview_job_manifest_is_subset(expected, observed)
                for expected, observed in zip(desired, actual)
            )
        )
    return desired == actual


def _serialize_preview_job(job: Any) -> dict[str, Any]:
    if isinstance(job, dict):
        return job
    from kubernetes import client

    return client.ApiClient().sanitize_for_serialization(job)


def _preview_job_matches_manifest(job: Any, manifest: dict[str, Any]) -> bool:
    return _preview_job_manifest_is_subset(manifest, _serialize_preview_job(job))


def _preview_job_has_attempt_generation(job: Any, manifest: dict[str, Any]) -> bool:
    actual = _serialize_preview_job(job)
    desired_generation = (
        manifest.get("metadata", {})
        .get("annotations", {})
        .get(RUNNER_GENERATION_ANNOTATION)
    )
    actual_generation = (
        actual.get("metadata", {})
        .get("annotations", {})
        .get(RUNNER_GENERATION_ANNOTATION)
    )
    actual_pod_generation = (
        actual.get("spec", {})
        .get("template", {})
        .get("metadata", {})
        .get("annotations", {})
        .get(RUNNER_GENERATION_ANNOTATION)
    )
    return (
        isinstance(desired_generation, str)
        and actual_generation == desired_generation
        and actual_pod_generation == desired_generation
    )


def _resolve_ambiguous_preview_job_create(
    batch: Any,
    *,
    namespace: str,
    job_name: str,
    manifest: dict[str, Any],
    create_exc: Exception,
) -> bool:
    try:
        current = batch.read_namespaced_job(name=job_name, namespace=namespace)
    except Exception:
        raise create_exc
    if _preview_job_matches_manifest(current, manifest):
        return True
    if not _preview_job_has_attempt_generation(current, manifest):
        raise PreviewRunnerIdentityError(
            "ambiguous preview Job create did not produce the exact manifest"
        ) from create_exc
    try:
        batch.delete_namespaced_job(
            name=job_name,
            namespace=namespace,
            propagation_policy="Background",
        )
    except Exception as delete_exc:
        if getattr(delete_exc, "status", None) != 404:
            raise PreviewRunnerIdentityError(
                "ambiguous preview Job create compensation failed"
            ) from delete_exc
    for _ in range(20):
        try:
            batch.read_namespaced_job(name=job_name, namespace=namespace)
            time.sleep(0.1)
        except Exception as read_exc:
            if getattr(read_exc, "status", None) == 404:
                raise PreviewRunnerIdentityError(
                    "ambiguous preview Job create produced a mismatched object; "
                    "the object was compensated"
                ) from create_exc
            raise PreviewRunnerIdentityError(
                "ambiguous preview Job compensation could not prove absence"
            ) from read_exc
    raise PreviewRunnerIdentityError(
        "ambiguous preview Job compensation did not remove the mismatched object"
    ) from create_exc


def _create_preview_job(
    batch,
    *,
    namespace: str,
    manifest: dict[str, Any],
    create_only: bool = False,
) -> bool:
    """Idempotently (re)create a preview provisioning/claim/teardown Job: clear a prior
    same-name Job, wait for it to clear, then create. Shared by provision, claim, and the
    A3 pool manager so all three get the same delete→settle→create behavior. Failure to
    confirm the replacement, including a persistent 409, is reported to the caller."""
    job_name = manifest["metadata"]["name"]
    if create_only:
        try:
            batch.create_namespaced_job(namespace=namespace, body=manifest)
            return True
        except Exception as create_exc:
            if getattr(create_exc, "status", None) == 409:
                raise
            if getattr(create_exc, "status", None) not in {
                None,
                500,
                502,
                503,
                504,
            }:
                raise
            return _resolve_ambiguous_preview_job_create(
                batch,
                namespace=namespace,
                job_name=job_name,
                manifest=manifest,
                create_exc=create_exc,
            )
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
    except Exception as create_exc:
        if getattr(create_exc, "status", None) not in {None, 500, 502, 503, 504}:
            raise
        return _resolve_ambiguous_preview_job_create(
            batch,
            namespace=namespace,
            job_name=job_name,
            manifest=manifest,
            create_exc=create_exc,
        )
    return True


def _submit_preview_job(
    batch: Any,
    core: Any,
    *,
    namespace: str,
    manifest: dict[str, Any],
    lifecycle: str | None = None,
    create_only: bool = False,
    allow_absent_down_bootstrap: bool = False,
    expected_existing_runner_generation: str | None = None,
) -> bool:
    """Establish the exact per-preview identity before handing work to Kubernetes."""
    metadata = manifest.get("metadata") or {}
    labels = metadata.get("labels") or {}
    preview_name = labels.get("vcluster-preview-name")
    action = labels.get("vcluster-preview-action")
    if not isinstance(preview_name, str) or not isinstance(action, str):
        raise PreviewRunnerIdentityError(
            "preview Job is missing its exact name/action identity"
        )
    if action not in {"up", "down", "claim", "sleep", "resume"}:
        raise PreviewRunnerIdentityError("preview Job action is not allowed")
    if allow_absent_down_bootstrap and action != "down":
        raise PreviewRunnerIdentityError(
            "absent identity bootstrap is allowed only for down"
        )
    required_labels = {
        "app": "vcluster-preview",
        "vcluster-preview-name": preview_name,
        "vcluster-preview-action": action,
        "preview.stacks.io/managed": "true",
        "preview.stacks.io/preview-name": preview_name,
    }
    pod_labels = (
        manifest.get("spec", {}).get("template", {}).get("metadata", {}).get("labels")
        or {}
    )
    if any(
        labels.get(key) != value or pod_labels.get(key) != value
        for key, value in required_labels.items()
    ):
        raise PreviewRunnerIdentityError(
            "preview Job and pod labels do not match their identity"
        )
    if metadata.get("name") != _vcluster_preview_job_name(preview_name, action):
        raise PreviewRunnerIdentityError("preview Job name does not match its identity")
    expected_service_account = preview_runner_identity_name(preview_name)
    actual_service_account = (
        manifest.get("spec", {})
        .get("template", {})
        .get("spec", {})
        .get("serviceAccountName")
    )
    if actual_service_account != expected_service_account:
        raise PreviewRunnerIdentityError(
            "preview Job serviceAccountName does not match its preview identity"
        )
    if namespace != _vcluster_preview_control_namespace():
        raise PreviewRunnerIdentityError(
            "preview Job must run in the preview control namespace"
        )
    if metadata.get("namespace") != namespace:
        raise PreviewRunnerIdentityError(
            "preview Job metadata namespace does not match its submission namespace"
        )

    annotations = metadata.setdefault("annotations", {})
    pod_metadata = (
        manifest.setdefault("spec", {})
        .setdefault("template", {})
        .setdefault("metadata", {})
    )
    pod_annotations = pod_metadata.setdefault("annotations", {})
    job_generation = annotations.get(RUNNER_GENERATION_ANNOTATION)
    pod_generation = pod_annotations.get(RUNNER_GENERATION_ANNOTATION)
    if job_generation is None and pod_generation is None:
        job_generation = f"op:{secrets.token_hex(16)}"
        annotations[RUNNER_GENERATION_ANNOTATION] = job_generation
        pod_annotations[RUNNER_GENERATION_ANNOTATION] = job_generation
    if (
        not isinstance(job_generation, str)
        or not re.fullmatch(r"op:[0-9a-f]{32}", job_generation)
        or pod_generation not in {None, job_generation}
    ):
        raise PreviewRunnerIdentityError(
            "preview Job and pod runner generations do not match"
        )
    pod_annotations[RUNNER_GENERATION_ANNOTATION] = job_generation
    operation_holder = next(
        (
            item.get("value")
            for item in manifest["spec"]["template"]["spec"]["containers"][0].get(
                "env", []
            )
            if item.get("name") == "PREVIEW_OPERATION_HOLDER"
        ),
        None,
    )
    if operation_holder is not None and operation_holder != job_generation:
        raise PreviewRunnerIdentityError(
            "preview Job generation does not match its operation Lease holder"
        )
    failed_up_generation = next(
        (
            item.get("value")
            for item in manifest["spec"]["template"]["spec"]["containers"][0].get(
                "env", []
            )
            if item.get("name") == "TEARDOWN_FAILED_UP_RUNNER_GENERATION"
        ),
        None,
    )
    if bool(expected_existing_runner_generation) != bool(failed_up_generation) or (
        expected_existing_runner_generation is not None
        and (
            action != "down"
            or failed_up_generation != expected_existing_runner_generation
            or failed_up_generation == job_generation
        )
    ):
        raise PreviewRunnerIdentityError(
            "preserved namespace generation requires the exact failed-up proof"
        )

    identity = PreviewRunnerIdentityAdapter(core, _load_k8s_rbac_client())
    reservation = identity.ensure_for_job(
        preview_name=preview_name,
        action=action,
        lifecycle=lifecycle,
        runner_generation=job_generation,
        allow_absent_down_bootstrap=allow_absent_down_bootstrap,
        expected_existing_runner_generation=expected_existing_runner_generation,
    )
    if reservation.identity_name != actual_service_account:
        identity.rollback_before_job(reservation)
        raise PreviewRunnerIdentityError(
            "established preview identity does not match the Job"
        )
    try:
        created = _create_preview_job(
            batch,
            namespace=namespace,
            manifest=manifest,
            create_only=create_only,
        )
    except Exception as job_exc:
        try:
            identity.rollback_before_job(reservation)
        except PreviewRunnerIdentityError as rollback_exc:
            raise PreviewRunnerIdentityError(
                f"preview Job admission failed ({job_exc}); "
                f"identity compensation incomplete ({rollback_exc})"
            ) from job_exc
        raise
    try:
        identity.mark_job_admitted(reservation)
    except PreviewRunnerIdentityError as exc:
        # The Job is already admitted and carries the operation Lease. The
        # reservation reconciler repairs this marker after proving that exact Job;
        # treating this as submission failure would release its Lease underneath it.
        logger.warning(
            "preview runner admission marker pending for %s: %s",
            preview_name,
            exc,
        )
    return created


@dataclass(frozen=True)
class _PreviewDownReceiptState:
    exact: bool = False
    succeeded: bool = False
    failed: bool = False

    @property
    def in_flight(self) -> bool:
        return self.exact and not self.succeeded and not self.failed


def _preview_down_receipt_state(
    batch: Any,
    *,
    namespace: str,
    preview_name: str,
    expected_request_id: str | None,
    expected_source_revision: str | None,
    protected_request_id: str | None,
    environment_uid: str | None,
    deletion_intent_id: str | None,
) -> _PreviewDownReceiptState:
    try:
        job = batch.read_namespaced_job_status(
            name=_vcluster_preview_job_name(preview_name, "down"),
            namespace=namespace,
            _request_timeout=_VCLUSTER_PREVIEW_PROBE_TIMEOUT,
        )
    except Exception as exc:
        if getattr(exc, "status", None) == 404:
            return _PreviewDownReceiptState()
        raise
    if _down_job_identity(job) != preview_name:
        return _PreviewDownReceiptState()
    annotations = getattr(getattr(job, "metadata", None), "annotations", None) or {}
    expected_annotations: dict[str, str] = {}
    if expected_request_id and expected_source_revision:
        expected_annotations = {
            "preview.stacks.io/teardown-request-id": expected_request_id,
            "preview.stacks.io/teardown-source-revision": expected_source_revision,
        }
    elif protected_request_id:
        expected_annotations = {
            "preview.stacks.io/teardown-protected-request-id": protected_request_id
        }
    if environment_uid and deletion_intent_id:
        expected_annotations.update(
            {
                "preview.stacks.io/teardown-environment-uid": environment_uid,
                "preview.stacks.io/teardown-intent-id": deletion_intent_id,
            }
        )
    guard_keys = {
        "preview.stacks.io/teardown-request-id",
        "preview.stacks.io/teardown-source-revision",
        "preview.stacks.io/teardown-protected-request-id",
        "preview.stacks.io/teardown-environment-uid",
        "preview.stacks.io/teardown-intent-id",
    }
    if {key: annotations.get(key) for key in guard_keys if key in annotations} != (
        expected_annotations
    ):
        return _PreviewDownReceiptState()
    succeeded, failed, _ = _preview_job_state(job)
    return _PreviewDownReceiptState(
        exact=True,
        succeeded=succeeded and not failed,
        failed=failed,
    )


def _capacity_lease_name() -> str:
    return (os.environ.get("DEV_PREVIEW_CAPACITY_LEASE_NAME") or "").strip()


def _lease_timestamp(value: Any) -> datetime | None:
    if isinstance(value, datetime):
        return value.astimezone(UTC) if value.tzinfo else value.replace(tzinfo=UTC)
    if isinstance(value, str):
        try:
            parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
        except ValueError:
            return None
        return parsed.astimezone(UTC) if parsed.tzinfo else parsed.replace(tzinfo=UTC)
    return None


def _lease_body(
    lease: Any,
    *,
    name: str,
    namespace: str,
    holder: str | None,
    duration_seconds: int,
) -> dict[str, Any]:
    metadata = getattr(lease, "metadata", None)
    resource_version = getattr(metadata, "resource_version", None)
    now = datetime.now(UTC).isoformat(timespec="microseconds").replace("+00:00", "Z")
    return {
        "apiVersion": "coordination.k8s.io/v1",
        "kind": "Lease",
        "metadata": {
            "name": name,
            "namespace": namespace,
            "resourceVersion": resource_version,
        },
        "spec": {
            "holderIdentity": holder,
            "leaseDurationSeconds": duration_seconds,
            "acquireTime": now if holder else None,
            "renewTime": now if holder else None,
        },
    }


@contextmanager
def _preview_capacity_lease(coordination: Any, *, namespace: str):
    """Serialize preview admission through one pre-created, narrowly RBAC-scoped Lease."""
    name = _capacity_lease_name()
    if not name:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="preview capacity Lease is not configured",
        )
    duration = _env_int("DEV_PREVIEW_CAPACITY_LEASE_SECONDS", 120, minimum=30)
    wait_seconds = _env_int("DEV_PREVIEW_CAPACITY_LEASE_WAIT_SECONDS", 15, minimum=1)
    holder = f"{os.environ.get('HOSTNAME', 'sandbox-execution-api')}-{uuid4().hex}"
    deadline = time.monotonic() + wait_seconds
    acquired = False
    while time.monotonic() < deadline:
        try:
            lease = coordination.read_namespaced_lease(name=name, namespace=namespace)
        except Exception as exc:
            if getattr(exc, "status", None) == 404:
                raise HTTPException(
                    status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                    detail=f"preview capacity Lease {namespace}/{name} does not exist",
                ) from exc
            raise HTTPException(
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                detail="could not read preview capacity Lease",
            ) from exc
        spec = getattr(lease, "spec", None)
        current_holder = getattr(spec, "holder_identity", None)
        lease_duration = int(getattr(spec, "lease_duration_seconds", None) or duration)
        renewed = _lease_timestamp(
            getattr(spec, "renew_time", None) or getattr(spec, "acquire_time", None)
        )
        expired = (
            not current_holder
            or renewed is None
            or datetime.now(UTC) >= renewed + timedelta(seconds=lease_duration)
        )
        if expired:
            try:
                coordination.replace_namespaced_lease(
                    name=name,
                    namespace=namespace,
                    body=_lease_body(
                        lease,
                        name=name,
                        namespace=namespace,
                        holder=holder,
                        duration_seconds=duration,
                    ),
                )
                acquired = True
                break
            except Exception as exc:
                if getattr(exc, "status", None) != 409:
                    raise HTTPException(
                        status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                        detail="could not acquire preview capacity Lease",
                    ) from exc
        time.sleep(0.1)
    if not acquired:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="preview capacity Lease is busy",
        )
    try:
        yield
    finally:
        try:
            lease = coordination.read_namespaced_lease(name=name, namespace=namespace)
            spec = getattr(lease, "spec", None)
            if getattr(spec, "holder_identity", None) == holder:
                coordination.replace_namespaced_lease(
                    name=name,
                    namespace=namespace,
                    body=_lease_body(
                        lease,
                        name=name,
                        namespace=namespace,
                        holder=None,
                        duration_seconds=duration,
                    ),
                )
        except Exception as exc:
            logger.warning("preview capacity Lease release failed: %s", exc)


_PREVIEW_OPERATION_LEASE_SECONDS = 90


def _preview_operation_lease_name(real_name: str) -> str:
    safe_name = _safe_resource_name(real_name, max_length=40)
    if safe_name != real_name:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="preview operation Lease requires a canonical preview name",
        )
    return _safe_resource_name(f"vcpreview-op-{safe_name}", max_length=63)


def _preview_operation_lease_body(
    *,
    name: str,
    namespace: str,
    holder: str,
    resource_version: str | None = None,
    transitions: int = 0,
) -> dict[str, Any]:
    if holder and not re.fullmatch(r"op:[0-9a-f]{32}", holder):
        raise ValueError("preview operation holder is invalid")
    now = datetime.now(UTC).isoformat(timespec="microseconds").replace("+00:00", "Z")
    metadata: dict[str, str] = {"name": name, "namespace": namespace}
    if resource_version:
        metadata["resourceVersion"] = resource_version
    return {
        "apiVersion": "coordination.k8s.io/v1",
        "kind": "Lease",
        "metadata": metadata,
        "spec": {
            "holderIdentity": holder,
            "leaseDurationSeconds": _PREVIEW_OPERATION_LEASE_SECONDS,
            "acquireTime": now,
            "renewTime": now,
            "leaseTransitions": max(0, transitions),
        },
    }


def _preview_operation_lease_fields(
    lease: Any,
) -> tuple[str, int, datetime | None, int]:
    spec = getattr(lease, "spec", None)
    holder = str(getattr(spec, "holder_identity", None) or "")
    duration = int(
        getattr(spec, "lease_duration_seconds", None)
        or _PREVIEW_OPERATION_LEASE_SECONDS
    )
    renewed = _lease_timestamp(
        getattr(spec, "renew_time", None) or getattr(spec, "acquire_time", None)
    )
    transitions = int(getattr(spec, "lease_transitions", None) or 0)
    return holder, duration, renewed, transitions


def _acquire_preview_operation_lease(
    coordination: Any, *, namespace: str, real_name: str
) -> str:
    """CAS-reserve one preview before any mutable operation.

    The runner receives the returned holder and renews the Lease for its entire
    lifetime. SEA releases only when it fails before handing the operation to a Job.
    """
    name = _preview_operation_lease_name(real_name)
    holder = f"op:{uuid4().hex}"
    try:
        lease = coordination.read_namespaced_lease(name=name, namespace=namespace)
    except Exception as exc:
        if getattr(exc, "status", None) != 404:
            raise HTTPException(
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                detail=f"could not read preview operation Lease for {real_name}",
            ) from exc
        try:
            coordination.create_namespaced_lease(
                namespace=namespace,
                body=_preview_operation_lease_body(
                    name=name,
                    namespace=namespace,
                    holder=holder,
                ),
            )
            return holder
        except Exception as create_exc:
            if getattr(create_exc, "status", None) == 409:
                raise HTTPException(
                    status_code=status.HTTP_409_CONFLICT,
                    detail=f"preview {real_name} already has an operation in progress",
                ) from create_exc
            raise HTTPException(
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                detail=f"could not create preview operation Lease for {real_name}",
            ) from create_exc

    current, duration, renewed, transitions = _preview_operation_lease_fields(lease)
    expired = (
        not current
        or renewed is None
        or datetime.now(UTC) >= renewed + timedelta(seconds=duration)
    )
    if not expired:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=f"preview {real_name} already has an operation in progress",
        )
    metadata = getattr(lease, "metadata", None)
    try:
        coordination.replace_namespaced_lease(
            name=name,
            namespace=namespace,
            body=_preview_operation_lease_body(
                name=name,
                namespace=namespace,
                holder=holder,
                resource_version=getattr(metadata, "resource_version", None),
                transitions=transitions + (1 if current else 0),
            ),
        )
    except Exception as exc:
        if getattr(exc, "status", None) == 409:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail=f"preview {real_name} already has an operation in progress",
            ) from exc
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail=f"could not acquire preview operation Lease for {real_name}",
        ) from exc
    return holder


def _release_preview_operation_lease(
    coordination: Any, *, namespace: str, real_name: str, holder: str
) -> None:
    """CAS-clear only the caller's reservation; never release a successor's Lease."""
    name = _preview_operation_lease_name(real_name)
    try:
        lease = coordination.read_namespaced_lease(name=name, namespace=namespace)
        current, _duration, _renewed, transitions = _preview_operation_lease_fields(
            lease
        )
        if current != holder:
            return
        metadata = getattr(lease, "metadata", None)
        coordination.replace_namespaced_lease(
            name=name,
            namespace=namespace,
            body=_preview_operation_lease_body(
                name=name,
                namespace=namespace,
                holder="",
                resource_version=getattr(metadata, "resource_version", None),
                transitions=transitions,
            ),
        )
    except Exception as exc:
        logger.warning(
            "preview operation Lease release failed for %s (%s): %s",
            real_name,
            holder,
            exc,
        )


def _delete_preview_operation_lease(
    coordination: Any,
    *,
    namespace: str,
    real_name: str,
    holder: str,
) -> bool:
    """Release and delete only the exact caller-owned operation Lease."""
    name = _preview_operation_lease_name(real_name)
    try:
        lease = coordination.read_namespaced_lease(name=name, namespace=namespace)
    except Exception as exc:
        if getattr(exc, "status", None) == 404:
            return True
        raise PreviewRunnerIdentityError(
            f"could not read cleanup Lease for {real_name}: {exc}"
        ) from exc
    current, _duration, _renewed, _transitions = _preview_operation_lease_fields(lease)
    if current != holder:
        raise PreviewRunnerIdentityError(
            f"cleanup Lease ownership changed for {real_name}"
        )
    metadata = getattr(lease, "metadata", None)
    resource_version = str(getattr(metadata, "resource_version", None) or "")
    lease_uid = str(getattr(metadata, "uid", None) or "")
    if not lease_uid:
        raise PreviewRunnerIdentityError(
            f"cleanup Lease UID is missing for {real_name}"
        )
    if current:
        if not resource_version:
            raise PreviewRunnerIdentityError(
                f"cleanup Lease resourceVersion is missing for {real_name}"
            )
        try:
            release_body = _preview_operation_lease_body(
                name=name,
                namespace=namespace,
                holder="",
                resource_version=resource_version,
                transitions=_transitions,
            )
            release_body["metadata"]["uid"] = lease_uid
            coordination.replace_namespaced_lease(
                name=name,
                namespace=namespace,
                body=release_body,
            )
        except Exception as exc:
            if getattr(exc, "status", None) != 404:
                raise PreviewRunnerIdentityError(
                    f"could not release cleanup Lease for {real_name}: {exc}"
                ) from exc
        try:
            lease = coordination.read_namespaced_lease(name=name, namespace=namespace)
        except Exception as exc:
            if getattr(exc, "status", None) == 404:
                return True
            raise PreviewRunnerIdentityError(
                f"could not prove cleanup Lease release for {real_name}: {exc}"
            ) from exc
        released_metadata = getattr(lease, "metadata", None)
        released_uid = str(getattr(released_metadata, "uid", None) or "")
        released_holder, _duration, _renewed, _transitions = (
            _preview_operation_lease_fields(lease)
        )
        if released_uid != lease_uid or released_holder:
            raise PreviewRunnerIdentityError(
                f"cleanup Lease identity changed while releasing {real_name}"
            )
    try:
        coordination.delete_namespaced_lease(
            name=name,
            namespace=namespace,
            body={
                "apiVersion": "v1",
                "kind": "DeleteOptions",
                "propagationPolicy": "Background",
                "preconditions": {"uid": lease_uid},
            },
        )
    except Exception as exc:
        if getattr(exc, "status", None) != 404:
            raise PreviewRunnerIdentityError(
                f"could not delete cleanup Lease for {real_name}: {exc}"
            ) from exc
    for _ in range(30):
        try:
            remaining = coordination.read_namespaced_lease(
                name=name, namespace=namespace
            )
        except Exception as exc:
            if getattr(exc, "status", None) == 404:
                return True
            raise PreviewRunnerIdentityError(
                f"could not prove cleanup Lease absence for {real_name}: {exc}"
            ) from exc
        remaining_metadata = getattr(remaining, "metadata", None)
        remaining_uid = str(getattr(remaining_metadata, "uid", None) or "")
        if remaining_uid != lease_uid:
            raise PreviewRunnerIdentityError(
                f"cleanup Lease replacement appeared for {real_name}"
            )
        remaining_holder, _duration, _renewed, _transitions = (
            _preview_operation_lease_fields(remaining)
        )
        if remaining_holder:
            raise PreviewRunnerIdentityError(
                f"cleanup Lease was reacquired for {real_name}"
            )
        time.sleep(0.1)
    raise PreviewRunnerIdentityError(
        f"cleanup Lease deletion did not converge for {real_name}"
    )


@dataclass(frozen=True)
class _PreviewCapacitySnapshot:
    names: frozenset[str]
    awake: int
    total: int


def _preview_up_job_is_pending(job: Any) -> bool:
    status_value = getattr(job, "status", None)
    conditions = getattr(status_value, "conditions", None) or []
    terminal = any(
        getattr(condition, "type", None) in {"Complete", "Failed"}
        and str(getattr(condition, "status", "")).lower() == "true"
        for condition in conditions
    )
    return not terminal and not int(getattr(status_value, "succeeded", 0) or 0)


def _preview_capacity_snapshot(
    batch: Any, core: Any, *, namespace: str
) -> _PreviewCapacitySnapshot:
    names: set[str] = set()
    real_names: set[str] = set()
    awake_names: set[str] = set()
    namespaces = core.list_namespace(label_selector="app=vcluster-preview")
    for item in namespaces.items:
        metadata = getattr(item, "metadata", None)
        if getattr(metadata, "deletion_timestamp", None) is not None:
            continue
        labels = getattr(metadata, "labels", None) or {}
        real_name = labels.get("vcluster-preview-name")
        if not real_name:
            raw_name = getattr(metadata, "name", "") or ""
            real_name = raw_name.removeprefix("vcluster-")
        if not real_name:
            continue
        names.add(real_name)
        real_names.add(real_name)
        alias = labels.get("vcluster-preview-alias")
        if alias:
            names.add(alias)
        if labels.get("vcluster-preview-state") != "slept":
            awake_names.add(real_name)

    jobs = batch.list_namespaced_job(
        namespace=namespace, label_selector="vcluster-preview-action=up"
    )
    for job in jobs.items:
        if not _preview_up_job_is_pending(job):
            continue
        labels = getattr(getattr(job, "metadata", None), "labels", None) or {}
        pending_name = labels.get("vcluster-preview-name")
        if pending_name:
            names.add(pending_name)
            real_names.add(pending_name)
            awake_names.add(pending_name)
    return _PreviewCapacitySnapshot(
        names=frozenset(names), awake=len(awake_names), total=len(real_names)
    )


def _namespace_exists(core: Any, name: str) -> bool:
    try:
        core.read_namespace(name=f"vcluster-{name}")
        return True
    except Exception as exc:
        if getattr(exc, "status", None) == 404:
            return False
        raise


def _create_preview_with_capacity(
    batch: Any,
    core: Any,
    *,
    namespace: str,
    request: VclusterPreviewRequest,
    manifest: dict[str, Any],
) -> None:
    requested_name = _safe_resource_name(request.name, max_length=40)
    snapshot = _preview_capacity_snapshot(batch, core, namespace=namespace)
    exists = requested_name in snapshot.names
    if request.createOnly and (exists or _namespace_exists(core, requested_name)):
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=f"preview {requested_name} already exists",
        )
    if not exists:
        maximum = _vcluster_preview_max()
        if snapshot.awake >= maximum:
            raise HTTPException(
                status_code=status.HTTP_429_TOO_MANY_REQUESTS,
                detail=f"awake preview capacity reached ({snapshot.awake}/{maximum})",
            )
        total_maximum = _vcluster_preview_total_max()
        if total_maximum > 0 and snapshot.total >= total_maximum:
            raise HTTPException(
                status_code=status.HTTP_429_TOO_MANY_REQUESTS,
                detail=(
                    f"total preview capacity reached ({snapshot.total}/{total_maximum})"
                ),
            )
    try:
        _submit_preview_job(
            batch,
            core,
            namespace=namespace,
            manifest=manifest,
            lifecycle=request.lifecycle or "ephemeral",
            create_only=request.createOnly,
        )
    except Exception as exc:
        if request.createOnly and getattr(exc, "status", None) == 409:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail=f"preview {requested_name} already has a provisioning reservation",
            ) from exc
        raise


def _resume_preview_with_capacity(
    batch: Any,
    core: Any,
    *,
    name: str,
    namespace: str,
    operation_holder: str | None = None,
    coordination: Any | None = None,
) -> tuple[PreviewMember, bool]:
    coordination = coordination or _load_k8s_coordination_client()
    initial = _read_preview_member(core, name)
    holder = operation_holder or _acquire_preview_operation_lease(
        coordination, namespace=namespace, real_name=initial.real_name
    )
    handed_to_runner = False
    try:
        with _preview_capacity_lease(coordination, namespace=namespace):
            member = _read_preview_member(core, name)
            if member.real_name != initial.real_name:
                raise HTTPException(
                    status_code=status.HTTP_409_CONFLICT,
                    detail="preview alias changed while reserving resume",
                )
            if not member.slept:
                return member, False
            snapshot = _preview_capacity_snapshot(batch, core, namespace=namespace)
            maximum = _vcluster_preview_max()
            if snapshot.awake >= maximum:
                raise HTTPException(
                    status_code=status.HTTP_429_TOO_MANY_REQUESTS,
                    detail=f"awake preview capacity reached ({snapshot.awake}/{maximum})",
                )
            if not _resume_member(
                batch,
                core,
                member,
                namespace,
                operation_holder=holder,
            ):
                raise HTTPException(status_code=500, detail="preview resume failed")
            handed_to_runner = True
            return member, True
    finally:
        if not handed_to_runner:
            _release_preview_operation_lease(
                coordination,
                namespace=namespace,
                real_name=initial.real_name,
                holder=holder,
            )


def _preview_service_catalog():
    """Load the authoritative catalog at the SEA trust boundary.

    Production mounts the catalog at /config. The repository-relative fallback
    keeps local tests and operator validation on the exact same document.
    """
    from src.preview_environment_controller import (
        DEFAULT_SERVICE_CATALOG_PATH,
        SERVICE_CATALOG_PATH_ENV,
        CatalogValidationError,
        load_preview_service_catalog,
    )

    configured = (os.environ.get(SERVICE_CATALOG_PATH_ENV) or "").strip()
    candidates = (
        [Path(configured)] if configured else [Path(DEFAULT_SERVICE_CATALOG_PATH)]
    )
    if not configured:
        candidates.append(
            Path(__file__).resolve().parents[2]
            / "shared"
            / "dev-preview-service-catalog.json"
        )
    for candidate in candidates:
        if not candidate.is_file():
            continue
        try:
            return load_preview_service_catalog(candidate)
        except CatalogValidationError as exc:
            raise HTTPException(
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                detail=f"preview service catalog is invalid: {exc}",
            ) from exc
    raise HTTPException(
        status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
        detail="preview service catalog is not mounted",
    )


def _manifest_candidate_surface() -> dict[str, Any]:
    path = os.environ.get(
        "PREVIEW_MANIFEST_CANDIDATE_SURFACE_PATH",
        DEFAULT_MANIFEST_CANDIDATE_SURFACE_PATH,
    )
    try:
        document = json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail=f"manifest candidate surface contract is unavailable: {exc}",
        ) from exc
    if (
        not isinstance(document, dict)
        or document.get("schemaVersion") != 1
        or document.get("profile") != "manifest-candidate"
        or not isinstance(document.get("allowedSurfaces"), list)
        or not document["allowedSurfaces"]
        or not isinstance(document.get("routeRules"), list)
    ):
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="manifest candidate surface contract is invalid",
        )
    return document


def _path_matches_prefix(path: str, prefix: str) -> bool:
    return path.startswith(prefix) if prefix.endswith("/") else path == prefix


def _validate_candidate_paths(body: VclusterPreviewRequest) -> None:
    paths = body.candidatePaths
    if body.profile != "manifest-candidate":
        if paths:
            raise HTTPException(
                status_code=400,
                detail="candidatePaths are allowed only for manifest-candidate",
            )
        return
    if not paths:
        raise HTTPException(
            status_code=400, detail="manifest-candidate requires candidatePaths"
        )
    if len(set(paths)) != len(paths):
        raise HTTPException(
            status_code=400, detail="candidatePaths must not duplicate paths"
        )
    for path in paths:
        if (
            not isinstance(path, str)
            or not path
            or len(path) > 512
            or path.startswith("/")
            or "\\" in path
            or any(part in {"", ".", ".."} for part in path.split("/"))
        ):
            raise HTTPException(
                status_code=400,
                detail="candidatePaths must contain normalized repository-relative paths",
            )
    contract = _manifest_candidate_surface()
    expected_lane = body.lane or "application"
    for path in paths:
        if expected_lane == "application" and any(
            isinstance(entry, dict)
            and isinstance(entry.get("pathPrefix"), str)
            and _path_matches_prefix(path, entry["pathPrefix"])
            for entry in contract["allowedSurfaces"]
        ):
            continue
        route = next(
            (
                entry
                for entry in contract["routeRules"]
                if isinstance(entry, dict)
                and isinstance(entry.get("pathPrefix"), str)
                and _path_matches_prefix(path, entry["pathPrefix"])
            ),
            None,
        )
        if route:
            raise HTTPException(
                status_code=409,
                detail=(
                    f"candidate path {path} requires {route.get('profile')} "
                    f"lane {route.get('lane')}: "
                    f"{route.get('reason')}"
                ),
            )
        raise HTTPException(
            status_code=400,
            detail=f"candidate path {path} is outside the executable preview surface",
        )


def _validate_profiled_preview_request(body: VclusterPreviewRequest) -> None:
    """Validate the new immutable PreviewEnvironment request without changing the
    legacy vCluster API contract during the delivery cutover."""
    if body.action != "up":
        return
    if body.profile is None:
        raise HTTPException(
            status_code=400,
            detail="new preview creation requires the profiled PreviewEnvironment contract",
        )
    if body.name.startswith("pool-") or body.name in {
        "mtxdev1",
        "mtxtmpl1",
        "preview6",
        "ganpilot",
        "ganvalidate",
        "test3",
    }:
        raise HTTPException(
            status_code=400,
            detail="preview name is reserved for legacy preview retirement",
        )
    if body.profile not in {
        "app-live",
        "manifest-candidate",
        "host-candidate",
    }:
        raise HTTPException(status_code=400, detail="invalid preview profile")
    if body.profile == "host-candidate":
        raise HTTPException(
            status_code=400,
            detail="host-candidate requires the leased physical-dev adapter, not vCluster",
        )
    if body.lane not in {"application", "management"}:
        raise HTTPException(
            status_code=400, detail="lane must be application|management"
        )
    if body.lane == "management" and body.profile != "manifest-candidate":
        raise HTTPException(
            status_code=400,
            detail="only manifest-candidate can use the management lane",
        )
    if body.lane == "management":
        raise HTTPException(
            status_code=400,
            detail=(
                "manifest-candidate lane management requires the isolated operator "
                "management "
                "adapter, not the standard vCluster lane"
            ),
        )
    if not body.trustedCode:
        raise HTTPException(
            status_code=403,
            detail="profiled preview environments require trustedCode=true",
        )
    if not body.platformRevision or not re.fullmatch(
        r"[0-9a-f]{40}", body.platformRevision
    ):
        raise HTTPException(
            status_code=400,
            detail="platformRevision must be a full lowercase 40-character Git SHA",
        )
    if body.targetRevision and body.targetRevision != body.platformRevision:
        raise HTTPException(
            status_code=400,
            detail="targetRevision must match platformRevision on profiled requests",
        )
    if body.profile == "manifest-candidate" and body.pool:
        raise HTTPException(
            status_code=400,
            detail="manifest-candidate cannot claim or bake a moving warm-pool baseline",
        )
    if body.capabilityBundle is None:
        raise HTTPException(
            status_code=400,
            detail="profiled previews require a broker-derived capabilityBundle",
        )
    if body.previewDb is not None:
        raise HTTPException(
            status_code=400,
            detail="profiled previews cannot select a shared preview database",
        )
    if body.previewDbMode not in {None, "cnpg"}:
        raise HTTPException(
            status_code=400,
            detail="profiled previews require previewDbMode=cnpg",
        )
    if body.previewDbBootstrap not in {None, "migrate"}:
        raise HTTPException(
            status_code=400,
            detail="profiled previews require previewDbBootstrap=migrate",
        )
    if body.previewObservability is not None:
        raise HTTPException(
            status_code=400,
            detail="profiled preview observability is platform-controlled",
        )
    _validate_candidate_paths(body)
    if body.mode not in {"live", "reconciled"}:
        raise HTTPException(
            status_code=400, detail="mode must be live|reconciled on profiled requests"
        )
    if body.profile != "app-live" and body.mode != "reconciled":
        raise HTTPException(
            status_code=400, detail=f"{body.profile} requires reconciled mode"
        )
    if body.lifecycle not in {"ephemeral", "retained"}:
        raise HTTPException(
            status_code=400,
            detail="profiled vCluster lifecycle must be ephemeral|retained",
        )
    if (
        body.ttlHours is None
        or isinstance(body.ttlHours, bool)
        or not 1 <= body.ttlHours <= 168
    ):
        raise HTTPException(
            status_code=400,
            detail="ttlHours must be an integer between 1 and 168 on profiled requests",
        )
    allocation = body.allocation
    if not isinstance(allocation, dict) or allocation.get("kind") != "cold":
        raise HTTPException(
            status_code=400,
            detail="profiled PreviewEnvironment allocation is cold-only",
        )
    if set(allocation) != {"kind"}:
        raise HTTPException(
            status_code=400, detail="allocation contains unknown fields"
        )
    if body.pool:
        raise HTTPException(
            status_code=409,
            detail="profiled warm pools are retired; use a cold preview",
        )
    if not body.createOnly:
        raise HTTPException(
            status_code=400,
            detail="profiled cold previews require createOnly=true",
        )
    selected_services = set(body.services)
    if any(
        not re.fullmatch(r"[a-z0-9][a-z0-9-]{0,62}", service)
        for service in body.services
    ):
        raise HTTPException(
            status_code=400, detail="services contains an invalid service id"
        )
    if len(selected_services) != len(body.services):
        raise HTTPException(
            status_code=400, detail="services must not contain duplicates"
        )
    catalog = _preview_service_catalog()
    if (
        not isinstance(body.catalogDigest, str)
        or not re.fullmatch(r"sha256:[0-9a-f]{64}", body.catalogDigest)
        or body.catalogDigest != catalog.catalog_digest
    ):
        raise HTTPException(
            status_code=409,
            detail="catalogDigest must exactly match the mounted preview service catalog",
        )
    if body.profile == "app-live" and not selected_services:
        raise HTTPException(
            status_code=400, detail="app-live requires at least one service"
        )
    for service in body.services:
        capability = catalog.services.get(service)
        if capability is None:
            raise HTTPException(
                status_code=400,
                detail=f"service {service} is not present in the preview service catalog",
            )
        if body.profile == "app-live" and not capability.preview_native:
            raise HTTPException(
                status_code=400,
                detail=f"service {service} is not preview-native for app-live",
            )
    image_pattern = re.compile(
        r"^ghcr\.io/pittampalliorg/[a-z0-9][a-z0-9._-]{0,126}[a-z0-9]"
        r"@sha256:[0-9a-f]{64}$"
    )
    for service, image in body.imageOverrides.items():
        if service not in body.services:
            raise HTTPException(
                status_code=400,
                detail="imageOverrides keys must name a requested service",
            )
        if not image_pattern.fullmatch(image):
            raise HTTPException(
                status_code=400,
                detail="imageOverrides must use immutable PittampalliOrg GHCR digests",
            )
        capability = catalog.services.get(service)
        if capability is None or not capability.acceptance_build:
            raise HTTPException(
                status_code=400,
                detail=f"service {service} has no catalog-backed acceptance build",
            )
    if body.mode == "live" and body.imageOverrides:
        raise HTTPException(
            status_code=400, detail="live mode cannot carry imageOverrides"
        )
    if (
        body.profile == "app-live"
        and body.mode == "reconciled"
        and set(body.imageOverrides) != selected_services
    ):
        raise HTTPException(
            status_code=400,
            detail=(
                "reconciled app-live acceptance requires imageOverrides with exactly "
                "one immutable image for every selected service"
            ),
        )
    delivery = body.delivery or os.environ.get(
        "VCLUSTER_PREVIEW_DELIVERY", "reconciler"
    )
    if delivery != "reconciler":
        raise HTTPException(
            status_code=400, detail="profiled previews require delivery=reconciler"
        )
    enroll_mode = body.enrollMode or os.environ.get(
        "VCLUSTER_PREVIEW_ENROLL_MODE", "agent"
    )
    if enroll_mode != "agent":
        raise HTTPException(
            status_code=400,
            detail="profiled previews require enrollMode=agent",
        )
    if not body.sourceRevision or not re.fullmatch(
        r"[0-9a-f]{40}", body.sourceRevision
    ):
        raise HTTPException(
            status_code=400,
            detail="sourceRevision must be a full lowercase 40-character Git SHA",
        )
    owner = _preview_owner(body.owner)
    if (
        owner is None
        or owner.kind not in {"user", "workflow", "session", "automation"}
        or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.:@/-]{0,127}", owner.id)
    ):
        raise HTTPException(
            status_code=400,
            detail="owner must be a valid structured {kind,id} value",
        )
    origin = _preview_origin(body.origin)
    if origin is None or origin.kind not in {
        "user",
        "pull-request",
        "workflow",
        "interactive-session",
        "automation",
    }:
        raise HTTPException(
            status_code=400,
            detail="origin must be a valid structured {kind,reference?} value",
        )
    if origin.reference is not None and (
        not origin.reference.strip()
        or len(origin.reference) > 512
        or re.search(r"[\x00-\x1f\x7f]", origin.reference)
    ):
        raise HTTPException(status_code=400, detail="origin.reference is invalid")
    if origin.kind in {"pull-request", "workflow", "interactive-session"} and not (
        origin.reference and origin.reference.strip()
    ):
        raise HTTPException(
            status_code=400,
            detail=f"origin.reference is required for {origin.kind}",
        )
    if (
        body.profile == "app-live"
        and body.mode == "live"
        and not (
            owner.kind == "user"
            or (owner.kind == "automation" and origin.kind == "pull-request")
        )
    ):
        raise HTTPException(
            status_code=400,
            detail=(
                "live app-live previews require a user owner or "
                "pull-request automation owner"
            ),
        )
    if body.provenance is None:
        raise HTTPException(status_code=400, detail="provenance is required")
    if len(json.dumps(body.provenance, separators=(",", ":"))) > 4096:
        raise HTTPException(status_code=400, detail="provenance exceeds 4096 bytes")
    for field in ("requestId", "platformRepository", "sourceRepository"):
        value = body.provenance.get(field)
        if not isinstance(value, str) or not value.strip():
            raise HTTPException(
                status_code=400,
                detail=f"provenance.{field} is required",
            )
    if body.provenance.get("platformRepository") != "PittampalliOrg/stacks":
        raise HTTPException(
            status_code=400,
            detail="provenance.platformRepository must be PittampalliOrg/stacks",
        )
    if body.provenance.get("sourceRepository") != "PittampalliOrg/workflow-builder":
        raise HTTPException(
            status_code=400,
            detail=(
                "provenance.sourceRepository must be PittampalliOrg/workflow-builder"
            ),
        )
    requested_at = body.provenance.get("requestedAt")
    if not isinstance(requested_at, str) or not re.fullmatch(
        r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z",
        requested_at,
    ):
        raise HTTPException(
            status_code=400,
            detail="provenance.requestedAt must be an RFC3339 UTC timestamp ending in Z",
        )
    try:
        datetime.fromisoformat(requested_at[:-1] + "+00:00")
    except ValueError as exc:
        raise HTTPException(
            status_code=400,
            detail="provenance.requestedAt must be a real timestamp",
        ) from exc


def _validate_profiled_preview_claim_request(
    body: VclusterPreviewClaimRequest,
) -> None:
    """Warm claims are retired until a bake can prove the full immutable tuple."""
    raise HTTPException(
        status_code=status.HTTP_409_CONFLICT,
        detail="profiled warm pools are retired; use a cold preview",
    )


@app.post("/internal/vcluster-preview", status_code=status.HTTP_202_ACCEPTED)
def provision_vcluster_preview(
    request: Request, body: VclusterPreviewRequest
) -> dict[str, Any]:
    _require_internal(request)
    set_current_span_io("input", body.model_dump())
    if body.action not in {"up", "down"}:
        raise HTTPException(status_code=400, detail="action must be up|down")
    if body.action == "down" and body.previewDb is not None:
        raise HTTPException(
            status_code=400,
            detail="down previewDb is server-derived and must not be supplied",
        )
    if body.action != "down" and (
        body.teardownExpectedRequestId
        or body.teardownExpectedSourceRevision
        or body.teardownExpectedPlatformRevision
        or body.teardownExpectedCatalogDigest
        or body.teardownDeletionTimestamp
        or body.teardownProtectedRequestId
        or body.teardownEnvironmentUid
        or body.teardownIntentId
    ):
        raise HTTPException(
            status_code=400, detail="teardown ownership guards require action=down"
        )
    if body.action == "down" and bool(body.teardownEnvironmentUid) != bool(
        body.teardownIntentId
    ):
        raise HTTPException(
            status_code=400,
            detail="teardown environment UID and deletion intent id must be supplied together",
        )
    if (
        body.action == "down"
        and body.teardownIntentId
        and not (body.teardownExpectedRequestId and body.teardownExpectedSourceRevision)
    ):
        raise HTTPException(
            status_code=400,
            detail="controller deletion intent requires exact owned teardown guards",
        )
    controller_intent = (
        _controller_deletion_intent(
            name=body.name,
            request_id=body.teardownExpectedRequestId,
            platform_revision=body.teardownExpectedPlatformRevision,
            source_revision=body.teardownExpectedSourceRevision,
            catalog_digest=body.teardownExpectedCatalogDigest,
            deletion_timestamp=body.teardownDeletionTimestamp,
            environment_uid=body.teardownEnvironmentUid,
            intent_id=body.teardownIntentId,
        )
        if body.action == "down"
        else None
    )
    _validate_profiled_preview_request(body)
    namespace = _vcluster_preview_control_namespace()
    manifest = _vcluster_preview_job_manifest(body, namespace=namespace)
    job_name = manifest["metadata"]["name"]
    tailnet_host = _vcluster_preview_tailnet_host(body)
    url = f"https://{tailnet_host}.{_VCLUSTER_PREVIEW_TAILNET_SUFFIX}"
    response = {
        "name": body.name,
        "action": body.action,
        "job": job_name,
        "status": "provisioning" if body.action == "up" else "terminating",
        "tailnetHost": tailnet_host,
        "url": url if body.action == "up" else None,
    }
    if os.environ.get("SANDBOX_EXECUTION_DRY_RUN", "").lower() not in {
        "1",
        "true",
        "yes",
    }:
        batch, core = _load_k8s_clients()
        safe_name = _safe_resource_name(body.name, max_length=40)

        def exact_down_receipt_state() -> _PreviewDownReceiptState:
            return _preview_down_receipt_state(
                batch,
                namespace=namespace,
                preview_name=safe_name,
                expected_request_id=body.teardownExpectedRequestId,
                expected_source_revision=body.teardownExpectedSourceRevision,
                protected_request_id=body.teardownProtectedRequestId,
                environment_uid=body.teardownEnvironmentUid,
                deletion_intent_id=body.teardownIntentId,
            )

        allow_absent_down_bootstrap = False
        receipt_state = (
            exact_down_receipt_state()
            if body.action == "down"
            else _PreviewDownReceiptState()
        )
        if receipt_state.in_flight:
            # Repeated down requests may arrive while the exact immutable runner is
            # still deleting the namespace. Preserve that receipt instead of
            # contending for a second operation Lease and returning a false 409.
            set_current_span_io("output", response)
            return response
        if body.action == "down" and not _namespace_exists(core, safe_name):
            receipt_succeeded = receipt_state.succeeded
            try:
                identity_absent = PreviewRunnerIdentityAdapter(
                    core, _load_k8s_rbac_client()
                ).is_absent(preview_name=safe_name)
            except PreviewRunnerIdentityError as exc:
                raise HTTPException(
                    status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                    detail=f"could not prove preview runner identity absence: {exc}",
                ) from exc
            if identity_absent:
                if not receipt_succeeded and not (
                    body.teardownEnvironmentUid and body.teardownIntentId
                ):
                    raise HTTPException(
                        status_code=status.HTTP_409_CONFLICT,
                        detail=(
                            "preview namespace and identity are absent without a "
                            "successful down receipt"
                        ),
                    )
                if receipt_succeeded:
                    result = {
                        "name": safe_name,
                        "action": "down",
                        "job": _vcluster_preview_job_name(safe_name, "down"),
                        "status": "absent",
                        "phase": "complete",
                        "complete": True,
                        "tailnetHost": tailnet_host,
                        "url": None,
                    }
                    set_current_span_io("output", result)
                    return result
                # A failed cold launch can leave only the hub CR. Its exact
                # controller intent is allowed to create a control-only runner
                # identity so the normal down Job can emit durable absence proof.
                allow_absent_down_bootstrap = True
            elif receipt_succeeded:
                owned_guard = bool(
                    body.teardownExpectedRequestId
                    and body.teardownExpectedSourceRevision
                )
                superseded_guard = bool(body.teardownProtectedRequestId)
                if owned_guard != superseded_guard:
                    # The destructive runner already succeeded, but the independent
                    # identity reconciler has not yet completed. Preserve the exact
                    # durable receipt and keep reporting teardown in progress.
                    set_current_span_io("output", response)
                    return response
        coordination = _load_k8s_coordination_client()
        operation_holder = _acquire_preview_operation_lease(
            coordination, namespace=namespace, real_name=body.name
        )
        handed_to_runner = False
        try:
            # Build the Job only after admission so every mutable runner carries the
            # exact Lease holder that fenced the SEA-side decision.
            manifest = _vcluster_preview_job_manifest(
                body,
                namespace=namespace,
                operation_holder=operation_holder,
            )
            job_name = manifest["metadata"]["name"]
            if body.action == "up":
                with _preview_capacity_lease(coordination, namespace=namespace):
                    _create_preview_with_capacity(
                        batch,
                        core,
                        namespace=namespace,
                        request=body,
                        manifest=manifest,
                    )
            else:
                # DELETE performs an early user-facing check. Repeat it under the
                # operation Lease so a replacement generation cannot land between
                # the check and creation of the destructive runner. A retry may land
                # after the first down attempt removed the namespace; exact ownership
                # guards plus the pre-existing bounded identity preserve that recovery
                # path without recreating the capacity-bearing namespace.
                owned_guard = bool(
                    body.teardownExpectedRequestId
                    and body.teardownExpectedSourceRevision
                )
                superseded_guard = bool(body.teardownProtectedRequestId)
                failed_preinitialized_proof = None
                try:
                    member = _read_preview_member(
                        core,
                        body.name,
                        allow_terminating=owned_guard != superseded_guard,
                    )
                except HTTPException as exc:
                    if exc.status_code != status.HTTP_404_NOT_FOUND:
                        raise
                    member = None
                if member is None:
                    if owned_guard == superseded_guard:
                        raise HTTPException(
                            status_code=status.HTTP_400_BAD_REQUEST,
                            detail=(
                                "residual preview teardown requires one exact owned "
                                "or superseded ownership guard"
                            ),
                        )
                    receipt_succeeded = exact_down_receipt_state().succeeded
                else:
                    receipt_succeeded = False
                    observed_request_id = (
                        member.provenance.get("requestId")
                        if member.provenance is not None
                        else None
                    )
                    if _preview_member_is_controller_owned(member) and (
                        owned_guard == superseded_guard
                    ):
                        raise HTTPException(
                            status_code=status.HTTP_400_BAD_REQUEST,
                            detail=(
                                "profiled preview teardown requires one exact owned "
                                "or superseded ownership guard"
                            ),
                        )
                    if _preview_member_requires_archive_teardown(member):
                        _require_preview_archive_teardown_proof(request)
                        if not (
                            body.teardownExpectedRequestId
                            and body.teardownExpectedSourceRevision
                        ):
                            raise HTTPException(
                                status_code=status.HTTP_400_BAD_REQUEST,
                                detail=(
                                    "mutable live preview teardown requires exact "
                                    "requestId and sourceRevision ownership guards"
                                ),
                            )
                    if body.teardownExpectedRequestId and (
                        observed_request_id != body.teardownExpectedRequestId
                        or member.source_revision != body.teardownExpectedSourceRevision
                    ):
                        if controller_intent is None:
                            raise HTTPException(
                                status_code=status.HTTP_409_CONFLICT,
                                detail="preview teardown ownership no longer matches",
                            )
                        failed_preinitialized_proof = (
                            _prove_failed_preinitialized_teardown(
                                batch,
                                core,
                                coordination,
                                intent=controller_intent,
                                expected_lease_holder=operation_holder,
                            )
                        )
                    if (
                        body.teardownProtectedRequestId
                        and observed_request_id == body.teardownProtectedRequestId
                    ):
                        raise HTTPException(
                            status_code=status.HTTP_409_CONFLICT,
                            detail="refusing to teardown the protected preview generation",
                        )
                if not receipt_succeeded:
                    manifest = _vcluster_preview_job_manifest(
                        body,
                        namespace=namespace,
                        operation_holder=operation_holder,
                        failed_preinitialized_proof=failed_preinitialized_proof,
                    )
                    _submit_preview_job(
                        batch,
                        core,
                        namespace=namespace,
                        manifest=manifest,
                        lifecycle=member.lifecycle if member is not None else None,
                        allow_absent_down_bootstrap=allow_absent_down_bootstrap,
                        expected_existing_runner_generation=(
                            failed_preinitialized_proof.failed_up_runner_generation
                            if failed_preinitialized_proof is not None
                            else None
                        ),
                    )
                    handed_to_runner = True
            if body.action == "up":
                handed_to_runner = True
        finally:
            if not handed_to_runner:
                _release_preview_operation_lease(
                    coordination,
                    namespace=namespace,
                    real_name=body.name,
                    holder=operation_holder,
                )
    set_current_span_io("output", response)
    return response


def _preview_reconciliation_marker_matches(
    annotations: dict[str, str],
) -> bool:
    platform_revision = annotations.get("preview.stacks.io/target-revision")
    source_revision = annotations.get("preview.stacks.io/source-revision")
    return bool(
        _parse_rfc3339(annotations.get("preview.stacks.io/reconciliation-succeeded-at"))
        and re.fullmatch(r"[0-9a-f]{40}", platform_revision or "")
        and re.fullmatch(r"[0-9a-f]{40}", source_revision or "")
        and annotations.get("preview.stacks.io/reconciliation-platform-revision")
        == platform_revision
        and annotations.get("preview.stacks.io/reconciliation-source-revision")
        == source_revision
    )


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
    namespace = _vcluster_preview_control_namespace()
    job_name = _vcluster_preview_job_name(name, "up")
    active = succeeded = failed = 0
    job_found = False
    try:
        job = batch.read_namespaced_job_status(
            name=job_name, namespace=namespace, _request_timeout=request_timeout
        )
        job_found = True
        st = job.status
        active = int(getattr(st, "active", 0) or 0)
        succeeded = int(getattr(st, "succeeded", 0) or 0)
        failed = int(getattr(st, "failed", 0) or 0)
        condition_succeeded, condition_failed, _ = _preview_job_state(job)
        succeeded = max(succeeded, int(condition_succeeded))
        failed = max(failed, int(condition_failed))
    except Exception as exc:
        if getattr(exc, "status", None) != 404:
            raise
    # ns existence needs a real read_namespace: listing pods in a NON-EXISTENT
    # namespace returns 200 + empty items (never 404), which made every unknown
    # preview name report "provisioning" — the D1 idempotent-up then skipped its
    # claim and polled that phantom forever.
    ns_exists = False
    profiled = False
    reconciliation_succeeded = False
    bff_ready = False
    try:
        preview_namespace = core.read_namespace(
            name=f"vcluster-{name}", _request_timeout=request_timeout
        )
        ns_exists = True
        metadata = getattr(preview_namespace, "metadata", None)
        annotations = getattr(metadata, "annotations", None) or {}
        profiled = bool(annotations.get("preview.stacks.io/profile"))
        reconciliation_succeeded = _preview_reconciliation_marker_matches(annotations)
    except Exception as exc:
        if getattr(exc, "status", None) != 404:
            raise
    if ns_exists:
        try:
            pods = core.list_namespaced_pod(
                namespace=f"vcluster-{name}",
                label_selector=(
                    "app=workflow-builder,"
                    "vcluster.loft.sh/namespace=workflow-builder"
                ),
                _request_timeout=request_timeout,
            )
            for p in pods.items:
                labels = (
                    getattr(p.metadata, "labels", None) or {}
                    if getattr(p, "metadata", None)
                    else {}
                )
                if not (
                    labels.get("app") == "workflow-builder"
                    and labels.get("vcluster.loft.sh/namespace") == "workflow-builder"
                ):
                    continue
                conds = (p.status.conditions or []) if p.status else []
                if any(
                    getattr(c, "type", "") == "Ready"
                    and getattr(c, "status", "") == "True"
                    for c in conds
                ):
                    bff_ready = True
                    break
        except Exception as exc:
            if getattr(exc, "status", None) != 404:
                raise
    if profiled and failed:
        phase = "failed"
    elif profiled and active:
        phase = "provisioning"
    elif (
        profiled
        and bff_ready
        and reconciliation_succeeded
        and (succeeded or not job_found)
    ):
        phase = "ready"
    elif profiled and ns_exists:
        phase = "provisioning"
    elif bff_ready:
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


def _resolve_preview_realname_strict(core: Any, name: str) -> str:
    """Resolve aliases for authoritative operations without outage fallback."""
    safe_name = _safe_resource_name(name, max_length=40)
    nss = core.list_namespace(
        label_selector=f"{_VCLUSTER_PREVIEW_ALIAS_LABEL}={safe_name}"
    )
    matches = [
        _preview_realname_from_ns(ns)
        for ns in nss.items
        if not _preview_ns_is_terminating(ns)
    ]
    if len(matches) > 1:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="preview alias resolves to multiple active environments",
        )
    return matches[0] if matches else safe_name


@app.get("/internal/vcluster-preview/{name}")
def get_vcluster_preview(request: Request, name: str) -> dict[str, Any]:
    _require_internal(request)
    guard = _preview_runtime_identity_guard(request)
    dry_run = os.environ.get("SANDBOX_EXECUTION_DRY_RUN", "").lower() in {
        "1",
        "true",
        "yes",
    }
    if guard is not None and dry_run:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="preview runtime identity is unavailable in dry-run mode",
        )
    if guard is not None:
        safe_name = _safe_resource_name(name, max_length=40)
        batch, core = _load_k8s_clients()
        member = _read_preview_member(core, safe_name)
        namespace_uid = _preview_member_namespace_uid(member)
        identity = _preview_member_runtime_identity(member, safe_name)
        if namespace_uid is None or identity != guard:
            raise _preview_runtime_identity_changed()
        initial_fingerprint = _preview_runtime_identity_fingerprint(member, safe_name)
        if member.slept:
            phase, active, succeeded, failed = "slept", 0, 0, 0
        else:
            phase, active, succeeded, failed = _vcluster_preview_phase(
                batch, core, member.real_name
            )
        boot_seconds = _vcluster_preview_boot_seconds(core, member.real_name)
        try:
            confirmed_member = _read_preview_member(core, safe_name)
        except HTTPException as exc:
            if exc.status_code in {
                status.HTTP_404_NOT_FOUND,
                status.HTTP_409_CONFLICT,
            }:
                raise _preview_runtime_identity_changed() from exc
            raise
        if (
            _preview_member_namespace_uid(confirmed_member) != namespace_uid
            or _preview_runtime_identity_fingerprint(confirmed_member, safe_name)
            != initial_fingerprint
        ):
            raise _preview_runtime_identity_changed()
        confirmed_identity = _preview_member_runtime_identity(
            confirmed_member, safe_name
        )
        if confirmed_identity != guard:
            raise _preview_runtime_identity_changed()
        result = _vcluster_preview_record_value(
            requested_name=safe_name,
            member=confirmed_member,
            phase=phase,
            active=active,
            succeeded=succeeded,
            failed=failed,
            boot_seconds=boot_seconds,
        )
        result["identity"] = confirmed_identity
        result["namespaceUid"] = namespace_uid
        set_current_span_io("output", result)
        return result
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


def _preview_pod_is_ready(pod: Any) -> bool:
    status_value = getattr(pod, "status", None)
    if getattr(status_value, "phase", None) != "Running":
        return False
    conditions = getattr(status_value, "conditions", None) or []
    return any(
        getattr(condition, "type", None) == "Ready"
        and str(getattr(condition, "status", "")).lower() == "true"
        for condition in conditions
    )


def _preview_pod_matches_service(pod: Any, service: str) -> bool:
    metadata = getattr(pod, "metadata", None)
    labels = getattr(metadata, "labels", None) or {}
    if service in {
        labels.get("app"),
        labels.get("app.kubernetes.io/name"),
        labels.get("app.kubernetes.io/component"),
    }:
        return True
    pod_name = getattr(metadata, "name", None) or ""
    return pod_name == service or pod_name.startswith(f"{service}-")


def _preview_runtime_container_name(pod: Any, service: str) -> str | None:
    """Resolve the physical container that represents a logical preview service."""
    spec_value = getattr(pod, "spec", None)
    container_names = {
        getattr(container, "name", None)
        for container in (getattr(spec_value, "containers", None) or [])
    }
    if service in container_names:
        return service

    metadata = getattr(pod, "metadata", None)
    labels = getattr(metadata, "labels", None) or {}
    if (
        "dev" in container_names
        and labels.get("preview.stacks.io/managed-by") == "sandbox-execution-api"
        and labels.get("dev-preview-service") == service
    ):
        return "dev"
    return None


def _preview_runtime_services(
    pods: Any, services: tuple[str, ...]
) -> list[dict[str, Any]]:
    """Project Kubernetes pod/container state into the narrow runtime-proof DTO."""
    observations: list[dict[str, Any]] = []
    for service in sorted(services):
        containers: list[dict[str, Any]] = []
        for pod in sorted(
            getattr(pods, "items", None) or [],
            key=lambda item: getattr(getattr(item, "metadata", None), "name", "") or "",
        ):
            if not _preview_pod_matches_service(pod, service):
                continue
            metadata = getattr(pod, "metadata", None)
            pod_name = getattr(metadata, "name", None) or ""
            spec_value = getattr(pod, "spec", None)
            status_value = getattr(pod, "status", None)
            runtime_container_name = _preview_runtime_container_name(pod, service)
            if runtime_container_name is None:
                continue
            statuses = {
                getattr(item, "name", ""): item
                for item in (getattr(status_value, "container_statuses", None) or [])
            }
            pod_ready = _preview_pod_is_ready(pod) and not bool(
                getattr(metadata, "deletion_timestamp", None)
            )
            for container in getattr(spec_value, "containers", None) or []:
                if getattr(container, "name", None) != runtime_container_name:
                    continue
                container_status = statuses.get(runtime_container_name)
                containers.append(
                    {
                        "pod": pod_name,
                        "image": getattr(container, "image", None) or "",
                        "imageId": (
                            getattr(container_status, "image_id", None)
                            if container_status is not None
                            else None
                        ),
                        "ready": pod_ready
                        and bool(getattr(container_status, "ready", False)),
                    }
                )
        observations.append({"service": service, "containers": containers})
    return observations


_PREVIEW_RUNTIME_IDENTITY_HEADER = "x-preview-runtime-identity"


def _preview_runtime_identity_guard(
    request: Request,
) -> dict[str, str] | None:
    raw = request.headers.get(_PREVIEW_RUNTIME_IDENTITY_HEADER)
    if raw is None:
        return None
    if len(raw) > 2048:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="preview runtime identity guard is invalid",
        )
    try:
        parsed = VclusterPreviewRuntimeIdentityGuard.model_validate_json(raw)
    except ValidationError as exc:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="preview runtime identity guard is invalid",
        ) from exc
    return {
        "previewName": parsed.previewName,
        "environmentRequestId": parsed.environmentRequestId,
        "environmentPlatformRevision": parsed.environmentPlatformRevision,
        "environmentSourceRevision": parsed.environmentSourceRevision,
        "catalogDigest": parsed.catalogDigest,
    }


def _preview_member_runtime_identity(
    member: PreviewMember, requested_name: str
) -> dict[str, str] | None:
    provenance = member.provenance
    request_id = provenance.get("requestId") if provenance is not None else None
    request_id = request_id.strip() if isinstance(request_id, str) else ""
    if (
        not re.fullmatch(r"[0-9a-f]{40}", member.platform_revision or "")
        or not re.fullmatch(r"[0-9a-f]{40}", member.source_revision or "")
        or not re.fullmatch(r"sha256:[0-9a-f]{64}", member.catalog_digest or "")
        or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._:-]{0,255}", request_id)
    ):
        return None
    return {
        "previewName": _safe_resource_name(requested_name, max_length=40),
        "environmentRequestId": request_id,
        "environmentPlatformRevision": member.platform_revision or "",
        "environmentSourceRevision": member.source_revision or "",
        "catalogDigest": member.catalog_digest or "",
    }


def _preview_member_namespace_uid(member: PreviewMember) -> str | None:
    uid = member.namespace_uid
    if not isinstance(uid, str) or not re.fullmatch(
        r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}",
        uid,
    ):
        return None
    return uid


def _preview_runtime_identity_fingerprint(
    member: PreviewMember, requested_name: str
) -> tuple[Any, ...]:
    provenance = member.provenance
    request_id = provenance.get("requestId") if provenance is not None else None
    return (
        _safe_resource_name(requested_name, max_length=40),
        member.real_name,
        member.ns_name,
        _preview_member_namespace_uid(member),
        member.platform_revision,
        member.source_revision,
        member.catalog_digest,
        request_id.strip() if isinstance(request_id, str) else request_id,
    )


def _preview_runtime_identity_changed() -> HTTPException:
    return HTTPException(
        status_code=status.HTTP_409_CONFLICT,
        detail="preview identity changed during runtime observation",
    )


def _vcluster_preview_record_value(
    *,
    requested_name: str,
    member: PreviewMember,
    phase: str,
    active: int,
    succeeded: int,
    failed: int,
    boot_seconds: int | None,
) -> dict[str, Any]:
    tailnet_host = f"wfb-{requested_name}"
    result = {
        "name": requested_name,
        "job": _vcluster_preview_job_name(member.real_name, "up"),
        "phase": phase,
        "ready": phase == "ready",
        "active": active,
        "succeeded": succeeded,
        "failed": failed,
        "tailnetHost": tailnet_host,
        "url": f"https://{tailnet_host}.{_VCLUSTER_PREVIEW_TAILNET_SUFFIX}",
        "bootSeconds": boot_seconds,
        **_preview_lifecycle_fields(member),
    }
    if member.real_name != requested_name:
        result["pool"] = member.real_name
    return result


def _vcluster_preview_phase_from_runtime(
    member: PreviewMember,
    pods: Any,
    *,
    up_job_found: bool,
    up_job_active: bool,
    up_job_succeeded: bool,
    up_job_failed: bool,
) -> str:
    if member.slept:
        return "slept"
    profiled = member.profile is not None
    reconciliation_succeeded = bool(
        member.reconciliation_succeeded_at
        and member.reconciliation_platform_revision == member.platform_revision
        and member.reconciliation_source_revision == member.source_revision
    )
    bff_ready = any(
        _preview_pod_matches_service(pod, "workflow-builder")
        and _preview_pod_is_ready(pod)
        for pod in (getattr(pods, "items", None) or [])
    )
    if profiled and up_job_failed:
        return "failed"
    if profiled and up_job_active:
        return "provisioning"
    if (
        profiled
        and bff_ready
        and reconciliation_succeeded
        and (up_job_succeeded or not up_job_found)
    ):
        return "ready"
    if profiled:
        return "provisioning"
    if bff_ready:
        return "ready"
    if up_job_active:
        return "provisioning"
    if up_job_failed:
        return "failed"
    return "provisioning"


@app.get("/internal/vcluster-preview/{name}/runtime")
def get_vcluster_preview_runtime(request: Request, name: str) -> dict[str, Any]:
    """Read actual selected-service pod images from the host Kubernetes API."""
    _require_internal(request)
    safe_name = _safe_resource_name(name, max_length=40)
    guard = _preview_runtime_identity_guard(request)
    if os.environ.get("SANDBOX_EXECUTION_DRY_RUN", "").lower() in {
        "1",
        "true",
        "yes",
    }:
        if guard is not None:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail="preview runtime identity is unavailable in dry-run mode",
            )
        up_job_name = _vcluster_preview_job_name(safe_name, "up")
        return {
            "name": name,
            "resourceName": safe_name,
            "reconciliationSucceeded": True,
            "upJob": {
                "name": up_job_name,
                "found": False,
                "active": False,
                "succeeded": False,
                "failed": False,
            },
            "services": [],
        }
    batch, core = _load_k8s_clients()
    member = _read_preview_member(core, safe_name)
    namespace_uid = _preview_member_namespace_uid(member)
    if namespace_uid is None:
        raise _preview_runtime_identity_changed()
    identity = _preview_member_runtime_identity(member, safe_name)
    if guard is not None and guard != identity:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="preview runtime identity guard does not match the resolved preview",
        )
    initial_fingerprint = _preview_runtime_identity_fingerprint(member, safe_name)
    pods = core.list_namespaced_pod(
        namespace=member.ns_name,
        _request_timeout=_VCLUSTER_PREVIEW_PROBE_TIMEOUT,
    )
    up_job_found = False
    up_job_active = False
    up_job_succeeded = False
    up_job_failed = False
    up_job_name = _vcluster_preview_job_name(member.real_name, "up")
    try:
        up_job = batch.read_namespaced_job_status(
            name=up_job_name,
            namespace=_vcluster_preview_control_namespace(),
            _request_timeout=_VCLUSTER_PREVIEW_PROBE_TIMEOUT,
        )
        up_job_found = True
        up_job_active = bool(int(getattr(up_job.status, "active", 0) or 0))
        up_job_succeeded, up_job_failed, _ = _preview_job_state(up_job)
    except Exception as exc:
        if getattr(exc, "status", None) != 404:
            raise
    try:
        confirmed_member = _read_preview_member(core, safe_name)
    except HTTPException as exc:
        if exc.status_code in {status.HTTP_404_NOT_FOUND, status.HTTP_409_CONFLICT}:
            raise _preview_runtime_identity_changed() from exc
        raise
    if (
        _preview_member_namespace_uid(confirmed_member) != namespace_uid
        or _preview_runtime_identity_fingerprint(confirmed_member, safe_name)
        != initial_fingerprint
    ):
        raise _preview_runtime_identity_changed()
    confirmed_identity = _preview_member_runtime_identity(confirmed_member, safe_name)
    phase = _vcluster_preview_phase_from_runtime(
        confirmed_member,
        pods,
        up_job_found=up_job_found,
        up_job_active=up_job_active,
        up_job_succeeded=up_job_succeeded,
        up_job_failed=up_job_failed,
    )
    result = {
        "name": name,
        "resourceName": member.real_name,
        "reconciliationSucceeded": bool(
            member.reconciliation_succeeded_at
            and member.reconciliation_platform_revision == member.platform_revision
            and member.reconciliation_source_revision == member.source_revision
            and (
                (up_job_succeeded and not up_job_failed and not up_job_active)
                or not up_job_found
            )
        ),
        "upJob": {
            "name": up_job_name,
            "found": up_job_found,
            "active": up_job_active,
            "succeeded": up_job_succeeded,
            "failed": up_job_failed,
        },
        "services": _preview_runtime_services(pods, member.services or ()),
    }
    if confirmed_identity is not None:
        result["identity"] = confirmed_identity
        result["namespaceUid"] = namespace_uid
        result["preview"] = _vcluster_preview_record_value(
            requested_name=safe_name,
            member=confirmed_member,
            phase=phase,
            active=int(up_job_active),
            succeeded=int(up_job_succeeded),
            failed=int(up_job_failed),
            boot_seconds=None,
        )
    set_current_span_io("output", result)
    return result


def _preview_job_state(job: Any) -> tuple[bool, bool, str | None]:
    status_value = getattr(job, "status", None)
    succeeded = int(getattr(status_value, "succeeded", 0) or 0) > 0
    failed = int(getattr(status_value, "failed", 0) or 0) > 0
    message: str | None = None
    for condition in getattr(status_value, "conditions", None) or []:
        if str(getattr(condition, "status", "")).lower() != "true":
            continue
        condition_type = getattr(condition, "type", None)
        if condition_type == "Complete":
            succeeded = True
        elif condition_type == "Failed":
            failed = True
            message = getattr(condition, "message", None) or getattr(
                condition, "reason", None
            )
    return succeeded, failed, message


_PREVIEW_IDENTITY_CLEANED_ANNOTATION = "preview.stacks.io/identity-cleaned"


def _kube_field(value: Any, snake_name: str, camel_name: str | None = None) -> Any:
    if isinstance(value, dict):
        return value.get(camel_name or snake_name)
    return getattr(value, snake_name, None)


def _runner_job_identity(job: Any) -> tuple[str, str] | None:
    metadata = _kube_field(job, "metadata")
    labels = _kube_field(metadata, "labels") or {}
    preview_name = labels.get("vcluster-preview-name")
    action = labels.get("vcluster-preview-action")
    if not isinstance(preview_name, str) or action not in {
        "up",
        "down",
        "claim",
        "sleep",
        "resume",
    }:
        return None
    try:
        expected_service_account = preview_runner_identity_name(preview_name)
    except PreviewRunnerIdentityError:
        return None
    expected_labels = {
        "app": "vcluster-preview",
        "vcluster-preview-name": preview_name,
        "vcluster-preview-action": action,
        "preview.stacks.io/managed": "true",
        "preview.stacks.io/preview-name": preview_name,
    }
    spec = _kube_field(job, "spec")
    template = _kube_field(spec, "template")
    template_metadata = _kube_field(template, "metadata")
    pod_labels = _kube_field(template_metadata, "labels") or {}
    pod_spec = _kube_field(template, "spec")
    if (
        _kube_field(metadata, "name")
        != _vcluster_preview_job_name(preview_name, action)
        or _kube_field(pod_spec, "service_account_name", "serviceAccountName")
        != expected_service_account
        or any(
            labels.get(key) != value or pod_labels.get(key) != value
            for key, value in expected_labels.items()
        )
    ):
        return None
    return preview_name, action


def _down_job_identity(job: Any) -> str | None:
    identity = _runner_job_identity(job)
    if identity is None or identity[1] != "down" or _runner_job_generation(job) is None:
        return None
    return identity[0]


def _runner_job_generation(job: Any) -> str | None:
    metadata = _kube_field(job, "metadata")
    annotations = _kube_field(metadata, "annotations") or {}
    spec = _kube_field(job, "spec")
    template = _kube_field(spec, "template")
    template_metadata = _kube_field(template, "metadata")
    pod_annotations = _kube_field(template_metadata, "annotations") or {}
    generation = annotations.get(RUNNER_GENERATION_ANNOTATION)
    if (
        not isinstance(generation, str)
        or not re.fullmatch(r"op:[0-9a-f]{32}", generation)
        or pod_annotations.get(RUNNER_GENERATION_ANNOTATION) != generation
    ):
        return None
    return generation


def _runner_container_env(resource: Any) -> dict[str, str] | None:
    """Return the single runner container's literal environment, fail closed."""

    spec = _kube_field(resource, "spec")
    template = _kube_field(spec, "template")
    if template is not None:
        spec = _kube_field(template, "spec")
    containers = _kube_field(spec, "containers") or []
    if len(containers) != 1:
        return None
    values: dict[str, str] = {}
    for item in _kube_field(containers[0], "env") or []:
        name = _kube_field(item, "name")
        value = _kube_field(item, "value")
        if not isinstance(name, str) or not isinstance(value, str) or name in values:
            return None
        values[name] = value
    return values


def _failed_preinitialized_conflict(reason: str) -> HTTPException:
    return HTTPException(
        status_code=status.HTTP_409_CONFLICT,
        detail=f"failed preinitialized preview proof failed: {reason}",
    )


def _prove_expired_preinitialization_reservation(
    core: Any,
    coordination: Any,
    *,
    intent: dict[str, str],
    namespace: Any,
    namespace_uid: str,
    namespace_generation: str,
    expected_lease_holder: str | None,
) -> FailedPreinitializedTeardownProof:
    """Bounded POC recovery when Kubernetes TTL removed the failed up evidence."""

    metadata = _kube_field(namespace, "metadata")
    namespace_created = _lease_timestamp(_kube_field(metadata, "creation_timestamp"))
    deletion_timestamp = _parse_rfc3339(intent["deletionTimestamp"])
    now = datetime.now(UTC)
    evidence_ttl = 1800
    if (
        namespace_created is None
        or deletion_timestamp is None
        or deletion_timestamp < namespace_created
        or deletion_timestamp > now
        or deletion_timestamp > namespace_created + timedelta(seconds=evidence_ttl)
        or now < namespace_created + timedelta(seconds=evidence_ttl)
    ):
        raise _failed_preinitialized_conflict(
            "expired reservation is outside the bounded evidence window"
        )

    control_namespace = _vcluster_preview_control_namespace()
    job_name = _vcluster_preview_job_name(intent["name"], "up")
    control_pods = core.list_namespaced_pod(
        namespace=control_namespace, label_selector=f"job-name={job_name}"
    )
    target_pods = core.list_namespaced_pod(
        namespace=f"vcluster-{intent['name']}"
    )
    if (_kube_field(control_pods, "items") or []) or (
        _kube_field(target_pods, "items") or []
    ):
        raise _failed_preinitialized_conflict(
            "expired reservation still has a runner or target pod"
        )

    lease_name = _preview_operation_lease_name(intent["name"])
    try:
        lease = coordination.read_namespaced_lease(
            name=lease_name, namespace=control_namespace
        )
    except Exception as exc:
        if getattr(exc, "status", None) == 404:
            raise _failed_preinitialized_conflict(
                "expired reservation operation Lease is absent"
            ) from exc
        raise
    lease_metadata = _kube_field(lease, "metadata")
    lease_uid = _kube_field(lease_metadata, "uid")
    lease_created = _lease_timestamp(
        _kube_field(lease_metadata, "creation_timestamp")
    )
    if (
        _kube_field(lease_metadata, "name") != lease_name
        or _kube_field(lease_metadata, "namespace") != control_namespace
        or not isinstance(lease_uid, str)
        or not re.fullmatch(
            r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}",
            lease_uid,
        )
        or lease_created is None
        or abs((lease_created - namespace_created).total_seconds()) > 30
    ):
        raise _failed_preinitialized_conflict(
            "expired reservation operation Lease identity is malformed"
        )
    holder, duration, renewed, transitions = _preview_operation_lease_fields(lease)
    lease_expired = (
        not holder
        or renewed is None
        or now >= renewed + timedelta(seconds=duration)
    )
    if duration != _PREVIEW_OPERATION_LEASE_SECONDS or not (0 <= transitions <= 8):
        raise _failed_preinitialized_conflict(
            "expired reservation operation Lease contract is malformed"
        )
    if expected_lease_holder is None:
        if not lease_expired:
            raise _failed_preinitialized_conflict(
                "expired reservation operation Lease is still active"
            )
    elif (
        holder != expected_lease_holder
        or renewed is None
        or now >= renewed + timedelta(seconds=duration)
    ):
        raise _failed_preinitialized_conflict(
            "expired reservation operation Lease holder does not match"
        )

    return FailedPreinitializedTeardownProof(
        preinitialization_evidence="expired-reservation-v1",
        physical_namespace_uid=namespace_uid,
        failed_up_job_uid=None,
        failed_up_runner_generation=namespace_generation,
    )


def _prove_failed_preinitialized_teardown(
    batch: Any,
    core: Any,
    coordination: Any,
    *,
    intent: dict[str, str],
    expected_lease_holder: str | None = None,
) -> FailedPreinitializedTeardownProof:
    """Prove an admitted cold launch failed before ordinary authority was stamped."""

    name = intent["name"]
    namespace_name = f"vcluster-{name}"
    try:
        namespace = core.read_namespace(name=namespace_name)
    except Exception as exc:
        if getattr(exc, "status", None) == 404:
            raise _failed_preinitialized_conflict(
                "physical namespace is absent"
            ) from exc
        raise
    metadata = _kube_field(namespace, "metadata")
    labels = _kube_field(metadata, "labels") or {}
    annotations = _kube_field(metadata, "annotations") or {}
    required_labels = {
        "app": "vcluster-preview",
        "vcluster-preview-name": name,
        "vcluster-preview-lifecycle": "ephemeral",
        "preview.stacks.io/managed": "true",
        "preview.stacks.io/preview-name": name,
        "preview.stacks.io/identity-ready": "true",
        "preview.stacks.io/runner-admitted": "true",
    }
    if any(labels.get(key) != value for key, value in required_labels.items()):
        raise _failed_preinitialized_conflict(
            "physical namespace is not the exact admitted ephemeral identity"
        )
    namespace_uid = _kube_field(metadata, "uid")
    if not isinstance(namespace_uid, str) or not re.fullmatch(
        r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}",
        namespace_uid,
    ):
        raise _failed_preinitialized_conflict("physical namespace UID is invalid")
    namespace_generation = annotations.get(RUNNER_GENERATION_ANNOTATION)
    if not isinstance(namespace_generation, str) or not re.fullmatch(
        r"op:[0-9a-f]{32}", namespace_generation
    ):
        raise _failed_preinitialized_conflict(
            "physical namespace runner generation is invalid"
        )
    ordinary_authority = {
        _VCLUSTER_PREVIEW_PROVENANCE_ANNOTATION,
        _VCLUSTER_PREVIEW_PLATFORM_REVISION_ANNOTATION,
        _VCLUSTER_PREVIEW_SOURCE_REVISION_ANNOTATION,
        _VCLUSTER_PREVIEW_CATALOG_DIGEST_ANNOTATION,
    }
    if any(key in annotations for key in ordinary_authority):
        raise _failed_preinitialized_conflict(
            "ordinary namespace ownership authority is present or partial"
        )
    reconciliation_authority = {
        _VCLUSTER_PREVIEW_RECONCILIATION_SUCCEEDED_AT_ANNOTATION,
        _VCLUSTER_PREVIEW_RECONCILIATION_PLATFORM_REVISION_ANNOTATION,
        _VCLUSTER_PREVIEW_RECONCILIATION_SOURCE_REVISION_ANNOTATION,
    }
    if any(key in annotations for key in reconciliation_authority):
        raise _failed_preinitialized_conflict(
            "namespace carries reconciliation success authority"
        )

    job_name = _vcluster_preview_job_name(name, "up")
    control_namespace = _vcluster_preview_control_namespace()
    try:
        job = batch.read_namespaced_job_status(
            name=job_name, namespace=control_namespace
        )
    except Exception as exc:
        if getattr(exc, "status", None) == 404:
            return _prove_expired_preinitialization_reservation(
                core,
                coordination,
                intent=intent,
                namespace=namespace,
                namespace_uid=namespace_uid,
                namespace_generation=namespace_generation,
                expected_lease_holder=expected_lease_holder,
            )
        raise
    if _runner_job_identity(job) != (name, "up"):
        raise _failed_preinitialized_conflict("up Job identity is malformed")
    job_generation = _runner_job_generation(job)
    if job_generation != namespace_generation:
        raise _failed_preinitialized_conflict(
            "up Job generation does not match the physical namespace"
        )
    job_metadata = _kube_field(job, "metadata")
    job_uid = _kube_field(job_metadata, "uid")
    if not isinstance(job_uid, str) or not re.fullmatch(
        r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}",
        job_uid,
    ):
        raise _failed_preinitialized_conflict("up Job UID is invalid")
    succeeded, failed, _ = _preview_job_state(job)
    job_status = _kube_field(job, "status")
    terminal_failed = any(
        str(_kube_field(condition, "status") or "").lower() == "true"
        and _kube_field(condition, "type") == "Failed"
        for condition in (_kube_field(job_status, "conditions") or [])
    )
    if (
        not failed
        or not terminal_failed
        or succeeded
        or int(_kube_field(job_status, "active") or 0) != 0
        or int(_kube_field(job_status, "succeeded") or 0) != 0
    ):
        raise _failed_preinitialized_conflict("up Job is not terminally failed")
    env = _runner_container_env(job)
    if env is None or env.get("PREVIEW_OPERATION_HOLDER") != job_generation:
        raise _failed_preinitialized_conflict("up Job operation holder is invalid")
    provenance = _safe_json_annotation(env.get("PREVIEW_PROVENANCE"), dict)
    if provenance is None or provenance.get("requestId") != intent["requestId"]:
        raise _failed_preinitialized_conflict("up Job request identity does not match")
    immutable_env = {
        "TARGET_REVISION": intent["platformRevision"],
        "SOURCE_REVISION": intent["sourceRevision"],
        "PREVIEW_CATALOG_DIGEST": intent["catalogDigest"],
    }
    if any(env.get(key) != value for key, value in immutable_env.items()):
        raise _failed_preinitialized_conflict(
            "up Job immutable revision tuple does not match"
        )

    pods = core.list_namespaced_pod(
        namespace=control_namespace, label_selector=f"job-name={job_name}"
    )
    pod_items = list(_kube_field(pods, "items") or [])
    if len(pod_items) != 1:
        raise _failed_preinitialized_conflict("up Job must have one exact failed pod")
    pod = pod_items[0]
    pod_metadata = _kube_field(pod, "metadata")
    pod_labels = _kube_field(pod_metadata, "labels") or {}
    pod_annotations = _kube_field(pod_metadata, "annotations") or {}
    owner_references = (
        _kube_field(pod_metadata, "owner_references", "ownerReferences") or []
    )
    owned_by_job = any(
        _kube_field(owner, "kind") == "Job"
        and _kube_field(owner, "name") == job_name
        and _kube_field(owner, "uid") == job_uid
        and _kube_field(owner, "controller") is True
        for owner in owner_references
    )
    pod_spec = _kube_field(pod, "spec")
    pod_status = _kube_field(pod, "status")
    pod_env = _runner_container_env(pod)
    if (
        not owned_by_job
        or pod_labels.get("job-name") != job_name
        or pod_labels.get("vcluster-preview-name") != name
        or pod_labels.get("vcluster-preview-action") != "up"
        or pod_annotations.get(RUNNER_GENERATION_ANNOTATION) != job_generation
        or _kube_field(pod_spec, "service_account_name", "serviceAccountName")
        != preview_runner_identity_name(name)
        or _kube_field(pod_status, "phase") != "Failed"
        or pod_env is None
        or pod_env.get("PREVIEW_OPERATION_HOLDER") != job_generation
    ):
        raise _failed_preinitialized_conflict("failed up pod identity is malformed")

    return FailedPreinitializedTeardownProof(
        preinitialization_evidence="failed-up-job-v1",
        physical_namespace_uid=namespace_uid,
        failed_up_job_uid=job_uid,
        failed_up_runner_generation=job_generation,
    )


def _preview_identity_cleanup_once(
    batch: Any,
    core: Any,
    rbac: Any,
    coordination: Any,
    *,
    namespace: str,
) -> dict[str, int]:
    stats = {"scanned": 0, "eligible": 0, "cleaned": 0, "busy": 0, "failed": 0}
    jobs = batch.list_namespaced_job(
        namespace=namespace,
        label_selector="vcluster-preview-action=down,preview.stacks.io/managed=true",
    )
    for listed_job in jobs.items:
        stats["scanned"] += 1
        preview_name = _down_job_identity(listed_job)
        succeeded, failed, _ = _preview_job_state(listed_job)
        annotations = (
            _kube_field(_kube_field(listed_job, "metadata"), "annotations") or {}
        )
        if (
            preview_name is None
            or not succeeded
            or failed
            or annotations.get(_PREVIEW_IDENTITY_CLEANED_ANNOTATION) == "true"
        ):
            continue
        stats["eligible"] += 1
        holder: str | None = None
        try:
            holder = _acquire_preview_operation_lease(
                coordination, namespace=namespace, real_name=preview_name
            )
        except HTTPException as exc:
            if exc.status_code == status.HTTP_409_CONFLICT:
                stats["busy"] += 1
                continue
            stats["failed"] += 1
            logger.warning(
                "preview-identity-cleanup: lease acquire failed for %s: %s",
                preview_name,
                exc.detail,
            )
            continue
        try:
            current_job = batch.read_namespaced_job_status(
                name=_vcluster_preview_job_name(preview_name, "down"),
                namespace=namespace,
                _request_timeout=_VCLUSTER_PREVIEW_PROBE_TIMEOUT,
            )
            current_name = _down_job_identity(current_job)
            current_succeeded, current_failed, _ = _preview_job_state(current_job)
            if (
                current_name != preview_name
                or not current_succeeded
                or current_failed
                or _namespace_exists(core, preview_name)
            ):
                continue
            PreviewRunnerIdentityAdapter(core, rbac).cleanup_after_down(
                preview_name=preview_name,
                runner_succeeded=True,
                target_namespace_absent=True,
            )
            batch.patch_namespaced_job(
                name=_vcluster_preview_job_name(preview_name, "down"),
                namespace=namespace,
                body={
                    "metadata": {
                        "annotations": {_PREVIEW_IDENTITY_CLEANED_ANNOTATION: "true"}
                    }
                },
            )
            _delete_preview_operation_lease(
                coordination,
                namespace=namespace,
                real_name=preview_name,
                holder=holder,
            )
            holder = None
            stats["cleaned"] += 1
        except Exception as exc:
            stats["failed"] += 1
            logger.warning(
                "preview-identity-cleanup: reconcile failed for %s: %s",
                preview_name,
                exc,
            )
        finally:
            if holder is not None:
                _release_preview_operation_lease(
                    coordination,
                    namespace=namespace,
                    real_name=preview_name,
                    holder=holder,
                )
    return stats


def _preview_identity_orphan_cleanup_once(
    batch: Any,
    core: Any,
    rbac: Any,
    coordination: Any,
    *,
    namespace: str,
) -> dict[str, int]:
    stats = {"scanned": 0, "recovered": 0, "cleaned": 0, "busy": 0, "failed": 0}
    namespaces = core.list_namespace(
        label_selector=(
            "preview.stacks.io/managed=true,preview.stacks.io/runner-admitted=false"
        )
    )
    for item in namespaces.items:
        stats["scanned"] += 1
        metadata = _kube_field(item, "metadata")
        labels = _kube_field(metadata, "labels") or {}
        annotations = _kube_field(metadata, "annotations") or {}
        preview_name = labels.get("preview.stacks.io/preview-name")
        runner_generation = annotations.get(RUNNER_GENERATION_ANNOTATION)
        if (
            not isinstance(preview_name, str)
            or _kube_field(metadata, "name") != f"vcluster-{preview_name}"
            or labels.get("preview.stacks.io/identity-ready") != "true"
            or not isinstance(runner_generation, str)
            or not re.fullmatch(r"op:[0-9a-f]{32}", runner_generation)
        ):
            stats["failed"] += 1
            continue
        holder: str | None = None
        cleaned = False
        try:
            holder = _acquire_preview_operation_lease(
                coordination, namespace=namespace, real_name=preview_name
            )
        except HTTPException as exc:
            if exc.status_code == status.HTTP_409_CONFLICT:
                stats["busy"] += 1
                continue
            stats["failed"] += 1
            continue
        try:
            current_namespace = core.read_namespace(name=f"vcluster-{preview_name}")
            current_labels = (
                _kube_field(_kube_field(current_namespace, "metadata"), "labels") or {}
            )
            current_annotations = (
                _kube_field(_kube_field(current_namespace, "metadata"), "annotations")
                or {}
            )
            if current_labels.get("preview.stacks.io/runner-admitted") != "false":
                continue
            if (
                current_annotations.get(RUNNER_GENERATION_ANNOTATION)
                != runner_generation
            ):
                continue
            jobs = batch.list_namespaced_job(
                namespace=namespace,
                label_selector=(
                    f"vcluster-preview-name={preview_name},"
                    "preview.stacks.io/managed=true"
                ),
            )
            identities = [(_runner_job_identity(job), job) for job in jobs.items]
            if any(identity is None for identity, _job in identities):
                raise PreviewRunnerIdentityError(
                    f"unadmitted reservation {preview_name} has a malformed Job"
                )
            valid_jobs = [
                job
                for identity, job in identities
                if identity is not None
                and identity[0] == preview_name
                and _runner_job_generation(job) == runner_generation
            ]
            if valid_jobs:
                core.patch_namespace(
                    name=f"vcluster-{preview_name}",
                    body={
                        "metadata": {
                            "labels": {"preview.stacks.io/runner-admitted": "true"}
                        }
                    },
                )
                proved = core.read_namespace(name=f"vcluster-{preview_name}")
                proved_labels = (
                    _kube_field(_kube_field(proved, "metadata"), "labels") or {}
                )
                if proved_labels.get("preview.stacks.io/runner-admitted") != "true":
                    raise PreviewRunnerIdentityError(
                        f"runner admission marker for {preview_name} did not persist"
                    )
                stats["recovered"] += 1
            else:
                PreviewRunnerIdentityAdapter(core, rbac).cleanup_unadmitted(
                    preview_name=preview_name
                )
                cleaned = True
                _delete_preview_operation_lease(
                    coordination,
                    namespace=namespace,
                    real_name=preview_name,
                    holder=holder,
                )
                holder = None
                stats["cleaned"] += 1
        except Exception as exc:
            stats["failed"] += 1
            logger.warning(
                "preview-identity-cleanup: orphan reconcile failed for %s: %s",
                preview_name,
                exc,
            )
        finally:
            if holder is not None:
                _release_preview_operation_lease(
                    coordination,
                    namespace=namespace,
                    real_name=preview_name,
                    holder=holder,
                )
        if cleaned:
            _invalidate_previews_cache()
    return stats


_preview_identity_cleanup_started = False
_preview_identity_cleanup_lock = threading.Lock()


def _preview_periodic_cleanup_once() -> dict[str, Any]:
    """Run independent conservative cleanup reconcilers for one periodic tick.

    Adopted Deployment restoration must not be starved by an unrelated runner
    identity failure: host Sandbox GC can remove the only claim without calling
    explicit dev-preview teardown, leaving the production Deployment at zero.
    Preview deployments retain this candidate-local recovery pass while the
    physical vCluster identity reconcilers remain control-plane-only.
    """
    result: dict[str, Any] = {
        "identity": None,
        "runnerOrphans": None,
        "adoptOrphans": None,
        "failures": [],
    }
    if not _env_flag_enabled("PREVIEW_HOST_RUNTIMES_DISABLED"):
        try:
            batch, core = _load_k8s_clients()
        except Exception as exc:
            result["failures"].append("runner-client-load")
            logger.warning("preview-identity-cleanup: client load failed: %s", exc)
        else:
            try:
                stats = _preview_identity_cleanup_once(
                    batch,
                    core,
                    _load_k8s_rbac_client(),
                    _load_k8s_coordination_client(),
                    namespace=_vcluster_preview_control_namespace(),
                )
                result["identity"] = stats
                if stats["failed"]:
                    logger.warning("preview-identity-cleanup: stats=%s", stats)
            except Exception as exc:
                result["failures"].append("identity")
                logger.warning("preview-identity-cleanup: pass failed: %s", exc)
            try:
                orphan_stats = _preview_identity_orphan_cleanup_once(
                    batch,
                    core,
                    _load_k8s_rbac_client(),
                    _load_k8s_coordination_client(),
                    namespace=_vcluster_preview_control_namespace(),
                )
                result["runnerOrphans"] = orphan_stats
                if orphan_stats["failed"]:
                    logger.warning(
                        "preview-identity-cleanup: orphan stats=%s", orphan_stats
                    )
            except Exception as exc:
                result["failures"].append("runner-orphans")
                logger.warning("preview-identity-cleanup: orphan pass failed: %s", exc)

    try:
        result["adoptOrphans"] = _adopt_restore_orphans(
            _load_k8s_apps_client(),
            _load_k8s_custom_objects_client(),
            namespace=_agent_workflow_host_namespace(),
            coordination=_load_k8s_coordination_client(),
        )
    except Exception as exc:
        result["failures"].append("adopt-orphans")
        logger.warning("adopt: periodic orphan sweep failed: %s", exc)
    return result


def _preview_identity_cleanup_loop() -> None:
    interval = float(
        os.environ.get("VCLUSTER_PREVIEW_IDENTITY_RECONCILE_SECONDS", "10") or 10
    )
    time.sleep(min(interval, 5.0))
    logger.info("preview-identity-cleanup: started (interval=%.0fs)", interval)
    while True:
        try:
            _preview_periodic_cleanup_once()
        except Exception as exc:
            logger.warning("preview-periodic-cleanup: unexpected pass failure: %s", exc)
        time.sleep(interval)


def _start_preview_identity_cleanup_controller() -> None:
    if os.environ.get("SANDBOX_EXECUTION_DRY_RUN", "").lower() in {
        "1",
        "true",
        "yes",
    }:
        return
    global _preview_identity_cleanup_started
    with _preview_identity_cleanup_lock:
        if _preview_identity_cleanup_started:
            return
        _preview_identity_cleanup_started = True
        threading.Thread(
            target=_preview_identity_cleanup_loop,
            daemon=True,
            name="vcluster-preview-identity-cleanup",
        ).start()


@app.get("/internal/vcluster-preview/{name}/cleanup")
def get_vcluster_preview_cleanup(request: Request, name: str) -> dict[str, Any]:
    """Converge and prove teardown of the bounded per-preview runner identity."""
    _require_internal(request)
    safe_name = _safe_resource_name(name, max_length=40)
    if os.environ.get("SANDBOX_EXECUTION_DRY_RUN", "").lower() in {
        "1",
        "true",
        "yes",
    }:
        checks = {
            "runnerSucceeded": True,
            "previewEnvironmentAbsent": False,
            "applicationAbsent": False,
            "agentRegistrationAbsent": False,
            "agentNamespacesAbsent": False,
            "databaseAbsent": True,
            "natsStreamAbsent": True,
            "headlampRegistrationAbsent": False,
            "tailnetEgressAbsent": True,
            "hostNamespaceAbsent": True,
            "storageScopeAbsent": True,
            "runnerIdentityAbsent": True,
        }
        return {
            "name": name,
            "resourceName": safe_name,
            "complete": True,
            "phase": "complete",
            "checks": checks,
            "message": None,
        }

    batch, core = _load_k8s_clients()
    real_name = _resolve_preview_realname_strict(core, safe_name)
    succeeded = failed = False
    message: str | None = None
    job: Any | None = None
    try:
        job = batch.read_namespaced_job_status(
            name=_vcluster_preview_job_name(real_name, "down"),
            namespace=_vcluster_preview_control_namespace(),
            _request_timeout=_VCLUSTER_PREVIEW_PROBE_TIMEOUT,
        )
        succeeded, failed, message = _preview_job_state(job)
    except Exception as exc:
        if getattr(exc, "status", None) != 404:
            raise

    host_absent = not _namespace_exists(core, real_name)
    runner_identity_absent = False
    if succeeded and host_absent:
        try:
            runner_identity_absent = PreviewRunnerIdentityAdapter(
                core, _load_k8s_rbac_client()
            ).is_absent(preview_name=real_name)
        except PreviewRunnerIdentityError as exc:
            message = f"runner identity absence proof pending: {exc}"
    # SEA proves only dev-side physical cleanup. The hub PreviewEnvironment remains
    # finalizer-blocked until the broker records the tuple-bound teardownProof; hub
    # Application/registration absence is a later controller phase.
    checks = {
        "runnerSucceeded": succeeded,
        "previewEnvironmentAbsent": False,
        "applicationAbsent": False,
        "agentRegistrationAbsent": False,
        "agentNamespacesAbsent": False,
        "databaseAbsent": succeeded,
        "natsStreamAbsent": succeeded,
        "headlampRegistrationAbsent": False,
        "tailnetEgressAbsent": succeeded,
        "hostNamespaceAbsent": host_absent,
        "storageScopeAbsent": succeeded,
        "runnerIdentityAbsent": runner_identity_absent,
    }
    complete = succeeded and host_absent and runner_identity_absent
    phase = "complete" if complete else "failed" if failed else "pending"
    teardown_proof: dict[str, str] | None = None
    if complete and job is not None:
        job_metadata = _kube_field(job, "metadata")
        job_annotations = _kube_field(job_metadata, "annotations") or {}
        intent_id = job_annotations.get("preview.stacks.io/teardown-intent-id")
        environment_uid = job_annotations.get(
            "preview.stacks.io/teardown-environment-uid"
        )
        request_id = job_annotations.get("preview.stacks.io/teardown-request-id")
        source_revision = job_annotations.get(
            "preview.stacks.io/teardown-source-revision"
        )
        runner_generation = _runner_job_generation(job)
        job_uid = _kube_field(job_metadata, "uid")
        job_name = _kube_field(job_metadata, "name")
        if (
            isinstance(intent_id, str)
            and re.fullmatch(r"sha256:[0-9a-f]{64}", intent_id)
            and isinstance(environment_uid, str)
            and re.fullmatch(
                r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}",
                environment_uid,
            )
            and isinstance(request_id, str)
            and request_id
            and isinstance(source_revision, str)
            and re.fullmatch(r"[0-9a-f]{40}", source_revision)
            and isinstance(job_name, str)
            and job_name == _vcluster_preview_job_name(real_name, "down")
            and isinstance(job_uid, str)
            and re.fullmatch(
                r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}",
                job_uid,
            )
            and runner_generation is not None
        ):
            teardown_proof = {
                "intentId": intent_id,
                "environmentUid": environment_uid,
                "requestId": request_id,
                "sourceRevision": source_revision,
                "jobName": job_name,
                "jobUid": job_uid,
                "runnerGeneration": runner_generation,
            }
    result = {
        "name": name,
        "resourceName": real_name,
        "complete": complete,
        "phase": phase,
        "checks": checks,
        **({"teardownProof": teardown_proof} if teardown_proof is not None else {}),
        "message": message,
    }
    set_current_span_io("output", result)
    return result


def _cleanup_receipt_from_job(job: Any, core: Any) -> dict[str, str] | None:
    preview_name = _down_job_identity(job)
    succeeded, failed, _ = _preview_job_state(job)
    metadata = _kube_field(job, "metadata")
    annotations = _kube_field(metadata, "annotations") or {}
    job_name = _kube_field(metadata, "name")
    job_uid = _kube_field(metadata, "uid")
    generation = _runner_job_generation(job)
    if (
        preview_name is None
        or not succeeded
        or failed
        or annotations.get(_PREVIEW_IDENTITY_CLEANED_ANNOTATION) != "true"
        or _namespace_exists(core, preview_name)
        or job_name != _vcluster_preview_job_name(preview_name, "down")
        or not isinstance(job_uid, str)
        or re.fullmatch(
            r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}",
            job_uid,
        )
        is None
        or generation is None
    ):
        return None
    return {
        "name": preview_name,
        "jobName": job_name,
        "jobUid": job_uid,
        "runnerGeneration": generation,
    }


@app.get("/internal/vcluster-preview-cleanup-receipts")
def list_vcluster_preview_cleanup_receipts(request: Request) -> dict[str, Any]:
    """List durable down Jobs eligible for hub-absence-gated pruning."""

    _require_internal(request)
    batch, core = _load_k8s_clients()
    jobs = batch.list_namespaced_job(
        namespace=_vcluster_preview_control_namespace(),
        label_selector="vcluster-preview-action=down,preview.stacks.io/managed=true",
    )
    receipts = [
        receipt
        for job in jobs.items
        if (receipt := _cleanup_receipt_from_job(job, core)) is not None
    ]
    return {"receipts": sorted(receipts, key=lambda item: item["name"])}


@app.delete("/internal/vcluster-preview-cleanup-receipts/{name}")
def release_vcluster_preview_cleanup_receipt(
    request: Request,
    name: str,
    body: VclusterPreviewCleanupReceiptReleaseRequest,
) -> dict[str, Any]:
    """Delete one exact receipt after the broker separately proved hub CR absence."""

    _require_internal(request)
    safe_name = _safe_resource_name(name, max_length=40)
    batch, core = _load_k8s_clients()
    coordination = _load_k8s_coordination_client()
    namespace = _vcluster_preview_control_namespace()
    job_name = _vcluster_preview_job_name(safe_name, "down")
    try:
        job = batch.read_namespaced_job_status(
            name=job_name,
            namespace=namespace,
            _request_timeout=_VCLUSTER_PREVIEW_PROBE_TIMEOUT,
        )
    except Exception as exc:
        if getattr(exc, "status", None) == 404:
            _delete_preview_operation_lease(
                coordination,
                namespace=namespace,
                real_name=safe_name,
                holder="",
            )
            return {"name": safe_name, "jobName": job_name, "absent": True}
        raise
    receipt = _cleanup_receipt_from_job(job, core)
    if (
        receipt is None
        or receipt["jobUid"] != body.jobUid
        or receipt["runnerGeneration"] != body.runnerGeneration
    ):
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="cleanup receipt identity or absence proof no longer matches",
        )
    try:
        batch.delete_namespaced_job(
            name=job_name,
            namespace=namespace,
            body={
                "apiVersion": "v1",
                "kind": "DeleteOptions",
                "propagationPolicy": "Background",
                "preconditions": {"uid": body.jobUid},
            },
        )
    except Exception as exc:
        if getattr(exc, "status", None) != 404:
            if getattr(exc, "status", None) == 409:
                raise HTTPException(
                    status_code=status.HTTP_409_CONFLICT,
                    detail="cleanup receipt Job identity changed before deletion",
                ) from exc
            raise
    for _ in range(30):
        try:
            remaining = batch.read_namespaced_job(
                name=job_name,
                namespace=namespace,
            )
        except Exception as exc:
            if getattr(exc, "status", None) == 404:
                break
            raise
        remaining_metadata = _kube_field(remaining, "metadata")
        remaining_uid = str(_kube_field(remaining_metadata, "uid") or "")
        if remaining_uid != body.jobUid:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail="cleanup receipt Job replacement appeared during deletion",
            )
        time.sleep(0.1)
    else:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="cleanup receipt deletion did not converge",
        )
    _delete_preview_operation_lease(
        coordination,
        namespace=namespace,
        real_name=safe_name,
        holder="",
    )
    return {"name": safe_name, "jobName": job_name, "absent": True}


def _read_preview_member(
    core, name: str, *, allow_terminating: bool = False
) -> PreviewMember:
    """Resolve a user-facing name (alias or real) to its PreviewMember, 404-ing on
    anything that is not a live preview vcluster namespace. The app=vcluster-preview
    label check is the HARD safety rule: lifecycle endpoints can never act on an
    arbitrary namespace."""
    real_name = _resolve_preview_realname_strict(core, name)
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
    if member.terminating and not allow_terminating:
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
        member, resuming = _resume_preview_with_capacity(
            batch,
            core,
            name=name,
            namespace=_vcluster_preview_control_namespace(),
        )
    else:
        namespace = _vcluster_preview_control_namespace()
        coordination = _load_k8s_coordination_client()
        holder = _acquire_preview_operation_lease(
            coordination, namespace=namespace, real_name=member.real_name
        )
        try:
            member = _read_preview_member(core, name)
            if member.slept:
                raise HTTPException(
                    status_code=status.HTTP_409_CONFLICT,
                    detail="preview state changed while reserving touch",
                )
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
        except HTTPException:
            raise
        except Exception as exc:
            logger.warning(
                "touch: last-active stamp %s failed: %s", member.real_name, exc
            )
            raise HTTPException(status_code=500, detail="touch failed") from exc
        finally:
            _release_preview_operation_lease(
                coordination,
                namespace=namespace,
                real_name=member.real_name,
                holder=holder,
            )
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
    initial = _read_preview_member(core, name)
    namespace = _vcluster_preview_control_namespace()
    coordination = _load_k8s_coordination_client()
    holder = _acquire_preview_operation_lease(
        coordination, namespace=namespace, real_name=initial.real_name
    )
    handed_to_runner = False
    try:
        member = _read_preview_member(core, name)
        if member.real_name != initial.real_name:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail="preview alias changed while reserving sleep",
            )
        if member.protected:
            raise HTTPException(status_code=409, detail="preview is protected")
        if member.pool_state in ("free", "recycling"):
            raise HTTPException(
                status_code=409,
                detail="free pool members stay claim-ready (never slept)",
            )
        if member.slept:
            return {
                "name": name,
                "state": "slept",
                "job": None,
                "alreadySlept": True,
            }
        if not _sleep_member(
            batch,
            core,
            member,
            namespace,
            operation_holder=holder,
        ):
            raise HTTPException(status_code=500, detail="sleep failed")
        handed_to_runner = True
    finally:
        if not handed_to_runner:
            _release_preview_operation_lease(
                coordination,
                namespace=namespace,
                real_name=initial.real_name,
                holder=holder,
            )
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
    """Run one legacy A4 pass (expiry/capacity deferral or legacy cleanup, then sleep) and
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
            "archiveRequired": 0,
            "applicationReaperRequired": 0,
        }
    batch, core = _load_k8s_clients()
    need_room = body.needRoom if body and body.needRoom and body.needRoom > 0 else 0
    stats = _lifecycle_reap_once(batch, core, need_room=need_room)
    set_current_span_io("output", stats)
    return stats


@app.delete("/internal/vcluster-preview/{name}")
def teardown_vcluster_preview(
    request: Request,
    name: str,
    body: VclusterPreviewTeardownRequest | None = None,
) -> dict[str, Any]:
    _require_internal(request)
    # Teardown == an ACTION=down Job (drops the per-preview DB + vcluster delete). Resolve an
    # alias to its backing pool member so tearing down a claimed preview reaps pool-<n>.
    real_name = name
    if os.environ.get("SANDBOX_EXECUTION_DRY_RUN", "").lower() not in {
        "1",
        "true",
        "yes",
    }:
        batch, core = _load_k8s_clients()
        if body is not None:
            if bool(body.expectedRequestId) == bool(body.protectedRequestId):
                raise HTTPException(
                    status_code=400,
                    detail=(
                        "teardown requires exactly one of expectedRequestId or "
                        "protectedRequestId"
                    ),
                )
            if body.expectedRequestId and not body.expectedSourceRevision:
                raise HTTPException(
                    status_code=400,
                    detail="owned teardown requires expectedSourceRevision",
                )
        try:
            member = _read_preview_member(
                core,
                name,
                allow_terminating=body is not None,
            )
        except HTTPException as exc:
            if exc.status_code != status.HTTP_404_NOT_FOUND:
                raise
            member = None
        real_name = (
            member.real_name
            if member is not None
            else _safe_resource_name(name, max_length=40)
        )
        controller_intent = (
            _controller_deletion_intent(
                name=real_name,
                request_id=body.expectedRequestId,
                platform_revision=body.platformRevision,
                source_revision=body.expectedSourceRevision,
                catalog_digest=body.catalogDigest,
                deletion_timestamp=body.deletionTimestamp,
                environment_uid=body.environmentUid,
                intent_id=body.deletionIntentId,
            )
            if body is not None
            else None
        )
        if member is not None and _preview_member_is_controller_owned(member):
            if body is None or bool(body.expectedRequestId) == bool(
                body.protectedRequestId
            ):
                raise HTTPException(
                    status_code=400,
                    detail=(
                        "profiled preview teardown requires one exact owned or "
                        "superseded ownership guard"
                    ),
                )
        if body is not None and member is not None:
            observed_request_id = (
                member.provenance.get("requestId")
                if member.provenance is not None
                else None
            )
            if body.expectedRequestId and (
                observed_request_id != body.expectedRequestId
                or member.source_revision != body.expectedSourceRevision
            ):
                if controller_intent is None:
                    raise HTTPException(
                        status_code=409,
                        detail="preview teardown ownership no longer matches",
                    )
                # Preliminary proof prevents the public DELETE seam from becoming
                # a generic missing-annotation bypass. provision_vcluster_preview
                # repeats the complete proof under the operation Lease.
                _prove_failed_preinitialized_teardown(
                    batch,
                    core,
                    _load_k8s_coordination_client(),
                    intent=controller_intent,
                )
            if (
                body.protectedRequestId
                and observed_request_id == body.protectedRequestId
            ):
                raise HTTPException(
                    status_code=409,
                    detail="refusing to teardown the protected preview generation",
                )
    teardown = VclusterPreviewRequest(
        name=real_name,
        action="down",
        teardownExpectedRequestId=(body.expectedRequestId if body else None),
        teardownExpectedSourceRevision=(body.expectedSourceRevision if body else None),
        teardownExpectedPlatformRevision=(body.platformRevision if body else None),
        teardownExpectedCatalogDigest=(body.catalogDigest if body else None),
        teardownDeletionTimestamp=(body.deletionTimestamp if body else None),
        teardownProtectedRequestId=(body.protectedRequestId if body else None),
        teardownEnvironmentUid=(body.environmentUid if body else None),
        teardownIntentId=(body.deletionIntentId if body else None),
    )
    return provision_vcluster_preview(request, teardown)


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
_VCLUSTER_PREVIEW_ALIAS_LABEL = (
    "vcluster-preview-alias"  # a claimed member's user-facing name
)
_VCLUSTER_PREVIEW_CLAIMED_BY_ANNOTATION = "vcluster-preview-claimed-by"
_VCLUSTER_PREVIEW_CLAIMED_AT_ANNOTATION = "vcluster-preview-claimed-at"
# Immutable PreviewEnvironment provenance stamped by runner.sh on the durable
# host namespace. Warm admission compares the requested SHA to this value before
# the atomic free -> claimed transition.
_VCLUSTER_PREVIEW_PLATFORM_REVISION_ANNOTATION = "preview.stacks.io/target-revision"
_VCLUSTER_PREVIEW_SOURCE_REVISION_ANNOTATION = "preview.stacks.io/source-revision"
_VCLUSTER_PREVIEW_PROFILE_ANNOTATION = "preview.stacks.io/profile"
_VCLUSTER_PREVIEW_LANE_ANNOTATION = "preview.stacks.io/lane"
_VCLUSTER_PREVIEW_MODE_ANNOTATION = "preview.stacks.io/mode"
_VCLUSTER_PREVIEW_OWNER_ANNOTATION = "preview.stacks.io/owner"
_VCLUSTER_PREVIEW_ORIGIN_ANNOTATION = "preview.stacks.io/origin"
_VCLUSTER_PREVIEW_LIFECYCLE_ANNOTATION = "preview.stacks.io/lifecycle"
_VCLUSTER_PREVIEW_SERVICES_ANNOTATION = "preview.stacks.io/services"
_VCLUSTER_PREVIEW_PROVENANCE_ANNOTATION = "preview.stacks.io/provenance"
_VCLUSTER_PREVIEW_TRUSTED_CODE_ANNOTATION = "preview.stacks.io/trusted-code"
_VCLUSTER_PREVIEW_ALLOCATION_ANNOTATION = "preview.stacks.io/allocation"
_VCLUSTER_PREVIEW_IMAGES_ANNOTATION = "preview.stacks.io/images"
_VCLUSTER_PREVIEW_CATALOG_DIGEST_ANNOTATION = "preview.stacks.io/catalog-digest"
_VCLUSTER_PREVIEW_RECONCILIATION_SUCCEEDED_AT_ANNOTATION = (
    "preview.stacks.io/reconciliation-succeeded-at"
)
_VCLUSTER_PREVIEW_RECONCILIATION_PLATFORM_REVISION_ANNOTATION = (
    "preview.stacks.io/reconciliation-platform-revision"
)
_VCLUSTER_PREVIEW_RECONCILIATION_SOURCE_REVISION_ANNOTATION = (
    "preview.stacks.io/reconciliation-source-revision"
)
# LEGACY baked image-pin signature (bff=…;orch=…;fr=…;sea=…). Superseded by the
# bake-inputs hash below; still read for the one-time migration turnover (a member
# carrying only this and no bake-hash is treated as stale exactly once).
_VCLUSTER_PREVIEW_IMAGE_PINS_ANNOTATION = "vcluster-preview-image-pins"
# Bake-inputs signature the runner stamps on each baked member: sha256 over the
# mounted `vcluster-preview-runner` ConfigMap (the same bytes the runner hashes with
# `cat /config/* | sha256sum`). The recycler diffs this vs `_bake_inputs_hash()` to
# detect a member baked from stale inputs (pins, template DB, runner script).
_VCLUSTER_PREVIEW_BAKE_HASH_ANNOTATION = "vcluster-preview-bake-hash"
# Recycling is a durable state, not merely an in-process transition. These
# annotations let a fresh SEA process determine whether teardown needs another
# attempt without ever making the member claimable again.
_VCLUSTER_PREVIEW_RECYCLING_AT_ANNOTATION = "vcluster-preview-recycling-at"
_VCLUSTER_PREVIEW_RECYCLE_REASON_ANNOTATION = "vcluster-preview-recycle-reason"
_VCLUSTER_PREVIEW_RECYCLE_ATTEMPT_ANNOTATION = "vcluster-preview-recycle-attempt"
_VCLUSTER_PREVIEW_RECYCLE_LAST_ATTEMPT_ANNOTATION = (
    "vcluster-preview-recycle-last-attempt"
)
_VCLUSTER_PREVIEW_RECYCLE_ERROR_ANNOTATION = "vcluster-preview-recycle-error"

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


def _safe_json_annotation(raw: Any, expected_type: type) -> Any | None:
    if not isinstance(raw, str) or not raw or len(raw.encode("utf-8")) > 8192:
        return None
    try:
        value = json.loads(
            raw,
            parse_constant=lambda value: (_ for _ in ()).throw(
                ValueError(f"invalid JSON constant {value}")
            ),
        )
        encoded = json.dumps(value, separators=(",", ":"), allow_nan=False)
    except (TypeError, ValueError, RecursionError):
        return None
    if not isinstance(value, expected_type) or len(encoded.encode("utf-8")) > 8192:
        return None
    return value


def _safe_services_annotation(raw: Any) -> tuple[str, ...] | None:
    values = _safe_json_annotation(raw, list)
    if values is None or len(values) > 16:
        return None
    services: list[str] = []
    for value in values:
        if not isinstance(value, str) or not re.fullmatch(
            r"[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?", value
        ):
            return None
        if value in services:
            return None
        services.append(value)
    return tuple(services)


def _safe_allocation_annotation(raw: Any) -> dict[str, str] | None:
    value = _safe_json_annotation(raw, dict)
    if value is None or set(value) - {"kind", "baselinePlatformRevision"}:
        return None
    kind = value.get("kind")
    if kind not in {"cold", "warm"}:
        return None
    baseline = value.get("baselinePlatformRevision")
    if kind == "cold" and baseline is not None:
        return None
    if kind == "warm" and (
        not isinstance(baseline, str) or not re.fullmatch(r"[0-9a-f]{40}", baseline)
    ):
        return None
    return {
        "kind": kind,
        **({"baselinePlatformRevision": baseline} if baseline is not None else {}),
    }


def _safe_images_annotation(raw: Any) -> dict[str, str] | None:
    value = _safe_json_annotation(raw, dict)
    if value is None or len(value) > 16:
        return None
    images: dict[str, str] = {}
    image_pattern = re.compile(
        r"^ghcr\.io/[a-z0-9]+(?:[._-][a-z0-9]+)*"
        r"(?:/[a-z0-9]+(?:[._-][a-z0-9]+)*)+"
        r"@sha256:[0-9a-f]{64}$"
    )
    for service, image in value.items():
        if not isinstance(service, str) or not re.fullmatch(
            r"[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?", service
        ):
            return None
        if not isinstance(image, str) or not image_pattern.fullmatch(image):
            return None
        images[service] = image
    return images


def _safe_annotation(raw: Any, pattern: str, max_length: int = 512) -> str | None:
    if (
        not isinstance(raw, str)
        or len(raw) > max_length
        or not re.fullmatch(pattern, raw)
    ):
        return None
    return raw


def _safe_owner_contract(raw: Any) -> dict[str, str] | None:
    value = _safe_json_annotation(raw, dict)
    if value is None or set(value) != {"kind", "id"}:
        return None
    kind = value.get("kind")
    owner_id = value.get("id")
    if kind not in {"user", "workflow", "session", "automation"}:
        return None
    if not isinstance(owner_id, str) or not re.fullmatch(
        r"[A-Za-z0-9][A-Za-z0-9_.:@/-]{0,127}", owner_id
    ):
        return None
    return {"kind": kind, "id": owner_id}


def _safe_origin_contract(raw: Any) -> dict[str, str] | None:
    value = _safe_json_annotation(raw, dict)
    if value is None or set(value) - {"kind", "reference"}:
        return None
    kind = value.get("kind")
    if kind not in {
        "user",
        "pull-request",
        "workflow",
        "interactive-session",
        "automation",
    }:
        return None
    reference = value.get("reference")
    if reference is not None and (
        not isinstance(reference, str)
        or not reference.strip()
        or len(reference) > 512
        or re.search(r"[\x00-\x1f\x7f]", reference)
    ):
        return None
    if kind in {"pull-request", "workflow", "interactive-session"} and not reference:
        return None
    return {
        "kind": kind,
        **({"reference": reference} if isinstance(reference, str) else {}),
    }


@dataclass
class PreviewMember:
    """One preview vcluster's lifecycle-relevant state, parsed off its host namespace.
    A plain value object so the A4 selection logic (`_select_preview_evictions`,
    `_member_is_expired`, …) stays PURE and exhaustively unit-testable."""

    real_name: str
    ns_name: str
    namespace_uid: str | None = None
    pool_state: str | None = None  # free | claimed | recycling | None (non-pool)
    alias: str | None = None
    slept: bool = False
    origin: str | None = None  # user | pr | None (legacy/human)
    lifecycle: str | None = None
    owner_contract: dict[str, str] | None = None
    origin_contract: dict[str, str] | None = None
    pr_number: int | None = None
    protected: bool = False
    terminating: bool = False
    created_at: datetime | None = None
    last_active: datetime | None = None
    expires_at: datetime | None = None  # the EXPLICIT annotation only
    platform_revision: str | None = None
    source_revision: str | None = None
    profile: str | None = None
    lane: str | None = None
    mode: str | None = None
    owner: str | None = None
    services: tuple[str, ...] | None = None
    provenance: dict[str, Any] | None = None
    trusted_code: bool | None = None
    allocation: dict[str, str] | None = None
    images: dict[str, str] | None = None
    catalog_digest: str | None = None
    reconciliation_succeeded_at: datetime | None = None
    reconciliation_platform_revision: str | None = None
    reconciliation_source_revision: str | None = None


def _preview_member_is_immutable_reconciled(member: PreviewMember) -> bool:
    services = set(member.services or ())
    images = member.images or {}
    image_pattern = re.compile(
        r"^ghcr\.io/pittampalliorg/[a-z0-9][a-z0-9._-]{0,126}[a-z0-9]"
        r"@sha256:[0-9a-f]{64}$"
    )
    return bool(
        member.profile == "app-live"
        and member.mode == "reconciled"
        and member.allocation == {"kind": "cold"}
        and member.trusted_code is True
        and re.fullmatch(r"[0-9a-f]{40}", member.platform_revision or "")
        and re.fullmatch(r"[0-9a-f]{40}", member.source_revision or "")
        and re.fullmatch(r"sha256:[0-9a-f]{64}", member.catalog_digest or "")
        and services
        and set(images) == services
        and all(image_pattern.fullmatch(image) for image in images.values())
        and member.reconciliation_succeeded_at is not None
        and member.reconciliation_platform_revision == member.platform_revision
        and member.reconciliation_source_revision == member.source_revision
    )


def _preview_member_requires_archive_teardown(member: PreviewMember) -> bool:
    """User/malformed live state requires archive; exact PR automation is reproducible."""
    pull_request_automation = bool(
        member.mode == "live"
        and member.owner_contract is not None
        and member.owner_contract.get("kind") == "automation"
        and member.origin_contract is not None
        and member.origin_contract.get("kind") == "pull-request"
    )
    return bool(
        member.profile == "app-live"
        and not pull_request_automation
        and not _preview_member_is_immutable_reconciled(member)
    )


def _preview_member_is_controller_owned(member: PreviewMember) -> bool:
    """Return previews whose teardown ordering is owned by the physical broker."""
    return bool(
        member.trusted_code is True
        and member.allocation == {"kind": "cold"}
        and member.profile in {"app-live", "manifest-candidate"}
        and member.mode in {"live", "reconciled"}
    )


def _require_preview_archive_teardown_proof(request: Request) -> None:
    expected = os.environ.get("PREVIEW_ARCHIVE_TEARDOWN_TOKEN", "").strip()
    if not expected:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="preview archive teardown proof is not configured",
        )
    supplied = request.headers.get("x-preview-archive-teardown-token", "")
    if not secrets.compare_digest(supplied, expected):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="valid preview archive teardown proof is required",
        )


def _preview_member_from_ns(ns) -> PreviewMember:
    meta = getattr(ns, "metadata", None)
    labels = getattr(meta, "labels", None) or {}
    annotations = getattr(meta, "annotations", None) or {}
    owner_contract = _safe_owner_contract(
        annotations.get(_VCLUSTER_PREVIEW_OWNER_ANNOTATION)
    )
    origin_contract = _safe_origin_contract(
        annotations.get(_VCLUSTER_PREVIEW_ORIGIN_ANNOTATION)
    )
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
        namespace_uid=getattr(meta, "uid", None),
        pool_state=labels.get(_VCLUSTER_PREVIEW_POOL_LABEL),
        alias=labels.get(_VCLUSTER_PREVIEW_ALIAS_LABEL),
        slept=labels.get(_VCLUSTER_PREVIEW_STATE_LABEL) == "slept",
        origin=labels.get(_VCLUSTER_PREVIEW_ORIGIN_LABEL),
        lifecycle=_safe_annotation(
            annotations.get(_VCLUSTER_PREVIEW_LIFECYCLE_ANNOTATION),
            r"(?:ephemeral|retained)",
            16,
        ),
        owner_contract=owner_contract,
        origin_contract=origin_contract,
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
        platform_revision=_safe_annotation(
            annotations.get(_VCLUSTER_PREVIEW_PLATFORM_REVISION_ANNOTATION),
            r"[0-9a-f]{40}",
            40,
        ),
        source_revision=_safe_annotation(
            annotations.get(_VCLUSTER_PREVIEW_SOURCE_REVISION_ANNOTATION),
            r"[0-9a-f]{40}",
            40,
        ),
        profile=_safe_annotation(
            annotations.get(_VCLUSTER_PREVIEW_PROFILE_ANNOTATION),
            r"(?:app-live|manifest-candidate)",
            32,
        ),
        lane=_safe_annotation(
            annotations.get(_VCLUSTER_PREVIEW_LANE_ANNOTATION),
            r"(?:application|management)",
            16,
        ),
        mode=_safe_annotation(
            annotations.get(_VCLUSTER_PREVIEW_MODE_ANNOTATION),
            r"(?:live|reconciled)",
            16,
        ),
        owner=(
            owner_contract["id"]
            if owner_contract is not None
            else _safe_annotation(
                annotations.get(_VCLUSTER_PREVIEW_OWNER_ANNOTATION),
                r"[A-Za-z0-9][A-Za-z0-9_.:@/-]{0,127}",
                128,
            )
        ),
        services=_safe_services_annotation(
            annotations.get(_VCLUSTER_PREVIEW_SERVICES_ANNOTATION)
        ),
        provenance=_safe_json_annotation(
            annotations.get(_VCLUSTER_PREVIEW_PROVENANCE_ANNOTATION), dict
        ),
        trusted_code=(
            True
            if annotations.get(_VCLUSTER_PREVIEW_TRUSTED_CODE_ANNOTATION) == "true"
            else False
            if annotations.get(_VCLUSTER_PREVIEW_TRUSTED_CODE_ANNOTATION) == "false"
            else None
        ),
        allocation=_safe_allocation_annotation(
            annotations.get(_VCLUSTER_PREVIEW_ALLOCATION_ANNOTATION)
        ),
        images=_safe_images_annotation(
            annotations.get(_VCLUSTER_PREVIEW_IMAGES_ANNOTATION)
        ),
        catalog_digest=_safe_annotation(
            annotations.get(_VCLUSTER_PREVIEW_CATALOG_DIGEST_ANNOTATION),
            r"sha256:[0-9a-f]{64}",
            71,
        ),
        reconciliation_succeeded_at=_parse_rfc3339(
            annotations.get(_VCLUSTER_PREVIEW_RECONCILIATION_SUCCEEDED_AT_ANNOTATION)
        ),
        reconciliation_platform_revision=_safe_annotation(
            annotations.get(
                _VCLUSTER_PREVIEW_RECONCILIATION_PLATFORM_REVISION_ANNOTATION
            ),
            r"[0-9a-f]{40}",
            40,
        ),
        reconciliation_source_revision=_safe_annotation(
            annotations.get(
                _VCLUSTER_PREVIEW_RECONCILIATION_SOURCE_REVISION_ANNOTATION
            ),
            r"[0-9a-f]{40}",
            40,
        ),
    )


# #29: pool-lifecycle states that are POOL PLUMBING, not user previews — hidden from the
# user-facing list (still counted, and visible via ?includePool=true for admin/debug):
#   baking    — up-Job still running; the runner stamps this at Job START (before the
#               ~5min bringup) and flips it to `free` at completion
#   free      — baked, claimable
#   recycling — being torn down by the recycler/reaper
_POOL_HIDDEN_STATES = ("baking", "free", "recycling")

# The pool manager names members `pool-` + secrets.token_hex(2) → exactly 4 hex chars.
_POOL_MEMBER_NAME_RE = re.compile(r"pool-[0-9a-f]{4}")


def _member_effective_pool_state(member: PreviewMember) -> str | None:
    """The pool state used to CLASSIFY a member in the list: the pool label when present.

    FALLBACK HEURISTIC — remove once no live member predates the runner's stamp-baking-
    at-Job-start change: older runner images only labeled the ns at bake COMPLETION
    (`free`), leaving mid-bake members unlabeled for their whole ~5min bringup. Those
    showed up in the user list as ordinary previews named pool-XXXX — the 2026-07-05
    incident where a user's UI delete removed free member pool-1251. A member whose id
    matches the pool-manager's generated shape (pool-<4 hex>) with NO pool label and NO
    alias is therefore treated as baking (hidden). Trade-off: a user COLD preview
    literally named e.g. `pool-ab12` would be mis-hidden from the list (it keeps
    working and stays deletable by name via the API) until this fallback is removed."""
    if member.pool_state:
        return member.pool_state
    if member.alias is None and _POOL_MEMBER_NAME_RE.fullmatch(member.real_name):
        return "baking"
    return None


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


def _member_is_expired(member: PreviewMember, *, now: datetime, ttl_hours: int) -> bool:
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
      4. ephemeral         — non-expired ephemeral previews, oldest-created first;
                             legacy origin=pr previews remain eligible during cutover

    NEVER returned, in any bucket: protected members, terminating members, members already
    recycling, RECENTLY-ACTIVE members (touched within active_minutes), and human previews
    with retained lifecycle that are not expired."""
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
    ephemeral = sorted(
        (
            m
            for m in non_free
            if m.real_name not in expired_names
            and (
                m.lifecycle == "ephemeral" or (m.lifecycle is None and m.origin == "pr")
            )
        ),
        key=created_key,
    )
    ordered = free_slept + free_hot_surplus + expired + ephemeral
    return ordered[:need]


def _preview_lifecycle_fields(member: PreviewMember) -> dict[str, Any]:
    """The A4/D1 lifecycle fields surfaced on the list + get endpoints (contract with the
    BFF PR-preview consumer): origin, prNumber, expiresAt, state (hot|slept), lastActive."""
    return {
        "state": "slept" if member.slept else "hot",
        "lifecycle": member.lifecycle
        or ("ephemeral" if member.origin == "pr" else "retained"),
        "origin": member.origin_contract
        or (
            {
                "kind": "pull-request",
                **(
                    {"reference": str(member.pr_number)}
                    if member.pr_number is not None
                    else {}
                ),
            }
            if member.origin == "pr"
            else {"kind": "user"}
            if member.origin == "user"
            else None
        ),
        "legacyOrigin": member.origin,
        "prNumber": member.pr_number,
        "protected": member.protected,
        "expiresAt": member.expires_at.isoformat(timespec="seconds")
        if member.expires_at
        else None,
        "lastActive": member.last_active.isoformat(timespec="seconds")
        if member.last_active
        else None,
        "platformRevision": member.platform_revision,
        "sourceRevision": member.source_revision,
        "profile": member.profile,
        "lane": member.lane,
        "mode": member.mode,
        "owner": member.owner_contract
        or ({"kind": "user", "id": member.owner} if member.owner else None),
        "services": list(member.services) if member.services is not None else None,
        "provenance": member.provenance,
        "trustedCode": member.trusted_code,
        "allocation": member.allocation,
        "images": member.images,
        "catalogDigest": member.catalog_digest,
    }


def _compute_vcluster_previews(*, include_pool: bool = False) -> dict[str, Any]:
    """The list body. `include_pool=False` (the user list) hides pool plumbing —
    members whose effective pool state is baking/free/recycling (#29) — while still
    counting them; `include_pool=True` (admin/debug) lists EVERY member, with its raw
    id, its `poolState`, and null tailnetHost/url for unclaimed pool members (the
    per-claim wfb-<alias> LB only exists once a member is claimed)."""
    items: list[dict[str, Any]] = []
    counts = {
        "awake": 0,
        "slept": 0,
        "total": 0,
        "baking": 0,
        "free": 0,
        "claimed": 0,
        "recycling": 0,
    }
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
    # (its ns is vcluster-<real>); a baking/free/recycling member is a pool slot, hidden from
    # the user list but counted for capacity. A4: `awake` counts only HOT members — a slept
    # preview (control plane scaled down) holds no capacity, so it doesn't gate cold
    # provisions; `total` (and totalMax) count everything.
    # (member, display_name, host|None, pool_state)
    listed: list[tuple[PreviewMember, str, str | None, str | None]] = []
    for ns in nss.items:
        if _preview_ns_is_terminating(ns):
            continue
        member = _preview_member_from_ns(ns)
        pool_state = _member_effective_pool_state(member)
        counts["total"] += 1
        if member.slept:
            counts["slept"] += 1
        else:
            counts["awake"] += 1
        if pool_state in counts:
            counts[pool_state] += 1
        if pool_state in _POOL_HIDDEN_STATES:
            if not include_pool:
                continue  # a pool slot, not a user-facing preview (#29)
            # Admin view: raw member id, no user-facing URL (no per-claim LB yet).
            listed.append((member, member.real_name, None, pool_state))
            continue
        display_name = (
            member.alias
            if (pool_state == "claimed" and member.alias)
            else member.real_name
        )
        listed.append((member, display_name, f"wfb-{display_name}", pool_state))

    # Each _vcluster_preview_phase does 2 serial K8s reads (job status + pod list); probe them
    # concurrently keyed on the real member id — the k8s client pool is thread-safe for reads.
    # A slept member is not probed at all: its pods are DELIBERATELY gone, so the probe would
    # just read "provisioning" (misleading) at the cost of 2 API calls — report phase "slept".
    def _probe(
        entry: tuple[PreviewMember, str, str | None, str | None],
    ) -> tuple[PreviewMember, str, str | None, str | None, str]:
        member, display_name, host, pool_state = entry
        if member.slept:
            return member, display_name, host, pool_state, "slept"
        try:
            phase, _a, _s, _f = _vcluster_preview_phase(
                batch,
                core,
                member.real_name,
                request_timeout=_VCLUSTER_PREVIEW_PROBE_TIMEOUT,
            )
            return member, display_name, host, pool_state, phase
        except Exception as exc:
            logger.warning(
                "vcluster-previews: phase probe for %s failed: %s",
                member.real_name,
                exc,
            )
            return member, display_name, host, pool_state, "absent"

    probed: list[tuple[PreviewMember, str, str | None, str | None, str]] = []
    if listed:
        with ThreadPoolExecutor(max_workers=min(8, len(listed))) as pool:
            probed = list(pool.map(_probe, listed))

    for member, display_name, host, pool_state, phase in probed:
        if phase == "absent":
            continue
        item = {
            "name": display_name,
            "phase": phase,
            "ready": phase == "ready",
            "tailnetHost": host,
            "url": f"https://{host}.{_VCLUSTER_PREVIEW_TAILNET_SUFFIX}"
            if host
            else None,
            **_preview_lifecycle_fields(member),
        }
        if pool_state:
            item["poolState"] = (
                pool_state  # pool members only; absent on normal previews
            )
        if member.real_name != display_name:
            item["pool"] = (
                member.real_name
            )  # the backing member id for claimed previews
        items.append(item)
    return {"previews": items, "counts": counts}


# #32: single-flight for the list compute. Without it, every cache expiry (and every
# churn-driven _invalidate_previews_cache — claims/bakes/recycles fire constantly under
# pool churn) let EVERY concurrent poller (UI 8s poll + BFF replicas + D1 dispatch
# status polls, each on its own anyio worker thread) run a FULL _compute_vcluster_previews
# simultaneously: N duplicate namespace lists, N×8 probe threads, N sets of deserialized
# pod lists alive at once. Those synchronized allocation bursts are peak-RSS spikes that
# glibc never returns to the OS (arena free lists), ratcheting RSS toward the limit —
# the churn-window OOM shape. One caller computes; the rest briefly block and get the
# cache the winner just refreshed.
_vcluster_previews_compute_lock = threading.Lock()


def _cached_vcluster_previews() -> dict[str, Any] | None:
    with _vcluster_previews_cache_lock:
        cached = _vcluster_previews_cache
        if (
            _VCLUSTER_PREVIEWS_CACHE_TTL > 0
            and cached["data"] is not None
            and (time.monotonic() - cached["at"]) < _VCLUSTER_PREVIEWS_CACHE_TTL
        ):
            return cached["data"]
    return None


@app.get("/internal/vcluster-previews")
def list_vcluster_previews(
    request: Request, includePool: bool = False
) -> dict[str, Any]:
    _require_internal(request)
    # ?includePool=true (admin/debug, #29) bypasses the burst cache in BOTH directions:
    # it must never be served the user-list variant, and its result must never poison
    # the cache the user list reads.
    if includePool:
        return _compute_vcluster_previews(include_pool=True)
    cached = _cached_vcluster_previews()
    if cached is not None:
        return cached
    if _VCLUSTER_PREVIEWS_CACHE_TTL > 0:
        # Single-flight (only meaningful with the cache on; TTL=0 debug keeps the
        # old always-compute behavior).
        with _vcluster_previews_compute_lock:
            cached = _cached_vcluster_previews()
            if cached is not None:
                return cached  # the winner refreshed it while we waited
            result = _compute_vcluster_previews()
            with _vcluster_previews_cache_lock:
                _vcluster_previews_cache["at"] = time.monotonic()
                _vcluster_previews_cache["data"] = result
            return result

    result = _compute_vcluster_previews()

    with _vcluster_previews_cache_lock:
        _vcluster_previews_cache["at"] = time.monotonic()
        _vcluster_previews_cache["data"] = result
    return result


# ===========================================================================
# Retired A3 warm-vCluster implementation retained as a compatibility tombstone.
# `_vcluster_preview_pool_size()` is hard-disabled, the public architecture is
# cold-only, and profiled claim/bake requests fail before any mutation.
# ===========================================================================

# Read→compare-and-swap retry budget for a claim (a 409 = a concurrent claim won that member).
_VCLUSTER_PREVIEW_CLAIM_ATTEMPTS = int(
    os.environ.get("VCLUSTER_PREVIEW_CLAIM_ATTEMPTS", "6") or 6
)


def _bake_inputs_hash(core) -> str | None:
    """The bake-inputs signature a freshly baked member should carry as
    `vcluster-preview-bake-hash`.

    Contract with the runner: the runner mounts the `vcluster-preview-runner`
    ConfigMap at /config and computes `cat /config/* | sha256sum`. A ConfigMap key
    becomes one file in /config, and the shell glob sorts by filename, so `cat
    /config/*` is the concatenation of the VALUES of the sorted keys. We reproduce
    that exactly here: sha256 over the values of the sorted keys. The `template-db-pin`
    key, when the renderer includes it, is one of those keys and so participates in
    the hash automatically. Returns None if the ConfigMap can't be read (so the
    recycler never false-recycles on a transient API error)."""
    ns = _vcluster_preview_control_namespace()
    try:
        cm = core.read_namespaced_config_map(
            name="vcluster-preview-runner", namespace=ns
        )
    except Exception as exc:
        logger.warning(
            "pool: reading vcluster-preview-runner ConfigMap failed: %s", exc
        )
        return None
    data = dict(getattr(cm, "data", None) or {})
    if not data:
        return None
    payload = "".join(data[key] for key in sorted(data))
    return sha256(payload.encode("utf-8")).hexdigest()


def _pool_recycle_deadline_seconds() -> int:
    try:
        return int(
            os.environ.get("VCLUSTER_PREVIEW_POOL_RECYCLE_DEADLINE", "900") or 900
        )
    except (TypeError, ValueError):
        return 900


def _pool_recycle_retry_base_seconds() -> int:
    try:
        value = int(
            os.environ.get("VCLUSTER_PREVIEW_POOL_RECYCLE_RETRY_BASE_SECONDS", "60")
            or 60
        )
    except (TypeError, ValueError):
        value = 60
    return max(1, value)


def _pool_recycle_retry_max_seconds() -> int:
    try:
        value = int(
            os.environ.get("VCLUSTER_PREVIEW_POOL_RECYCLE_RETRY_MAX_SECONDS", "900")
            or 900
        )
    except (TypeError, ValueError):
        value = 900
    return max(_pool_recycle_retry_base_seconds(), value)


def _pool_recycle_max_attempts() -> int:
    try:
        value = int(
            os.environ.get("VCLUSTER_PREVIEW_POOL_RECYCLE_MAX_ATTEMPTS", "6") or 6
        )
    except (TypeError, ValueError):
        value = 6
    return max(1, value)


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


def _bake_hash_is_stale(
    *, member_hash: str | None, member_legacy_pins: str | None, want: str | None
) -> bool:
    """Pure staleness decision for a baked member (exhaustively unit-testable):
    * want is None (bake inputs unreadable) → never stale (no false-recycle);
    * member carries a bake-hash → stale iff it differs from `want`;
    * member has no bake-hash but has the LEGACY image-pins annotation → stale once
      (one-time turnover of pre-bake-hash members);
    * neither annotation → not a re-key candidate (leave it)."""
    if not want:
        return False
    if member_hash:
        return member_hash != want
    return bool(member_legacy_pins)


def _member_is_stale(core, real_name: str) -> bool:
    want = _bake_inputs_hash(core)
    if not want:
        return False
    try:
        ns = core.read_namespace(name=f"vcluster-{real_name}")
    except Exception:
        return False
    ann = (ns.metadata.annotations or {}) if ns.metadata else {}
    return _bake_hash_is_stale(
        member_hash=ann.get(_VCLUSTER_PREVIEW_BAKE_HASH_ANNOTATION),
        member_legacy_pins=ann.get(_VCLUSTER_PREVIEW_IMAGE_PINS_ANNOTATION),
        want=want,
    )


@dataclass(frozen=True)
class _PreviewClaimReservation:
    real_name: str
    operation_holder: str


def _claim_free_member(
    core,
    *,
    alias: str,
    claim_user: str,
    origin: str | None = None,
    lifecycle: str | None = None,
    owner_contract: PreviewEnvironmentOwnerRequest | None = None,
    origin_contract: PreviewEnvironmentOriginRequest | None = None,
    pr_number: int | None = None,
    ttl_hours: int | None = None,
    platform_revision: str | None = None,
    source_revision: str | None = None,
    profile: str | None = None,
    owner: str | None = None,
    catalog_digest: str | None = None,
    services: list[str] | None = None,
    provenance: dict[str, Any] | None = None,
    trusted_code: bool = False,
    coordination: Any | None = None,
    operation_namespace: str | None = None,
) -> str | _PreviewClaimReservation | None:
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
                if platform_revision:
                    annotations = (ns.metadata.annotations or {}) if ns.metadata else {}
                    actual = annotations.get(
                        _VCLUSTER_PREVIEW_PLATFORM_REVISION_ANNOTATION
                    )
                    if actual != platform_revision:
                        raise HTTPException(
                            status_code=409,
                            detail=(
                                f'preview alias "{alias}" already uses platform '
                                f"revision {actual or 'unknown'}; tear it down before "
                                f"launching {platform_revision}"
                            ),
                        )
                real_name = _preview_realname_from_ns(ns)
                if coordination is None:
                    return real_name
                holder = _acquire_preview_operation_lease(
                    coordination,
                    namespace=operation_namespace
                    or _vcluster_preview_control_namespace(),
                    real_name=real_name,
                )
                return _PreviewClaimReservation(real_name, holder)
    except HTTPException:
        raise
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
    operation_busy = False
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
            # A profiled warm claim may consume only a baseline baked from the
            # exact requested stacks commit. Legacy callers omit the revision
            # and retain the historical any-free-member behavior.
            and (
                not platform_revision
                or (
                    ((ns.metadata.annotations or {}) if ns.metadata else {}).get(
                        _VCLUSTER_PREVIEW_PLATFORM_REVISION_ANNOTATION
                    )
                    == platform_revision
                )
            )
        ]
        if not candidates:
            return None
        # Oldest first — drain aging members before freshly-baked ones.
        candidates.sort(
            key=lambda ns: ns.metadata.creation_timestamp or datetime.now(UTC)
        )
        for ns in candidates:
            real_name = _preview_realname_from_ns(ns)
            operation_holder: str | None = None
            if coordination is not None:
                try:
                    operation_holder = _acquire_preview_operation_lease(
                        coordination,
                        namespace=(
                            operation_namespace or _vcluster_preview_control_namespace()
                        ),
                        real_name=real_name,
                    )
                except HTTPException as exc:
                    if exc.status_code == status.HTTP_409_CONFLICT:
                        operation_busy = True
                        continue
                    raise
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
            if lifecycle in {"ephemeral", "retained"}:
                annotations[_VCLUSTER_PREVIEW_LIFECYCLE_ANNOTATION] = lifecycle
            if owner_contract is not None:
                annotations[_VCLUSTER_PREVIEW_OWNER_ANNOTATION] = json.dumps(
                    owner_contract.model_dump(), separators=(",", ":"), sort_keys=True
                )
            if origin_contract is not None:
                annotations[_VCLUSTER_PREVIEW_ORIGIN_ANNOTATION] = json.dumps(
                    origin_contract.model_dump(exclude_none=True),
                    separators=(",", ":"),
                    sort_keys=True,
                )
            if platform_revision:
                annotations[_VCLUSTER_PREVIEW_PLATFORM_REVISION_ANNOTATION] = (
                    platform_revision
                )
            if source_revision:
                annotations[_VCLUSTER_PREVIEW_SOURCE_REVISION_ANNOTATION] = (
                    source_revision
                )
            if profile:
                annotations[_VCLUSTER_PREVIEW_PROFILE_ANNOTATION] = profile
            if owner and owner_contract is None:
                annotations[_VCLUSTER_PREVIEW_OWNER_ANNOTATION] = owner
            if services is not None:
                annotations[_VCLUSTER_PREVIEW_SERVICES_ANNOTATION] = json.dumps(
                    services, separators=(",", ":")
                )
            if provenance is not None:
                annotations[_VCLUSTER_PREVIEW_PROVENANCE_ANNOTATION] = json.dumps(
                    provenance, separators=(",", ":"), sort_keys=True
                )
            if profile:
                annotations[_VCLUSTER_PREVIEW_TRUSTED_CODE_ANNOTATION] = (
                    "true" if trusted_code else "false"
                )
            if catalog_digest:
                annotations[_VCLUSTER_PREVIEW_CATALOG_DIGEST_ANNOTATION] = (
                    catalog_digest
                )
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
                if operation_holder is not None:
                    return _PreviewClaimReservation(real_name, operation_holder)
                return real_name
            except Exception as exc:
                if operation_holder is not None:
                    _release_preview_operation_lease(
                        coordination,
                        namespace=(
                            operation_namespace or _vcluster_preview_control_namespace()
                        ),
                        real_name=real_name,
                        holder=operation_holder,
                    )
                if getattr(exc, "status", None) == 409:
                    continue  # lost the race for this member; try another
                logger.warning("claim: replace %s failed: %s", meta.name, exc)
                continue
    if coordination is not None and operation_busy:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="warm-pool members currently have operations in progress",
        )
    return None


def _vcluster_claim_job_manifest(
    pool_name: str,
    alias: str,
    claim_user: str,
    *,
    namespace: str,
    request_body: VclusterPreviewClaimRequest | None = None,
    operation_holder: str | None = None,
) -> dict[str, Any]:
    """The ACTION=claim Job manifest. Reuses the up-Job's env defaulting (ENROLL_MODE/
    PREVIEW_DB_MODE/TARGET_REVISION/…) so the runner resolves the member's DB,
    then appends the claim-specific env. Image freshness is owned by the recycler (free members
    are recycled on bake-inputs drift), so a claim no longer re-authors images."""
    req = VclusterPreviewRequest(
        name=pool_name,
        action="claim",
        enrollMode=request_body.enrollMode if request_body else None,
        platformRevision=request_body.platformRevision if request_body else None,
        sourceRevision=request_body.sourceRevision if request_body else None,
        catalogDigest=request_body.catalogDigest if request_body else None,
        candidatePaths=request_body.candidatePaths if request_body else [],
        delivery=request_body.delivery if request_body else None,
        profile=request_body.profile if request_body else None,
        mode=request_body.mode if request_body else None,
        allocation=request_body.allocation if request_body else None,
        imageOverrides=request_body.imageOverrides if request_body else {},
        lifecycle=request_body.lifecycle if request_body else None,
        owner=request_body.owner if request_body else None,
        origin=request_body.origin if request_body else None,
        services=request_body.services if request_body else [],
        provenance=request_body.provenance if request_body else None,
        trustedCode=request_body.trustedCode if request_body else False,
        createOnly=request_body.createOnly if request_body else False,
        ttlHours=request_body.ttlHours if request_body else None,
        prNumber=request_body.prNumber if request_body else None,
    )
    manifest = _vcluster_preview_job_manifest(
        req, namespace=namespace, operation_holder=operation_holder
    )
    env = manifest["spec"]["template"]["spec"]["containers"][0]["env"]
    env.extend(
        [
            {"name": "POOL_NAME", "value": pool_name},
            {"name": "ALIAS", "value": alias},
            {"name": "CLAIM_USER", "value": claim_user},
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
    _validate_profiled_preview_claim_request(body)
    alias = _safe_resource_name(body.name, max_length=40)
    claim_user = (body.user or "unknown").strip() or "unknown"
    namespace = _vcluster_preview_control_namespace()
    tailnet_host = f"wfb-{alias}"
    url = f"https://{tailnet_host}.{_VCLUSTER_PREVIEW_TAILNET_SUFFIX}"
    if os.environ.get("SANDBOX_EXECUTION_DRY_RUN", "").lower() in {"1", "true", "yes"}:
        # No real vclusters in dry-run → behave as an empty pool (BFF cold-path also dry-runs).
        raise HTTPException(status_code=404, detail="warm pool unavailable (dry-run)")
    batch, core = _load_k8s_clients()
    coordination = _load_k8s_coordination_client()
    claim = _claim_free_member(
        core,
        alias=alias,
        claim_user=claim_user,
        origin=_legacy_preview_origin(body.origin),
        lifecycle=body.lifecycle,
        owner_contract=_preview_owner(body.owner),
        origin_contract=_preview_origin(body.origin),
        pr_number=body.prNumber,
        ttl_hours=body.ttlHours,
        platform_revision=body.platformRevision,
        source_revision=body.sourceRevision,
        profile=body.profile,
        owner=(
            _preview_owner(body.owner).id
            if _preview_owner(body.owner) is not None
            else body.owner
            if isinstance(body.owner, str)
            else None
        ),
        catalog_digest=body.catalogDigest,
        services=body.services,
        provenance=body.provenance,
        trusted_code=body.trustedCode,
        coordination=coordination,
        operation_namespace=namespace,
    )
    if not claim:
        raise HTTPException(
            status_code=404, detail="no free warm-pool member available"
        )
    if not isinstance(claim, _PreviewClaimReservation):
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="warm-pool claim did not reserve its preview operation Lease",
        )
    pool_name = claim.real_name
    operation_holder = claim.operation_holder
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
        try:
            member, _ = _resume_preview_with_capacity(
                batch,
                core,
                name=alias,
                namespace=namespace,
                operation_holder=operation_holder,
                coordination=coordination,
            )
        except Exception:
            _release_preview_operation_lease(
                coordination,
                namespace=namespace,
                real_name=pool_name,
                holder=operation_holder,
            )
            raise
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
    manifest = _vcluster_claim_job_manifest(
        pool_name,
        alias,
        claim_user,
        namespace=namespace,
        request_body=body,
        operation_holder=operation_holder,
    )
    try:
        _submit_preview_job(
            batch,
            core,
            namespace=namespace,
            manifest=manifest,
            lifecycle=(member.lifecycle if member is not None else body.lifecycle),
        )
    except Exception:
        _release_preview_operation_lease(
            coordination,
            namespace=namespace,
            real_name=pool_name,
            holder=operation_holder,
        )
        raise
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
        "platformRevision": body.platformRevision,
    }
    set_current_span_io("output", response)
    return response


@dataclass(frozen=True)
class _RecycleStartResult:
    marked: bool
    job_created: bool


def _recycle_attempt_from_ns(ns) -> int:
    annotations = (ns.metadata.annotations or {}) if ns.metadata else {}
    try:
        return max(
            0,
            int(annotations.get(_VCLUSTER_PREVIEW_RECYCLE_ATTEMPT_ANNOTATION, "0")),
        )
    except (TypeError, ValueError):
        return 0


def _recycle_error_text(value: Any) -> str:
    return " ".join(str(value).split())[:512]


def _patch_recycle_error(core, ns_name: str, real_name: str, error: str) -> None:
    try:
        core.patch_namespace(
            name=ns_name,
            body={
                "metadata": {
                    "annotations": {
                        _VCLUSTER_PREVIEW_RECYCLE_ERROR_ANNOTATION: _recycle_error_text(
                            error
                        )
                    }
                }
            },
        )
    except Exception as exc:
        logger.warning("pool: recycle error stamp %s failed: %s", real_name, exc)


def _launch_recycle_down_job(
    batch,
    core,
    ns,
    real_name: str,
    namespace: str,
    *,
    reason: str,
    operation_holder: str,
) -> bool:
    """Persist the next attempt before creating its Job. A failed create leaves the
    member non-claimable with enough durable state for a later SEA process to retry."""
    now = datetime.now(UTC).isoformat(timespec="seconds")
    annotations = (ns.metadata.annotations or {}) if ns.metadata else {}
    recycling_at = annotations.get(_VCLUSTER_PREVIEW_RECYCLING_AT_ANNOTATION) or now
    attempt = _recycle_attempt_from_ns(ns) + 1
    try:
        core.patch_namespace(
            name=ns.metadata.name,
            body={
                "metadata": {
                    "annotations": {
                        _VCLUSTER_PREVIEW_RECYCLING_AT_ANNOTATION: recycling_at,
                        _VCLUSTER_PREVIEW_RECYCLE_REASON_ANNOTATION: reason,
                        _VCLUSTER_PREVIEW_RECYCLE_ATTEMPT_ANNOTATION: str(attempt),
                        _VCLUSTER_PREVIEW_RECYCLE_LAST_ATTEMPT_ANNOTATION: now,
                        _VCLUSTER_PREVIEW_RECYCLE_ERROR_ANNOTATION: "",
                    }
                }
            },
        )
    except Exception as exc:
        error = f"attempt metadata update failed: {exc}"
        logger.warning("pool: recycle %s %s", real_name, error)
        _patch_recycle_error(core, ns.metadata.name, real_name, error)
        return False

    req = VclusterPreviewRequest(name=real_name, action="down")
    manifest = _vcluster_preview_job_manifest(
        req, namespace=namespace, operation_holder=operation_holder
    )
    manifest["spec"]["activeDeadlineSeconds"] = _pool_recycle_deadline_seconds()
    try:
        _submit_preview_job(
            batch,
            core,
            namespace=namespace,
            manifest=manifest,
            lifecycle=_preview_member_from_ns(ns).lifecycle,
        )
    except Exception as exc:
        error = f"down Job create failed: {exc}"
        logger.warning("pool: recycle %s %s", real_name, error)
        _patch_recycle_error(core, ns.metadata.name, real_name, error)
        return False
    return True


def _start_member_recycling(
    batch,
    core,
    ns,
    real_name: str,
    namespace: str,
    *,
    reason: str,
    operation_holder: str | None = None,
) -> _RecycleStartResult:
    """Atomically exclude a pool member from claims, then start bounded teardown."""
    coordination = _load_k8s_coordination_client()
    holder = operation_holder
    if holder is None:
        try:
            holder = _acquire_preview_operation_lease(
                coordination, namespace=namespace, real_name=real_name
            )
        except HTTPException as exc:
            if exc.status_code == status.HTTP_409_CONFLICT:
                return _RecycleStartResult(marked=False, job_created=False)
            raise
    handed_to_runner = False
    recycling_at = datetime.now(UTC).isoformat(timespec="seconds")
    try:
        core.patch_namespace(
            name=ns.metadata.name,
            body={
                "metadata": {
                    "labels": {_VCLUSTER_PREVIEW_POOL_LABEL: "recycling"},
                    "annotations": {
                        _VCLUSTER_PREVIEW_RECYCLING_AT_ANNOTATION: recycling_at,
                        _VCLUSTER_PREVIEW_RECYCLE_REASON_ANNOTATION: reason,
                        _VCLUSTER_PREVIEW_RECYCLE_ATTEMPT_ANNOTATION: "0",
                        _VCLUSTER_PREVIEW_RECYCLE_ERROR_ANNOTATION: "",
                    },
                }
            },
        )
    except Exception as exc:
        logger.warning("pool: recycle relabel %s failed: %s", real_name, exc)
        _release_preview_operation_lease(
            coordination,
            namespace=namespace,
            real_name=real_name,
            holder=holder,
        )
        return _RecycleStartResult(marked=False, job_created=False)
    created = _launch_recycle_down_job(
        batch,
        core,
        ns,
        real_name,
        namespace,
        reason=reason,
        operation_holder=holder,
    )
    handed_to_runner = created
    if not handed_to_runner:
        _release_preview_operation_lease(
            coordination,
            namespace=namespace,
            real_name=real_name,
            holder=holder,
        )
    return _RecycleStartResult(marked=True, job_created=created)


def _recycle_free_member(
    batch, core, ns, real_name: str, namespace: str
) -> _RecycleStartResult:
    """Recycle one bake-drifted free member. Exclusion always precedes teardown."""
    result = _start_member_recycling(
        batch,
        core,
        ns,
        real_name,
        namespace,
        reason="bake-drift",
    )
    if result.job_created:
        logger.info("pool: recycling stale member %s (bake drift)", real_name)
    return result


# ===========================================================================
# A4 lifecycle: touch/last-active, sleep/resume, TTL teardown, capacity
# eviction. All flag-gated (VCLUSTER_PREVIEW_SLEEP_AFTER_MINUTES /
# VCLUSTER_PREVIEW_TTL_HOURS / VCLUSTER_PREVIEW_TOTAL_MAX default 0 = OFF): with
# the flags at 0 no reaper thread starts and a reap pass only honors EXPLICIT
# per-preview expires-at markers — merging this is inert for the live fleet.
# ===========================================================================


def _lifecycle_job(
    batch,
    core,
    member: PreviewMember,
    namespace: str,
    action: str,
    *,
    operation_holder: str | None = None,
) -> bool:
    """Create a sleep/resume Job for a member (the runner is the mechanism; SEA only
    decides). Returns False (logged) on failure — callers revert their label flip."""
    req = VclusterPreviewRequest(name=member.real_name, action=action)
    manifest = _vcluster_preview_job_manifest(
        req, namespace=namespace, operation_holder=operation_holder
    )
    try:
        _submit_preview_job(
            batch,
            core,
            namespace=namespace,
            manifest=manifest,
            lifecycle=member.lifecycle,
        )
    except Exception as exc:
        logger.warning(
            "lifecycle: %s job for %s failed: %s", action, member.real_name, exc
        )
        return False
    return True


def _sleep_member(
    batch,
    core,
    member: PreviewMember,
    namespace: str,
    *,
    operation_holder: str | None = None,
) -> bool:
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
                    "annotations": {_VCLUSTER_PREVIEW_SLEPT_AT_ANNOTATION: slept_at},
                }
            },
        )
    except Exception as exc:
        logger.warning("lifecycle: sleep relabel %s failed: %s", member.real_name, exc)
        return False
    if not _lifecycle_job(
        batch,
        core,
        member,
        namespace,
        "sleep",
        operation_holder=operation_holder,
    ):
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


def _sleep_member_with_operation_lease(
    batch, core, member: PreviewMember, namespace: str
) -> bool:
    coordination = _load_k8s_coordination_client()
    try:
        holder = _acquire_preview_operation_lease(
            coordination, namespace=namespace, real_name=member.real_name
        )
    except HTTPException as exc:
        if exc.status_code == status.HTTP_409_CONFLICT:
            return False
        raise
    handed_to_runner = False
    try:
        current = _read_preview_member(core, member.real_name)
        if (
            current.slept
            or current.protected
            or current.pool_state in ("free", "recycling")
        ):
            return False
        handed_to_runner = _sleep_member(
            batch,
            core,
            current,
            namespace,
            operation_holder=holder,
        )
        return handed_to_runner
    finally:
        if not handed_to_runner:
            _release_preview_operation_lease(
                coordination,
                namespace=namespace,
                real_name=member.real_name,
                holder=holder,
            )


def _resume_member(
    batch,
    core,
    member: PreviewMember,
    namespace: str,
    *,
    operation_holder: str | None = None,
) -> bool:
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
                    "annotations": {_VCLUSTER_PREVIEW_LAST_ACTIVE_ANNOTATION: now_iso},
                }
            },
        )
    except Exception as exc:
        logger.warning("lifecycle: resume relabel %s failed: %s", member.real_name, exc)
    if not _lifecycle_job(
        batch,
        core,
        member,
        namespace,
        "resume",
        operation_holder=operation_holder,
    ):
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
    if _preview_member_is_controller_owned(member):
        logger.info(
            "lifecycle: deferring controller-owned preview %s (%s) to application reaper",
            member.real_name,
            reason,
        )
        return False
    if _preview_member_requires_archive_teardown(member):
        logger.info(
            "lifecycle: refusing unarchived mutable live teardown for %s (%s)",
            member.real_name,
            reason,
        )
        return False
    if member.pool_state == "recycling":
        # The pool recovery reconciler owns retries and backoff after the initial
        # transition. The lifecycle reaper must not create an untracked parallel Job.
        return False
    if member.pool_state in ("free", "claimed"):
        try:
            ns = core.read_namespace(name=member.ns_name)
        except Exception as exc:
            logger.warning(
                "lifecycle: recycle read %s failed: %s", member.real_name, exc
            )
            return False
        result = _start_member_recycling(
            batch,
            core,
            ns,
            member.real_name,
            namespace,
            reason=reason,
        )
        if not result.job_created:
            logger.warning(
                "lifecycle: recycle start %s failed (%s)", member.real_name, reason
            )
        return result.job_created
    coordination = _load_k8s_coordination_client()
    try:
        operation_holder = _acquire_preview_operation_lease(
            coordination, namespace=namespace, real_name=member.real_name
        )
    except HTTPException as exc:
        if exc.status_code == status.HTTP_409_CONFLICT:
            return False
        raise
    req = VclusterPreviewRequest(name=member.real_name, action="down")
    manifest = _vcluster_preview_job_manifest(
        req, namespace=namespace, operation_holder=operation_holder
    )
    manifest["spec"]["activeDeadlineSeconds"] = _pool_recycle_deadline_seconds()
    try:
        _submit_preview_job(
            batch,
            core,
            namespace=namespace,
            manifest=manifest,
            lifecycle=member.lifecycle,
        )
    except Exception as exc:
        logger.warning("lifecycle: reap down-job %s failed: %s", member.real_name, exc)
        _release_preview_operation_lease(
            coordination,
            namespace=namespace,
            real_name=member.real_name,
            holder=operation_holder,
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
      1. TTL handling  — members past their effective expiry (explicit expires-at always;
                         creation+VCLUSTER_PREVIEW_TTL_HOURS only when that flag is on)
      2. capacity      — evict (via the PURE selector) down to VCLUSTER_PREVIEW_TOTAL_MAX,
                         plus any explicit need_room the caller asked for
      3. sleep         — activity-tracked members idle past VCLUSTER_PREVIEW_SLEEP_AFTER_MINUTES
                         (free/recycling pool members and untracked previews are exempt)
    Profiled trusted cold environments are never directly torn down here; the
    application reaper must delete/finalize hub desired state first. HARD RULES
    enforced here + in the selector: only namespaces labeled app=vcluster-preview
    are considered; protected members are never touched; members with an in-flight
    down/sleep/resume Job are skipped for the tick. Returns a stats dict."""
    stats = {
        "total": 0,
        "awake": 0,
        "slept": 0,
        "reapedExpired": 0,
        "evicted": 0,
        "sleptNow": 0,
        "archiveRequired": 0,
        "applicationReaperRequired": 0,
    }
    namespace = _vcluster_preview_control_namespace()
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
    archive_blocked: set[str] = set()
    application_blocked: set[str] = set()

    def defer_mutable_live(member: PreviewMember, *, reason: str) -> None:
        archive_blocked.add(member.real_name)
        stats["archiveRequired"] += 1
        if not member.slept and _sleep_member_with_operation_lease(
            batch, core, member, namespace
        ):
            stats["sleptNow"] += 1
        logger.info(
            "lifecycle: mutable live preview %s requires archive before %s teardown",
            member.real_name,
            reason,
        )

    def defer_controller_owned(member: PreviewMember, *, reason: str) -> None:
        application_blocked.add(member.real_name)
        stats["applicationReaperRequired"] += 1
        if _preview_member_requires_archive_teardown(member):
            defer_mutable_live(member, reason=reason)
            return
        logger.info(
            "lifecycle: controller-owned preview %s awaits application reaper (%s)",
            member.real_name,
            reason,
        )

    # 1) TTL teardown.
    for m in live:
        if m.protected or m.real_name in in_flight:
            continue
        if _member_is_expired(m, now=now, ttl_hours=ttl_hours):
            if _preview_member_is_controller_owned(m):
                defer_controller_owned(m, reason="ttl-expired")
                continue
            if _preview_member_requires_archive_teardown(m):
                defer_mutable_live(m, reason="ttl-expired")
                continue
            if _reap_teardown_member(batch, core, m, namespace, reason="ttl-expired"):
                stats["reapedExpired"] += 1
                reaped.add(m.real_name)

    # 2) Capacity eviction: TOTAL_MAX overflow + explicit need_room (both via the pure
    # selector, so the locked eviction order is the ONLY order).
    remaining = [
        m
        for m in live
        if m.real_name not in reaped
        and m.real_name not in archive_blocked
        and m.real_name not in application_blocked
        and m.real_name not in in_flight
    ]
    overflow = (len(remaining) - total_max) if total_max > 0 else 0
    need = max(0, overflow) + max(0, need_room)
    if need > 0:
        for m in _select_preview_evictions(
            remaining,
            need=len(remaining),
            pool_size=pool_size,
            now=now,
            ttl_hours=ttl_hours,
            active_minutes=active_minutes,
        ):
            if stats["evicted"] >= need:
                break
            if _preview_member_is_controller_owned(m):
                defer_controller_owned(m, reason="capacity")
                continue
            if _preview_member_requires_archive_teardown(m):
                defer_mutable_live(m, reason="capacity")
                continue
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
            if (
                m.real_name in reaped
                or m.real_name in archive_blocked
                or m.real_name in application_blocked
                or m.real_name in in_flight
            ):
                continue
            if m.protected or m.slept or m.terminating:
                continue
            if m.pool_state in ("free", "recycling"):
                continue
            if m.last_active is None:
                continue
            if now - m.last_active >= idle:
                if _sleep_member_with_operation_lease(batch, core, m, namespace):
                    stats["sleptNow"] += 1

    if stats["reapedExpired"] or stats["evicted"] or stats["sleptNow"]:
        _invalidate_previews_cache()
    return stats


_lifecycle_reaper_started = False
_lifecycle_reaper_lock = threading.Lock()


def _lifecycle_enabled() -> bool:
    if _env_flag_enabled("PREVIEW_HOST_RUNTIMES_DISABLED"):
        return False
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


def _recycle_retry_delay_seconds(attempt: int) -> int:
    base = _pool_recycle_retry_base_seconds()
    maximum = _pool_recycle_retry_max_seconds()
    exponent = min(20, max(0, attempt - 1))
    return min(maximum, base * (2**exponent))


def _recycle_job_phase(job) -> str:
    status_obj = getattr(job, "status", None)
    if int(getattr(status_obj, "active", 0) or 0) > 0:
        return "active"
    if int(getattr(status_obj, "failed", 0) or 0) > 0:
        return "failed"
    if int(getattr(status_obj, "succeeded", 0) or 0) > 0:
        return "succeeded"
    conditions = getattr(status_obj, "conditions", None) or []
    for condition in conditions:
        if str(getattr(condition, "status", "")).lower() != "true":
            continue
        if getattr(condition, "type", "") == "Failed":
            return "failed"
        if getattr(condition, "type", "") == "Complete":
            return "succeeded"
    # A just-created Job can have all counters at zero. It is still in flight and
    # must not be replaced by another reconcile tick.
    return "active"


def _recycle_down_jobs(batch, namespace: str) -> dict[str, list[Any]]:
    jobs = batch.list_namespaced_job(
        namespace=namespace, label_selector="vcluster-preview-action=down"
    )
    by_member: dict[str, list[Any]] = {}
    for job in jobs.items:
        metadata = getattr(job, "metadata", None)
        labels = getattr(metadata, "labels", None) or {}
        real_name = labels.get(_VCLUSTER_PREVIEW_NAME_LABEL)
        if labels.get("vcluster-preview-action") != "down" or not real_name:
            continue
        by_member.setdefault(real_name, []).append(job)
    return by_member


def _recycle_jobs_phase(jobs: list[Any]) -> str:
    phases = {_recycle_job_phase(job) for job in jobs}
    if "active" in phases:
        return "active"
    if "succeeded" in phases:
        return "succeeded"
    return "failed"


def _ensure_recycling_metadata(
    core, ns, now: datetime
) -> tuple[str, int, datetime | None] | None:
    annotations = (ns.metadata.annotations or {}) if ns.metadata else {}
    reason = annotations.get(_VCLUSTER_PREVIEW_RECYCLE_REASON_ANNOTATION) or "recovery"
    attempt = _recycle_attempt_from_ns(ns)
    last_attempt = _parse_rfc3339(
        annotations.get(_VCLUSTER_PREVIEW_RECYCLE_LAST_ATTEMPT_ANNOTATION)
    )
    recycling_at = annotations.get(_VCLUSTER_PREVIEW_RECYCLING_AT_ANNOTATION)
    if not recycling_at:
        created = getattr(ns.metadata, "creation_timestamp", None)
        if created is not None and created.tzinfo is None:
            created = created.replace(tzinfo=UTC)
        recycling_at = (created or now).isoformat(timespec="seconds")

    required = {
        _VCLUSTER_PREVIEW_RECYCLING_AT_ANNOTATION: recycling_at,
        _VCLUSTER_PREVIEW_RECYCLE_REASON_ANNOTATION: reason,
        _VCLUSTER_PREVIEW_RECYCLE_ATTEMPT_ANNOTATION: str(attempt),
        _VCLUSTER_PREVIEW_RECYCLE_ERROR_ANNOTATION: annotations.get(
            _VCLUSTER_PREVIEW_RECYCLE_ERROR_ANNOTATION, ""
        ),
    }
    if any(annotations.get(key) != value for key, value in required.items()):
        try:
            core.patch_namespace(
                name=ns.metadata.name,
                body={"metadata": {"annotations": required}},
            )
        except Exception as exc:
            logger.warning(
                "pool: recycling metadata repair %s failed: %s",
                _preview_realname_from_ns(ns),
                exc,
            )
            return None
    return reason, attempt, last_attempt


def _reconcile_recycling_members(
    batch, core, members: list[Any], namespace: str
) -> dict[str, int]:
    """Recover recycling members after SEA restarts, failed Job creation, or terminal
    teardown Jobs. Members stay non-claimable for the entire retry lifecycle."""
    stats = {
        "recycling": len(members),
        "recoveryRetried": 0,
        "recoveryActive": 0,
        "recoveryWaiting": 0,
        "recoveryBackoff": 0,
        "recoveryExhausted": 0,
        "recoveryFailed": 0,
        "recoveryScanFailed": 0,
    }
    if not members:
        return stats
    try:
        jobs_by_member = _recycle_down_jobs(batch, namespace)
    except Exception as exc:
        logger.warning("pool: recycle recovery Job scan failed: %s", exc)
        stats["recoveryScanFailed"] = 1
        return stats

    now = datetime.now(UTC)
    max_attempts = _pool_recycle_max_attempts()
    for ns in members:
        real_name = _preview_realname_from_ns(ns)
        repaired = _ensure_recycling_metadata(core, ns, now)
        if repaired is None:
            stats["recoveryFailed"] += 1
            continue
        reason, attempt, last_attempt = repaired
        jobs = jobs_by_member.get(real_name, [])
        phase = _recycle_jobs_phase(jobs) if jobs else "absent"
        if phase == "active":
            stats["recoveryActive"] += 1
            continue
        if phase == "succeeded":
            # Namespace deletion can trail Job completion. If teardown did not
            # actually remove it, Job TTL eventually makes it absent and retryable.
            stats["recoveryWaiting"] += 1
            continue

        trigger = "terminal down Job" if phase == "failed" else "missing down Job"
        if attempt >= max_attempts:
            error = f"retry limit reached after {attempt} attempts ({trigger})"
            _patch_recycle_error(core, ns.metadata.name, real_name, error)
            stats["recoveryExhausted"] += 1
            continue
        if last_attempt is not None:
            retry_at = last_attempt + timedelta(
                seconds=_recycle_retry_delay_seconds(attempt)
            )
            if now < retry_at:
                _patch_recycle_error(core, ns.metadata.name, real_name, trigger)
                stats["recoveryBackoff"] += 1
                continue

        coordination = _load_k8s_coordination_client()
        try:
            operation_holder = _acquire_preview_operation_lease(
                coordination, namespace=namespace, real_name=real_name
            )
        except HTTPException as exc:
            if exc.status_code == status.HTTP_409_CONFLICT:
                stats["recoveryActive"] += 1
                continue
            raise
        retried = _launch_recycle_down_job(
            batch,
            core,
            ns,
            real_name,
            namespace,
            reason=reason,
            operation_holder=operation_holder,
        )
        if retried:
            logger.info(
                "pool: recycle recovery retried %s after %s", real_name, trigger
            )
            stats["recoveryRetried"] += 1
        else:
            _release_preview_operation_lease(
                coordination,
                namespace=namespace,
                real_name=real_name,
                holder=operation_holder,
            )
            stats["recoveryFailed"] += 1
    return stats


def _pool_reconcile_once(batch, core, apps) -> dict[str, int]:
    """One reconcile pass: recycle pin-drifted free members, then top the pool up toward
    VCLUSTER_PREVIEW_POOL_SIZE — bounded by VCLUSTER_PREVIEW_MAX awake and the per-tick fill
    batch. Returns a small stats dict (used by tests)."""
    stats = {
        "awake": 0,
        "free": 0,
        "baking": 0,
        "created": 0,
        "recycled": 0,
        "recycling": 0,
        "recoveryRetried": 0,
        "recoveryActive": 0,
        "recoveryWaiting": 0,
        "recoveryBackoff": 0,
        "recoveryExhausted": 0,
        "recoveryFailed": 0,
        "recoveryScanFailed": 0,
    }
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
    namespace = _vcluster_preview_control_namespace()

    nss = core.list_namespace(label_selector="app=vcluster-preview")
    free_members = []
    recycling_members = []
    existing_names: set[str] = set()
    awake = 0
    free = 0
    for ns in nss.items:
        if _preview_ns_is_terminating(ns):
            continue
        labels = (ns.metadata.labels or {}) if ns.metadata else {}
        real_name = labels.get(_VCLUSTER_PREVIEW_NAME_LABEL)
        if real_name:
            existing_names.add(real_name)
        # A4: a SLEPT preview holds no compute — it doesn't count against the awake cap,
        # so the pool can keep filling while user previews sleep. (A slept FREE member —
        # manual force-sleep only — still counts as free to avoid an overshoot when it
        # wakes; claims skip it.)
        if labels.get(_VCLUSTER_PREVIEW_STATE_LABEL) != "slept":
            awake += 1
        pool_state = labels.get(_VCLUSTER_PREVIEW_POOL_LABEL)
        if pool_state == "free":
            free += 1
            free_members.append(ns)
        elif pool_state == "recycling":
            recycling_members.append(ns)

    stats.update(
        _reconcile_recycling_members(batch, core, recycling_members, namespace)
    )

    recycled = 0
    if recycle_on and free_members:
        want_hash = _bake_inputs_hash(core)
        if want_hash:
            for ns in free_members:
                ann = (ns.metadata.annotations or {}) if ns.metadata else {}
                if _bake_hash_is_stale(
                    member_hash=ann.get(_VCLUSTER_PREVIEW_BAKE_HASH_ANNOTATION),
                    member_legacy_pins=ann.get(_VCLUSTER_PREVIEW_IMAGE_PINS_ANNOTATION),
                    want=want_hash,
                ):
                    real_name = _preview_realname_from_ns(ns)
                    result = _recycle_free_member(batch, core, ns, real_name, namespace)
                    if result.marked:
                        recycled += 1
                        free -= (
                            1  # no longer claimable (relabeled recycling); still awake
                        )
                        stats["recycling"] += 1
                        if not result.job_created:
                            stats["recoveryFailed"] += 1

    # In-flight bakes: pool up-Jobs still Running. A baking member is counted in `awake` but NOT
    # in `free` (the free label lands only at the END of its ~277s bringup), so without counting
    # these the fill below would relaunch a redundant bake every reconcile tick during that window
    # and overshoot pool_size (task #33). Keying on the Job's `active` status (not a namespace
    # label) is the robust signal: it survives an SEA restart (the Job persists, so a fresh pool
    # manager still sees the in-flight bake) and self-clears on a failed bake (a labelless
    # half-baked namespace would otherwise count as in-flight forever → permanent under-fill).
    baking = 0
    pending_names: set[str] = set()
    try:
        jobs = batch.list_namespaced_job(
            namespace=namespace, label_selector="vcluster-preview-action=up"
        )
        for j in jobs.items:
            jname = (j.metadata.name or "") if j.metadata else ""
            if (
                jname.startswith("vcpreview-up-pool-")
                and int(getattr(j.status, "active", 0) or 0) > 0
            ):
                baking += 1
                labels = getattr(getattr(j, "metadata", None), "labels", None) or {}
                pending_name = labels.get(_VCLUSTER_PREVIEW_NAME_LABEL)
                if pending_name:
                    pending_names.add(pending_name)
    except Exception as exc:
        # Fail-open toward the pre-#33 behavior (may overshoot, never under-fill).
        logger.warning("pool: in-flight bake count failed: %s", exc)
        baking = 0

    # Fill: aim for pool_size free members, counting in-flight bakes so we don't over-provision;
    # never past max_awake, and at most fill_batch per tick (bounds the IO/enrollment burst).
    pending_without_namespace = pending_names - existing_names
    awake += len(pending_without_namespace)
    total = len(existing_names | pending_names)
    need = pool_size - (free + baking)
    room = max_awake - awake
    total_max = _vcluster_preview_total_max()
    if total_max > 0:
        room = min(room, total_max - total)
    to_create = max(0, min(need, room, fill_batch))
    created = 0
    for _ in range(to_create):
        name = f"pool-{secrets.token_hex(2)}"
        req = VclusterPreviewRequest(name=name, action="up", pool=True)
        coordination = _load_k8s_coordination_client()
        operation_holder: str | None = None
        handed_to_runner = False
        try:
            operation_holder = _acquire_preview_operation_lease(
                coordination, namespace=namespace, real_name=name
            )
            manifest = _vcluster_preview_job_manifest(
                req,
                namespace=namespace,
                operation_holder=operation_holder,
            )
            _submit_preview_job(
                batch,
                core,
                namespace=namespace,
                manifest=manifest,
                lifecycle="ephemeral",
            )
            handed_to_runner = True
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
        finally:
            if operation_holder is not None and not handed_to_runner:
                _release_preview_operation_lease(
                    coordination,
                    namespace=namespace,
                    real_name=name,
                    holder=operation_holder,
                )

    if created or recycled or stats["recoveryRetried"]:
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
            coordination = _load_k8s_coordination_client()
            with _preview_capacity_lease(
                coordination, namespace=_vcluster_preview_control_namespace()
            ):
                stats = _pool_reconcile_once(batch, core, apps)
            if (
                stats["recoveryFailed"]
                or stats["recoveryExhausted"]
                or stats["recoveryScanFailed"]
            ):
                logger.warning("pool-manager: recycle recovery stats=%s", stats)
            elif stats["recoveryRetried"]:
                logger.info("pool-manager: recycle recovery stats=%s", stats)
        except Exception as exc:
            logger.warning("pool-manager: reconcile failed: %s", exc)
        time.sleep(interval)


def _start_pool_manager() -> None:
    """Start the local pool loop iff enabled; the cluster Lease serializes all replicas."""
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

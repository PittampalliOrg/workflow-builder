"""agent-runtime-controller — kopf operator that reconciles AgentRuntime CRs
into Deployments running the dapr-agent-py-sandbox image. The CR can describe
either a dedicated per-agent runtime or a shared runtime-class pool. Dedicated
runtimes usually scale 0 <-> 1; pools may keep minReplicas warm and wake to
maxReplicas for capacity.

Lifecycle:
  - CR create  -> Deployment at minReplicas, status.phase=Sleeping/Starting
  - annotation agents.x-k8s.io/wake=<ts> -> scale to wake capacity, wait
    ready, status.phase=Active
  - idle check (every 60s): if lastActiveAt older than spec.lifecycle.
    idleTtlSeconds, scale back to minReplicas, status.phase=Sleeping/Starting

Pod annotations dapr.io/enabled / dapr.io/app-id are injected by the
openshell-sandbox-dapr-webhook (extended in this same change) — we only
set the label agents.x-k8s.io/role=agent-runtime so the webhook matches.
"""
from __future__ import annotations

import datetime as _dt
import json
import logging
import os
from typing import Any

import kopf
from kubernetes import client, config

LOGGER = logging.getLogger("agent-runtime-controller")
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")

GROUP = "agents.x-k8s.io"
VERSION = "v1alpha1"
PLURAL = "agentruntimes"
DAPR_GROUP = "dapr.io"
DAPR_VERSION = "v1alpha1"
DAPR_COMPONENT_PLURAL = "components"

LABEL_ROLE = "agents.x-k8s.io/role"
LABEL_SLUG = "agents.x-k8s.io/slug"
LABEL_APP_ID = "agents.x-k8s.io/app-id"
LABEL_RUNTIME_CLASS = "agents.x-k8s.io/runtime-class"
LABEL_RUNTIME_ISOLATION = "agents.x-k8s.io/runtime-isolation"
ANNO_APP_ID = LABEL_APP_ID
ANNO_WAKE = "agents.x-k8s.io/wake"
ANNO_SLEEP = "agents.x-k8s.io/sleep"
ANNO_LAST_ACTIVE = "agents.x-k8s.io/last-active"

DEFAULT_IDLE_TTL = 1800
IDLE_CHECK_INTERVAL = 60

DEFAULT_NAMESPACE = os.environ.get("CONTROLLER_NAMESPACE", "workflow-builder")
DEFAULT_SA = os.environ.get("AGENT_RUNTIME_SERVICE_ACCOUNT", "agent-runtime")
DEFAULT_OPENSHELL_GATEWAY_NAME = os.environ.get(
    "OPENSHELL_GATEWAY_NAME",
    "ryzen-internal",
)
AGENT_STATESTORE_COMPONENT = os.environ.get(
    "AGENT_RUNTIME_STATESTORE_COMPONENT",
    "dapr-agent-py-statestore",
)

# modelSpec -> Dapr conversation component. Mirrors
# services/dapr-agent-py/src/effective_agent_config.py:MODEL_COMPONENT_MAP so
# DAPR_LLM_COMPONENT_DEFAULT lines up with the agent's model when the workflow
# omits modelSpec at session-spawn. Default falls back to llm-anthropic-opus
# only when the AgentRuntime CR has no modelSpec.
MODEL_COMPONENT_MAP: dict[str, str] = {
    "anthropic/claude-sonnet-4-6": "llm-anthropic-sonnet",
    "anthropic/claude-opus-4-7": "llm-anthropic-opus",
    "anthropic/claude-opus-4-6": "llm-anthropic-opus",
    "anthropic/claude-haiku-4-5-20251001": "llm-anthropic-haiku",
    "anthropic/claude-haiku-4-5": "llm-anthropic-haiku",
    "claude-sonnet-4-6": "llm-anthropic-sonnet",
    "claude-opus-4-7": "llm-anthropic-opus",
    "claude-opus-4-6": "llm-anthropic-opus",
    "claude-haiku-4-5-20251001": "llm-anthropic-haiku",
    "claude-haiku-4-5": "llm-anthropic-haiku",
    "openai/gpt-5.4": "llm-openai-gpt5",
    "gpt-5.4": "llm-openai-gpt5",
    "openai/o3": "llm-openai-o3",
    "o3": "llm-openai-o3",
    "nvidia/meta/llama-3.1-8b-instruct": "llm-nvidia-llama31-8b",
    "meta/llama-3.1-8b-instruct": "llm-nvidia-llama31-8b",
    "nvidia/mistralai/mistral-medium-3.5-128b": "llm-nvidia-mistral-medium-35-128b",
    "mistralai/mistral-medium-3.5-128b": "llm-nvidia-mistral-medium-35-128b",
    "nvidia/qwen/qwen3-coder-480b-a35b-instruct": "llm-nvidia-qwen3-coder-480b",
    "qwen/qwen3-coder-480b-a35b-instruct": "llm-nvidia-qwen3-coder-480b",
    "nvidia/mistralai/devstral-2-123b-instruct-2512": "llm-nvidia-devstral-2-123b",
    "mistralai/devstral-2-123b-instruct-2512": "llm-nvidia-devstral-2-123b",
    "nvidia/moonshotai/kimi-k2-thinking": "llm-nvidia-kimi-k2-thinking",
    "moonshotai/kimi-k2-thinking": "llm-nvidia-kimi-k2-thinking",
    "nvidia/moonshotai/kimi-k2-instruct-0905": "llm-nvidia-kimi-k2-0905",
    "moonshotai/kimi-k2-instruct-0905": "llm-nvidia-kimi-k2-0905",
    "nvidia/z-ai/glm4.7": "llm-nvidia-glm47",
    "z-ai/glm4.7": "llm-nvidia-glm47",
    "foundry/DeepSeek-V4-Flash": "llm-foundry-deepseek-v4-flash",
    "DeepSeek-V4-Flash": "llm-foundry-deepseek-v4-flash",
    "foundry/Kimi-K2.6": "llm-foundry-kimi-k26",
    "Kimi-K2.6": "llm-foundry-kimi-k26",
    "together/zai-org/GLM-5.1": "llm-together-glm-51",
    "zai-org/GLM-5.1": "llm-together-glm-51",
    "GLM-5.1": "llm-together-glm-51",
    "glm-5.1": "llm-together-glm-51",
    "together/Qwen/Qwen3-Coder-480B-A35B-Instruct-FP8": "llm-together-qwen3-coder-480b",
    "Qwen/Qwen3-Coder-480B-A35B-Instruct-FP8": "llm-together-qwen3-coder-480b",
    "qwen3-coder-480b-a35b-instruct-fp8": "llm-together-qwen3-coder-480b",
    "together/deepseek-ai/DeepSeek-V4-Pro": "llm-together-deepseek-v4-pro",
    "deepseek-ai/DeepSeek-V4-Pro": "llm-together-deepseek-v4-pro",
    "DeepSeek-V4-Pro": "llm-together-deepseek-v4-pro",
    "deepseek-v4-pro": "llm-together-deepseek-v4-pro",
    "googleai/gemini-3.1-pro-preview": "llm-google-gemini",
    "google/gemini-3.1-pro-preview": "llm-google-gemini",
    "gemini-3.1-pro-preview": "llm-google-gemini",
    "deepseek/default": "llm-deepseek",
    "huggingface/meta-llama/Meta-Llama-3-8B": "llm-huggingface-llama3",
    "meta-llama/Meta-Llama-3-8B": "llm-huggingface-llama3",
    "mistral/open-mistral-7b": "llm-mistral-open",
    "open-mistral-7b": "llm-mistral-open",
    "echo/local": "llm-echo",
}
DEFAULT_LLM_COMPONENT = "llm-anthropic-opus"

COMPONENT_PROVIDER_MAP: dict[str, tuple[str, str]] = {
    "llm-anthropic-sonnet": ("anthropic", "claude-sonnet-4-6"),
    "llm-anthropic-opus": ("anthropic", "claude-opus-4-7"),
    "llm-anthropic-haiku": ("anthropic", "claude-haiku-4-5-20251001"),
    "llm-openai-gpt5": ("openai", "gpt-5.4"),
    "llm-openai-o3": ("openai", "o3"),
    "llm-nvidia-llama31-8b": ("nvidia", "meta/llama-3.1-8b-instruct"),
    "llm-nvidia-mistral-medium-35-128b": (
        "nvidia",
        "mistralai/mistral-medium-3.5-128b",
    ),
    "llm-nvidia-qwen3-coder-480b": (
        "nvidia",
        "qwen/qwen3-coder-480b-a35b-instruct",
    ),
    "llm-nvidia-devstral-2-123b": (
        "nvidia",
        "mistralai/devstral-2-123b-instruct-2512",
    ),
    "llm-nvidia-kimi-k2-thinking": ("nvidia", "moonshotai/kimi-k2-thinking"),
    "llm-nvidia-kimi-k2-0905": ("nvidia", "moonshotai/kimi-k2-instruct-0905"),
    "llm-nvidia-glm47": ("nvidia", "z-ai/glm4.7"),
    "llm-foundry-deepseek-v4-flash": ("foundry", "DeepSeek-V4-Flash"),
    "llm-foundry-kimi-k26": ("foundry", "Kimi-K2.6"),
    "llm-together-glm-51": ("together", "zai-org/GLM-5.1"),
    "llm-together-qwen3-coder-480b": (
        "together",
        "Qwen/Qwen3-Coder-480B-A35B-Instruct-FP8",
    ),
    "llm-together-deepseek-v4-pro": ("together", "deepseek-ai/DeepSeek-V4-Pro"),
    "llm-google-gemini": ("googleai", "gemini-3.1-pro-preview"),
    "llm-deepseek": ("deepseek", "default"),
    "llm-huggingface-llama3": ("huggingface", "meta-llama/Meta-Llama-3-8B"),
    "llm-mistral-open": ("mistral", "open-mistral-7b"),
    "llm-echo": ("echo", "local"),
}


def _resolve_llm_component(model_spec: str | None) -> str:
    if not model_spec or not str(model_spec).strip():
        return DEFAULT_LLM_COMPONENT
    normalized = str(model_spec).strip()
    component = MODEL_COMPONENT_MAP.get(normalized)
    if component is None:
        raise ValueError(f"Unknown AgentRuntime modelSpec {normalized!r}")
    return component


def _provider_for_component(component: str) -> dict[str, str]:
    mapped = COMPONENT_PROVIDER_MAP.get(component)
    if mapped:
        return {"provider": mapped[0], "providerModel": mapped[1]}
    lowered = component.lower()
    if "anthropic" in lowered:
        provider = "anthropic"
    elif "openai" in lowered:
        provider = "openai"
    elif "nvidia" in lowered:
        provider = "nvidia"
    elif "foundry" in lowered:
        provider = "foundry"
    elif "together" in lowered:
        provider = "together"
    elif "mistral" in lowered:
        provider = "mistral"
    else:
        provider = "unknown"
    return {"provider": provider}


def _effective_model_status(spec: dict[str, Any]) -> dict[str, Any]:
    raw_model_spec = spec.get("modelSpec")
    model_spec = str(raw_model_spec).strip() if raw_model_spec else ""
    component = _resolve_llm_component(model_spec or None)
    provider = _provider_for_component(component)
    return {
        "effectiveModelSpec": model_spec or provider.get("providerModel") or component,
        "effectiveLlmComponent": component,
        "provider": provider.get("provider", "unknown"),
        "providerModel": provider.get("providerModel"),
    }
# Image pull secrets reused from dapr-agent-py Deployment pattern.
DEFAULT_PULL_SECRETS = [
    s.strip()
    for s in os.environ.get(
        "AGENT_RUNTIME_PULL_SECRETS",
        "workflow-builder-pull-credentials,workflow-builder-ghcr-pull-credentials,ghcr-pull-credentials",
    ).split(",")
    if s.strip()
]

# Defaults for the optional browser sidecar (Chromium + playwright-mcp-gateway).
DEFAULT_CHROME_IMAGE = os.environ.get(
    "AGENT_RUNTIME_CHROME_IMAGE",
    "ghcr.io/pittampalliorg/chrome-sandbox:latest",
)
DEFAULT_PW_MCP_IMAGE = os.environ.get(
    "AGENT_RUNTIME_PW_MCP_IMAGE",
    "ghcr.io/pittampalliorg/playwright-mcp-gateway:latest",
)


def _load_kube() -> None:
    if os.environ.get("AGENT_RUNTIME_CONTROLLER_SKIP_KUBE_LOAD") == "1":
        return
    try:
        config.load_incluster_config()
    except config.ConfigException:
        config.load_kube_config()


_load_kube()
APPS_V1 = client.AppsV1Api()
CORE_V1 = client.CoreV1Api()
CUSTOM = client.CustomObjectsApi()


# ---------------------------------------------------------------------------
# Deployment spec builder
# ---------------------------------------------------------------------------


def _deployment_name(agent_slug: str) -> str:
    return f"agent-runtime-{agent_slug}"


def _app_id(spec: dict[str, Any]) -> str:
    return str(spec.get("appId") or _deployment_name(spec["agentSlug"]))


def _runtime_class(spec: dict[str, Any]) -> str:
    raw = str(spec.get("runtimeClass") or "").strip()
    if raw:
        return raw
    runtime = str(spec.get("runtime") or "").strip()
    return "browser" if runtime == "browser-use-agent" else "coding"


def _runtime_isolation(spec: dict[str, Any]) -> str:
    raw = str(spec.get("runtimeIsolation") or "").strip()
    return raw if raw in {"shared", "dedicated"} else "dedicated"


def _lifecycle_int(spec: dict[str, Any], key: str, default: int) -> int:
    value = (spec.get("lifecycle") or {}).get(key)
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        return default
    return max(0, parsed)


def _min_replicas(spec: dict[str, Any]) -> int:
    return _lifecycle_int(spec, "minReplicas", 0)


def _wake_replicas(spec: dict[str, Any]) -> int:
    if _runtime_isolation(spec) == "shared":
        return max(1, _lifecycle_int(spec, "maxReplicas", 1))
    return 1


def _slots_per_replica(spec: dict[str, Any]) -> int:
    explicit = _lifecycle_int(spec, "slotsPerReplica", 0)
    if explicit > 0:
        return explicit
    defaults = {"coding": 5, "office": 2, "browser": 1, "testing": 2}
    return defaults.get(_runtime_class(spec), 1)


def _dapr_workflow_limit_per_sidecar(spec: dict[str, Any]) -> int:
    lifecycle = spec.get("lifecycle") or {}
    for key in ("daprWorkflowLimitPerSidecar", "maxConcurrentWorkflowInvocations"):
        try:
            parsed = int(lifecycle.get(key))
        except (TypeError, ValueError):
            parsed = 0
        if parsed > 0:
            return parsed
    try:
        parsed = int(os.environ.get("AGENT_RUNTIME_DAPR_WORKFLOW_LIMIT_PER_SIDECAR", "0"))
    except ValueError:
        parsed = 0
    return parsed if parsed > 0 else _slots_per_replica(spec)


def _capacity_status(
    spec: dict[str, Any],
    *,
    desired_replicas: int,
    ready_replicas: int = 0,
) -> dict[str, Any]:
    slots_per_replica = _slots_per_replica(spec)
    workflow_limit = _dapr_workflow_limit_per_sidecar(spec)
    return {
        "desiredReplicas": desired_replicas,
        "slotsPerReplica": slots_per_replica,
        "effectiveSlots": max(0, ready_replicas) * slots_per_replica,
        "daprWorkflowLimitPerSidecar": workflow_limit,
        "daprWorkflowEffectiveCapacity": max(0, ready_replicas) * workflow_limit,
        "admissionReady": ready_replicas > 0,
    }


def ensure_agent_statestore_scope(app_id: str, namespace: str, logger: logging.Logger) -> None:
    """Enroll the per-agent Dapr app id in the shared actor state store.

    Dapr durable workflows use the actor backend. Each runtime pod must see
    exactly one actorStateStore=true Component, so the centralized
    dapr-agent-py state store is scoped and the controller mutates only the
    scopes list. Workflow history stays centralized; no per-agent state store
    is created or deleted.
    """
    if not app_id:
        return
    try:
        component = CUSTOM.get_namespaced_custom_object(
            group=DAPR_GROUP,
            version=DAPR_VERSION,
            namespace=namespace,
            plural=DAPR_COMPONENT_PLURAL,
            name=AGENT_STATESTORE_COMPONENT,
        )
    except client.ApiException as exc:
        raise RuntimeError(
            f"Dapr Component {AGENT_STATESTORE_COMPONENT!r} is required before "
            f"AgentRuntime {app_id!r} can host durable workflows"
        ) from exc

    scopes = component.get("scopes")
    if isinstance(scopes, list) and app_id in scopes:
        return

    if isinstance(scopes, list):
        patch = {"scopes": [*scopes, app_id]}
    else:
        patch = {"scopes": [app_id]}
    CUSTOM.patch_namespaced_custom_object(
        group=DAPR_GROUP,
        version=DAPR_VERSION,
        namespace=namespace,
        plural=DAPR_COMPONENT_PLURAL,
        name=AGENT_STATESTORE_COMPONENT,
        body=patch,
    )
    logger.info(
        "enrolled app id %s in Dapr Component %s scopes",
        app_id,
        AGENT_STATESTORE_COMPONENT,
    )


def remove_agent_statestore_scope(app_id: str, namespace: str, logger: logging.Logger) -> None:
    """Remove a deleted runtime app id from the shared actor state store scopes."""
    if not app_id:
        return
    try:
        component = CUSTOM.get_namespaced_custom_object(
            group=DAPR_GROUP,
            version=DAPR_VERSION,
            namespace=namespace,
            plural=DAPR_COMPONENT_PLURAL,
            name=AGENT_STATESTORE_COMPONENT,
        )
    except client.ApiException as exc:
        if exc.status == 404:
            logger.warning(
                "Dapr Component %s missing while removing scope for app id %s",
                AGENT_STATESTORE_COMPONENT,
                app_id,
            )
            return
        raise

    scopes = component.get("scopes")
    if not isinstance(scopes, list) or app_id not in scopes:
        return

    CUSTOM.patch_namespaced_custom_object(
        group=DAPR_GROUP,
        version=DAPR_VERSION,
        namespace=namespace,
        plural=DAPR_COMPONENT_PLURAL,
        name=AGENT_STATESTORE_COMPONENT,
        body={"scopes": [scope for scope in scopes if scope != app_id]},
    )
    logger.info(
        "removed app id %s from Dapr Component %s scopes",
        app_id,
        AGENT_STATESTORE_COMPONENT,
    )


def _build_browser_sidecars(browser_spec: dict[str, Any]) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    """Return (containers, volumes) for the chromium + playwright-mcp sidecar pair.

    Colocating chromium + the MCP gateway in the agent pod means Playwright
    reaches CDP via http://localhost:9222 — Chromium accepts Host: localhost
    natively, no nginx Host rewrite, no cross-pod round-trip. Each agent runtime
    gets its own browser, so sessions can't see each other's pages.
    """
    chrome_image = browser_spec.get("chromeImage") or DEFAULT_CHROME_IMAGE
    mcp_image = browser_spec.get("mcpGatewayImage") or DEFAULT_PW_MCP_IMAGE
    chrome_resources = browser_spec.get("chromeResources") or {
        "requests": {"memory": "64Mi", "cpu": "50m"},
        "limits":   {"memory": "2Gi",   "cpu": "2000m"},
    }
    mcp_resources = browser_spec.get("mcpResources") or {
        "requests": {"memory": "32Mi", "cpu": "10m"},
        "limits":   {"memory": "512Mi", "cpu": "500m"},
    }
    containers = [
        {
            "name": "chromium",
            "image": chrome_image,
            "imagePullPolicy": "Always",
            "env": [
                # chrome-sandbox's start-chrome starts nginx on 9223 for the
                # cross-pod Host-rewrite case. In the colocated sidecar
                # layout, playwright-mcp reaches us via localhost:9222, which
                # chromium already binds natively, so nginx is unnecessary.
                {"name": "CHROME_CDP_HOST_REWRITE", "value": "false"},
            ],
            "resources": chrome_resources,
            "volumeMounts": [{"name": "dshm", "mountPath": "/dev/shm"}],
        },
        {
            "name": "playwright-mcp",
            "image": mcp_image,
            "imagePullPolicy": "Always",
            "args": [
                "--port", "3100",
                # Bound to 0.0.0.0 so the per-agent ClusterIP Service
                # (agent-runtime-<slug>-mcp:3100) can reach the pod.
                # Cross-pod reachability is bounded to callers in the
                # cluster; BFF endpoints that invoke this MCP enforce
                # workspace-role scope before relaying.
                "--host", "0.0.0.0",
                "--allowed-hosts", "*",
                "--output-dir", "/tmp/playwright-mcp-output",
                "--cdp-endpoint", "http://localhost:9222",
            ],
            "ports": [
                {"name": "mcp", "containerPort": 3100},
            ],
            "resources": mcp_resources,
            "readinessProbe": {
                "tcpSocket": {"port": 3100},
                "initialDelaySeconds": 3,
                "periodSeconds": 5,
            },
        },
    ]
    volumes = [
        {
            "name": "dshm",
            "emptyDir": {"medium": "Memory", "sizeLimit": "1Gi"},
        },
    ]
    return containers, volumes


def _build_deployment(name: str, namespace: str, spec: dict[str, Any]) -> dict[str, Any]:
    image = spec["environment"]["imageTag"]
    slug = spec["agentSlug"]
    app_id = _app_id(spec)
    runtime_class = _runtime_class(spec)
    runtime_isolation = _runtime_isolation(spec)
    bootstrap = json.dumps(spec.get("mcpServers") or [])
    llm_component = _resolve_llm_component(spec.get("modelSpec"))
    model_status = _effective_model_status(spec)
    # browser-use runtime pods OOMKill on the 1Gi default: browser-use's
    # AgentHistoryList keeps the full screenshot bytes in-memory per step,
    # the Anthropic client batches images for context, and OTEL span/metric
    # exporters layer their own buffers on top. 2Gi gives a 3-4 turn run
    # headroom without the container being reaped mid-turn (which would
    # then trigger a WorkflowRetryPolicy loop that leaks Browserstation
    # browsers).
    is_browser_use = "browser-use-agent" in image
    if is_browser_use:
        default_resources = {
            "requests": {"memory": "128Mi", "cpu": "75m"},
            "limits": {"memory": "2Gi", "cpu": "1000m"},
        }
    else:
        default_resources = {
            "requests": {"memory": "512Mi", "cpu": "250m"},
            "limits": {"memory": "2Gi", "cpu": "1500m"},
        }
    resources = spec.get("resources") or {
        **default_resources,
    }
    pull_secrets = spec.get("imagePullSecrets") or [{"name": n} for n in DEFAULT_PULL_SECRETS]
    service_account = spec.get("serviceAccountName") or DEFAULT_SA

    browser_spec = spec.get("browserSidecar") or {}
    browser_enabled = bool(browser_spec.get("enabled"))
    extra_containers: list[dict[str, Any]] = []
    extra_volumes: list[dict[str, Any]] = []
    if browser_enabled:
        extra_containers, extra_volumes = _build_browser_sidecars(browser_spec)

    # OpenShell gateway config + mTLS certs. Without these, every tool the
    # agent runs that touches the per-session sandbox (write_file, bash_run,
    # etc.) fails with "[Errno 2] No such file or directory:
    # '/root/.config/openshell/active_gateway'". Mirrors the
    # seed-openshell-config init container on the legacy dapr-agent-py
    # Deployment (packages/components/active-development/manifests/
    # dapr-agent-py/Deployment-dapr-agent-py.yaml).
    openshell_init = {
        "name": "seed-openshell-config",
        "image": image,
        "imagePullPolicy": "IfNotPresent",
        "command": ["sh", "-c"],
        "args": [
            (
                'set -eu\n'
                'CONFIG_ROOT="${XDG_CONFIG_HOME}/openshell"\n'
                'GATEWAY_DIR="${CONFIG_ROOT}/gateways/${OPENSHELL_GATEWAY_NAME}"\n'
                'MTLS_DIR="${GATEWAY_DIR}/mtls"\n'
                'install -d -m 700 "${MTLS_DIR}"\n'
                'cat >"${GATEWAY_DIR}/metadata.json" <<EOF\n'
                '{\n'
                '  "name": "${OPENSHELL_GATEWAY_NAME}",\n'
                '  "gateway_endpoint": "${OPENSHELL_GATEWAY_URL}",\n'
                '  "is_remote": false,\n'
                '  "gateway_port": ${OPENSHELL_GATEWAY_PORT},\n'
                '  "auth_mode": "mtls"\n'
                '}\n'
                'EOF\n'
                'printf \'%s\\n\' "${OPENSHELL_GATEWAY_NAME}" > "${CONFIG_ROOT}/active_gateway"\n'
                'cp /etc/openshell-tls/client/tls.crt "${MTLS_DIR}/tls.crt"\n'
                'cp /etc/openshell-tls/client/tls.key "${MTLS_DIR}/tls.key"\n'
                'if [ -f /etc/openshell-tls/client/ca.crt ]; then\n'
                '  cp /etc/openshell-tls/client/ca.crt "${MTLS_DIR}/ca.crt"\n'
                'else\n'
                '  cp /etc/openshell-tls/client-ca/tls.crt "${MTLS_DIR}/ca.crt"\n'
                'fi\n'
                'chmod 644 "${MTLS_DIR}/ca.crt" "${MTLS_DIR}/tls.crt"\n'
                'chmod 600 "${MTLS_DIR}/tls.key"\n'
            )
        ],
        "env": [
            {"name": "XDG_CONFIG_HOME", "value": "/root/.config"},
            {
                "name": "OPENSHELL_GATEWAY_URL",
                "value": "https://openshell.openshell.svc.cluster.local:8080",
            },
            {"name": "OPENSHELL_GATEWAY_NAME", "value": DEFAULT_OPENSHELL_GATEWAY_NAME},
            {"name": "OPENSHELL_GATEWAY_PORT", "value": "8080"},
        ],
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
    openshell_volumes: list[dict[str, Any]] = [
        {"name": "openshell-config", "emptyDir": {}},
        {
            "name": "openshell-client-tls",
            "secret": {"defaultMode": 256, "secretName": "openshell-client-tls"},
        },
        {
            "name": "openshell-client-ca",
            "secret": {
                "defaultMode": 292,
                "secretName": "openshell-server-client-ca",
            },
        },
    ]

    pod_spec: dict[str, Any] = {
        "serviceAccountName": service_account,
        "terminationGracePeriodSeconds": 60,
        "imagePullSecrets": pull_secrets,
        "initContainers": [openshell_init],
        "containers": [],  # filled below
        "volumes": [*openshell_volumes, *extra_volumes],
        "topologySpreadConstraints": [
            {
                "maxSkew": 1,
                "topologyKey": "kubernetes.io/hostname",
                "whenUnsatisfiable": "ScheduleAnyway",
                "labelSelector": {
                    "matchLabels": {
                        LABEL_ROLE: "agent-runtime",
                    },
                },
            },
        ],
    }
    runtime_labels = {
        "app": name,
        LABEL_ROLE: "agent-runtime",
        LABEL_SLUG: slug,
        LABEL_APP_ID: app_id,
        LABEL_RUNTIME_CLASS: runtime_class,
        LABEL_RUNTIME_ISOLATION: runtime_isolation,
    }
    runtime_annotations = {
        ANNO_APP_ID: app_id,
        "agents.x-k8s.io/effective-model-spec": str(model_status["effectiveModelSpec"]),
        "agents.x-k8s.io/effective-llm-component": str(model_status["effectiveLlmComponent"]),
        "agents.x-k8s.io/provider": str(model_status["provider"]),
    }

    return {
        "apiVersion": "apps/v1",
        "kind": "Deployment",
        "metadata": {
            "name": name,
            "namespace": namespace,
            "labels": runtime_labels,
            "annotations": runtime_annotations,
        },
        "spec": {
            "replicas": _min_replicas(spec),
            "selector": {"matchLabels": {"app": name}},
            "template": {
                "metadata": {
                    "labels": runtime_labels,
                    # dapr.io/enabled + dapr.io/app-id are injected by the
                    # openshell-sandbox-dapr-webhook; we only declare the
                    # label so the webhook matches this Pod.
                    "annotations": runtime_annotations,
                },
                "spec": {
                    **pod_spec,
                    "containers": [
                        {
                            "name": "dapr-agent-py",
                            "image": image,
                            # Always pull: the default env image tag is
                            # dapr-agent-py-sandbox:latest, which moves on
                            # every sandbox-image build. IfNotPresent would
                            # pin every per-agent pod to whatever digest the
                            # node cached first — stale pods would silently
                            # keep running old code even after a fresh
                            # `:latest` retag.
                            "imagePullPolicy": "Always",
                            "ports": [{"name": "http", "containerPort": 8002}],
                            "env": [
                                {"name": "AGENT_SERVICE_NAME", "value": app_id},
                                # Override OTEL_SERVICE_NAME for browser-use
                                # runtime pods so Phoenix/Tempo/Langfuse can
                                # slice spans by runtime-class. The shared
                                # `dapr-agent-py-config` ConfigMap (injected
                                # via envFrom below) bakes in
                                # OTEL_SERVICE_NAME=dapr-agent-py; an
                                # explicit env entry overrides that. Detected
                                # via image tag — no CR schema change needed.
                                *(
                                    [{"name": "OTEL_SERVICE_NAME", "value": "browser-use-agent"}]
                                    if "browser-use-agent" in image
                                    else []
                                ),
                                # OpenShell CLI reads ${XDG_CONFIG_HOME}/openshell/active_gateway
                                # + gateway metadata files populated by the seed-openshell-config
                                # init container. Without this, every OpenShell-backed tool
                                # (write_file, bash_run, etc.) fails with ENOENT on active_gateway.
                                {"name": "XDG_CONFIG_HOME", "value": "/root/.config"},
                                {"name": "DAPR_LLM_COMPONENT_DEFAULT", "value": llm_component},
                                {"name": "DAPR_AGENT_PY_HOOKS_ENABLED", "value": "true"},
                                {"name": "DAPR_AGENT_PY_PLUGINS_ENABLED", "value": "true"},
                                {"name": "DAPR_AGENT_PY_PLUGIN_PATHS", "value": "/etc/dapr-agent-py/plugins"},
                                {"name": "DAPR_AGENT_PY_BOOTSTRAP_MCP_SERVERS_JSON", "value": bootstrap},
                                {"name": "AGENT_CALL_AGENT_NATIVE", "value": "1"},
                                # Agent slug as the Producer-Id for durable-streams-shaped
                                # session event idempotency (see event_publisher.py
                                # _default_source_event_id). Joins cleanly with
                                # agents.slug so "all events from agent X" is a
                                # one-liner query.
                                {"name": "AGENT_SLUG", "value": slug},
                                # BFF base URL for session event mirroring. INTERNAL_API_TOKEN
                                # arrives via envFrom from dapr-agent-py-secrets (Azure
                                # Key Vault -> ExternalSecret adds the INTERNAL-API-TOKEN
                                # key). With both set, src/event_publisher.py POSTs every
                                # agent.message / agent.tool_use event to the BFF ingest
                                # endpoint so the UI Test panel shows live activity.
                                {
                                    "name": "WORKFLOW_BUILDER_URL",
                                    "value": "http://workflow-builder.workflow-builder.svc.cluster.local:3000",
                                },
                            ],
                            "envFrom": [
                                {"configMapRef": {"name": "dapr-agent-py-config", "optional": True}},
                                {"secretRef": {"name": "dapr-agent-py-secrets", "optional": True}},
                                {"secretRef": {"name": "workflow-checkpoint-gitea", "optional": True}},
                            ],
                            "volumeMounts": [
                                {"name": "openshell-config", "mountPath": "/root/.config"},
                            ],
                            "resources": resources,
                            "startupProbe": {
                                "httpGet": {"path": "/healthz", "port": 8002},
                                "initialDelaySeconds": 5,
                                "periodSeconds": 5,
                                "failureThreshold": 30,
                            },
                            "livenessProbe": {
                                "httpGet": {"path": "/healthz", "port": 8002},
                                "periodSeconds": 30,
                                # browser-use turns can briefly block the
                                # Python event loop during CDP calls or
                                # AgentHistoryList updates — default
                                # timeoutSeconds=1 + failureThreshold=3
                                # killed the pod mid-turn, triggering a
                                # WorkflowRetryPolicy retry that wasted
                                # minutes + left session events stalled.
                                # Loosen to tolerate ~3 min of
                                # unresponsiveness before declaring the
                                # container dead.
                                "timeoutSeconds": 5,
                                "failureThreshold": 6,
                            },
                            "readinessProbe": {
                                "httpGet": {"path": "/readyz", "port": 8002},
                                "periodSeconds": 5,
                                "timeoutSeconds": 3,
                                "failureThreshold": 6,
                            },
                        },
                        *extra_containers,
                    ],
                },
            },
        },
    }


# ---------------------------------------------------------------------------
# Status helpers
# ---------------------------------------------------------------------------


def _now_iso() -> str:
    return _dt.datetime.now(_dt.UTC).isoformat()


def _patch_status(name: str, namespace: str, patch: dict[str, Any]) -> None:
    CUSTOM.patch_namespaced_custom_object_status(
        group=GROUP,
        version=VERSION,
        namespace=namespace,
        plural=PLURAL,
        name=name,
        body={"status": patch},
    )


def _scale_deployment(name: str, namespace: str, replicas: int) -> None:
    APPS_V1.patch_namespaced_deployment_scale(
        name=name,
        namespace=namespace,
        body={"spec": {"replicas": replicas}},
    )


# ---------------------------------------------------------------------------
# MCP Service upsert/delete
# ---------------------------------------------------------------------------


def _mcp_service_name(agent_slug: str) -> str:
    return f"{_deployment_name(agent_slug)}-mcp"


def _build_mcp_service(svc_name: str, dep_name: str, namespace: str, slug: str) -> dict[str, Any]:
    """Per-agent ClusterIP Service exposing playwright-mcp :3100 to the BFF.
    Selecting app=agent-runtime-<slug> matches the pod label set in
    _build_deployment. The Service only exists while browserSidecar is
    enabled; see reconcile_mcp_service() below.
    """
    return {
        "apiVersion": "v1",
        "kind": "Service",
        "metadata": {
            "name": svc_name,
            "namespace": namespace,
            "labels": {
                "app": dep_name,
                LABEL_ROLE: "agent-runtime",
                LABEL_SLUG: slug,
            },
        },
        "spec": {
            "type": "ClusterIP",
            "selector": {"app": dep_name},
            "ports": [
                {"name": "mcp", "port": 3100, "targetPort": 3100, "protocol": "TCP"},
            ],
        },
    }


def reconcile_mcp_service(spec: dict[str, Any], namespace: str, logger: logging.Logger) -> None:
    """Create/patch the MCP Service when browserSidecar.enabled; delete when not."""
    slug = spec["agentSlug"]
    dep_name = _deployment_name(slug)
    svc_name = _mcp_service_name(slug)
    want = bool((spec.get("browserSidecar") or {}).get("enabled"))
    if want:
        body = _build_mcp_service(svc_name, dep_name, namespace, slug)
        try:
            CORE_V1.create_namespaced_service(namespace=namespace, body=body)
            logger.info("created Service %s", svc_name)
        except client.ApiException as exc:
            if exc.status != 409:
                raise
            CORE_V1.patch_namespaced_service(name=svc_name, namespace=namespace, body=body)
    else:
        try:
            CORE_V1.delete_namespaced_service(name=svc_name, namespace=namespace)
            logger.info("deleted Service %s (browserSidecar disabled)", svc_name)
        except client.ApiException as exc:
            if exc.status != 404:
                raise


# ---------------------------------------------------------------------------
# Handlers
# ---------------------------------------------------------------------------


@kopf.on.create(GROUP, VERSION, PLURAL)
def on_create(spec: dict, name: str, namespace: str, logger: logging.Logger, **_: Any) -> dict:
    """Materialize Deployment at the runtime's configured warm capacity."""
    dep_name = _deployment_name(spec["agentSlug"])
    ensure_agent_statestore_scope(_app_id(spec), namespace, logger)
    dep = _build_deployment(dep_name, namespace, dict(spec))
    replicas = _min_replicas(spec)

    try:
        APPS_V1.create_namespaced_deployment(namespace=namespace, body=dep)
        logger.info("created Deployment %s", dep_name)
    except client.ApiException as exc:
        if exc.status != 409:
            raise
        APPS_V1.patch_namespaced_deployment(name=dep_name, namespace=namespace, body=dep)
        logger.info("patched existing Deployment %s", dep_name)

    reconcile_mcp_service(dict(spec), namespace, logger)

    _patch_status(name, namespace, {
        "phase": "Starting" if replicas >= 1 else "Sleeping",
        "replicas": replicas,
        **_capacity_status(spec, desired_replicas=replicas, ready_replicas=0),
        **_effective_model_status(spec),
        "deploymentRef": dep_name,
        "lastTransitionTime": _now_iso(),
        "message": f"Deployment created; replicas={replicas}",
    })
    return {"deploymentRef": dep_name}


@kopf.on.update(GROUP, VERSION, PLURAL, field="spec")
def on_spec_update(spec: dict, name: str, namespace: str, logger: logging.Logger, **_: Any) -> None:
    """Re-patch Deployment when spec changes (image, mcpServers, etc.).

    Use replace rather than merge-patch so fields removed from the desired
    spec (e.g., an old exec probe we replaced with tcpSocket) actually
    disappear — strategic merge would union the two probe handler types and
    Kubernetes would 422 "may not specify more than 1 handler type".
    """
    dep_name = _deployment_name(spec["agentSlug"])
    ensure_agent_statestore_scope(_app_id(spec), namespace, logger)
    dep = _build_deployment(dep_name, namespace, dict(spec))
    # Preserve current replica count on spec update — don't bounce a hot pod.
    try:
        live = APPS_V1.read_namespaced_deployment(name=dep_name, namespace=namespace)
        dep["spec"]["replicas"] = live.spec.replicas or 0
        # resourceVersion is required for replace so we don't race with any
        # concurrent writer.
        dep["metadata"]["resourceVersion"] = live.metadata.resource_version
        APPS_V1.replace_namespaced_deployment(name=dep_name, namespace=namespace, body=dep)
    except client.ApiException as exc:
        if exc.status != 404:
            raise
        # Deployment was deleted out-of-band — re-create cleanly.
        APPS_V1.create_namespaced_deployment(namespace=namespace, body=dep)
    reconcile_mcp_service(dict(spec), namespace, logger)
    try:
        live = APPS_V1.read_namespaced_deployment(name=dep_name, namespace=namespace)
        ready = int((live.status.ready_replicas or 0))
        replicas = int((live.status.replicas or 0))
    except client.ApiException as exc:
        if exc.status != 404:
            logger.warning("on_spec_update live deployment read failed: %s", exc)
        ready = 0
        replicas = _min_replicas(spec)
    _patch_status(name, namespace, {
        **_effective_model_status(spec),
        "readyReplicas": ready,
        "replicas": replicas,
        **_capacity_status(spec, desired_replicas=replicas, ready_replicas=ready),
        "lastTransitionTime": _now_iso(),
    })
    logger.info("spec update applied to Deployment %s", dep_name)


@kopf.on.delete(GROUP, VERSION, PLURAL)
def on_delete(spec: dict, name: str, namespace: str, logger: logging.Logger, **_: Any) -> None:
    dep_name = _deployment_name(spec["agentSlug"])
    try:
        APPS_V1.delete_namespaced_deployment(name=dep_name, namespace=namespace)
        logger.info("deleted Deployment %s", dep_name)
    except client.ApiException as exc:
        if exc.status != 404:
            raise
    # Also drop the MCP Service if one exists (reconcile_mcp_service treats
    # a spec without browserSidecar.enabled as "delete").
    try:
        reconcile_mcp_service({"agentSlug": spec["agentSlug"]}, namespace, logger)
    except client.ApiException as exc:
        if exc.status != 404:
            raise
    remove_agent_statestore_scope(_app_id(spec), namespace, logger)


@kopf.on.field(GROUP, VERSION, PLURAL, field=("metadata", "annotations", ANNO_WAKE))
def on_wake(old: Any, new: Any, spec: dict, name: str, namespace: str, logger: logging.Logger, **_: Any) -> None:
    if old == new or not new:
        return
    dep_name = _deployment_name(spec["agentSlug"])
    ensure_agent_statestore_scope(_app_id(spec), namespace, logger)
    desired_replicas = _wake_replicas(spec)
    logger.info(
        "wake signal %s -> scaling Deployment %s to %d",
        new,
        dep_name,
        desired_replicas,
    )
    _scale_deployment(dep_name, namespace, desired_replicas)
    # Read the live Deployment to decide phase — on_deployment_event may
    # have already set phase=Active (if the pod was already running for
    # another reason), and we'd otherwise stomp that to Starting. Pick
    # Active when readyReplicas≥1 so the wake handler is idempotent.
    phase = "Starting"
    ready = 0
    try:
        live = APPS_V1.read_namespaced_deployment(name=dep_name, namespace=namespace)
        ready = int((live.status.ready_replicas or 0))
        if ready >= 1:
            phase = "Active"
    except client.ApiException as exc:
        if exc.status != 404:
            logger.warning("on_wake live deployment read failed: %s", exc)
    _patch_status(name, namespace, {
        "phase": phase,
        "replicas": desired_replicas,
        "readyReplicas": ready,
        **_effective_model_status(spec),
        **_capacity_status(
            spec,
            desired_replicas=desired_replicas,
            ready_replicas=ready,
        ),
        "lastActiveAt": _now_iso(),
        "lastTransitionTime": _now_iso(),
        "message": f"Wake requested at {new}",
    })


@kopf.on.field(GROUP, VERSION, PLURAL, field=("metadata", "annotations", ANNO_SLEEP))
def on_sleep(old: Any, new: Any, spec: dict, name: str, namespace: str, logger: logging.Logger, **_: Any) -> None:
    if old == new or not new:
        return
    dep_name = _deployment_name(spec["agentSlug"])
    replicas = _min_replicas(spec)
    logger.info("sleep signal %s -> scaling Deployment %s to %d", new, dep_name, replicas)
    _scale_deployment(dep_name, namespace, replicas)
    _patch_status(name, namespace, {
        "phase": "Starting" if replicas >= 1 else "Sleeping",
        "replicas": replicas,
        "readyReplicas": 0,
        **_effective_model_status(spec),
        **_capacity_status(spec, desired_replicas=replicas, ready_replicas=0),
        "lastTransitionTime": _now_iso(),
        "message": f"Sleep requested at {new}",
    })


@kopf.on.field(GROUP, VERSION, PLURAL, field=("metadata", "annotations", ANNO_LAST_ACTIVE))
def on_last_active(old: Any, new: Any, name: str, namespace: str, **_: Any) -> None:
    """BFF stamps this on every session dispatch. Cheap mirror into status."""
    if old == new or not new:
        return
    _patch_status(name, namespace, {"lastActiveAt": new})


@kopf.timer(GROUP, VERSION, PLURAL, interval=IDLE_CHECK_INTERVAL)
def idle_reaper(spec: dict, status: dict, name: str, namespace: str, logger: logging.Logger, **_: Any) -> None:
    """Scale back to minReplicas when idle > idleTtlSeconds."""
    replicas = (status or {}).get("replicas") or 0
    min_replicas = _min_replicas(spec)
    if replicas <= min_replicas:
        return
    last_active = (status or {}).get("lastActiveAt")
    if not last_active:
        return
    ttl = ((spec.get("lifecycle") or {}).get("idleTtlSeconds")) or DEFAULT_IDLE_TTL
    try:
        parsed = _dt.datetime.fromisoformat(last_active.replace("Z", "+00:00"))
    except (TypeError, ValueError):
        return
    age = (_dt.datetime.now(_dt.UTC) - parsed).total_seconds()
    if age < ttl:
        return
    dep_name = _deployment_name(spec["agentSlug"])
    logger.info(
        "idle reaper: %s idle %ds (>ttl %ds) -> scaling to %d",
        dep_name,
        int(age),
        ttl,
        min_replicas,
    )
    _scale_deployment(dep_name, namespace, min_replicas)
    _patch_status(name, namespace, {
        "phase": "Starting" if min_replicas >= 1 else "Sleeping",
        "replicas": min_replicas,
        "readyReplicas": 0,
        **_effective_model_status(spec),
        **_capacity_status(spec, desired_replicas=min_replicas, ready_replicas=0),
        "lastTransitionTime": _now_iso(),
        "message": f"Idle > {ttl}s",
    })


@kopf.on.event("apps", "v1", "deployments", labels={LABEL_ROLE: "agent-runtime"})
def on_deployment_event(event: dict, logger: logging.Logger, **_: Any) -> None:
    """Mirror Deployment readyReplicas into the owning AgentRuntime status."""
    obj = event.get("object") or {}
    metadata = obj.get("metadata") or {}
    status_obj = obj.get("status") or {}
    labels = metadata.get("labels") or {}
    slug = labels.get(LABEL_SLUG)
    namespace = metadata.get("namespace")
    if not slug or not namespace:
        return
    ar_name = _deployment_name(slug)
    ready = int(status_obj.get("readyReplicas") or 0)
    replicas = int(status_obj.get("replicas") or 0)
    phase = "Active" if ready >= 1 else ("Starting" if replicas >= 1 else "Sleeping")
    try:
        runtime = CUSTOM.get_namespaced_custom_object(
            group=GROUP,
            version=VERSION,
            namespace=namespace,
            plural=PLURAL,
            name=ar_name,
        )
        spec = runtime.get("spec") or {}
        _patch_status(ar_name, namespace, {
            "readyReplicas": ready,
            "replicas": replicas,
            **_effective_model_status(spec),
            **_capacity_status(
                spec,
                desired_replicas=replicas,
                ready_replicas=ready,
            ),
            "phase": phase,
            "lastTransitionTime": _now_iso(),
        })
    except client.ApiException as exc:
        if exc.status != 404:
            logger.warning("status patch failed for %s: %s", ar_name, exc)

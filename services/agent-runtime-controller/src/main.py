"""agent-runtime-controller — kopf operator that reconciles AgentRuntime CRs
into Deployments running the dapr-agent-py-sandbox image with per-agent MCP
bootstrap config. One AgentRuntime = one Deployment = one Pod (replicas
scale 0 <-> 1 on idle/wake).

Lifecycle:
  - CR create  -> Deployment at replicas=0, status.phase=Sleeping
  - annotation agents.x-k8s.io/wake=<ts> -> scale to 1, wait ready,
    status.phase=Active
  - idle check (every 60s): if lastActiveAt older than spec.lifecycle.
    idleTtlSeconds and replicas=1, scale to 0, status.phase=Sleeping

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

LABEL_ROLE = "agents.x-k8s.io/role"
LABEL_SLUG = "agents.x-k8s.io/slug"
ANNO_WAKE = "agents.x-k8s.io/wake"
ANNO_SLEEP = "agents.x-k8s.io/sleep"
ANNO_LAST_ACTIVE = "agents.x-k8s.io/last-active"

DEFAULT_IDLE_TTL = 1800
IDLE_CHECK_INTERVAL = 60

DEFAULT_NAMESPACE = os.environ.get("CONTROLLER_NAMESPACE", "openshell")
DEFAULT_SA = os.environ.get("AGENT_RUNTIME_SERVICE_ACCOUNT", "agent-runtime")
# Image pull secrets reused from dapr-agent-py Deployment pattern.
DEFAULT_PULL_SECRETS = [
    s.strip()
    for s in os.environ.get(
        "AGENT_RUNTIME_PULL_SECRETS",
        "workflow-builder-pull-credentials,workflow-builder-ghcr-pull-credentials,ghcr-pull-credentials",
    ).split(",")
    if s.strip()
]


def _load_kube() -> None:
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


def _build_deployment(name: str, namespace: str, spec: dict[str, Any]) -> dict[str, Any]:
    image = spec["environment"]["imageTag"]
    slug = spec["agentSlug"]
    app_id = spec.get("appId") or _deployment_name(slug)
    bootstrap = json.dumps(spec.get("mcpServers") or [])
    resources = spec.get("resources") or {
        "requests": {"memory": "256Mi", "cpu": "100m"},
        "limits": {"memory": "1Gi", "cpu": "1000m"},
    }
    pull_secrets = spec.get("imagePullSecrets") or [{"name": n} for n in DEFAULT_PULL_SECRETS]
    service_account = spec.get("serviceAccountName") or DEFAULT_SA

    return {
        "apiVersion": "apps/v1",
        "kind": "Deployment",
        "metadata": {
            "name": name,
            "namespace": namespace,
            "labels": {
                "app": name,
                LABEL_ROLE: "agent-runtime",
                LABEL_SLUG: slug,
            },
        },
        "spec": {
            "replicas": 0,
            "selector": {"matchLabels": {"app": name}},
            "template": {
                "metadata": {
                    "labels": {
                        "app": name,
                        LABEL_ROLE: "agent-runtime",
                        LABEL_SLUG: slug,
                    },
                    # dapr.io/enabled + dapr.io/app-id are injected by the
                    # openshell-sandbox-dapr-webhook; we only declare the
                    # label so the webhook matches this Pod.
                    "annotations": {},
                },
                "spec": {
                    "serviceAccountName": service_account,
                    "terminationGracePeriodSeconds": 60,
                    "imagePullSecrets": pull_secrets,
                    "containers": [
                        {
                            "name": "dapr-agent-py",
                            "image": image,
                            "imagePullPolicy": "IfNotPresent",
                            "ports": [{"name": "http", "containerPort": 8002}],
                            "env": [
                                {"name": "AGENT_SERVICE_NAME", "value": app_id},
                                {"name": "DAPR_LLM_COMPONENT_DEFAULT", "value": "llm-anthropic-opus"},
                                {"name": "DAPR_AGENT_PY_HOOKS_ENABLED", "value": "true"},
                                {"name": "DAPR_AGENT_PY_PLUGINS_ENABLED", "value": "true"},
                                {"name": "DAPR_AGENT_PY_PLUGIN_PATHS", "value": "/etc/dapr-agent-py/plugins"},
                                {"name": "DAPR_AGENT_PY_BOOTSTRAP_MCP_SERVERS_JSON", "value": bootstrap},
                                {"name": "AGENT_CALL_AGENT_NATIVE", "value": "1"},
                            ],
                            "envFrom": [
                                {"configMapRef": {"name": "dapr-agent-py-config", "optional": True}},
                                {"secretRef": {"name": "dapr-agent-py-secrets", "optional": True}},
                                {"secretRef": {"name": "workflow-checkpoint-gitea", "optional": True}},
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
                            },
                            "readinessProbe": {
                                "httpGet": {"path": "/readyz", "port": 8002},
                                "periodSeconds": 5,
                            },
                        }
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
# Handlers
# ---------------------------------------------------------------------------


@kopf.on.create(GROUP, VERSION, PLURAL)
def on_create(spec: dict, name: str, namespace: str, logger: logging.Logger, **_: Any) -> dict:
    """Materialize Deployment at replicas=0."""
    dep_name = _deployment_name(spec["agentSlug"])
    dep = _build_deployment(dep_name, namespace, dict(spec))

    try:
        APPS_V1.create_namespaced_deployment(namespace=namespace, body=dep)
        logger.info("created Deployment %s", dep_name)
    except client.ApiException as exc:
        if exc.status != 409:
            raise
        APPS_V1.patch_namespaced_deployment(name=dep_name, namespace=namespace, body=dep)
        logger.info("patched existing Deployment %s", dep_name)

    _patch_status(name, namespace, {
        "phase": "Sleeping",
        "replicas": 0,
        "deploymentRef": dep_name,
        "lastTransitionTime": _now_iso(),
        "message": "Deployment created; scaled to 0",
    })
    return {"deploymentRef": dep_name}


@kopf.on.update(GROUP, VERSION, PLURAL, field="spec")
def on_spec_update(spec: dict, name: str, namespace: str, logger: logging.Logger, **_: Any) -> None:
    """Re-patch Deployment when spec changes (image, mcpServers, etc.)."""
    dep_name = _deployment_name(spec["agentSlug"])
    dep = _build_deployment(dep_name, namespace, dict(spec))
    # Preserve current replica count on spec update — don't bounce a hot pod.
    try:
        live = APPS_V1.read_namespaced_deployment(name=dep_name, namespace=namespace)
        dep["spec"]["replicas"] = live.spec.replicas or 0
    except client.ApiException as exc:
        if exc.status != 404:
            raise
    APPS_V1.patch_namespaced_deployment(name=dep_name, namespace=namespace, body=dep)
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


@kopf.on.field(GROUP, VERSION, PLURAL, field=("metadata", "annotations", ANNO_WAKE))
def on_wake(old: Any, new: Any, spec: dict, name: str, namespace: str, logger: logging.Logger, **_: Any) -> None:
    if old == new or not new:
        return
    dep_name = _deployment_name(spec["agentSlug"])
    logger.info("wake signal %s -> scaling Deployment %s to 1", new, dep_name)
    _scale_deployment(dep_name, namespace, 1)
    _patch_status(name, namespace, {
        "phase": "Starting",
        "replicas": 1,
        "lastActiveAt": _now_iso(),
        "lastTransitionTime": _now_iso(),
        "message": f"Wake requested at {new}",
    })


@kopf.on.field(GROUP, VERSION, PLURAL, field=("metadata", "annotations", ANNO_SLEEP))
def on_sleep(old: Any, new: Any, spec: dict, name: str, namespace: str, logger: logging.Logger, **_: Any) -> None:
    if old == new or not new:
        return
    dep_name = _deployment_name(spec["agentSlug"])
    logger.info("sleep signal %s -> scaling Deployment %s to 0", new, dep_name)
    _scale_deployment(dep_name, namespace, 0)
    _patch_status(name, namespace, {
        "phase": "Sleeping",
        "replicas": 0,
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
    """Scale to 0 when idle > idleTtlSeconds."""
    replicas = (status or {}).get("replicas") or 0
    if replicas < 1:
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
    logger.info("idle reaper: %s idle %ds (>ttl %ds) -> scaling to 0", dep_name, int(age), ttl)
    _scale_deployment(dep_name, namespace, 0)
    _patch_status(name, namespace, {
        "phase": "Sleeping",
        "replicas": 0,
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
        _patch_status(ar_name, namespace, {
            "readyReplicas": ready,
            "replicas": replicas,
            "phase": phase,
            "lastTransitionTime": _now_iso(),
        })
    except client.ApiException as exc:
        if exc.status != 404:
            logger.warning("status patch failed for %s: %s", ar_name, exc)

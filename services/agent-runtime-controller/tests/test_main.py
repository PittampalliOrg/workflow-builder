from __future__ import annotations

import os
import sys
import types
from pathlib import Path


SERVICE_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SERVICE_ROOT / "src"))
os.environ["AGENT_RUNTIME_CONTROLLER_SKIP_KUBE_LOAD"] = "1"


def _decorator(*_args, **_kwargs):
    def wrap(fn):
        return fn

    return wrap


kopf = types.ModuleType("kopf")
kopf.on = types.SimpleNamespace(  # type: ignore[attr-defined]
    create=_decorator,
    update=_decorator,
    delete=_decorator,
    field=_decorator,
    event=_decorator,
)
kopf.timer = _decorator  # type: ignore[attr-defined]
sys.modules.setdefault("kopf", kopf)

kubernetes = types.ModuleType("kubernetes")
client = types.ModuleType("client")
config = types.ModuleType("config")


class ApiException(Exception):
    def __init__(self, status=0):
        super().__init__(str(status))
        self.status = status


class ConfigException(Exception):
    pass


client.ApiException = ApiException  # type: ignore[attr-defined]
client.AppsV1Api = lambda: object()  # type: ignore[attr-defined]
client.CoreV1Api = lambda: object()  # type: ignore[attr-defined]
client.CustomObjectsApi = lambda: object()  # type: ignore[attr-defined]
config.ConfigException = ConfigException  # type: ignore[attr-defined]
config.load_incluster_config = lambda: None  # type: ignore[attr-defined]
config.load_kube_config = lambda: None  # type: ignore[attr-defined]
kubernetes.client = client  # type: ignore[attr-defined]
kubernetes.config = config  # type: ignore[attr-defined]
sys.modules.setdefault("kubernetes", kubernetes)
sys.modules.setdefault("kubernetes.client", client)
sys.modules.setdefault("kubernetes.config", config)

import main  # noqa: E402


def _spec(**overrides):
    spec = {
        "agentSlug": "pool-coding",
        "appId": "agent-runtime-pool-coding",
        "runtimeClass": "coding",
        "runtimeIsolation": "shared",
        "environment": {"imageTag": "ghcr.io/example/dapr-agent-py-sandbox:latest"},
        "lifecycle": {"maxReplicas": 2},
    }
    spec.update(overrides)
    return spec


def test_build_deployment_stamps_runtime_app_id_labels_annotations_and_resources():
    dep = main._build_deployment(
        "agent-runtime-pool-coding",
        "workflow-builder",
        _spec(),
    )

    labels = dep["metadata"]["labels"]
    template = dep["spec"]["template"]
    template_labels = template["metadata"]["labels"]
    template_annotations = template["metadata"]["annotations"]
    container = template["spec"]["containers"][0]

    assert labels[main.LABEL_APP_ID] == "agent-runtime-pool-coding"
    assert template_labels[main.LABEL_APP_ID] == "agent-runtime-pool-coding"
    assert template_annotations[main.ANNO_APP_ID] == "agent-runtime-pool-coding"
    assert container["resources"] == {
        "requests": {"memory": "512Mi", "cpu": "250m"},
        "limits": {"memory": "2Gi", "cpu": "1500m"},
    }
    assert template["spec"]["topologySpreadConstraints"][0]["labelSelector"] == {
        "matchLabels": {main.LABEL_ROLE: "agent-runtime"}
    }


def test_wake_replicas_uses_shared_pool_max_replicas():
    assert main._wake_replicas(_spec(lifecycle={"maxReplicas": 2})) == 2
    assert (
        main._wake_replicas(
            _spec(runtimeIsolation="dedicated", lifecycle={"maxReplicas": 5})
        )
        == 1
    )


def test_capacity_status_reports_slots_and_dapr_workflow_capacity():
    status = main._capacity_status(
        _spec(
            lifecycle={
                "maxReplicas": 5,
                "slotsPerReplica": 4,
                "daprWorkflowLimitPerSidecar": 6,
            }
        ),
        desired_replicas=5,
        ready_replicas=3,
    )

    assert status == {
        "desiredReplicas": 5,
        "slotsPerReplica": 4,
        "effectiveSlots": 12,
        "daprWorkflowLimitPerSidecar": 6,
        "daprWorkflowEffectiveCapacity": 18,
        "admissionReady": True,
    }

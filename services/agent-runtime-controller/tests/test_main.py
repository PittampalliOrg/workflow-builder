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
        "modelSpec": "nvidia/qwen/qwen3-coder-480b-a35b-instruct",
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
    assert (
        template_annotations["agents.x-k8s.io/effective-llm-component"]
        == "llm-nvidia-qwen3-coder-480b"
    )
    assert template_annotations["agents.x-k8s.io/provider"] == "nvidia"
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


def test_capacity_status_uses_runtime_class_slot_env(monkeypatch):
    monkeypatch.setenv(
        "AGENT_RUNTIME_SLOTS_PER_REPLICA_JSON",
        '{"coding": 12, "office": 3}',
    )
    status = main._capacity_status(
        _spec(lifecycle={"maxReplicas": 1}),
        desired_replicas=1,
        ready_replicas=1,
    )

    assert status["slotsPerReplica"] == 12
    assert status["effectiveSlots"] == 12


def test_effective_model_status_exposes_provider_component_and_model():
    status = main._effective_model_status(
        _spec(modelSpec="nvidia/mistralai/devstral-2-123b-instruct-2512")
    )

    assert status == {
        "effectiveModelSpec": "nvidia/mistralai/devstral-2-123b-instruct-2512",
        "effectiveLlmComponent": "llm-nvidia-devstral-2-123b",
        "provider": "nvidia",
        "providerModel": "mistralai/devstral-2-123b-instruct-2512",
    }


def test_effective_model_status_supports_foundry_deepseek():
    status = main._effective_model_status(
        _spec(modelSpec="foundry/DeepSeek-V4-Flash")
    )

    assert status == {
        "effectiveModelSpec": "foundry/DeepSeek-V4-Flash",
        "effectiveLlmComponent": "llm-foundry-deepseek-v4-flash",
        "provider": "foundry",
        "providerModel": "DeepSeek-V4-Flash",
    }


def test_effective_model_status_supports_together_glm():
    status = main._effective_model_status(
        _spec(modelSpec="together/zai-org/GLM-5.1")
    )

    assert status == {
        "effectiveModelSpec": "together/zai-org/GLM-5.1",
        "effectiveLlmComponent": "llm-together-glm-51",
        "provider": "together",
        "providerModel": "zai-org/GLM-5.1",
    }


def test_effective_model_status_supports_together_deepseek_canary():
    status = main._effective_model_status(
        _spec(modelSpec="together/deepseek-ai/DeepSeek-V4-Pro")
    )

    assert status == {
        "effectiveModelSpec": "together/deepseek-ai/DeepSeek-V4-Pro",
        "effectiveLlmComponent": "llm-together-deepseek-v4-pro",
        "provider": "together",
        "providerModel": "deepseek-ai/DeepSeek-V4-Pro",
    }


def test_effective_model_status_supports_direct_deepseek():
    status = main._effective_model_status(
        _spec(modelSpec="deepseek/deepseek-v4-pro")
    )

    assert status == {
        "effectiveModelSpec": "deepseek/deepseek-v4-pro",
        "effectiveLlmComponent": "llm-deepseek-v4-pro",
        "provider": "deepseek",
        "providerModel": "deepseek-v4-pro",
    }


def test_effective_model_status_supports_direct_kimi():
    status = main._effective_model_status(_spec(modelSpec="kimi/kimi-k2.6"))

    assert status == {
        "effectiveModelSpec": "kimi/kimi-k2.6",
        "effectiveLlmComponent": "llm-kimi-k26",
        "provider": "kimi",
        "providerModel": "kimi-k2.6",
    }


def test_effective_model_status_supports_moonshot_kimi_alias():
    status = main._effective_model_status(_spec(modelSpec="moonshotai/kimi-k2.5"))

    assert status == {
        "effectiveModelSpec": "moonshotai/kimi-k2.5",
        "effectiveLlmComponent": "llm-kimi-k25",
        "provider": "kimi",
        "providerModel": "kimi-k2.5",
    }


def test_unknown_model_spec_is_rejected_instead_of_defaulting_to_anthropic():
    try:
        main._resolve_llm_component("nvidia/unknown-model")
    except ValueError as exc:
        assert "Unknown AgentRuntime modelSpec" in str(exc)
    else:
        raise AssertionError("expected ValueError")

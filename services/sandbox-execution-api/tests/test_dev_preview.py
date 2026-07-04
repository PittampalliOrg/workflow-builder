"""Dev-preview (executionId, service) scoping + Dapr-shadow guard (P0 multi-service).

These cover the two latent bugs that block N dev pods per execution:
  * per-service Sandbox/Secret names + service-scoped readiness/scale-down selectors
    (else service B's prod Deployment scales to 0 when service A becomes Ready, and
    readiness can return the wrong pod's IP);
  * preview-native provisions must NOT inherit the SEA-default Dapr-shadow env
    (PUBSUB_NAME=pubsub-dev / DAPR_CONFIG_STORE=disabled-dev), which points the pod at
    a `pubsub-dev` component that does not exist in the vcluster preview.
"""

import time as _time
from types import SimpleNamespace

import src.app as app_module
from src.app import (
    DevPreviewRequest,
    ExecutionClassConfig,
    build_dev_preview_sandbox_manifest,
)


class _FakeCustom:
    def __init__(self) -> None:
        self.creates: list[tuple[str, str, str, str, dict]] = []

    def create_namespaced_custom_object(
        self, *, group, version, namespace, plural, body
    ):
        self.creates.append((group, version, namespace, plural, body))
        return body


def _dev_class() -> ExecutionClassConfig:
    return ExecutionClassConfig(localQueue="")


def _container_env(manifest: dict) -> dict[str, str | None]:
    container = manifest["spec"]["podTemplate"]["spec"]["containers"][0]
    return {e["name"]: e.get("value") for e in container["env"]}


def test_dev_preview_names_are_service_scoped() -> None:
    exec_id = "exec-1"
    bff = app_module._dev_preview_sandbox_name(exec_id, "workflow-builder")
    orch = app_module._dev_preview_sandbox_name(exec_id, "workflow-orchestrator")
    assert bff != orch  # two services of one execution no longer collide
    assert "workflow-orchestrator" in orch
    assert app_module._dev_preview_secret_name(
        exec_id, "workflow-builder"
    ) != app_module._dev_preview_secret_name(exec_id, "workflow-orchestrator")


def test_dev_preview_names_backcompat_without_service() -> None:
    # In-flight single-service sessions are torn down by their stored name; a missing
    # `service` must reproduce the legacy names byte-for-byte.
    assert app_module._dev_preview_sandbox_name("exec-1") == "wfb-dev-preview-exec-1"
    assert app_module._dev_preview_secret_name("exec-1") == "dev-preview-secret-exec-1"


def test_dev_preview_sandbox_name_respects_63_char_limit() -> None:
    name = app_module._dev_preview_sandbox_name("e" * 90, "workflow-orchestrator")
    assert len(name) <= 63


def test_manifest_scopes_pod_and_cr_labels_by_service() -> None:
    manifest = build_dev_preview_sandbox_manifest(
        DevPreviewRequest(executionId="exec-1", service="workflow-orchestrator"),
        namespace="workflow-builder",
        class_config=_dev_class(),
    )
    pod_labels = manifest["spec"]["podTemplate"]["metadata"]["labels"]
    assert pod_labels["dev-preview-service"] == "workflow-orchestrator"
    assert pod_labels["workflow-execution-id"] == "exec-1"
    cr_labels = manifest["metadata"]["labels"]
    assert cr_labels["dev-preview-service"] == "workflow-orchestrator"
    assert "workflow-orchestrator" in manifest["metadata"]["name"]


def test_manifest_defaults_service_label_to_workflow_builder() -> None:
    manifest = build_dev_preview_sandbox_manifest(
        DevPreviewRequest(executionId="exec-1"),
        namespace="workflow-builder",
        class_config=_dev_class(),
    )
    labels = manifest["spec"]["podTemplate"]["metadata"]["labels"]
    assert labels["dev-preview-service"] == "workflow-builder"


def test_manifest_omits_shadow_env_when_disabled() -> None:
    manifest = build_dev_preview_sandbox_manifest(
        DevPreviewRequest(
            executionId="exec-1",
            service="workflow-orchestrator",
            needsDapr=True,
            applyDaprShadowDefaults=False,
        ),
        namespace="workflow-builder",
        class_config=_dev_class(),
    )
    env = _container_env(manifest)
    assert "PUBSUB_NAME" not in env
    assert "DAPR_CONFIG_STORE" not in env


def test_manifest_keeps_shadow_env_when_enabled() -> None:
    manifest = build_dev_preview_sandbox_manifest(
        DevPreviewRequest(
            executionId="exec-1",
            service="workflow-orchestrator",
            needsDapr=True,
            applyDaprShadowDefaults=True,
        ),
        namespace="workflow-builder",
        class_config=_dev_class(),
    )
    env = _container_env(manifest)
    assert env.get("PUBSUB_NAME") == "pubsub-dev"
    assert env.get("DAPR_CONFIG_STORE") == "disabled-dev"


def test_wait_for_dev_preview_ready_scopes_selector_by_service() -> None:
    captured: dict[str, str] = {}

    def list_pods(*, namespace, label_selector):
        captured["selector"] = label_selector
        return SimpleNamespace(items=[])

    core = SimpleNamespace(list_namespaced_pod=list_pods)
    app_module._wait_for_dev_preview_ready(
        core,
        namespace="workflow-builder",
        execution_id="exec-1",
        wait_seconds=0,  # returns immediately after one selector-scoped pod list
        service="workflow-orchestrator",
    )
    assert "workflow-execution-id=exec-1" in captured["selector"]
    assert "dev-preview-service=workflow-orchestrator" in captured["selector"]


def test_adopt_deferred_scale_down_scopes_selector_by_service(monkeypatch) -> None:
    monkeypatch.setattr(_time, "sleep", lambda *_a, **_k: None)
    captured: dict[str, str] = {}
    patched: dict[str, object] = {}
    ready_pod = SimpleNamespace(
        status=SimpleNamespace(
            container_statuses=[SimpleNamespace(name="dev", ready=True)]
        )
    )

    def list_pods(*, namespace, label_selector):
        captured["selector"] = label_selector
        return SimpleNamespace(items=[ready_pod])

    fake_core = SimpleNamespace(list_namespaced_pod=list_pods)

    def read_dep(*, name, namespace):
        return SimpleNamespace(
            spec=SimpleNamespace(replicas=2),
            metadata=SimpleNamespace(annotations={}),
        )

    def patch_dep(*, name, namespace, body):
        patched["name"] = name
        patched["replicas"] = body["spec"]["replicas"]

    fake_apps = SimpleNamespace(
        read_namespaced_deployment=read_dep,
        patch_namespaced_deployment=patch_dep,
    )
    monkeypatch.setattr(app_module, "_load_k8s_apps_client", lambda: fake_apps)
    monkeypatch.setattr(
        app_module, "_load_k8s_clients", lambda: (SimpleNamespace(), fake_core)
    )

    app_module._adopt_deferred_scale_down(
        namespace="workflow-builder",
        deployment="workflow-orchestrator",
        execution_id="exec-1",
        wait_seconds=1,
        service="workflow-orchestrator",
    )
    # Only THIS service's prod Deployment is scaled to 0, keyed on both labels.
    assert "workflow-execution-id=exec-1" in captured["selector"]
    assert "dev-preview-service=workflow-orchestrator" in captured["selector"]
    assert patched == {"name": "workflow-orchestrator", "replicas": 0}


def test_provision_forces_shadow_off_and_scopes_cr_when_preview_native(
    monkeypatch,
) -> None:
    fake_custom = _FakeCustom()
    monkeypatch.setenv("SANDBOX_EXECUTION_API_TOKEN", "token")
    monkeypatch.setattr(
        app_module,
        "_load_execution_classes",
        lambda: {"dev-preview": _dev_class()},
    )
    monkeypatch.setattr(app_module, "_load_k8s_apps_client", lambda: SimpleNamespace())
    monkeypatch.setattr(
        app_module, "_load_k8s_clients", lambda: (SimpleNamespace(), SimpleNamespace())
    )
    monkeypatch.setattr(
        app_module, "_load_k8s_custom_objects_client", lambda: fake_custom
    )
    monkeypatch.setattr(
        app_module,
        "_wait_for_dev_preview_ready",
        lambda *_a, **_k: ("ready", "10.0.0.9"),
    )

    response = app_module.provision_dev_preview(
        SimpleNamespace(headers={"authorization": "Bearer token"}),
        DevPreviewRequest(
            executionId="exec-1",
            service="workflow-orchestrator",
            needsDapr=True,
            previewNative=True,
            # Caller "forgot" to opt out — the server must force it off anyway.
            applyDaprShadowDefaults=True,
        ),
    )

    assert response["ready"] is True
    assert len(fake_custom.creates) == 1
    _, _, _, _, body = fake_custom.creates[0]
    env = _container_env(body)
    assert "PUBSUB_NAME" not in env
    assert "DAPR_CONFIG_STORE" not in env
    assert body["metadata"]["labels"]["dev-preview-service"] == "workflow-orchestrator"
    assert "workflow-orchestrator" in body["metadata"]["name"]

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


def test_needsdapr_uses_native_sidecar_with_readiness_probe() -> None:
    # daprd is a NATIVE sidecar (agent-host parity) for both previewNative adopt and
    # the host Dapr-shadow path; native injection works in-vcluster (the fail-open
    # cold-start race is handled by the injector gate + daprd-present assert, not by
    # dropping native-sidecar). The readiness-probe 0/1/1 tuning matches agent-host.
    for preview_native in (True, False):
        manifest = build_dev_preview_sandbox_manifest(
            DevPreviewRequest(
                executionId="exec-1",
                service="workflow-orchestrator",
                needsDapr=True,
                previewNative=preview_native,
            ),
            namespace="workflow-builder",
            class_config=_dev_class(),
        )
        ann = manifest["spec"]["podTemplate"]["metadata"]["annotations"]
        assert ann["dapr.io/enabled"] == "true"
        assert ann["dapr.io/enable-workflow"] == "true"
        assert ann["dapr.io/enable-native-sidecar"] == "true"
        assert ann["dapr.io/sidecar-readiness-probe-delay-seconds"] == "0"
        assert ann["dapr.io/sidecar-readiness-probe-period-seconds"] == "1"
        assert ann["dapr.io/sidecar-readiness-probe-timeout-seconds"] == "1"


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


def _ready_pod(name: str, *, daprd: str | None = None) -> SimpleNamespace:
    """A dev pod that is Ready. daprd: None=absent, "init"/"regular"/"label"=present."""
    init_cs = [SimpleNamespace(name="daprd")] if daprd == "init" else None
    regular = [SimpleNamespace(name="dev", ready=True)]
    if daprd == "regular":
        regular.append(SimpleNamespace(name="daprd"))
    labels = {"dapr.io/sidecar-injected": "true"} if daprd == "label" else {}
    return SimpleNamespace(
        metadata=SimpleNamespace(name=name, labels=labels),
        status=SimpleNamespace(
            container_statuses=regular, init_container_statuses=init_cs
        ),
    )


def test_wait_for_dapr_injector_available_true_when_ready(monkeypatch) -> None:
    apps = SimpleNamespace(
        read_namespaced_deployment=lambda *, name, namespace: SimpleNamespace(
            status=SimpleNamespace(available_replicas=1)
        )
    )
    assert app_module._wait_for_dapr_injector_available(apps, timeout_seconds=5)


def test_wait_for_dapr_injector_available_false_on_timeout(monkeypatch) -> None:
    # Missing/unavailable injector → returns False (caller proceeds; assert is backstop).
    def read_dep(*, name, namespace):
        raise RuntimeError("not found")

    apps = SimpleNamespace(read_namespaced_deployment=read_dep)
    assert not app_module._wait_for_dapr_injector_available(apps, timeout_seconds=0)


def test_dev_pod_has_daprd_checks_init_regular_and_label() -> None:
    assert app_module._dev_pod_has_daprd(_ready_pod("p", daprd="init"))
    assert app_module._dev_pod_has_daprd(_ready_pod("p", daprd="regular"))
    assert app_module._dev_pod_has_daprd(_ready_pod("p", daprd="label"))
    assert not app_module._dev_pod_has_daprd(_ready_pod("p", daprd=None))


def _scale_down_fakes(monkeypatch, pods_sequence):
    """Wire _adopt_deferred_scale_down against a scripted pod-list sequence."""
    monkeypatch.setattr(_time, "sleep", lambda *_a, **_k: None)
    state = {"i": 0, "deleted": [], "patched": {}}

    def list_pods(*, namespace, label_selector):
        idx = min(state["i"], len(pods_sequence) - 1)
        state["i"] += 1
        return SimpleNamespace(items=pods_sequence[idx])

    def del_pod(*, name, namespace):
        state["deleted"].append(name)

    def read_dep(*, name, namespace):
        return SimpleNamespace(
            spec=SimpleNamespace(replicas=1), metadata=SimpleNamespace(annotations={})
        )

    def patch_dep(*, name, namespace, body):
        state["patched"] = {"name": name, "replicas": body["spec"]["replicas"]}

    fake_core = SimpleNamespace(
        list_namespaced_pod=list_pods, delete_namespaced_pod=del_pod
    )
    fake_apps = SimpleNamespace(
        read_namespaced_deployment=read_dep, patch_namespaced_deployment=patch_dep
    )
    monkeypatch.setattr(app_module, "_load_k8s_apps_client", lambda: fake_apps)
    monkeypatch.setattr(
        app_module, "_load_k8s_clients", lambda: (SimpleNamespace(), fake_core)
    )
    return state


def test_adopt_scale_down_recreates_then_scales_when_daprd_appears(monkeypatch) -> None:
    # 1st poll: Ready but no daprd (fail-open race) → delete to force re-injection;
    # 2nd poll: the recreated pod has daprd → scale prod to 0.
    state = _scale_down_fakes(
        monkeypatch,
        [[_ready_pod("wfb-dev-x", daprd=None)], [_ready_pod("wfb-dev-x", daprd="init")]],
    )
    app_module._adopt_deferred_scale_down(
        namespace="wb",
        deployment="workflow-builder",
        execution_id="exec-1",
        wait_seconds=1,
        service="workflow-builder",
        needs_dapr=True,
    )
    assert state["deleted"] == ["wfb-dev-x"]
    assert state["patched"] == {"name": "workflow-builder", "replicas": 0}


def test_adopt_scale_down_leaves_prod_up_when_daprd_never_injects(monkeypatch) -> None:
    # daprd never appears → recreate once, then LEAVE PROD UP (no scale-to-0).
    state = _scale_down_fakes(monkeypatch, [[_ready_pod("wfb-dev-x", daprd=None)]])
    app_module._adopt_deferred_scale_down(
        namespace="wb",
        deployment="workflow-builder",
        execution_id="exec-1",
        wait_seconds=1,
        service="workflow-builder",
        needs_dapr=True,
    )
    assert state["deleted"] == ["wfb-dev-x"]  # recreated exactly once
    assert state["patched"] == {}  # prod NOT scaled to 0 (failsafe)


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
        app_module, "_wait_for_dapr_injector_available", lambda *_a, **_k: True
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


def test_list_dev_previews_groups_by_service(monkeypatch) -> None:
    monkeypatch.setenv("SANDBOX_EXECUTION_API_TOKEN", "token")
    bff_pod = SimpleNamespace(
        metadata=SimpleNamespace(
            labels={
                "dev-preview-service": "workflow-builder",
                "workflow-execution-id": "exec-1",
            }
        ),
        status=SimpleNamespace(
            pod_ip="10.0.0.1",
            conditions=[SimpleNamespace(type="Ready", status="True")],
        ),
    )
    orch_pod = SimpleNamespace(
        metadata=SimpleNamespace(
            labels={
                "dev-preview-service": "workflow-orchestrator",
                "workflow-execution-id": "exec-1",
            }
        ),
        status=SimpleNamespace(
            pod_ip="10.0.0.2",
            conditions=[SimpleNamespace(type="Ready", status="False")],
        ),
    )
    fake_core = SimpleNamespace(
        list_namespaced_pod=lambda *, namespace, label_selector: SimpleNamespace(
            items=[bff_pod, orch_pod]
        )
    )

    class FakeCustom:
        def list_namespaced_custom_object(
            self, *, group, version, namespace, plural, label_selector
        ):
            return {
                "items": [
                    {
                        "metadata": {
                            "name": "wfb-dev-preview-workflow-builder-exec-1",
                            "labels": {"dev-preview-service": "workflow-builder"},
                            "annotations": {
                                "wfb-dev-preview/adopt-deployment": "workflow-builder"
                            },
                        }
                    },
                    {
                        "metadata": {
                            "name": "wfb-dev-preview-workflow-orchestrator-exec-1",
                            "labels": {"dev-preview-service": "workflow-orchestrator"},
                        }
                    },
                ]
            }

    monkeypatch.setattr(
        app_module, "_load_k8s_custom_objects_client", lambda: FakeCustom()
    )
    monkeypatch.setattr(
        app_module, "_load_k8s_clients", lambda: (SimpleNamespace(), fake_core)
    )

    resp = app_module.list_dev_previews(
        SimpleNamespace(headers={"authorization": "Bearer token"}),
        executionId="exec-1",
    )
    assert resp["executionId"] == "exec-1"
    by_svc = {s["service"]: s for s in resp["services"]}
    assert set(by_svc) == {"workflow-builder", "workflow-orchestrator"}
    assert by_svc["workflow-builder"]["ready"] is True
    assert by_svc["workflow-builder"]["podIP"] == "10.0.0.1"
    assert by_svc["workflow-builder"]["adoptDeployment"] == "workflow-builder"
    assert by_svc["workflow-orchestrator"]["ready"] is False
    assert by_svc["workflow-orchestrator"]["podIP"] == "10.0.0.2"
    assert by_svc["workflow-orchestrator"]["adoptDeployment"] is None

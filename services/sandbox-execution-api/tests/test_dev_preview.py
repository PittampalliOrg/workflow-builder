"""Dev-preview (executionId, service) scoping + Dapr-shadow guard (P0 multi-service).

These cover the two latent bugs that block N dev pods per execution:
  * per-service Sandbox/Secret names + service-scoped readiness/scale-down selectors
    (else service B's prod Deployment scales to 0 when service A becomes Ready, and
    readiness can return the wrong pod's IP);
  * preview-native provisions must NOT inherit the SEA-default Dapr-shadow env
    (PUBSUB_NAME=pubsub-dev / DAPR_CONFIG_STORE=disabled-dev), which points the pod at
    a `pubsub-dev` component that does not exist in the vcluster preview.
"""

import hashlib
import json
import time as _time
from concurrent.futures import ThreadPoolExecutor
from threading import Lock
from types import SimpleNamespace

import pytest
from fastapi import HTTPException
from pydantic import ValidationError

import src.app as app_module
from src.app import (
    DevPreviewRequest,
    ExecutionClassConfig,
    build_dev_preview_sandbox_manifest,
)


def _sidecar_env(manifest: dict) -> dict[str, str | None] | None:
    """Env of the dev-sync sidecar container (None if this manifest has no sidecar)."""
    for c in manifest["spec"]["podTemplate"]["spec"]["containers"]:
        if c["name"] == "dev-sync":
            return {e["name"]: e.get("value") for e in c.get("env", [])}
    return None


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


def test_dev_preview_rejects_malformed_sync_leaves() -> None:
    with pytest.raises(ValidationError):
        DevPreviewRequest(executionId="exec-1", syncToken="short")
    with pytest.raises(ValidationError):
        DevPreviewRequest(executionId="exec-1", syncAgentToken="A" * 64)


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


def test_preview_native_omits_internal_grpc_port_override() -> None:
    # internal-grpc-port is app-level contract (daprd's peer-dial port, caller-chosen).
    # A preview-native adopt pod must service-invoke NON-adopted prod peers (prod sets
    # no override → Dapr default), so it must NOT set the 3502 override, else
    # adopted→prod invoke (orchestrator→function-router) hits connection-refused on 3502.
    manifest = build_dev_preview_sandbox_manifest(
        DevPreviewRequest(
            executionId="exec-1",
            service="workflow-orchestrator",
            needsDapr=True,
            previewNative=True,
        ),
        namespace="workflow-builder",
        class_config=_dev_class(),
    )
    ann = manifest["spec"]["podTemplate"]["metadata"]["annotations"]
    assert "dapr.io/internal-grpc-port" not in ann
    # Native sidecar + placement are unaffected (agent-host dispatch is a placement-
    # routed child workflow, so the port change doesn't touch it).
    assert ann["dapr.io/enable-native-sidecar"] == "true"


def test_preview_native_tls_terminator_has_admissible_cpu_limit() -> None:
    manifest = build_dev_preview_sandbox_manifest(
        DevPreviewRequest(
            executionId="exec-1",
            service="workflow-builder",
            previewNative=True,
            adoptTlsTerminator=True,
        ),
        namespace="workflow-builder",
        class_config=_dev_class(),
    )

    pod = manifest["spec"]["podTemplate"]["spec"]
    tls = next(c for c in pod["containers"] if c["name"] == "tls-terminator")
    assert tls["resources"]["requests"]["cpu"] == "10m"
    assert tls["resources"]["limits"]["cpu"] == "200m"


def test_preview_native_manifest_satisfies_restricted_pod_security() -> None:
    manifest = build_dev_preview_sandbox_manifest(
        DevPreviewRequest(
            executionId="exec-1",
            service="workflow-builder",
            previewNative=True,
            syncMode="sidecar",
            adoptTlsTerminator=True,
        ),
        namespace="workflow-builder",
        class_config=_dev_class(),
    )

    pod = manifest["spec"]["podTemplate"]["spec"]
    assert pod["securityContext"] == {
        "runAsNonRoot": True,
        "runAsUser": 1001,
        "runAsGroup": 1001,
        "fsGroup": 1001,
        "seccompProfile": {"type": "RuntimeDefault"},
    }
    for container in [*pod.get("initContainers", []), *pod["containers"]]:
        security = container["securityContext"]
        assert security["allowPrivilegeEscalation"] is False
        assert security["runAsNonRoot"] is True
        assert security["runAsUser"] == 1001
        assert security["runAsGroup"] == 1001
        assert security["capabilities"] == {"drop": ["ALL"]}


def test_host_shadow_keeps_internal_grpc_port_override() -> None:
    # The host Dapr-shadow path (needsDapr, not previewNative) keeps the 3502 override
    # for agent-host parity.
    manifest = build_dev_preview_sandbox_manifest(
        DevPreviewRequest(
            executionId="exec-1",
            service="workflow-orchestrator",
            needsDapr=True,
            previewNative=False,
        ),
        namespace="workflow-builder",
        class_config=_dev_class(),
    )
    ann = manifest["spec"]["podTemplate"]["metadata"]["annotations"]
    assert ann["dapr.io/internal-grpc-port"] == "3502"


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
        [
            [_ready_pod("wfb-dev-x", daprd=None)],
            [_ready_pod("wfb-dev-x", daprd="init")],
        ],
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
    monkeypatch.setenv("DEV_PREVIEW_PLATFORM_SCOPE", "vcluster")
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


@pytest.mark.parametrize("platform_scope", [None, "physical"])
def test_provision_denies_preview_native_outside_vcluster(
    monkeypatch, platform_scope
) -> None:
    monkeypatch.setenv("SANDBOX_EXECUTION_API_TOKEN", "token")
    if platform_scope is None:
        monkeypatch.delenv("DEV_PREVIEW_PLATFORM_SCOPE", raising=False)
    else:
        monkeypatch.setenv("DEV_PREVIEW_PLATFORM_SCOPE", platform_scope)

    def load_classes():
        raise AssertionError("cluster clients must not be loaded")

    monkeypatch.setattr(app_module, "_load_execution_classes", load_classes)

    with pytest.raises(HTTPException) as caught:
        app_module.provision_dev_preview(
            SimpleNamespace(headers={"authorization": "Bearer token"}),
            DevPreviewRequest(
                executionId="exec-1",
                service="workflow-builder",
                previewNative=True,
                adoptDeployment="workflow-builder",
            ),
        )

    assert caught.value.status_code == 403
    assert "only inside a vCluster" in caught.value.detail


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


# --- vcluster-previews list perf (task #18): parallel probe + burst cache + per-preview
#     error isolation. Fake k8s clients accept _request_timeout (the list now bounds
#     each call). --------------------------------------------------------------------


def _vc_ns(host_name, preview_name=None, phase=None):
    labels = {"vcluster-preview-name": preview_name} if preview_name else {}
    return SimpleNamespace(
        metadata=SimpleNamespace(name=host_name, labels=labels),
        status=SimpleNamespace(phase=phase),
    )


def _vc_ready_pod():
    return SimpleNamespace(
        metadata=SimpleNamespace(
            name="workflow-builder-xyz",
            labels={
                "app": "workflow-builder",
                "vcluster.loft.sh/namespace": "workflow-builder",
            },
        ),
        status=SimpleNamespace(
            conditions=[SimpleNamespace(type="Ready", status="True")]
        ),
    )


def test_list_vcluster_previews_parallel_and_burst_cached(monkeypatch) -> None:
    app_module._vcluster_previews_cache["data"] = None
    monkeypatch.setattr(app_module, "_require_internal", lambda *_a, **_k: None)
    monkeypatch.setattr(
        app_module, "_agent_workflow_host_namespace", lambda: "workflow-builder"
    )
    ns_calls = {"n": 0}

    def list_namespace(*, label_selector, **_k):
        ns_calls["n"] += 1
        return SimpleNamespace(
            items=[_vc_ns("vcluster-gan-a", "gan-a"), _vc_ns("vcluster-gan-b", "gan-b")]
        )

    def read_job_status(*, name, namespace, **_k):
        return SimpleNamespace(status=SimpleNamespace(active=1, succeeded=0, failed=0))

    def list_pod(*, namespace, **_k):
        items = [_vc_ready_pod()] if namespace == "vcluster-gan-a" else []
        return SimpleNamespace(items=items)

    fake_core = SimpleNamespace(
        list_namespace=list_namespace,
        list_namespaced_pod=list_pod,
        # phase now confirms ns existence with a real read (list-pods-in-missing-ns
        # is 200+empty in k8s); these previews' namespaces all exist.
        read_namespace=lambda *, name, **_k: SimpleNamespace(
            metadata=SimpleNamespace(name=name)
        ),
    )
    fake_batch = SimpleNamespace(read_namespaced_job_status=read_job_status)
    monkeypatch.setattr(
        app_module, "_load_k8s_clients", lambda: (fake_batch, fake_core)
    )

    req = SimpleNamespace()
    out = app_module.list_vcluster_previews(req)
    by = {p["name"]: p for p in out["previews"]}
    assert set(by) == {"gan-a", "gan-b"}
    assert by["gan-a"]["ready"] is True and by["gan-a"]["phase"] == "ready"
    assert by["gan-b"]["ready"] is False and by["gan-b"]["phase"] == "provisioning"
    assert by["gan-a"]["url"].startswith("https://wfb-gan-a.")
    assert ns_calls["n"] == 1
    # Burst cache: a second call within TTL must NOT re-scan the cluster.
    assert app_module.list_vcluster_previews(req) == out
    assert ns_calls["n"] == 1


def test_list_vcluster_previews_isolates_a_failing_preview(monkeypatch) -> None:
    app_module._vcluster_previews_cache["data"] = None
    monkeypatch.setattr(app_module, "_require_internal", lambda *_a, **_k: None)
    monkeypatch.setattr(
        app_module, "_agent_workflow_host_namespace", lambda: "workflow-builder"
    )

    def list_namespace(*, label_selector, **_k):
        return SimpleNamespace(
            items=[_vc_ns("vcluster-ok", "ok"), _vc_ns("vcluster-bad", "bad")]
        )

    def read_job_status(*, name, namespace, **_k):
        return SimpleNamespace(status=SimpleNamespace(active=1, succeeded=0, failed=0))

    def list_pod(*, namespace, **_k):
        if namespace == "vcluster-bad":
            raise RuntimeError("simulated k8s timeout")
        return SimpleNamespace(items=[_vc_ready_pod()])

    fake_core = SimpleNamespace(
        list_namespace=list_namespace,
        list_namespaced_pod=list_pod,
        # phase now confirms ns existence with a real read (list-pods-in-missing-ns
        # is 200+empty in k8s); these previews' namespaces all exist.
        read_namespace=lambda *, name, **_k: SimpleNamespace(
            metadata=SimpleNamespace(name=name)
        ),
    )
    fake_batch = SimpleNamespace(read_namespaced_job_status=read_job_status)
    monkeypatch.setattr(
        app_module, "_load_k8s_clients", lambda: (fake_batch, fake_core)
    )

    out = app_module.list_vcluster_previews(SimpleNamespace())
    # The failing preview is dropped (probe error -> "absent"), the healthy one lists.
    assert {p["name"] for p in out["previews"]} == {"ok"}


def test_sidecar_forwards_dev_sync_commands_json() -> None:
    # The registry's deps/test command allowlist must reach the sidecar as
    # DEV_SYNC_COMMANDS_JSON (which the sidecar parses once at boot for /__run).
    manifest = build_dev_preview_sandbox_manifest(
        DevPreviewRequest(
            executionId="exec-1",
            service="workflow-orchestrator",
            syncMode="sidecar",
            devSyncCommands={
                "deps": "pip install -r requirements.txt && touch /app/app.py",
                "contract": "python -m pytest tests/test_workflow_data_activity_migration.py -q",
            },
        ),
        namespace="workflow-builder",
        class_config=_dev_class(),
    )
    env = _sidecar_env(manifest)
    assert env is not None, "sidecar container should exist in sidecar mode"
    assert "DEV_SYNC_COMMANDS_JSON" in env
    assert json.loads(env["DEV_SYNC_COMMANDS_JSON"]) == {
        "deps": "pip install -r requirements.txt && touch /app/app.py",
        "contract": "python -m pytest tests/test_workflow_data_activity_migration.py -q",
    }


def test_sidecar_omits_commands_json_when_none() -> None:
    manifest = build_dev_preview_sandbox_manifest(
        DevPreviewRequest(
            executionId="exec-1", service="workflow-orchestrator", syncMode="sidecar"
        ),
        namespace="workflow-builder",
        class_config=_dev_class(),
    )
    env = _sidecar_env(manifest)
    assert env is not None
    assert "DEV_SYNC_COMMANDS_JSON" not in env


def test_sidecar_mode_stamps_exec_bridge_env_into_app_container() -> None:
    # #40: /__run must execute in the APP container (the sidecar image is
    # node-only — the orchestrator's pytest exits 127 there). The dev image's
    # exec bridge lives in the app container and needs ITS OWN token + allowlist
    # env (it fails closed without them); the sidecar needs the bridge port.
    commands = {
        "deps": "pip install -r requirements.txt && touch /app/app.py",
        "contract": "python -m pytest tests/test_workflow_data_activity_migration.py -q",
    }
    manifest = build_dev_preview_sandbox_manifest(
        DevPreviewRequest(
            executionId="exec-1",
            service="workflow-orchestrator",
            syncMode="sidecar",
            syncToken="a" * 64,
            syncAgentToken="b" * 64,
            devSyncCommands=commands,
            devSyncAllowedRoots=["core", "app.py"],
        ),
        namespace="workflow-builder",
        class_config=_dev_class(),
    )
    app_env = _container_env(manifest)
    assert app_env["DEV_SYNC_EXEC_PORT"] == "8002"
    assert app_env["DEV_SYNC_DEST"] == "/app"
    assert app_env["DEV_SYNC_TOKEN"] == "a" * 64
    assert json.loads(app_env["DEV_SYNC_COMMANDS_JSON"]) == commands
    # #41: the sidecar's route-add restart signal file, polled by the Vite
    # plugin (only meaningful for node/vite services; python ones ignore it).
    assert (
        app_env["WFB_DEV_SYNC_RESTART_SIGNAL"] == "/app/.dev-sync-restart-request.json"
    )
    # The sidecar learns where the bridge listens (pod-localhost proxy target).
    sidecar_env = _sidecar_env(manifest)
    assert sidecar_env is not None
    assert sidecar_env["DEV_SYNC_EXEC_PORT"] == "8002"
    assert (
        sidecar_env["DEV_SYNC_AGENT_TOKEN_SHA256"]
        == hashlib.sha256(("b" * 64).encode("utf-8")).hexdigest()
    )
    assert sidecar_env["DEV_SYNC_SERVICE"] == "workflow-orchestrator"
    assert json.loads(sidecar_env["DEV_SYNC_ALLOWED_ROOTS_JSON"]) == ["app.py", "core"]


def test_plugin_mode_has_no_exec_bridge_env() -> None:
    # Plugin mode (the BFF default): /__sync is the in-process Vite plugin, no
    # sidecar container — the WFB_* plugin env applies and none of the bridge
    # env should leak in.
    manifest = build_dev_preview_sandbox_manifest(
        DevPreviewRequest(
            executionId="exec-1",
            service="workflow-builder",
            syncMode="plugin",
            syncToken="a" * 64,
            syncAgentToken="b" * 64,
            devSyncAllowedRoots=["src", "static"],
        ),
        namespace="workflow-builder",
        class_config=_dev_class(),
    )
    app_env = _container_env(manifest)
    assert app_env["WFB_DEV_SYNC_ENABLED"] == "true"
    assert app_env["WFB_DEV_SYNC_TOKEN"] == "a" * 64
    assert (
        app_env["WFB_DEV_SYNC_AGENT_TOKEN_SHA256"]
        == hashlib.sha256(("b" * 64).encode("utf-8")).hexdigest()
    )
    assert app_env["WFB_DEV_SYNC_SERVICE"] == "workflow-builder"
    assert json.loads(app_env["WFB_DEV_SYNC_ALLOWED_ROOTS_JSON"]) == ["src", "static"]
    for key in (
        "DEV_SYNC_EXEC_PORT",
        "DEV_SYNC_TOKEN",
        "DEV_SYNC_COMMANDS_JSON",
        "WFB_DEV_SYNC_RESTART_SIGNAL",
    ):
        assert key not in app_env


def test_adopted_container_env_retains_only_operational_config_and_scoped_leaves() -> (
    None
):
    inherited = [
        {"name": "AGENT_RUNTIME_CODEX_CLI_DEFAULT_IMAGE", "value": "image@sha256:x"},
        {"name": "CODEX_CLI_APP_ID", "value": "cli-agent-py"},
        {"name": "DAPR_CONFIG_STORE", "value": "configstore"},
        {"name": "PREVIEW_CONTROL_BROKER_URL", "value": "http://broker:3000"},
        {
            "name": "PREVIEW_CONTROL_CAPABILITY_TOKEN",
            "valueFrom": {
                "secretKeyRef": {
                    "name": "preview-control-credentials",
                    "key": "control-token",
                }
            },
        },
        {
            "name": "PREVIEW_ACTION_INTERNAL_TOKEN",
            "valueFrom": {
                "secretKeyRef": {
                    "name": "preview-control-credentials",
                    "key": "action-token",
                }
            },
        },
        {
            "name": "SANDBOX_EXECUTION_API_TOKEN",
            "valueFrom": {
                "secretKeyRef": {
                    "name": "preview-control-credentials",
                    "key": "sandbox-token",
                }
            },
        },
        {
            "name": "PREVIEW_DEV_SYNC_MINT_TOKEN",
            "valueFrom": {
                "secretKeyRef": {
                    "name": "preview-control-credentials",
                    "key": "sync-token",
                }
            },
        },
        {
            "name": "PREVIEW_ENVIRONMENT_NAME",
            "valueFrom": {
                "configMapKeyRef": {
                    "name": "preview-environment-identity",
                    "key": "environment-name",
                }
            },
        },
        {"name": "WFB_DEV_SYNC_TOKEN", "value": "fleet-root"},
        {"name": "DEV_SYNC_AGENT_TOKEN", "value": "raw-agent-leaf"},
        {"name": "PREVIEW_CONTROL_CAPABILITY_ROOT_TOKEN", "value": "control-root"},
        {
            "name": "PREVIEW_RUNTIME_CAPABILITY_TOKEN",
            "valueFrom": {
                "secretKeyRef": {
                    "name": "preview-control-credentials",
                    "key": "runtime-token",
                }
            },
        },
        {
            "name": "GITHUB_TOKEN",
            "valueFrom": {
                "secretKeyRef": {
                    "name": "workflow-builder-secrets",
                    "key": "GITHUB_TOKEN",
                }
            },
        },
        {
            "name": "PREVIEW_CONTROL_CAPABILITY_TOKEN",
            "valueFrom": {"fieldRef": {"fieldPath": "metadata.name"}},
        },
    ]

    filtered = app_module._filter_adopted_container_env(inherited)
    assert filtered is not None
    by_name = {entry["name"]: entry for entry in filtered}
    assert set(by_name) == {
        "AGENT_RUNTIME_CODEX_CLI_DEFAULT_IMAGE",
        "CODEX_CLI_APP_ID",
        "DAPR_CONFIG_STORE",
        "PREVIEW_ACTION_INTERNAL_TOKEN",
        "PREVIEW_CONTROL_BROKER_URL",
        "PREVIEW_CONTROL_CAPABILITY_TOKEN",
        "PREVIEW_DEV_SYNC_MINT_TOKEN",
        "PREVIEW_ENVIRONMENT_NAME",
        "SANDBOX_EXECUTION_API_TOKEN",
    }
    assert (
        by_name["PREVIEW_DEV_SYNC_MINT_TOKEN"]["valueFrom"]["secretKeyRef"]["key"]
        == "sync-token"
    )


def test_adopted_dev_manifest_overrides_inherited_sync_root_with_receiver_leaf() -> (
    None
):
    request = DevPreviewRequest(
        executionId="exec-1",
        service="workflow-builder",
        previewNative=True,
        syncToken="a" * 64,
        syncAgentToken="b" * 64,
        adoptInheritedEnv=[
            {"name": "WFB_DEV_SYNC_TOKEN", "value": "fleet-root"},
            {
                "name": "PREVIEW_DEV_SYNC_MINT_TOKEN",
                "valueFrom": {
                    "secretKeyRef": {
                        "name": "preview-control-credentials",
                        "key": "sync-token",
                    }
                },
            },
        ],
    )
    manifest = build_dev_preview_sandbox_manifest(
        request, namespace="workflow-builder", class_config=_dev_class()
    )
    entries = manifest["spec"]["podTemplate"]["spec"]["containers"][0]["env"]
    by_name = {entry["name"]: entry for entry in entries}
    assert by_name["WFB_DEV_SYNC_TOKEN"] == {
        "name": "WFB_DEV_SYNC_TOKEN",
        "value": "a" * 64,
    }
    assert (
        by_name["WFB_DEV_SYNC_AGENT_TOKEN_SHA256"]["value"]
        == hashlib.sha256(("b" * 64).encode("utf-8")).hexdigest()
    )
    assert "WFB_DEV_SYNC_AGENT_TOKEN" not in by_name
    assert (
        by_name["PREVIEW_DEV_SYNC_MINT_TOKEN"]["valueFrom"]["secretKeyRef"]["key"]
        == "sync-token"
    )


def test_list_vcluster_previews_ttl_zero_disables_cache(monkeypatch) -> None:
    app_module._vcluster_previews_cache["data"] = None
    monkeypatch.setattr(app_module, "_require_internal", lambda *_a, **_k: None)
    monkeypatch.setattr(app_module, "_VCLUSTER_PREVIEWS_CACHE_TTL", 0.0)
    calls = {"n": 0}

    def compute():
        calls["n"] += 1
        return {"previews": []}

    monkeypatch.setattr(app_module, "_compute_vcluster_previews", compute)
    req = SimpleNamespace()
    app_module.list_vcluster_previews(req)
    app_module.list_vcluster_previews(req)
    assert calls["n"] == 2


# ---------------------------------------------------------------------------
# B5: restore-all orphan sweep (_adopt_restore_orphans)
# ---------------------------------------------------------------------------


class _LeaseApiError(Exception):
    def __init__(self, status: int) -> None:
        super().__init__(f"lease api status {status}")
        self.status = status


class _FakeAdoptionCoordination:
    def __init__(self) -> None:
        self._lock = Lock()
        self.lease: dict | None = None
        self.deletes: list[dict] = []

    def create_namespaced_lease(self, *, namespace, body):
        with self._lock:
            if self.lease is not None:
                raise _LeaseApiError(409)
            self.lease = json.loads(json.dumps(body))
            self.lease["metadata"]["resourceVersion"] = "1"
            return self.lease

    def read_namespaced_lease(self, *, name, namespace):
        with self._lock:
            if self.lease is None:
                raise _LeaseApiError(404)
            return json.loads(json.dumps(self.lease))

    def list_namespaced_lease(self, *, namespace, label_selector):
        with self._lock:
            return {
                "items": []
                if self.lease is None
                else [json.loads(json.dumps(self.lease))]
            }

    def delete_namespaced_lease(self, *, name, namespace, body):
        with self._lock:
            if self.lease is None:
                raise _LeaseApiError(404)
            assert body["preconditions"]["resourceVersion"] == "1"
            self.deletes.append(body)
            self.lease = None


def test_adoption_lease_is_create_only_idempotent_and_exactly_labeled() -> None:
    coordination = _FakeAdoptionCoordination()
    first = app_module._acquire_dev_preview_adoption_lease(
        coordination,
        namespace="workflow-builder",
        deployment="workflow-builder",
        execution_id="execution-1",
        service="workflow-builder",
    )
    second = app_module._acquire_dev_preview_adoption_lease(
        coordination,
        namespace="workflow-builder",
        deployment="workflow-builder",
        execution_id="execution-1",
        service="workflow-builder",
    )

    assert first == second
    assert coordination.lease["metadata"]["name"] == "wfb-dev-adopt-workflow-builder"
    assert coordination.lease["metadata"]["labels"] == {
        "app": "wfb-dev-preview-adoption",
        "wfb-dev-preview/adopt-deployment": "workflow-builder",
        "dev-preview-service": "workflow-builder",
    }
    assert (
        coordination.lease["metadata"]["annotations"]["wfb-dev-preview/adopt-holder"]
        == first
    )


def test_simultaneous_adopters_have_exactly_one_lease_winner() -> None:
    coordination = _FakeAdoptionCoordination()

    def acquire(execution_id: str):
        try:
            return (
                "ok",
                app_module._acquire_dev_preview_adoption_lease(
                    coordination,
                    namespace="workflow-builder",
                    deployment="workflow-builder",
                    execution_id=execution_id,
                    service="workflow-builder",
                ),
            )
        except HTTPException as exc:
            return ("error", exc.status_code)

    with ThreadPoolExecutor(max_workers=2) as pool:
        outcomes = list(pool.map(acquire, ["execution-1", "execution-2"]))

    assert sum(status == "ok" for status, _ in outcomes) == 1
    assert sum(value == 409 for status, value in outcomes if status == "error") == 1


def test_stale_unclaimed_adoption_lease_is_recovered_after_grace() -> None:
    deployment = _dep("workflow-builder", annotated=False, replicas=1)
    apps, custom, _patched = _sweep_fakes([deployment], sandbox_items=[])
    coordination = _FakeAdoptionCoordination()
    app_module._acquire_dev_preview_adoption_lease(
        coordination,
        namespace="workflow-builder",
        deployment="workflow-builder",
        execution_id="execution-stale",
        service="workflow-builder",
    )
    coordination.lease["spec"]["renewTime"] = "2020-01-01T00:00:00Z"

    result = app_module._adopt_restore_orphans(
        apps,
        custom,
        namespace="workflow-builder",
        coordination=coordination,
    )

    assert result["releasedLeases"] == ["wfb-dev-adopt-workflow-builder"]
    assert coordination.lease is None


def test_recent_or_claimed_adoption_lease_is_never_recovered() -> None:
    deployment = _dep("workflow-builder", annotated=False, replicas=1)
    coordination = _FakeAdoptionCoordination()
    holder = app_module._acquire_dev_preview_adoption_lease(
        coordination,
        namespace="workflow-builder",
        deployment="workflow-builder",
        execution_id="execution-live",
        service="workflow-builder",
    )
    apps, recent_custom, _patched = _sweep_fakes([deployment], sandbox_items=[])
    recent = app_module._adopt_restore_orphans(
        apps,
        recent_custom,
        namespace="workflow-builder",
        coordination=coordination,
    )
    assert recent["releasedLeases"] == []

    coordination.lease["spec"]["renewTime"] = "2020-01-01T00:00:00Z"
    claimed_sandbox = {
        "metadata": {
            "annotations": {
                "wfb-dev-preview/adopt-deployment": "workflow-builder",
                "wfb-dev-preview/adopt-holder": holder,
            }
        }
    }
    apps, claimed_custom, _patched = _sweep_fakes(
        [deployment], sandbox_items=[claimed_sandbox]
    )
    claimed = app_module._adopt_restore_orphans(
        apps,
        claimed_custom,
        namespace="workflow-builder",
        coordination=coordination,
    )
    assert claimed["releasedLeases"] == []
    assert coordination.lease is not None


def _dep(name: str, *, annotated: bool, replicas: int):
    return SimpleNamespace(
        metadata=SimpleNamespace(
            name=name,
            annotations=(
                {app_module.DEV_PREVIEW_ORIGINAL_REPLICAS_ANNOTATION: "2"}
                if annotated
                else {}
            ),
        ),
        spec=SimpleNamespace(replicas=replicas),
    )


def _sweep_fakes(deployments, sandbox_items):
    patched: list[tuple[str, dict]] = []

    def read_dep(name, namespace):
        for d in deployments:
            if d.metadata.name == name:
                return d
        raise RuntimeError("not found")

    def patch_dep(name, namespace, body):
        patched.append((name, body))

    apps = SimpleNamespace(
        list_namespaced_deployment=lambda namespace: SimpleNamespace(items=deployments),
        read_namespaced_deployment=read_dep,
        patch_namespaced_deployment=patch_dep,
    )
    custom = SimpleNamespace(
        list_namespaced_custom_object=lambda **_k: {"items": sandbox_items}
    )
    return apps, custom, patched


def test_restore_orphans_restores_unclaimed_zero_replica_deployment() -> None:
    orphan = _dep("workflow-orchestrator", annotated=True, replicas=0)
    apps, custom, patched = _sweep_fakes([orphan], sandbox_items=[])

    result = app_module._adopt_restore_orphans(
        apps, custom, namespace="workflow-builder"
    )

    assert result["restored"] == ["workflow-orchestrator"]
    assert len(patched) == 1
    name, body = patched[0]
    assert name == "workflow-orchestrator"
    assert body["spec"]["replicas"] == 2  # stashed original count
    assert (
        body["metadata"]["annotations"][
            app_module.DEV_PREVIEW_ORIGINAL_REPLICAS_ANNOTATION
        ]
        is None
    )


def test_restore_orphans_leaves_deployment_claimed_by_live_sandbox() -> None:
    claimed = _dep("workflow-builder", annotated=True, replicas=0)
    sandbox = {
        "metadata": {
            "annotations": {"wfb-dev-preview/adopt-deployment": "workflow-builder"}
        }
    }
    apps, custom, patched = _sweep_fakes([claimed], sandbox_items=[sandbox])

    result = app_module._adopt_restore_orphans(
        apps, custom, namespace="workflow-builder"
    )

    assert result["restored"] == []
    assert patched == []


def test_restore_orphans_skips_running_deployment_with_stale_annotation() -> None:
    # Annotation present but replicas already > 0: restoring would rewrite live
    # scale from a stale stash — must be left alone.
    running = _dep("function-router", annotated=True, replicas=3)
    apps, custom, patched = _sweep_fakes([running], sandbox_items=[])

    result = app_module._adopt_restore_orphans(
        apps, custom, namespace="workflow-builder"
    )

    assert result["restored"] == []
    assert patched == []


def test_restore_orphans_ignores_unannotated_deployments() -> None:
    plain = _dep("mcp-gateway", annotated=False, replicas=0)
    apps, custom, patched = _sweep_fakes([plain], sandbox_items=[])

    result = app_module._adopt_restore_orphans(
        apps, custom, namespace="workflow-builder"
    )

    assert result["restored"] == []
    assert patched == []


def test_restore_orphans_noop_when_sandbox_list_fails() -> None:
    # If the claimed-set cannot be established, restore NOTHING (better an
    # orphan at 0 than breaking an active adopt).
    orphan = _dep("workflow-orchestrator", annotated=True, replicas=0)
    apps, _custom, patched = _sweep_fakes([orphan], sandbox_items=[])

    def boom(**_k):
        raise RuntimeError("apiserver unavailable")

    custom = SimpleNamespace(list_namespaced_custom_object=boom)

    result = app_module._adopt_restore_orphans(
        apps, custom, namespace="workflow-builder"
    )

    assert result == {"restored": [], "skipped": "sandbox-list-failed"}
    assert patched == []


def test_restore_orphans_continues_past_a_failing_restore() -> None:
    bad = _dep("workflow-builder", annotated=True, replicas=0)
    good = _dep("workflow-orchestrator", annotated=True, replicas=0)
    apps, custom, patched = _sweep_fakes([bad, good], sandbox_items=[])
    original_patch = apps.patch_namespaced_deployment

    def patch_dep(name, namespace, body):
        if name == "workflow-builder":
            raise RuntimeError("conflict")
        original_patch(name, namespace, body)

    apps.patch_namespaced_deployment = patch_dep

    result = app_module._adopt_restore_orphans(
        apps, custom, namespace="workflow-builder"
    )

    assert result["restored"] == ["workflow-orchestrator"]
    assert [name for name, _ in patched] == ["workflow-orchestrator"]


def test_periodic_cleanup_restores_adopt_orphans_when_identity_cleanup_fails(
    monkeypatch,
) -> None:
    batch = object()
    core = object()
    apps = object()
    custom = object()
    restored = {"restored": ["workflow-builder"]}
    calls: list[tuple[object, object, str]] = []

    monkeypatch.setattr(app_module, "_load_k8s_clients", lambda: (batch, core))
    monkeypatch.setattr(app_module, "_load_k8s_rbac_client", object)
    monkeypatch.setattr(app_module, "_load_k8s_coordination_client", object)
    monkeypatch.setattr(app_module, "_load_k8s_apps_client", lambda: apps)
    monkeypatch.setattr(app_module, "_load_k8s_custom_objects_client", lambda: custom)
    monkeypatch.setattr(
        app_module,
        "_preview_identity_cleanup_once",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(
            RuntimeError("identity failed")
        ),
    )
    monkeypatch.setattr(
        app_module,
        "_preview_identity_orphan_cleanup_once",
        lambda *_args, **_kwargs: {"failed": 0},
    )
    monkeypatch.setattr(
        app_module,
        "_agent_workflow_host_namespace",
        lambda: "preview-workflow-builder",
    )

    def restore_orphans(received_apps, received_custom, *, namespace, coordination):
        assert coordination is not None
        calls.append((received_apps, received_custom, namespace))
        return restored

    monkeypatch.setattr(app_module, "_adopt_restore_orphans", restore_orphans)

    result = app_module._preview_periodic_cleanup_once()

    assert result["failures"] == ["identity"]
    assert result["adoptOrphans"] == restored
    assert calls == [(apps, custom, "preview-workflow-builder")]


# ---------------------------------------------------------------------------
# 409 recreate-on-mismatch (preview image freshness Phase 0): a create-409 adopts
# the existing dev-preview CR only when its `dev` container image matches the
# manifest we just built; on image drift it deletes + recreates.
# ---------------------------------------------------------------------------


class _Api4xx(Exception):
    def __init__(self, status: int) -> None:
        super().__init__(f"api status {status}")
        self.status = status


class _FakeCustom409:
    """Create raises 409 on the FIRST call (name already exists); get returns an
    existing CR carrying `existing_image`; delete flips exists so the wait loop
    returns immediately and a subsequent recreate succeeds."""

    def __init__(self, existing_image: str) -> None:
        self.existing_image = existing_image
        self.annotations: dict[str, str] = {}
        self.exists = True
        self.create_calls = 0
        self.recreates: list[dict] = []
        self.deletes: list[str] = []

    def create_namespaced_custom_object(
        self, *, group, version, namespace, plural, body
    ):
        self.create_calls += 1
        if self.create_calls == 1 and self.exists:
            raise _Api4xx(409)
        self.recreates.append(body)
        return body

    def get_namespaced_custom_object(self, *, group, version, namespace, plural, name):
        if not self.exists:
            raise _Api4xx(404)
        return {
            "metadata": {"annotations": self.annotations},
            "spec": {
                "podTemplate": {
                    "spec": {
                        "containers": [{"name": "dev", "image": self.existing_image}]
                    }
                }
            },
        }

    def delete_namespaced_custom_object(
        self, *, group, version, namespace, plural, name, body=None
    ):
        self.deletes.append(name)
        self.exists = False


def _provision_409_harness(monkeypatch, *, class_image: str, existing_image: str):
    fake_custom = _FakeCustom409(existing_image)
    monkeypatch.setenv("SANDBOX_EXECUTION_API_TOKEN", "token")
    monkeypatch.setattr(
        app_module,
        "_load_execution_classes",
        lambda: {
            "dev-preview": ExecutionClassConfig(localQueue="", serviceImage=class_image)
        },
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
    return fake_custom


def test_provision_409_adopts_when_image_matches(monkeypatch) -> None:
    fake_custom = _provision_409_harness(
        monkeypatch, class_image="img:v1", existing_image="img:v1"
    )
    response = app_module.provision_dev_preview(
        SimpleNamespace(headers={"authorization": "Bearer token"}),
        DevPreviewRequest(executionId="exec-1", service="workflow-builder"),
    )
    assert response["ready"] is True
    assert fake_custom.deletes == []  # adopted, not recreated
    assert fake_custom.recreates == []
    assert fake_custom.create_calls == 1


def test_provision_409_recreates_when_image_drifts(monkeypatch) -> None:
    fake_custom = _provision_409_harness(
        monkeypatch, class_image="img:v2", existing_image="img:v1"
    )
    response = app_module.provision_dev_preview(
        SimpleNamespace(headers={"authorization": "Bearer token"}),
        DevPreviewRequest(executionId="exec-1", service="workflow-builder"),
    )
    assert response["ready"] is True
    assert len(fake_custom.deletes) == 1  # drifted → deleted
    assert len(fake_custom.recreates) == 1  # then recreated with the new image
    assert app_module._dev_preview_manifest_image(fake_custom.recreates[0]) == "img:v2"


def test_adopted_workflow_builder_image_drift_fails_closed(monkeypatch) -> None:
    fake_custom = _provision_409_harness(
        monkeypatch, class_image="img:v2", existing_image="img:v1"
    )
    coordination = _FakeAdoptionCoordination()
    holder = app_module._adopt_lease_holder("exec-1", "workflow-builder")
    fake_custom.annotations[app_module.DEV_PREVIEW_ADOPT_HOLDER_ANNOTATION] = holder
    monkeypatch.setenv("DEV_PREVIEW_PLATFORM_SCOPE", "vcluster")
    monkeypatch.setattr(app_module, "_adopt_read_identity", lambda *_a, **_k: None)
    monkeypatch.setattr(
        app_module, "_load_k8s_coordination_client", lambda: coordination
    )

    with pytest.raises(HTTPException) as raised:
        app_module.provision_dev_preview(
            SimpleNamespace(headers={"authorization": "Bearer token"}),
            DevPreviewRequest(
                executionId="exec-1",
                service="workflow-builder",
                previewNative=True,
                adoptDeployment="workflow-builder",
            ),
        )

    assert raised.value.status_code == 409
    assert "fresh acceptance preview" in str(raised.value.detail)
    assert fake_custom.deletes == []
    assert fake_custom.recreates == []
    assert coordination.lease is not None


def test_self_adopt_teardown_returns_before_deferred_cleanup(monkeypatch) -> None:
    context = {
        "execution": "exec-1",
        "service": "workflow-builder",
        "deployment": "workflow-builder",
        "holder": "adopt:exec-1:digest:workflow-builder",
    }
    captured: dict[str, object] = {}
    events: list[object] = []

    class _DeferredThread:
        def __init__(self, *, target, kwargs, daemon, name):
            captured.update(target=target, kwargs=kwargs, daemon=daemon, name=name)

        def start(self):
            events.append("started")

    monkeypatch.setenv("SANDBOX_EXECUTION_API_TOKEN", "token")
    monkeypatch.setattr(
        app_module, "_agent_workflow_host_namespace", lambda: "workflow-builder"
    )
    monkeypatch.setattr(app_module, "_load_k8s_custom_objects_client", lambda: object())
    monkeypatch.setattr(
        app_module, "_dev_preview_teardown_context", lambda *_a, **_k: context
    )
    monkeypatch.setattr(app_module.threading, "Thread", _DeferredThread)
    monkeypatch.setattr(
        app_module.time, "sleep", lambda seconds: events.append(seconds)
    )
    monkeypatch.setattr(
        app_module,
        "_teardown_dev_preview_resources",
        lambda **kwargs: events.append(("cleanup", kwargs)),
    )

    response = app_module.teardown_dev_preview(
        SimpleNamespace(headers={"authorization": "Bearer token"}),
        "wfb-dev-preview-exec-1-workflow-builder",
    )

    assert response == {
        "sandboxName": "wfb-dev-preview-exec-1-workflow-builder",
        "accepted": True,
        "deleted": False,
        "deferred": True,
    }
    assert events == ["started"]
    assert captured["daemon"] is True

    captured["target"](**captured["kwargs"])
    assert events[1] == 15
    assert events[2][0] == "cleanup"
    assert events[2][1]["context"] is context


def test_teardown_restores_production_before_releasing_adoption_lease(
    monkeypatch,
) -> None:
    events: list[str] = []
    custom = object()
    apps = object()
    coordination = object()
    core = SimpleNamespace(
        delete_collection_namespaced_secret=lambda **_kwargs: events.append("secret")
    )
    context = {
        "execution": "exec-1",
        "service": "workflow-orchestrator",
        "deployment": "workflow-orchestrator",
        "holder": "adopt:exec-1:digest:workflow-orchestrator",
    }
    monkeypatch.setattr(app_module, "_load_k8s_custom_objects_client", lambda: custom)
    monkeypatch.setattr(app_module, "_load_k8s_clients", lambda: (object(), core))
    monkeypatch.setattr(
        app_module,
        "_delete_agent_host_cr_and_wait",
        lambda *_args, **_kwargs: events.append("sandbox"),
    )
    monkeypatch.setattr(app_module, "_load_k8s_apps_client", lambda: apps)
    monkeypatch.setattr(
        app_module,
        "_adopt_restore_deployment",
        lambda *_args, **_kwargs: events.append("restore"),
    )
    monkeypatch.setattr(
        app_module, "_load_k8s_coordination_client", lambda: coordination
    )
    monkeypatch.setattr(
        app_module,
        "_delete_dev_preview_adoption_lease",
        lambda *_args, **_kwargs: events.append("release"),
    )
    monkeypatch.setattr(
        app_module,
        "_adopt_restore_orphans",
        lambda *_args, **_kwargs: events.append("sweep"),
    )

    app_module._teardown_dev_preview_resources(
        namespace="workflow-builder",
        sandbox_name="wfb-dev-preview-exec-1-workflow-orchestrator",
        context=context,
    )

    assert events == ["secret", "sandbox", "restore", "release", "sweep"]


def test_provision_forces_image_pins_mount_when_class_declares_it() -> None:
    cfg = ExecutionClassConfig(
        localQueue="", imagePinsConfigMap="workflow-builder-image-pins"
    )
    manifest = build_dev_preview_sandbox_manifest(
        DevPreviewRequest(executionId="exec-1", service="workflow-builder"),
        namespace="workflow-builder",
        class_config=cfg,
    )
    pod = manifest["spec"]["podTemplate"]["spec"]
    dev = next(c for c in pod["containers"] if c["name"] == "dev")
    env = {e["name"]: e.get("value") for e in dev["env"]}
    assert (
        env["SANDBOX_EXECUTION_CLASSES_FILE"]
        == "/etc/workflow-builder/image-pins/classes.json"
    )
    assert (
        env["WORKFLOW_BUILDER_IMAGE_PINS_FILE"]
        == "/etc/workflow-builder/image-pins/runtime-images.json"
    )
    mount = next(m for m in dev["volumeMounts"] if m["name"] == "image-pins")
    assert mount["mountPath"] == "/etc/workflow-builder/image-pins"
    vol = next(v for v in pod["volumes"] if v["name"] == "image-pins")
    assert vol["configMap"]["name"] == "workflow-builder-image-pins"


def test_manifest_has_no_image_pins_mount_by_default() -> None:
    manifest = build_dev_preview_sandbox_manifest(
        DevPreviewRequest(executionId="exec-1", service="workflow-builder"),
        namespace="workflow-builder",
        class_config=ExecutionClassConfig(localQueue=""),
    )
    pod = manifest["spec"]["podTemplate"]["spec"]
    dev = next(c for c in pod["containers"] if c["name"] == "dev")
    env = {e["name"] for e in dev["env"]}
    assert "SANDBOX_EXECUTION_CLASSES_FILE" not in env
    assert "WORKFLOW_BUILDER_IMAGE_PINS_FILE" not in env
    assert not any(v.get("name") == "image-pins" for v in pod.get("volumes", []))

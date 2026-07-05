"""Dev-preview (executionId, service) scoping + Dapr-shadow guard (P0 multi-service).

These cover the two latent bugs that block N dev pods per execution:
  * per-service Sandbox/Secret names + service-scoped readiness/scale-down selectors
    (else service B's prod Deployment scales to 0 when service A becomes Ready, and
    readiness can return the wrong pod's IP);
  * preview-native provisions must NOT inherit the SEA-default Dapr-shadow env
    (PUBSUB_NAME=pubsub-dev / DAPR_CONFIG_STORE=disabled-dev), which points the pod at
    a `pubsub-dev` component that does not exist in the vcluster preview.
"""

import json
import time as _time
from types import SimpleNamespace

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
        metadata=SimpleNamespace(name="workflow-builder-xyz"),
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
        return SimpleNamespace(
            status=SimpleNamespace(active=1, succeeded=0, failed=0)
        )

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

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
from dataclasses import replace
from threading import Event, Lock
from types import SimpleNamespace

import pytest
from fastapi import HTTPException, Response
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


def test_dev_preview_trace_dump_redacts_credentials_and_environment() -> None:
    dump = app_module._redacted_dev_preview_request_dump(
        DevPreviewRequest(
            executionId="exec-1",
            syncToken="a" * 64,
            syncAgentToken="b" * 64,
            env={"API_TOKEN": "plaintext"},
            serviceSecretEnv={"DATABASE_URL": "postgres://secret"},
            adoptInheritedEnv=[{"name": "TOKEN", "value": "secret"}],
        )
    )

    assert dump["syncToken"] == "***"
    assert dump["syncAgentToken"] == "***"
    assert dump["env"] == {"API_TOKEN": "***"}
    assert dump["serviceSecretEnv"] == {"DATABASE_URL": "***"}
    assert dump["adoptInheritedEnv"] == "***"
    assert "plaintext" not in json.dumps(dump)
    assert "postgres://secret" not in json.dumps(dump)


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
    assert (
        pod_labels[app_module.DEV_PREVIEW_MANAGED_LABEL]
        == app_module.DEV_PREVIEW_MANAGED_VALUE
    )
    cr_labels = manifest["metadata"]["labels"]
    assert cr_labels["dev-preview-service"] == "workflow-orchestrator"
    assert (
        cr_labels[app_module.DEV_PREVIEW_MANAGED_LABEL]
        == app_module.DEV_PREVIEW_MANAGED_VALUE
    )
    assert "workflow-orchestrator" in manifest["metadata"]["name"]


def test_manifest_records_exact_owned_secret_for_retryable_teardown() -> None:
    request = DevPreviewRequest(
        executionId="exec-1",
        service="workflow-orchestrator",
        serviceSecretEnv={"DATABASE_URL": "postgres://secret"},
    )
    manifest = build_dev_preview_sandbox_manifest(
        request,
        namespace="workflow-builder",
        class_config=_dev_class(),
    )

    assert manifest["metadata"]["annotations"][
        app_module.DEV_PREVIEW_SECRET_NAME_ANNOTATION
    ] == app_module._dev_preview_secret_name(request.executionId, request.service)


@pytest.mark.parametrize(
    ("service", "selector"),
    [
        ("workflow-builder", {"app": "workflow-builder", "traffic": "prod"}),
        ("workflow-orchestrator", {"app": "workflow-orchestrator"}),
        ("function-router", {"app": "function-router"}),
        ("workflow-mcp-server", {"app": "workflow-mcp-server"}),
        ("mcp-gateway", {"app.kubernetes.io/name": "mcp-gateway"}),
    ],
)
def test_staged_manifest_quarantines_one_live_service_selector_key(
    service: str, selector: dict[str, str]
) -> None:
    request = DevPreviewRequest(
        executionId="exec-1",
        service=service,
        previewNative=True,
        adoptService=service,
        adoptDeployment=service,
        stageAdoption=True,
    )
    manifest = build_dev_preview_sandbox_manifest(
        request,
        namespace="workflow-builder",
        class_config=_dev_class(),
        adopt_selector=selector,
    )
    pod_labels = manifest["spec"]["podTemplate"]["metadata"]["labels"]
    annotations = manifest["metadata"]["annotations"]
    gate_key = annotations[app_module.DEV_PREVIEW_ADOPT_GATE_KEY_ANNOTATION]

    assert all(
        pod_labels.get(key) == value for key, value in selector.items() if key != gate_key
    )
    assert pod_labels[gate_key] != selector[gate_key]
    assert not all(pod_labels.get(key) == value for key, value in selector.items())
    # Dapr-generated Services for the Dapr-enabled preview services select `app`.
    if "app" in selector:
        assert pod_labels["app"] != service
    assert json.loads(
        annotations[app_module.DEV_PREVIEW_ADOPT_SELECTOR_ANNOTATION]
    ) == selector


def test_non_staged_manifest_keeps_live_selector_behavior() -> None:
    selector = {"app": "workflow-builder", "traffic": "prod"}
    manifest = build_dev_preview_sandbox_manifest(
        DevPreviewRequest(
            executionId="exec-1",
            service="workflow-builder",
            previewNative=True,
            adoptService="workflow-builder",
            adoptDeployment="workflow-builder",
        ),
        namespace="workflow-builder",
        class_config=_dev_class(),
        adopt_selector=selector,
    )
    labels = manifest["spec"]["podTemplate"]["metadata"]["labels"]
    assert all(labels.get(key) == value for key, value in selector.items())


def test_manifest_defaults_service_label_to_workflow_builder() -> None:
    manifest = build_dev_preview_sandbox_manifest(
        DevPreviewRequest(executionId="exec-1"),
        namespace="workflow-builder",
        class_config=_dev_class(),
    )
    labels = manifest["spec"]["podTemplate"]["metadata"]["labels"]
    assert labels["dev-preview-service"] == "workflow-builder"


def test_manifest_merges_request_and_class_service_env_from() -> None:
    manifest = build_dev_preview_sandbox_manifest(
        DevPreviewRequest(
            executionId="exec-1",
            service="workflow-builder",
            envFrom=[
                {
                    "configMapRef": {
                        "name": "workflow-builder-otel-config",
                        "optional": True,
                    }
                },
                {"secretRef": {"name": "workflow-builder-secrets"}},
            ],
        ),
        namespace="workflow-builder",
        class_config=ExecutionClassConfig(
            localQueue="",
            serviceEnvFrom=[
                {
                    "secretRef": {
                        "name": "workflow-builder-secrets",
                        "optional": True,
                    }
                },
                {
                    "configMapRef": {
                        "name": "preview-observability",
                        "optional": True,
                    }
                },
            ],
        ),
    )

    env_from = manifest["spec"]["podTemplate"]["spec"]["containers"][0]["envFrom"]
    assert env_from == [
        {
            "configMapRef": {
                "name": "workflow-builder-otel-config",
                "optional": True,
            }
        },
        {
            "secretRef": {
                "name": "workflow-builder-secrets",
                "optional": True,
            }
        },
        {
            "configMapRef": {
                "name": "preview-observability",
                "optional": True,
            }
        },
    ]


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
    assert tls["image"] == (
        "docker.io/nginxinc/nginx-unprivileged@sha256:"
        "65e3e85dbaed8ba248841d9d58a899b6197106c23cb0ff1a132b7bfe0547e4c0"
    )
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


def test_host_shadow_omits_internal_grpc_port_override() -> None:
    # Host Dapr-shadow sidecars invoke workflow-builder during startup, so they must
    # use the same cluster-default internal gRPC port as every host workload.
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
    assert "dapr.io/internal-grpc-port" not in ann


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
    transitions: list[str] = []
    deployment = {"replicas": 2, "annotations": {}}
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
            spec=SimpleNamespace(replicas=deployment["replicas"]),
            metadata=SimpleNamespace(annotations=deployment["annotations"]),
        )

    def patch_dep(*, name, namespace, body):
        assert transitions == ["entered"]
        patched["name"] = name
        patched["replicas"] = body["spec"]["replicas"]
        deployment["replicas"] = body["spec"]["replicas"]
        deployment["annotations"] = body["metadata"]["annotations"]

    fake_apps = SimpleNamespace(
        read_namespaced_deployment=read_dep,
        patch_namespaced_deployment=patch_dep,
    )
    monkeypatch.setattr(app_module, "_load_k8s_apps_client", lambda: fake_apps)
    monkeypatch.setattr(
        app_module, "_load_k8s_clients", lambda: (SimpleNamespace(), fake_core)
    )

    class _TransitionLock:
        def __enter__(self):
            transitions.append("entered")

        def __exit__(self, *_args):
            transitions.append("released")

    monkeypatch.setattr(
        app_module,
        "_dev_preview_adoption_transition_lock",
        lambda *_args: _TransitionLock(),
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
    assert transitions == ["entered", "released"]


def _ready_pod(
    name: str,
    *,
    daprd: str | None = None,
    labels: dict[str, str] | None = None,
    pod_ip: str = "10.0.0.9",
) -> SimpleNamespace:
    """A dev pod that is Ready. daprd: None=absent, "init"/"regular"/"label"=present."""
    init_cs = (
        [SimpleNamespace(name="daprd", ready=True)] if daprd == "init" else None
    )
    regular = [SimpleNamespace(name="dev", ready=True)]
    if daprd == "regular":
        regular.append(SimpleNamespace(name="daprd", ready=True))
    pod_labels = dict(labels or {})
    if daprd == "label":
        pod_labels["dapr.io/sidecar-injected"] = "true"
    return SimpleNamespace(
        metadata=SimpleNamespace(name=name, labels=pod_labels),
        status=SimpleNamespace(
            pod_ip=pod_ip,
            container_statuses=regular,
            init_container_statuses=init_cs,
            conditions=[SimpleNamespace(type="Ready", status="True")],
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
    assert not app_module._dev_pod_has_daprd(_ready_pod("p", daprd="label"))
    assert not app_module._dev_pod_has_daprd(_ready_pod("p", daprd=None))


def _scale_down_fakes(monkeypatch, pods_sequence):
    """Wire _adopt_deferred_scale_down against a scripted pod-list sequence."""
    monkeypatch.setattr(_time, "sleep", lambda *_a, **_k: None)
    state = {
        "i": 0,
        "deleted": [],
        "patched": {},
        "replicas": 1,
        "annotations": {},
    }

    def list_pods(*, namespace, label_selector):
        idx = min(state["i"], len(pods_sequence) - 1)
        state["i"] += 1
        return SimpleNamespace(items=pods_sequence[idx])

    def del_pod(*, name, namespace):
        state["deleted"].append(name)

    def read_dep(*, name, namespace):
        return SimpleNamespace(
            spec=SimpleNamespace(replicas=state["replicas"]),
            metadata=SimpleNamespace(annotations=state["annotations"]),
        )

    def patch_dep(*, name, namespace, body):
        state["patched"] = {"name": name, "replicas": body["spec"]["replicas"]}
        state["replicas"] = body["spec"]["replicas"]
        state["annotations"] = body["metadata"]["annotations"]

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


def test_adopt_restore_leaves_never_scaled_deployment_unchanged() -> None:
    patches: list[dict] = []
    apps = SimpleNamespace(
        read_namespaced_deployment=lambda **_kwargs: SimpleNamespace(
            spec=SimpleNamespace(replicas=3),
            metadata=SimpleNamespace(annotations={}),
        ),
        patch_namespaced_deployment=lambda **kwargs: patches.append(kwargs),
    )

    app_module._adopt_restore_deployment(
        apps, namespace="workflow-builder", name="workflow-orchestrator"
    )

    assert patches == []


def test_non_ready_adoption_compensates_without_starting_late_cutover(
    monkeypatch,
) -> None:
    fake_custom = _FakeCustom()
    cleanup: list[dict] = []
    threads: list[dict] = []
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
    monkeypatch.setattr(app_module, "_adopt_read_identity", lambda *_a, **_k: None)
    monkeypatch.setattr(
        app_module, "_load_k8s_coordination_client", lambda: SimpleNamespace()
    )
    monkeypatch.setattr(
        app_module,
        "_acquire_dev_preview_adoption_lease",
        lambda *_a, **_k: "adopt:exec-1:digest:workflow-orchestrator",
    )
    monkeypatch.setattr(
        app_module,
        "_wait_for_dev_preview_ready",
        lambda *_a, **_k: ("queued", None),
    )
    context = {
        "execution": "exec-1",
        "service": "workflow-orchestrator",
        "deployment": "workflow-orchestrator",
        "holder": "adopt:exec-1:digest:workflow-orchestrator",
    }
    monkeypatch.setattr(
        app_module, "_dev_preview_teardown_context", lambda *_a, **_k: context
    )
    monkeypatch.setattr(
        app_module,
        "_teardown_dev_preview_resources",
        lambda **kwargs: cleanup.append(kwargs),
    )
    monkeypatch.setattr(
        app_module.threading,
        "Thread",
        lambda **kwargs: threads.append(kwargs),
    )

    with pytest.raises(HTTPException) as raised:
        app_module.provision_dev_preview(
            SimpleNamespace(headers={"authorization": "Bearer token"}),
            DevPreviewRequest(
                executionId="exec-1",
                service="workflow-orchestrator",
                previewNative=True,
                adoptDeployment="workflow-orchestrator",
                waitReadySeconds=1,
            ),
        )

    assert raised.value.status_code == 503
    assert "removed without cutover" in str(raised.value.detail)
    assert len(cleanup) == 1
    assert cleanup[0]["context"] == context
    assert threads == []


def _provision_cutover_harness(
    monkeypatch,
    deployment: str,
    *,
    staged: bool = False,
    deployment_identity: dict | None = None,
    request_env: dict[str, str] | None = None,
    caller_inherited_env: list[dict] | None = None,
) -> tuple[list[str], list[dict], dict, _FakeCustom]:
    fake_custom = _FakeCustom()
    synchronous: list[str] = []
    deferred: list[dict] = []

    class _DeferredThread:
        def __init__(self, *, target, kwargs, daemon, name):
            deferred.append(
                {
                    "target": target,
                    "kwargs": kwargs,
                    "daemon": daemon,
                    "name": name,
                    "started": False,
                }
            )

        def start(self):
            deferred[-1]["started"] = True

    core = SimpleNamespace(
        read_namespaced_service=lambda *, name, namespace: SimpleNamespace(
            spec=SimpleNamespace(selector={"app": name})
        )
    )
    monkeypatch.setenv("SANDBOX_EXECUTION_API_TOKEN", "token")
    monkeypatch.setenv("DEV_PREVIEW_PLATFORM_SCOPE", "vcluster")
    monkeypatch.setattr(
        app_module,
        "_load_execution_classes",
        lambda: {"dev-preview": _dev_class()},
    )
    monkeypatch.setattr(app_module, "_load_k8s_apps_client", lambda: SimpleNamespace())
    monkeypatch.setattr(
        app_module, "_load_k8s_clients", lambda: (SimpleNamespace(), core)
    )
    monkeypatch.setattr(
        app_module, "_load_k8s_custom_objects_client", lambda: fake_custom
    )
    monkeypatch.setattr(
        app_module, "_load_k8s_coordination_client", lambda: SimpleNamespace()
    )
    monkeypatch.setattr(
        app_module,
        "_adopt_read_identity",
        lambda *_a, **_k: deployment_identity,
    )
    monkeypatch.setattr(
        app_module,
        "_acquire_dev_preview_adoption_lease",
        lambda *_a, **_k: f"adopt:exec-1:digest:{deployment}",
    )
    monkeypatch.setattr(
        app_module,
        "_wait_for_dapr_injector_available",
        lambda *_a, **_k: True,
    )
    monkeypatch.setattr(
        app_module,
        "_wait_for_dev_preview_ready",
        lambda *_a, **_k: ("ready", "10.0.0.9"),
    )
    monkeypatch.setattr(
        app_module,
        "_ready_dev_preview_pod",
        lambda *_a, **_k: _ready_pod("dev", daprd="init"),
    )
    monkeypatch.setattr(
        app_module,
        "_adopt_scale_deployment_down",
        lambda _apps, *, namespace, name: synchronous.append(name),
    )
    monkeypatch.setattr(
        app_module, "_dev_preview_adoption_is_current", lambda *_a, **_k: True
    )
    monkeypatch.setattr(app_module.threading, "Thread", _DeferredThread)

    response = app_module.provision_dev_preview(
        SimpleNamespace(headers={"authorization": "Bearer token"}),
        DevPreviewRequest(
            executionId="exec-1",
            service=deployment,
            needsDapr=True,
            previewNative=True,
            adoptService=deployment,
            adoptDeployment=deployment,
            stageAdoption=staged,
            waitReadySeconds=1,
            env=request_env,
            adoptInheritedEnv=caller_inherited_env,
        ),
    )
    assert response["ready"] is True
    return synchronous, deferred, response, fake_custom


def test_provision_adoption_uses_live_deployment_capability_and_origin_env(
    monkeypatch,
) -> None:
    live_origin = {
        "valueFrom": {
            "configMapKeyRef": {
                "name": "preview-environment-identity",
                "key": "public-url",
            }
        }
    }
    _, _, _, custom = _provision_cutover_harness(
        monkeypatch,
        "workflow-builder",
        deployment_identity={
            "containerEnv": [
                {"name": "APP_PUBLIC_URL", **live_origin},
                {"name": "ORIGIN", **live_origin},
                {
                    "name": "PREVIEW_FUNCTION_REGISTRY_JSON",
                    "valueFrom": {
                        "configMapKeyRef": {
                            "name": "function-registry",
                            "key": "functions.json",
                        }
                    },
                },
                {
                    "name": "PREVIEW_NATIVE_ACTION_SLUGS_JSON",
                    "value": '["durable/run","dev/preview"]',
                },
            ]
        },
        request_env={
            "APP_PUBLIC_URL": "https://wfb-dev.tailnet.example",
            "ORIGIN": "https://wfb-dev.tailnet.example",
            "PREVIEW_FUNCTION_REGISTRY_JSON": '{"attacker":true}',
            "PREVIEW_NATIVE_ACTION_SLUGS_JSON": '["admin/all"]',
        },
        caller_inherited_env=[
            {"name": "ORIGIN", "value": "https://caller.example"}
        ],
    )

    manifest = custom.creates[0][4]
    entries = manifest["spec"]["podTemplate"]["spec"]["containers"][0]["env"]
    by_name = {entry["name"]: entry for entry in entries}
    assert by_name["APP_PUBLIC_URL"] == {"name": "APP_PUBLIC_URL", **live_origin}
    assert by_name["ORIGIN"] == {"name": "ORIGIN", **live_origin}
    assert by_name["PREVIEW_FUNCTION_REGISTRY_JSON"]["valueFrom"] == {
        "configMapKeyRef": {
            "name": "function-registry",
            "key": "functions.json",
        }
    }
    assert by_name["PREVIEW_NATIVE_ACTION_SLUGS_JSON"]["value"] == (
        '["durable/run","dev/preview"]'
    )


def test_provision_adoption_drops_caller_authority_when_identity_is_missing(
    monkeypatch,
) -> None:
    _, _, _, custom = _provision_cutover_harness(
        monkeypatch,
        "workflow-builder",
        request_env={
            "APP_PUBLIC_URL": "https://wfb-dev.tailnet.example",
            "ORIGIN": "https://wfb-dev.tailnet.example",
            "PREVIEW_FUNCTION_REGISTRY_JSON": '{"attacker":true}',
            "PREVIEW_NATIVE_ACTION_SLUGS_JSON": '["admin/all"]',
            "DAPR_CONFIG_STORE": "request-configstore",
        },
        caller_inherited_env=[
            {
                "name": "PREVIEW_NATIVE_ACTION_SLUGS_JSON",
                "value": '["admin/all"]',
            }
        ],
    )

    manifest = custom.creates[0][4]
    entries = manifest["spec"]["podTemplate"]["spec"]["containers"][0]["env"]
    by_name = {entry["name"]: entry for entry in entries}
    for name in app_module._ADOPT_ENV_DEPLOYMENT_AUTHORITY_NAMES:
        assert name not in by_name
    assert by_name["DAPR_CONFIG_STORE"]["value"] == "request-configstore"


@pytest.mark.parametrize("deployment", ["workflow-builder", "function-router"])
def test_response_path_adoptions_defer_cutover_until_after_response(
    monkeypatch, deployment
) -> None:
    synchronous, deferred, response, _custom = _provision_cutover_harness(
        monkeypatch, deployment
    )

    assert synchronous == []
    assert len(deferred) == 1
    assert deferred[0]["target"] is app_module._adopt_deferred_scale_down
    assert deferred[0]["kwargs"]["deployment"] == deployment
    assert deferred[0]["kwargs"]["service"] == deployment
    assert deferred[0]["started"] is True
    assert response["staged"] is False


def test_non_response_path_adoption_stays_synchronous(monkeypatch) -> None:
    synchronous, deferred, response, _custom = _provision_cutover_harness(
        monkeypatch, "workflow-orchestrator"
    )

    assert synchronous == ["workflow-orchestrator"]
    assert deferred == []
    assert response["staged"] is False


@pytest.mark.parametrize(
    "deployment", ["workflow-builder", "function-router", "workflow-orchestrator"]
)
def test_staged_adoption_proves_ready_without_scaling_or_cutover(
    monkeypatch, deployment
) -> None:
    synchronous, deferred, response, custom = _provision_cutover_harness(
        monkeypatch, deployment, staged=True
    )

    assert synchronous == []
    assert deferred == []
    assert response["staged"] is True
    manifest = custom.creates[0][4]
    annotations = manifest["metadata"]["annotations"]
    assert (
        annotations[app_module.DEV_PREVIEW_ADOPT_STAGED_ANNOTATION]
        == annotations[app_module.DEV_PREVIEW_ADOPT_HOLDER_ANNOTATION]
    )


def test_provision_holds_teardown_intent_guard_across_lease_secret_and_cr(
    monkeypatch,
) -> None:
    events: list[str] = []

    class _GuardedCustom(_FakeCustom):
        def create_namespaced_custom_object(self, **kwargs):
            assert app_module._DEV_PREVIEW_TEARDOWN_INTENTS_GUARD.locked()
            events.append("sandbox")
            return super().create_namespaced_custom_object(**kwargs)

    core = SimpleNamespace(
        read_namespaced_service=lambda **_kwargs: SimpleNamespace(
            spec=SimpleNamespace(selector={"app": "workflow-orchestrator"})
        )
    )
    monkeypatch.setenv("SANDBOX_EXECUTION_API_TOKEN", "token")
    monkeypatch.setenv("DEV_PREVIEW_PLATFORM_SCOPE", "vcluster")
    monkeypatch.setattr(
        app_module, "_load_execution_classes", lambda: {"dev-preview": _dev_class()}
    )
    monkeypatch.setattr(app_module, "_load_k8s_apps_client", SimpleNamespace)
    monkeypatch.setattr(
        app_module, "_load_k8s_clients", lambda: (SimpleNamespace(), core)
    )
    monkeypatch.setattr(
        app_module, "_load_k8s_custom_objects_client", lambda: _GuardedCustom()
    )
    monkeypatch.setattr(app_module, "_load_k8s_coordination_client", SimpleNamespace)
    monkeypatch.setattr(app_module, "_adopt_read_identity", lambda *_a, **_k: None)

    def acquire(*_args, **_kwargs):
        assert app_module._DEV_PREVIEW_TEARDOWN_INTENTS_GUARD.locked()
        events.append("lease")
        return "adopt:exec-guarded:digest:workflow-orchestrator"

    def ensure(*_args, **_kwargs):
        assert app_module._DEV_PREVIEW_TEARDOWN_INTENTS_GUARD.locked()
        events.append("secret")
        return "dev-preview-secret-workflow-orchestrator-exec-guarded"

    monkeypatch.setattr(app_module, "_acquire_dev_preview_adoption_lease", acquire)
    monkeypatch.setattr(app_module, "_ensure_dev_preview_secret", ensure)
    monkeypatch.setattr(
        app_module,
        "_wait_for_dev_preview_ready",
        lambda *_a, **_k: ("ready", "10.0.0.9"),
    )
    monkeypatch.setattr(
        app_module,
        "_ready_dev_preview_pod",
        lambda *_a, **_k: _ready_pod("dev"),
    )

    response = app_module.provision_dev_preview(
        SimpleNamespace(headers={"authorization": "Bearer token"}),
        DevPreviewRequest(
            executionId="exec-guarded",
            service="workflow-orchestrator",
            previewNative=True,
            adoptService="workflow-orchestrator",
            adoptDeployment="workflow-orchestrator",
            stageAdoption=True,
            serviceSecretEnv={"DATABASE_URL": "postgres://secret"},
        ),
    )

    assert response["staged"] is True
    assert events == ["lease", "secret", "sandbox"]


def _staged_member(
    service: str, execution_id: str = "exec-1", *, gate_active: bool = False
):
    holder = app_module._adopt_lease_holder(execution_id, service)
    selector = {"app": service}
    return app_module._StagedDevPreviewAdoption(
        execution_id=execution_id,
        sandbox_name=app_module._dev_preview_sandbox_name(execution_id, service),
        service=service,
        deployment=service,
        holder=holder,
        needs_dapr=True,
        active_selector=tuple(selector.items()),
        routing_surfaces=(
            app_module._DevPreviewRoutingSurface(
                name=service,
                selector=tuple(selector.items()),
            ),
        ),
        gate_key="app",
        staged_gate_value=app_module._adopt_stage_gate_value(holder),
        pod_name=f"{service}-dev",
        pod_ip="10.0.0.9",
        gate_active=gate_active,
    )


def test_staged_batch_validation_fails_closed_on_incomplete_exact_set() -> None:
    first = _staged_member("function-router")
    second = _staged_member("workflow-builder")

    class _ListedCustom:
        def list_namespaced_custom_object(self, **_kwargs):
            return {
                "items": [
                    {
                        "metadata": {
                            "name": member.sandbox_name,
                            "annotations": {
                                app_module.DEV_PREVIEW_ADOPT_STAGED_ANNOTATION: member.holder
                            },
                        }
                    }
                    for member in (first, second)
                ]
            }

    with pytest.raises(HTTPException) as raised:
        app_module._validate_staged_dev_preview_batch(
            _ListedCustom(),
            object(),
            object(),
            namespace="workflow-builder",
            execution_id="exec-1",
            sandbox_names=[first.sandbox_name],
        )

    assert raised.value.status_code == 409
    assert "complete staged set" in str(raised.value.detail)


def test_staged_batch_validation_accepts_exact_ready_owned_tuple() -> None:
    service = "function-router"
    execution_id = "exec-1"
    request = DevPreviewRequest(
        executionId=execution_id,
        service=service,
        needsDapr=True,
        daprAppId=service,
        previewNative=True,
        adoptService=service,
        adoptDeployment=service,
        stageAdoption=True,
    )
    cr = build_dev_preview_sandbox_manifest(
        request,
        namespace="workflow-builder",
        class_config=_dev_class(),
        adopt_selector={"app": service},
    )
    coordination = _FakeAdoptionCoordination()
    holder = app_module._acquire_dev_preview_adoption_lease(
        coordination,
        namespace="workflow-builder",
        deployment=service,
        execution_id=execution_id,
        service=service,
    )

    class _ExactCustom:
        def list_namespaced_custom_object(self, **_kwargs):
            return {"items": [cr]}

        def get_namespaced_custom_object(self, **_kwargs):
            return cr

    pod_labels = cr["spec"]["podTemplate"]["metadata"]["labels"]
    core = SimpleNamespace(
        read_namespaced_service=lambda **_kwargs: SimpleNamespace(
            spec=SimpleNamespace(selector={"app": service})
        ),
        list_namespaced_pod=lambda **_kwargs: SimpleNamespace(
            items=[_ready_pod("dev", daprd="init", labels=pod_labels)]
        )
    )

    assert app_module._validate_staged_dev_preview_batch(
        _ExactCustom(),
        coordination,
        core,
        namespace="workflow-builder",
        execution_id=execution_id,
        sandbox_names=[cr["metadata"]["name"]],
    ) == (
        app_module._StagedDevPreviewAdoption(
            execution_id=execution_id,
            sandbox_name=cr["metadata"]["name"],
            service=service,
            deployment=service,
            holder=holder,
            needs_dapr=True,
            active_selector=(("app", service),),
            routing_surfaces=(
                app_module._DevPreviewRoutingSurface(
                    name=service,
                    selector=(("app", service),),
                ),
                app_module._DevPreviewRoutingSurface(
                    name=f"{service}-dapr",
                    selector=(("app", service),),
                ),
            ),
            gate_key="app",
            staged_gate_value=app_module._adopt_stage_gate_value(holder),
            pod_name="dev",
            pod_ip="10.0.0.9",
            gate_active=False,
        ),
    )


def test_staged_activation_returns_receipt_and_schedules_one_worker(
    monkeypatch,
) -> None:
    expected = tuple(
        sorted(
            (_staged_member("workflow-builder"), _staged_member("function-router")),
            key=lambda member: member.sandbox_name,
        )
    )
    captured: list[dict] = []
    phase: list[str | None] = [None]

    monkeypatch.setenv("SANDBOX_EXECUTION_API_TOKEN", "token")
    monkeypatch.delenv("SANDBOX_EXECUTION_DRY_RUN", raising=False)
    monkeypatch.setattr(
        app_module, "_agent_workflow_host_namespace", lambda: "workflow-builder"
    )
    monkeypatch.setattr(app_module, "_load_k8s_custom_objects_client", object)
    monkeypatch.setattr(app_module, "_load_k8s_coordination_client", object)
    monkeypatch.setattr(
        app_module, "_load_k8s_clients", lambda: (object(), object())
    )
    monkeypatch.setattr(
        app_module, "_validate_staged_dev_preview_batch", lambda *_a, **_k: expected
    )
    monkeypatch.setattr(
        app_module,
        "_read_dev_preview_batch_phase",
        lambda *_a, **_k: (phase[0], None),
    )

    def set_phase(*_args, **kwargs):
        phase[0] = kwargs["phase"]

    monkeypatch.setattr(app_module, "_set_dev_preview_batch_phase", set_phase)
    monkeypatch.setattr(
        app_module,
        "_start_dev_preview_activation_worker",
        lambda **kwargs: captured.append(kwargs),
    )
    names = [member.sandbox_name for member in reversed(expected)]
    batch_id = app_module._dev_preview_batch_id("exec-1", names)

    response_status = Response()
    response = app_module.activate_dev_previews(
        SimpleNamespace(headers={"authorization": "Bearer token"}),
        app_module.DevPreviewActivationRequest(
            executionId="exec-1", sandboxNames=names
        ),
        response_status,
    )

    assert response == {
        "executionId": "exec-1",
        "sandboxNames": sorted(names),
        "batchId": batch_id,
        "activationPhase": "scheduled",
        "accepted": True,
        "complete": False,
        "pending": True,
        "activated": False,
    }
    assert len(captured) == 1
    assert captured[0]["sandbox_names"] == sorted(names)
    assert captured[0]["batch_id"] == batch_id
    assert phase == ["scheduled"]
    assert response_status.status_code == 202


@pytest.mark.parametrize(
    ("phase", "expected_status"), [("active", 200), ("failed", 409)]
)
def test_staged_activation_terminal_phase_is_observable_and_does_not_spawn(
    monkeypatch, phase: str, expected_status: int
) -> None:
    expected = (_staged_member("workflow-builder"),)
    names = [expected[0].sandbox_name]
    started: list[bool] = []
    monkeypatch.setenv("SANDBOX_EXECUTION_API_TOKEN", "token")
    monkeypatch.delenv("SANDBOX_EXECUTION_DRY_RUN", raising=False)
    monkeypatch.setattr(
        app_module, "_agent_workflow_host_namespace", lambda: "workflow-builder"
    )
    monkeypatch.setattr(app_module, "_load_k8s_custom_objects_client", object)
    monkeypatch.setattr(app_module, "_load_k8s_coordination_client", object)
    monkeypatch.setattr(app_module, "_load_k8s_clients", lambda: (object(), object()))
    monkeypatch.setattr(
        app_module, "_validate_staged_dev_preview_batch", lambda *_a, **_k: expected
    )
    monkeypatch.setattr(
        app_module,
        "_read_dev_preview_batch_phase",
        lambda *_a, **_k: (phase, "activation-rolled-back" if phase == "failed" else None),
    )
    monkeypatch.setattr(
        app_module,
        "_start_dev_preview_activation_worker",
        lambda **_kwargs: started.append(True),
    )
    response_status = Response()

    if phase == "failed":
        with pytest.raises(HTTPException) as raised:
            app_module.activate_dev_previews(
                SimpleNamespace(headers={"authorization": "Bearer token"}),
                app_module.DevPreviewActivationRequest(
                    executionId="exec-1", sandboxNames=names
                ),
                response_status,
            )
        assert raised.value.status_code == expected_status
    else:
        receipt = app_module.activate_dev_previews(
            SimpleNamespace(headers={"authorization": "Bearer token"}),
            app_module.DevPreviewActivationRequest(
                executionId="exec-1", sandboxNames=names
            ),
            response_status,
        )
        assert receipt["complete"] is True
        assert receipt["activationPhase"] == "active"
        assert response_status.status_code == expected_status
    assert started == []


def test_activation_worker_start_failure_records_terminal_failure(monkeypatch) -> None:
    expected = (_staged_member("workflow-builder"),)
    names = [expected[0].sandbox_name]
    phase: list[str | None] = [None]
    transitions: list[tuple[str, str | None]] = []
    monkeypatch.setenv("SANDBOX_EXECUTION_API_TOKEN", "token")
    monkeypatch.delenv("SANDBOX_EXECUTION_DRY_RUN", raising=False)
    monkeypatch.setattr(
        app_module, "_agent_workflow_host_namespace", lambda: "workflow-builder"
    )
    monkeypatch.setattr(app_module, "_load_k8s_custom_objects_client", object)
    monkeypatch.setattr(app_module, "_load_k8s_coordination_client", object)
    monkeypatch.setattr(app_module, "_load_k8s_clients", lambda: (object(), object()))
    monkeypatch.setattr(
        app_module, "_validate_staged_dev_preview_batch", lambda *_a, **_k: expected
    )
    monkeypatch.setattr(
        app_module,
        "_read_dev_preview_batch_phase",
        lambda *_a, **_k: (phase[0], None),
    )

    def set_phase(*_args, **kwargs):
        phase[0] = kwargs["phase"]
        transitions.append((kwargs["phase"], kwargs.get("error_code")))

    monkeypatch.setattr(app_module, "_set_dev_preview_batch_phase", set_phase)
    monkeypatch.setattr(
        app_module,
        "_start_dev_preview_activation_worker",
        lambda **_kwargs: (_ for _ in ()).throw(RuntimeError("thread unavailable")),
    )

    with pytest.raises(HTTPException) as raised:
        app_module.activate_dev_previews(
            SimpleNamespace(headers={"authorization": "Bearer token"}),
            app_module.DevPreviewActivationRequest(
                executionId="exec-1", sandboxNames=names
            ),
            Response(),
        )

    assert raised.value.status_code == 503
    assert transitions == [
        ("scheduled", None),
        ("failed", "activation-worker-not-started"),
    ]


def test_activation_worker_deduplicates_batch_until_worker_exits(monkeypatch) -> None:
    batch_id = "sha256:" + "a" * 64
    entered = Event()
    release = Event()
    calls: list[str] = []

    def activate(**kwargs) -> None:
        calls.append(kwargs["batch_id"])
        entered.set()
        assert release.wait(2)

    monkeypatch.setattr(app_module, "_activate_staged_dev_preview_batch", activate)
    with app_module._DEV_PREVIEW_ACTIVATION_WORKERS_GUARD:
        app_module._DEV_PREVIEW_ACTIVATION_WORKERS.discard(batch_id)
    try:
        args = {
            "namespace": "workflow-builder",
            "execution_id": "exec-1",
            "sandbox_names": ["wfb-dev-preview-workflow-builder-exec-1"],
            "batch_id": batch_id,
        }
        app_module._start_dev_preview_activation_worker(**args)
        assert entered.wait(2)
        app_module._start_dev_preview_activation_worker(**args)
        assert calls == [batch_id]
        release.set()
        deadline = _time.monotonic() + 2
        while _time.monotonic() < deadline:
            with app_module._DEV_PREVIEW_ACTIVATION_WORKERS_GUARD:
                if batch_id not in app_module._DEV_PREVIEW_ACTIVATION_WORKERS:
                    break
            _time.sleep(0.01)
        with app_module._DEV_PREVIEW_ACTIVATION_WORKERS_GUARD:
            assert batch_id not in app_module._DEV_PREVIEW_ACTIVATION_WORKERS
    finally:
        release.set()
        with app_module._DEV_PREVIEW_ACTIVATION_WORKERS_GUARD:
            app_module._DEV_PREVIEW_ACTIVATION_WORKERS.discard(batch_id)


def test_startup_recovery_redrives_pending_activation_anchor(monkeypatch) -> None:
    member = _staged_member("workflow-builder")
    names = [member.sandbox_name]
    batch_id = app_module._dev_preview_batch_id("exec-1", names)
    custom = SimpleNamespace(
        list_namespaced_custom_object=lambda **_kwargs: {
            "items": [
                {
                    "metadata": {
                        "name": member.sandbox_name,
                        "annotations": {
                            app_module.DEV_PREVIEW_ADOPT_BATCH_PHASE_ANNOTATION: "activating",
                            app_module.DEV_PREVIEW_ADOPT_BATCH_EXECUTION_ANNOTATION: "exec-1",
                            app_module.DEV_PREVIEW_ADOPT_BATCH_ID_ANNOTATION: batch_id,
                            app_module.DEV_PREVIEW_ADOPT_BATCH_NAMES_ANNOTATION: json.dumps(names),
                        },
                    }
                }
            ]
        }
    )
    started: list[dict] = []
    monkeypatch.delenv("SANDBOX_EXECUTION_DRY_RUN", raising=False)
    monkeypatch.setattr(
        app_module, "_agent_workflow_host_namespace", lambda: "workflow-builder"
    )
    monkeypatch.setattr(
        app_module, "_load_k8s_custom_objects_client", lambda: custom
    )
    monkeypatch.setattr(
        app_module,
        "_start_dev_preview_activation_worker",
        lambda **kwargs: started.append(kwargs),
    )

    app_module._resume_pending_dev_preview_activations()

    assert started == [
        {
            "namespace": "workflow-builder",
            "execution_id": "exec-1",
            "sandbox_names": names,
            "batch_id": batch_id,
        }
    ]


def test_selector_gate_uses_resource_version_and_waits_for_endpoint_convergence() -> None:
    member = _staged_member("workflow-builder")
    selector = dict(member.active_selector)
    pod = _ready_pod(
        member.pod_name,
        labels={
            app_module.DEV_PREVIEW_MANAGED_LABEL: (
                app_module.DEV_PREVIEW_MANAGED_VALUE
            ),
            "workflow-execution-id": "exec-1",
            "dev-preview-service": member.service,
            member.gate_key: member.staged_gate_value,
        },
        pod_ip=member.pod_ip,
    )
    cr = {
        "metadata": {
            "name": member.sandbox_name,
            "resourceVersion": "1",
            "annotations": {
                app_module.DEV_PREVIEW_ADOPT_HOLDER_ANNOTATION: member.holder,
                app_module.DEV_PREVIEW_ADOPT_SELECTOR_ANNOTATION: json.dumps(
                    selector, sort_keys=True, separators=(",", ":")
                ),
                app_module.DEV_PREVIEW_ADOPT_GATE_KEY_ANNOTATION: member.gate_key,
                app_module.DEV_PREVIEW_ADOPT_GATE_STAGED_VALUE_ANNOTATION: (
                    member.staged_gate_value
                ),
            },
        },
        "spec": {
            "podTemplate": {
                "metadata": {
                    "labels": {member.gate_key: member.staged_gate_value}
                }
            }
        },
    }
    patches: list[dict] = []

    class _Custom:
        def get_namespaced_custom_object(self, **_kwargs):
            return json.loads(json.dumps(cr))

        def patch_namespaced_custom_object(self, *, body, **_kwargs):
            patches.append(json.loads(json.dumps(body)))
            assert body["metadata"]["resourceVersion"] == cr["metadata"][
                "resourceVersion"
            ]
            value = body["spec"]["podTemplate"]["metadata"]["labels"][
                member.gate_key
            ]
            cr["spec"]["podTemplate"]["metadata"]["labels"][member.gate_key] = value
            cr["metadata"]["resourceVersion"] = str(
                int(cr["metadata"]["resourceVersion"]) + 1
            )
            pod.metadata.labels[member.gate_key] = value

    def endpoints(**_kwargs):
        addresses = []
        if pod.metadata.labels[member.gate_key] == selector[member.gate_key]:
            addresses = [
                SimpleNamespace(
                    ip=member.pod_ip,
                    target_ref=SimpleNamespace(name=member.pod_name),
                )
            ]
        return SimpleNamespace(subsets=[SimpleNamespace(addresses=addresses)])

    core = SimpleNamespace(
        list_namespaced_pod=lambda **_kwargs: SimpleNamespace(items=[pod]),
        read_namespaced_endpoints=endpoints,
    )

    app_module._set_staged_dev_preview_gate(
        _Custom(),
        core,
        namespace="workflow-builder",
        member=member,
        active=True,
        timeout_s=0,
    )
    app_module._set_staged_dev_preview_gate(
        _Custom(),
        core,
        namespace="workflow-builder",
        member=member,
        active=False,
        timeout_s=0,
    )

    assert [
        patch["spec"]["podTemplate"]["metadata"]["labels"][member.gate_key]
        for patch in patches
    ] == [selector[member.gate_key], member.staged_gate_value]


def test_selector_gate_proves_primary_and_dapr_routing_surfaces() -> None:
    base = _staged_member("workflow-orchestrator", gate_active=True)
    selector = dict(base.active_selector)
    member = replace(
        base,
        routing_surfaces=(
            app_module._DevPreviewRoutingSurface(
                name=base.service, selector=base.active_selector
            ),
            app_module._DevPreviewRoutingSurface(
                name=f"{base.service}-dapr", selector=base.active_selector
            ),
        ),
    )
    cr = {
        "metadata": {
            "resourceVersion": "4",
            "annotations": {
                app_module.DEV_PREVIEW_ADOPT_HOLDER_ANNOTATION: member.holder,
                app_module.DEV_PREVIEW_ADOPT_SELECTOR_ANNOTATION: json.dumps(
                    selector, sort_keys=True, separators=(",", ":")
                ),
                app_module.DEV_PREVIEW_ADOPT_GATE_KEY_ANNOTATION: member.gate_key,
                app_module.DEV_PREVIEW_ADOPT_GATE_STAGED_VALUE_ANNOTATION: (
                    member.staged_gate_value
                ),
            },
        },
        "spec": {
            "podTemplate": {
                "metadata": {"labels": {member.gate_key: member.service}}
            }
        },
    }
    pod = _ready_pod(
        member.pod_name,
        labels={
            app_module.DEV_PREVIEW_MANAGED_LABEL: (
                app_module.DEV_PREVIEW_MANAGED_VALUE
            ),
            "workflow-execution-id": member.execution_id,
            "dev-preview-service": member.service,
            member.gate_key: member.service,
        },
        pod_ip=member.pod_ip,
    )
    endpoint_reads: list[str] = []

    class _Custom:
        def get_namespaced_custom_object(self, **_kwargs):
            return cr

        def patch_namespaced_custom_object(self, *, body, **_kwargs):
            value = body["spec"]["podTemplate"]["metadata"]["labels"][
                member.gate_key
            ]
            cr["spec"]["podTemplate"]["metadata"]["labels"][member.gate_key] = (
                value
            )
            pod.metadata.labels[member.gate_key] = value

    def endpoints(*, name, **_kwargs):
        endpoint_reads.append(name)
        addresses = (
            [
                SimpleNamespace(
                    ip=member.pod_ip,
                    target_ref=SimpleNamespace(name=member.pod_name),
                )
            ]
            if pod.metadata.labels[member.gate_key] == member.service
            else []
        )
        return SimpleNamespace(subsets=[SimpleNamespace(addresses=addresses)])

    core = SimpleNamespace(
        list_namespaced_pod=lambda **_kwargs: SimpleNamespace(items=[pod]),
        read_namespaced_endpoints=endpoints,
    )

    app_module._set_staged_dev_preview_gate(
        _Custom(),
        core,
        namespace="workflow-builder",
        member=member,
        active=True,
        timeout_s=0,
    )
    app_module._set_staged_dev_preview_gate(
        _Custom(),
        core,
        namespace="workflow-builder",
        member=member,
        active=False,
        timeout_s=0,
    )

    assert endpoint_reads == [
        member.service,
        f"{member.service}-dapr",
        member.service,
        f"{member.service}-dapr",
    ]


def test_active_endpoint_proof_rejects_any_extra_identity() -> None:
    expected = ("workflow-orchestrator-dev", "10.0.0.9")
    core = SimpleNamespace(
        read_namespaced_endpoints=lambda **_kwargs: SimpleNamespace(
            subsets=[
                SimpleNamespace(
                    addresses=[
                        SimpleNamespace(
                            ip=expected[1],
                            target_ref=SimpleNamespace(name=expected[0]),
                        ),
                        SimpleNamespace(
                            ip="10.0.0.10",
                            target_ref=SimpleNamespace(name="old-production-pod"),
                        ),
                    ]
                )
            ]
        )
    )

    with pytest.raises(RuntimeError, match="did not converge"):
        app_module._wait_for_adopted_service_endpoints(
            core,
            namespace="workflow-builder",
            service="workflow-orchestrator",
            expected_pod=expected,
            timeout_s=0,
        )


def test_teardown_quarantines_active_template_and_drains_service_when_pod_absent(
) -> None:
    service = "workflow-orchestrator"
    execution_id = "exec-1"
    holder = app_module._adopt_lease_holder(execution_id, service)
    selector = {"app": service}
    staged_value = app_module._adopt_stage_gate_value(holder)
    cr = {
        "metadata": {
            "name": app_module._dev_preview_sandbox_name(execution_id, service),
            "resourceVersion": "4",
            "annotations": {
                app_module.DEV_PREVIEW_ADOPT_HOLDER_ANNOTATION: holder,
                app_module.DEV_PREVIEW_ADOPT_DEPLOYMENT_ANNOTATION: service,
                app_module.DEV_PREVIEW_ADOPT_SELECTOR_ANNOTATION: json.dumps(
                    selector, sort_keys=True, separators=(",", ":")
                ),
                app_module.DEV_PREVIEW_ADOPT_GATE_KEY_ANNOTATION: "app",
                app_module.DEV_PREVIEW_ADOPT_GATE_STAGED_VALUE_ANNOTATION: (
                    staged_value
                ),
            },
        },
        "spec": {
            "podTemplate": {"metadata": {"labels": {"app": service}}}
        },
    }
    patches: list[dict] = []

    class _Custom:
        def get_namespaced_custom_object(self, **_kwargs):
            return json.loads(json.dumps(cr))

        def patch_namespaced_custom_object(self, *, body, **_kwargs):
            patches.append(json.loads(json.dumps(body)))
            cr["spec"]["podTemplate"]["metadata"]["labels"]["app"] = body[
                "spec"
            ]["podTemplate"]["metadata"]["labels"]["app"]

    endpoint_reads: list[str] = []
    core = SimpleNamespace(
        read_namespaced_service=lambda **_kwargs: SimpleNamespace(
            spec=SimpleNamespace(selector=selector)
        ),
        list_namespaced_pod=lambda **_kwargs: SimpleNamespace(items=[]),
        read_namespaced_endpoints=lambda *, name, **_kwargs: (
            endpoint_reads.append(name) or SimpleNamespace(subsets=[])
        ),
    )
    context = {
        "execution": execution_id,
        "service": service,
        "deployment": service,
        "holder": holder,
    }

    member = app_module._dev_preview_gate_member_for_teardown(
        core, namespace="workflow-builder", cr=cr, context=context
    )
    assert member is not None
    assert member.gate_active is True
    assert member.pod_name == ""
    assert member.pod_ip == ""

    app_module._set_staged_dev_preview_gate(
        _Custom(),
        core,
        namespace="workflow-builder",
        member=member,
        active=False,
        require_exact_pod=False,
        timeout_s=0,
    )

    assert patches[0]["spec"]["podTemplate"]["metadata"]["labels"] == {
        "app": staged_value
    }
    assert endpoint_reads == [service]


def test_teardown_refuses_stale_endpoint_when_template_is_already_staged() -> None:
    member = _staged_member("workflow-orchestrator")
    selector = dict(member.active_selector)
    cr = {
        "metadata": {
            "name": member.sandbox_name,
            "resourceVersion": "4",
            "annotations": {
                app_module.DEV_PREVIEW_ADOPT_HOLDER_ANNOTATION: member.holder,
                app_module.DEV_PREVIEW_ADOPT_SELECTOR_ANNOTATION: json.dumps(
                    selector, sort_keys=True, separators=(",", ":")
                ),
                app_module.DEV_PREVIEW_ADOPT_GATE_KEY_ANNOTATION: member.gate_key,
                app_module.DEV_PREVIEW_ADOPT_GATE_STAGED_VALUE_ANNOTATION: (
                    member.staged_gate_value
                ),
            },
        },
        "spec": {
            "podTemplate": {
                "metadata": {
                    "labels": {member.gate_key: member.staged_gate_value}
                }
            }
        },
    }
    endpoint_reads: list[str] = []
    core = SimpleNamespace(
        list_namespaced_pod=lambda **_kwargs: SimpleNamespace(items=[]),
        read_namespaced_endpoints=lambda *, name, **_kwargs: (
            endpoint_reads.append(name)
            or SimpleNamespace(
                subsets=[
                    SimpleNamespace(
                        addresses=[
                            SimpleNamespace(
                                ip="10.0.0.99",
                                target_ref=SimpleNamespace(name="deleted-dev-pod"),
                            )
                        ]
                    )
                ]
            )
        ),
    )
    custom = SimpleNamespace(get_namespaced_custom_object=lambda **_kwargs: cr)

    with pytest.raises(RuntimeError, match="managed or stale"):
        app_module._set_staged_dev_preview_gate(
            custom,
            core,
            namespace="workflow-builder",
            member=member,
            active=False,
            require_exact_pod=False,
            timeout_s=0,
        )

    assert endpoint_reads == [member.service]


def test_batch_phase_transitions_are_resource_version_guarded_and_exact() -> None:
    member = _staged_member("workflow-builder")
    names = [member.sandbox_name]
    batch_id = app_module._dev_preview_batch_id("exec-1", names)
    cr = {
        "metadata": {
            "name": member.sandbox_name,
            "resourceVersion": "4",
            "annotations": {
                app_module.DEV_PREVIEW_ADOPT_HOLDER_ANNOTATION: member.holder,
                app_module.DEV_PREVIEW_ADOPT_STAGED_ANNOTATION: member.holder,
            },
        }
    }
    observed_versions: list[str] = []

    class _Custom:
        def get_namespaced_custom_object(self, **_kwargs):
            return json.loads(json.dumps(cr))

        def patch_namespaced_custom_object(self, *, body, **_kwargs):
            observed_versions.append(body["metadata"]["resourceVersion"])
            assert body["metadata"]["resourceVersion"] == cr["metadata"][
                "resourceVersion"
            ]
            for key, value in body["metadata"]["annotations"].items():
                if value is None:
                    cr["metadata"]["annotations"].pop(key, None)
                else:
                    cr["metadata"]["annotations"][key] = value
            cr["metadata"]["resourceVersion"] = str(
                int(cr["metadata"]["resourceVersion"]) + 1
            )

    custom = _Custom()
    for phase, allowed in [
        ("scheduled", {None}),
        ("activating", {"scheduled"}),
        ("active", {"activating"}),
    ]:
        app_module._set_dev_preview_batch_phase(
            custom,
            namespace="workflow-builder",
            members=(member,),
            execution_id="exec-1",
            sandbox_names=names,
            batch_id=batch_id,
            phase=phase,
            allowed_from=allowed,
        )

    assert observed_versions == ["4", "5", "6"]
    assert app_module._read_dev_preview_batch_phase(
        custom,
        namespace="workflow-builder",
        members=(member,),
        execution_id="exec-1",
        sandbox_names=names,
        batch_id=batch_id,
    ) == ("active", None)


def test_staged_activation_dry_run_returns_immediate_complete_receipt(
    monkeypatch,
) -> None:
    monkeypatch.setenv("SANDBOX_EXECUTION_API_TOKEN", "token")
    monkeypatch.setenv("SANDBOX_EXECUTION_DRY_RUN", "true")
    names = ["wfb-dev-preview-workflow-builder-exec-1"]

    response_status = Response()
    assert app_module.activate_dev_previews(
        SimpleNamespace(headers={"authorization": "Bearer token"}),
        app_module.DevPreviewActivationRequest(
            executionId="exec-1", sandboxNames=names
        ),
        response_status,
    ) == {
        "executionId": "exec-1",
        "sandboxNames": names,
        "batchId": app_module._dev_preview_batch_id("exec-1", names),
        "activationPhase": "active",
        "accepted": True,
        "complete": True,
        "pending": False,
        "activated": True,
    }
    assert response_status.status_code == 200


def test_batch_worker_revalidates_whole_set_before_first_scale(monkeypatch) -> None:
    expected = tuple(
        sorted(
            (_staged_member("workflow-builder"), _staged_member("function-router")),
            key=lambda member: member.sandbox_name,
        )
    )
    events: list[str] = []
    monkeypatch.setattr(app_module.time, "sleep", lambda _seconds: events.append("grace"))
    monkeypatch.setattr(app_module, "_load_k8s_apps_client", object)
    monkeypatch.setattr(
        app_module, "_load_k8s_clients", lambda: (object(), object())
    )
    monkeypatch.setattr(app_module, "_load_k8s_custom_objects_client", object)
    monkeypatch.setattr(app_module, "_load_k8s_coordination_client", object)

    def validate(*_args, **_kwargs):
        events.append("validate-all")
        return expected

    def scale(_apps, *, namespace, name):
        events.append(f"scale:{name}")

    monkeypatch.setattr(app_module, "_validate_staged_dev_preview_batch", validate)
    monkeypatch.setattr(app_module, "_adopt_scale_deployment_down", scale)
    monkeypatch.setattr(
        app_module,
        "_read_dev_preview_batch_phase",
        lambda *_a, **_k: ("scheduled", None),
    )
    monkeypatch.setattr(
        app_module,
        "_set_dev_preview_batch_phase",
        lambda *_a, **kwargs: events.append(f"phase:{kwargs['phase']}"),
    )
    monkeypatch.setattr(
        app_module,
        "_wait_for_adopted_service_endpoints",
        lambda *_a, **kwargs: events.append(f"endpoints:{kwargs['service']}"),
    )
    monkeypatch.setattr(
        app_module,
        "_set_staged_dev_preview_gate",
        lambda *_a, **kwargs: events.append(
            f"gate:{kwargs['member'].service}:{kwargs['active']}"
        ),
    )
    names = [member.sandbox_name for member in expected]

    app_module._activate_staged_dev_preview_batch(
        namespace="workflow-builder",
        execution_id="exec-1",
        sandbox_names=names,
        batch_id=app_module._dev_preview_batch_id("exec-1", names),
    )

    assert events[:4] == [
        "grace",
        "validate-all",
        "validate-all",
        "phase:activating",
    ]
    assert events[4 : 4 + len(expected)] == [
        f"scale:{member.deployment}" for member in expected
    ]
    assert events[-1] == "phase:active"


def test_batch_worker_restart_persists_already_released_batch_without_redrain(
    monkeypatch,
) -> None:
    expected = tuple(
        sorted(
            (
                _staged_member("workflow-builder", gate_active=True),
                _staged_member("function-router", gate_active=True),
            ),
            key=lambda member: member.sandbox_name,
        )
    )
    events: list[str] = []
    monkeypatch.setattr(app_module.time, "sleep", lambda _seconds: None)
    monkeypatch.setattr(app_module, "_load_k8s_apps_client", object)
    monkeypatch.setattr(app_module, "_load_k8s_clients", lambda: (object(), object()))
    monkeypatch.setattr(app_module, "_load_k8s_custom_objects_client", object)
    monkeypatch.setattr(app_module, "_load_k8s_coordination_client", object)
    monkeypatch.setattr(
        app_module, "_validate_staged_dev_preview_batch", lambda *_a, **_k: expected
    )
    monkeypatch.setattr(
        app_module,
        "_read_dev_preview_batch_phase",
        lambda *_a, **_k: ("activating", None),
    )
    monkeypatch.setattr(
        app_module,
        "_set_dev_preview_batch_phase",
        lambda *_a, **kwargs: events.append(f"phase:{kwargs['phase']}"),
    )
    monkeypatch.setattr(
        app_module,
        "_wait_for_adopted_service_endpoints",
        lambda *_a, **kwargs: events.append(
            f"endpoint:{kwargs['service']}:{kwargs['expected_pod']}"
        ),
    )
    monkeypatch.setattr(
        app_module,
        "_adopt_scale_deployment_down",
        lambda *_a, **_k: (_ for _ in ()).throw(
            AssertionError("an already released batch must not be drained")
        ),
    )
    monkeypatch.setattr(
        app_module,
        "_set_staged_dev_preview_gate",
        lambda *_a, **_k: (_ for _ in ()).throw(
            AssertionError("an already released batch must not rewrite gates")
        ),
    )
    names = [member.sandbox_name for member in expected]

    app_module._activate_staged_dev_preview_batch(
        namespace="workflow-builder",
        execution_id="exec-1",
        sandbox_names=names,
        batch_id=app_module._dev_preview_batch_id("exec-1", names),
    )

    assert events == [
        *(f"endpoint:{member.service}:{(member.pod_name, member.pod_ip)}" for member in expected),
        "phase:active",
    ]


def test_batch_worker_restart_quarantines_partial_release_before_redrain(
    monkeypatch,
) -> None:
    expected = tuple(
        sorted(
            (
                _staged_member("workflow-builder", gate_active=True),
                _staged_member("function-router"),
            ),
            key=lambda member: member.sandbox_name,
        )
    )
    events: list[str] = []
    monkeypatch.setattr(app_module.time, "sleep", lambda _seconds: None)
    monkeypatch.setattr(app_module, "_load_k8s_apps_client", object)
    monkeypatch.setattr(app_module, "_load_k8s_clients", lambda: (object(), object()))
    monkeypatch.setattr(app_module, "_load_k8s_custom_objects_client", object)
    monkeypatch.setattr(app_module, "_load_k8s_coordination_client", object)
    monkeypatch.setattr(
        app_module, "_validate_staged_dev_preview_batch", lambda *_a, **_k: expected
    )
    monkeypatch.setattr(
        app_module,
        "_read_dev_preview_batch_phase",
        lambda *_a, **_k: ("activating", None),
    )
    monkeypatch.setattr(
        app_module,
        "_set_dev_preview_batch_phase",
        lambda *_a, **kwargs: events.append(f"phase:{kwargs['phase']}"),
    )
    monkeypatch.setattr(
        app_module,
        "_set_staged_dev_preview_gate",
        lambda *_a, **kwargs: events.append(
            f"gate:{kwargs['member'].service}:{kwargs['active']}"
        ),
    )
    monkeypatch.setattr(
        app_module,
        "_adopt_scale_deployment_down",
        lambda *_a, **kwargs: events.append(f"scale:{kwargs['name']}"),
    )
    monkeypatch.setattr(
        app_module,
        "_wait_for_adopted_service_endpoints",
        lambda *_a, **kwargs: events.append(f"endpoint:{kwargs['service']}"),
    )
    names = [member.sandbox_name for member in expected]

    app_module._activate_staged_dev_preview_batch(
        namespace="workflow-builder",
        execution_id="exec-1",
        sandbox_names=names,
        batch_id=app_module._dev_preview_batch_id("exec-1", names),
    )

    released = next(member for member in expected if member.gate_active)
    first_scale = next(index for index, event in enumerate(events) if event.startswith("scale:"))
    assert events.index(f"gate:{released.service}:False") < first_scale
    assert events[-1] == "phase:active"


def test_batch_worker_rolls_back_and_preserves_evidence_on_mid_scale_failure(
    monkeypatch,
) -> None:
    expected = tuple(
        sorted(
            (
                _staged_member("workflow-builder"),
                _staged_member("function-router"),
                _staged_member("workflow-orchestrator"),
            ),
            key=lambda member: member.sandbox_name,
        )
    )
    scaled: list[str] = []
    restored: list[str] = []
    phases: list[tuple[str, str | None]] = []
    gates: list[tuple[str, bool]] = []
    monkeypatch.setattr(app_module.time, "sleep", lambda _seconds: None)
    monkeypatch.setattr(app_module, "_load_k8s_apps_client", object)
    monkeypatch.setattr(
        app_module, "_load_k8s_clients", lambda: (object(), object())
    )
    monkeypatch.setattr(app_module, "_load_k8s_custom_objects_client", object)
    monkeypatch.setattr(app_module, "_load_k8s_coordination_client", object)
    monkeypatch.setattr(
        app_module, "_validate_staged_dev_preview_batch", lambda *_a, **_k: expected
    )
    monkeypatch.setattr(
        app_module,
        "_read_dev_preview_batch_phase",
        lambda *_a, **_k: ("scheduled", None),
    )
    monkeypatch.setattr(
        app_module,
        "_set_dev_preview_batch_phase",
        lambda *_a, **kwargs: phases.append(
            (kwargs["phase"], kwargs.get("error_code"))
        ),
    )
    monkeypatch.setattr(
        app_module,
        "_set_staged_dev_preview_gate",
        lambda *_a, **kwargs: gates.append(
            (kwargs["member"].service, kwargs["active"])
        ),
    )
    monkeypatch.setattr(
        app_module,
        "_wait_for_adopted_service_endpoints",
        lambda *_a, **_kwargs: None,
    )

    def scale(_apps, *, namespace, name):
        scaled.append(name)
        if len(scaled) == 2:
            raise RuntimeError("mid-batch scale failed")

    monkeypatch.setattr(app_module, "_adopt_scale_deployment_down", scale)
    monkeypatch.setattr(
        app_module,
        "_adopt_restore_deployment",
        lambda _apps, *, namespace, name: restored.append(name),
    )
    deleted: list[str] = []
    monkeypatch.setattr(
        app_module,
        "_teardown_dev_preview_resources",
        lambda **kwargs: deleted.append(kwargs["sandbox_name"]),
    )
    names = [member.sandbox_name for member in expected]

    app_module._activate_staged_dev_preview_batch(
        namespace="workflow-builder",
        execution_id="exec-1",
        sandbox_names=names,
        batch_id=app_module._dev_preview_batch_id("exec-1", names),
    )

    assert scaled == [member.deployment for member in expected[:2]]
    assert restored == [member.deployment for member in expected]
    assert gates == [(member.service, False) for member in expected]
    assert phases == [
        ("activating", None),
        ("failed", "activation-rolled-back"),
    ]
    assert deleted == []


def test_batch_rollback_does_not_restore_member_with_unproven_quarantine(
    monkeypatch,
) -> None:
    unsafe = _staged_member("workflow-builder")
    safe = _staged_member("workflow-orchestrator")
    expected = tuple(sorted((unsafe, safe), key=lambda member: member.sandbox_name))
    restored: list[str] = []
    phases: list[tuple[str, str | None]] = []
    monkeypatch.setattr(app_module.time, "sleep", lambda _seconds: None)
    monkeypatch.setattr(app_module, "_load_k8s_apps_client", object)
    monkeypatch.setattr(app_module, "_load_k8s_clients", lambda: (object(), object()))
    monkeypatch.setattr(app_module, "_load_k8s_custom_objects_client", object)
    monkeypatch.setattr(app_module, "_load_k8s_coordination_client", object)
    monkeypatch.setattr(
        app_module, "_validate_staged_dev_preview_batch", lambda *_a, **_k: expected
    )
    monkeypatch.setattr(
        app_module,
        "_read_dev_preview_batch_phase",
        lambda *_a, **_k: ("scheduled", None),
    )
    monkeypatch.setattr(
        app_module,
        "_set_dev_preview_batch_phase",
        lambda *_a, **kwargs: phases.append(
            (kwargs["phase"], kwargs.get("error_code"))
        ),
    )
    monkeypatch.setattr(
        app_module,
        "_adopt_scale_deployment_down",
        lambda *_a, **_k: (_ for _ in ()).throw(RuntimeError("scale failed")),
    )

    def quarantine(*_args, **kwargs) -> None:
        if kwargs["member"].service == unsafe.service:
            raise RuntimeError("gate state unknown")

    monkeypatch.setattr(app_module, "_set_staged_dev_preview_gate", quarantine)
    monkeypatch.setattr(
        app_module,
        "_adopt_restore_deployment",
        lambda _apps, *, namespace, name: restored.append(name),
    )
    monkeypatch.setattr(
        app_module, "_wait_for_adopted_service_endpoints", lambda *_a, **_k: None
    )
    names = [member.sandbox_name for member in expected]

    app_module._activate_staged_dev_preview_batch(
        namespace="workflow-builder",
        execution_id="exec-1",
        sandbox_names=names,
        batch_id=app_module._dev_preview_batch_id("exec-1", names),
    )

    assert unsafe.deployment not in restored
    assert safe.deployment in restored
    assert phases[-1] == ("failed", "activation-rollback-incomplete")


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
    selectors: list[str] = []
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
        list_namespaced_pod=lambda *, namespace, label_selector: (
            selectors.append(label_selector)
            or SimpleNamespace(items=[bff_pod, orch_pod])
        )
    )

    class FakeCustom:
        def list_namespaced_custom_object(
            self, *, group, version, namespace, plural, label_selector
        ):
            selectors.append(label_selector)
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
    assert selectors == [
        f"{app_module.DEV_PREVIEW_MANAGED_LABEL}="
        f"{app_module.DEV_PREVIEW_MANAGED_VALUE},workflow-execution-id=exec-1",
    ] * 2


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
    # exec bridge lives in the app container and needs a purpose-specific token
    # plus its allowlist; the receiver token must remain sidecar-only.
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
    expected_bridge_token = hashlib.sha256(
        f"dev-sync-bridge/v1\0{'a' * 64}".encode("utf-8")
    ).hexdigest()
    assert app_env["DEV_SYNC_BRIDGE_TOKEN"] == expected_bridge_token
    assert "DEV_SYNC_TOKEN" not in app_env
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
    assert sidecar_env["DEV_SYNC_TOKEN"] == "a" * 64
    assert sidecar_env["DEV_SYNC_BRIDGE_TOKEN"] == expected_bridge_token
    assert "DEV_SYNC_ALLOW_LOCAL_RUN" not in sidecar_env
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
        "DEV_SYNC_BRIDGE_TOKEN",
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
            "name": "WORKFLOW_ORCHESTRATOR_EVENT_TOPIC_PREFIX",
            "value": "wbpreview-app-live-five",
        },
        {
            "name": "WORKFLOW_ORCHESTRATOR_EMIT_LIFECYCLE_EVENTS",
            "value": "true",
        },
        {
            "name": "PREVIEW_NATIVE_ACTION_SLUGS_JSON",
            "value": '["durable/run","dev/preview"]',
        },
        {
            "name": "PREVIEW_FUNCTION_REGISTRY_JSON",
            "valueFrom": {
                "configMapKeyRef": {
                    "name": "function-registry",
                    "key": "functions.json",
                }
            },
        },
        {
            "name": "APP_PUBLIC_URL",
            "valueFrom": {
                "configMapKeyRef": {
                    "name": "preview-environment-identity",
                    "key": "public-url",
                }
            },
        },
        {
            "name": "ORIGIN",
            "valueFrom": {
                "configMapKeyRef": {
                    "name": "preview-environment-identity",
                    "key": "public-url",
                }
            },
        },
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
        {
            "name": "INTERNAL_API_TOKEN",
            "valueFrom": {
                "secretKeyRef": {
                    "name": "workflow-builder-secrets",
                    "key": "INTERNAL_API_TOKEN",
                    "optional": True,
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
        "APP_PUBLIC_URL",
        "CODEX_CLI_APP_ID",
        "DAPR_CONFIG_STORE",
        "INTERNAL_API_TOKEN",
        "ORIGIN",
        "PREVIEW_ACTION_INTERNAL_TOKEN",
        "PREVIEW_CONTROL_BROKER_URL",
        "PREVIEW_CONTROL_CAPABILITY_TOKEN",
        "PREVIEW_DEV_SYNC_MINT_TOKEN",
        "PREVIEW_ENVIRONMENT_NAME",
        "PREVIEW_FUNCTION_REGISTRY_JSON",
        "PREVIEW_NATIVE_ACTION_SLUGS_JSON",
        "SANDBOX_EXECUTION_API_TOKEN",
        "WORKFLOW_ORCHESTRATOR_EMIT_LIFECYCLE_EVENTS",
        "WORKFLOW_ORCHESTRATOR_EVENT_TOPIC_PREFIX",
    }
    assert (
        by_name["PREVIEW_DEV_SYNC_MINT_TOKEN"]["valueFrom"]["secretKeyRef"]["key"]
        == "sync-token"
    )
    assert (
        by_name["WORKFLOW_ORCHESTRATOR_EVENT_TOPIC_PREFIX"]["value"]
        == "wbpreview-app-live-five"
    )
    assert by_name["WORKFLOW_ORCHESTRATOR_EMIT_LIFECYCLE_EVENTS"]["value"] == "true"
    assert (
        by_name["PREVIEW_FUNCTION_REGISTRY_JSON"]["valueFrom"]["configMapKeyRef"]
        == {"name": "function-registry", "key": "functions.json"}
    )
    assert (
        by_name["ORIGIN"]["valueFrom"]["configMapKeyRef"]
        == {"name": "preview-environment-identity", "key": "public-url"}
    )


def test_adopted_internal_token_requires_exact_secret_reference() -> None:
    valid = {
        "name": "INTERNAL_API_TOKEN",
        "valueFrom": {
            "secretKeyRef": {
                "name": "workflow-builder-secrets",
                "key": "INTERNAL_API_TOKEN",
                "optional": True,
            }
        },
    }
    filtered = app_module._filter_adopted_container_env(
        [
            valid,
            {"name": "INTERNAL_API_TOKEN", "value": "literal-token"},
            {
                "name": "INTERNAL_API_TOKEN",
                "valueFrom": {
                    "secretKeyRef": {
                        "name": "unrelated-secret",
                        "key": "INTERNAL_API_TOKEN",
                    }
                },
            },
            {
                "name": "INTERNAL_API_TOKEN",
                "valueFrom": {
                    "secretKeyRef": {
                        "name": "workflow-builder-secrets",
                        "key": "OTHER_KEY",
                    }
                },
            },
        ]
    )
    assert filtered == [valid]


def test_adopted_capability_and_origin_refs_require_exact_config_maps() -> None:
    filtered = app_module._filter_adopted_container_env(
        [
            {
                "name": "APP_PUBLIC_URL",
                "valueFrom": {
                    "configMapKeyRef": {
                        "name": "attacker-config",
                        "key": "public-url",
                    }
                },
            },
            {
                "name": "ORIGIN",
                "valueFrom": {
                    "configMapKeyRef": {
                        "name": "preview-environment-identity",
                        "key": "wrong-key",
                    }
                },
            },
            {
                "name": "PREVIEW_FUNCTION_REGISTRY_JSON",
                "valueFrom": {
                    "configMapKeyRef": {
                        "name": "wrong-registry",
                        "key": "functions.json",
                    }
                },
            },
        ]
    )

    assert filtered is None


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


def test_adopt_identity_inherits_only_config_map_file_mounts() -> None:
    main = SimpleNamespace(
        name="function-router",
        env=None,
        volume_mounts=[
            {"name": "function-registry", "mountPath": "/config"},
            {"name": "credentials", "mountPath": "/secrets", "readOnly": True},
            {"name": "workspace", "mountPath": "/data"},
        ],
    )
    pod_spec = SimpleNamespace(
        service_account_name="workflow-functions",
        containers=[main],
        volumes=[
            {
                "name": "function-registry",
                "configMap": {
                    "name": "function-registry",
                    "items": [{"key": "functions.json", "path": "functions.json"}],
                },
            },
            {"name": "credentials", "secret": {"secretName": "credentials"}},
            {"name": "workspace", "persistentVolumeClaim": {"claimName": "work"}},
        ],
    )
    deployment = SimpleNamespace(
        spec=SimpleNamespace(
            template=SimpleNamespace(
                metadata=SimpleNamespace(annotations={}),
                spec=pod_spec,
            )
        )
    )
    apps = SimpleNamespace(
        api_client=SimpleNamespace(sanitize_for_serialization=lambda value: value),
        read_namespaced_deployment=lambda **_kwargs: deployment,
    )

    identity = app_module._adopt_read_identity(
        apps, namespace="workflow-builder", name="function-router"
    )

    assert identity is not None
    assert identity["configMapMounts"] == [
        {
            "volume": {
                "name": "function-registry",
                "configMap": {
                    "name": "function-registry",
                    "items": [{"key": "functions.json", "path": "functions.json"}],
                },
            },
            "mount": {
                "name": "function-registry",
                "mountPath": "/config",
                "readOnly": True,
            },
        }
    ]
    assert "credentials" not in json.dumps(identity["configMapMounts"])
    assert "workspace" not in json.dumps(identity["configMapMounts"])


def test_adopted_manifest_mounts_platform_config_map_read_only() -> None:
    manifest = build_dev_preview_sandbox_manifest(
        DevPreviewRequest(
            executionId="exec-1",
            service="function-router",
            previewNative=True,
            workdir="/app",
            syncMode="sidecar",
        ),
        namespace="workflow-builder",
        class_config=_dev_class(),
        adopt_config_map_mounts=[
            {
                "volume": {
                    "name": "function-registry",
                    "configMap": {"name": "function-registry"},
                },
                "mount": {"name": "function-registry", "mountPath": "/config"},
            },
            {
                "volume": {
                    "name": "mutable-source-mask",
                    "configMap": {"name": "must-not-mask-source"},
                },
                "mount": {
                    "name": "mutable-source-mask",
                    "mountPath": "/app/config",
                },
            },
        ],
    )
    pod = manifest["spec"]["podTemplate"]["spec"]
    dev = next(c for c in pod["containers"] if c["name"] == "dev")

    assert {
        "name": "function-registry",
        "mountPath": "/config",
        "readOnly": True,
    } in dev["volumeMounts"]
    assert {
        "name": "function-registry",
        "configMap": {"name": "function-registry"},
    } in pod["volumes"]
    assert not any(
        mount["name"] == "mutable-source-mask" for mount in dev["volumeMounts"]
    )
    assert not any(
        volume["name"] == "mutable-source-mask" for volume in pod["volumes"]
    )


@pytest.mark.parametrize(
    ("workdir", "mount_path"),
    [
        ("/app/.", "/app/config"),
        ("/app//src", "/app/src/config"),
        ("/app/src/..", "/app/config"),
        ("/app", "/config/../app/config"),
    ],
)
def test_adopted_manifest_normalizes_paths_before_workdir_overlap_check(
    workdir: str, mount_path: str
) -> None:
    manifest = build_dev_preview_sandbox_manifest(
        DevPreviewRequest(
            executionId="exec-1",
            service="function-router",
            previewNative=True,
            workdir=workdir,
            syncMode="sidecar",
        ),
        namespace="workflow-builder",
        class_config=_dev_class(),
        adopt_config_map_mounts=[
            {
                "volume": {
                    "name": "source-mask",
                    "configMap": {"name": "must-not-mask-source"},
                },
                "mount": {"name": "source-mask", "mountPath": mount_path},
            }
        ],
    )
    pod = manifest["spec"]["podTemplate"]["spec"]
    dev = next(c for c in pod["containers"] if c["name"] == "dev")

    assert not any(mount["name"] == "source-mask" for mount in dev["volumeMounts"])
    assert not any(volume["name"] == "source-mask" for volume in pod["volumes"])


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
        deployment = next(d for d in deployments if d.metadata.name == name)
        deployment.spec.replicas = body["spec"]["replicas"]
        for key, value in body["metadata"]["annotations"].items():
            if value is None:
                deployment.metadata.annotations.pop(key, None)
            else:
                deployment.metadata.annotations[key] = value

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


def test_periodic_cleanup_in_candidate_skips_host_identity_and_restores_adoptions(
    monkeypatch,
) -> None:
    apps = object()
    custom = object()
    restored = {"restored": ["workflow-builder"]}
    monkeypatch.setenv("PREVIEW_HOST_RUNTIMES_DISABLED", "true")
    monkeypatch.setattr(
        app_module,
        "_load_k8s_clients",
        lambda: (_ for _ in ()).throw(AssertionError("host clients must not load")),
    )
    monkeypatch.setattr(app_module, "_load_k8s_apps_client", lambda: apps)
    monkeypatch.setattr(app_module, "_load_k8s_custom_objects_client", lambda: custom)
    monkeypatch.setattr(app_module, "_load_k8s_coordination_client", object)
    monkeypatch.setattr(
        app_module,
        "_agent_workflow_host_namespace",
        lambda: "preview-workflow-builder",
    )
    monkeypatch.setattr(
        app_module,
        "_adopt_restore_orphans",
        lambda received_apps, received_custom, *, namespace, coordination: restored,
    )

    result = app_module._preview_periodic_cleanup_once()

    assert result == {
        "identity": None,
        "runnerOrphans": None,
        "adoptOrphans": restored,
        "failures": [],
    }


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
        self.service = "workflow-builder"
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
            "metadata": {
                "name": name,
                "namespace": namespace,
                "labels": {
                    "app": "wfb-dev-preview",
                    app_module.DEV_PREVIEW_MANAGED_LABEL: (
                        app_module.DEV_PREVIEW_MANAGED_VALUE
                    ),
                    "workflow-execution-id": "exec-1",
                    "dev-preview-service": self.service,
                },
                "annotations": self.annotations,
            },
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


def test_provision_409_rejects_unrelated_sandbox_identity(monkeypatch) -> None:
    fake_custom = _provision_409_harness(
        monkeypatch, class_image="img:v1", existing_image="img:v1"
    )
    fake_custom.service = "workflow-orchestrator"

    with pytest.raises(HTTPException) as raised:
        app_module.provision_dev_preview(
            SimpleNamespace(headers={"authorization": "Bearer token"}),
            DevPreviewRequest(executionId="exec-1", service="workflow-builder"),
        )

    assert raised.value.status_code == 409
    assert "exact managed dev preview" in str(raised.value.detail)
    assert fake_custom.deletes == []


def test_provision_409_unrelated_sandbox_releases_new_adoption_lease(
    monkeypatch,
) -> None:
    deployment = "function-router"
    fake_custom = _provision_409_harness(
        monkeypatch, class_image="img:v1", existing_image="img:v1"
    )
    fake_custom.service = "workflow-orchestrator"
    coordination = _FakeAdoptionCoordination()
    monkeypatch.setenv("DEV_PREVIEW_PLATFORM_SCOPE", "vcluster")
    monkeypatch.setattr(app_module, "_adopt_read_identity", lambda *_a, **_k: None)
    monkeypatch.setattr(
        app_module, "_load_k8s_coordination_client", lambda: coordination
    )

    with pytest.raises(HTTPException, match="exact managed dev preview"):
        app_module.provision_dev_preview(
            SimpleNamespace(headers={"authorization": "Bearer token"}),
            DevPreviewRequest(
                executionId="exec-1",
                service=deployment,
                previewNative=True,
                adoptDeployment=deployment,
            ),
        )

    assert coordination.lease is None
    assert len(coordination.deletes) == 1


@pytest.mark.parametrize("deployment", ["workflow-builder", "function-router"])
def test_adopted_response_path_image_drift_fails_closed(
    monkeypatch, deployment
) -> None:
    fake_custom = _provision_409_harness(
        monkeypatch, class_image="img:v2", existing_image="img:v1"
    )
    coordination = _FakeAdoptionCoordination()
    holder = app_module._adopt_lease_holder("exec-1", deployment)
    fake_custom.service = deployment
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
                service=deployment,
                previewNative=True,
                adoptDeployment=deployment,
            ),
        )

    assert raised.value.status_code == 409
    assert "fresh acceptance preview" in str(raised.value.detail)
    assert fake_custom.deletes == []
    assert fake_custom.recreates == []
    assert coordination.lease is not None


def test_non_staged_reprovision_cannot_bypass_batch_activation(monkeypatch) -> None:
    deployment = "function-router"
    fake_custom = _provision_409_harness(
        monkeypatch, class_image="img:v1", existing_image="img:v1"
    )
    coordination = _FakeAdoptionCoordination()
    holder = app_module._acquire_dev_preview_adoption_lease(
        coordination,
        namespace="workflow-builder",
        deployment=deployment,
        execution_id="exec-1",
        service=deployment,
    )
    fake_custom.service = deployment
    fake_custom.annotations.update(
        {
            app_module.DEV_PREVIEW_ADOPT_HOLDER_ANNOTATION: holder,
            app_module.DEV_PREVIEW_ADOPT_STAGED_ANNOTATION: holder,
        }
    )
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
                service=deployment,
                previewNative=True,
                adoptDeployment=deployment,
            ),
        )

    assert raised.value.status_code == 409
    assert "batch activation endpoint" in str(raised.value.detail)


def test_response_path_cutover_cancellation_is_resource_version_guarded() -> None:
    coordination = _FakeAdoptionCoordination()
    holder = app_module._acquire_dev_preview_adoption_lease(
        coordination,
        namespace="workflow-builder",
        deployment="function-router",
        execution_id="exec-1",
        service="function-router",
    )

    class _CutoverCustom:
        def __init__(self) -> None:
            self.cr = {
                "metadata": {
                    "resourceVersion": "7",
                    "labels": {
                        "app": "wfb-dev-preview",
                        app_module.DEV_PREVIEW_MANAGED_LABEL: (
                            app_module.DEV_PREVIEW_MANAGED_VALUE
                        ),
                        "workflow-execution-id": "exec-1",
                        "dev-preview-service": "function-router",
                    },
                    "annotations": {
                        app_module.DEV_PREVIEW_ADOPT_HOLDER_ANNOTATION: holder
                    },
                }
            }
            self.patches: list[dict] = []

        def get_namespaced_custom_object(self, **_kwargs):
            return json.loads(json.dumps(self.cr))

        def patch_namespaced_custom_object(self, *, body, **_kwargs):
            self.patches.append(json.loads(json.dumps(body)))
            assert body["metadata"]["resourceVersion"] == "7"
            annotations = body["metadata"]["annotations"]
            assert annotations[app_module.DEV_PREVIEW_ADOPT_HOLDER_ANNOTATION] is None
            self.cr["metadata"]["annotations"].pop(
                app_module.DEV_PREVIEW_ADOPT_HOLDER_ANNOTATION
            )
            self.cr["metadata"]["annotations"][
                app_module.DEV_PREVIEW_ADOPT_CUTOVER_CANCELLED_ANNOTATION
            ] = annotations[app_module.DEV_PREVIEW_ADOPT_CUTOVER_CANCELLED_ANNOTATION]
            self.cr["metadata"]["resourceVersion"] = "8"

    custom = _CutoverCustom()

    assert app_module._dev_preview_adoption_is_current(
        custom,
        coordination,
        namespace="workflow-builder",
        sandbox_name="wfb-dev-preview-exec-1-function-router",
        deployment="function-router",
        holder=holder,
    )
    assert app_module._cancel_dev_preview_deferred_cutover(
        custom,
        namespace="workflow-builder",
        sandbox_name="wfb-dev-preview-exec-1-function-router",
        holder=holder,
    )
    assert len(custom.patches) == 1
    assert not app_module._dev_preview_adoption_is_current(
        custom,
        coordination,
        namespace="workflow-builder",
        sandbox_name="wfb-dev-preview-exec-1-function-router",
        deployment="function-router",
        holder=holder,
    )
    assert app_module._dev_preview_teardown_context(
        custom,
        namespace="workflow-builder",
        sandbox_name="wfb-dev-preview-exec-1-function-router",
    )["holder"] == holder


def test_response_path_cutover_cancellation_retries_resource_version_conflict() -> None:
    holder = "adopt:exec-1:digest:workflow-builder"

    class _ConflictingCustom:
        def __init__(self) -> None:
            self.resource_version = 1
            self.attempts: list[str] = []
            self.cancelled = False

        def get_namespaced_custom_object(self, **_kwargs):
            annotations = {
                (
                    app_module.DEV_PREVIEW_ADOPT_CUTOVER_CANCELLED_ANNOTATION
                    if self.cancelled
                    else app_module.DEV_PREVIEW_ADOPT_HOLDER_ANNOTATION
                ): holder
            }
            return {
                "metadata": {
                    "resourceVersion": str(self.resource_version),
                    "annotations": annotations,
                }
            }

        def patch_namespaced_custom_object(self, *, body, **_kwargs):
            resource_version = body["metadata"]["resourceVersion"]
            self.attempts.append(resource_version)
            if len(self.attempts) == 1:
                self.resource_version += 1
                raise _Api4xx(409)
            assert resource_version == str(self.resource_version)
            self.cancelled = True
            self.resource_version += 1

    custom = _ConflictingCustom()

    assert app_module._cancel_dev_preview_deferred_cutover(
        custom,
        namespace="workflow-builder",
        sandbox_name="wfb-dev-preview-exec-1-workflow-builder",
        holder=holder,
    )
    assert custom.attempts == ["1", "2"]


@pytest.mark.parametrize("deployment", ["workflow-builder", "function-router"])
def test_self_adopt_teardown_returns_before_deferred_cleanup(
    monkeypatch, deployment
) -> None:
    context = {
        "execution": "exec-1",
        "service": deployment,
        "deployment": deployment,
        "holder": app_module._adopt_lease_holder("exec-1", deployment),
        "secret": None,
        "uid": "uid-1",
        "resourceVersion": "7",
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
    monkeypatch.setattr(
        app_module,
        "_cancel_dev_preview_deferred_cutover",
        lambda *_args, **_kwargs: events.append("cancelled") or True,
    )

    class _TransitionLock:
        def __enter__(self):
            events.append("lock-entered")

        def __exit__(self, *_args):
            events.append("lock-released")

    monkeypatch.setattr(
        app_module,
        "_dev_preview_adoption_transition_lock",
        lambda *_args: _TransitionLock(),
    )

    response = app_module.teardown_dev_preview(
        SimpleNamespace(headers={"authorization": "Bearer token"}),
        f"wfb-dev-preview-{deployment}-exec-1",
        execution_id="exec-1",
        service=deployment,
    )

    assert isinstance(response, app_module.JSONResponse)
    assert response.status_code == 202
    assert json.loads(response.body) == {
        "sandboxName": f"wfb-dev-preview-{deployment}-exec-1",
        "accepted": True,
        "deleted": False,
        "deferred": True,
    }
    assert events == ["lock-entered", "cancelled", "started", "lock-released"]
    assert captured["daemon"] is True

    captured["target"](**captured["kwargs"])
    assert events[4] == 15
    assert events[5] == "lock-entered"
    assert events[6][0] == "cleanup"
    assert events[6][1]["context"] is context
    assert events[7] == "lock-released"


def test_self_adopt_teardown_fails_closed_before_scheduling_when_not_cancelled(
    monkeypatch,
) -> None:
    context = {
        "execution": "exec-1",
        "service": "function-router",
        "deployment": "function-router",
        "holder": app_module._adopt_lease_holder("exec-1", "function-router"),
        "secret": None,
        "uid": "uid-1",
        "resourceVersion": "7",
    }
    started: list[bool] = []

    monkeypatch.setenv("SANDBOX_EXECUTION_API_TOKEN", "token")
    monkeypatch.setattr(
        app_module, "_agent_workflow_host_namespace", lambda: "workflow-builder"
    )
    monkeypatch.setattr(app_module, "_load_k8s_custom_objects_client", lambda: object())
    monkeypatch.setattr(
        app_module, "_dev_preview_teardown_context", lambda *_a, **_k: context
    )
    monkeypatch.setattr(
        app_module, "_cancel_dev_preview_deferred_cutover", lambda *_a, **_k: False
    )
    monkeypatch.setattr(
        app_module.threading,
        "Thread",
        lambda **_kwargs: started.append(True),
    )

    with pytest.raises(HTTPException) as raised:
        app_module.teardown_dev_preview(
            SimpleNamespace(headers={"authorization": "Bearer token"}),
            "wfb-dev-preview-function-router-exec-1",
            execution_id="exec-1",
            service="function-router",
        )

    assert raised.value.status_code == 503
    assert "cutover cancellation" in str(raised.value.detail)
    assert started == []


def test_dev_preview_teardown_dry_run_returns_complete_receipt(monkeypatch) -> None:
    monkeypatch.setenv("SANDBOX_EXECUTION_API_TOKEN", "token")
    monkeypatch.setenv("SANDBOX_EXECUTION_DRY_RUN", "true")
    monkeypatch.setattr(
        app_module, "_agent_workflow_host_namespace", lambda: "workflow-builder"
    )

    assert app_module.teardown_dev_preview(
        SimpleNamespace(headers={"authorization": "Bearer token"}),
        "wfb-dev-preview-function-router-exec-1",
        execution_id="exec-1",
        service="function-router",
    ) == {
        "sandboxName": "wfb-dev-preview-function-router-exec-1",
        "accepted": True,
        "deleted": True,
        "deferred": False,
    }


def test_dev_preview_teardown_rejects_mismatched_exact_tuple_before_cluster_access(
    monkeypatch,
) -> None:
    monkeypatch.setenv("SANDBOX_EXECUTION_API_TOKEN", "token")
    monkeypatch.setattr(
        app_module,
        "_agent_workflow_host_namespace",
        lambda: (_ for _ in ()).throw(AssertionError("cluster access is forbidden")),
    )

    with pytest.raises(HTTPException) as raised:
        app_module.teardown_dev_preview(
            SimpleNamespace(headers={"authorization": "Bearer token"}),
            "wfb-dev-preview-workflow-builder-other-execution",
            execution_id="exec-1",
            service="workflow-builder",
        )

    assert raised.value.status_code == 409
    assert "does not match" in str(raised.value.detail)


def test_dev_preview_teardown_cleans_exact_secret_and_lease_when_cr_is_absent(
    monkeypatch,
) -> None:
    class _NotFound(Exception):
        status = 404

    execution_id = "exec-1"
    service = "workflow-orchestrator"
    secret_name = app_module._dev_preview_secret_name(execution_id, service)
    secret_deleted = False
    lease_deleted = False
    lease = app_module._adopt_lease_body(
        namespace="workflow-builder",
        deployment=service,
        execution_id=execution_id,
        service=service,
    )
    lease["metadata"]["resourceVersion"] = "9"

    class _Custom:
        def get_namespaced_custom_object(self, **_kwargs):
            raise _NotFound()

    class _Core:
        def read_namespaced_secret(self, **_kwargs):
            if secret_deleted:
                raise _NotFound()
            return {
                "metadata": {
                    "name": secret_name,
                    "namespace": "workflow-builder",
                    "uid": "secret-uid",
                    "resourceVersion": "8",
                    "labels": {
                        "app": "wfb-dev-preview",
                        app_module.DEV_PREVIEW_MANAGED_LABEL: (
                            app_module.DEV_PREVIEW_MANAGED_VALUE
                        ),
                        "workflow-execution-id": execution_id,
                        "dev-preview-service": service,
                    },
                }
            }

        def delete_namespaced_secret(self, *, body, **_kwargs):
            nonlocal secret_deleted
            assert body["preconditions"] == {
                "uid": "secret-uid",
                "resourceVersion": "8",
            }
            secret_deleted = True

    class _Coordination:
        def read_namespaced_lease(self, **_kwargs):
            if lease_deleted:
                raise _NotFound()
            return lease

        def delete_namespaced_lease(self, *, body, **_kwargs):
            nonlocal lease_deleted
            assert body["preconditions"] == {"resourceVersion": "9"}
            lease_deleted = True

    monkeypatch.setenv("SANDBOX_EXECUTION_API_TOKEN", "token")
    monkeypatch.setattr(
        app_module, "_agent_workflow_host_namespace", lambda: "workflow-builder"
    )
    monkeypatch.setattr(
        app_module, "_load_k8s_custom_objects_client", lambda: _Custom()
    )
    monkeypatch.setattr(
        app_module, "_load_k8s_clients", lambda: (object(), _Core())
    )
    monkeypatch.setattr(
        app_module, "_load_k8s_coordination_client", lambda: _Coordination()
    )
    monkeypatch.setattr(
        app_module,
        "_load_k8s_apps_client",
        lambda: (_ for _ in ()).throw(AssertionError("Deployment restore is forbidden")),
    )

    response = app_module.teardown_dev_preview(
        SimpleNamespace(headers={"authorization": "Bearer token"}),
        app_module._dev_preview_sandbox_name(execution_id, service),
        execution_id=execution_id,
        service=service,
    )

    assert response["deleted"] is True
    assert response["deferred"] is False
    assert secret_deleted is True
    assert lease_deleted is True


def test_dev_preview_teardown_fails_when_absent_cr_support_cleanup_is_ambiguous(
    monkeypatch,
) -> None:
    class _NotFound(Exception):
        status = 404

    execution_id = "exec-1"
    service = "workflow-orchestrator"
    mismatched_lease = app_module._adopt_lease_body(
        namespace="workflow-builder",
        deployment=service,
        execution_id="other-execution",
        service=service,
    )
    mismatched_lease["metadata"]["resourceVersion"] = "9"
    custom = SimpleNamespace(
        get_namespaced_custom_object=lambda **_kwargs: (_ for _ in ()).throw(
            _NotFound()
        )
    )
    core = SimpleNamespace(
        read_namespaced_secret=lambda **_kwargs: (_ for _ in ()).throw(_NotFound())
    )
    coordination = SimpleNamespace(
        read_namespaced_lease=lambda **_kwargs: mismatched_lease
    )
    monkeypatch.setenv("SANDBOX_EXECUTION_API_TOKEN", "token")
    monkeypatch.setattr(
        app_module, "_agent_workflow_host_namespace", lambda: "workflow-builder"
    )
    monkeypatch.setattr(
        app_module, "_load_k8s_custom_objects_client", lambda: custom
    )
    monkeypatch.setattr(app_module, "_load_k8s_clients", lambda: (object(), core))
    monkeypatch.setattr(
        app_module, "_load_k8s_coordination_client", lambda: coordination
    )

    with pytest.raises(HTTPException) as raised:
        app_module.teardown_dev_preview(
            SimpleNamespace(headers={"authorization": "Bearer token"}),
            app_module._dev_preview_sandbox_name(execution_id, service),
            execution_id=execution_id,
            service=service,
        )

    assert raised.value.status_code == 503
    assert "could not be proven" in str(raised.value.detail)


def test_teardown_intent_fences_later_provision_before_cluster_access(
    monkeypatch,
) -> None:
    monkeypatch.setenv("SANDBOX_EXECUTION_API_TOKEN", "token")
    with app_module._DEV_PREVIEW_TEARDOWN_INTENTS_GUARD:
        app_module._DEV_PREVIEW_TEARDOWN_INTENTS.discard("exec-fenced")
    try:
        receipt = app_module.establish_dev_preview_teardown_intent(
            SimpleNamespace(headers={"authorization": "Bearer token"}),
            app_module.DevPreviewTeardownIntentRequest(executionId="exec-fenced"),
        )
        monkeypatch.setattr(
            app_module,
            "_load_execution_classes",
            lambda: (_ for _ in ()).throw(
                AssertionError("cluster access must not begin after teardown intent")
            ),
        )

        with pytest.raises(HTTPException) as raised:
            app_module.provision_dev_preview(
                SimpleNamespace(headers={"authorization": "Bearer token"}),
                DevPreviewRequest(executionId="exec-fenced"),
            )

        assert receipt == {"accepted": True, "executionId": "exec-fenced"}
        assert raised.value.status_code == 409
    finally:
        with app_module._DEV_PREVIEW_TEARDOWN_INTENTS_GUARD:
            app_module._DEV_PREVIEW_TEARDOWN_INTENTS.discard("exec-fenced")


def test_teardown_intent_read_returns_exact_fence_state(monkeypatch) -> None:
    monkeypatch.setenv("SANDBOX_EXECUTION_API_TOKEN", "token")
    request = SimpleNamespace(headers={"authorization": "Bearer token"})
    with app_module._DEV_PREVIEW_TEARDOWN_INTENTS_GUARD:
        app_module._DEV_PREVIEW_TEARDOWN_INTENTS.discard("exec-fenced")
    try:
        assert app_module.read_dev_preview_teardown_intent(
            request, executionId="exec-fenced"
        ) == {
            "executionId": "exec-fenced",
            "teardownIntent": False,
        }

        app_module.establish_dev_preview_teardown_intent(
            request,
            app_module.DevPreviewTeardownIntentRequest(executionId="exec-fenced"),
        )

        assert app_module.read_dev_preview_teardown_intent(
            request, executionId="exec-fenced"
        ) == {
            "executionId": "exec-fenced",
            "teardownIntent": True,
        }
    finally:
        with app_module._DEV_PREVIEW_TEARDOWN_INTENTS_GUARD:
            app_module._DEV_PREVIEW_TEARDOWN_INTENTS.discard("exec-fenced")


def test_teardown_intent_read_requires_internal_auth(monkeypatch) -> None:
    monkeypatch.setenv("SANDBOX_EXECUTION_API_TOKEN", "token")

    with pytest.raises(HTTPException) as raised:
        app_module.read_dev_preview_teardown_intent(
            SimpleNamespace(headers={}), executionId="exec-fenced"
        )

    assert raised.value.status_code == 401


def test_teardown_context_rejects_unrelated_sandbox() -> None:
    unrelated = {
        "metadata": {
            "name": "agent-host-exec-1",
            "uid": "agent-uid",
            "resourceVersion": "9",
            "labels": {
                "app": "agent-workflow-host",
                "workflow-execution-id": "exec-1",
            },
        }
    }
    custom = SimpleNamespace(
        get_namespaced_custom_object=lambda **_kwargs: unrelated
    )

    with pytest.raises(RuntimeError, match="not managed"):
        app_module._dev_preview_teardown_context(
            custom,
            namespace="workflow-builder",
            sandbox_name="agent-host-exec-1",
        )


def test_dev_preview_secret_delete_is_owned_and_observed() -> None:
    name = "dev-preview-secret-workflow-orchestrator-exec-1"

    class _NotFound(Exception):
        status = 404

    class _Core:
        deleted = False
        body: dict | None = None

        def read_namespaced_secret(self, **_kwargs):
            if self.deleted:
                raise _NotFound()
            return SimpleNamespace(
                metadata=SimpleNamespace(
                    name=name,
                    namespace="workflow-builder",
                    uid="uid-1",
                    resource_version="7",
                    labels={
                        "app": "wfb-dev-preview",
                        app_module.DEV_PREVIEW_MANAGED_LABEL: (
                            app_module.DEV_PREVIEW_MANAGED_VALUE
                        ),
                        "workflow-execution-id": "exec-1",
                        "dev-preview-service": "workflow-orchestrator",
                    },
                )
            )

        def delete_namespaced_secret(self, *, body, **_kwargs):
            self.body = body
            self.deleted = True

    core = _Core()
    app_module._delete_dev_preview_secret_and_wait(
        core,
        namespace="workflow-builder",
        name=name,
        execution_id="exec-1",
        service="workflow-orchestrator",
        timeout_s=0,
    )

    assert core.body is not None
    assert core.body["preconditions"] == {"uid": "uid-1", "resourceVersion": "7"}


def test_dev_preview_secret_delete_rejects_mismatched_owner() -> None:
    secret = SimpleNamespace(
        metadata=SimpleNamespace(
            name="dev-preview-secret-workflow-orchestrator-exec-1",
            namespace="workflow-builder",
            uid="uid-1",
            resource_version="7",
            labels={
                "app": "wfb-dev-preview",
                app_module.DEV_PREVIEW_MANAGED_LABEL: (
                    app_module.DEV_PREVIEW_MANAGED_VALUE
                ),
                "workflow-execution-id": "other-execution",
                "dev-preview-service": "workflow-orchestrator",
            },
        )
    )
    core = SimpleNamespace(read_namespaced_secret=lambda **_kwargs: secret)

    with pytest.raises(RuntimeError, match="ownership changed"):
        app_module._delete_dev_preview_secret_and_wait(
            core,
            namespace="workflow-builder",
            name="dev-preview-secret-workflow-orchestrator-exec-1",
            execution_id="exec-1",
            service="workflow-orchestrator",
        )


def test_delayed_teardown_refuses_a_newer_sandbox_uid_before_restore(
    monkeypatch,
) -> None:
    restored: list[str] = []
    context = {
        "execution": "exec-1",
        "service": "workflow-builder",
        "deployment": "workflow-builder",
        "holder": "adopt:exec-1:digest:workflow-builder",
        "uid": "old-uid",
        "resourceVersion": "7",
    }
    newer = {
        "metadata": {
            "uid": "new-uid",
            "resourceVersion": "8",
            "labels": {
                "workflow-execution-id": "exec-1",
                "dev-preview-service": "workflow-builder",
            },
            "annotations": {
                app_module.DEV_PREVIEW_ADOPT_DEPLOYMENT_ANNOTATION: "workflow-builder",
                app_module.DEV_PREVIEW_ADOPT_HOLDER_ANNOTATION: context["holder"],
            },
        }
    }
    custom = SimpleNamespace(
        get_namespaced_custom_object=lambda **_kwargs: newer
    )
    monkeypatch.setattr(
        app_module, "_load_k8s_custom_objects_client", lambda: custom
    )
    monkeypatch.setattr(app_module, "_load_k8s_apps_client", object)
    monkeypatch.setattr(
        app_module, "_load_k8s_clients", lambda: (object(), object())
    )
    monkeypatch.setattr(app_module, "_load_k8s_coordination_client", object)
    monkeypatch.setattr(
        app_module,
        "_adopt_restore_deployment",
        lambda *_a, **_k: restored.append("restore"),
    )

    with pytest.raises(RuntimeError, match="ownership changed"):
        app_module._teardown_dev_preview_resources(
            namespace="workflow-builder",
            sandbox_name="wfb-dev-preview-workflow-builder-exec-1",
            context=context,
        )

    assert restored == []


def test_teardown_restores_production_before_releasing_adoption_lease(
    monkeypatch,
) -> None:
    events: list[str] = []
    custom = object()
    apps = object()
    coordination = object()
    core = SimpleNamespace(
        delete_collection_namespaced_secret=lambda **_kwargs: events.append("unused")
    )
    context = {
        "execution": "exec-1",
        "service": "workflow-orchestrator",
        "deployment": "workflow-orchestrator",
        "holder": "adopt:exec-1:digest:workflow-orchestrator",
        "secret": "dev-preview-secret-workflow-orchestrator-exec-1",
        "uid": "uid-1",
        "resourceVersion": "7",
    }
    cr = {
        "metadata": {
            "name": "wfb-dev-preview-exec-1-workflow-orchestrator",
            "uid": "uid-1",
            "resourceVersion": "7",
            "annotations": {},
        }
    }
    proof_calls = 0

    def prove(*_args, **_kwargs):
        nonlocal proof_calls
        proof_calls += 1
        return (cr, coordination)

    monkeypatch.setattr(app_module, "_load_k8s_custom_objects_client", lambda: custom)
    monkeypatch.setattr(app_module, "_load_k8s_clients", lambda: (object(), core))
    monkeypatch.setattr(app_module, "_prove_dev_preview_teardown_owner", prove)
    monkeypatch.setattr(
        app_module,
        "_wait_for_adopted_service_endpoints",
        lambda *_args, **_kwargs: events.append("endpoint"),
    )
    monkeypatch.setattr(
        app_module,
        "_delete_dev_preview_cr_and_wait",
        lambda *_args, **_kwargs: events.append("sandbox") or True,
    )
    monkeypatch.setattr(
        app_module,
        "_delete_dev_preview_secret_and_wait",
        lambda *_args, **_kwargs: events.append("secret"),
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
        lambda *_args, **_kwargs: events.append("release") or True,
    )

    app_module._teardown_dev_preview_resources(
        namespace="workflow-builder",
        sandbox_name="wfb-dev-preview-exec-1-workflow-orchestrator",
        context=context,
    )

    assert events == ["restore", "endpoint", "secret", "sandbox", "release"]
    assert proof_calls == 2


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

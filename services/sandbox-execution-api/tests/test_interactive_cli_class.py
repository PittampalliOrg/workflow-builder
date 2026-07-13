"""Tests for the interactive-cli execution-class surface.

Covers the four ExecutionClassConfig extensions (agentHostEnvFrom,
omitOpenshellSeedInit, podSecurityContext, agentHostUserHome), per-session
sessionSecretEnv secretKeyRef injection + Secret lifecycle, redaction, and
the additive `phase` readiness field.
"""

import json
import re
from types import SimpleNamespace

import src.app as app_module
from src.app import (
    AgentWorkflowHostRequest,
    ExecutionClassConfig,
    build_agent_workflow_host_sandbox_manifest,
)

OAUTH_TOKEN = "sk-ant-oat01-test-token-value"


def _interactive_cli_class() -> ExecutionClassConfig:
    """Mirror of the stacks `interactive-cli` SANDBOX_EXECUTION_CLASSES_JSON entry."""
    return ExecutionClassConfig(
        localQueue="interactive-agent",
        priorityClass="interactive-agent",
        priorityClassName="interactive-workload",
        agentHostImage="ghcr.io/pittampalliorg/cli-agent-py-sandbox:latest",
        imagePullSecrets=["ghcr-pull-credentials"],
        agentHostCpu="500m",
        agentHostMemory="1Gi",
        agentHostEphemeralStorage="4Gi",
        agentHostCpuLimit="2",
        agentHostMemoryLimit="3Gi",
        agentHostEphemeralStorageLimit="12Gi",
        omitOpenshellSeedInit=True,
        podSecurityContext={
            "runAsUser": 10001,
            "runAsGroup": 10001,
            "fsGroup": 10001,
            "runAsNonRoot": True,
        },
        agentHostUserHome="/home/cli-agent",
        agentHostEnvFrom=[
            {"configMapRef": {"name": "cli-agent-py-config", "optional": True}},
            {"secretRef": {"name": "cli-agent-py-secrets", "optional": False}},
        ],
        agentHostEnv={
            "CLI_IDLE_TTL_SECONDS": "3600",
            "OTEL_SERVICE_NAME": "cli-agent-py",
        },
    )


def _cli_request(**overrides) -> AgentWorkflowHostRequest:
    fields = {
        "sessionId": "sw-session-cli-1",
        "agentAppId": "agent-session-cli123",
        "runId": "run_cli",
        "executionClass": "interactive-cli",
        "timeoutSeconds": 900,
        "sessionSecretEnv": {"CLAUDE_CODE_OAUTH_TOKEN": OAUTH_TOKEN},
    }
    fields.update(overrides)
    return AgentWorkflowHostRequest(**fields)


def _cli_manifest(**request_overrides) -> dict:
    return build_agent_workflow_host_sandbox_manifest(
        _cli_request(**request_overrides),
        namespace="workflow-builder",
        class_config=_interactive_cli_class(),
    )


def test_interactive_cli_env_from_replaces_dapr_agent_defaults() -> None:
    manifest = _cli_manifest()
    container = manifest["spec"]["podTemplate"]["spec"]["containers"][0]
    assert container["envFrom"] == [
        {"configMapRef": {"name": "cli-agent-py-config", "optional": True}},
        {"secretRef": {"name": "cli-agent-py-secrets", "optional": False}},
    ]
    serialized = json.dumps(manifest)
    assert "dapr-agent-py-secrets" not in serialized
    assert "workflow-builder-secrets" not in serialized
    assert "workflow-checkpoint-gitea" not in serialized


def test_interactive_cli_pod_never_sees_anthropic_api_key_env() -> None:
    manifest = _cli_manifest()
    container = manifest["spec"]["podTemplate"]["spec"]["containers"][0]
    api_key_pattern = re.compile(r"ANTHROPIC|CLAUDE_API", re.IGNORECASE)
    offending = [
        entry["name"]
        for entry in container["env"]
        if api_key_pattern.search(entry["name"])
    ]
    assert offending == []
    # The only Claude-credential env is the OAuth token, via secretKeyRef.
    token_entries = [
        entry
        for entry in container["env"]
        if entry["name"] == "CLAUDE_CODE_OAUTH_TOKEN"
    ]
    assert len(token_entries) == 1


def test_interactive_cli_session_secret_env_uses_secret_key_ref_not_literal() -> None:
    manifest = _cli_manifest()
    container = manifest["spec"]["podTemplate"]["spec"]["containers"][0]
    token_entry = next(
        entry for entry in container["env"] if entry["name"] == "CLAUDE_CODE_OAUTH_TOKEN"
    )
    assert "value" not in token_entry
    assert token_entry["valueFrom"]["secretKeyRef"] == {
        "name": "agent-host-cred-agent-session-cli123",
        "key": "CLAUDE_CODE_OAUTH_TOKEN",
    }
    # The plaintext token must never be embedded in the Sandbox CR.
    assert OAUTH_TOKEN not in json.dumps(manifest)


def test_interactive_cli_omits_openshell_seed_init_and_tls_volumes() -> None:
    manifest = _cli_manifest()
    pod_spec = manifest["spec"]["podTemplate"]["spec"]
    assert "initContainers" not in pod_spec
    volume_names = {volume["name"] for volume in pod_spec["volumes"]}
    assert "openshell-client-tls" not in volume_names
    assert "openshell-client-ca" not in volume_names
    # The writable config + sandbox emptyDirs survive.
    assert {"openshell-config", "sandbox"} <= volume_names


def test_interactive_cli_sets_pod_security_context_10001() -> None:
    manifest = _cli_manifest()
    assert manifest["spec"]["podTemplate"]["spec"]["securityContext"] == {
        "runAsUser": 10001,
        "runAsGroup": 10001,
        "fsGroup": 10001,
        "runAsNonRoot": True,
    }


def test_interactive_cli_user_home_redirects_home_and_xdg() -> None:
    manifest = _cli_manifest()
    container = manifest["spec"]["podTemplate"]["spec"]["containers"][0]
    env = {
        entry["name"]: entry.get("value")
        for entry in container["env"]
        if "value" in entry
    }
    assert env["HOME"] == "/home/cli-agent"
    assert env["XDG_CONFIG_HOME"] == "/home/cli-agent/.config"
    config_mount = next(
        mount for mount in container["volumeMounts"] if mount["name"] == "openshell-config"
    )
    assert config_mount["mountPath"] == "/home/cli-agent/.config"


def test_interactive_cli_class_env_and_resources_apply() -> None:
    manifest = _cli_manifest()
    container = manifest["spec"]["podTemplate"]["spec"]["containers"][0]
    env = {
        entry["name"]: entry.get("value")
        for entry in container["env"]
        if "value" in entry
    }
    assert env["CLI_IDLE_TTL_SECONDS"] == "3600"
    assert env["OTEL_SERVICE_NAME"] == "cli-agent-py"
    assert container["resources"]["requests"] == {
        "cpu": "500m",
        "memory": "1Gi",
        "ephemeral-storage": "4Gi",
    }
    assert container["resources"]["limits"] == {
        "cpu": "2",
        "memory": "3Gi",
        "ephemeral-storage": "12Gi",
    }


def _interactive_cli_transcript_class() -> ExecutionClassConfig:
    """interactive-cli class WITH the durable transcript store enabled."""
    cfg = _interactive_cli_class()
    return cfg.model_copy(
        update={
            "transcriptStoreCsiDriver": "csi.juicefs.com",
            "transcriptStoreSecretName": "juicefs-wfbcli",
            "transcriptStoreMountPath": "/sandbox/.transcripts",
            "transcriptStoreCapacity": "10Gi",
        }
    )


def _cli_transcript_manifest(**request_overrides) -> dict:
    return build_agent_workflow_host_sandbox_manifest(
        _cli_request(**request_overrides),
        namespace="workflow-builder",
        class_config=_interactive_cli_transcript_class(),
    )


def test_transcript_store_disabled_by_default_adds_no_volume() -> None:
    manifest = _cli_manifest()
    pod_spec = manifest["spec"]["podTemplate"]["spec"]
    volume_names = {v["name"] for v in pod_spec["volumes"]}
    assert "cli-transcripts" not in volume_names
    env_names = {e["name"] for e in pod_spec["containers"][0]["env"]}
    assert "CLI_TRANSCRIPT_MOUNT" not in env_names


def test_transcript_store_adds_pvc_volume_mount_and_env() -> None:
    manifest = _cli_transcript_manifest()
    pod_spec = manifest["spec"]["podTemplate"]["spec"]
    container = pod_spec["containers"][0]
    vol = next(v for v in pod_spec["volumes"] if v["name"] == "cli-transcripts")
    # The per-session PVC name keys on the session id (unique per attempt).
    assert vol["persistentVolumeClaim"]["claimName"] == "cli-tx-sw-session-cli-1"
    mount = next(
        m for m in container["volumeMounts"] if m["name"] == "cli-transcripts"
    )
    assert mount["mountPath"] == "/sandbox/.transcripts"
    env = {e["name"]: e.get("value") for e in container["env"] if "value" in e}
    assert env["CLI_TRANSCRIPT_MOUNT"] == "/sandbox/.transcripts"


def test_transcript_conversation_key_prefers_resume_session() -> None:
    fresh = app_module._cli_transcript_conversation_key(
        _cli_request(sessionId="S2")
    )
    assert fresh == "S2"
    resumed = app_module._cli_transcript_conversation_key(
        _cli_request(sessionId="S2", resumeFromSessionId="S1")
    )
    assert resumed == "S1"


def test_ensure_transcript_volume_retain_preserves_data() -> None:
    created: list = []

    class _FakeCore:
        def create_persistent_volume(self, body):
            created.append(("pv", body))

        def create_namespaced_persistent_volume_claim(self, namespace, body):
            created.append(("pvc", namespace, body))

    name = app_module._ensure_cli_transcript_volume(
        _FakeCore(),
        _cli_request(sessionId="S2", resumeFromSessionId="S1"),
        _interactive_cli_transcript_class(),
        namespace="workflow-builder",
    )
    assert name == "cli-tx-s2"
    pv = next(b for kind, b in ((c[0], c[-1]) for c in created) if kind == "pv")
    assert pv["spec"]["csi"]["volumeHandle"] == "cli-tx-s2"
    # Retain (NOT Delete): the driver rmr's the subPath on a Delete-reclaim PV
    # removal, which would wipe the durable conversation when the PVC is GC'd.
    assert pv["spec"]["persistentVolumeReclaimPolicy"] == "Retain"
    # Subtree (Postgres data) keyed on the conversation, not the pod attempt.
    assert pv["spec"]["csi"]["volumeAttributes"]["subPath"] == "S1"
    assert pv["spec"]["mountOptions"] == ["allow_other"]
    assert pv["spec"]["csi"]["nodePublishSecretRef"] == {
        "name": "juicefs-wfbcli",
        "namespace": "workflow-builder",
    }


def test_ensure_transcript_volume_rebinds_released_pv_on_conflict() -> None:
    """A re-spawn of the same session hits a 409 on the Retain PV; if it's
    Released, clear its claimRef so the fresh PVC rebinds (data-safe)."""

    class _Conflict(Exception):
        status = 409

    patched: list = []

    class _FakeCore:
        def create_persistent_volume(self, body):
            raise _Conflict()

        def read_persistent_volume(self, name):
            return SimpleNamespace(status=SimpleNamespace(phase="Released"))

        def patch_persistent_volume(self, name, body):
            patched.append((name, body))

        def create_namespaced_persistent_volume_claim(self, namespace, body):
            pass

    name = app_module._ensure_cli_transcript_volume(
        _FakeCore(),
        _cli_request(sessionId="S9"),
        _interactive_cli_transcript_class(),
        namespace="workflow-builder",
    )
    assert name == "cli-tx-s9"
    assert patched == [("cli-tx-s9", {"spec": {"claimRef": None}})]


def test_default_class_manifest_is_unchanged_by_new_optional_fields() -> None:
    """Existing classes (no new fields) keep byte-identical behavior."""
    manifest = build_agent_workflow_host_sandbox_manifest(
        AgentWorkflowHostRequest(
            sessionId="sw-session-1",
            agentAppId="agent-session-abc123",
            runId="run_1",
            executionClass="interactive-agent",
            timeoutSeconds=900,
        ),
        namespace="workflow-builder",
        class_config=ExecutionClassConfig(localQueue="interactive-agent"),
    )
    pod_spec = manifest["spec"]["podTemplate"]["spec"]
    assert pod_spec["initContainers"][0]["name"] == "seed-openshell-config"
    assert "securityContext" not in pod_spec
    volume_names = {volume["name"] for volume in pod_spec["volumes"]}
    assert {"openshell-client-tls", "openshell-client-ca"} <= volume_names
    container = pod_spec["containers"][0]
    env = {
        entry["name"]: entry.get("value")
        for entry in container["env"]
        if "value" in entry
    }
    assert env["XDG_CONFIG_HOME"] == "/root/.config"
    assert "HOME" not in env
    assert {"secretRef": {"name": "dapr-agent-py-secrets", "optional": True}} in (
        container["envFrom"]
    )


def test_redacted_host_request_dump_masks_session_secret_values() -> None:
    dump = app_module._redacted_host_request_dump(_cli_request())
    assert dump["sessionSecretEnv"] == {"CLAUDE_CODE_OAUTH_TOKEN": "***"}
    assert OAUTH_TOKEN not in json.dumps(dump)


def test_cred_secret_name_is_deterministic_and_dns_safe() -> None:
    name = app_module._agent_host_cred_secret_name("agent-session-cli123")
    assert name == "agent-host-cred-agent-session-cli123"
    long_name = app_module._agent_host_cred_secret_name("x" * 100)
    assert len(long_name) <= 63


class _FakeCore:
    def __init__(self, create_conflict: bool = False) -> None:
        self.create_conflict = create_conflict
        self.created: list[dict] = []
        self.patched: list[tuple[str, dict]] = []

    def create_namespaced_secret(self, *, namespace, body):
        if self.create_conflict:
            error = Exception("conflict")
            error.status = 409
            raise error
        self.created.append(body)
        return body

    def patch_namespaced_secret(self, *, name, namespace, body):
        self.patched.append((name, body))
        return body


def test_ensure_cred_secret_creates_opaque_secret_with_owner_labels() -> None:
    core = _FakeCore()
    secret_name = app_module._ensure_agent_host_cred_secret(
        core, _cli_request(), namespace="workflow-builder"
    )

    assert secret_name == "agent-host-cred-agent-session-cli123"
    assert len(core.created) == 1
    body = core.created[0]
    assert body["type"] == "Opaque"
    assert body["metadata"]["labels"]["app"] == "agent-workflow-host"
    assert body["metadata"]["labels"]["agent-app-id"] == "agent-session-cli123"
    assert (
        body["metadata"]["labels"]["workflow-builder.cnoe.io/session-id"]
        == "sw-session-cli-1"
    )
    assert body["stringData"] == {"CLAUDE_CODE_OAUTH_TOKEN": OAUTH_TOKEN}


def test_ensure_cred_secret_conflict_patches_data_and_clears_stale_owner() -> None:
    core = _FakeCore(create_conflict=True)
    app_module._ensure_agent_host_cred_secret(
        core, _cli_request(), namespace="workflow-builder"
    )

    assert len(core.patched) == 1
    name, body = core.patched[0]
    assert name == "agent-host-cred-agent-session-cli123"
    assert body["stringData"] == {"CLAUDE_CODE_OAUTH_TOKEN": OAUTH_TOKEN}
    # Stale ownerReferences must be cleared so the GC can't race-delete the
    # refreshed Secret before the new Sandbox owner is bound.
    assert body["metadata"]["ownerReferences"] is None


def test_ensure_cred_secret_noop_without_session_secret_env() -> None:
    core = _FakeCore()
    assert (
        app_module._ensure_agent_host_cred_secret(
            core, _cli_request(sessionSecretEnv=None), namespace="workflow-builder"
        )
        is None
    )
    assert core.created == []
    assert core.patched == []


def test_bind_cred_secret_owner_uses_sandbox_create_response_uid() -> None:
    core = _FakeCore()
    app_module._bind_agent_host_cred_secret_owner(
        core,
        SimpleNamespace(),
        namespace="workflow-builder",
        secret_name="agent-host-cred-agent-session-cli123",
        sandbox_name="agent-host-agent-session-cli123",
        sandbox={"metadata": {"uid": "uid-123"}},
    )

    assert len(core.patched) == 1
    name, body = core.patched[0]
    assert name == "agent-host-cred-agent-session-cli123"
    assert body["metadata"]["ownerReferences"] == [
        {
            "apiVersion": "agents.x-k8s.io/v1alpha1",
            "kind": "Sandbox",
            "name": "agent-host-agent-session-cli123",
            "uid": "uid-123",
            "controller": False,
            "blockOwnerDeletion": False,
        }
    ]


def test_bind_cred_secret_owner_fetches_cr_uid_on_adopt_path() -> None:
    core = _FakeCore()
    custom = SimpleNamespace(
        get_namespaced_custom_object=lambda **_kwargs: {
            "metadata": {"uid": "uid-existing"}
        }
    )
    app_module._bind_agent_host_cred_secret_owner(
        core,
        custom,
        namespace="workflow-builder",
        secret_name="agent-host-cred-agent-session-cli123",
        sandbox_name="agent-host-agent-session-cli123",
        sandbox=None,
    )

    assert len(core.patched) == 1
    assert (
        core.patched[0][1]["metadata"]["ownerReferences"][0]["uid"] == "uid-existing"
    )


def _pod(conditions: list[SimpleNamespace]) -> SimpleNamespace:
    return SimpleNamespace(
        status=SimpleNamespace(
            phase="Pending", conditions=conditions, container_statuses=[]
        )
    )


def _core_with_pods(pods: list) -> SimpleNamespace:
    return SimpleNamespace(
        list_namespaced_pod=lambda **_kwargs: SimpleNamespace(items=pods)
    )


def test_provisioning_phase_queued_when_no_pod_exists() -> None:
    phase = app_module._agent_host_provisioning_phase(
        _core_with_pods([]),
        namespace="workflow-builder",
        agent_app_id="agent-session-cli123",
    )
    assert phase == "queued"


def test_provisioning_phase_queued_when_pod_scheduling_gated() -> None:
    gated = _pod(
        [
            SimpleNamespace(
                type="PodScheduled", status="False", reason="SchedulingGated"
            )
        ]
    )
    phase = app_module._agent_host_provisioning_phase(
        _core_with_pods([gated]),
        namespace="workflow-builder",
        agent_app_id="agent-session-cli123",
    )
    assert phase == "queued"


def test_provisioning_phase_starting_when_scheduled_but_not_ready() -> None:
    scheduled = _pod(
        [
            SimpleNamespace(type="PodScheduled", status="True"),
            SimpleNamespace(type="Ready", status="False"),
        ]
    )
    phase = app_module._agent_host_provisioning_phase(
        _core_with_pods([scheduled]),
        namespace="workflow-builder",
        agent_app_id="agent-session-cli123",
    )
    assert phase == "starting"


def test_provisioning_phase_ready_when_pod_ready() -> None:
    ready = _pod(
        [
            SimpleNamespace(type="PodScheduled", status="True"),
            SimpleNamespace(type="Ready", status="True"),
        ]
    )
    phase = app_module._agent_host_provisioning_phase(
        _core_with_pods([ready]),
        namespace="workflow-builder",
        agent_app_id="agent-session-cli123",
    )
    assert phase == "ready"


class _FakeCustomCreate:
    def __init__(self) -> None:
        self.creates: list[dict] = []

    def create_namespaced_custom_object(self, *, group, version, namespace, plural, body):
        self.creates.append(body)
        return {**body, "metadata": {**body["metadata"], "uid": "uid-created"}}


def test_submit_with_session_secret_env_creates_secret_before_sandbox(
    monkeypatch,
) -> None:
    order: list[str] = []
    fake_custom = _FakeCustomCreate()
    span_payloads: list = []

    class _OrderedCore(_FakeCore):
        def create_namespaced_secret(self, *, namespace, body):
            order.append("secret-create")
            return super().create_namespaced_secret(namespace=namespace, body=body)

        def patch_namespaced_secret(self, *, name, namespace, body):
            order.append("secret-patch")
            return super().patch_namespaced_secret(
                name=name, namespace=namespace, body=body
            )

    original_create = fake_custom.create_namespaced_custom_object

    def tracked_create(**kwargs):
        order.append("sandbox-create")
        return original_create(**kwargs)

    fake_custom.create_namespaced_custom_object = tracked_create
    fake_core = _OrderedCore()

    monkeypatch.setenv("SANDBOX_EXECUTION_API_TOKEN", "token")
    monkeypatch.delenv("SANDBOX_EXECUTION_DRY_RUN", raising=False)
    monkeypatch.setattr(
        app_module,
        "_load_execution_classes",
        lambda: {"interactive-cli": _interactive_cli_class()},
    )
    monkeypatch.setattr(
        app_module, "_load_k8s_clients", lambda: (SimpleNamespace(), fake_core)
    )
    monkeypatch.setattr(
        app_module, "_load_k8s_custom_objects_client", lambda: fake_custom
    )
    monkeypatch.setattr(
        app_module,
        "_ensure_agent_host_component_scopes",
        lambda _namespace, _app_id: None,
    )
    monkeypatch.setattr(
        app_module,
        "_wait_for_agent_host_ready",
        lambda *_args, **_kwargs: app_module.AgentHostReadiness(status="queued"),
    )
    monkeypatch.setattr(
        app_module,
        "_agent_host_provisioning_phase",
        lambda *_args, **_kwargs: "queued",
    )
    monkeypatch.setattr(
        app_module,
        "set_current_span_io",
        lambda _prefix, payload: span_payloads.append(payload),
    )

    response = app_module.submit_agent_workflow_host(
        SimpleNamespace(headers={"authorization": "Bearer token"}),
        _cli_request(),
    )

    # Secret is created before the Sandbox CR, then ownerRef-bound after.
    assert order == ["secret-create", "sandbox-create", "secret-patch"]
    owner_refs = fake_core.patched[0][1]["metadata"]["ownerReferences"]
    assert owner_refs[0]["uid"] == "uid-created"
    assert owner_refs[0]["kind"] == "Sandbox"
    # Additive phase field, and no token anywhere in response or span payloads.
    assert response["phase"] == "queued"
    assert response["status"] == "queued"
    assert OAUTH_TOKEN not in json.dumps(response)
    assert OAUTH_TOKEN not in json.dumps(span_payloads, default=str)
    # The created Sandbox CR itself never embeds the token.
    assert OAUTH_TOKEN not in json.dumps(fake_custom.creates)

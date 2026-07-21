from __future__ import annotations

from copy import deepcopy
from datetime import UTC, datetime, timedelta
from types import SimpleNamespace

import pytest
from fastapi import HTTPException

import src.app as app_module
from src.app import AgentWorkflowHostRequest, ExecutionClassConfig


AGENT_APP_ID = "agent-session-generation-a"
SANDBOX_NAME = "agent-host-agent-session-generation-a"


def _request(**overrides) -> AgentWorkflowHostRequest:
    values = {
        "sessionId": "session-stable",
        "agentAppId": AGENT_APP_ID,
        "runId": "run-one",
        "executionClass": "interactive-agent",
        "timeoutSeconds": 900,
        "provisionalTimeoutSeconds": 300,
    }
    values.update(overrides)
    return AgentWorkflowHostRequest(**values)


def _class() -> ExecutionClassConfig:
    return ExecutionClassConfig(localQueue="interactive-agent")


def _manifest(**overrides) -> dict:
    return app_module.build_agent_workflow_host_sandbox_manifest(
        _request(**overrides),
        namespace="workflow-builder",
        class_config=_class(),
    )


def _internal_request() -> SimpleNamespace:
    return SimpleNamespace(headers={"authorization": "Bearer token"})


class _ApiError(Exception):
    def __init__(self, status_code: int) -> None:
        super().__init__(f"api status {status_code}")
        self.status = status_code


class _ActivationCustom:
    def __init__(self, sandbox: dict) -> None:
        self.sandbox = deepcopy(sandbox)
        self.sandbox["metadata"].setdefault("resourceVersion", "1")
        self.patches: list[dict] = []

    def get_namespaced_custom_object(self, **_kwargs):
        return deepcopy(self.sandbox)

    def patch_namespaced_custom_object(self, *, body, **_kwargs):
        self.patches.append(deepcopy(body))
        metadata_patch = body.get("metadata") or {}
        self.sandbox["metadata"].setdefault("annotations", {}).update(
            metadata_patch.get("annotations") or {}
        )
        for key, value in (body.get("spec") or {}).items():
            if value is None:
                self.sandbox["spec"].pop(key, None)
            else:
                self.sandbox["spec"][key] = value
        return deepcopy(self.sandbox)


def _install_activation_custom(monkeypatch, custom: _ActivationCustom) -> None:
    monkeypatch.setenv("SANDBOX_EXECUTION_API_TOKEN", "token")
    monkeypatch.setenv("AGENT_WORKFLOW_HOST_NAMESPACE", "workflow-builder")
    monkeypatch.setattr(
        app_module, "_load_k8s_custom_objects_client", lambda: custom
    )


def _activation_body(**overrides) -> app_module.AgentWorkflowHostActivationRequest:
    values = {"sandboxName": SANDBOX_NAME, "generation": AGENT_APP_ID}
    values.update(overrides)
    return app_module.AgentWorkflowHostActivationRequest(**values)


def test_provisional_finite_host_preserves_final_intent_and_deadline(
    monkeypatch,
) -> None:
    monkeypatch.setenv("SANDBOX_EXECUTION_AGENT_HOST_SHUTDOWN_BUFFER_SECONDS", "120")
    before = datetime.now(UTC)
    manifest = _manifest(timeoutSeconds=900, provisionalTimeoutSeconds=300)

    shutdown_time = datetime.fromisoformat(
        manifest["spec"]["shutdownTime"].replace("Z", "+00:00")
    )
    assert before + timedelta(seconds=299) <= shutdown_time
    assert shutdown_time <= datetime.now(UTC) + timedelta(seconds=301)
    annotations = manifest["metadata"]["annotations"]
    assert annotations[app_module.AGENT_HOST_GENERATION_ANNOTATION] == AGENT_APP_ID
    assert annotations[app_module.AGENT_HOST_LIFECYCLE_ANNOTATION] == "provisional"
    assert annotations[app_module.AGENT_HOST_FINAL_TIMEOUT_ANNOTATION] == "900"
    assert (
        annotations[app_module.AGENT_HOST_FINAL_PERSISTENT_ANNOTATION] == "false"
    )
    assert manifest["spec"]["podTemplate"]["spec"]["activeDeadlineSeconds"] == (
        300 + 900 + 120 + app_module.AGENT_HOST_POD_DEADLINE_MARGIN_SECONDS
    )


def test_provisional_persistent_host_has_no_pod_deadline() -> None:
    before = datetime.now(UTC)
    manifest = _manifest(timeoutSeconds=None, provisionalTimeoutSeconds=300)

    shutdown_time = datetime.fromisoformat(
        manifest["spec"]["shutdownTime"].replace("Z", "+00:00")
    )
    assert before + timedelta(seconds=299) <= shutdown_time
    assert shutdown_time <= datetime.now(UTC) + timedelta(seconds=301)
    assert (
        "activeDeadlineSeconds"
        not in manifest["spec"]["podTemplate"]["spec"]
    )
    annotations = manifest["metadata"]["annotations"]
    assert annotations[app_module.AGENT_HOST_FINAL_TIMEOUT_ANNOTATION] == ""
    assert (
        annotations[app_module.AGENT_HOST_FINAL_PERSISTENT_ANNOTATION] == "true"
    )


@pytest.mark.parametrize("seconds", [59, 3601])
def test_provisional_timeout_is_bounded(seconds: int) -> None:
    with pytest.raises(ValueError):
        _request(provisionalTimeoutSeconds=seconds)


def test_finite_activation_is_idempotent_and_does_not_extend_timeout(
    monkeypatch,
) -> None:
    monkeypatch.setenv("SANDBOX_EXECUTION_AGENT_HOST_SHUTDOWN_BUFFER_SECONDS", "120")
    sandbox = _manifest(timeoutSeconds=900, provisionalTimeoutSeconds=300)
    sandbox["metadata"]["resourceVersion"] = "17"
    custom = _ActivationCustom(sandbox)
    _install_activation_custom(monkeypatch, custom)
    before = datetime.now(UTC)

    first = app_module.activate_agent_workflow_host(
        _internal_request(), AGENT_APP_ID, _activation_body()
    )
    first_shutdown = custom.sandbox["spec"]["shutdownTime"]
    second = app_module.activate_agent_workflow_host(
        _internal_request(), AGENT_APP_ID, _activation_body()
    )

    assert first["outcome"] == "activated"
    assert first["persistent"] is False
    assert second["outcome"] == "already-active"
    assert len(custom.patches) == 1
    assert custom.sandbox["spec"]["shutdownPolicy"] == "Delete"
    assert custom.sandbox["spec"]["shutdownTime"] == first_shutdown
    final_shutdown = datetime.fromisoformat(first_shutdown.replace("Z", "+00:00"))
    assert before + timedelta(seconds=1019) <= final_shutdown
    assert final_shutdown <= datetime.now(UTC) + timedelta(seconds=1021)
    assert custom.patches[0]["metadata"]["resourceVersion"] == "17"


def test_persistent_activation_removes_provisional_shutdown_idempotently(
    monkeypatch,
) -> None:
    custom = _ActivationCustom(
        _manifest(timeoutSeconds=None, provisionalTimeoutSeconds=300)
    )
    _install_activation_custom(monkeypatch, custom)

    first = app_module.activate_agent_workflow_host(
        _internal_request(), AGENT_APP_ID, _activation_body()
    )
    second = app_module.activate_agent_workflow_host(
        _internal_request(), AGENT_APP_ID, _activation_body()
    )

    assert first == {
        "agentAppId": AGENT_APP_ID,
        "sandboxName": SANDBOX_NAME,
        "generation": AGENT_APP_ID,
        "outcome": "activated",
        "legacy": False,
        "persistent": True,
        "shutdownTime": None,
    }
    assert second["outcome"] == "already-active"
    assert len(custom.patches) == 1
    assert "shutdownPolicy" not in custom.sandbox["spec"]
    assert "shutdownTime" not in custom.sandbox["spec"]


@pytest.mark.parametrize(
    ("sandbox_name", "generation"),
    [
        ("agent-host-agent-session-generation-b", AGENT_APP_ID),
        (SANDBOX_NAME, "agent-session-generation-b"),
    ],
)
def test_activation_rejects_request_identity_mismatch(
    monkeypatch, sandbox_name: str, generation: str
) -> None:
    custom = _ActivationCustom(_manifest())
    _install_activation_custom(monkeypatch, custom)

    with pytest.raises(HTTPException) as exc_info:
        app_module.activate_agent_workflow_host(
            _internal_request(),
            AGENT_APP_ID,
            _activation_body(sandboxName=sandbox_name, generation=generation),
        )

    assert exc_info.value.status_code == 409
    assert custom.patches == []


def test_activation_rejects_wrong_observed_generation(monkeypatch) -> None:
    sandbox = _manifest()
    sandbox["metadata"]["annotations"][
        app_module.AGENT_HOST_GENERATION_ANNOTATION
    ] = "agent-session-generation-b"
    custom = _ActivationCustom(sandbox)
    _install_activation_custom(monkeypatch, custom)

    with pytest.raises(HTTPException) as exc_info:
        app_module.activate_agent_workflow_host(
            _internal_request(), AGENT_APP_ID, _activation_body()
        )

    assert exc_info.value.status_code == 409
    assert "generation mismatch" in str(exc_info.value.detail)
    assert custom.patches == []


def test_activation_accepts_exact_pre_upgrade_active_host(monkeypatch) -> None:
    legacy = _manifest(timeoutSeconds=None, provisionalTimeoutSeconds=None)
    annotations = legacy["metadata"]["annotations"]
    annotations.pop(app_module.AGENT_HOST_GENERATION_ANNOTATION)
    annotations.pop(app_module.AGENT_HOST_LIFECYCLE_ANNOTATION)
    annotations.pop(app_module.AGENT_HOST_FINAL_TIMEOUT_ANNOTATION)
    annotations.pop(app_module.AGENT_HOST_FINAL_PERSISTENT_ANNOTATION)
    custom = _ActivationCustom(legacy)
    _install_activation_custom(monkeypatch, custom)

    response = app_module.activate_agent_workflow_host(
        _internal_request(), AGENT_APP_ID, _activation_body()
    )

    assert response["outcome"] == "already-active"
    assert response["legacy"] is True
    assert custom.patches == []


def test_owner_reference_binding_rejects_wrong_generation() -> None:
    wrong = _manifest()
    wrong["metadata"]["annotations"][
        app_module.AGENT_HOST_GENERATION_ANNOTATION
    ] = "agent-session-generation-b"
    wrong["metadata"]["uid"] = "uid-wrong"
    core = SimpleNamespace(
        patches=[],
        patch_namespaced_secret=lambda **kwargs: core.patches.append(kwargs),
    )
    custom = SimpleNamespace(get_namespaced_custom_object=lambda **_kwargs: wrong)

    app_module._bind_agent_host_cred_secret_owner(
        core,
        custom,
        namespace="workflow-builder",
        secret_name="agent-host-cred-agent-session-generation-a",
        sandbox_name=SANDBOX_NAME,
        generation=AGENT_APP_ID,
        sandbox=wrong,
    )

    assert core.patches == []


def test_host_owned_resource_names_use_generation_but_keep_logical_subpaths() -> None:
    created_pvs: list[dict] = []
    created_pvcs: list[dict] = []

    class Core:
        def create_persistent_volume(self, *, body):
            created_pvs.append(body)

        def create_namespaced_persistent_volume_claim(self, *, namespace, body):
            assert namespace == "workflow-builder"
            created_pvcs.append(body)

    config = ExecutionClassConfig(
        localQueue="interactive-agent",
        transcriptStoreCsiDriver="csi.juicefs.com",
        transcriptStoreSecretName="juicefs",
        sharedWorkspaceStoreCsiDriver="csi.juicefs.com",
        sharedWorkspaceStoreSecretName="juicefs",
    )
    first = _request(
        resumeFromSessionId="conversation-original",
        sharedWorkspaceKey="workspace-shared",
        seedWorkspaceFrom="workspace-source",
    )
    second = first.model_copy(update={"agentAppId": "agent-session-generation-b"})

    transcript = app_module._ensure_cli_transcript_volume(
        Core(), first, config, namespace="workflow-builder"
    )
    workspace = app_module._ensure_cli_shared_workspace_volume(
        Core(), first, config, namespace="workflow-builder"
    )
    seed = app_module._ensure_cli_seed_workspace_volume(
        Core(), first, config, namespace="workflow-builder"
    )

    assert transcript == "cli-tx-agent-session-generation-a"
    assert workspace == "cli-ws-agent-session-generation-a"
    assert seed == "cli-seed-agent-session-generation-a"
    assert app_module._cli_transcript_claim_name(second, None) != transcript
    assert app_module._cli_shared_workspace_claim_name(second, None) != workspace
    assert app_module._cli_seed_workspace_claim_name(second, None) != seed
    assert app_module._agent_host_cred_secret_name(first.agentAppId) != (
        app_module._agent_host_cred_secret_name(second.agentAppId)
    )
    assert app_module._pydantic_scratch_claim_name(first) != (
        app_module._pydantic_scratch_claim_name(second)
    )
    subpaths = {
        pv["metadata"]["labels"]["app"]: pv["spec"]["csi"]["volumeAttributes"][
            "subPath"
        ]
        for pv in created_pvs
    }
    assert subpaths == {
        "cli-transcript": "conversation-original",
        "cli-shared-workspace": "workspace-shared",
        "cli-seed-workspace": "workspace-source",
    }
    assert {pvc["metadata"]["name"] for pvc in created_pvcs} == {
        transcript,
        workspace,
        seed,
    }


def test_provisional_create_replay_does_not_extend_shutdown_time(monkeypatch) -> None:
    body = _request()
    existing = _manifest()
    original_shutdown = existing["spec"]["shutdownTime"]

    class Custom:
        def __init__(self) -> None:
            self.patch_calls = 0

        def create_namespaced_custom_object(self, **_kwargs):
            raise _ApiError(409)

        def get_namespaced_custom_object(self, **_kwargs):
            return deepcopy(existing)

        def patch_namespaced_custom_object(self, **_kwargs):
            self.patch_calls += 1

    custom = Custom()
    monkeypatch.setenv("SANDBOX_EXECUTION_API_TOKEN", "token")
    monkeypatch.setattr(
        app_module,
        "_load_execution_classes",
        lambda: {_request().executionClass: _class()},
    )
    monkeypatch.setattr(
        app_module, "_load_k8s_clients", lambda: (SimpleNamespace(), SimpleNamespace())
    )
    monkeypatch.setattr(
        app_module, "_load_k8s_custom_objects_client", lambda: custom
    )
    monkeypatch.setattr(
        app_module, "_ensure_agent_host_component_scopes", lambda *_args: None
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

    response = app_module.submit_agent_workflow_host(_internal_request(), body)

    assert response["provisional"] is True
    assert existing["spec"]["shutdownTime"] == original_shutdown
    assert custom.patch_calls == 0

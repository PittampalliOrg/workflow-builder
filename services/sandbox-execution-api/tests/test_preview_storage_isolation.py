from __future__ import annotations

from types import SimpleNamespace

import pytest

import src.app as app_module
from src.app import (
    AgentWorkflowHostRequest,
    ExecutionClassConfig,
    PurgeWorkspaceDataRequest,
)


class ApiError(Exception):
    def __init__(self, status: int) -> None:
        super().__init__(f"api status {status}")
        self.status = status


class FakeCore:
    def __init__(self) -> None:
        self.pvcs: dict[str, SimpleNamespace] = {}
        self.persistent_volume_calls = 0

    def create_persistent_volume(self, **_kwargs):
        self.persistent_volume_calls += 1
        raise AssertionError("preview storage must never create a static PV")

    def create_namespaced_persistent_volume_claim(self, *, namespace, body):
        name = body["metadata"]["name"]
        if name in self.pvcs:
            raise ApiError(409)
        self.pvcs[name] = SimpleNamespace(
            metadata=SimpleNamespace(labels=dict(body["metadata"]["labels"])),
            spec=SimpleNamespace(
                storage_class_name=body["spec"]["storageClassName"]
            ),
        )

    def read_namespaced_persistent_volume_claim(self, *, name, namespace):
        del namespace
        if name not in self.pvcs:
            raise ApiError(404)
        return self.pvcs[name]


class FakeBatch:
    def __init__(self) -> None:
        self.jobs: list[dict] = []

    def create_namespaced_job(self, *, namespace, body):
        assert namespace == "workflow-builder"
        self.jobs.append(body)


def storage_class() -> ExecutionClassConfig:
    return ExecutionClassConfig(
        localQueue="agent-runtime",
        transcriptStoreCsiDriver="csi.juicefs.com",
        transcriptStoreSecretName="must-not-be-used",
        sharedWorkspaceStoreCsiDriver="csi.juicefs.com",
        sharedWorkspaceStoreSecretName="must-not-be-used",
    )


def set_preview_env(monkeypatch, scope: str) -> None:
    values = {
        "PREVIEW_ENVIRONMENT_NAME": "preview-one",
        "PREVIEW_ENVIRONMENT_REQUEST_ID": "request-1",
        "PREVIEW_ENVIRONMENT_PLATFORM_REVISION": "a" * 40,
        "PREVIEW_ENVIRONMENT_SOURCE_REVISION": "b" * 40,
        "PREVIEW_ENVIRONMENT_CATALOG_DIGEST": f"sha256:{'c' * 64}",
        "PREVIEW_ENVIRONMENT_SERVICES_JSON": '["workflow-builder"]',
        "PREVIEW_STORAGE_SCOPE_ID": scope,
        "PREVIEW_STORAGE_CLASS": f"preview-jfs-{scope}",
        "SANDBOX_EXECUTION_API_TOKEN": "sandbox-token",
        "AGENT_WORKFLOW_HOST_NAMESPACE": "workflow-builder",
    }
    for key, value in values.items():
        monkeypatch.setenv(key, value)


def request() -> SimpleNamespace:
    return SimpleNamespace(headers={"authorization": "Bearer sandbox-token"})


def test_partial_preview_identity_fails_closed(monkeypatch) -> None:
    monkeypatch.setenv("PREVIEW_ENVIRONMENT_NAME", "preview-one")
    with pytest.raises(app_module.HTTPException, match="identity is incomplete"):
        app_module._preview_storage_context()


@pytest.mark.parametrize(
    "key",
    ["", ".", "..", "/root", "other/workspace", "previews/v1/owned", "bad\\key"],
)
def test_preview_logical_keys_reject_paths_and_caller_prefixes(key: str) -> None:
    with pytest.raises(app_module.HTTPException):
        app_module._preview_storage_logical_key(key, field="workspace")


def test_preview_transcript_and_workspace_use_only_host_issued_dynamic_class(
    monkeypatch,
) -> None:
    set_preview_env(monkeypatch, "1" * 32)
    core = FakeCore()
    cfg = storage_class()
    host = AgentWorkflowHostRequest(
        sessionId="session-1",
        agentAppId="agent-1",
        executionClass="interactive-cli",
        sharedWorkspaceKey="execution-1",
    )

    transcript = app_module._ensure_cli_transcript_volume(
        core, host, cfg, namespace="workflow-builder"
    )
    workspace = app_module._ensure_cli_shared_workspace_volume(
        core, host, cfg, namespace="workflow-builder"
    )

    assert transcript == f"ptx-{app_module.sha256(b'session-1').hexdigest()[:32]}"
    assert workspace == f"pws-{app_module.sha256(b'execution-1').hexdigest()[:32]}"
    assert core.persistent_volume_calls == 0
    assert set(core.pvcs) == {transcript, workspace}
    for pvc in core.pvcs.values():
        assert pvc.spec.storage_class_name == f"preview-jfs-{'1' * 32}"
        assert pvc.metadata.labels["preview.stacks.io/storage-scope"] == "1" * 32


def test_other_preview_cannot_read_or_purge_an_existing_scope(monkeypatch) -> None:
    core = FakeCore()
    cfg = storage_class()
    logical_key = "execution-1"

    set_preview_env(monkeypatch, "1" * 32)
    first = app_module._preview_storage_context()
    assert first is not None
    app_module._ensure_preview_dynamic_pvc(
        core,
        namespace="workflow-builder",
        context=first,
        kind="workspace",
        logical_key=logical_key,
        capacity="10Gi",
    )

    set_preview_env(monkeypatch, "2" * 32)
    second = app_module._preview_storage_context()
    assert second is not None
    with pytest.raises(app_module.HTTPException, match="PVC identity conflict"):
        app_module._ensure_preview_dynamic_pvc(
            core,
            namespace="workflow-builder",
            context=second,
            kind="workspace",
            logical_key=logical_key,
            capacity="10Gi",
            create=False,
        )

    batch = FakeBatch()
    monkeypatch.setattr(app_module, "_resolve_juicefs_class", lambda _name: cfg)
    monkeypatch.setattr(app_module, "_load_k8s_clients", lambda: (batch, core))
    with pytest.raises(app_module.HTTPException, match="PVC identity conflict"):
        app_module.purge_workspace_data(
            request(), PurgeWorkspaceDataRequest(workspaceExecutionId=logical_key)
        )
    assert batch.jobs == []


def test_preview_root_mount_is_unconditionally_forbidden(monkeypatch) -> None:
    set_preview_env(monkeypatch, "3" * 32)
    with pytest.raises(app_module.HTTPException, match="forbids root volume"):
        app_module._ensure_root_pv(
            FakeCore(),
            name="root",
            class_config=storage_class(),
            namespace="workflow-builder",
        )

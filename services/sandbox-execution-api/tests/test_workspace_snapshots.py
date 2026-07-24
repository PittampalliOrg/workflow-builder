"""Node-boundary CLI-workspace snapshots (durability phase 3)."""
from __future__ import annotations

from types import SimpleNamespace

import pytest

import src.app as app_module
from src.app import (
    CliWorkspaceSnapshotPruneRequest,
    CliWorkspaceSnapshotRequest,
    ExecutionClassConfig,
)


class ApiError(Exception):
    def __init__(self, status: int) -> None:
        super().__init__(f"api status {status}")
        self.status = status


class FakeCore:
    def __init__(self) -> None:
        self.pvs: dict[str, dict] = {}
        self.pvcs: dict[str, dict] = {}

    def create_persistent_volume(self, *, body):
        name = body["metadata"]["name"]
        if name in self.pvs:
            raise ApiError(409)
        self.pvs[name] = body

    def read_persistent_volume(self, *, name):
        if name not in self.pvs:
            raise ApiError(404)
        return SimpleNamespace(status=SimpleNamespace(phase="Bound"))

    def patch_persistent_volume(self, *, name, body):
        del name, body

    def create_namespaced_persistent_volume_claim(self, *, namespace, body):
        del namespace
        name = body["metadata"]["name"]
        if name in self.pvcs:
            raise ApiError(409)
        self.pvcs[name] = body


class FakeBatch:
    def __init__(self) -> None:
        self.jobs: list[dict] = []

    def create_namespaced_job(self, *, namespace, body):
        assert namespace == "workflow-builder"
        self.jobs.append(body)


def storage_class() -> ExecutionClassConfig:
    return ExecutionClassConfig(
        localQueue="agent-runtime",
        sharedWorkspaceStoreCsiDriver="csi.juicefs.com",
        sharedWorkspaceStoreSecretName="jfs-secret",
    )


def request() -> SimpleNamespace:
    return SimpleNamespace(headers={"authorization": "Bearer sandbox-token"})


@pytest.fixture(autouse=True)
def _internal_token(monkeypatch) -> None:
    monkeypatch.setenv("SANDBOX_EXECUTION_API_TOKEN", "sandbox-token")
    monkeypatch.setenv("AGENT_WORKFLOW_HOST_NAMESPACE", "workflow-builder")


@pytest.fixture
def _juicefs(monkeypatch):
    cfg = storage_class()
    monkeypatch.setattr(app_module, "_resolve_juicefs_class", lambda _name: cfg)
    monkeypatch.setattr(app_module, "_preview_storage_context", lambda: None)
    batch, core = FakeBatch(), FakeCore()
    monkeypatch.setattr(app_module, "_load_k8s_clients", lambda: (batch, core))
    return batch, core


# --- validation ---------------------------------------------------------------


@pytest.mark.parametrize(
    "value",
    ["", ".", "..", "a/b", "a\\b", " ", ".hidden", "-", "x" * 202],
)
def test_validate_snapshot_component_rejects_bad(value: str) -> None:
    with pytest.raises(app_module.HTTPException):
        app_module._validate_snapshot_component(value, field="x")


@pytest.mark.parametrize(
    "value",
    ["clone", "evaluate_ui", "exec_abc-123", "node.1", "a@b", "a:b", "_seed"],
)
def test_validate_snapshot_component_accepts_valid(value: str) -> None:
    assert app_module._validate_snapshot_component(value, field="x") == value


def test_snapshot_subpath() -> None:
    assert (
        app_module._snapshot_subpath("exec_1", "planning")
        == ".snapshots/exec_1/planning"
    )


# --- command bodies -----------------------------------------------------------


def test_clone_cmd_has_fallback_idempotency_and_cap() -> None:
    cmd = app_module._snapshot_clone_cmd()
    assert "juicefs clone" in cmd
    assert "cp -a --reflink=auto" in cmd  # fallback when the clone ioctl fails
    assert "cp -a " in cmd  # final plain-copy fallback
    assert "already-exists" in cmd  # idempotent no-op on re-run
    assert ".snapshots/$KEY" in cmd
    assert "$CAP" in cmd  # keep-newest cap prune
    assert "node_modules" in cmd  # build artifacts excluded


def test_prune_cmd_supports_all_and_keep() -> None:
    cmd = app_module._snapshot_prune_cmd()
    assert "PRUNE_ALL" in cmd
    assert "$KEEP" in cmd
    assert ".snapshots/$KEY" in cmd


# --- job manifest -------------------------------------------------------------


def test_build_snapshot_job_is_plain_root_mounted_job() -> None:
    job = app_module._build_snapshot_job(
        name="snap-abc",
        namespace="workflow-builder",
        command="echo hi",
        command_env={"KEY": "exec_1", "SNAP": "plan"},
        execution_id="exec_1",
        action="create",
    )
    labels = job["metadata"]["labels"]
    assert labels["app"] == "cli-workspace-snapshot"
    assert labels["snapshot.workflow-builder.cnoe.io/action"] == "create"
    assert labels["workflow-builder.cnoe.io/execution-id"] == "exec-1"
    # NOT Kueue-managed — snapshots run outside sandbox admission queues.
    assert "kueue.x-k8s.io/queue-name" not in labels
    spec = job["spec"]
    assert spec["ttlSecondsAfterFinished"] > 0
    container = spec["template"]["spec"]["containers"][0]
    assert container["image"] == "juicedata/mount:ce-v1.3.1"
    assert {"name": "KEY", "value": "exec_1"} in container["env"]
    assert container["volumeMounts"] == [{"name": "root", "mountPath": "/jfs"}]
    assert spec["template"]["spec"]["volumes"][0]["persistentVolumeClaim"][
        "claimName"
    ] == app_module._SNAPSHOT_ROOT_PVC


# --- endpoints ----------------------------------------------------------------


def test_create_snapshot_submits_root_mounted_job(_juicefs) -> None:
    batch, core = _juicefs
    out = app_module.create_cli_workspace_snapshot(
        request(),
        CliWorkspaceSnapshotRequest(
            sharedWorkspaceKey="exec_1", snapshotId="planning", executionId="exec_1"
        ),
    )
    assert out["success"] is True
    assert out["key"] == "exec_1"
    assert out["snapshotId"] == "planning"
    assert len(batch.jobs) == 1
    job = batch.jobs[0]
    env = {e["name"]: e["value"] for e in job["spec"]["template"]["spec"]["containers"][0]["env"]}
    assert env["KEY"] == "exec_1"
    assert env["SNAP"] == "planning"
    assert env["CAP"] == str(app_module._SNAPSHOT_MAX_PER_KEY)
    # The root PV/PVC were provisioned for the clone.
    assert app_module._SNAPSHOT_ROOT_PVC in core.pvs


def test_create_snapshot_rejects_bad_snapshot_id(_juicefs) -> None:
    with pytest.raises(app_module.HTTPException):
        app_module.create_cli_workspace_snapshot(
            request(),
            CliWorkspaceSnapshotRequest(
                sharedWorkspaceKey="exec_1", snapshotId="../escape"
            ),
        )


def test_create_snapshot_forbidden_under_preview_storage(monkeypatch) -> None:
    monkeypatch.setenv("SANDBOX_EXECUTION_API_TOKEN", "sandbox-token")
    monkeypatch.setattr(
        app_module, "_resolve_juicefs_class", lambda _name: storage_class()
    )
    monkeypatch.setattr(
        app_module, "_preview_storage_context", lambda: SimpleNamespace(scope_id="x")
    )
    with pytest.raises(app_module.HTTPException) as exc:
        app_module.create_cli_workspace_snapshot(
            request(),
            CliWorkspaceSnapshotRequest(
                sharedWorkspaceKey="exec_1", snapshotId="planning"
            ),
        )
    assert exc.value.status_code == 409


def test_prune_snapshots_submits_job(_juicefs) -> None:
    batch, _core = _juicefs
    out = app_module.prune_cli_workspace_snapshots(
        request(),
        CliWorkspaceSnapshotPruneRequest(
            sharedWorkspaceKey="exec_1", keep=["planning"], all=False
        ),
    )
    assert out["success"] is True
    assert len(batch.jobs) == 1
    env = {e["name"]: e["value"] for e in batch.jobs[0]["spec"]["template"]["spec"]["containers"][0]["env"]}
    assert env["KEY"] == "exec_1"
    assert env["KEEP"] == "planning"
    assert "PRUNE_ALL" not in env


def test_prune_all_sets_prune_all_env(_juicefs) -> None:
    batch, _core = _juicefs
    app_module.prune_cli_workspace_snapshots(
        request(),
        CliWorkspaceSnapshotPruneRequest(sharedWorkspaceKey="exec_1", all=True),
    )
    env = {e["name"]: e["value"] for e in batch.jobs[0]["spec"]["template"]["spec"]["containers"][0]["env"]}
    assert env["PRUNE_ALL"] == "1"


# --- webdav listing parse -----------------------------------------------------


def test_parse_webdav_child_dir_names() -> None:
    xml = (
        '<?xml version="1.0"?><D:multistatus xmlns:D="DAV:">'
        "<D:response><D:href>/.snapshots/exec_1/</D:href></D:response>"
        "<D:response><D:href>/.snapshots/exec_1/planning/</D:href></D:response>"
        "<D:response><D:href>/.snapshots/exec_1/build_ui/</D:href></D:response>"
        "</D:multistatus>"
    )
    names = app_module._parse_webdav_child_dir_names(
        xml, self_path=".snapshots/exec_1/"
    )
    assert sorted(names) == ["build_ui", "planning"]

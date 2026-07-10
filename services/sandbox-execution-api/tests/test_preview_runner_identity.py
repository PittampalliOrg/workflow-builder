from __future__ import annotations

from copy import deepcopy
from types import SimpleNamespace

import pytest

import src.app as app_module
from src.app import VclusterPreviewRequest
from src.preview_runner_identity import (
    BOOTSTRAP_CLUSTER_ROLE,
    CONTROL_NAMESPACE,
    CONTROL_ROLE,
    NAMESPACE_CLUSTER_ROLE,
    RUNNER_GENERATION_ANNOTATION,
    PreviewRunnerIdentityAdapter,
    PreviewRunnerIdentityContract,
    PreviewRunnerIdentityError,
)

RUNNER_GENERATION = "op:" + "a" * 32


class ApiError(Exception):
    def __init__(self, status: int) -> None:
        super().__init__(f"api status {status}")
        self.status = status


class FakeCore:
    def __init__(self) -> None:
        self.namespaces: dict[str, dict] = {}
        self.service_accounts: dict[tuple[str, str], dict] = {}
        self.namespace_creates: list[str] = []
        self.fail_namespace_read = False
        self.fail_namespace_read_at: int | None = None
        self.namespace_reads = 0
        self.fail_namespace_list = False
        self.list_stored_namespaces = False
        self.fail_namespace_delete = False
        self.ambiguous_service_account_create = False
        self.hostile_service_account_create = False

    def read_namespace(self, *, name: str):
        self.namespace_reads += 1
        if (
            self.fail_namespace_read
            or self.namespace_reads == self.fail_namespace_read_at
        ):
            raise ApiError(500)
        if name not in self.namespaces:
            raise ApiError(404)
        return deepcopy(self.namespaces[name])

    def list_namespace(self, **_kwargs):
        if self.fail_namespace_list:
            raise ApiError(500)
        return SimpleNamespace(
            items=(
                [deepcopy(value) for value in self.namespaces.values()]
                if self.list_stored_namespaces
                else []
            )
        )

    def create_namespace(self, *, body: dict):
        name = body["metadata"]["name"]
        if name in self.namespaces:
            raise ApiError(409)
        self.namespaces[name] = deepcopy(body)
        self.namespace_creates.append(name)
        return deepcopy(body)

    def patch_namespace(self, *, name: str, body: dict):
        if name not in self.namespaces:
            raise ApiError(404)
        labels = self.namespaces[name]["metadata"].setdefault("labels", {})
        for key, value in body.get("metadata", {}).get("labels", {}).items():
            if value is None:
                labels.pop(key, None)
            else:
                labels[key] = value
        annotations = self.namespaces[name]["metadata"].setdefault("annotations", {})
        for key, value in body.get("metadata", {}).get("annotations", {}).items():
            if value is None:
                annotations.pop(key, None)
            else:
                annotations[key] = value
        return deepcopy(self.namespaces[name])

    def delete_namespace(self, *, name: str, **_kwargs):
        if self.fail_namespace_delete:
            raise ApiError(500)
        if name not in self.namespaces:
            raise ApiError(404)
        del self.namespaces[name]

    def read_namespaced_service_account(self, *, name: str, namespace: str):
        key = (namespace, name)
        if key not in self.service_accounts:
            raise ApiError(404)
        return deepcopy(self.service_accounts[key])

    def create_namespaced_service_account(self, *, namespace: str, body: dict):
        key = (namespace, body["metadata"]["name"])
        if key in self.service_accounts:
            raise ApiError(409)
        stored = deepcopy(body)
        if self.hostile_service_account_create:
            stored["secrets"] = [{"name": "host-secret"}]
        self.service_accounts[key] = stored
        if self.ambiguous_service_account_create or self.hostile_service_account_create:
            raise ApiError(500)
        return deepcopy(body)

    def delete_namespaced_service_account(
        self, *, name: str, namespace: str, **_kwargs
    ):
        key = (namespace, name)
        if key not in self.service_accounts:
            raise ApiError(404)
        del self.service_accounts[key]


class FakeRbac:
    def __init__(self, core: FakeCore) -> None:
        self.core = core
        self.cluster_role_bindings: dict[str, dict] = {}
        self.role_bindings: dict[tuple[str, str], dict] = {}
        self.drop_cluster_binding_create = False
        self.fail_cluster_binding_read = False

    def read_cluster_role_binding(self, *, name: str):
        if self.fail_cluster_binding_read:
            raise ApiError(500)
        if name not in self.cluster_role_bindings:
            raise ApiError(404)
        return deepcopy(self.cluster_role_bindings[name])

    def create_cluster_role_binding(self, *, body: dict):
        name = body["metadata"]["name"]
        if self.drop_cluster_binding_create:
            return deepcopy(body)
        if name in self.cluster_role_bindings:
            raise ApiError(409)
        self.cluster_role_bindings[name] = deepcopy(body)
        return deepcopy(body)

    def delete_cluster_role_binding(self, *, name: str, **_kwargs):
        if name not in self.cluster_role_bindings:
            raise ApiError(404)
        del self.cluster_role_bindings[name]

    def read_namespaced_role_binding(self, *, name: str, namespace: str):
        key = (namespace, name)
        if key not in self.role_bindings:
            raise ApiError(404)
        return deepcopy(self.role_bindings[key])

    def create_namespaced_role_binding(self, *, namespace: str, body: dict):
        if namespace != CONTROL_NAMESPACE and namespace not in self.core.namespaces:
            raise ApiError(404)
        key = (namespace, body["metadata"]["name"])
        if key in self.role_bindings:
            raise ApiError(409)
        self.role_bindings[key] = deepcopy(body)
        return deepcopy(body)

    def delete_namespaced_role_binding(self, *, name: str, namespace: str, **_kwargs):
        key = (namespace, name)
        if key not in self.role_bindings:
            raise ApiError(404)
        del self.role_bindings[key]


class FakeBatch:
    def __init__(
        self,
        *,
        create_status: int | None = None,
        ambiguous_create: bool = False,
        hostile_ambiguous_create: bool = False,
        down_succeeded: bool = False,
        down_annotations: dict[str, str] | None = None,
    ) -> None:
        self.create_status = create_status
        self.ambiguous_create = ambiguous_create
        self.hostile_ambiguous_create = hostile_ambiguous_create
        self.down_succeeded = down_succeeded
        self.down_annotations = down_annotations or {}
        self.jobs: list[dict] = []

    def create_namespaced_job(self, *, namespace: str, body: dict):
        if self.create_status is not None:
            raise ApiError(self.create_status)
        assert namespace == CONTROL_NAMESPACE
        created = deepcopy(body)
        if self.hostile_ambiguous_create:
            created["spec"]["template"]["spec"]["containers"][0]["image"] = (
                "attacker.invalid/runner:latest"
            )
        self.jobs.append(created)
        if self.ambiguous_create or self.hostile_ambiguous_create:
            raise ApiError(500)

    def delete_namespaced_job(self, *, name: str, **_kwargs):
        for index, job in enumerate(self.jobs):
            if job["metadata"]["name"] == name:
                self.jobs.pop(index)
                return
        raise ApiError(404)

    def read_namespaced_job(self, *, name: str, **_kwargs):
        for job in self.jobs:
            if job["metadata"]["name"] == name:
                return deepcopy(job)
        raise ApiError(404)

    def read_namespaced_job_status(self, *, name: str, **_kwargs):
        if not self.down_succeeded:
            raise ApiError(404)
        preview_name = name.removeprefix("vcpreview-down-")
        job = _down_job(preview_name)
        job.metadata.annotations.update(self.down_annotations)
        return job


def _down_job(
    name: str,
    *,
    succeeded: bool = True,
    service_account: str | None = None,
    generation: str = RUNNER_GENERATION,
) -> SimpleNamespace:
    contract = PreviewRunnerIdentityContract(name)
    labels = {
        "app": "vcluster-preview",
        "vcluster-preview-name": name,
        "vcluster-preview-action": "down",
        "preview.stacks.io/managed": "true",
        "preview.stacks.io/preview-name": name,
    }
    return SimpleNamespace(
        metadata=SimpleNamespace(
            name=f"vcpreview-down-{name}",
            labels=dict(labels),
            annotations={RUNNER_GENERATION_ANNOTATION: generation},
        ),
        spec=SimpleNamespace(
            template=SimpleNamespace(
                metadata=SimpleNamespace(
                    labels=dict(labels),
                    annotations={RUNNER_GENERATION_ANNOTATION: generation},
                ),
                spec=SimpleNamespace(
                    service_account_name=(service_account or contract.identity_name)
                ),
            )
        ),
        status=SimpleNamespace(
            succeeded=1 if succeeded else 0,
            failed=0 if succeeded else 1,
            conditions=[],
        ),
    )


class CleanupBatch:
    def __init__(self, jobs: list[SimpleNamespace]) -> None:
        self.jobs = jobs
        self.patches: list[dict] = []

    def list_namespaced_job(self, **_kwargs):
        return SimpleNamespace(items=self.jobs)

    def read_namespaced_job_status(self, *, name: str, **_kwargs):
        for job in self.jobs:
            if job.metadata.name == name:
                return job
        raise ApiError(404)

    def patch_namespaced_job(self, *, name: str, namespace: str, body: dict):
        self.patches.append({"name": name, "namespace": namespace, "body": body})
        for job in self.jobs:
            if job.metadata.name == name:
                job.metadata.annotations.update(body["metadata"]["annotations"])
                return job
        raise ApiError(404)


def _seed_identity(core: FakeCore, rbac: FakeRbac, name: str) -> None:
    contract = PreviewRunnerIdentityContract(name, "ephemeral")
    core.namespaces[contract.target_namespace] = contract.namespace_body()
    core.namespaces[contract.target_namespace]["metadata"]["labels"][
        "preview.stacks.io/runner-admitted"
    ] = "true"
    core.service_accounts[(CONTROL_NAMESPACE, contract.identity_name)] = (
        contract.service_account_body()
    )
    rbac.cluster_role_bindings[contract.identity_name] = (
        contract.cluster_role_binding_body()
    )
    rbac.role_bindings[(CONTROL_NAMESPACE, contract.identity_name)] = (
        contract.control_role_binding_body()
    )
    rbac.role_bindings[(contract.target_namespace, contract.identity_name)] = (
        contract.target_role_binding_body()
    )


def _assert_identity_absent(core: FakeCore, rbac: FakeRbac, name: str) -> None:
    contract = PreviewRunnerIdentityContract(name)
    assert contract.target_namespace not in core.namespaces
    assert (CONTROL_NAMESPACE, contract.identity_name) not in core.service_accounts
    assert contract.identity_name not in rbac.cluster_role_bindings
    assert (CONTROL_NAMESPACE, contract.identity_name) not in rbac.role_bindings
    assert (contract.target_namespace, contract.identity_name) not in rbac.role_bindings


def test_contract_names_and_role_refs_are_exact() -> None:
    contract = PreviewRunnerIdentityContract("feature-one", "retained")

    assert contract.identity_name == "vcpreview-feature-one"
    assert contract.target_namespace == "vcluster-feature-one"
    assert contract.cluster_role_binding_body()["roleRef"]["name"] == (
        BOOTSTRAP_CLUSTER_ROLE
    )
    assert contract.control_role_binding_body()["roleRef"] == {
        "apiGroup": "rbac.authorization.k8s.io",
        "kind": "Role",
        "name": CONTROL_ROLE,
    }
    assert contract.target_role_binding_body()["roleRef"]["name"] == (
        NAMESPACE_CLUSTER_ROLE
    )
    for binding in (
        contract.cluster_role_binding_body(),
        contract.control_role_binding_body(),
        contract.target_role_binding_body(),
    ):
        assert binding["subjects"] == [
            {
                "apiGroup": "",
                "kind": "ServiceAccount",
                "name": contract.identity_name,
                "namespace": CONTROL_NAMESPACE,
            }
        ]


def test_up_establishes_and_proves_exact_identity_before_job(monkeypatch) -> None:
    core = FakeCore()
    rbac = FakeRbac(core)
    batch = FakeBatch()
    monkeypatch.setattr(app_module, "_load_k8s_rbac_client", lambda: rbac)
    request = VclusterPreviewRequest(
        name="feature-one", action="up", lifecycle="ephemeral"
    )
    manifest = app_module._vcluster_preview_job_manifest(
        request, namespace=CONTROL_NAMESPACE
    )

    app_module._submit_preview_job(
        batch,
        core,
        namespace=CONTROL_NAMESPACE,
        manifest=manifest,
        lifecycle="ephemeral",
        create_only=True,
    )

    contract = PreviewRunnerIdentityContract("feature-one", "ephemeral")
    labels = core.namespaces[contract.target_namespace]["metadata"]["labels"]
    assert labels["preview.stacks.io/identity-ready"] == "true"
    assert labels["pod-security.kubernetes.io/enforce"] == "restricted"
    assert batch.jobs[0]["spec"]["template"]["spec"]["serviceAccountName"] == (
        contract.identity_name
    )
    pod_spec = batch.jobs[0]["spec"]["template"]["spec"]
    assert pod_spec["containers"][0]["command"] == [
        "bash",
        "/opt/preview-runner/runner.sh",
    ]
    assert pod_spec["automountServiceAccountToken"] is True
    assert pod_spec["enableServiceLinks"] is False
    assert pod_spec["securityContext"] == {
        "runAsNonRoot": True,
        "runAsUser": 1001,
        "runAsGroup": 1001,
        "fsGroup": 1001,
        "fsGroupChangePolicy": "OnRootMismatch",
        "seccompProfile": {"type": "RuntimeDefault"},
    }
    runner = pod_spec["containers"][0]
    assert runner["securityContext"] == {
        "allowPrivilegeEscalation": False,
        "readOnlyRootFilesystem": True,
        "capabilities": {"drop": ["ALL"]},
    }
    assert runner["resources"] == {
        "requests": {"cpu": "250m", "memory": "256Mi"},
        "limits": {"cpu": "2", "memory": "1Gi"},
    }
    assert next(item for item in runner["env"] if item["name"] == "HOME") == {
        "name": "HOME",
        "value": "/tmp",
    }
    assert {mount["name"]: mount["mountPath"] for mount in runner["volumeMounts"]} == {
        "tmp": "/tmp",
        "ghcr-pull": "/var/run/preview-credentials/ghcr-pull",
    }
    assert {volume["name"] for volume in pod_spec["volumes"]} == {
        "tmp",
        "ghcr-pull",
    }
    assert next(volume for volume in pod_spec["volumes"] if volume["name"] == "tmp") == {
        "name": "tmp",
        "emptyDir": {"sizeLimit": "1Gi"},
    }
    assert not any("configMap" in volume for volume in pod_spec["volumes"])
    assert batch.jobs[0]["spec"]["ttlSecondsAfterFinished"] == 1800


def test_ambiguous_exact_job_create_is_reread_and_keeps_identity(
    monkeypatch,
) -> None:
    core = FakeCore()
    rbac = FakeRbac(core)
    batch = FakeBatch(ambiguous_create=True)
    monkeypatch.setattr(app_module, "_load_k8s_rbac_client", lambda: rbac)
    manifest = app_module._vcluster_preview_job_manifest(
        VclusterPreviewRequest(name="ambiguous-job", action="up"),
        namespace=CONTROL_NAMESPACE,
    )

    assert app_module._submit_preview_job(
        batch,
        core,
        namespace=CONTROL_NAMESPACE,
        manifest=manifest,
        lifecycle="ephemeral",
        create_only=True,
    )

    contract = PreviewRunnerIdentityContract("ambiguous-job")
    assert len(batch.jobs) == 1
    generation = batch.jobs[0]["metadata"]["annotations"][
        RUNNER_GENERATION_ANNOTATION
    ]
    assert generation.startswith("op:")
    assert batch.jobs[0]["spec"]["template"]["metadata"]["annotations"][
        RUNNER_GENERATION_ANNOTATION
    ] == generation
    assert core.namespaces[contract.target_namespace]["metadata"]["labels"][
        "preview.stacks.io/runner-admitted"
    ] == "true"


def test_ambiguous_mismatched_job_is_compensated_with_identity(
    monkeypatch,
) -> None:
    core = FakeCore()
    rbac = FakeRbac(core)
    batch = FakeBatch(hostile_ambiguous_create=True)
    monkeypatch.setattr(app_module, "_load_k8s_rbac_client", lambda: rbac)
    manifest = app_module._vcluster_preview_job_manifest(
        VclusterPreviewRequest(name="ambiguous-hostile", action="up"),
        namespace=CONTROL_NAMESPACE,
    )

    with pytest.raises(PreviewRunnerIdentityError, match="compensated"):
        app_module._submit_preview_job(
            batch,
            core,
            namespace=CONTROL_NAMESPACE,
            manifest=manifest,
            lifecycle="ephemeral",
            create_only=True,
        )

    assert batch.jobs == []
    _assert_identity_absent(core, rbac, "ambiguous-hostile")


def test_mismatched_binding_fails_before_job_and_rolls_back_new_objects(
    monkeypatch,
) -> None:
    core = FakeCore()
    rbac = FakeRbac(core)
    contract = PreviewRunnerIdentityContract("hostile", "ephemeral")
    core.namespaces[contract.target_namespace] = contract.namespace_body()
    hostile = contract.cluster_role_binding_body()
    hostile["roleRef"]["name"] = "cluster-admin"
    rbac.cluster_role_bindings[contract.identity_name] = hostile
    batch = FakeBatch()
    monkeypatch.setattr(app_module, "_load_k8s_rbac_client", lambda: rbac)
    manifest = app_module._vcluster_preview_job_manifest(
        VclusterPreviewRequest(name="hostile", action="up"),
        namespace=CONTROL_NAMESPACE,
    )

    with pytest.raises(PreviewRunnerIdentityError, match="does not match"):
        app_module._submit_preview_job(
            batch,
            core,
            namespace=CONTROL_NAMESPACE,
            manifest=manifest,
            lifecycle="ephemeral",
        )

    assert batch.jobs == []
    assert (CONTROL_NAMESPACE, contract.identity_name) not in core.service_accounts
    assert rbac.cluster_role_bindings[contract.identity_name] == hostile


def test_tampered_pod_identity_fails_before_kubernetes_access(monkeypatch) -> None:
    core = FakeCore()
    batch = FakeBatch()
    manifest = app_module._vcluster_preview_job_manifest(
        VclusterPreviewRequest(name="hostile-pod", action="up"),
        namespace=CONTROL_NAMESPACE,
    )
    manifest["spec"]["template"]["metadata"]["labels"][
        "preview.stacks.io/preview-name"
    ] = "someone-else"
    monkeypatch.setattr(
        app_module,
        "_load_k8s_rbac_client",
        lambda: pytest.fail("tampered pod must fail before RBAC access"),
    )

    with pytest.raises(PreviewRunnerIdentityError, match="pod labels"):
        app_module._submit_preview_job(
            batch,
            core,
            namespace=CONTROL_NAMESPACE,
            manifest=manifest,
            lifecycle="ephemeral",
        )

    assert batch.jobs == []


def test_unobservable_created_binding_fails_closed_before_job(monkeypatch) -> None:
    core = FakeCore()
    rbac = FakeRbac(core)
    rbac.drop_cluster_binding_create = True
    batch = FakeBatch()
    monkeypatch.setattr(app_module, "_load_k8s_rbac_client", lambda: rbac)
    manifest = app_module._vcluster_preview_job_manifest(
        VclusterPreviewRequest(name="vanished", action="up"),
        namespace=CONTROL_NAMESPACE,
    )

    with pytest.raises(PreviewRunnerIdentityError):
        app_module._submit_preview_job(
            batch,
            core,
            namespace=CONTROL_NAMESPACE,
            manifest=manifest,
            lifecycle="ephemeral",
        )

    assert batch.jobs == []
    _assert_identity_absent(core, rbac, "vanished")


def test_job_rejection_rolls_back_fresh_identity_reservation(monkeypatch) -> None:
    core = FakeCore()
    rbac = FakeRbac(core)
    batch = FakeBatch(create_status=409)
    monkeypatch.setattr(app_module, "_load_k8s_rbac_client", lambda: rbac)
    manifest = app_module._vcluster_preview_job_manifest(
        VclusterPreviewRequest(name="retryable", action="up"),
        namespace=CONTROL_NAMESPACE,
    )

    with pytest.raises(ApiError) as caught:
        app_module._submit_preview_job(
            batch,
            core,
            namespace=CONTROL_NAMESPACE,
            manifest=manifest,
            lifecycle="ephemeral",
            create_only=True,
        )

    assert caught.value.status == 409
    _assert_identity_absent(core, rbac, "retryable")


def test_ambiguous_service_account_create_is_reobserved_and_validated(
    monkeypatch,
) -> None:
    core = FakeCore()
    core.ambiguous_service_account_create = True
    rbac = FakeRbac(core)
    batch = FakeBatch()
    monkeypatch.setattr(app_module, "_load_k8s_rbac_client", lambda: rbac)
    manifest = app_module._vcluster_preview_job_manifest(
        VclusterPreviewRequest(name="ambiguous", action="up"),
        namespace=CONTROL_NAMESPACE,
    )

    app_module._submit_preview_job(
        batch,
        core,
        namespace=CONTROL_NAMESPACE,
        manifest=manifest,
        lifecycle="ephemeral",
    )

    assert len(batch.jobs) == 1
    contract = PreviewRunnerIdentityContract("ambiguous")
    assert (CONTROL_NAMESPACE, contract.identity_name) in core.service_accounts
    assert (
        core.namespaces[contract.target_namespace]["metadata"]["labels"][
            "preview.stacks.io/runner-admitted"
        ]
        == "true"
    )


def test_ambiguous_hostile_create_fails_closed_without_deleting_conflict(
    monkeypatch,
) -> None:
    core = FakeCore()
    core.hostile_service_account_create = True
    rbac = FakeRbac(core)
    batch = FakeBatch()
    monkeypatch.setattr(app_module, "_load_k8s_rbac_client", lambda: rbac)
    manifest = app_module._vcluster_preview_job_manifest(
        VclusterPreviewRequest(name="hostile-create", action="up"),
        namespace=CONTROL_NAMESPACE,
    )

    with pytest.raises(PreviewRunnerIdentityError, match="compensation incomplete"):
        app_module._submit_preview_job(
            batch,
            core,
            namespace=CONTROL_NAMESPACE,
            manifest=manifest,
            lifecycle="ephemeral",
        )

    contract = PreviewRunnerIdentityContract("hostile-create")
    assert batch.jobs == []
    assert core.service_accounts[(CONTROL_NAMESPACE, contract.identity_name)][
        "secrets"
    ] == [{"name": "host-secret"}]


def test_failed_job_rollback_reports_orphan_and_is_retryable(monkeypatch) -> None:
    core = FakeCore()
    core.fail_namespace_delete = True
    rbac = FakeRbac(core)
    batch = FakeBatch(create_status=409)
    monkeypatch.setattr(app_module, "_load_k8s_rbac_client", lambda: rbac)
    manifest = app_module._vcluster_preview_job_manifest(
        VclusterPreviewRequest(name="orphaned", action="up"),
        namespace=CONTROL_NAMESPACE,
    )

    with pytest.raises(PreviewRunnerIdentityError, match="compensation incomplete"):
        app_module._submit_preview_job(
            batch,
            core,
            namespace=CONTROL_NAMESPACE,
            manifest=manifest,
            lifecycle="ephemeral",
            create_only=True,
        )

    contract = PreviewRunnerIdentityContract("orphaned")
    labels = core.namespaces[contract.target_namespace]["metadata"]["labels"]
    assert labels["preview.stacks.io/runner-admitted"] == "false"
    assert batch.jobs == []

    core.fail_namespace_delete = False
    core.list_stored_namespaces = True
    monkeypatch.setattr(
        app_module,
        "_acquire_preview_operation_lease",
        lambda _coordination, *, namespace, real_name: "op:" + "3" * 32,
    )
    monkeypatch.setattr(
        app_module,
        "_delete_preview_operation_lease",
        lambda *_args, **_kwargs: True,
    )
    orphan_stats = app_module._preview_identity_orphan_cleanup_once(
        CleanupBatch([]),
        core,
        rbac,
        SimpleNamespace(),
        namespace=CONTROL_NAMESPACE,
    )
    assert orphan_stats["cleaned"] == 1
    _assert_identity_absent(core, rbac, "orphaned")


def test_failed_post_patch_proof_clears_ready_marker_and_created_identity() -> None:
    core = FakeCore()
    rbac = FakeRbac(core)
    contract = PreviewRunnerIdentityContract("uncertain", "ephemeral")
    core.namespaces[contract.target_namespace] = contract.namespace_body()
    core.fail_namespace_read_at = 2

    with pytest.raises(PreviewRunnerIdentityError):
        PreviewRunnerIdentityAdapter(core, rbac).ensure_for_job(
            preview_name="uncertain",
            action="up",
            lifecycle="ephemeral",
            runner_generation=RUNNER_GENERATION,
        )

    assert (
        "preview.stacks.io/identity-ready"
        not in core.namespaces[contract.target_namespace]["metadata"]["labels"]
    )
    assert (CONTROL_NAMESPACE, contract.identity_name) not in core.service_accounts
    assert contract.identity_name not in rbac.cluster_role_bindings
    assert (CONTROL_NAMESPACE, contract.identity_name) not in rbac.role_bindings
    assert (contract.target_namespace, contract.identity_name) not in rbac.role_bindings


def test_residual_down_never_recreates_namespace() -> None:
    core = FakeCore()
    rbac = FakeRbac(core)
    _seed_identity(core, rbac, "residual")
    contract = PreviewRunnerIdentityContract("residual")
    del core.namespaces[contract.target_namespace]
    del rbac.role_bindings[(contract.target_namespace, contract.identity_name)]
    core.namespace_creates.clear()

    reservation = PreviewRunnerIdentityAdapter(core, rbac).ensure_for_job(
        preview_name="residual",
        action="down",
        lifecycle=None,
        runner_generation=RUNNER_GENERATION,
    )

    assert reservation.identity_name == contract.identity_name
    assert reservation.created == ()
    assert core.namespace_creates == []
    assert contract.target_namespace not in core.namespaces


def test_residual_down_requires_existing_control_identity() -> None:
    core = FakeCore()
    rbac = FakeRbac(core)
    _seed_identity(core, rbac, "residual")
    contract = PreviewRunnerIdentityContract("residual")
    del core.namespaces[contract.target_namespace]
    del rbac.role_bindings[(contract.target_namespace, contract.identity_name)]
    del rbac.role_bindings[(CONTROL_NAMESPACE, contract.identity_name)]

    with pytest.raises(PreviewRunnerIdentityError, match="existing bounded"):
        PreviewRunnerIdentityAdapter(core, rbac).ensure_for_job(
            preview_name="residual",
            action="down",
            lifecycle=None,
            runner_generation=RUNNER_GENERATION,
        )

    assert core.namespace_creates == []


def test_controller_compensation_bootstraps_only_control_identity_for_absent_down() -> None:
    core = FakeCore()
    rbac = FakeRbac(core)
    contract = PreviewRunnerIdentityContract("never-created")

    reservation = PreviewRunnerIdentityAdapter(core, rbac).ensure_for_job(
        preview_name="never-created",
        action="down",
        lifecycle=None,
        runner_generation=RUNNER_GENERATION,
        allow_absent_down_bootstrap=True,
    )

    assert reservation.target_namespace_present is False
    assert contract.target_namespace not in core.namespaces
    assert core.namespace_creates == []
    assert (CONTROL_NAMESPACE, contract.identity_name) in core.service_accounts
    assert contract.identity_name in rbac.cluster_role_bindings
    assert (CONTROL_NAMESPACE, contract.identity_name) in rbac.role_bindings
    assert (contract.target_namespace, contract.identity_name) not in rbac.role_bindings


def test_absent_identity_bootstrap_is_rejected_for_non_down_actions() -> None:
    core = FakeCore()
    rbac = FakeRbac(core)

    with pytest.raises(PreviewRunnerIdentityError, match="only for down"):
        PreviewRunnerIdentityAdapter(core, rbac).ensure_for_job(
            preview_name="never-created",
            action="up",
            lifecycle="ephemeral",
            runner_generation=RUNNER_GENERATION,
            allow_absent_down_bootstrap=True,
        )

    _assert_identity_absent(core, rbac, "never-created")


def test_repeat_delete_after_namespace_and_identity_absence_is_complete(
    monkeypatch,
) -> None:
    core = FakeCore()
    rbac = FakeRbac(core)
    batch = FakeBatch(
        down_succeeded=True,
        down_annotations={
            "preview.stacks.io/teardown-request-id": "request-one",
            "preview.stacks.io/teardown-source-revision": "a" * 40,
        },
    )
    monkeypatch.setenv("SANDBOX_EXECUTION_API_TOKEN", "test-token")
    monkeypatch.setattr(app_module, "_load_k8s_clients", lambda: (batch, core))
    monkeypatch.setattr(app_module, "_load_k8s_rbac_client", lambda: rbac)
    monkeypatch.setattr(
        app_module,
        "_load_k8s_coordination_client",
        lambda: pytest.fail("completed absence must not acquire or recreate authority"),
    )
    request = SimpleNamespace(headers={"authorization": "Bearer test-token"})
    teardown = app_module.VclusterPreviewTeardownRequest(
        expectedRequestId="request-one",
        expectedSourceRevision="a" * 40,
    )

    first = app_module.teardown_vcluster_preview(request, "already-gone", teardown)
    second = app_module.teardown_vcluster_preview(request, "already-gone", teardown)

    assert first == second
    assert first["complete"] is True
    assert first["phase"] == "complete"
    assert first["status"] == "absent"
    assert batch.jobs == []
    _assert_identity_absent(core, rbac, "already-gone")


def test_repeat_delete_rejects_a_success_receipt_from_an_older_generation(
    monkeypatch,
) -> None:
    core = FakeCore()
    rbac = FakeRbac(core)
    batch = FakeBatch(
        down_succeeded=True,
        down_annotations={
            "preview.stacks.io/teardown-request-id": "older-request",
            "preview.stacks.io/teardown-source-revision": "b" * 40,
        },
    )
    monkeypatch.setenv("SANDBOX_EXECUTION_API_TOKEN", "test-token")
    monkeypatch.setattr(app_module, "_load_k8s_clients", lambda: (batch, core))
    monkeypatch.setattr(app_module, "_load_k8s_rbac_client", lambda: rbac)
    monkeypatch.setattr(
        app_module,
        "_load_k8s_coordination_client",
        lambda: pytest.fail("mismatched receipt must not acquire authority"),
    )

    with pytest.raises(app_module.HTTPException) as caught:
        app_module.teardown_vcluster_preview(
            SimpleNamespace(headers={"authorization": "Bearer test-token"}),
            "already-gone",
            app_module.VclusterPreviewTeardownRequest(
                expectedRequestId="new-request",
                expectedSourceRevision="c" * 40,
            ),
        )

    assert caught.value.status_code == 409
    assert batch.jobs == []
    _assert_identity_absent(core, rbac, "already-gone")


def test_absence_without_successful_down_receipt_fails_without_recreation(
    monkeypatch,
) -> None:
    core = FakeCore()
    rbac = FakeRbac(core)
    batch = FakeBatch()
    monkeypatch.setenv("SANDBOX_EXECUTION_API_TOKEN", "test-token")
    monkeypatch.setattr(app_module, "_load_k8s_clients", lambda: (batch, core))
    monkeypatch.setattr(app_module, "_load_k8s_rbac_client", lambda: rbac)
    monkeypatch.setattr(
        app_module,
        "_load_k8s_coordination_client",
        lambda: pytest.fail("unproved absence must not acquire authority"),
    )

    with pytest.raises(app_module.HTTPException) as caught:
        app_module.provision_vcluster_preview(
            SimpleNamespace(headers={"authorization": "Bearer test-token"}),
            VclusterPreviewRequest(name="unproved", action="down"),
        )

    assert caught.value.status_code == 409
    assert core.namespace_creates == []
    assert batch.jobs == []
    _assert_identity_absent(core, rbac, "unproved")


def test_lifecycle_mismatch_is_rejected_without_mutation() -> None:
    core = FakeCore()
    rbac = FakeRbac(core)
    _seed_identity(core, rbac, "retained")

    with pytest.raises(PreviewRunnerIdentityError, match="lifecycle"):
        PreviewRunnerIdentityAdapter(core, rbac).ensure_for_job(
            preview_name="retained",
            action="sleep",
            lifecycle="retained",
            runner_generation=RUNNER_GENERATION,
        )


def test_cleanup_requires_success_and_namespace_absence_then_allows_recreate() -> None:
    core = FakeCore()
    rbac = FakeRbac(core)
    adapter = PreviewRunnerIdentityAdapter(core, rbac)
    adapter.ensure_for_job(
        preview_name="recreate",
        action="up",
        lifecycle="ephemeral",
        runner_generation=RUNNER_GENERATION,
    )
    contract = PreviewRunnerIdentityContract("recreate")

    with pytest.raises(PreviewRunnerIdentityError, match="successful down"):
        adapter.cleanup_after_down(
            preview_name="recreate",
            runner_succeeded=False,
            target_namespace_absent=False,
        )
    assert (CONTROL_NAMESPACE, contract.identity_name) in core.service_accounts

    core.delete_namespace(name=contract.target_namespace)
    assert adapter.cleanup_after_down(
        preview_name="recreate",
        runner_succeeded=True,
        target_namespace_absent=True,
    )
    adapter.prove_absent(preview_name="recreate")

    adapter.ensure_for_job(
        preview_name="recreate",
        action="up",
        lifecycle="retained",
        runner_generation=RUNNER_GENERATION,
    )
    assert (
        core.namespaces[contract.target_namespace]["metadata"]["labels"][
            "vcluster-preview-lifecycle"
        ]
        == "retained"
    )


def test_terminal_down_controller_cleans_identity_without_get_poll(
    monkeypatch,
) -> None:
    core = FakeCore()
    rbac = FakeRbac(core)
    _seed_identity(core, rbac, "automatic")
    contract = PreviewRunnerIdentityContract("automatic")
    del core.namespaces[contract.target_namespace]
    del rbac.role_bindings[(contract.target_namespace, contract.identity_name)]
    batch = CleanupBatch([_down_job("automatic")])
    deleted_leases: list[tuple[str, str]] = []
    monkeypatch.setattr(
        app_module,
        "_acquire_preview_operation_lease",
        lambda _coordination, *, namespace, real_name: "op:" + "1" * 32,
    )
    monkeypatch.setattr(
        app_module,
        "_delete_preview_operation_lease",
        lambda _coordination, *, namespace, real_name, holder: (
            deleted_leases.append((namespace, real_name)) or True
        ),
    )

    stats = app_module._preview_identity_cleanup_once(
        batch,
        core,
        rbac,
        SimpleNamespace(),
        namespace=CONTROL_NAMESPACE,
    )

    assert stats == {
        "scanned": 1,
        "eligible": 1,
        "cleaned": 1,
        "busy": 0,
        "failed": 0,
    }
    PreviewRunnerIdentityAdapter(core, rbac).prove_absent(preview_name="automatic")
    assert batch.jobs[0].metadata.annotations == {
        RUNNER_GENERATION_ANNOTATION: RUNNER_GENERATION,
        "preview.stacks.io/identity-cleaned": "true"
    }
    assert deleted_leases == [(CONTROL_NAMESPACE, "automatic")]


def test_orphan_controller_recovers_marker_when_exact_job_exists(
    monkeypatch,
) -> None:
    core = FakeCore()
    core.list_stored_namespaces = True
    rbac = FakeRbac(core)
    PreviewRunnerIdentityAdapter(core, rbac).ensure_for_job(
        preview_name="marker-recovery",
        action="up",
        lifecycle="ephemeral",
        runner_generation=RUNNER_GENERATION,
    )
    manifest = app_module._vcluster_preview_job_manifest(
        VclusterPreviewRequest(name="marker-recovery", action="up"),
        namespace=CONTROL_NAMESPACE,
        operation_holder=RUNNER_GENERATION,
    )
    batch = CleanupBatch([manifest])
    monkeypatch.setattr(
        app_module,
        "_acquire_preview_operation_lease",
        lambda _coordination, *, namespace, real_name: "op:" + "4" * 32,
    )
    monkeypatch.setattr(
        app_module,
        "_release_preview_operation_lease",
        lambda *_args, **_kwargs: None,
    )

    stats = app_module._preview_identity_orphan_cleanup_once(
        batch,
        core,
        rbac,
        SimpleNamespace(),
        namespace=CONTROL_NAMESPACE,
    )

    contract = PreviewRunnerIdentityContract("marker-recovery")
    assert stats["recovered"] == 1
    assert stats["cleaned"] == 0
    assert (
        core.namespaces[contract.target_namespace]["metadata"]["labels"][
            "preview.stacks.io/runner-admitted"
        ]
        == "true"
    )
    assert (CONTROL_NAMESPACE, contract.identity_name) in core.service_accounts


def test_orphan_controller_ignores_prior_down_receipt_generation(
    monkeypatch,
) -> None:
    core = FakeCore()
    core.list_stored_namespaces = True
    rbac = FakeRbac(core)
    PreviewRunnerIdentityAdapter(core, rbac).ensure_for_job(
        preview_name="stale-receipt",
        action="up",
        lifecycle="ephemeral",
        runner_generation=RUNNER_GENERATION,
    )
    old_generation = "op:" + "b" * 32
    batch = CleanupBatch(
        [_down_job("stale-receipt", generation=old_generation)]
    )
    monkeypatch.setattr(
        app_module,
        "_acquire_preview_operation_lease",
        lambda _coordination, *, namespace, real_name: "op:" + "4" * 32,
    )
    monkeypatch.setattr(
        app_module,
        "_delete_preview_operation_lease",
        lambda *_args, **_kwargs: True,
    )

    stats = app_module._preview_identity_orphan_cleanup_once(
        batch,
        core,
        rbac,
        SimpleNamespace(),
        namespace=CONTROL_NAMESPACE,
    )

    assert stats["recovered"] == 0
    assert stats["cleaned"] == 1
    _assert_identity_absent(core, rbac, "stale-receipt")


@pytest.mark.parametrize(
    ("job", "namespace_present"),
    [
        (_down_job("failed", succeeded=False), False),
        (_down_job("wrong-sa", service_account="someone-else"), False),
        (_down_job("still-present"), True),
    ],
)
def test_terminal_down_controller_retains_identity_until_every_proof(
    monkeypatch,
    job: SimpleNamespace,
    namespace_present: bool,
) -> None:
    name = job.metadata.labels["vcluster-preview-name"]
    core = FakeCore()
    rbac = FakeRbac(core)
    _seed_identity(core, rbac, name)
    contract = PreviewRunnerIdentityContract(name)
    if not namespace_present:
        del core.namespaces[contract.target_namespace]
        del rbac.role_bindings[(contract.target_namespace, contract.identity_name)]
    batch = CleanupBatch([job])
    monkeypatch.setattr(
        app_module,
        "_acquire_preview_operation_lease",
        lambda _coordination, *, namespace, real_name: "op:" + "2" * 32,
    )
    monkeypatch.setattr(
        app_module,
        "_release_preview_operation_lease",
        lambda *_args, **_kwargs: None,
    )

    stats = app_module._preview_identity_cleanup_once(
        batch,
        core,
        rbac,
        SimpleNamespace(),
        namespace=CONTROL_NAMESPACE,
    )

    assert stats["cleaned"] == 0
    assert (CONTROL_NAMESPACE, contract.identity_name) in core.service_accounts
    assert contract.identity_name in rbac.cluster_role_bindings
    assert batch.patches == []


def test_teardown_alias_list_failure_never_falls_back_to_requested_name(
    monkeypatch,
) -> None:
    core = FakeCore()
    core.fail_namespace_list = True
    batch = FakeBatch(down_succeeded=True)
    monkeypatch.setenv("SANDBOX_EXECUTION_API_TOKEN", "test-token")
    monkeypatch.setattr(app_module, "_load_k8s_clients", lambda: (batch, core))
    monkeypatch.setattr(
        app_module,
        "_load_k8s_rbac_client",
        lambda: pytest.fail("alias outage must stop before identity access"),
    )
    monkeypatch.setattr(
        app_module,
        "_load_k8s_coordination_client",
        lambda: pytest.fail("alias outage must stop before mutation"),
    )

    with pytest.raises(ApiError) as caught:
        app_module.teardown_vcluster_preview(
            SimpleNamespace(headers={"authorization": "Bearer test-token"}),
            "possibly-an-alias",
            app_module.VclusterPreviewTeardownRequest(
                expectedRequestId="request-one",
                expectedSourceRevision="a" * 40,
            ),
        )

    assert caught.value.status == 500
    assert batch.jobs == []


def test_cleanup_alias_list_failure_never_proves_wrong_identity(monkeypatch) -> None:
    core = FakeCore()
    core.fail_namespace_list = True
    batch = FakeBatch(down_succeeded=True)
    monkeypatch.setenv("SANDBOX_EXECUTION_API_TOKEN", "test-token")
    monkeypatch.setattr(app_module, "_load_k8s_clients", lambda: (batch, core))
    monkeypatch.setattr(
        app_module,
        "_load_k8s_rbac_client",
        lambda: pytest.fail("alias outage must stop before cleanup proof"),
    )

    with pytest.raises(ApiError) as caught:
        app_module.get_vcluster_preview_cleanup(
            SimpleNamespace(headers={"authorization": "Bearer test-token"}),
            "possibly-an-alias",
        )

    assert caught.value.status == 500


def test_kubernetes_query_error_never_becomes_not_found() -> None:
    core = FakeCore()
    rbac = FakeRbac(core)
    _seed_identity(core, rbac, "query-error")
    rbac.fail_cluster_binding_read = True

    with pytest.raises(PreviewRunnerIdentityError, match="could not read"):
        PreviewRunnerIdentityAdapter(core, rbac).ensure_for_job(
            preview_name="query-error",
            action="resume",
            lifecycle="ephemeral",
            runner_generation=RUNNER_GENERATION,
        )

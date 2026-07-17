from __future__ import annotations

import copy
import hashlib
import inspect
import json
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import pytest
from kubernetes.client.exceptions import ApiException

from src.preview_agent_registration import (
    REGISTRATION_FINALIZER,
    PreviewAgentRegistrationOwnershipError,
    PreviewAgentRegistrationStatus,
)
from src.preview_dashboard_cleanup import (
    DASHBOARD_REGISTRATION_FINALIZER,
    PreviewDashboardCleanupOwnershipError,
)
from src.preview_environment_controller import (
    ALLOCATION_LABEL,
    API_GROUP,
    API_PLURAL,
    API_VERSION,
    ARGO_APPLICATIONS_PLURAL,
    ARGO_PROJECTS_PLURAL,
    CONTROL_NAMESPACE,
    CONTRACT_GENERATION_ANNOTATION,
    DELETION_ACK_STATUS_FIELD,
    DELETION_INTENT_STATUS_FIELD,
    ENVIRONMENT_UID_LABEL,
    FINALIZER,
    IMAGES_HASH_LABEL,
    LANE_LABEL,
    MANAGED_BY_LABEL,
    MANAGED_BY_VALUE,
    MODE_LABEL,
    PHYSICAL_CLEANUP_CHECKS,
    CatalogValidationError,
    OwnershipConflict,
    PreviewEnvironmentController,
    PreviewServiceCapabilities,
    PreviewServiceCatalog,
    ManifestCandidateSurface,
    RECONCILE_REQUESTED_AT_ANNOTATION,
    SpecValidationError,
    application_is_ready,
    assert_owned,
    build_app_project_manifest,
    build_application_manifest,
    build_deletion_intent,
    build_namespace_manifest,
    build_status,
    load_preview_service_catalog,
    parse_preview_service_catalog,
    parse_manifest_candidate_surface,
    validate_preview_environment as _validate_preview_environment,
)

NOW = datetime(2026, 7, 9, 12, 0, 0, tzinfo=UTC)
PLATFORM_SHA = "a" * 40
SOURCE_SHA = "b" * 40
IMAGE_DIGEST = f"ghcr.io/pittampalliorg/workflow-builder@sha256:{'c' * 64}"
CATALOG_PATH = (
    Path(__file__).resolve().parents[2] / "shared" / "dev-preview-service-catalog.json"
)
TEST_CATALOG = load_preview_service_catalog(CATALOG_PATH)
TEST_SURFACE = ManifestCandidateSurface(
    profile="manifest-candidate",
    application_path=(
        "packages/components/workloads/workflow-builder-preview-vcluster/"
        "manifest-candidate-overlay"
    ),
    bootstrap_path=(
        "packages/components/workloads/workflow-builder-preview-vcluster/agent-bootstrap"
    ),
    allowed_prefixes=("packages/components/workloads/workflow-builder/manifests/",),
    route_rules=(
        (
            "packages/components/hub-management/",
            "manifest-candidate",
            "management",
            "hub management",
        ),
        (
            "packages/components/talos-only/",
            "host-candidate",
            "application",
            "physical host",
        ),
    ),
)


def validate_preview_environment(
    resource: dict[str, Any],
    *,
    catalog: PreviewServiceCatalog = TEST_CATALOG,
):
    return _validate_preview_environment(
        resource, catalog=catalog, candidate_surface=TEST_SURFACE
    )


def preview_resource(
    *,
    spec: dict[str, Any] | None = None,
    metadata: dict[str, Any] | None = None,
) -> dict[str, Any]:
    base_spec: dict[str, Any] = {
        "id": "feature-x",
        "profile": "app-live",
        "lane": "application",
        "mode": "live",
        "platformRevision": PLATFORM_SHA,
        "sourceRevision": SOURCE_SHA,
        "catalogDigest": TEST_CATALOG.catalog_digest,
        "trustedCode": True,
        "lifecycle": "retained",
        "owner": {"kind": "user", "id": "user-42"},
        "origin": {"kind": "user", "reference": "workspace-1"},
        "services": ["workflow-builder", "workflow-orchestrator"],
        "candidatePaths": [],
        "images": {"workflow-builder": IMAGE_DIGEST},
        "allocation": {"kind": "cold"},
        "ttlHours": 24,
        "expiresAt": "2026-07-10T12:00:00Z",
        "provenance": {
            "requestId": "request-1",
            "requestedAt": "2026-07-09T12:00:00Z",
            "platformRepository": "PittampalliOrg/stacks",
            "sourceRepository": "PittampalliOrg/workflow-builder",
        },
    }
    if spec:
        base_spec.update(spec)
        if spec.get("profile") == "manifest-candidate" and "candidatePaths" not in spec:
            base_spec["candidatePaths"] = [
                "packages/components/workloads/workflow-builder/manifests/Deployment.yaml"
            ]
    base_metadata: dict[str, Any] = {
        "name": "feature-x",
        "namespace": CONTROL_NAMESPACE,
        "uid": "12345678-1234-1234-1234-123456789abc",
        "generation": 3,
    }
    if metadata:
        base_metadata.update(metadata)
    return {
        "apiVersion": f"{API_GROUP}/{API_VERSION}",
        "kind": "PreviewEnvironment",
        "metadata": base_metadata,
        "spec": base_spec,
    }


def validation_messages(
    resource: dict[str, Any],
    *,
    catalog: PreviewServiceCatalog = TEST_CATALOG,
) -> tuple[str, ...]:
    with pytest.raises(SpecValidationError) as caught:
        validate_preview_environment(resource, catalog=catalog)
    return caught.value.issues


def test_validation_accepts_strict_live_contract() -> None:
    value = validate_preview_environment(preview_resource())

    assert value.id == "feature-x"
    assert value.profile == "app-live"
    assert value.lane == "application"
    assert value.mode == "live"
    assert value.lifecycle == "retained"
    assert value.owner_kind == "user"
    assert value.owner_id == "user-42"
    assert value.origin_kind == "user"
    assert value.origin_reference == "workspace-1"
    assert value.services == ("workflow-builder", "workflow-orchestrator")
    assert value.images == (("workflow-builder", IMAGE_DIGEST),)
    assert value.allocation_kind == "cold"
    assert value.baseline_platform_revision is None
    assert value.expires_at == datetime(2026, 7, 10, 12, tzinfo=UTC)
    assert value.catalog_digest == TEST_CATALOG.catalog_digest


def test_validation_requires_user_owner_for_mutable_live_app_preview() -> None:
    messages = validation_messages(
        preview_resource(
            spec={
                "owner": {"kind": "workflow", "id": "workflow-1"},
                "origin": {"kind": "workflow", "reference": "execution-1"},
            }
        )
    )

    assert any(
        "live app-live previews require spec.owner.kind=user or " in issue
        for issue in messages
    )


def test_validation_allows_pull_request_automation_owner_for_live_app() -> None:
    value = validate_preview_environment(
        preview_resource(
            spec={
                "lifecycle": "ephemeral",
                "owner": {"kind": "automation", "id": "pr-preview:42"},
                "origin": {
                    "kind": "pull-request",
                    "reference": "PittampalliOrg/workflow-builder#42",
                },
            }
        )
    )

    assert value.owner_kind == "automation"
    assert value.origin_kind == "pull-request"


@pytest.mark.parametrize(
    ("owner", "origin"),
    [
        (
            {"kind": "automation", "id": "scheduled-preview"},
            {"kind": "automation"},
        ),
        (
            {"kind": "workflow", "id": "workflow-1"},
            {"kind": "pull-request", "reference": "repo#42"},
        ),
        (
            {"kind": "session", "id": "session-1"},
            {"kind": "interactive-session", "reference": "session-1"},
        ),
    ],
)
def test_validation_rejects_non_pr_automation_and_non_user_live_owners(
    owner: dict[str, str], origin: dict[str, str]
) -> None:
    messages = validation_messages(
        preview_resource(spec={"owner": owner, "origin": origin})
    )

    assert any(
        "live app-live previews require spec.owner.kind=user or " in issue
        for issue in messages
    )


def test_validation_allows_automation_owner_for_reconciled_app_acceptance() -> None:
    value = validate_preview_environment(
        preview_resource(
            spec={
                "mode": "reconciled",
                "services": ["workflow-builder"],
                "images": {"workflow-builder": IMAGE_DIGEST},
                "owner": {"kind": "automation", "id": "acceptance-1"},
                "origin": {"kind": "pull-request", "reference": "123"},
            }
        )
    )

    assert value.owner_kind == "automation"


@pytest.mark.parametrize(
    ("field", "value", "expected"),
    [
        (
            "platformRepository",
            "attacker/stacks",
            "platformRepository must be PittampalliOrg/stacks",
        ),
        (
            "sourceRepository",
            "attacker/workflow-builder",
            "sourceRepository must be PittampalliOrg/workflow-builder",
        ),
    ],
)
def test_validation_rejects_untrusted_provenance_repositories(
    field: str, value: str, expected: str
) -> None:
    resource = preview_resource()
    resource["spec"]["provenance"][field] = value
    assert any(expected in issue for issue in validation_messages(resource))


def test_generated_catalog_digest_is_verified() -> None:
    document = json.loads(CATALOG_PATH.read_text(encoding="utf-8"))
    assert (
        parse_preview_service_catalog(document).catalog_digest
        == document["catalogDigest"]
    )

    document["services"][0]["capabilities"]["hotSync"] = True
    with pytest.raises(CatalogValidationError, match="digest does not match"):
        parse_preview_service_catalog(document)


def test_generated_catalog_requires_fail_closed_path_policy() -> None:
    document = json.loads(CATALOG_PATH.read_text(encoding="utf-8"))
    document["pathPolicy"]["unmatchedPathPolicy"] = "ignored"
    payload = dict(document)
    payload.pop("catalogDigest", None)
    canonical = json.dumps(
        payload,
        separators=(",", ":"),
        ensure_ascii=False,
        allow_nan=False,
    ).encode("utf-8")
    document["catalogDigest"] = f"sha256:{hashlib.sha256(canonical).hexdigest()}"

    with pytest.raises(CatalogValidationError, match="path policy is invalid"):
        parse_preview_service_catalog(document)


def test_request_catalog_digest_must_match_mounted_catalog() -> None:
    assert any(
        "does not match the mounted service catalog" in issue
        for issue in validation_messages(
            preview_resource(spec={"catalogDigest": f"sha256:{'f' * 64}"})
        )
    )


def test_validation_rejects_unknown_and_non_preview_native_live_services() -> None:
    unknown = preview_resource(spec={"services": ["unknown-service"], "images": {}})
    assert any(
        "not present in the service catalog" in issue
        for issue in validation_messages(unknown)
    )

    capabilities = dict(TEST_CATALOG.services)
    capabilities["workflow-orchestrator"] = PreviewServiceCapabilities(
        hot_sync=True,
        preview_native=False,
        acceptance_build=True,
        acceptance_replay=False,
        activation_build=False,
        acceptance_image="ghcr.io/pittampalliorg/workflow-orchestrator",
        activation_image=None,
        activation_pipeline=None,
        activation_status_context=None,
    )
    restricted = PreviewServiceCatalog(TEST_CATALOG.catalog_digest, capabilities)
    messages = validation_messages(
        preview_resource(spec={"images": {}}),
        catalog=restricted,
    )
    assert any(
        "is not hot-sync preview-native for app-live" in issue for issue in messages
    )


def test_reconciled_app_live_rejects_non_preview_native_catalog_service() -> None:
    messages = validation_messages(
        preview_resource(
            spec={
                "mode": "reconciled",
                "services": ["swebench-coordinator"],
                "images": {
                    "swebench-coordinator": (
                        "ghcr.io/pittampalliorg/swebench-coordinator@sha256:" + "d" * 64
                    )
                },
            }
        )
    )

    assert any(
        "swebench-coordinator has no immutable acceptance replay contract" in issue
        for issue in messages
    )


def test_reconciled_app_live_accepts_sea_without_hot_sync_capability() -> None:
    sea_digest = "ghcr.io/pittampalliorg/sandbox-execution-api@sha256:" + "e" * 64
    value = validate_preview_environment(
        preview_resource(
            spec={
                "mode": "reconciled",
                "services": ["sandbox-execution-api"],
                "images": {"sandbox-execution-api": sea_digest},
            }
        )
    )

    assert value.services == ("sandbox-execution-api",)
    assert value.images == (("sandbox-execution-api", sea_digest),)


def test_reconciled_app_live_rejects_image_repository_substitution() -> None:
    messages = validation_messages(
        preview_resource(
            spec={
                "mode": "reconciled",
                "services": ["sandbox-execution-api"],
                "images": {
                    "sandbox-execution-api": (
                        "ghcr.io/pittampalliorg/workflow-builder@sha256:" + "e" * 64
                    )
                },
            }
        )
    )

    assert any(
        "must use catalog repository ghcr.io/pittampalliorg/sandbox-execution-api"
        in issue
        for issue in messages
    )


def test_reconciled_app_live_requires_complete_acceptance_image_set() -> None:
    messages = validation_messages(
        preview_resource(
            spec={
                "mode": "reconciled",
                "allocation": {"kind": "cold"},
                "images": {"workflow-builder": IMAGE_DIGEST},
            }
        )
    )
    assert any(
        "requires one immutable image for every service: workflow-orchestrator" in issue
        for issue in messages
    )


@pytest.mark.parametrize(
    ("spec_patch", "metadata_patch", "message"),
    [
        ({"id": "other"}, None, "metadata.name must exactly equal spec.id"),
        ({"id": "Bad_Name"}, None, "spec.id must be a lowercase DNS label"),
        ({"profile": "host-candidate"}, None, "spec.profile must be"),
        ({"platformRevision": PLATFORM_SHA.upper()}, None, "platformRevision"),
        ({"sourceRevision": "main"}, None, "sourceRevision"),
        ({"trustedCode": False}, None, "trustedCode must be true"),
        ({"owner": " space"}, None, "spec.owner"),
        ({"services": ["workflow-builder", "workflow-builder"]}, None, "duplicates"),
        ({"services": ["UPPER"]}, None, "Kubernetes DNS label"),
        ({"ttlHours": 0}, None, "ttlHours"),
        ({"ttlHours": 169}, None, "ttlHours"),
        ({"expiresAt": "2026-07-10T12:00:00+00:00"}, None, "ending in Z"),
        ({"expiresAt": "2026-07-11T12:00:00Z"}, None, "exceeds spec.ttlHours"),
        ({}, {"namespace": "default"}, f"namespace must be {CONTROL_NAMESPACE}"),
        ({"arbitraryPatch": {}}, None, "unsupported fields: arbitraryPatch"),
        ({}, {"generation": True}, "generation must be a positive integer"),
    ],
)
def test_validation_rejects_invalid_boundary_fields(
    spec_patch: dict[str, Any],
    metadata_patch: dict[str, Any] | None,
    message: str,
) -> None:
    assert any(
        message in issue
        for issue in validation_messages(
            preview_resource(spec=spec_patch, metadata=metadata_patch)
        )
    )


@pytest.mark.parametrize(
    "name",
    [
        "pool-1",
        "pool-replacement",
        "mtxdev1",
        "mtxtmpl1",
        "preview6",
        "ganpilot",
        "ganvalidate",
        "test3",
    ],
)
def test_validation_rejects_legacy_retirement_subject_names(name: str) -> None:
    assert "spec.id is reserved for legacy preview retirement" in validation_messages(
        preview_resource(spec={"id": name}, metadata={"name": name})
    )


def test_validation_rejects_wrong_group_version_and_kind() -> None:
    resource = preview_resource()
    resource["apiVersion"] = "preview.stacks.io/v1"
    resource["kind"] = "SomethingElse"
    messages = validation_messages(resource)
    assert any("apiVersion must be" in message for message in messages)
    assert any("kind must be PreviewEnvironment" in message for message in messages)


def test_validation_bounds_provenance_shape_and_size() -> None:
    messages = validation_messages(
        preview_resource(
            spec={
                "provenance": {
                    "requestId": "request-1",
                    "requestedAt": "2026-07-09T12:00:00Z",
                    "platformRepository": "PittampalliOrg/stacks",
                    "sourceRepository": "PittampalliOrg/workflow-builder",
                    "tooLarge": "x" * 5000,
                }
            }
        )
    )
    assert any("4096 UTF-8 bytes" in issue for issue in messages)
    assert any("at most 512 chars" in issue for issue in messages)


@pytest.mark.parametrize(
    ("spec_patch", "message"),
    [
        (
            {
                "allocation": {
                    "kind": "warm",
                    "baselinePlatformRevision": PLATFORM_SHA,
                }
            },
            "exactly {kind: cold}",
        ),
        (
            {"allocation": {"kind": "cold", "baselinePlatformRevision": PLATFORM_SHA}},
            "unsupported fields",
        ),
        (
            {
                "profile": "manifest-candidate",
                "mode": "live",
                "services": [],
                "images": {},
            },
            "manifest-candidate requires",
        ),
        (
            {
                "profile": "manifest-candidate",
                "lane": "management",
            },
            "isolated operator adapter",
        ),
    ],
)
def test_validation_enforces_profile_mode_allocation_matrix(
    spec_patch: dict[str, Any], message: str
) -> None:
    assert any(
        message in issue
        for issue in validation_messages(preview_resource(spec=spec_patch))
    )


def test_validation_accepts_cold_manifest_candidate_without_images() -> None:
    value = validate_preview_environment(
        preview_resource(
            spec={
                "profile": "manifest-candidate",
                "mode": "reconciled",
                "services": [],
                "images": {},
                "allocation": {"kind": "cold"},
            }
        )
    )
    assert value.profile == "manifest-candidate"
    assert value.mode == "reconciled"
    assert value.images == ()


@pytest.mark.parametrize(
    ("images", "message"),
    [
        (
            {"workflow-builder": "ghcr.io/pittampalliorg/workflow-builder:latest"},
            "image@sha256 digest reference",
        ),
        (
            {"workflow-builder": f"docker.io/org/app@sha256:{'c' * 64}"},
            "ghcr.io image@sha256",
        ),
        (
            {"not-selected": f"ghcr.io/org/not-selected@sha256:{'c' * 64}"},
            "is not present in spec.services",
        ),
        (
            {"workflow-builder": f"ghcr.io/Org/App@sha256:{'C' * 64}"},
            "full lowercase",
        ),
    ],
)
def test_validation_rejects_mutable_or_unselected_images(
    images: dict[str, str], message: str
) -> None:
    assert any(
        message in issue
        for issue in validation_messages(preview_resource(spec={"images": images}))
    )


def test_manifests_are_constant_derived_owned_and_digest_pinned() -> None:
    environment = validate_preview_environment(preview_resource())
    namespace = build_namespace_manifest(environment)
    app_project = build_app_project_manifest(environment)
    application = build_application_manifest(environment)

    assert namespace["metadata"]["name"] == "preview-feature-x"
    assert all(
        namespace["metadata"]["labels"].get(key) == value
        for key, value in application["metadata"]["labels"].items()
    )
    assert app_project["metadata"]["name"] == "default"
    assert app_project["metadata"]["namespace"] == "preview-feature-x"
    assert app_project["metadata"]["labels"] == application["metadata"]["labels"]
    assert app_project["spec"] == {
        "description": "Default project for preview environment feature-x",
        "sourceRepos": ["*"],
        "destinations": [{"server": "*", "namespace": "*"}],
        "clusterResourceWhitelist": [{"group": "*", "kind": "*"}],
        "namespaceResourceWhitelist": [{"group": "*", "kind": "*"}],
    }
    assert {
        key: namespace["metadata"]["labels"][key]
        for key in (
            "preview.stacks.io/managed",
            "preview.stacks.io/preview-name",
            "preview.stacks.io/agent-name",
        )
    } == {
        "preview.stacks.io/managed": "true",
        "preview.stacks.io/preview-name": "feature-x",
        "preview.stacks.io/agent-name": "preview-feature-x",
    }
    assert (
        namespace["metadata"]["annotations"][
            "preview.stacks.io/preview-environment-uid"
        ]
        == environment.uid
    )
    assert namespace["metadata"]["labels"][MANAGED_BY_LABEL] == MANAGED_BY_VALUE
    assert namespace["metadata"]["labels"][ENVIRONMENT_UID_LABEL] == environment.uid
    assert namespace["metadata"]["labels"][MODE_LABEL] == "live"
    assert namespace["metadata"]["labels"][ALLOCATION_LABEL] == "cold"
    assert namespace["metadata"]["labels"][LANE_LABEL] == "application"
    assert len(namespace["metadata"]["labels"][IMAGES_HASH_LABEL]) == 16
    assert (
        namespace["metadata"]["annotations"]["preview.stacks.io/catalog-digest"]
        == TEST_CATALOG.catalog_digest
    )

    source = application["spec"]["source"]
    assert source == {
        "repoURL": "https://github.com/PittampalliOrg/stacks.git",
        "path": "packages/components/workloads/workflow-builder-preview-vcluster/app-overlay",
        "targetRevision": PLATFORM_SHA,
        "kustomize": {
            "patches": source["kustomize"]["patches"],
            "images": [f"workflow-builder={IMAGE_DIGEST}"],
        },
    }
    assert application["spec"]["destination"] == {
        "name": "preview-feature-x",
        "namespace": "workflow-builder",
    }
    ignores = application["spec"]["ignoreDifferences"]
    assert [entry["name"] for entry in ignores] == [
        "workflow-builder",
        "workflow-orchestrator",
    ]
    assert all(entry["jsonPointers"] == ["/spec/replicas"] for entry in ignores)
    options = application["spec"]["syncPolicy"]["syncOptions"]
    assert "RespectIgnoreDifferences=true" in options
    assert not any("ServerSideApply" in option for option in options)
    assert application["spec"]["syncPolicy"]["automated"] == {
        "prune": True,
        "selfHeal": True,
    }
    patches = {
        patch["target"]["name"]: patch["patch"]
        for patch in source["kustomize"]["patches"]
    }
    all_patches = "\n".join(patches.values())
    assert "WORKSPACE_RUNTIME_URL" not in all_patches
    assert "tlsTerminator" not in all_patches
    for deployment in ("workflow-builder", "sandbox-execution-api"):
        runtime_patch = patches[deployment]
        for name, value in (
            ("PREVIEW_ENVIRONMENT_ID", "feature-x"),
            ("PREVIEW_ENVIRONMENT_PROFILE", "app-live"),
            ("PREVIEW_ENVIRONMENT_LANE", "application"),
            ("PREVIEW_PLATFORM_REVISION", PLATFORM_SHA),
            ("PREVIEW_SOURCE_REVISION", SOURCE_SHA),
            ("DEV_PREVIEW_CATALOG_DIGEST", TEST_CATALOG.catalog_digest),
        ):
            assert f'- name: {name}\n              value: "{value}"' in runtime_patch

    workflow_builder_patch = patches["workflow-builder"]
    sandbox_execution_api_patch = patches["sandbox-execution-api"]
    canonical_identity_names = (
        "PREVIEW_ENVIRONMENT_NAME",
        "PREVIEW_ENVIRONMENT_REQUEST_ID",
        "PREVIEW_ENVIRONMENT_PLATFORM_REVISION",
        "PREVIEW_ENVIRONMENT_SOURCE_REVISION",
        "PREVIEW_ENVIRONMENT_CATALOG_DIGEST",
        "PREVIEW_ENVIRONMENT_SERVICES_JSON",
    )
    for name in canonical_identity_names:
        assert f"- name: {name}\n" not in workflow_builder_patch
        assert f"- name: {name}\n" in sandbox_execution_api_patch
    assert "valueFrom: null" not in workflow_builder_patch
    assert (
        '- name: PREVIEW_HOST_RUNTIMES_DISABLED\n              value: "true"'
        in workflow_builder_patch
    )
    assert (
        '- name: AGENT_RUNTIME_SHARED_POOLS_ENABLED\n              value: "false"'
        in workflow_builder_patch
    )


def test_manifest_candidate_application_uses_the_mounted_executable_path() -> None:
    app_live = validate_preview_environment(preview_resource())
    manifest_candidate = validate_preview_environment(
        preview_resource(
            spec={
                "profile": "manifest-candidate",
                "mode": "reconciled",
                "services": [],
                "images": {},
                "candidatePaths": [
                    "packages/components/workloads/workflow-builder/manifests/deployment.yaml"
                ],
                "allocation": {"kind": "cold"},
            }
        )
    )

    assert (
        build_application_manifest(app_live)["spec"]["source"]["path"]
        == "packages/components/workloads/workflow-builder-preview-vcluster/app-overlay"
    )
    assert (
        build_application_manifest(manifest_candidate, candidate_surface=TEST_SURFACE)[
            "spec"
        ]["source"]["path"]
        == TEST_SURFACE.application_path
    )
    with pytest.raises(CatalogValidationError, match="surface contract is required"):
        build_application_manifest(manifest_candidate)


def test_manifest_candidate_rejects_more_than_crd_path_bound() -> None:
    messages = validation_messages(
        preview_resource(
            spec={
                "profile": "manifest-candidate",
                "mode": "reconciled",
                "services": [],
                "images": {},
                "candidatePaths": [
                    f"packages/components/workloads/workflow-builder/manifests/{index}.yaml"
                    for index in range(65)
                ],
                "allocation": {"kind": "cold"},
            }
        )
    )
    assert any("at most 64 paths" in issue for issue in messages)


@pytest.mark.parametrize(
    ("field", "value", "message"),
    [
        ("profile", "app-live", "header"),
        ("applicationPath", "packages/attacker", "applicationPath"),
        ("bootstrapPath", "packages/attacker", "bootstrapPath"),
    ],
)
def test_manifest_candidate_surface_rejects_malformed_execution_paths(
    field: str, value: str, message: str
) -> None:
    document = {
        "schemaVersion": 1,
        "profile": "manifest-candidate",
        "applicationPath": TEST_SURFACE.application_path,
        "bootstrapPath": TEST_SURFACE.bootstrap_path,
        "allowedSurfaces": [
            {
                "pathPrefix": "packages/components/workloads/workflow-builder/manifests/",
                "renderer": "application",
            }
        ],
        "routeRules": [],
    }
    document[field] = value

    with pytest.raises(CatalogValidationError, match=message):
        parse_manifest_candidate_surface(document)


def test_manifest_candidate_surface_uses_profile_plus_lane_route_contract() -> None:
    document = {
        "schemaVersion": 1,
        "profile": "manifest-candidate",
        "applicationPath": TEST_SURFACE.application_path,
        "bootstrapPath": TEST_SURFACE.bootstrap_path,
        "allowedSurfaces": [
            {
                "pathPrefix": "packages/components/workloads/",
                "renderer": "application",
            }
        ],
        "routeRules": [
            {
                "pathPrefix": "packages/components/hub-management/",
                "profile": "manifest-candidate",
                "lane": "management",
                "reason": "hub management",
            },
            {
                "pathPrefix": "deployment/",
                "profile": "host-candidate",
                "lane": "application",
                "reason": "physical host",
            },
        ],
    }

    parsed = parse_manifest_candidate_surface(document)
    assert parsed.route_rules == (
        (
            "packages/components/hub-management/",
            "manifest-candidate",
            "management",
            "hub management",
        ),
        ("deployment/", "host-candidate", "application", "physical host"),
    )


@pytest.mark.parametrize("profile", ["app-live", "manifest-candidate"])
def test_reconciled_manifests_never_delegate_replicas(profile: str) -> None:
    services = ["workflow-builder"] if profile == "app-live" else []
    images = {"workflow-builder": IMAGE_DIGEST} if services else {}
    environment = validate_preview_environment(
        preview_resource(
            spec={
                "profile": profile,
                "mode": "reconciled",
                "services": services,
                "images": images,
                "allocation": {"kind": "cold"},
            }
        )
    )
    application = build_application_manifest(
        environment,
        candidate_surface=TEST_SURFACE if profile == "manifest-candidate" else None,
    )
    assert "ignoreDifferences" not in application["spec"]
    assert (
        "RespectIgnoreDifferences=true"
        not in application["spec"]["syncPolicy"]["syncOptions"]
    )


def test_application_readiness_requires_both_sync_and_health() -> None:
    environment = validate_preview_environment(preview_resource())
    application = build_application_manifest(environment, reconcile_requested_at=NOW)
    application["status"] = {
        "sync": {"status": "Synced", "revision": PLATFORM_SHA},
        "health": {"status": "Healthy"},
        "reconciledAt": "2026-07-09T12:00:01Z",
    }
    assert application_is_ready(application, environment)
    application["status"]["sync"]["status"] = "OutOfSync"
    assert not application_is_ready(application, environment)
    assert not application_is_ready({}, environment)


def test_application_readiness_rejects_stale_revision_generation_and_reconcile_time() -> (
    None
):
    environment = validate_preview_environment(preview_resource())
    application = build_application_manifest(environment, reconcile_requested_at=NOW)
    application["status"] = {
        "sync": {"status": "Synced", "revision": SOURCE_SHA},
        "health": {"status": "Healthy"},
        "reconciledAt": "2026-07-09T12:00:01Z",
    }
    assert not application_is_ready(application, environment)

    application["status"]["sync"]["revision"] = PLATFORM_SHA
    application["metadata"]["annotations"][CONTRACT_GENERATION_ANNOTATION] = "2"
    assert not application_is_ready(application, environment)

    application["metadata"]["annotations"][CONTRACT_GENERATION_ANNOTATION] = "3"
    application["status"]["reconciledAt"] = "2026-07-09T11:59:59Z"
    assert not application_is_ready(application, environment)


def test_status_preserves_transition_time_until_condition_changes() -> None:
    resource = preview_resource()
    first = build_status(
        resource,
        phase="Provisioning",
        valid=True,
        ready=False,
        reason="WaitingForApplication",
        message="waiting",
        now=NOW,
    )
    resource["status"] = first
    second = build_status(
        resource,
        phase="Provisioning",
        valid=True,
        ready=False,
        reason="WaitingForApplication",
        message="waiting",
        now=datetime(2026, 7, 9, 13, tzinfo=UTC),
    )
    assert second["conditions"] == first["conditions"]
    assert second["observedGeneration"] == 3


def test_ownership_requires_controller_label_id_and_uid() -> None:
    owned = build_namespace_manifest(validate_preview_environment(preview_resource()))
    assert_owned(
        owned,
        environment_id="feature-x",
        environment_uid="12345678-1234-1234-1234-123456789abc",
    )
    for labels in (
        {},
        {MANAGED_BY_LABEL: MANAGED_BY_VALUE},
        {
            MANAGED_BY_LABEL: MANAGED_BY_VALUE,
            "preview.stacks.io/id": "feature-x",
            ENVIRONMENT_UID_LABEL: "different",
        },
    ):
        with pytest.raises(OwnershipConflict):
            assert_owned(
                {"metadata": {"labels": labels}},
                environment_id="feature-x",
                environment_uid="12345678-1234-1234-1234-123456789abc",
            )


def _not_found() -> ApiException:
    return ApiException(status=404, reason="Not Found")


class FakeCoreApi:
    def __init__(self) -> None:
        self.namespace: dict[str, Any] | None = None
        self.calls: list[tuple[str, str]] = []

    def read_namespace(self, *, name: str) -> dict[str, Any]:
        self.calls.append(("read", name))
        if self.namespace is None:
            raise _not_found()
        return copy.deepcopy(self.namespace)

    def create_namespace(self, *, body: dict[str, Any]) -> dict[str, Any]:
        self.calls.append(("create", body["metadata"]["name"]))
        self.namespace = copy.deepcopy(body)
        return copy.deepcopy(body)

    def patch_namespace(self, *, name: str, body: dict[str, Any]) -> dict[str, Any]:
        self.calls.append(("patch", name))
        assert self.namespace is not None
        self.namespace["metadata"].update(copy.deepcopy(body["metadata"]))
        return copy.deepcopy(self.namespace)

    def delete_namespace(self, *, name: str, body: Any) -> None:
        del body
        self.calls.append(("delete", name))
        self.namespace = None


class FakeCustomApi:
    def __init__(self, resource: dict[str, Any]) -> None:
        self.resource = copy.deepcopy(resource)
        self.application: dict[str, Any] | None = None
        self.app_project: dict[str, Any] | None = None
        self.calls: list[tuple[str, str, str]] = []
        self.deleted_preview = False
        self.list_namespace: str | None = None
        self.application_delete_requires_no_finalizers = False

    def get_namespaced_custom_object(self, **kwargs: Any) -> dict[str, Any]:
        self.calls.append(("get", kwargs["plural"], kwargs["name"]))
        if kwargs["plural"] == ARGO_APPLICATIONS_PLURAL:
            if self.application is None:
                raise _not_found()
            return copy.deepcopy(self.application)
        if kwargs["plural"] == ARGO_PROJECTS_PLURAL:
            if self.app_project is None:
                raise _not_found()
            return copy.deepcopy(self.app_project)
        if kwargs["plural"] != API_PLURAL:
            raise _not_found()
        return copy.deepcopy(self.resource)

    def create_namespaced_custom_object(self, **kwargs: Any) -> dict[str, Any]:
        self.calls.append(
            ("create", kwargs["plural"], kwargs["body"]["metadata"]["name"])
        )
        if kwargs["plural"] == ARGO_APPLICATIONS_PLURAL:
            self.application = copy.deepcopy(kwargs["body"])
            return copy.deepcopy(self.application)
        if kwargs["plural"] == ARGO_PROJECTS_PLURAL:
            self.app_project = copy.deepcopy(kwargs["body"])
            return copy.deepcopy(self.app_project)
        raise _not_found()

    def patch_namespaced_custom_object(self, **kwargs: Any) -> dict[str, Any]:
        self.calls.append(("patch", kwargs["plural"], kwargs["name"]))
        body = kwargs["body"]
        if kwargs["plural"] == API_PLURAL:
            self.resource.setdefault("metadata", {}).update(
                copy.deepcopy(body["metadata"])
            )
            return copy.deepcopy(self.resource)
        if kwargs["plural"] == ARGO_APPLICATIONS_PLURAL:
            assert self.application is not None
            self.application["metadata"].update(copy.deepcopy(body["metadata"]))
            if "spec" in body:
                self.application["spec"] = copy.deepcopy(body["spec"])
            return copy.deepcopy(self.application)
        if kwargs["plural"] == ARGO_PROJECTS_PLURAL:
            assert self.app_project is not None
            self.app_project["metadata"].update(copy.deepcopy(body["metadata"]))
            if "spec" in body:
                self.app_project["spec"] = copy.deepcopy(body["spec"])
            return copy.deepcopy(self.app_project)
        raise _not_found()

    def patch_namespaced_custom_object_status(self, **kwargs: Any) -> dict[str, Any]:
        self.calls.append(("status", kwargs["plural"], kwargs["name"]))
        self.resource["status"] = copy.deepcopy(kwargs["body"]["status"])
        return copy.deepcopy(self.resource)

    def delete_namespaced_custom_object(self, **kwargs: Any) -> None:
        self.calls.append(("delete", kwargs["plural"], kwargs["name"]))
        if kwargs["plural"] == ARGO_APPLICATIONS_PLURAL:
            if (
                self.application_delete_requires_no_finalizers
                and self.application is not None
                and self.application.get("metadata", {}).get("finalizers")
            ):
                return
            self.application = None
        else:
            self.deleted_preview = True

    def list_namespaced_custom_object(self, **kwargs: Any) -> dict[str, Any]:
        self.list_namespace = kwargs["namespace"]
        return {
            "metadata": {"resourceVersion": "42"},
            "items": [copy.deepcopy(self.resource)],
        }


def controller_pair(
    resource: dict[str, Any],
    *,
    now: datetime = NOW,
    registration_adapter: Any | None = None,
    dashboard_cleanup_adapter: Any | None = None,
) -> tuple[PreviewEnvironmentController, FakeCoreApi, FakeCustomApi]:
    core = FakeCoreApi()
    custom = FakeCustomApi(resource)
    controller = PreviewEnvironmentController(
        core_api=core,
        custom_api=custom,
        catalog=TEST_CATALOG,
        registration_adapter=registration_adapter,
        dashboard_cleanup_adapter=dashboard_cleanup_adapter,
        now=lambda: now,
        full_resync_seconds=10,
    )
    return controller, core, custom


class FakeRegistrationAdapter:
    def __init__(self) -> None:
        self.status = PreviewAgentRegistrationStatus(
            agent_name="preview-feature-x",
            ready=False,
            reason="WaitingForCertificate",
        )
        self.ensure_calls: list[Any] = []
        self.cleanup_calls: list[tuple[str, str]] = []
        self.cleanup_result = False
        self.ensure_error: Exception | None = None
        self.cleanup_error: Exception | None = None

    def ensure(self, environment: Any) -> PreviewAgentRegistrationStatus:
        self.ensure_calls.append(environment)
        if self.ensure_error is not None:
            raise self.ensure_error
        return self.status

    def cleanup(self, *, preview_id: str, environment_uid: str) -> bool:
        self.cleanup_calls.append((preview_id, environment_uid))
        if self.cleanup_error is not None:
            raise self.cleanup_error
        return self.cleanup_result


class FakeDashboardCleanupAdapter:
    def __init__(self) -> None:
        self.cleanup_calls: list[tuple[str, str]] = []
        self.cleanup_result = False
        self.cleanup_error: Exception | None = None

    def cleanup(self, *, preview_id: str, environment_uid: str) -> bool:
        self.cleanup_calls.append((preview_id, environment_uid))
        if self.cleanup_error is not None:
            raise self.cleanup_error
        return self.cleanup_result


def acknowledge_physical_cleanup(resource: dict[str, Any]) -> None:
    intent = build_deletion_intent(resource)
    resource.setdefault("status", {})[DELETION_INTENT_STATUS_FIELD] = intent
    resource["status"][DELETION_ACK_STATUS_FIELD] = {
        "intentId": intent["id"],
        "environmentUid": intent["environmentUid"],
        "requestId": intent["requestId"],
        "platformRevision": intent["platformRevision"],
        "sourceRevision": intent["sourceRevision"],
        "catalogDigest": intent["catalogDigest"],
        "observedAt": "2026-07-09T12:01:00Z",
        "resourceName": intent["name"],
        "runner": {
            "jobName": f"vcpreview-down-{intent['name']}",
            "jobUid": "87654321-4321-4321-4321-cba987654321",
            "generation": f"op:{'c' * 32}",
        },
        "checks": {name: True for name in PHYSICAL_CLEANUP_CHECKS},
    }


def test_reconcile_adds_finalizer_then_creates_resources_and_reports_ready() -> None:
    controller, core, custom = controller_pair(preview_resource())

    controller.reconcile(custom.resource)
    assert custom.resource["metadata"]["finalizers"] == [FINALIZER]
    assert core.namespace is None

    controller.reconcile(custom.resource)
    assert core.namespace is not None
    assert custom.app_project is not None
    assert custom.app_project["metadata"]["namespace"] == "preview-feature-x"
    assert custom.application is not None
    assert custom.resource["status"]["phase"] == "Provisioning"
    assert (
        custom.application["metadata"]["annotations"][RECONCILE_REQUESTED_AT_ANNOTATION]
        == "2026-07-09T12:00:00.000000Z"
    )

    custom.application["status"] = {
        "sync": {"status": "Synced", "revision": PLATFORM_SHA},
        "health": {"status": "Healthy"},
        "reconciledAt": "2026-07-09T12:00:01Z",
    }
    controller.reconcile(custom.resource)
    assert custom.resource["status"]["phase"] == "Ready"
    assert custom.resource["status"]["observedGeneration"] == 3
    assert custom.resource["status"]["mode"] == "live"
    assert custom.resource["status"]["images"] == {"workflow-builder": IMAGE_DIGEST}
    assert custom.resource["status"]["catalogDigest"] == TEST_CATALOG.catalog_digest
    assert custom.resource["status"]["allocation"] == {"kind": "cold"}
    assert custom.resource["status"]["namespace"] == "preview-feature-x"
    assert custom.resource["status"]["application"] == {
        "name": "preview-feature-x-workflow-builder",
        "namespace": "preview-feature-x",
        "syncStatus": "Synced",
        "healthStatus": "Healthy",
        "revision": PLATFORM_SHA,
        "reconciledAt": "2026-07-09T12:00:01Z",
        "contractGeneration": "3",
    }
    conditions = {
        item["type"]: item for item in custom.resource["status"]["conditions"]
    }
    assert conditions["Valid"]["status"] == "True"
    assert conditions["Ready"]["status"] == "True"


def test_registration_finalizer_blocks_workload_until_agent_mapping_is_ready() -> None:
    registration = FakeRegistrationAdapter()
    controller, core, custom = controller_pair(
        preview_resource(), registration_adapter=registration
    )

    controller.reconcile(custom.resource)
    assert custom.resource["metadata"]["finalizers"] == [
        FINALIZER,
        REGISTRATION_FINALIZER,
    ]

    controller.reconcile(custom.resource)
    assert core.namespace is None
    assert custom.application is None
    assert custom.resource["status"]["phase"] == "Provisioning"
    assert custom.resource["status"]["agentRegistration"] == {
        "agentName": "preview-feature-x",
        "ready": False,
        "reason": "WaitingForCertificate",
        "certificateNotAfter": None,
        "transport": "one-shot",
    }

    registration.status = PreviewAgentRegistrationStatus(
        agent_name="preview-feature-x",
        ready=True,
        reason="Registered",
        certificate_not_after=datetime(2026, 7, 18, 12, tzinfo=UTC),
    )
    controller.reconcile(custom.resource)

    assert core.namespace is not None
    assert custom.application is not None
    assert custom.resource["status"]["agentRegistration"]["ready"] is True
    assert custom.resource["status"]["agentRegistration"]["transport"] == "one-shot"


def test_dashboard_finalizer_is_persisted_before_child_resources_are_created() -> None:
    dashboard = FakeDashboardCleanupAdapter()
    controller, core, custom = controller_pair(
        preview_resource(), dashboard_cleanup_adapter=dashboard
    )

    controller.reconcile(custom.resource)

    assert custom.resource["metadata"]["finalizers"] == [
        FINALIZER,
        DASHBOARD_REGISTRATION_FINALIZER,
    ]
    assert core.namespace is None
    assert custom.application is None

    controller.reconcile(custom.resource)
    assert core.namespace is not None
    assert custom.application is not None


def test_registration_ownership_conflict_blocks_without_creating_workload() -> None:
    registration = FakeRegistrationAdapter()
    registration.ensure_error = PreviewAgentRegistrationOwnershipError(
        "mapping belongs to another PreviewEnvironment"
    )
    resource = preview_resource(
        metadata={"finalizers": [FINALIZER, REGISTRATION_FINALIZER]}
    )
    controller, core, custom = controller_pair(
        resource, registration_adapter=registration
    )

    controller.reconcile(custom.resource)

    assert core.namespace is None
    assert custom.application is None
    assert custom.resource["status"]["phase"] == "Blocked"
    assert custom.resource["status"]["conditions"][1]["reason"] == (
        "AgentRegistrationOwnershipConflict"
    )


def test_invalid_resource_only_updates_failed_status() -> None:
    resource = preview_resource(spec={"trustedCode": False})
    controller, core, custom = controller_pair(resource)
    controller.reconcile(custom.resource)

    assert core.namespace is None
    assert custom.application is None
    assert custom.resource["status"]["phase"] == "Failed"
    assert custom.resource["status"]["conditions"][0]["reason"] == "InvalidSpec"


def test_reconcile_refuses_to_adopt_unmanaged_namespace() -> None:
    resource = preview_resource(metadata={"finalizers": [FINALIZER]})
    controller, core, custom = controller_pair(resource)
    core.namespace = {"metadata": {"name": "preview-feature-x", "labels": {}}}

    controller.reconcile(custom.resource)

    assert custom.application is None
    assert custom.resource["status"]["phase"] == "Blocked"
    assert custom.resource["status"]["conditions"][1]["reason"] == "OwnershipConflict"
    assert ("patch", "preview-feature-x") not in core.calls


def test_reconcile_refreshes_application_missing_freshness_marker() -> None:
    resource = preview_resource(metadata={"finalizers": [FINALIZER]})
    controller, core, custom = controller_pair(resource)
    environment = validate_preview_environment(custom.resource)
    core.namespace = build_namespace_manifest(environment)
    custom.application = build_application_manifest(environment)
    assert (
        RECONCILE_REQUESTED_AT_ANNOTATION
        not in custom.application["metadata"]["annotations"]
    )

    controller.reconcile(custom.resource)

    assert (
        custom.application["metadata"]["annotations"][RECONCILE_REQUESTED_AT_ANNOTATION]
        == "2026-07-09T12:00:00.000000Z"
    )
    assert (
        "patch",
        ARGO_APPLICATIONS_PLURAL,
        environment.application_name,
    ) in custom.calls
    assert custom.resource["status"]["phase"] == "Provisioning"


def test_expiry_marks_status_without_bypassing_archive_aware_reaper() -> None:
    resource = preview_resource(
        metadata={"finalizers": [FINALIZER]},
    )
    controller, core, custom = controller_pair(
        resource, now=datetime(2026, 7, 10, 12, 0, 1, tzinfo=UTC)
    )
    environment = validate_preview_environment(custom.resource)
    core.namespace = build_namespace_manifest(environment)
    custom.application = build_application_manifest(environment)

    controller.reconcile(custom.resource)
    assert not custom.deleted_preview
    assert custom.application is not None
    assert core.namespace is not None
    assert custom.resource["status"]["phase"] == "Expired"
    assert FINALIZER in custom.resource["metadata"]["finalizers"]
    assert not any(
        call[0] == "delete" and call[1] == API_PLURAL for call in custom.calls
    )
    assert not any(
        call[0] == "delete" and call[1] == ARGO_APPLICATIONS_PLURAL
        for call in custom.calls
    )
    assert ("delete", "preview-feature-x") not in core.calls


def test_agent_registration_cleanup_runs_after_application_and_namespace() -> None:
    registration = FakeRegistrationAdapter()
    resource = preview_resource(
        metadata={
            "finalizers": [FINALIZER, REGISTRATION_FINALIZER],
            "deletionTimestamp": "2026-07-09T12:00:00Z",
        }
    )
    controller, core, custom = controller_pair(
        resource, registration_adapter=registration
    )
    environment = validate_preview_environment(custom.resource)
    core.namespace = build_namespace_manifest(environment)
    custom.application = build_application_manifest(environment)

    # Direct/admin DELETE first creates a durable outbox intent. Hub resources
    # remain present until a dev-side SEA proof is acknowledged.
    controller.reconcile(custom.resource)
    assert custom.application is not None
    assert core.namespace is not None
    assert custom.resource["status"][DELETION_INTENT_STATUS_FIELD] == (
        build_deletion_intent(custom.resource)
    )
    controller.reconcile(custom.resource)
    assert custom.application is not None
    assert core.namespace is not None
    assert custom.resource["status"]["conditions"][1]["reason"] == (
        "WaitingForPhysicalCleanup"
    )

    acknowledge_physical_cleanup(custom.resource)
    controller.reconcile(custom.resource)
    assert custom.application is None
    assert core.namespace is not None
    assert registration.cleanup_calls == []

    controller.reconcile(custom.resource)
    assert core.namespace is None
    assert registration.cleanup_calls == []

    controller.reconcile(custom.resource)
    assert FINALIZER in custom.resource["metadata"]["finalizers"]
    assert REGISTRATION_FINALIZER in custom.resource["metadata"]["finalizers"]
    assert registration.cleanup_calls == [("feature-x", environment.uid)]
    assert custom.resource["status"]["conditions"][1]["reason"] == (
        "DeletingAgentRegistration"
    )

    registration.cleanup_result = True
    controller.reconcile(custom.resource)
    assert REGISTRATION_FINALIZER not in custom.resource["metadata"]["finalizers"]
    assert FINALIZER in custom.resource["metadata"]["finalizers"]

    controller.reconcile(custom.resource)
    assert FINALIZER not in custom.resource["metadata"]["finalizers"]


def test_dashboard_and_agent_cleanup_finalizers_are_released_independently() -> None:
    dashboard = FakeDashboardCleanupAdapter()
    registration = FakeRegistrationAdapter()
    resource = preview_resource(
        metadata={
            "finalizers": [
                FINALIZER,
                REGISTRATION_FINALIZER,
                DASHBOARD_REGISTRATION_FINALIZER,
            ],
            "deletionTimestamp": "2026-07-09T12:00:00Z",
        }
    )
    acknowledge_physical_cleanup(resource)
    controller, _core, custom = controller_pair(
        resource,
        registration_adapter=registration,
        dashboard_cleanup_adapter=dashboard,
    )

    controller.reconcile(custom.resource)
    assert dashboard.cleanup_calls == [
        ("feature-x", "12345678-1234-1234-1234-123456789abc")
    ]
    assert registration.cleanup_calls == []
    assert custom.resource["status"]["conditions"][1]["reason"] == (
        "DeletingHeadlampRegistration"
    )
    assert DASHBOARD_REGISTRATION_FINALIZER in custom.resource["metadata"]["finalizers"]

    dashboard.cleanup_result = True
    controller.reconcile(custom.resource)
    assert (
        DASHBOARD_REGISTRATION_FINALIZER
        not in custom.resource["metadata"]["finalizers"]
    )
    assert REGISTRATION_FINALIZER in custom.resource["metadata"]["finalizers"]
    assert registration.cleanup_calls == []

    controller.reconcile(custom.resource)
    assert registration.cleanup_calls == [
        ("feature-x", "12345678-1234-1234-1234-123456789abc")
    ]
    assert REGISTRATION_FINALIZER in custom.resource["metadata"]["finalizers"]

    registration.cleanup_result = True
    controller.reconcile(custom.resource)
    assert REGISTRATION_FINALIZER not in custom.resource["metadata"]["finalizers"]
    assert FINALIZER in custom.resource["metadata"]["finalizers"]

    controller.reconcile(custom.resource)
    assert FINALIZER not in custom.resource["metadata"]["finalizers"]


def test_dashboard_cleanup_ownership_error_blocks_and_retains_finalizer() -> None:
    dashboard = FakeDashboardCleanupAdapter()
    dashboard.cleanup_error = PreviewDashboardCleanupOwnershipError(
        "dashboard resource belongs to another PreviewEnvironment"
    )
    resource = preview_resource(
        metadata={
            "finalizers": [DASHBOARD_REGISTRATION_FINALIZER],
            "deletionTimestamp": "2026-07-09T12:00:00Z",
        }
    )
    controller, _core, custom = controller_pair(
        resource, dashboard_cleanup_adapter=dashboard
    )

    controller.reconcile(custom.resource)

    assert custom.resource["status"]["phase"] == "Blocked"
    assert custom.resource["status"]["conditions"][1]["reason"] == ("OwnershipConflict")
    assert DASHBOARD_REGISTRATION_FINALIZER in custom.resource["metadata"]["finalizers"]


def test_dashboard_cleanup_api_failure_propagates_and_retains_finalizer() -> None:
    dashboard = FakeDashboardCleanupAdapter()
    dashboard.cleanup_error = ApiException(status=500, reason="query failed")
    resource = preview_resource(
        metadata={
            "finalizers": [DASHBOARD_REGISTRATION_FINALIZER],
            "deletionTimestamp": "2026-07-09T12:00:00Z",
        }
    )
    controller, _core, custom = controller_pair(
        resource, dashboard_cleanup_adapter=dashboard
    )

    with pytest.raises(ApiException):
        controller.reconcile(custom.resource)

    assert DASHBOARD_REGISTRATION_FINALIZER in custom.resource["metadata"]["finalizers"]


def test_agent_registration_query_error_keeps_finalizer() -> None:
    registration = FakeRegistrationAdapter()
    registration.cleanup_error = ApiException(
        status=500, reason="registration query failed"
    )
    resource = preview_resource(
        metadata={
            "finalizers": [REGISTRATION_FINALIZER],
            "deletionTimestamp": "2026-07-09T12:00:00Z",
        }
    )
    controller, _core, custom = controller_pair(
        resource, registration_adapter=registration
    )

    with pytest.raises(ApiException):
        controller.reconcile(custom.resource)

    assert REGISTRATION_FINALIZER in custom.resource["metadata"]["finalizers"]


def test_future_cleanup_ack_cannot_release_or_delete_hub_resources() -> None:
    resource = preview_resource(
        metadata={
            "finalizers": [FINALIZER],
            "deletionTimestamp": "2026-07-09T12:00:00Z",
        }
    )
    controller, core, custom = controller_pair(resource, now=NOW)
    environment = validate_preview_environment(custom.resource)
    core.namespace = build_namespace_manifest(environment)
    custom.application = build_application_manifest(environment)
    acknowledge_physical_cleanup(custom.resource)
    custom.resource["status"][DELETION_ACK_STATUS_FIELD]["observedAt"] = (
        "2026-07-10T12:00:00Z"
    )

    controller.reconcile(custom.resource)

    assert custom.application is not None
    assert core.namespace is not None
    assert FINALIZER in custom.resource["metadata"]["finalizers"]
    assert custom.resource["status"]["conditions"][1]["reason"] == (
        "WaitingForPhysicalCleanup"
    )


@pytest.mark.parametrize(
    ("field", "replacement"),
    [
        ("platformRevision", "d" * 40),
        ("catalogDigest", f"sha256:{'e' * 64}"),
    ],
)
def test_cleanup_ack_with_different_budget_identity_keeps_finalizer(
    field: str, replacement: str
) -> None:
    resource = preview_resource(
        metadata={
            "finalizers": [FINALIZER],
            "deletionTimestamp": "2026-07-09T12:00:00Z",
        }
    )
    controller, core, custom = controller_pair(resource, now=NOW)
    environment = validate_preview_environment(custom.resource)
    core.namespace = build_namespace_manifest(environment)
    custom.application = build_application_manifest(environment)
    acknowledge_physical_cleanup(custom.resource)
    custom.resource["status"][DELETION_ACK_STATUS_FIELD][field] = replacement

    controller.reconcile(custom.resource)

    assert custom.application is not None
    assert core.namespace is not None
    assert FINALIZER in custom.resource["metadata"]["finalizers"]
    assert custom.resource["status"]["conditions"][1]["reason"] == (
        "WaitingForPhysicalCleanup"
    )


def test_deletion_refuses_unowned_application_and_keeps_finalizer() -> None:
    resource = preview_resource(
        metadata={
            "finalizers": [FINALIZER],
            "deletionTimestamp": "2026-07-09T12:00:00Z",
        }
    )
    controller, _core, custom = controller_pair(resource)
    acknowledge_physical_cleanup(custom.resource)
    custom.application = {
        "metadata": {
            "name": "preview-feature-x-workflow-builder",
            "namespace": "preview-feature-x",
            "labels": {},
        }
    }

    controller.reconcile(custom.resource)

    assert custom.application is not None
    assert FINALIZER in custom.resource["metadata"]["finalizers"]
    assert custom.resource["status"]["phase"] == "Blocked"


def test_deletion_strips_argo_finalizer_when_preview_agent_is_unavailable() -> None:
    resource = preview_resource(
        metadata={
            "finalizers": [FINALIZER],
            "deletionTimestamp": "2026-07-09T12:00:00Z",
        }
    )
    controller, core, custom = controller_pair(resource)
    environment = validate_preview_environment(custom.resource)
    acknowledge_physical_cleanup(custom.resource)
    custom.application = build_application_manifest(environment)
    core.namespace = build_namespace_manifest(environment)
    custom.application_delete_requires_no_finalizers = True

    controller.reconcile(custom.resource)

    assert custom.application is None
    assert core.namespace is not None
    application_calls = [
        call for call in custom.calls if call[1] == ARGO_APPLICATIONS_PLURAL
    ]
    assert application_calls[-2:] == [
        ("patch", ARGO_APPLICATIONS_PLURAL, environment.application_name),
        ("delete", ARGO_APPLICATIONS_PLURAL, environment.application_name),
    ]
    assert FINALIZER in custom.resource["metadata"]["finalizers"]

    controller.reconcile(custom.resource)
    controller.reconcile(custom.resource)
    assert core.namespace is None
    assert FINALIZER not in custom.resource["metadata"]["finalizers"]


def test_full_reconcile_lists_only_fixed_control_namespace() -> None:
    controller, _core, custom = controller_pair(preview_resource())
    assert controller.full_reconcile() == "42"
    assert custom.list_namespace == CONTROL_NAMESPACE


class ErrorWatcher:
    def stream(self, function: Any, **kwargs: Any):
        del function, kwargs
        yield {"type": "ERROR", "object": {"code": 410, "reason": "Gone"}}
        raise AssertionError("watch must restart after a 410 event")


def test_watch_cycle_returns_for_resource_version_410() -> None:
    controller, _core, _custom = controller_pair(preview_resource())
    controller.watch_factory = ErrorWatcher
    controller.watch_cycle("stale")


def test_controller_source_never_calls_secret_apis() -> None:
    source = inspect.getsource(
        __import__(
            "src.preview_environment_controller",
            fromlist=["preview_environment_controller"],
        )
    )
    assert "read_namespaced_secret" not in source
    assert "list_namespaced_secret" not in source
    assert "get_namespaced_secret" not in source

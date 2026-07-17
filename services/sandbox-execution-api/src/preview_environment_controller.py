"""Hub-side reconciler for immutable vCluster PreviewEnvironment requests.

The controller intentionally has a narrow authority surface:

* it watches PreviewEnvironment custom resources in ``preview-system`` only;
* it owns one hub namespace, one AppProject, and one Argo CD Application per request;
* certificate and Secret mechanics live behind an injected registration adapter; and
* it refuses to adopt resources that do not carry its label and the originating
  PreviewEnvironment UID.

The validation and manifest functions are pure so the trust boundary can be
tested without a Kubernetes cluster.
"""

from __future__ import annotations

import hashlib
import json
import logging
import math
import os
import re
import signal
import threading
import time
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

from kubernetes import client, config, watch
from kubernetes.client.exceptions import ApiException
from kubernetes.config.config_exception import ConfigException

from src.preview_agent_registration import (
    REGISTRATION_FINALIZER,
    PreviewAgentRegistrationAdapter,
    PreviewAgentRegistrationError,
    PreviewAgentRegistrationOwnershipError,
    PreviewAgentRegistrationStatus,
    registration_annotations,
    registration_labels,
)
from src.preview_dashboard_cleanup import (
    DASHBOARD_REGISTRATION_FINALIZER,
    KubernetesPreviewDashboardCleanupAdapter,
    PreviewDashboardCleanupOwnershipError,
    PreviewDashboardCleanupPort,
)

logger = logging.getLogger(__name__)

API_GROUP = "preview.stacks.io"
API_VERSION = "v1alpha1"
API_PLURAL = "previewenvironments"
CONTROL_NAMESPACE = "preview-system"

FINALIZER = "preview.stacks.io/environment-cleanup"
MANAGED_BY_LABEL = "preview.stacks.io/managed-by"
MANAGED_BY_VALUE = "preview-environment-controller"
ENVIRONMENT_ID_LABEL = "preview.stacks.io/id"
ENVIRONMENT_UID_LABEL = "preview.stacks.io/environment-uid"
PROFILE_LABEL = "preview.stacks.io/profile"
LANE_LABEL = "preview.stacks.io/lane"
MODE_LABEL = "preview.stacks.io/mode"
ALLOCATION_LABEL = "preview.stacks.io/allocation"
OWNER_HASH_LABEL = "preview.stacks.io/owner-id-hash"
IMAGES_HASH_LABEL = "preview.stacks.io/images-hash"
CONTRACT_GENERATION_ANNOTATION = "preview.stacks.io/contract-generation"
RECONCILE_REQUESTED_AT_ANNOTATION = "preview.stacks.io/reconcile-requested-at"
DELETION_INTENT_STATUS_FIELD = "deletionIntent"
DELETION_ACK_STATUS_FIELD = "deletionAcknowledgement"
PHYSICAL_CLEANUP_CHECKS = frozenset(
    {
        "runnerSucceeded",
        "databaseAbsent",
        "natsStreamAbsent",
        "tailnetEgressAbsent",
        "hostNamespaceAbsent",
        "storageScopeAbsent",
        "runnerIdentityAbsent",
    }
)

ARGO_GROUP = "argoproj.io"
ARGO_VERSION = "v1alpha1"
ARGO_APPLICATIONS_PLURAL = "applications"
ARGO_PROJECTS_PLURAL = "appprojects"
ARGO_RESOURCE_FINALIZER = "resources-finalizer.argocd.argoproj.io"

STACKS_REPOSITORY = "https://github.com/PittampalliOrg/stacks.git"
WORKLOAD_PATH = (
    "packages/components/workloads/workflow-builder-preview-vcluster/app-overlay"
)
MANIFEST_CANDIDATE_APPLICATION_PATH = (
    "packages/components/workloads/workflow-builder-preview-vcluster/"
    "manifest-candidate-overlay"
)
MANIFEST_CANDIDATE_BOOTSTRAP_PATH = (
    "packages/components/workloads/workflow-builder-preview-vcluster/agent-bootstrap"
)
WORKLOAD_NAMESPACE = "workflow-builder"
DEFAULT_SERVICE_CATALOG_PATH = "/config/dev-preview-service-catalog.json"
SERVICE_CATALOG_PATH_ENV = "PREVIEW_SERVICE_CATALOG_PATH"
DEFAULT_MANIFEST_CANDIDATE_SURFACE_PATH = "/config/manifest-candidate-surface.json"
MANIFEST_CANDIDATE_SURFACE_PATH_ENV = "PREVIEW_MANIFEST_CANDIDATE_SURFACE_PATH"

MIN_TTL_HOURS = 1
MAX_TTL_HOURS = 168
MAX_SERVICES = 16
MAX_CANDIDATE_PATHS = 64
MAX_PROVENANCE_BYTES = 4096
MAX_PROVENANCE_DEPTH = 4
MAX_PROVENANCE_ENTRIES = 64
PLATFORM_REPOSITORY = "PittampalliOrg/stacks"
SOURCE_REPOSITORY = "PittampalliOrg/workflow-builder"

_ID_PATTERN = re.compile(r"^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$")
_SERVICE_PATTERN = re.compile(r"^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$")
_OWNER_PATTERN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.:@/-]{0,127}$")
_REQUEST_ID_PATTERN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$")
_SHA_PATTERN = re.compile(r"^[0-9a-f]{40}$")
_SHA256_PATTERN = re.compile(r"^sha256:[0-9a-f]{64}$")
_IMMUTABLE_GHCR_IMAGE_PATTERN = re.compile(
    r"^ghcr\.io/"
    r"[a-z0-9]+(?:[._-][a-z0-9]+)*"
    r"(?:/[a-z0-9]+(?:[._-][a-z0-9]+)*)+"
    r"@sha256:[0-9a-f]{64}$"
)
_GHCR_IMAGE_REPOSITORY_PATTERN = re.compile(
    r"^ghcr\.io/pittampalliorg/[a-z0-9]+(?:[._-][a-z0-9]+)*$"
)
_RFC3339_UTC_PATTERN = re.compile(
    r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$"
)
_PROVENANCE_KEY_PATTERN = re.compile(r"^[A-Za-z][A-Za-z0-9_.-]{0,63}$")
_KUBERNETES_UID_PATTERN = re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$"
)
_RUNNER_GENERATION_PATTERN = re.compile(r"^op:[0-9a-f]{32}$")

_RESERVED_PREVIEW_NAMES = frozenset(
    {"mtxdev1", "mtxtmpl1", "preview6", "ganpilot", "ganvalidate", "test3"}
)

_PROFILE_VALUES = frozenset({"app-live", "manifest-candidate"})
_MODE_VALUES = frozenset({"live", "reconciled"})
_LIFECYCLE_VALUES = frozenset({"ephemeral", "retained"})
_OWNER_KIND_VALUES = frozenset({"user", "workflow", "session", "automation"})
_ORIGIN_KIND_VALUES = frozenset(
    {"user", "pull-request", "workflow", "interactive-session", "automation"}
)
_SPEC_FIELDS = frozenset(
    {
        "id",
        "profile",
        "lane",
        "mode",
        "platformRevision",
        "sourceRevision",
        "catalogDigest",
        "trustedCode",
        "lifecycle",
        "owner",
        "origin",
        "services",
        "candidatePaths",
        "images",
        "allocation",
        "ttlHours",
        "expiresAt",
        "provenance",
    }
)

# These patches are preview-runtime wiring, not request data. Keeping them as
# constants prevents a PreviewEnvironment from injecting arbitrary Kustomize.
_KUSTOMIZE_PATCHES: tuple[dict[str, Any], ...] = (
    {
        "target": {"kind": "ConfigMap", "name": "workflow-orchestrator-config"},
        "patch": """apiVersion: v1
kind: ConfigMap
metadata:
  name: workflow-orchestrator-config
  namespace: workflow-builder
data:
  WORKFLOW_DATA_API_MODE: "http"
  WORKFLOW_DATA_API_TRANSPORT: "dapr"
  WORKFLOW_DATA_API_TIMEOUT_SECONDS: "5"
  WORKFLOW_BUILDER_APP_ID: "workflow-builder"
""",
    },
    # The workflow-builder Deployment reads the six canonical environment,
    # request, revision, catalog, and service fields from the runner-staged
    # preview-environment-identity ConfigMap. Do not add literal duplicates:
    # strategic merge would retain valueFrom and produce invalid EnvVars.
    {
        "target": {"kind": "Deployment", "name": "workflow-builder"},
        "patch": """apiVersion: apps/v1
kind: Deployment
metadata:
  name: workflow-builder
  namespace: workflow-builder
spec:
  template:
    spec:
      containers:
        - name: workflow-builder
          env:
            - name: PERSISTENCE_ADAPTER
              value: "postgres"
            - name: EVENT_BUS_ADAPTER
              value: "dapr-pubsub"
            - name: ARTIFACT_STORE_ADAPTER
              value: "postgres-metadata-object-data"
            - name: WORKFLOW_SCHEDULER_ADAPTER
              value: "dapr-workflow"
            - name: PREVIEW_PROVISIONER_ADAPTER
              value: "sandbox-execution-api"
            - name: PREVIEW_HOST_RUNTIMES_DISABLED
              value: "true"
            - name: AGENT_RUNTIME_NAMESPACE
              value: "workflow-builder"
            - name: AGENT_RUNTIME_SHARED_POOLS_ENABLED
              value: "false"
            - name: PREVIEW_ENVIRONMENT_ID
              value: "__PREVIEW_ID__"
            - name: PREVIEW_ENVIRONMENT_PROFILE
              value: "__PREVIEW_PROFILE__"
            - name: PREVIEW_ENVIRONMENT_LANE
              value: "__PREVIEW_LANE__"
            - name: PREVIEW_PLATFORM_REVISION
              value: "__PLATFORM_REVISION__"
            - name: PREVIEW_SOURCE_REVISION
              value: "__SOURCE_REVISION__"
            - name: DEV_PREVIEW_CATALOG_DIGEST
              value: "__CATALOG_DIGEST__"
            - name: PREVIEW_CONTROL_CAPABILITY_TOKEN
              valueFrom:
                secretKeyRef:
                  name: preview-control-credentials
                  key: control-token
            - name: PREVIEW_DEV_SYNC_MINT_TOKEN
              valueFrom:
                secretKeyRef:
                  name: preview-control-credentials
                  key: sync-token
            - name: PREVIEW_ACTION_INTERNAL_TOKEN
              valueFrom:
                secretKeyRef:
                  name: preview-control-credentials
                  key: action-token
            - name: SANDBOX_EXECUTION_API_TOKEN
              valueFrom:
                secretKeyRef:
                  name: preview-control-credentials
                  key: sandbox-token
""",
    },
    {
        "target": {"kind": "Deployment", "name": "sandbox-execution-api"},
        "patch": """apiVersion: apps/v1
kind: Deployment
metadata:
  name: sandbox-execution-api
  namespace: workflow-builder
spec:
  template:
    spec:
      containers:
        - name: sandbox-execution-api
          env:
            - name: SANDBOX_EXECUTION_AGENT_TOPIC_PREFIX
              value: "wbpreview-__PREVIEW_ID__"
            - name: PREVIEW_ENVIRONMENT_ID
              value: "__PREVIEW_ID__"
            - name: PREVIEW_ENVIRONMENT_NAME
              value: "__PREVIEW_ID__"
            - name: PREVIEW_ENVIRONMENT_REQUEST_ID
              value: "__REQUEST_ID__"
            - name: PREVIEW_ENVIRONMENT_PROFILE
              value: "__PREVIEW_PROFILE__"
            - name: PREVIEW_ENVIRONMENT_LANE
              value: "__PREVIEW_LANE__"
            - name: PREVIEW_PLATFORM_REVISION
              value: "__PLATFORM_REVISION__"
            - name: PREVIEW_ENVIRONMENT_PLATFORM_REVISION
              value: "__PLATFORM_REVISION__"
            - name: PREVIEW_SOURCE_REVISION
              value: "__SOURCE_REVISION__"
            - name: PREVIEW_ENVIRONMENT_SOURCE_REVISION
              value: "__SOURCE_REVISION__"
            - name: DEV_PREVIEW_CATALOG_DIGEST
              value: "__CATALOG_DIGEST__"
            - name: PREVIEW_ENVIRONMENT_CATALOG_DIGEST
              value: "__CATALOG_DIGEST__"
            - name: PREVIEW_ENVIRONMENT_SERVICES_JSON
              value: '__SERVICES_JSON__'
            - name: SANDBOX_EXECUTION_API_TOKEN
              valueFrom:
                secretKeyRef:
                  name: preview-control-credentials
                  key: sandbox-token
""",
    },
    {
        "target": {"kind": "Deployment", "name": "workflow-orchestrator"},
        "patch": """apiVersion: apps/v1
kind: Deployment
metadata:
  name: workflow-orchestrator
  namespace: workflow-builder
spec:
  template:
    spec:
      containers:
        - name: workflow-orchestrator
          env:
            - name: WORKFLOW_ORCHESTRATOR_EVENT_TOPIC_PREFIX
              value: "wbpreview-__PREVIEW_ID__"
            - name: PREVIEW_ACTION_INTERNAL_TOKEN
              valueFrom:
                secretKeyRef:
                  name: preview-control-credentials
                  key: action-token
""",
    },
    {
        "target": {"kind": "Deployment", "name": "function-router"},
        "patch": """apiVersion: apps/v1
kind: Deployment
metadata:
  name: function-router
  namespace: workflow-builder
spec:
  template:
    spec:
      containers:
        - name: function-router
          env:
            - name: PREVIEW_ACTION_INTERNAL_TOKEN
              valueFrom:
                secretKeyRef:
                  name: preview-control-credentials
                  key: action-token
""",
    },
)


class PreviewEnvironmentError(RuntimeError):
    """Base class for expected reconciliation errors."""


class SpecValidationError(PreviewEnvironmentError):
    """Raised when a PreviewEnvironment crosses the controller trust boundary."""

    def __init__(self, issues: Sequence[str]) -> None:
        self.issues = tuple(issues)
        super().__init__("; ".join(self.issues))


class OwnershipConflict(PreviewEnvironmentError):
    """Raised rather than adopting a resource owned by another actor or CR."""


class CatalogValidationError(PreviewEnvironmentError):
    """Raised when the controller's mounted service catalog is malformed or stale."""


@dataclass(frozen=True)
class PreviewServiceCapabilities:
    hot_sync: bool
    preview_native: bool
    acceptance_build: bool
    acceptance_replay: bool
    activation_build: bool
    acceptance_image: str | None
    activation_image: str | None
    activation_pipeline: str | None
    activation_status_context: str | None


@dataclass(frozen=True)
class PreviewServiceCatalog:
    catalog_digest: str
    services: Mapping[str, PreviewServiceCapabilities]


@dataclass(frozen=True)
class ManifestCandidateSurface:
    profile: str
    application_path: str
    bootstrap_path: str
    allowed_prefixes: tuple[str, ...]
    route_rules: tuple[tuple[str, str, str, str], ...]


@dataclass(frozen=True)
class ValidatedPreviewEnvironment:
    id: str
    uid: str
    generation: int
    profile: str
    lane: str
    mode: str
    platform_revision: str
    source_revision: str
    lifecycle: str
    owner_kind: str
    owner_id: str
    origin_kind: str
    origin_reference: str | None
    services: tuple[str, ...]
    candidate_paths: tuple[str, ...]
    images: tuple[tuple[str, str], ...]
    allocation_kind: str
    baseline_platform_revision: str | None
    ttl_hours: int
    expires_at: datetime
    provenance: Mapping[str, Any]
    request_id: str
    catalog_digest: str

    @property
    def namespace(self) -> str:
        return f"preview-{self.id}"

    @property
    def application_name(self) -> str:
        return f"preview-{self.id}-workflow-builder"


def _mapping(value: Any) -> Mapping[str, Any] | None:
    return value if isinstance(value, Mapping) else None


def _valid_catalog_path_prefix(value: Any) -> bool:
    return (
        isinstance(value, str)
        and 0 < len(value) <= 1024
        and not value.startswith("/")
        and "\\" not in value
        and all(part not in {"", ".", ".."} for part in value.split("/"))
    )


def parse_preview_service_catalog(document: Any) -> PreviewServiceCatalog:
    """Validate the generated cross-repository service contract and its digest."""

    if not isinstance(document, Mapping):
        raise CatalogValidationError("service catalog must be a JSON object")
    if document.get("schemaVersion") != 3:
        raise CatalogValidationError("service catalog schemaVersion must be 3")
    declared_digest = document.get("catalogDigest")
    if not isinstance(declared_digest, str) or not _SHA256_PATTERN.fullmatch(
        declared_digest
    ):
        raise CatalogValidationError("service catalog has an invalid catalogDigest")
    payload = dict(document)
    payload.pop("catalogDigest", None)
    # The generated document is already recursively canonicalized by the TS
    # producer. Preserve that insertion order here: JS localeCompare ordering is
    # not byte-for-byte equivalent to Python's sort_keys ordering for camel-case
    # keys.
    canonical = json.dumps(
        payload,
        separators=(",", ":"),
        ensure_ascii=False,
        allow_nan=False,
    ).encode("utf-8")
    actual_digest = f"sha256:{hashlib.sha256(canonical).hexdigest()}"
    if declared_digest != actual_digest:
        raise CatalogValidationError(
            "service catalog digest does not match its canonical payload"
        )

    path_policy = _mapping(document.get("pathPolicy"))
    ignored_prefixes = (
        path_policy.get("ignoredPathPrefixes") if path_policy is not None else None
    )
    unsupported_prefixes = (
        path_policy.get("unsupportedPathPrefixes") if path_policy is not None else None
    )
    if (
        path_policy is None
        or path_policy.get("unmatchedPathPolicy") != "unsupported"
        or not isinstance(ignored_prefixes, list)
        or not ignored_prefixes
        or not isinstance(unsupported_prefixes, list)
        or not unsupported_prefixes
        or any(not _valid_catalog_path_prefix(path) for path in ignored_prefixes)
        or any(not _valid_catalog_path_prefix(path) for path in unsupported_prefixes)
        or len(set(ignored_prefixes)) != len(ignored_prefixes)
        or len(set(unsupported_prefixes)) != len(unsupported_prefixes)
    ):
        raise CatalogValidationError("service catalog path policy is invalid")
    for ignored in ignored_prefixes:
        for unsupported in unsupported_prefixes:
            if (
                ignored == unsupported
                or ignored.startswith(f"{unsupported}/")
                or unsupported.startswith(f"{ignored}/")
            ):
                raise CatalogValidationError("service catalog path policy is ambiguous")

    raw_services = document.get("services")
    if not isinstance(raw_services, list) or not raw_services:
        raise CatalogValidationError(
            "service catalog services must be a non-empty array"
        )
    services: dict[str, PreviewServiceCapabilities] = {}
    for index, raw_service in enumerate(raw_services):
        service = _mapping(raw_service)
        if service is None:
            raise CatalogValidationError(
                f"service catalog services[{index}] is invalid"
            )
        name = service.get("service")
        if not isinstance(name, str) or not _SERVICE_PATTERN.fullmatch(name):
            raise CatalogValidationError(
                f"service catalog services[{index}].service is invalid"
            )
        if name in services:
            raise CatalogValidationError(f"service catalog duplicates service {name}")
        capabilities = _mapping(service.get("capabilities"))
        if capabilities is None:
            raise CatalogValidationError(f"service catalog {name} has no capabilities")
        hot_sync = capabilities.get("hotSync")
        preview_native = capabilities.get("previewNative")
        acceptance_build = capabilities.get("acceptanceBuild")
        acceptance_replay = capabilities.get("acceptanceReplay")
        activation_build = capabilities.get("activationBuild")
        if not all(
            isinstance(value, bool)
            for value in (
                hot_sync,
                preview_native,
                acceptance_build,
                acceptance_replay,
                activation_build,
            )
        ):
            raise CatalogValidationError(
                f"service catalog {name} capabilities must be booleans"
            )
        acceptance = _mapping(service.get("acceptance"))
        activation = _mapping(service.get("activation"))
        if acceptance_build != (acceptance is not None):
            raise CatalogValidationError(
                f"service catalog {name} acceptanceBuild disagrees with its build contract"
            )
        if activation_build != (activation is not None):
            raise CatalogValidationError(
                f"service catalog {name} activationBuild disagrees with its build contract"
            )
        requirements = _mapping(service.get("stacksRequirements"))
        adoption = (
            _mapping(requirements.get("workloadAdoption"))
            if requirements is not None
            else None
        )
        if (preview_native or acceptance_replay) and adoption is None:
            raise CatalogValidationError(
                f"service catalog {name} declares runtime adoption without an adoption contract"
            )
        if acceptance_replay and not acceptance_build:
            raise CatalogValidationError(
                f"service catalog {name} declares acceptanceReplay without acceptanceBuild"
            )
        acceptance_image = acceptance.get("image") if acceptance is not None else None
        if acceptance is not None and (
            not isinstance(acceptance_image, str)
            or not _GHCR_IMAGE_REPOSITORY_PATTERN.fullmatch(acceptance_image)
        ):
            raise CatalogValidationError(
                f"service catalog {name} acceptance image repository is invalid"
            )
        activation_image = activation.get("image") if activation is not None else None
        activation_pipeline = (
            activation.get("pipeline") if activation is not None else None
        )
        activation_status_context = (
            activation.get("statusContext") if activation is not None else None
        )
        if activation is not None and (
            not isinstance(activation_image, str)
            or not _GHCR_IMAGE_REPOSITORY_PATTERN.fullmatch(activation_image)
            or not isinstance(activation_pipeline, str)
            or not _SERVICE_PATTERN.fullmatch(activation_pipeline)
            or activation_status_context != "preview/activation-images"
        ):
            raise CatalogValidationError(
                f"service catalog {name} activation metadata is invalid"
            )
        services[name] = PreviewServiceCapabilities(
            hot_sync=hot_sync,
            preview_native=preview_native,
            acceptance_build=acceptance_build,
            acceptance_replay=acceptance_replay,
            activation_build=activation_build,
            acceptance_image=acceptance_image,
            activation_image=activation_image,
            activation_pipeline=activation_pipeline,
            activation_status_context=activation_status_context,
        )
    return PreviewServiceCatalog(
        catalog_digest=declared_digest,
        services=services,
    )


def load_preview_service_catalog(path: str | Path) -> PreviewServiceCatalog:
    """Load the mounted catalog once; startup fails closed on drift or corruption."""

    catalog_path = Path(path)
    try:
        document = json.loads(catalog_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise CatalogValidationError(
            f"could not load preview service catalog {catalog_path}: {exc}"
        ) from exc
    return parse_preview_service_catalog(document)


def parse_manifest_candidate_surface(document: Any) -> ManifestCandidateSurface:
    if (
        not isinstance(document, Mapping)
        or document.get("schemaVersion") != 1
        or document.get("profile") != "manifest-candidate"
    ):
        raise CatalogValidationError("manifest candidate surface header is invalid")
    application_path = document.get("applicationPath")
    bootstrap_path = document.get("bootstrapPath")
    if application_path != MANIFEST_CANDIDATE_APPLICATION_PATH:
        raise CatalogValidationError(
            "manifest candidate applicationPath does not match the executable surface"
        )
    if bootstrap_path != MANIFEST_CANDIDATE_BOOTSTRAP_PATH:
        raise CatalogValidationError(
            "manifest candidate bootstrapPath does not match the executable surface"
        )
    allowed_raw = document.get("allowedSurfaces")
    routes_raw = document.get("routeRules")
    if (
        not isinstance(allowed_raw, list)
        or not allowed_raw
        or not isinstance(routes_raw, list)
    ):
        raise CatalogValidationError("manifest candidate surface rules are invalid")
    allowed: list[str] = []
    for entry in allowed_raw:
        value = _mapping(entry)
        prefix = value.get("pathPrefix") if value is not None else None
        if not isinstance(prefix, str) or not prefix:
            raise CatalogValidationError(
                "manifest candidate allowed pathPrefix is invalid"
            )
        allowed.append(prefix)
    routes: list[tuple[str, str, str, str]] = []
    for entry in routes_raw:
        value = _mapping(entry)
        if value is None:
            raise CatalogValidationError("manifest candidate route rule is invalid")
        prefix = value.get("pathPrefix")
        profile = value.get("profile")
        lane = value.get("lane")
        reason = value.get("reason")
        if (
            not isinstance(prefix, str)
            or not prefix
            or (profile, lane)
            not in {
                ("manifest-candidate", "management"),
                ("host-candidate", "application"),
            }
            or not isinstance(reason, str)
            or not reason
        ):
            raise CatalogValidationError("manifest candidate route rule is invalid")
        routes.append((prefix, profile, lane, reason))
    return ManifestCandidateSurface(
        profile="manifest-candidate",
        application_path=application_path,
        bootstrap_path=bootstrap_path,
        allowed_prefixes=tuple(allowed),
        route_rules=tuple(routes),
    )


def load_manifest_candidate_surface(path: str | Path) -> ManifestCandidateSurface:
    try:
        document = json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise CatalogValidationError(
            f"could not load manifest candidate surface {path}: {exc}"
        ) from exc
    return parse_manifest_candidate_surface(document)


def _candidate_path_matches(path: str, prefix: str) -> bool:
    return path.startswith(prefix) if prefix.endswith("/") else path == prefix


def _parse_utc_timestamp(value: Any, field: str, issues: list[str]) -> datetime | None:
    if not isinstance(value, str) or not _RFC3339_UTC_PATTERN.fullmatch(value):
        issues.append(f"{field} must be an RFC3339 UTC timestamp ending in Z")
        return None
    try:
        parsed = datetime.fromisoformat(value[:-1] + "+00:00")
    except ValueError:
        issues.append(f"{field} is not a real timestamp")
        return None
    if parsed.tzinfo is None or parsed.utcoffset() != timedelta(0):
        issues.append(f"{field} must be UTC")
        return None
    return parsed.astimezone(UTC)


def _validate_json_value(
    value: Any,
    *,
    path: str,
    depth: int,
    state: dict[str, int],
    issues: list[str],
) -> None:
    if depth > MAX_PROVENANCE_DEPTH:
        issues.append(f"{path} exceeds maximum nesting depth {MAX_PROVENANCE_DEPTH}")
        return
    if isinstance(value, Mapping):
        state["entries"] += len(value)
        if state["entries"] > MAX_PROVENANCE_ENTRIES:
            issues.append(
                f"provenance exceeds maximum entry count {MAX_PROVENANCE_ENTRIES}"
            )
            return
        for key, child in value.items():
            if not isinstance(key, str) or not _PROVENANCE_KEY_PATTERN.fullmatch(key):
                issues.append(f"{path} contains an invalid key")
                continue
            _validate_json_value(
                child,
                path=f"{path}.{key}",
                depth=depth + 1,
                state=state,
                issues=issues,
            )
        return
    if isinstance(value, list):
        state["entries"] += len(value)
        if state["entries"] > MAX_PROVENANCE_ENTRIES:
            issues.append(
                f"provenance exceeds maximum entry count {MAX_PROVENANCE_ENTRIES}"
            )
            return
        if len(value) > 32:
            issues.append(f"{path} arrays may contain at most 32 values")
            return
        for index, child in enumerate(value):
            _validate_json_value(
                child,
                path=f"{path}[{index}]",
                depth=depth + 1,
                state=state,
                issues=issues,
            )
        return
    if isinstance(value, str):
        if (
            not value.strip()
            or len(value) > 512
            or any(ord(char) < 32 or ord(char) == 127 for char in value)
        ):
            issues.append(
                f"{path} must be non-empty printable text of at most 512 chars"
            )
        return
    if value is None or isinstance(value, bool) or isinstance(value, int):
        return
    if isinstance(value, float) and math.isfinite(value):
        return
    issues.append(f"{path} contains an unsupported JSON value")


def validate_preview_environment(
    resource: Mapping[str, Any],
    *,
    catalog: PreviewServiceCatalog,
    candidate_surface: ManifestCandidateSurface | None = None,
) -> ValidatedPreviewEnvironment:
    """Validate and normalize one untrusted PreviewEnvironment custom resource."""

    issues: list[str] = []
    metadata = _mapping(resource.get("metadata"))
    spec = _mapping(resource.get("spec"))
    if metadata is None:
        raise SpecValidationError(("metadata is required",))
    if spec is None:
        raise SpecValidationError(("spec is required",))

    if resource.get("apiVersion") != f"{API_GROUP}/{API_VERSION}":
        issues.append(f"apiVersion must be {API_GROUP}/{API_VERSION}")
    if resource.get("kind") != "PreviewEnvironment":
        issues.append("kind must be PreviewEnvironment")
    unexpected_fields = sorted(str(field) for field in set(spec) - _SPEC_FIELDS)
    if unexpected_fields:
        issues.append(
            f"spec contains unsupported fields: {', '.join(unexpected_fields)}"
        )

    name = metadata.get("name")
    preview_id = spec.get("id")
    if not isinstance(name, str) or not _ID_PATTERN.fullmatch(name):
        issues.append("metadata.name must be a lowercase DNS label of at most 40 chars")
    if not isinstance(preview_id, str) or not _ID_PATTERN.fullmatch(preview_id):
        issues.append("spec.id must be a lowercase DNS label of at most 40 chars")
    elif preview_id.startswith("pool-") or preview_id in _RESERVED_PREVIEW_NAMES:
        issues.append("spec.id is reserved for legacy preview retirement")
    if isinstance(name, str) and isinstance(preview_id, str) and name != preview_id:
        issues.append("metadata.name must exactly equal spec.id")
    namespace = metadata.get("namespace")
    if namespace != CONTROL_NAMESPACE:
        issues.append(f"metadata.namespace must be {CONTROL_NAMESPACE}")

    uid = metadata.get("uid")
    if not isinstance(uid, str) or not uid or len(uid) > 63:
        issues.append("metadata.uid is required and must be at most 63 chars")
    generation = metadata.get("generation", 1)
    if (
        isinstance(generation, bool)
        or not isinstance(generation, int)
        or generation < 1
    ):
        issues.append("metadata.generation must be a positive integer")

    profile = spec.get("profile")
    if profile not in _PROFILE_VALUES:
        issues.append("spec.profile must be app-live or manifest-candidate")
    lane = spec.get("lane")
    if lane not in {"application", "management"}:
        issues.append("spec.lane must be application or management")
    if lane == "management":
        if profile != "manifest-candidate":
            issues.append("only manifest-candidate can use spec.lane=management")
        issues.append(
            "spec.lane=management requires the isolated operator adapter, not this reconciler"
        )
    mode = spec.get("mode")
    if mode not in _MODE_VALUES:
        issues.append("spec.mode must be live or reconciled")
    if profile == "manifest-candidate" and mode != "reconciled":
        issues.append("manifest-candidate requires spec.mode=reconciled")
    platform_revision = spec.get("platformRevision")
    if not isinstance(platform_revision, str) or not _SHA_PATTERN.fullmatch(
        platform_revision
    ):
        issues.append(
            "spec.platformRevision must be an exact lowercase 40-char Git SHA"
        )
    source_revision = spec.get("sourceRevision")
    if not isinstance(source_revision, str) or not _SHA_PATTERN.fullmatch(
        source_revision
    ):
        issues.append("spec.sourceRevision must be an exact lowercase 40-char Git SHA")
    if spec.get("trustedCode") is not True:
        issues.append("spec.trustedCode must be true")

    lifecycle = spec.get("lifecycle")
    if lifecycle not in _LIFECYCLE_VALUES:
        issues.append("spec.lifecycle must be ephemeral or retained")

    owner = _mapping(spec.get("owner"))
    owner_kind: str | None = None
    owner_id: str | None = None
    if owner is None:
        issues.append("spec.owner must be an object with kind and id")
    else:
        unexpected_owner_fields = sorted(
            str(field) for field in set(owner) - {"kind", "id"}
        )
        if unexpected_owner_fields:
            issues.append(
                "spec.owner contains unsupported fields: "
                + ", ".join(unexpected_owner_fields)
            )
        kind_value = owner.get("kind")
        if kind_value not in _OWNER_KIND_VALUES:
            issues.append("spec.owner.kind is invalid")
        else:
            owner_kind = kind_value
        id_value = owner.get("id")
        if not isinstance(id_value, str) or not _OWNER_PATTERN.fullmatch(id_value):
            issues.append(
                "spec.owner.id is required and contains unsupported characters"
            )
        else:
            owner_id = id_value

    origin = _mapping(spec.get("origin"))
    origin_kind: str | None = None
    origin_reference: str | None = None
    if origin is None:
        issues.append("spec.origin must be an object with kind")
    else:
        unexpected_origin_fields = sorted(
            str(field) for field in set(origin) - {"kind", "reference"}
        )
        if unexpected_origin_fields:
            issues.append(
                "spec.origin contains unsupported fields: "
                + ", ".join(unexpected_origin_fields)
            )
        kind_value = origin.get("kind")
        if kind_value not in _ORIGIN_KIND_VALUES:
            issues.append("spec.origin.kind is invalid")
        else:
            origin_kind = kind_value
        reference_value = origin.get("reference")
        if reference_value is not None:
            if (
                not isinstance(reference_value, str)
                or not reference_value.strip()
                or len(reference_value) > 512
                or re.search(r"[\x00-\x1f\x7f]", reference_value)
            ):
                issues.append("spec.origin.reference is invalid")
            else:
                origin_reference = reference_value
        if (
            kind_value in {"pull-request", "workflow", "interactive-session"}
            and not origin_reference
        ):
            issues.append(f"spec.origin.reference is required for {kind_value}")

    if (
        profile == "app-live"
        and mode == "live"
        and owner_kind is not None
        and not (
            owner_kind == "user"
            or (owner_kind == "automation" and origin_kind == "pull-request")
        )
    ):
        issues.append(
            "live app-live previews require spec.owner.kind=user or "
            "pull-request automation ownership"
        )

    requested_catalog_digest = spec.get("catalogDigest")
    if not isinstance(requested_catalog_digest, str) or not _SHA256_PATTERN.fullmatch(
        requested_catalog_digest
    ):
        issues.append("spec.catalogDigest must be a lowercase sha256 digest")
    elif requested_catalog_digest != catalog.catalog_digest:
        issues.append("spec.catalogDigest does not match the mounted service catalog")

    raw_services = spec.get("services")
    services: list[str] = []
    if not isinstance(raw_services, list):
        issues.append("spec.services must be an array")
    elif len(raw_services) > MAX_SERVICES:
        issues.append(f"spec.services may contain at most {MAX_SERVICES} entries")
    else:
        seen: set[str] = set()
        for index, service in enumerate(raw_services):
            if not isinstance(service, str) or not _SERVICE_PATTERN.fullmatch(service):
                issues.append(
                    f"spec.services[{index}] must be a lowercase Kubernetes DNS label"
                )
                continue
            if service in seen:
                issues.append(f"spec.services[{index}] duplicates {service}")
                continue
            seen.add(service)
            services.append(service)
            catalog_service = catalog.services.get(service)
            if catalog_service is None:
                issues.append(
                    f"spec.services[{index}] {service} is not present in the service catalog"
                )
            elif profile == "app-live":
                if mode == "reconciled" and not catalog_service.acceptance_replay:
                    issues.append(
                        f"spec.services[{index}] {service} has no immutable acceptance replay contract"
                    )
                elif mode == "live" and not (
                    catalog_service.hot_sync and catalog_service.preview_native
                ):
                    issues.append(
                        f"spec.services[{index}] {service} is not hot-sync preview-native for app-live"
                    )
        if profile == "app-live" and not services:
            issues.append("spec.services must not be empty for app-live")

    raw_candidate_paths = spec.get("candidatePaths", [])
    candidate_paths: list[str] = []
    if (
        not isinstance(raw_candidate_paths, list)
        or len(raw_candidate_paths) > MAX_CANDIDATE_PATHS
    ):
        issues.append(
            f"spec.candidatePaths must be an array of at most {MAX_CANDIDATE_PATHS} paths"
        )
    else:
        seen_paths: set[str] = set()
        for index, path in enumerate(raw_candidate_paths):
            if (
                not isinstance(path, str)
                or not path
                or len(path) > 512
                or path.startswith("/")
                or "\\" in path
                or any(part in {"", ".", ".."} for part in path.split("/"))
            ):
                issues.append(
                    f"spec.candidatePaths[{index}] must be a normalized repository-relative path"
                )
                continue
            if path in seen_paths:
                issues.append(f"spec.candidatePaths[{index}] duplicates {path}")
                continue
            seen_paths.add(path)
            candidate_paths.append(path)
    candidate_paths.sort()
    if profile == "manifest-candidate":
        if not candidate_paths:
            issues.append("manifest-candidate requires non-empty spec.candidatePaths")
        elif candidate_surface is None:
            issues.append("manifest candidate surface contract is not configured")
        else:
            for path in candidate_paths:
                if any(
                    _candidate_path_matches(path, prefix)
                    for prefix in candidate_surface.allowed_prefixes
                ):
                    continue
                route = next(
                    (
                        (route_profile, route_lane, reason)
                        for prefix, route_profile, route_lane, reason in candidate_surface.route_rules
                        if _candidate_path_matches(path, prefix)
                    ),
                    None,
                )
                if route:
                    issues.append(
                        f"spec.candidatePaths path {path} requires {route[0]} "
                        f"lane {route[1]}: {route[2]}"
                    )
                else:
                    issues.append(
                        f"spec.candidatePaths path {path} is outside the executable preview surface"
                    )
    elif candidate_paths:
        issues.append("spec.candidatePaths is allowed only for manifest-candidate")

    raw_images = spec.get("images", {})
    images: list[tuple[str, str]] = []
    if not isinstance(raw_images, Mapping):
        issues.append(
            "spec.images must be an object mapping service ids to image digests"
        )
    elif len(raw_images) > MAX_SERVICES:
        issues.append(f"spec.images may contain at most {MAX_SERVICES} entries")
    else:
        selected_services = set(services)
        for service, image in sorted(raw_images.items(), key=lambda item: str(item[0])):
            if not isinstance(service, str) or not _SERVICE_PATTERN.fullmatch(service):
                issues.append("spec.images contains an invalid service id")
                continue
            if service not in selected_services:
                issues.append(f"spec.images.{service} is not present in spec.services")
            catalog_service = catalog.services.get(service)
            if catalog_service is not None and not catalog_service.acceptance_build:
                issues.append(
                    f"spec.images.{service} has no acceptance build contract in the service catalog"
                )
            if not isinstance(
                image, str
            ) or not _IMMUTABLE_GHCR_IMAGE_PATTERN.fullmatch(image):
                issues.append(
                    f"spec.images.{service} must be a full lowercase "
                    "ghcr.io image@sha256 digest reference"
                )
                continue
            if (
                catalog_service is not None
                and catalog_service.acceptance_image is not None
                and not image.startswith(f"{catalog_service.acceptance_image}@")
            ):
                issues.append(
                    f"spec.images.{service} must use catalog repository "
                    f"{catalog_service.acceptance_image}"
                )
                continue
            images.append((service, image))
    if profile == "app-live" and mode == "reconciled":
        missing_images = sorted(set(services) - {service for service, _ in images})
        if missing_images:
            issues.append(
                "reconciled app-live requires one immutable image for every service: "
                + ", ".join(missing_images)
            )

    allocation = _mapping(spec.get("allocation"))
    allocation_kind: str | None = None
    baseline_platform_revision: str | None = None
    if allocation is None:
        issues.append("spec.allocation must be an object")
    else:
        unexpected_allocation_fields = sorted(
            str(field) for field in set(allocation) - {"kind"}
        )
        if unexpected_allocation_fields:
            issues.append(
                "spec.allocation contains unsupported fields: "
                + ", ".join(unexpected_allocation_fields)
            )
        allocation_kind_value = allocation.get("kind")
        if allocation_kind_value != "cold":
            issues.append("spec.allocation must be exactly {kind: cold}")
        else:
            allocation_kind = allocation_kind_value

    ttl_hours = spec.get("ttlHours")
    if (
        isinstance(ttl_hours, bool)
        or not isinstance(ttl_hours, int)
        or not MIN_TTL_HOURS <= ttl_hours <= MAX_TTL_HOURS
    ):
        issues.append(
            f"spec.ttlHours must be an integer from {MIN_TTL_HOURS} to {MAX_TTL_HOURS}"
        )
    expires_at = _parse_utc_timestamp(spec.get("expiresAt"), "spec.expiresAt", issues)

    provenance = _mapping(spec.get("provenance"))
    requested_at: datetime | None = None
    if provenance is None or not provenance:
        issues.append("spec.provenance must be a non-empty object")
        provenance = {}
    else:
        try:
            encoded = json.dumps(
                provenance,
                sort_keys=True,
                separators=(",", ":"),
                allow_nan=False,
            ).encode("utf-8")
        except (TypeError, ValueError):
            issues.append("spec.provenance must contain valid JSON values")
        else:
            if len(encoded) > MAX_PROVENANCE_BYTES:
                issues.append(
                    f"spec.provenance may be at most {MAX_PROVENANCE_BYTES} UTF-8 bytes"
                )
        _validate_json_value(
            provenance,
            path="spec.provenance",
            depth=0,
            state={"entries": 0},
            issues=issues,
        )
        for key, limit in (
            ("requestId", 256),
            ("platformRepository", 512),
            ("sourceRepository", 512),
        ):
            value = provenance.get(key)
            if not isinstance(value, str) or not value.strip() or len(value) > limit:
                issues.append(
                    f"spec.provenance.{key} is required and too long or empty"
                )
        request_id = provenance.get("requestId")
        if not isinstance(request_id, str) or not _REQUEST_ID_PATTERN.fullmatch(
            request_id
        ):
            issues.append("spec.provenance.requestId contains unsafe characters")
        if provenance.get("platformRepository") != PLATFORM_REPOSITORY:
            issues.append(
                f"spec.provenance.platformRepository must be {PLATFORM_REPOSITORY}"
            )
        if provenance.get("sourceRepository") != SOURCE_REPOSITORY:
            issues.append(
                f"spec.provenance.sourceRepository must be {SOURCE_REPOSITORY}"
            )
        requested_at = _parse_utc_timestamp(
            provenance.get("requestedAt"),
            "spec.provenance.requestedAt",
            issues,
        )

    if (
        expires_at is not None
        and requested_at is not None
        and isinstance(ttl_hours, int)
        and not isinstance(ttl_hours, bool)
        and MIN_TTL_HOURS <= ttl_hours <= MAX_TTL_HOURS
    ):
        lifetime = expires_at - requested_at
        if lifetime <= timedelta(0):
            issues.append("spec.expiresAt must be after provenance.requestedAt")
        elif lifetime > timedelta(hours=ttl_hours):
            issues.append("spec.expiresAt exceeds spec.ttlHours from requestedAt")

    if issues:
        raise SpecValidationError(issues)

    assert isinstance(preview_id, str)
    assert isinstance(uid, str)
    assert isinstance(generation, int)
    assert isinstance(profile, str)
    assert isinstance(mode, str)
    assert isinstance(platform_revision, str)
    assert isinstance(source_revision, str)
    assert isinstance(lifecycle, str)
    assert isinstance(owner_kind, str)
    assert isinstance(owner_id, str)
    assert isinstance(origin_kind, str)
    assert isinstance(requested_catalog_digest, str)
    assert isinstance(ttl_hours, int)
    assert expires_at is not None
    assert allocation_kind in {"cold", "warm"}
    return ValidatedPreviewEnvironment(
        id=preview_id,
        uid=uid,
        generation=generation,
        profile=profile,
        lane=lane,
        mode=mode,
        platform_revision=platform_revision,
        source_revision=source_revision,
        lifecycle=lifecycle,
        owner_kind=owner_kind,
        owner_id=owner_id,
        origin_kind=origin_kind,
        origin_reference=origin_reference,
        services=tuple(services),
        candidate_paths=tuple(candidate_paths),
        images=tuple(images),
        allocation_kind=allocation_kind,
        baseline_platform_revision=baseline_platform_revision,
        ttl_hours=ttl_hours,
        expires_at=expires_at,
        provenance=dict(provenance),
        request_id=str(provenance["requestId"]),
        catalog_digest=requested_catalog_digest,
    )


def _owner_hash(owner_id: str) -> str:
    return hashlib.sha256(owner_id.encode("utf-8")).hexdigest()[:16]


def _resource_labels(environment: ValidatedPreviewEnvironment) -> dict[str, str]:
    images_json = json.dumps(
        dict(environment.images), sort_keys=True, separators=(",", ":")
    )
    return {
        MANAGED_BY_LABEL: MANAGED_BY_VALUE,
        ENVIRONMENT_ID_LABEL: environment.id,
        ENVIRONMENT_UID_LABEL: environment.uid,
        PROFILE_LABEL: environment.profile,
        LANE_LABEL: environment.lane,
        MODE_LABEL: environment.mode,
        ALLOCATION_LABEL: environment.allocation_kind,
        OWNER_HASH_LABEL: _owner_hash(environment.owner_id),
        IMAGES_HASH_LABEL: hashlib.sha256(images_json.encode("utf-8")).hexdigest()[:16],
    }


def _resource_annotations(environment: ValidatedPreviewEnvironment) -> dict[str, str]:
    return {
        "preview.stacks.io/lifecycle": environment.lifecycle,
        "preview.stacks.io/owner": json.dumps(
            {"kind": environment.owner_kind, "id": environment.owner_id},
            sort_keys=True,
            separators=(",", ":"),
        ),
        "preview.stacks.io/origin": json.dumps(
            {
                "kind": environment.origin_kind,
                **(
                    {"reference": environment.origin_reference}
                    if environment.origin_reference is not None
                    else {}
                ),
            },
            sort_keys=True,
            separators=(",", ":"),
        ),
        "preview.stacks.io/platform-revision": environment.platform_revision,
        "preview.stacks.io/source-revision": environment.source_revision,
        "preview.stacks.io/catalog-digest": environment.catalog_digest,
        "preview.stacks.io/services": json.dumps(
            environment.services, separators=(",", ":")
        ),
        "preview.stacks.io/candidate-paths": json.dumps(
            environment.candidate_paths, separators=(",", ":")
        ),
        "preview.stacks.io/images": json.dumps(
            dict(environment.images), sort_keys=True, separators=(",", ":")
        ),
        "preview.stacks.io/allocation": json.dumps(
            {
                "kind": environment.allocation_kind,
                **(
                    {"baselinePlatformRevision": environment.baseline_platform_revision}
                    if environment.baseline_platform_revision is not None
                    else {}
                ),
            },
            sort_keys=True,
            separators=(",", ":"),
        ),
        "preview.stacks.io/ttl-hours": str(environment.ttl_hours),
        "preview.stacks.io/expires-at": environment.expires_at.isoformat().replace(
            "+00:00", "Z"
        ),
        "preview.stacks.io/provenance": json.dumps(
            environment.provenance,
            sort_keys=True,
            separators=(",", ":"),
            allow_nan=False,
        ),
    }


def build_namespace_manifest(
    environment: ValidatedPreviewEnvironment,
) -> dict[str, Any]:
    """Build the one hub namespace owned by a PreviewEnvironment."""

    return {
        "apiVersion": "v1",
        "kind": "Namespace",
        "metadata": {
            "name": environment.namespace,
            "labels": {
                **_resource_labels(environment),
                **registration_labels(environment.id),
            },
            "annotations": {
                **_resource_annotations(environment),
                **registration_annotations(environment.uid),
            },
        },
    }


def build_app_project_manifest(
    environment: ValidatedPreviewEnvironment,
) -> dict[str, Any]:
    """Build the hub-side Argo CD project for the preview Application namespace."""

    return {
        "apiVersion": f"{ARGO_GROUP}/{ARGO_VERSION}",
        "kind": "AppProject",
        "metadata": {
            "name": "default",
            "namespace": environment.namespace,
            "labels": _resource_labels(environment),
            "annotations": _resource_annotations(environment),
        },
        "spec": {
            "description": f"Default project for preview environment {environment.id}",
            "sourceRepos": ["*"],
            "sourceNamespaces": ["*"],
            "destinations": [{"server": "*", "namespace": "*"}],
            "clusterResourceWhitelist": [{"group": "*", "kind": "*"}],
            "namespaceResourceWhitelist": [{"group": "*", "kind": "*"}],
        },
    }


def _render_kustomize_patches(
    environment: ValidatedPreviewEnvironment,
) -> list[dict[str, Any]]:
    substitutions = {
        "__PREVIEW_ID__": environment.id,
        "__PREVIEW_PROFILE__": environment.profile,
        "__PREVIEW_LANE__": environment.lane,
        "__PLATFORM_REVISION__": environment.platform_revision,
        "__SOURCE_REVISION__": environment.source_revision,
        "__CATALOG_DIGEST__": environment.catalog_digest,
        "__REQUEST_ID__": environment.request_id,
        "__SERVICES_JSON__": json.dumps(
            sorted(environment.services), separators=(",", ":")
        ),
    }
    rendered: list[dict[str, Any]] = []
    for item in _KUSTOMIZE_PATCHES:
        patch = item["patch"]
        for placeholder, value in substitutions.items():
            patch = patch.replace(placeholder, value)
        rendered.append(
            {
                "target": dict(item["target"]),
                "patch": patch,
            }
        )
    return rendered


def build_application_manifest(
    environment: ValidatedPreviewEnvironment,
    *,
    candidate_surface: ManifestCandidateSurface | None = None,
    reconcile_requested_at: datetime | None = None,
) -> dict[str, Any]:
    """Build the immutable-revision Argo CD Application for one preview."""

    if environment.profile == "manifest-candidate" and candidate_surface is None:
        raise CatalogValidationError(
            "manifest candidate surface contract is required to build its Application"
        )
    source_path = (
        candidate_surface.application_path
        if environment.profile == "manifest-candidate" and candidate_surface is not None
        else WORKLOAD_PATH
    )
    sync_options = ["CreateNamespace=false", "ApplyOutOfSyncOnly=true"]
    spec: dict[str, Any] = {
        "project": "default",
        "source": {
            "repoURL": STACKS_REPOSITORY,
            "path": source_path,
            "targetRevision": environment.platform_revision,
            "kustomize": {"patches": _render_kustomize_patches(environment)},
        },
        "destination": {
            "name": environment.namespace,
            "namespace": WORKLOAD_NAMESPACE,
        },
        "syncPolicy": {
            "automated": {"prune": True, "selfHeal": True},
            "syncOptions": sync_options,
            "retry": {
                "limit": 5,
                "backoff": {
                    "duration": "10s",
                    "factor": 2,
                    "maxDuration": "3m",
                },
            },
        },
    }
    if environment.images:
        spec["source"]["kustomize"]["images"] = [
            f"{service}={image}" for service, image in environment.images
        ]
    if environment.profile == "app-live" and environment.mode == "live":
        spec["ignoreDifferences"] = [
            {
                "group": "apps",
                "kind": "Deployment",
                "name": service,
                "jsonPointers": ["/spec/replicas"],
            }
            for service in environment.services
        ]
        sync_options.append("RespectIgnoreDifferences=true")

    annotations = _resource_annotations(environment)
    annotations[CONTRACT_GENERATION_ANNOTATION] = str(environment.generation)
    if reconcile_requested_at is not None:
        annotations[RECONCILE_REQUESTED_AT_ANNOTATION] = (
            reconcile_requested_at.astimezone(UTC)
            .isoformat(timespec="microseconds")
            .replace("+00:00", "Z")
        )
    return {
        "apiVersion": f"{ARGO_GROUP}/{ARGO_VERSION}",
        "kind": "Application",
        "metadata": {
            "name": environment.application_name,
            "namespace": environment.namespace,
            "labels": _resource_labels(environment),
            "annotations": annotations,
            "finalizers": [ARGO_RESOURCE_FINALIZER],
        },
        "spec": spec,
    }


def application_is_ready(
    application: Mapping[str, Any], environment: ValidatedPreviewEnvironment
) -> bool:
    status = _mapping(application.get("status")) or {}
    sync_status = _mapping(status.get("sync")) or {}
    health_status = _mapping(status.get("health")) or {}
    metadata = _mapping(application.get("metadata")) or {}
    annotations = _mapping(metadata.get("annotations")) or {}
    requested_at = _parse_utc_timestamp(
        annotations.get(RECONCILE_REQUESTED_AT_ANNOTATION),
        RECONCILE_REQUESTED_AT_ANNOTATION,
        [],
    )
    reconciled_at = _parse_utc_timestamp(
        status.get("reconciledAt"), "status.reconciledAt", []
    )
    return (
        sync_status.get("status") == "Synced"
        and sync_status.get("revision") == environment.platform_revision
        and health_status.get("status") == "Healthy"
        and annotations.get(CONTRACT_GENERATION_ANNOTATION)
        == str(environment.generation)
        and requested_at is not None
        and reconciled_at is not None
        and reconciled_at >= requested_at
    )


def _now_text(now: datetime) -> str:
    return now.astimezone(UTC).isoformat(timespec="seconds").replace("+00:00", "Z")


def _condition(
    current_conditions: Sequence[Mapping[str, Any]],
    *,
    condition_type: str,
    status: str,
    reason: str,
    message: str,
    generation: int,
    now: datetime,
) -> dict[str, Any]:
    transition = _now_text(now)
    for existing in current_conditions:
        if existing.get("type") != condition_type:
            continue
        if (
            existing.get("status") == status
            and existing.get("reason") == reason
            and existing.get("message") == message
        ):
            transition = str(existing.get("lastTransitionTime") or transition)
        break
    return {
        "type": condition_type,
        "status": status,
        "reason": reason,
        "message": message,
        "observedGeneration": generation,
        "lastTransitionTime": transition,
    }


def build_status(
    resource: Mapping[str, Any],
    *,
    phase: str,
    valid: bool,
    ready: bool,
    reason: str,
    message: str,
    now: datetime,
    environment: ValidatedPreviewEnvironment | None = None,
    application: Mapping[str, Any] | None = None,
    agent_registration: Mapping[str, Any] | None = None,
) -> dict[str, Any]:
    """Build stable Kubernetes-style status conditions for a reconcile result."""

    metadata = _mapping(resource.get("metadata")) or {}
    generation_value = metadata.get("generation", 1)
    generation = (
        generation_value
        if isinstance(generation_value, int) and not isinstance(generation_value, bool)
        else 0
    )
    existing_status = _mapping(resource.get("status")) or {}
    raw_conditions = existing_status.get("conditions")
    current_conditions = (
        [entry for entry in raw_conditions if isinstance(entry, Mapping)]
        if isinstance(raw_conditions, list)
        else []
    )
    result: dict[str, Any] = {
        "phase": phase,
        "observedGeneration": generation,
        "conditions": [
            _condition(
                current_conditions,
                condition_type="Valid",
                status="True" if valid else "False",
                reason="Validated" if valid else reason,
                message="PreviewEnvironment contract is valid" if valid else message,
                generation=generation,
                now=now,
            ),
            _condition(
                current_conditions,
                condition_type="Ready",
                status="True" if ready else "False",
                reason="ResourcesReady" if ready else reason,
                message="Preview workload Application is healthy and synced"
                if ready
                else message,
                generation=generation,
                now=now,
            ),
        ],
    }
    contract_fields = (
        "profile",
        "mode",
        "platformRevision",
        "sourceRevision",
        "images",
        "allocation",
        "expiresAt",
        "namespace",
        "application",
        "agentRegistration",
    )
    if environment is not None:
        application_summary: dict[str, str] = {
            "name": environment.application_name,
            "namespace": environment.namespace,
        }
        if application is not None:
            application_status = _mapping(application.get("status")) or {}
            sync_status = _mapping(application_status.get("sync")) or {}
            health_status = _mapping(application_status.get("health")) or {}
            application_metadata = _mapping(application.get("metadata")) or {}
            application_annotations = (
                _mapping(application_metadata.get("annotations")) or {}
            )
            application_summary.update(
                {
                    "syncStatus": str(sync_status.get("status") or "Unknown"),
                    "healthStatus": str(health_status.get("status") or "Unknown"),
                    "revision": str(sync_status.get("revision") or ""),
                    "reconciledAt": str(application_status.get("reconciledAt") or ""),
                    "contractGeneration": str(
                        application_annotations.get(CONTRACT_GENERATION_ANNOTATION)
                        or ""
                    ),
                }
            )
        result.update(
            {
                "profile": environment.profile,
                "lane": environment.lane,
                "mode": environment.mode,
                "platformRevision": environment.platform_revision,
                "sourceRevision": environment.source_revision,
                "catalogDigest": environment.catalog_digest,
                "candidatePaths": list(environment.candidate_paths),
                "images": dict(environment.images),
                "allocation": {
                    "kind": environment.allocation_kind,
                    **(
                        {
                            "baselinePlatformRevision": (
                                environment.baseline_platform_revision
                            )
                        }
                        if environment.baseline_platform_revision is not None
                        else {}
                    ),
                },
                "expiresAt": environment.expires_at.isoformat().replace("+00:00", "Z"),
                "namespace": environment.namespace,
                "application": application_summary,
                **(
                    {"agentRegistration": dict(agent_registration)}
                    if agent_registration is not None
                    else {}
                ),
            }
        )
    else:
        # Deletion may follow an invalid spec edit. Preserve only fields that
        # previously crossed validation; never copy untrusted spec into status.
        for field in contract_fields:
            if field in existing_status:
                result[field] = existing_status[field]
    # These are independently written by the hub controller and the dev broker.
    # Preserve either half of the durable handshake across ordinary status patches.
    for field in (DELETION_INTENT_STATUS_FIELD, DELETION_ACK_STATUS_FIELD):
        if field in existing_status:
            result[field] = existing_status[field]
    return result


def build_deletion_intent(resource: Mapping[str, Any]) -> dict[str, str]:
    """Derive one immutable, retry-safe physical deletion command."""

    metadata = _mapping(resource.get("metadata")) or {}
    spec = _mapping(resource.get("spec")) or {}
    provenance = _mapping(spec.get("provenance")) or {}
    name = metadata.get("name")
    environment_uid = metadata.get("uid")
    deletion_timestamp = metadata.get("deletionTimestamp")
    request_id = provenance.get("requestId")
    platform_revision = spec.get("platformRevision")
    source_revision = spec.get("sourceRevision")
    catalog_digest = spec.get("catalogDigest")
    finalizers = metadata.get("finalizers") or []
    if (
        not isinstance(name, str)
        or not _ID_PATTERN.fullmatch(name)
        or not isinstance(environment_uid, str)
        or not _KUBERNETES_UID_PATTERN.fullmatch(environment_uid)
        or not isinstance(deletion_timestamp, str)
        or not deletion_timestamp
        or not isinstance(request_id, str)
        or not _REQUEST_ID_PATTERN.fullmatch(request_id)
        or not isinstance(platform_revision, str)
        or not _SHA_PATTERN.fullmatch(platform_revision)
        or not isinstance(source_revision, str)
        or not _SHA_PATTERN.fullmatch(source_revision)
        or not isinstance(catalog_digest, str)
        or not _SHA256_PATTERN.fullmatch(catalog_digest)
        or FINALIZER not in finalizers
    ):
        raise OwnershipConflict("cannot derive an exact physical deletion intent")
    payload = {
        "name": name,
        "environmentUid": environment_uid,
        "requestId": request_id,
        "platformRevision": platform_revision,
        "sourceRevision": source_revision,
        "catalogDigest": catalog_digest,
        "deletionTimestamp": deletion_timestamp,
    }
    canonical = json.dumps(payload, sort_keys=True, separators=(",", ":"))
    return {
        "id": f"sha256:{hashlib.sha256(canonical.encode('utf-8')).hexdigest()}",
        **payload,
    }


def deletion_acknowledgement_is_exact(
    resource: Mapping[str, Any], intent: Mapping[str, str], *, now: datetime
) -> bool:
    status = _mapping(resource.get("status")) or {}
    acknowledgement = _mapping(status.get(DELETION_ACK_STATUS_FIELD))
    if acknowledgement is None:
        return False
    runner = _mapping(acknowledgement.get("runner")) or {}
    checks = _mapping(acknowledgement.get("checks")) or {}
    observed_at_issues: list[str] = []
    observed_at = _parse_utc_timestamp(
        acknowledgement.get("observedAt"),
        "status.deletionAcknowledgement.observedAt",
        observed_at_issues,
    )
    deletion_at = _parse_utc_timestamp(
        intent.get("deletionTimestamp"),
        "status.deletionIntent.deletionTimestamp",
        observed_at_issues,
    )
    return (
        acknowledgement.get("intentId") == intent["id"]
        and acknowledgement.get("environmentUid") == intent["environmentUid"]
        and acknowledgement.get("requestId") == intent["requestId"]
        and acknowledgement.get("platformRevision") == intent["platformRevision"]
        and acknowledgement.get("sourceRevision") == intent["sourceRevision"]
        and acknowledgement.get("catalogDigest") == intent["catalogDigest"]
        and observed_at is not None
        and deletion_at is not None
        and observed_at >= deletion_at
        and observed_at <= now.astimezone(UTC) + timedelta(minutes=5)
        and isinstance(acknowledgement.get("resourceName"), str)
        and acknowledgement.get("resourceName") == intent["name"]
        and isinstance(runner.get("jobName"), str)
        and runner.get("jobName") == f"vcpreview-down-{intent['name']}"
        and isinstance(runner.get("jobUid"), str)
        and _KUBERNETES_UID_PATTERN.fullmatch(str(runner.get("jobUid"))) is not None
        and isinstance(runner.get("generation"), str)
        and _RUNNER_GENERATION_PATTERN.fullmatch(str(runner.get("generation")))
        is not None
        and set(checks) == PHYSICAL_CLEANUP_CHECKS
        and all(checks.get(name) is True for name in PHYSICAL_CLEANUP_CHECKS)
    )


def _api_status(exc: BaseException) -> int | None:
    value = getattr(exc, "status", None)
    return value if isinstance(value, int) else None


def _object_metadata(resource: Any) -> tuple[dict[str, str], dict[str, str]]:
    if isinstance(resource, Mapping):
        metadata = _mapping(resource.get("metadata")) or {}
        return dict(metadata.get("labels") or {}), dict(
            metadata.get("annotations") or {}
        )
    metadata = getattr(resource, "metadata", None)
    return dict(getattr(metadata, "labels", None) or {}), dict(
        getattr(metadata, "annotations", None) or {}
    )


def assert_owned(resource: Any, *, environment_id: str, environment_uid: str) -> None:
    """Refuse adoption unless both controller ownership and CR identity match."""

    labels, _ = _object_metadata(resource)
    if labels.get(MANAGED_BY_LABEL) != MANAGED_BY_VALUE:
        raise OwnershipConflict(
            f"resource exists without {MANAGED_BY_LABEL}={MANAGED_BY_VALUE}"
        )
    if labels.get(ENVIRONMENT_ID_LABEL) != environment_id:
        raise OwnershipConflict("resource belongs to a different preview id")
    if labels.get(ENVIRONMENT_UID_LABEL) != environment_uid:
        raise OwnershipConflict(
            "resource belongs to a different PreviewEnvironment UID"
        )


def _metadata_subset_matches(existing: Any, desired: Mapping[str, Any]) -> bool:
    labels, annotations = _object_metadata(existing)
    desired_metadata = _mapping(desired.get("metadata")) or {}
    desired_labels = _mapping(desired_metadata.get("labels")) or {}
    desired_annotations = _mapping(desired_metadata.get("annotations")) or {}
    return all(
        labels.get(key) == value for key, value in desired_labels.items()
    ) and all(
        annotations.get(key) == value for key, value in desired_annotations.items()
    )


class PreviewEnvironmentController:
    """Small reconciliation adapter around CoreV1 and CustomObjects APIs."""

    def __init__(
        self,
        *,
        core_api: Any,
        custom_api: Any,
        catalog: PreviewServiceCatalog,
        registration_adapter: PreviewAgentRegistrationAdapter | None = None,
        dashboard_cleanup_adapter: PreviewDashboardCleanupPort | None = None,
        candidate_surface: ManifestCandidateSurface | None = None,
        now: Callable[[], datetime] | None = None,
        watch_factory: Callable[[], Any] = watch.Watch,
        full_resync_seconds: int = 60,
        sleep: Callable[[float], None] = time.sleep,
    ) -> None:
        self.core_api = core_api
        self.custom_api = custom_api
        self.catalog = catalog
        self.registration_adapter = registration_adapter
        self.dashboard_cleanup_adapter = dashboard_cleanup_adapter
        self.candidate_surface = candidate_surface
        self.now = now or (lambda: datetime.now(UTC))
        self.watch_factory = watch_factory
        self.full_resync_seconds = max(10, full_resync_seconds)
        self.sleep = sleep

    def _get_application(self, namespace: str, name: str) -> dict[str, Any] | None:
        try:
            return self.custom_api.get_namespaced_custom_object(
                group=ARGO_GROUP,
                version=ARGO_VERSION,
                namespace=namespace,
                plural=ARGO_APPLICATIONS_PLURAL,
                name=name,
            )
        except ApiException as exc:
            if _api_status(exc) == 404:
                return None
            raise

    def _get_app_project(
        self, namespace: str, name: str = "default"
    ) -> dict[str, Any] | None:
        try:
            return self.custom_api.get_namespaced_custom_object(
                group=ARGO_GROUP,
                version=ARGO_VERSION,
                namespace=namespace,
                plural=ARGO_PROJECTS_PLURAL,
                name=name,
            )
        except ApiException as exc:
            if _api_status(exc) == 404:
                return None
            raise

    def _get_namespace(self, name: str) -> Any | None:
        try:
            return self.core_api.read_namespace(name=name)
        except ApiException as exc:
            if _api_status(exc) == 404:
                return None
            raise

    def _ensure_finalizer(self, resource: Mapping[str, Any]) -> bool:
        metadata = _mapping(resource.get("metadata")) or {}
        finalizers = list(metadata.get("finalizers") or [])
        required = [FINALIZER]
        if self.registration_adapter is not None:
            required.append(REGISTRATION_FINALIZER)
        if self.dashboard_cleanup_adapter is not None:
            required.append(DASHBOARD_REGISTRATION_FINALIZER)
        missing = [value for value in required if value not in finalizers]
        if not missing:
            return False
        finalizers.extend(missing)
        patch_metadata: dict[str, Any] = {"finalizers": finalizers}
        if isinstance(metadata.get("resourceVersion"), str):
            patch_metadata["resourceVersion"] = metadata["resourceVersion"]
        self.custom_api.patch_namespaced_custom_object(
            group=API_GROUP,
            version=API_VERSION,
            namespace=CONTROL_NAMESPACE,
            plural=API_PLURAL,
            name=metadata["name"],
            body={"metadata": patch_metadata},
        )
        return True

    def _remove_finalizer(self, resource: Mapping[str, Any]) -> None:
        metadata = _mapping(resource.get("metadata")) or {}
        finalizers = [
            value
            for value in list(metadata.get("finalizers") or [])
            if value != FINALIZER
        ]
        patch_metadata: dict[str, Any] = {"finalizers": finalizers}
        if isinstance(metadata.get("resourceVersion"), str):
            patch_metadata["resourceVersion"] = metadata["resourceVersion"]
        self.custom_api.patch_namespaced_custom_object(
            group=API_GROUP,
            version=API_VERSION,
            namespace=CONTROL_NAMESPACE,
            plural=API_PLURAL,
            name=metadata["name"],
            body={"metadata": patch_metadata},
        )

    def _remove_registration_finalizer(self, resource: Mapping[str, Any]) -> None:
        metadata = _mapping(resource.get("metadata")) or {}
        finalizers = [
            value
            for value in list(metadata.get("finalizers") or [])
            if value != REGISTRATION_FINALIZER
        ]
        patch_metadata: dict[str, Any] = {"finalizers": finalizers}
        if isinstance(metadata.get("resourceVersion"), str):
            patch_metadata["resourceVersion"] = metadata["resourceVersion"]
        self.custom_api.patch_namespaced_custom_object(
            group=API_GROUP,
            version=API_VERSION,
            namespace=CONTROL_NAMESPACE,
            plural=API_PLURAL,
            name=metadata["name"],
            body={"metadata": patch_metadata},
        )

    def _remove_dashboard_registration_finalizer(
        self, resource: Mapping[str, Any]
    ) -> None:
        metadata = _mapping(resource.get("metadata")) or {}
        finalizers = [
            value
            for value in list(metadata.get("finalizers") or [])
            if value != DASHBOARD_REGISTRATION_FINALIZER
        ]
        patch_metadata: dict[str, Any] = {"finalizers": finalizers}
        if isinstance(metadata.get("resourceVersion"), str):
            patch_metadata["resourceVersion"] = metadata["resourceVersion"]
        self.custom_api.patch_namespaced_custom_object(
            group=API_GROUP,
            version=API_VERSION,
            namespace=CONTROL_NAMESPACE,
            plural=API_PLURAL,
            name=metadata["name"],
            body={"metadata": patch_metadata},
        )

    def _patch_status(
        self,
        resource: Mapping[str, Any],
        *,
        phase: str,
        valid: bool,
        ready: bool,
        reason: str,
        message: str,
        environment: ValidatedPreviewEnvironment | None = None,
        application: Mapping[str, Any] | None = None,
        agent_registration: Mapping[str, Any] | None = None,
        extra_status: Mapping[str, Any] | None = None,
    ) -> None:
        metadata = _mapping(resource.get("metadata")) or {}
        desired = build_status(
            resource,
            phase=phase,
            valid=valid,
            ready=ready,
            reason=reason,
            message=message[:1024],
            now=self.now(),
            environment=environment,
            application=application,
            agent_registration=agent_registration,
        )
        if extra_status is not None:
            desired.update(dict(extra_status))
        if resource.get("status") == desired:
            return
        self.custom_api.patch_namespaced_custom_object_status(
            group=API_GROUP,
            version=API_VERSION,
            namespace=CONTROL_NAMESPACE,
            plural=API_PLURAL,
            name=metadata["name"],
            body={"status": desired},
        )

    def _upsert_namespace(self, environment: ValidatedPreviewEnvironment) -> Any:
        desired = build_namespace_manifest(environment)
        existing = self._get_namespace(environment.namespace)
        if existing is None:
            try:
                return self.core_api.create_namespace(body=desired)
            except ApiException as exc:
                if _api_status(exc) != 409:
                    raise
                existing = self._get_namespace(environment.namespace)
                if existing is None:
                    raise
        assert_owned(
            existing,
            environment_id=environment.id,
            environment_uid=environment.uid,
        )
        if not _metadata_subset_matches(existing, desired):
            return self.core_api.patch_namespace(
                name=environment.namespace,
                body={"metadata": desired["metadata"]},
            )
        return existing

    def _upsert_app_project(
        self, environment: ValidatedPreviewEnvironment
    ) -> dict[str, Any]:
        desired = build_app_project_manifest(environment)
        existing = self._get_app_project(environment.namespace)
        if existing is None:
            try:
                return self.custom_api.create_namespaced_custom_object(
                    group=ARGO_GROUP,
                    version=ARGO_VERSION,
                    namespace=environment.namespace,
                    plural=ARGO_PROJECTS_PLURAL,
                    body=desired,
                )
            except ApiException as exc:
                if _api_status(exc) != 409:
                    raise
                existing = self._get_app_project(environment.namespace)
                if existing is None:
                    raise
        assert_owned(
            existing,
            environment_id=environment.id,
            environment_uid=environment.uid,
        )
        if (
            not _metadata_subset_matches(existing, desired)
            or existing.get("spec") != desired["spec"]
        ):
            return self.custom_api.patch_namespaced_custom_object(
                group=ARGO_GROUP,
                version=ARGO_VERSION,
                namespace=environment.namespace,
                plural=ARGO_PROJECTS_PLURAL,
                name="default",
                body={
                    "metadata": desired["metadata"],
                    "spec": desired["spec"],
                },
            )
        return existing

    def _upsert_application(
        self, environment: ValidatedPreviewEnvironment
    ) -> dict[str, Any]:
        desired = build_application_manifest(
            environment, candidate_surface=self.candidate_surface
        )
        existing = self._get_application(
            environment.namespace, environment.application_name
        )
        if existing is None:
            desired = build_application_manifest(
                environment,
                candidate_surface=self.candidate_surface,
                reconcile_requested_at=self.now(),
            )
            try:
                return self.custom_api.create_namespaced_custom_object(
                    group=ARGO_GROUP,
                    version=ARGO_VERSION,
                    namespace=environment.namespace,
                    plural=ARGO_APPLICATIONS_PLURAL,
                    body=desired,
                )
            except ApiException as exc:
                if _api_status(exc) != 409:
                    raise
                existing = self._get_application(
                    environment.namespace, environment.application_name
                )
                if existing is None:
                    raise
        assert_owned(
            existing,
            environment_id=environment.id,
            environment_uid=environment.uid,
        )
        existing_metadata = _mapping(existing.get("metadata")) or {}
        existing_annotations = _mapping(existing_metadata.get("annotations")) or {}
        existing_finalizers = list(existing_metadata.get("finalizers") or [])
        desired_finalizers = desired["metadata"]["finalizers"]
        needs_update = (
            not _metadata_subset_matches(existing, desired)
            or existing.get("spec") != desired["spec"]
            or any(value not in existing_finalizers for value in desired_finalizers)
            or _parse_utc_timestamp(
                existing_annotations.get(RECONCILE_REQUESTED_AT_ANNOTATION),
                RECONCILE_REQUESTED_AT_ANNOTATION,
                [],
            )
            is None
        )
        if needs_update:
            desired = build_application_manifest(
                environment,
                candidate_surface=self.candidate_surface,
                reconcile_requested_at=self.now(),
            )
            return self.custom_api.patch_namespaced_custom_object(
                group=ARGO_GROUP,
                version=ARGO_VERSION,
                namespace=environment.namespace,
                plural=ARGO_APPLICATIONS_PLURAL,
                name=environment.application_name,
                body={
                    "metadata": desired["metadata"],
                    "spec": desired["spec"],
                },
            )
        return existing

    def _remove_application_resource_finalizer(
        self,
        application: Mapping[str, Any],
        *,
        namespace: str,
        name: str,
    ) -> None:
        """Relinquish Argo's remote-resource cleanup before vCluster teardown.

        The preview agent may already be unavailable. Waiting for Argo's resources
        finalizer in that state deadlocks the PreviewEnvironment finalizer, while the
        vCluster down-runner is the actual cleanup boundary for remote workloads.
        """
        metadata = _mapping(application.get("metadata")) or {}
        finalizers = [
            value
            for value in list(metadata.get("finalizers") or [])
            if value != ARGO_RESOURCE_FINALIZER
        ]
        if finalizers == list(metadata.get("finalizers") or []):
            return
        patch_metadata: dict[str, Any] = {"finalizers": finalizers}
        if isinstance(metadata.get("resourceVersion"), str):
            patch_metadata["resourceVersion"] = metadata["resourceVersion"]
        self.custom_api.patch_namespaced_custom_object(
            group=ARGO_GROUP,
            version=ARGO_VERSION,
            namespace=namespace,
            plural=ARGO_APPLICATIONS_PLURAL,
            name=name,
            body={"metadata": patch_metadata},
        )

    def _delete_expired(
        self,
        resource: Mapping[str, Any],
        environment: ValidatedPreviewEnvironment,
    ) -> None:
        self._patch_status(
            resource,
            phase="Expired",
            valid=True,
            ready=False,
            reason="TTLExpired",
            message=(
                "PreviewEnvironment TTL has expired; the application lifecycle "
                "reaper must complete any required archive and initiate deletion"
            ),
            environment=environment,
        )

    def _reconcile_deletion(self, resource: Mapping[str, Any]) -> None:
        metadata = _mapping(resource.get("metadata")) or {}
        finalizers = list(metadata.get("finalizers") or [])
        preview_id = metadata.get("name")
        uid = metadata.get("uid")
        if (
            not isinstance(preview_id, str)
            or not _ID_PATTERN.fullmatch(preview_id)
            or not isinstance(uid, str)
            or not uid
        ):
            raise OwnershipConflict("cannot derive a safe cleanup identity")
        if FINALIZER not in finalizers:
            if DASHBOARD_REGISTRATION_FINALIZER in finalizers:
                if self.dashboard_cleanup_adapter is None:
                    raise OwnershipConflict(
                        "Headlamp registration finalizer has no configured adapter"
                    )
                complete = self.dashboard_cleanup_adapter.cleanup(
                    preview_id=preview_id,
                    environment_uid=uid,
                )
                if complete:
                    self._remove_dashboard_registration_finalizer(resource)
                else:
                    self._patch_status(
                        resource,
                        phase="Terminating",
                        valid=True,
                        ready=False,
                        reason="DeletingHeadlampRegistration",
                        message=(
                            "Waiting for preview Headlamp registration resources "
                            "to disappear"
                        ),
                    )
                return
            if REGISTRATION_FINALIZER in finalizers:
                if self.registration_adapter is None:
                    raise OwnershipConflict(
                        "agent registration finalizer has no configured adapter"
                    )
                complete = self.registration_adapter.cleanup(
                    preview_id=preview_id,
                    environment_uid=uid,
                )
                if complete:
                    self._remove_registration_finalizer(resource)
                else:
                    self._patch_status(
                        resource,
                        phase="Terminating",
                        valid=True,
                        ready=False,
                        reason="DeletingAgentRegistration",
                        message=(
                            "Waiting for preview agent registration resources "
                            "to disappear"
                        ),
                    )
            return

        intent = build_deletion_intent(resource)
        current_status = _mapping(resource.get("status")) or {}
        observed_intent = _mapping(current_status.get(DELETION_INTENT_STATUS_FIELD))
        if observed_intent != intent:
            # Status is the durable outbox. No hub or dev resource is removed until
            # the exact command is visible to the dev-side consumer.
            self._patch_status(
                resource,
                phase="Terminating",
                valid=True,
                ready=False,
                reason="PhysicalCleanupRequested",
                message="Waiting for the dev cleanup broker to consume the deletion intent",
                extra_status={DELETION_INTENT_STATUS_FIELD: intent},
            )
            return
        if not deletion_acknowledgement_is_exact(resource, intent, now=self.now()):
            self._patch_status(
                resource,
                phase="Terminating",
                valid=True,
                ready=False,
                reason="WaitingForPhysicalCleanup",
                message="Waiting for exact SEA down-runner absence proof",
            )
            return

        namespace = f"preview-{preview_id}"
        application_name = f"preview-{preview_id}-workflow-builder"

        application = self._get_application(namespace, application_name)
        if application is not None:
            assert_owned(application, environment_id=preview_id, environment_uid=uid)
            try:
                self._remove_application_resource_finalizer(
                    application,
                    namespace=namespace,
                    name=application_name,
                )
                self.custom_api.delete_namespaced_custom_object(
                    group=ARGO_GROUP,
                    version=ARGO_VERSION,
                    namespace=namespace,
                    plural=ARGO_APPLICATIONS_PLURAL,
                    name=application_name,
                    body={
                        "apiVersion": "v1",
                        "kind": "DeleteOptions",
                        "propagationPolicy": "Foreground",
                    },
                )
            except ApiException as exc:
                if _api_status(exc) != 404:
                    raise
            self._patch_status(
                resource,
                phase="Terminating",
                valid=True,
                ready=False,
                reason="DeletingApplication",
                message="Waiting for the Argo CD Application to be deleted",
            )
            return

        namespace_resource = self._get_namespace(namespace)
        if namespace_resource is not None:
            assert_owned(
                namespace_resource,
                environment_id=preview_id,
                environment_uid=uid,
            )
            self.core_api.delete_namespace(
                name=namespace,
                body=client.V1DeleteOptions(propagation_policy="Foreground"),
            )
            self._patch_status(
                resource,
                phase="Terminating",
                valid=True,
                ready=False,
                reason="DeletingNamespace",
                message="Waiting for the preview hub namespace to be deleted",
            )
            return

        if DASHBOARD_REGISTRATION_FINALIZER in finalizers:
            if self.dashboard_cleanup_adapter is None:
                raise OwnershipConflict(
                    "Headlamp registration finalizer has no configured adapter"
                )
            complete = self.dashboard_cleanup_adapter.cleanup(
                preview_id=preview_id,
                environment_uid=uid,
            )
            if not complete:
                self._patch_status(
                    resource,
                    phase="Terminating",
                    valid=True,
                    ready=False,
                    reason="DeletingHeadlampRegistration",
                    message=(
                        "Waiting for preview Headlamp registration resources "
                        "to disappear"
                    ),
                )
                return
            self._remove_dashboard_registration_finalizer(resource)
            return

        if REGISTRATION_FINALIZER in finalizers:
            if self.registration_adapter is None:
                raise OwnershipConflict(
                    "agent registration finalizer has no configured adapter"
                )
            complete = self.registration_adapter.cleanup(
                preview_id=preview_id,
                environment_uid=uid,
            )
            if not complete:
                self._patch_status(
                    resource,
                    phase="Terminating",
                    valid=True,
                    ready=False,
                    reason="DeletingAgentRegistration",
                    message="Waiting for preview agent registration resources to disappear",
                )
                return
            self._remove_registration_finalizer(resource)
            return

        self._remove_finalizer(resource)

    def reconcile(self, resource: Mapping[str, Any]) -> None:
        """Reconcile a single watch/list snapshot."""

        metadata = _mapping(resource.get("metadata")) or {}
        if metadata.get("namespace") not in (None, CONTROL_NAMESPACE):
            return
        if metadata.get("deletionTimestamp"):
            try:
                self._reconcile_deletion(resource)
            except (
                OwnershipConflict,
                PreviewAgentRegistrationOwnershipError,
                PreviewDashboardCleanupOwnershipError,
            ) as exc:
                self._patch_status(
                    resource,
                    phase="Blocked",
                    valid=True,
                    ready=False,
                    reason="OwnershipConflict",
                    message=str(exc),
                )
            return

        try:
            environment = validate_preview_environment(
                resource,
                catalog=self.catalog,
                candidate_surface=self.candidate_surface,
            )
        except SpecValidationError as exc:
            self._patch_status(
                resource,
                phase="Failed",
                valid=False,
                ready=False,
                reason="InvalidSpec",
                message=str(exc),
            )
            return

        if self._ensure_finalizer(resource):
            return
        if self.now().astimezone(UTC) >= environment.expires_at:
            self._delete_expired(resource, environment)
            return

        registration_status: PreviewAgentRegistrationStatus | None = None
        if self.registration_adapter is not None:
            try:
                registration_status = self.registration_adapter.ensure(environment)
            except PreviewAgentRegistrationOwnershipError as exc:
                self._patch_status(
                    resource,
                    phase="Blocked",
                    valid=True,
                    ready=False,
                    reason="AgentRegistrationOwnershipConflict",
                    message=str(exc),
                    environment=environment,
                )
                return
            except PreviewAgentRegistrationError as exc:
                self._patch_status(
                    resource,
                    phase="Blocked",
                    valid=True,
                    ready=False,
                    reason="InvalidAgentRegistration",
                    message=str(exc),
                    environment=environment,
                )
                return
            if not registration_status.ready:
                self._patch_status(
                    resource,
                    phase="Provisioning",
                    valid=True,
                    ready=False,
                    reason=registration_status.reason,
                    message="Waiting for the bounded preview agent certificate",
                    environment=environment,
                    agent_registration=registration_status.as_status(),
                )
                return

        try:
            self._upsert_namespace(environment)
            self._upsert_app_project(environment)
            application = self._upsert_application(environment)
        except OwnershipConflict as exc:
            self._patch_status(
                resource,
                phase="Blocked",
                valid=True,
                ready=False,
                reason="OwnershipConflict",
                message=str(exc),
                environment=environment,
            )
            return

        ready = application_is_ready(application, environment)
        self._patch_status(
            resource,
            phase="Ready" if ready else "Provisioning",
            valid=True,
            ready=ready,
            reason="ResourcesReady" if ready else "WaitingForApplication",
            message="Preview workload Application is healthy and synced"
            if ready
            else "Waiting for the Argo CD Application to become healthy and synced",
            environment=environment,
            application=application,
            agent_registration=(
                registration_status.as_status()
                if registration_status is not None
                else None
            ),
        )

    def full_reconcile(self) -> str | None:
        """List the fixed namespace and reconcile every current resource."""

        response = self.custom_api.list_namespaced_custom_object(
            group=API_GROUP,
            version=API_VERSION,
            namespace=CONTROL_NAMESPACE,
            plural=API_PLURAL,
        )
        for resource in response.get("items", []):
            if not isinstance(resource, Mapping):
                continue
            try:
                self.reconcile(resource)
            except Exception:
                logger.exception(
                    "PreviewEnvironment full reconcile failed for %s",
                    (_mapping(resource.get("metadata")) or {}).get("name", "unknown"),
                )
        metadata = _mapping(response.get("metadata")) or {}
        resource_version = metadata.get("resourceVersion")
        return resource_version if isinstance(resource_version, str) else None

    def watch_cycle(self, resource_version: str | None) -> None:
        """Watch until timeout; ERROR/410 returns to a fresh full list."""

        watcher = self.watch_factory()
        for event in watcher.stream(
            self.custom_api.list_namespaced_custom_object,
            group=API_GROUP,
            version=API_VERSION,
            namespace=CONTROL_NAMESPACE,
            plural=API_PLURAL,
            resource_version=resource_version,
            timeout_seconds=self.full_resync_seconds,
        ):
            event_type = event.get("type") if isinstance(event, Mapping) else None
            resource = event.get("object") if isinstance(event, Mapping) else None
            if event_type == "ERROR":
                code = resource.get("code") if isinstance(resource, Mapping) else None
                if code == 410:
                    logger.info("PreviewEnvironment watch resourceVersion expired")
                    return
                raise RuntimeError(f"PreviewEnvironment watch error: {resource!r}")
            if event_type == "DELETED" or not isinstance(resource, Mapping):
                continue
            try:
                self.reconcile(resource)
            except Exception:
                logger.exception(
                    "PreviewEnvironment watch reconcile failed for %s",
                    (_mapping(resource.get("metadata")) or {}).get("name", "unknown"),
                )

    def run_forever(self, stop_event: threading.Event | None = None) -> None:
        """Run list/watch cycles with full resync and robust 410 recovery."""

        stop = stop_event or threading.Event()
        backoff = 1.0
        while not stop.is_set():
            try:
                resource_version = self.full_reconcile()
                if stop.is_set():
                    return
                self.watch_cycle(resource_version)
                backoff = 1.0
            except ApiException as exc:
                if _api_status(exc) == 410:
                    logger.info("PreviewEnvironment list/watch returned 410; relisting")
                    backoff = 1.0
                    continue
                logger.exception("PreviewEnvironment Kubernetes API failure")
                self.sleep(backoff)
                backoff = min(backoff * 2, 30.0)
            except Exception:
                logger.exception("PreviewEnvironment controller loop failure")
                self.sleep(backoff)
                backoff = min(backoff * 2, 30.0)


def create_controller() -> PreviewEnvironmentController:
    """Load hub Kubernetes credentials and construct the production controller."""

    try:
        config.load_incluster_config()
    except ConfigException:
        config.load_kube_config()
    api_client = client.ApiClient(client.Configuration.get_default_copy())
    catalog_path = os.environ.get(
        SERVICE_CATALOG_PATH_ENV, DEFAULT_SERVICE_CATALOG_PATH
    ).strip()
    if not catalog_path:
        raise CatalogValidationError(f"{SERVICE_CATALOG_PATH_ENV} must not be empty")
    catalog = load_preview_service_catalog(catalog_path)
    candidate_surface_path = os.environ.get(
        MANIFEST_CANDIDATE_SURFACE_PATH_ENV,
        DEFAULT_MANIFEST_CANDIDATE_SURFACE_PATH,
    ).strip()
    if not candidate_surface_path:
        raise CatalogValidationError(
            f"{MANIFEST_CANDIDATE_SURFACE_PATH_ENV} must not be empty"
        )
    candidate_surface = load_manifest_candidate_surface(candidate_surface_path)
    core_api = client.CoreV1Api(api_client)
    custom_api = client.CustomObjectsApi(api_client)
    return PreviewEnvironmentController(
        core_api=core_api,
        custom_api=custom_api,
        catalog=catalog,
        candidate_surface=candidate_surface,
        registration_adapter=PreviewAgentRegistrationAdapter(
            core_api=core_api,
            custom_api=custom_api,
        ),
        dashboard_cleanup_adapter=KubernetesPreviewDashboardCleanupAdapter(
            core_api=core_api,
        ),
    )


def main() -> None:
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s %(message)s",
    )
    stop = threading.Event()

    def request_stop(_signum: int, _frame: Any) -> None:
        stop.set()

    signal.signal(signal.SIGTERM, request_stop)
    signal.signal(signal.SIGINT, request_stop)
    create_controller().run_forever(stop)


if __name__ == "__main__":
    main()

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Any


CONTROL_NAMESPACE = "preview-control-system"
BOOTSTRAP_CLUSTER_ROLE = "vcluster-preview-bootstrap"
CONTROL_ROLE = "vcluster-preview-control"
NAMESPACE_CLUSTER_ROLE = "vcluster-preview-namespace"
RUNNER_GENERATION_ANNOTATION = "preview.stacks.io/runner-generation"

_PREVIEW_NAME_RE = re.compile(r"^[a-z0-9]([-a-z0-9]*[a-z0-9])?$")
_RUNNER_GENERATION_RE = re.compile(r"^op:[0-9a-f]{32}$")
_NOT_FOUND = 404


class PreviewRunnerIdentityError(RuntimeError):
    """The physical runner identity is absent, malformed, or unprovable."""


def _value(value: Any, *path: str, default: Any = None) -> Any:
    current = value
    for segment in path:
        if isinstance(current, dict):
            current = current.get(segment, default)
        else:
            current = getattr(current, segment, default)
        if current is default:
            return default
    return current


def _labels(value: Any) -> dict[str, str]:
    labels = _value(value, "metadata", "labels", default={}) or {}
    return dict(labels)


def _subject_contract(value: Any) -> tuple[str, str, str, str]:
    subjects = _value(value, "subjects", default=[]) or []
    if len(subjects) != 1:
        raise PreviewRunnerIdentityError("runner binding must have one subject")
    subject = subjects[0]
    return (
        _value(subject, "kind", default="") or "",
        _value(subject, "name", default="") or "",
        _value(subject, "namespace", default="") or "",
        _value(subject, "api_group", default=None)
        or _value(subject, "apiGroup", default="")
        or "",
    )


def _role_ref_contract(value: Any) -> tuple[str, str, str]:
    role_ref = _value(value, "role_ref", default=None) or _value(
        value, "roleRef", default={}
    )
    return (
        _value(role_ref, "api_group", default=None)
        or _value(role_ref, "apiGroup", default="")
        or "",
        _value(role_ref, "kind", default="") or "",
        _value(role_ref, "name", default="") or "",
    )


def preview_runner_identity_name(preview_name: str) -> str:
    if len(preview_name) > 40 or not _PREVIEW_NAME_RE.fullmatch(preview_name):
        raise PreviewRunnerIdentityError("preview name is not a bounded DNS label")
    return f"vcpreview-{preview_name}"


@dataclass(frozen=True)
class PreviewRunnerIdentityContract:
    preview_name: str
    lifecycle: str | None = None

    def __post_init__(self) -> None:
        preview_runner_identity_name(self.preview_name)
        if self.lifecycle not in {None, "ephemeral", "retained"}:
            raise PreviewRunnerIdentityError("preview lifecycle is invalid")

    @property
    def identity_name(self) -> str:
        return preview_runner_identity_name(self.preview_name)

    @property
    def target_namespace(self) -> str:
        return f"vcluster-{self.preview_name}"

    @property
    def identity_labels(self) -> dict[str, str]:
        return {
            "preview.stacks.io/managed": "true",
            "preview.stacks.io/preview-name": self.preview_name,
        }

    def namespace_labels(self, lifecycle: str) -> dict[str, str]:
        if lifecycle not in {"ephemeral", "retained"}:
            raise PreviewRunnerIdentityError("preview lifecycle is invalid")
        return {
            **self.identity_labels,
            "app": "vcluster-preview",
            "vcluster-preview-name": self.preview_name,
            "vcluster-preview-lifecycle": lifecycle,
            "pod-security.kubernetes.io/enforce": "restricted",
            "pod-security.kubernetes.io/enforce-version": "latest",
            "pod-security.kubernetes.io/audit": "restricted",
            "pod-security.kubernetes.io/audit-version": "latest",
            "pod-security.kubernetes.io/warn": "restricted",
            "pod-security.kubernetes.io/warn-version": "latest",
        }

    def namespace_body(self) -> dict[str, Any]:
        if self.lifecycle is None:
            raise PreviewRunnerIdentityError("new preview namespace requires lifecycle")
        return {
            "apiVersion": "v1",
            "kind": "Namespace",
            "metadata": {
                "name": self.target_namespace,
                "labels": {
                    **self.namespace_labels(self.lifecycle),
                    "preview.stacks.io/runner-admitted": "false",
                },
            },
        }

    def service_account_body(self) -> dict[str, Any]:
        return {
            "apiVersion": "v1",
            "kind": "ServiceAccount",
            "metadata": {
                "name": self.identity_name,
                "namespace": CONTROL_NAMESPACE,
                "labels": self.identity_labels,
            },
            "automountServiceAccountToken": True,
        }

    def cluster_role_binding_body(self) -> dict[str, Any]:
        return {
            "apiVersion": "rbac.authorization.k8s.io/v1",
            "kind": "ClusterRoleBinding",
            "metadata": {
                "name": self.identity_name,
                "labels": self.identity_labels,
            },
            "roleRef": {
                "apiGroup": "rbac.authorization.k8s.io",
                "kind": "ClusterRole",
                "name": BOOTSTRAP_CLUSTER_ROLE,
            },
            "subjects": [
                {
                    "apiGroup": "",
                    "kind": "ServiceAccount",
                    "name": self.identity_name,
                    "namespace": CONTROL_NAMESPACE,
                }
            ],
        }

    def control_role_binding_body(self) -> dict[str, Any]:
        return self._role_binding_body(
            namespace=CONTROL_NAMESPACE,
            role_kind="Role",
            role_name=CONTROL_ROLE,
        )

    def target_role_binding_body(self) -> dict[str, Any]:
        return self._role_binding_body(
            namespace=self.target_namespace,
            role_kind="ClusterRole",
            role_name=NAMESPACE_CLUSTER_ROLE,
        )

    def _role_binding_body(
        self, *, namespace: str, role_kind: str, role_name: str
    ) -> dict[str, Any]:
        return {
            "apiVersion": "rbac.authorization.k8s.io/v1",
            "kind": "RoleBinding",
            "metadata": {
                "name": self.identity_name,
                "namespace": namespace,
                "labels": self.identity_labels,
            },
            "roleRef": {
                "apiGroup": "rbac.authorization.k8s.io",
                "kind": role_kind,
                "name": role_name,
            },
            "subjects": [
                {
                    "apiGroup": "",
                    "kind": "ServiceAccount",
                    "name": self.identity_name,
                    "namespace": CONTROL_NAMESPACE,
                }
            ],
        }


@dataclass(frozen=True)
class PreviewRunnerIdentityReservation:
    identity_name: str
    preview_name: str
    created: tuple[tuple[str, str], ...]
    namespace_created: bool
    namespace_ready_before: bool
    target_namespace_present: bool
    runner_generation: str


class PreviewRunnerIdentityAdapter:
    """Kubernetes adapter for the bounded per-preview runner identity."""

    def __init__(self, core: Any, rbac: Any) -> None:
        self._core = core
        self._rbac = rbac

    def ensure_for_job(
        self,
        *,
        preview_name: str,
        action: str,
        lifecycle: str | None,
        runner_generation: str,
        allow_absent_down_bootstrap: bool = False,
    ) -> PreviewRunnerIdentityReservation:
        if not _RUNNER_GENERATION_RE.fullmatch(runner_generation):
            raise PreviewRunnerIdentityError("runner generation is invalid")
        if allow_absent_down_bootstrap and action != "down":
            raise PreviewRunnerIdentityError(
                "absent identity bootstrap is allowed only for down"
            )
        contract = PreviewRunnerIdentityContract(preview_name, lifecycle)
        namespace = self._read_optional(
            lambda: self._core.read_namespace(name=contract.target_namespace),
            f"namespace {contract.target_namespace}",
        )
        namespace_created = False
        namespace_ready_before = bool(
            namespace is not None
            and _labels(namespace).get("preview.stacks.io/identity-ready") == "true"
        )
        created: list[tuple[str, str]] = []
        try:
            if namespace is None:
                if action == "down":
                    target_required = False
                elif action == "up":
                    namespace_created = True
                    try:
                        namespace = self._core.create_namespace(
                            body=contract.namespace_body()
                        )
                    except Exception as create_exc:
                        namespace = self._read_optional(
                            lambda: self._core.read_namespace(
                                name=contract.target_namespace
                            ),
                            f"namespace {contract.target_namespace} after create error",
                        )
                        if namespace is None:
                            raise PreviewRunnerIdentityError(
                                f"namespace create failed: {create_exc}"
                            ) from create_exc
                        self._validate_namespace(contract, namespace)
                    target_required = True
                else:
                    raise PreviewRunnerIdentityError(
                        f"{action} requires existing namespace {contract.target_namespace}"
                    )
            else:
                target_required = True
                self._validate_namespace(
                    contract,
                    namespace,
                    require_admitted=action != "up",
                )

            if target_required:
                self._ensure_service_account(contract, created)
                self._ensure_cluster_role_binding(contract, created)
                self._ensure_control_role_binding(contract, created)
                self._ensure_target_role_binding(contract, created)
            else:
                if allow_absent_down_bootstrap:
                    self._ensure_service_account(contract, created)
                    self._ensure_cluster_role_binding(contract, created)
                    self._ensure_control_role_binding(contract, created)
                else:
                    self._require_residual_down_identity(contract)
                target = self._read_optional(
                    lambda: self._rbac.read_namespaced_role_binding(
                        name=contract.identity_name,
                        namespace=contract.target_namespace,
                    ),
                    f"target RoleBinding {contract.identity_name}",
                )
                if target is not None:
                    raise PreviewRunnerIdentityError(
                        "target RoleBinding exists while target namespace is absent"
                    )

            self._validate_service_account(
                contract,
                self._core.read_namespaced_service_account(
                    name=contract.identity_name, namespace=CONTROL_NAMESPACE
                ),
            )
            self._validate_cluster_role_binding(
                contract,
                self._rbac.read_cluster_role_binding(name=contract.identity_name),
            )
            self._validate_role_binding(
                contract,
                self._rbac.read_namespaced_role_binding(
                    name=contract.identity_name, namespace=CONTROL_NAMESPACE
                ),
                namespace=CONTROL_NAMESPACE,
                role_kind="Role",
                role_name=CONTROL_ROLE,
            )
            if target_required:
                self._validate_role_binding(
                    contract,
                    self._rbac.read_namespaced_role_binding(
                        name=contract.identity_name,
                        namespace=contract.target_namespace,
                    ),
                    namespace=contract.target_namespace,
                    role_kind="ClusterRole",
                    role_name=NAMESPACE_CLUSTER_ROLE,
                )
                self._core.patch_namespace(
                    name=contract.target_namespace,
                    body={
                        "metadata": {
                            "labels": {
                                **contract.identity_labels,
                                "preview.stacks.io/identity-ready": "true",
                            },
                            "annotations": {
                                RUNNER_GENERATION_ANNOTATION: runner_generation
                            },
                        }
                    },
                )
                ready_namespace = self._core.read_namespace(
                    name=contract.target_namespace
                )
                self._validate_namespace(
                    contract,
                    ready_namespace,
                    require_ready=True,
                    runner_generation=runner_generation,
                )
            return PreviewRunnerIdentityReservation(
                identity_name=contract.identity_name,
                preview_name=preview_name,
                created=tuple(created),
                namespace_created=namespace_created,
                namespace_ready_before=namespace_ready_before,
                target_namespace_present=target_required,
                runner_generation=runner_generation,
            )
        except Exception as exc:
            try:
                self._rollback(
                    contract,
                    created,
                    namespace_created,
                    clear_ready=(
                        bool(created)
                        and not namespace_created
                        and not namespace_ready_before
                    ),
                )
            except PreviewRunnerIdentityError as rollback_exc:
                raise PreviewRunnerIdentityError(
                    f"runner identity establishment failed ({exc}); "
                    f"compensation incomplete ({rollback_exc})"
                ) from exc
            if isinstance(exc, PreviewRunnerIdentityError):
                raise
            raise PreviewRunnerIdentityError(
                f"could not establish runner identity for {preview_name}: {exc}"
            ) from exc

    def rollback_before_job(
        self, reservation: PreviewRunnerIdentityReservation
    ) -> None:
        contract = PreviewRunnerIdentityContract(reservation.preview_name)
        self._rollback(
            contract,
            list(reservation.created),
            reservation.namespace_created,
            clear_ready=(
                bool(reservation.created)
                and not reservation.namespace_created
                and not reservation.namespace_ready_before
            ),
        )

    def mark_job_admitted(self, reservation: PreviewRunnerIdentityReservation) -> None:
        if not reservation.target_namespace_present:
            return
        contract = PreviewRunnerIdentityContract(reservation.preview_name)
        try:
            namespace = self._core.read_namespace(name=contract.target_namespace)
            self._validate_namespace(
                contract,
                namespace,
                require_ready=True,
                runner_generation=reservation.runner_generation,
            )
            self._core.patch_namespace(
                name=contract.target_namespace,
                body={
                    "metadata": {
                        "labels": {"preview.stacks.io/runner-admitted": "true"}
                    }
                },
            )
            namespace = self._core.read_namespace(name=contract.target_namespace)
            self._validate_namespace(
                contract,
                namespace,
                require_ready=True,
                require_admitted=True,
                runner_generation=reservation.runner_generation,
            )
        except Exception as exc:
            if isinstance(exc, PreviewRunnerIdentityError):
                raise
            raise PreviewRunnerIdentityError(
                f"could not mark runner Job admitted for {reservation.preview_name}: {exc}"
            ) from exc

    def cleanup_after_down(
        self,
        *,
        preview_name: str,
        runner_succeeded: bool,
        target_namespace_absent: bool,
    ) -> bool:
        if not runner_succeeded or not target_namespace_absent:
            raise PreviewRunnerIdentityError(
                "runner identity cleanup requires successful down and absent target namespace"
            )
        contract = PreviewRunnerIdentityContract(preview_name)
        self._delete_optional(
            lambda: self._rbac.delete_namespaced_role_binding(
                name=contract.identity_name,
                namespace=contract.target_namespace,
                propagation_policy="Background",
            ),
            f"target RoleBinding {contract.identity_name}",
        )
        self._delete_optional(
            lambda: self._rbac.delete_namespaced_role_binding(
                name=contract.identity_name,
                namespace=CONTROL_NAMESPACE,
                propagation_policy="Background",
            ),
            f"control RoleBinding {contract.identity_name}",
        )
        self._delete_optional(
            lambda: self._rbac.delete_cluster_role_binding(
                name=contract.identity_name, propagation_policy="Background"
            ),
            f"ClusterRoleBinding {contract.identity_name}",
        )
        self._delete_optional(
            lambda: self._core.delete_namespaced_service_account(
                name=contract.identity_name,
                namespace=CONTROL_NAMESPACE,
                propagation_policy="Background",
            ),
            f"ServiceAccount {contract.identity_name}",
        )
        self.prove_absent(preview_name=preview_name)
        return True

    def cleanup_unadmitted(self, *, preview_name: str) -> bool:
        probe = PreviewRunnerIdentityContract(preview_name)
        namespace = self._core.read_namespace(name=probe.target_namespace)
        lifecycle = _labels(namespace).get("vcluster-preview-lifecycle")
        contract = PreviewRunnerIdentityContract(preview_name, lifecycle)
        self._validate_namespace(contract, namespace, require_ready=True)
        if _labels(namespace).get("preview.stacks.io/runner-admitted") != "false":
            raise PreviewRunnerIdentityError(
                "only an unadmitted runner reservation may be compensated"
            )
        self._rollback(
            contract,
            [
                ("service-account", CONTROL_NAMESPACE),
                ("cluster-role-binding", ""),
                ("role-binding", CONTROL_NAMESPACE),
                ("role-binding", contract.target_namespace),
            ],
            True,
        )
        return True

    def prove_absent(self, *, preview_name: str) -> None:
        contract = PreviewRunnerIdentityContract(preview_name)
        for read, description in self._absence_checks(contract):
            if self._read_optional(read, description) is not None:
                raise PreviewRunnerIdentityError(
                    f"{description} {contract.identity_name} remains"
                )

    def is_absent(self, *, preview_name: str) -> bool:
        contract = PreviewRunnerIdentityContract(preview_name)
        return all(
            self._read_optional(read, description) is None
            for read, description in self._absence_checks(contract)
        )

    def _absence_checks(self, contract: PreviewRunnerIdentityContract):
        return (
            (
                lambda: self._core.read_namespaced_service_account(
                    name=contract.identity_name, namespace=CONTROL_NAMESPACE
                ),
                "ServiceAccount",
            ),
            (
                lambda: self._rbac.read_cluster_role_binding(
                    name=contract.identity_name
                ),
                "ClusterRoleBinding",
            ),
            (
                lambda: self._rbac.read_namespaced_role_binding(
                    name=contract.identity_name, namespace=CONTROL_NAMESPACE
                ),
                "control RoleBinding",
            ),
            (
                lambda: self._rbac.read_namespaced_role_binding(
                    name=contract.identity_name,
                    namespace=contract.target_namespace,
                ),
                "target RoleBinding",
            ),
        )

    def _ensure_service_account(
        self, contract: PreviewRunnerIdentityContract, created: list[tuple[str, str]]
    ) -> None:
        current = self._read_optional(
            lambda: self._core.read_namespaced_service_account(
                name=contract.identity_name, namespace=CONTROL_NAMESPACE
            ),
            f"ServiceAccount {contract.identity_name}",
        )
        if current is None:
            created.append(("service-account", CONTROL_NAMESPACE))
            try:
                self._core.create_namespaced_service_account(
                    namespace=CONTROL_NAMESPACE,
                    body=contract.service_account_body(),
                )
            except Exception as create_exc:
                observed = self._read_optional(
                    lambda: self._core.read_namespaced_service_account(
                        name=contract.identity_name, namespace=CONTROL_NAMESPACE
                    ),
                    f"ServiceAccount {contract.identity_name} after create error",
                )
                if observed is None:
                    raise PreviewRunnerIdentityError(
                        f"runner ServiceAccount create failed: {create_exc}"
                    ) from create_exc
                self._validate_service_account(contract, observed)
            return
        self._validate_service_account(contract, current)

    def _require_residual_down_identity(
        self, contract: PreviewRunnerIdentityContract
    ) -> None:
        service_account = self._read_optional(
            lambda: self._core.read_namespaced_service_account(
                name=contract.identity_name, namespace=CONTROL_NAMESPACE
            ),
            f"ServiceAccount {contract.identity_name}",
        )
        cluster_binding = self._read_optional(
            lambda: self._rbac.read_cluster_role_binding(name=contract.identity_name),
            f"ClusterRoleBinding {contract.identity_name}",
        )
        control_binding = self._read_optional(
            lambda: self._rbac.read_namespaced_role_binding(
                name=contract.identity_name, namespace=CONTROL_NAMESPACE
            ),
            f"control RoleBinding {contract.identity_name}",
        )
        if (
            service_account is None
            or cluster_binding is None
            or control_binding is None
        ):
            raise PreviewRunnerIdentityError(
                "residual down requires its existing bounded runner identity"
            )
        self._validate_service_account(contract, service_account)
        self._validate_cluster_role_binding(contract, cluster_binding)
        self._validate_role_binding(
            contract,
            control_binding,
            namespace=CONTROL_NAMESPACE,
            role_kind="Role",
            role_name=CONTROL_ROLE,
        )

    def _ensure_cluster_role_binding(
        self, contract: PreviewRunnerIdentityContract, created: list[tuple[str, str]]
    ) -> None:
        current = self._read_optional(
            lambda: self._rbac.read_cluster_role_binding(name=contract.identity_name),
            f"ClusterRoleBinding {contract.identity_name}",
        )
        if current is None:
            created.append(("cluster-role-binding", ""))
            try:
                self._rbac.create_cluster_role_binding(
                    body=contract.cluster_role_binding_body()
                )
            except Exception as create_exc:
                observed = self._read_optional(
                    lambda: self._rbac.read_cluster_role_binding(
                        name=contract.identity_name
                    ),
                    f"ClusterRoleBinding {contract.identity_name} after create error",
                )
                if observed is None:
                    raise PreviewRunnerIdentityError(
                        f"runner ClusterRoleBinding create failed: {create_exc}"
                    ) from create_exc
                self._validate_cluster_role_binding(contract, observed)
            return
        self._validate_cluster_role_binding(contract, current)

    def _ensure_control_role_binding(
        self, contract: PreviewRunnerIdentityContract, created: list[tuple[str, str]]
    ) -> None:
        self._ensure_role_binding(
            contract,
            namespace=CONTROL_NAMESPACE,
            role_kind="Role",
            role_name=CONTROL_ROLE,
            body=contract.control_role_binding_body(),
            created=created,
        )

    def _ensure_target_role_binding(
        self, contract: PreviewRunnerIdentityContract, created: list[tuple[str, str]]
    ) -> None:
        self._ensure_role_binding(
            contract,
            namespace=contract.target_namespace,
            role_kind="ClusterRole",
            role_name=NAMESPACE_CLUSTER_ROLE,
            body=contract.target_role_binding_body(),
            created=created,
        )

    def _ensure_role_binding(
        self,
        contract: PreviewRunnerIdentityContract,
        *,
        namespace: str,
        role_kind: str,
        role_name: str,
        body: dict[str, Any],
        created: list[tuple[str, str]],
    ) -> None:
        current = self._read_optional(
            lambda: self._rbac.read_namespaced_role_binding(
                name=contract.identity_name, namespace=namespace
            ),
            f"RoleBinding {namespace}/{contract.identity_name}",
        )
        if current is None:
            created.append(("role-binding", namespace))
            try:
                self._rbac.create_namespaced_role_binding(
                    namespace=namespace, body=body
                )
            except Exception as create_exc:
                observed = self._read_optional(
                    lambda: self._rbac.read_namespaced_role_binding(
                        name=contract.identity_name, namespace=namespace
                    ),
                    f"RoleBinding {namespace}/{contract.identity_name} after create error",
                )
                if observed is None:
                    raise PreviewRunnerIdentityError(
                        f"runner RoleBinding create failed: {create_exc}"
                    ) from create_exc
                self._validate_role_binding(
                    contract,
                    observed,
                    namespace=namespace,
                    role_kind=role_kind,
                    role_name=role_name,
                )
            return
        self._validate_role_binding(
            contract,
            current,
            namespace=namespace,
            role_kind=role_kind,
            role_name=role_name,
        )

    def _validate_namespace(
        self,
        contract: PreviewRunnerIdentityContract,
        value: Any,
        *,
        require_ready: bool = False,
        require_admitted: bool = False,
        runner_generation: str | None = None,
    ) -> None:
        if _value(value, "metadata", "name", default="") != contract.target_namespace:
            raise PreviewRunnerIdentityError("target namespace name does not match")
        labels = _labels(value)
        lifecycle = labels.get("vcluster-preview-lifecycle")
        if contract.lifecycle is not None and lifecycle != contract.lifecycle:
            raise PreviewRunnerIdentityError(
                "target namespace lifecycle does not match request"
            )
        expected = contract.namespace_labels(lifecycle or "")
        if any(
            labels.get(key) != expected_value
            for key, expected_value in expected.items()
        ):
            raise PreviewRunnerIdentityError("target namespace contract does not match")
        if require_ready and labels.get("preview.stacks.io/identity-ready") != "true":
            raise PreviewRunnerIdentityError("target namespace identity is not ready")
        admitted = labels.get("preview.stacks.io/runner-admitted")
        if admitted not in {"false", "true"}:
            raise PreviewRunnerIdentityError(
                "target namespace runner admission marker is invalid"
            )
        if require_admitted and admitted != "true":
            raise PreviewRunnerIdentityError("target namespace runner is not admitted")
        if runner_generation is not None:
            annotations = (
                _value(value, "metadata", "annotations", default={}) or {}
            )
            observed_generation = annotations.get(RUNNER_GENERATION_ANNOTATION)
            if observed_generation != runner_generation:
                raise PreviewRunnerIdentityError(
                    "target namespace runner generation does not match"
                )

    def _validate_service_account(
        self, contract: PreviewRunnerIdentityContract, value: Any
    ) -> None:
        self._validate_metadata(
            contract, value, namespace=CONTROL_NAMESPACE, description="ServiceAccount"
        )
        automount = _value(value, "automount_service_account_token", default=None)
        if automount is None:
            automount = _value(value, "automountServiceAccountToken", default=None)
        if automount is not True:
            raise PreviewRunnerIdentityError(
                "runner ServiceAccount must explicitly automount its token"
            )
        if (_value(value, "secrets", default=[]) or []) or (
            _value(value, "image_pull_secrets", default=None)
            or _value(value, "imagePullSecrets", default=[])
            or []
        ):
            raise PreviewRunnerIdentityError(
                "runner ServiceAccount may not carry Secret references"
            )

    def _validate_cluster_role_binding(
        self, contract: PreviewRunnerIdentityContract, value: Any
    ) -> None:
        self._validate_metadata(
            contract, value, namespace=None, description="ClusterRoleBinding"
        )
        if _role_ref_contract(value) != (
            "rbac.authorization.k8s.io",
            "ClusterRole",
            BOOTSTRAP_CLUSTER_ROLE,
        ):
            raise PreviewRunnerIdentityError(
                "bootstrap ClusterRoleBinding does not match"
            )
        self._validate_subject(contract, value)

    def _validate_role_binding(
        self,
        contract: PreviewRunnerIdentityContract,
        value: Any,
        *,
        namespace: str,
        role_kind: str,
        role_name: str,
    ) -> None:
        self._validate_metadata(
            contract, value, namespace=namespace, description="RoleBinding"
        )
        if _role_ref_contract(value) != (
            "rbac.authorization.k8s.io",
            role_kind,
            role_name,
        ):
            raise PreviewRunnerIdentityError(
                "runner RoleBinding roleRef does not match"
            )
        self._validate_subject(contract, value)

    def _validate_subject(
        self, contract: PreviewRunnerIdentityContract, value: Any
    ) -> None:
        if _subject_contract(value) != (
            "ServiceAccount",
            contract.identity_name,
            CONTROL_NAMESPACE,
            "",
        ):
            raise PreviewRunnerIdentityError("runner binding subject does not match")

    def _validate_metadata(
        self,
        contract: PreviewRunnerIdentityContract,
        value: Any,
        *,
        namespace: str | None,
        description: str,
    ) -> None:
        metadata = _value(value, "metadata", default={})
        if _value(metadata, "name", default="") != contract.identity_name:
            raise PreviewRunnerIdentityError(f"{description} name does not match")
        actual_namespace = _value(metadata, "namespace", default=None)
        if namespace is not None and actual_namespace != namespace:
            raise PreviewRunnerIdentityError(f"{description} namespace does not match")
        labels = _labels(value)
        if any(
            labels.get(key) != expected
            for key, expected in contract.identity_labels.items()
        ):
            raise PreviewRunnerIdentityError(f"{description} labels do not match")

    @staticmethod
    def _read_optional(read, description: str) -> Any | None:
        try:
            return read()
        except Exception as exc:
            if getattr(exc, "status", None) == _NOT_FOUND:
                return None
            raise PreviewRunnerIdentityError(
                f"could not read {description}: {exc}"
            ) from exc

    @staticmethod
    def _delete_optional(delete, description: str) -> None:
        try:
            delete()
        except Exception as exc:
            if getattr(exc, "status", None) != _NOT_FOUND:
                raise PreviewRunnerIdentityError(
                    f"could not delete {description}: {exc}"
                ) from exc

    def _rollback(
        self,
        contract: PreviewRunnerIdentityContract,
        created: list[tuple[str, str]],
        namespace_created: bool,
        *,
        clear_ready: bool = False,
    ) -> None:
        errors: list[str] = []
        for kind, namespace in reversed(created):
            try:
                if kind == "role-binding":
                    current = self._read_optional(
                        lambda: self._rbac.read_namespaced_role_binding(
                            name=contract.identity_name, namespace=namespace
                        ),
                        f"rollback RoleBinding {namespace}/{contract.identity_name}",
                    )
                    if current is None:
                        continue
                    self._validate_role_binding(
                        contract,
                        current,
                        namespace=namespace,
                        role_kind=(
                            "Role" if namespace == CONTROL_NAMESPACE else "ClusterRole"
                        ),
                        role_name=(
                            CONTROL_ROLE
                            if namespace == CONTROL_NAMESPACE
                            else NAMESPACE_CLUSTER_ROLE
                        ),
                    )
                elif kind == "cluster-role-binding":
                    current = self._read_optional(
                        lambda: self._rbac.read_cluster_role_binding(
                            name=contract.identity_name
                        ),
                        f"rollback ClusterRoleBinding {contract.identity_name}",
                    )
                    if current is None:
                        continue
                    self._validate_cluster_role_binding(contract, current)
                elif kind == "service-account":
                    current = self._read_optional(
                        lambda: self._core.read_namespaced_service_account(
                            name=contract.identity_name, namespace=CONTROL_NAMESPACE
                        ),
                        f"rollback ServiceAccount {contract.identity_name}",
                    )
                    if current is None:
                        continue
                    self._validate_service_account(contract, current)

                if kind == "role-binding":
                    self._delete_optional(
                        lambda: self._rbac.delete_namespaced_role_binding(
                            name=contract.identity_name,
                            namespace=namespace,
                            propagation_policy="Background",
                        ),
                        f"rollback RoleBinding {namespace}/{contract.identity_name}",
                    )
                elif kind == "cluster-role-binding":
                    self._delete_optional(
                        lambda: self._rbac.delete_cluster_role_binding(
                            name=contract.identity_name,
                            propagation_policy="Background",
                        ),
                        f"rollback ClusterRoleBinding {contract.identity_name}",
                    )
                elif kind == "service-account":
                    self._delete_optional(
                        lambda: self._core.delete_namespaced_service_account(
                            name=contract.identity_name,
                            namespace=CONTROL_NAMESPACE,
                            propagation_policy="Background",
                        ),
                        f"rollback ServiceAccount {contract.identity_name}",
                    )
                remaining = self._read_created_optional(contract, kind, namespace)
                if remaining is not None:
                    raise PreviewRunnerIdentityError(
                        f"rollback {kind} {contract.identity_name} remains"
                    )
            except Exception as exc:
                errors.append(str(exc))
        if namespace_created:
            try:
                current_namespace = self._read_optional(
                    lambda: self._core.read_namespace(name=contract.target_namespace),
                    f"rollback namespace {contract.target_namespace}",
                )
                if current_namespace is not None:
                    self._validate_namespace(contract, current_namespace)
                    self._delete_optional(
                        lambda: self._core.delete_namespace(
                            name=contract.target_namespace,
                            propagation_policy="Background",
                        ),
                        f"rollback namespace {contract.target_namespace}",
                    )
                if (
                    self._read_optional(
                        lambda: self._core.read_namespace(
                            name=contract.target_namespace
                        ),
                        f"rollback namespace proof {contract.target_namespace}",
                    )
                    is not None
                ):
                    raise PreviewRunnerIdentityError(
                        f"rollback namespace {contract.target_namespace} remains"
                    )
            except Exception as exc:
                errors.append(str(exc))
        elif clear_ready:
            try:
                self._core.patch_namespace(
                    name=contract.target_namespace,
                    body={
                        "metadata": {
                            "labels": {"preview.stacks.io/identity-ready": None}
                        }
                    },
                )
                namespace_value = self._core.read_namespace(
                    name=contract.target_namespace
                )
                if (
                    _labels(namespace_value).get("preview.stacks.io/identity-ready")
                    == "true"
                ):
                    raise PreviewRunnerIdentityError(
                        "rollback identity-ready marker remains"
                    )
            except Exception as exc:
                errors.append(str(exc))
        if errors:
            raise PreviewRunnerIdentityError("; ".join(errors))

    def _read_created_optional(
        self,
        contract: PreviewRunnerIdentityContract,
        kind: str,
        namespace: str,
    ) -> Any | None:
        if kind == "role-binding":
            return self._read_optional(
                lambda: self._rbac.read_namespaced_role_binding(
                    name=contract.identity_name, namespace=namespace
                ),
                f"rollback RoleBinding proof {namespace}/{contract.identity_name}",
            )
        if kind == "cluster-role-binding":
            return self._read_optional(
                lambda: self._rbac.read_cluster_role_binding(
                    name=contract.identity_name
                ),
                f"rollback ClusterRoleBinding proof {contract.identity_name}",
            )
        if kind == "service-account":
            return self._read_optional(
                lambda: self._core.read_namespaced_service_account(
                    name=contract.identity_name, namespace=CONTROL_NAMESPACE
                ),
                f"rollback ServiceAccount proof {contract.identity_name}",
            )
        raise PreviewRunnerIdentityError(f"unknown rollback resource kind {kind}")

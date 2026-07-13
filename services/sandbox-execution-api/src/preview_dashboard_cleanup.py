"""Cleanup port and Kubernetes adapter for preview dashboard registrations.

The registration write path is owned by the preview-control application.  This
adapter gives the hub PreviewEnvironment controller only the lifecycle authority
it needs: verify the immutable ownership tuple, delete the two derived resources,
and prove that both are absent before releasing its finalizer.
"""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any, Protocol

from kubernetes.client.exceptions import ApiException


DASHBOARD_REGISTRATION_FINALIZER = "preview.stacks.io/headlamp-registration"
HEADLAMP_SECRET_NAMESPACE = "preview-headlamp"
TAILSCALE_NAMESPACE = "tailscale"

MANAGED_LABEL = "preview.stacks.io/managed"
HEADLAMP_RECORD_LABEL = "preview.stacks.io/headlamp-record"
PREVIEW_NAME_LABEL = "preview.stacks.io/preview-name"
ENVIRONMENT_UID_ANNOTATION = "preview.stacks.io/preview-environment-uid"


class PreviewDashboardCleanupError(RuntimeError):
    pass


class PreviewDashboardCleanupOwnershipError(PreviewDashboardCleanupError):
    pass


class PreviewDashboardCleanupPort(Protocol):
    def cleanup(self, *, preview_id: str, environment_uid: str) -> bool:
        """Delete owned dashboard resources and return true only after two 404s."""


def headlamp_secret_name(preview_id: str) -> str:
    return f"headlamp-preview-{preview_id}"


def tailnet_egress_service_name(preview_id: str) -> str:
    return f"kube-{preview_id}-api-egress"


def dashboard_labels(preview_id: str) -> dict[str, str]:
    return {
        MANAGED_LABEL: "true",
        HEADLAMP_RECORD_LABEL: "true",
        PREVIEW_NAME_LABEL: preview_id,
    }


def dashboard_annotations(environment_uid: str) -> dict[str, str]:
    return {ENVIRONMENT_UID_ANNOTATION: environment_uid}


def _status(exc: Exception) -> int | None:
    return getattr(exc, "status", None)


def _field(value: Any, snake_name: str, camel_name: str | None = None) -> Any:
    if isinstance(value, Mapping):
        return value.get(camel_name or snake_name)
    return getattr(value, snake_name, None)


def _metadata(value: Any) -> Any:
    return _field(value, "metadata") or {}


def _name(value: Any) -> str:
    return str(_field(_metadata(value), "name") or "")


def _namespace(value: Any) -> str:
    return str(_field(_metadata(value), "namespace") or "")


def _labels(value: Any) -> dict[str, str]:
    return dict(_field(_metadata(value), "labels") or {})


def _annotations(value: Any) -> dict[str, str]:
    return dict(_field(_metadata(value), "annotations") or {})


def _uid(value: Any) -> str:
    return str(_field(_metadata(value), "uid") or "")


class KubernetesPreviewDashboardCleanupAdapter:
    """Kubernetes adapter for the dashboard-registration cleanup port."""

    def __init__(self, *, core_api: Any) -> None:
        self.core_api = core_api

    def cleanup(self, *, preview_id: str, environment_uid: str) -> bool:
        secret = self._get_secret(preview_id)
        service = self._get_service(preview_id)

        # Validate the complete deletion set before mutating either member.  A
        # foreign object at a derived name must block cleanup, not cause a
        # partial deletion that hides the ownership conflict.
        if secret is not None:
            self._assert_owned(
                secret,
                preview_id=preview_id,
                environment_uid=environment_uid,
                expected_namespace=HEADLAMP_SECRET_NAMESPACE,
                expected_name=headlamp_secret_name(preview_id),
            )
        if service is not None:
            self._assert_owned(
                service,
                preview_id=preview_id,
                environment_uid=environment_uid,
                expected_namespace=TAILSCALE_NAMESPACE,
                expected_name=tailnet_egress_service_name(preview_id),
            )

        if secret is not None:
            self._delete_secret(secret, preview_id=preview_id)
        if service is not None:
            self._delete_service(service, preview_id=preview_id)

        remaining_secret = self._get_secret(preview_id)
        remaining_service = self._get_service(preview_id)
        if remaining_secret is not None:
            self._assert_owned(
                remaining_secret,
                preview_id=preview_id,
                environment_uid=environment_uid,
                expected_namespace=HEADLAMP_SECRET_NAMESPACE,
                expected_name=headlamp_secret_name(preview_id),
            )
        if remaining_service is not None:
            self._assert_owned(
                remaining_service,
                preview_id=preview_id,
                environment_uid=environment_uid,
                expected_namespace=TAILSCALE_NAMESPACE,
                expected_name=tailnet_egress_service_name(preview_id),
            )
        return remaining_secret is None and remaining_service is None

    def _get_secret(self, preview_id: str) -> Any | None:
        try:
            return self.core_api.read_namespaced_secret(
                namespace=HEADLAMP_SECRET_NAMESPACE,
                name=headlamp_secret_name(preview_id),
            )
        except ApiException as exc:
            if _status(exc) == 404:
                return None
            raise

    def _get_service(self, preview_id: str) -> Any | None:
        try:
            return self.core_api.read_namespaced_service(
                namespace=TAILSCALE_NAMESPACE,
                name=tailnet_egress_service_name(preview_id),
            )
        except ApiException as exc:
            if _status(exc) == 404:
                return None
            raise

    def _assert_owned(
        self,
        value: Any,
        *,
        preview_id: str,
        environment_uid: str,
        expected_namespace: str,
        expected_name: str,
    ) -> None:
        if _name(value) != expected_name or _namespace(value) != expected_namespace:
            raise PreviewDashboardCleanupOwnershipError(
                "dashboard resource name or namespace does not match"
            )
        if _labels(value) != dashboard_labels(preview_id):
            raise PreviewDashboardCleanupOwnershipError(
                "dashboard resource labels do not match the preview ownership tuple"
            )
        if _annotations(value).get(ENVIRONMENT_UID_ANNOTATION) != environment_uid:
            raise PreviewDashboardCleanupOwnershipError(
                "dashboard resource belongs to another PreviewEnvironment"
            )
        if not _uid(value):
            raise PreviewDashboardCleanupOwnershipError(
                "dashboard resource has no stable Kubernetes UID"
            )

    def _delete_secret(self, value: Any, *, preview_id: str) -> None:
        self._delete(
            self.core_api.delete_namespaced_secret,
            namespace=HEADLAMP_SECRET_NAMESPACE,
            name=headlamp_secret_name(preview_id),
            uid=_uid(value),
        )

    def _delete_service(self, value: Any, *, preview_id: str) -> None:
        self._delete(
            self.core_api.delete_namespaced_service,
            namespace=TAILSCALE_NAMESPACE,
            name=tailnet_egress_service_name(preview_id),
            uid=_uid(value),
        )

    @staticmethod
    def _delete(delete: Any, *, namespace: str, name: str, uid: str) -> None:
        try:
            delete(
                namespace=namespace,
                name=name,
                body={
                    "apiVersion": "v1",
                    "kind": "DeleteOptions",
                    "preconditions": {"uid": uid},
                },
            )
        except ApiException as exc:
            if _status(exc) == 404:
                return
            if _status(exc) == 409:
                raise PreviewDashboardCleanupOwnershipError(
                    f"dashboard resource {namespace}/{name} changed during cleanup"
                ) from exc
            raise

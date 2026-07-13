from __future__ import annotations

import copy
from typing import Any

import pytest
from kubernetes.client.exceptions import ApiException

from src.preview_dashboard_cleanup import (
    ENVIRONMENT_UID_ANNOTATION,
    HEADLAMP_SECRET_NAMESPACE,
    TAILSCALE_NAMESPACE,
    KubernetesPreviewDashboardCleanupAdapter,
    PreviewDashboardCleanupOwnershipError,
    dashboard_labels,
    headlamp_secret_name,
    tailnet_egress_service_name,
)


PREVIEW_ID = "feature-x"
ENVIRONMENT_UID = "12345678-1234-1234-1234-123456789abc"


def _not_found() -> ApiException:
    return ApiException(status=404, reason="Not Found")


def _resource(*, kind: str, uid: str) -> dict[str, Any]:
    namespace = HEADLAMP_SECRET_NAMESPACE if kind == "secret" else TAILSCALE_NAMESPACE
    name = (
        headlamp_secret_name(PREVIEW_ID)
        if kind == "secret"
        else tailnet_egress_service_name(PREVIEW_ID)
    )
    return {
        "metadata": {
            "name": name,
            "namespace": namespace,
            "uid": uid,
            "labels": dashboard_labels(PREVIEW_ID),
            "annotations": {ENVIRONMENT_UID_ANNOTATION: ENVIRONMENT_UID},
        }
    }


class FakeCoreApi:
    def __init__(self) -> None:
        self.secret: dict[str, Any] | None = None
        self.service: dict[str, Any] | None = None
        self.delete_immediately = True
        self.delete_status: int | None = None
        self.calls: list[tuple[str, str, str, dict[str, Any] | None]] = []

    def read_namespaced_secret(self, *, namespace: str, name: str) -> Any:
        self.calls.append(("read", namespace, name, None))
        if self.secret is None:
            raise _not_found()
        return copy.deepcopy(self.secret)

    def read_namespaced_service(self, *, namespace: str, name: str) -> Any:
        self.calls.append(("read", namespace, name, None))
        if self.service is None:
            raise _not_found()
        return copy.deepcopy(self.service)

    def delete_namespaced_secret(
        self, *, namespace: str, name: str, body: dict[str, Any]
    ) -> None:
        self.calls.append(("delete", namespace, name, copy.deepcopy(body)))
        if self.delete_status is not None:
            raise ApiException(status=self.delete_status, reason="delete failed")
        if self.delete_immediately:
            self.secret = None

    def delete_namespaced_service(
        self, *, namespace: str, name: str, body: dict[str, Any]
    ) -> None:
        self.calls.append(("delete", namespace, name, copy.deepcopy(body)))
        if self.delete_status is not None:
            raise ApiException(status=self.delete_status, reason="delete failed")
        if self.delete_immediately:
            self.service = None


def test_cleanup_is_complete_only_after_both_resources_return_404() -> None:
    core = FakeCoreApi()
    core.secret = _resource(kind="secret", uid="secret-uid")
    core.service = _resource(kind="service", uid="service-uid")
    core.delete_immediately = False
    adapter = KubernetesPreviewDashboardCleanupAdapter(core_api=core)

    assert (
        adapter.cleanup(preview_id=PREVIEW_ID, environment_uid=ENVIRONMENT_UID) is False
    )
    assert [call[0:3] for call in core.calls].count(
        ("read", HEADLAMP_SECRET_NAMESPACE, headlamp_secret_name(PREVIEW_ID))
    ) == 2
    assert [call[0:3] for call in core.calls].count(
        ("read", TAILSCALE_NAMESPACE, tailnet_egress_service_name(PREVIEW_ID))
    ) == 2

    core.secret = None
    core.service = None
    assert (
        adapter.cleanup(preview_id=PREVIEW_ID, environment_uid=ENVIRONMENT_UID) is True
    )


def test_cleanup_deletes_each_owned_resource_with_its_kubernetes_uid() -> None:
    core = FakeCoreApi()
    core.secret = _resource(kind="secret", uid="secret-uid")
    core.service = _resource(kind="service", uid="service-uid")
    adapter = KubernetesPreviewDashboardCleanupAdapter(core_api=core)

    assert adapter.cleanup(preview_id=PREVIEW_ID, environment_uid=ENVIRONMENT_UID)

    delete_calls = [call for call in core.calls if call[0] == "delete"]
    assert delete_calls == [
        (
            "delete",
            HEADLAMP_SECRET_NAMESPACE,
            headlamp_secret_name(PREVIEW_ID),
            {
                "apiVersion": "v1",
                "kind": "DeleteOptions",
                "preconditions": {"uid": "secret-uid"},
            },
        ),
        (
            "delete",
            TAILSCALE_NAMESPACE,
            tailnet_egress_service_name(PREVIEW_ID),
            {
                "apiVersion": "v1",
                "kind": "DeleteOptions",
                "preconditions": {"uid": "service-uid"},
            },
        ),
    ]


@pytest.mark.parametrize(
    "mutate",
    [
        lambda value: value["metadata"].update(
            {"labels": {**dashboard_labels(PREVIEW_ID), "unexpected": "label"}}
        ),
        lambda value: value["metadata"]["labels"].update(
            {"preview.stacks.io/preview-name": "other"}
        ),
        lambda value: value["metadata"]["annotations"].update(
            {ENVIRONMENT_UID_ANNOTATION: "another-environment"}
        ),
        lambda value: value["metadata"].update({"uid": ""}),
    ],
)
def test_cleanup_refuses_non_exact_ownership_before_deleting_anything(
    mutate: Any,
) -> None:
    core = FakeCoreApi()
    core.secret = _resource(kind="secret", uid="secret-uid")
    core.service = _resource(kind="service", uid="service-uid")
    mutate(core.service)
    adapter = KubernetesPreviewDashboardCleanupAdapter(core_api=core)

    with pytest.raises(PreviewDashboardCleanupOwnershipError):
        adapter.cleanup(preview_id=PREVIEW_ID, environment_uid=ENVIRONMENT_UID)

    assert not any(call[0] == "delete" for call in core.calls)


def test_uid_precondition_conflict_is_reported_as_ownership_failure() -> None:
    core = FakeCoreApi()
    core.secret = _resource(kind="secret", uid="secret-uid")
    core.delete_status = 409
    adapter = KubernetesPreviewDashboardCleanupAdapter(core_api=core)

    with pytest.raises(
        PreviewDashboardCleanupOwnershipError, match="changed during cleanup"
    ):
        adapter.cleanup(preview_id=PREVIEW_ID, environment_uid=ENVIRONMENT_UID)


def test_non_not_found_api_errors_are_not_misreported_as_absence() -> None:
    class ErrorCore(FakeCoreApi):
        def read_namespaced_secret(self, *, namespace: str, name: str) -> Any:
            del namespace, name
            raise ApiException(status=500, reason="query failed")

    adapter = KubernetesPreviewDashboardCleanupAdapter(core_api=ErrorCore())

    with pytest.raises(ApiException) as error:
        adapter.cleanup(preview_id=PREVIEW_ID, environment_uid=ENVIRONMENT_UID)
    assert error.value.status == 500

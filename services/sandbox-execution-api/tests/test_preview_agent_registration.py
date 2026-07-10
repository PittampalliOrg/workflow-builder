from __future__ import annotations

import base64
import copy
from datetime import UTC, datetime, timedelta
from functools import lru_cache
from types import SimpleNamespace
from typing import Any

import pytest
from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from cryptography.x509.oid import ExtendedKeyUsageOID, NameOID
from kubernetes.client.exceptions import ApiException

from src.preview_agent_registration import (
    ARGO_NAMESPACE,
    ARGO_SECRET_TYPE_LABEL,
    CERTIFICATE_DURATION,
    CERTIFICATE_EXPIRY_MARGIN,
    CERTIFICATE_NAMESPACE,
    CERTIFICATE_PLURAL,
    CERTIFICATE_RENEW_BEFORE,
    CLUSTER_ISSUER_NAME,
    ENVIRONMENT_UID_ANNOTATION,
    EXTERNAL_SECRET_GROUP,
    EXTERNAL_SECRET_PLURAL,
    EXTERNAL_SECRET_STORE_NAME,
    EXTERNAL_SECRET_VERSION,
    PreviewAgentRegistrationAdapter,
    PreviewAgentRegistrationError,
    PreviewAgentRegistrationOwnershipError,
    agent_name,
    build_certificate_manifest,
    build_mapping_external_secret,
    certificate_name,
    certificate_secret_name,
    mapping_secret_name,
    registration_annotations,
    registration_labels,
)


PREVIEW_ID = "feature-x"
ENVIRONMENT_UID = "12345678-1234-1234-1234-123456789abc"
EXPIRES_AT = datetime(2026, 7, 17, 12, tzinfo=UTC)
NOT_AFTER = EXPIRES_AT + CERTIFICATE_EXPIRY_MARGIN + timedelta(hours=1)
NOW = datetime(2026, 7, 10, 12, tzinfo=UTC)


def _not_found() -> ApiException:
    return ApiException(status=404, reason="Not Found")


def _environment() -> SimpleNamespace:
    return SimpleNamespace(id=PREVIEW_ID, uid=ENVIRONMENT_UID, expires_at=EXPIRES_AT)


def _timestamp(value: datetime) -> str:
    return value.astimezone(UTC).isoformat().replace("+00:00", "Z")


def _ready_certificate(*, not_after: datetime = NOT_AFTER) -> dict[str, Any]:
    certificate = build_certificate_manifest(_environment())
    certificate["metadata"].update({"generation": 1, "resourceVersion": "3"})
    certificate["status"] = {
        "conditions": [{"type": "Ready", "status": "True"}],
        "notAfter": _timestamp(not_after),
    }
    return certificate


def _encoded(value: bytes) -> str:
    return base64.b64encode(value).decode("ascii")


def _valid_leaf_data(
    *,
    common_name: str | None = None,
    not_after: datetime = NOT_AFTER,
    not_before: datetime = datetime(2026, 7, 1, tzinfo=UTC),
    ca_permits_signing: bool = True,
) -> dict[str, str]:
    ca_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    ca_name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "preview-test-ca")])
    ca_certificate = (
        x509.CertificateBuilder()
        .subject_name(ca_name)
        .issuer_name(ca_name)
        .public_key(ca_key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(datetime(2026, 7, 1, tzinfo=UTC))
        .not_valid_after(datetime(2027, 7, 1, tzinfo=UTC))
        .add_extension(
            x509.BasicConstraints(ca=ca_permits_signing, path_length=None),
            critical=True,
        )
        .sign(ca_key, hashes.SHA256())
    )
    leaf_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    leaf_certificate = (
        x509.CertificateBuilder()
        .subject_name(
            x509.Name(
                [
                    x509.NameAttribute(
                        NameOID.COMMON_NAME,
                        common_name or agent_name(PREVIEW_ID),
                    )
                ]
            )
        )
        .issuer_name(ca_name)
        .public_key(leaf_key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(not_before)
        .not_valid_after(not_after)
        .add_extension(
            x509.ExtendedKeyUsage([ExtendedKeyUsageOID.CLIENT_AUTH]),
            critical=False,
        )
        .add_extension(
            x509.KeyUsage(
                digital_signature=True,
                content_commitment=False,
                key_encipherment=True,
                data_encipherment=False,
                key_agreement=False,
                key_cert_sign=False,
                crl_sign=False,
                encipher_only=None,
                decipher_only=None,
            ),
            critical=True,
        )
        .sign(ca_key, hashes.SHA256())
    )
    return {
        "tls.crt": _encoded(leaf_certificate.public_bytes(serialization.Encoding.PEM)),
        "tls.key": _encoded(
            leaf_key.private_bytes(
                serialization.Encoding.PEM,
                serialization.PrivateFormat.PKCS8,
                serialization.NoEncryption(),
            )
        ),
        "ca.crt": _encoded(ca_certificate.public_bytes(serialization.Encoding.PEM)),
    }


@lru_cache(maxsize=1)
def _default_leaf_data() -> dict[str, str]:
    return _valid_leaf_data()


def _leaf_secret(*, data: dict[str, Any] | None = None) -> dict[str, Any]:
    return {
        "apiVersion": "v1",
        "kind": "Secret",
        "metadata": {
            "name": certificate_secret_name(PREVIEW_ID),
            "namespace": CERTIFICATE_NAMESPACE,
            "labels": registration_labels(PREVIEW_ID),
            "annotations": registration_annotations(ENVIRONMENT_UID),
        },
        "type": "kubernetes.io/tls",
        "data": copy.deepcopy(data if data is not None else _default_leaf_data()),
    }


def _mapping_secret(*, environment_uid: str = ENVIRONMENT_UID) -> dict[str, Any]:
    return {
        "apiVersion": "v1",
        "kind": "Secret",
        "metadata": {
            "name": mapping_secret_name(PREVIEW_ID),
            "namespace": ARGO_NAMESPACE,
            "labels": {
                **registration_labels(PREVIEW_ID),
                ARGO_SECRET_TYPE_LABEL: "cluster",
            },
            "annotations": registration_annotations(environment_uid),
        },
        "type": "Opaque",
        "data": {},
    }


def _ready_external_secret() -> dict[str, Any]:
    value = build_mapping_external_secret(_environment())
    value["metadata"].update({"generation": 1, "resourceVersion": "5"})
    value["status"] = {
        "observedGeneration": 1,
        "conditions": [{"type": "Ready", "status": "True"}],
    }
    return value


class FakeCoreApi:
    def __init__(self) -> None:
        self.secrets: dict[tuple[str, str], dict[str, Any]] = {}
        self.namespaces: dict[str, dict[str, Any]] = {}
        self.calls: list[tuple[Any, ...]] = []
        self.read_secret_error: ApiException | None = None
        self.hold_delete_secret: tuple[str, str] | None = None
        self.delete_secret_errors: dict[tuple[str, str], ApiException] = {}

    def read_namespaced_secret(self, *, namespace: str, name: str) -> dict[str, Any]:
        self.calls.append(("read-secret", namespace, name))
        if self.read_secret_error is not None:
            raise self.read_secret_error
        value = self.secrets.get((namespace, name))
        if value is None:
            raise _not_found()
        return copy.deepcopy(value)

    def delete_namespaced_secret(self, *, namespace: str, name: str) -> None:
        self.calls.append(("delete-secret", namespace, name))
        key = (namespace, name)
        if error := self.delete_secret_errors.get(key):
            raise error
        if key not in self.secrets:
            raise _not_found()
        if self.hold_delete_secret != (namespace, name):
            self.secrets.pop(key)

    def read_namespace(self, *, name: str) -> dict[str, Any]:
        self.calls.append(("read-namespace", name))
        value = self.namespaces.get(name)
        if value is None:
            raise _not_found()
        return copy.deepcopy(value)

    def delete_namespace(self, *, name: str) -> None:
        self.calls.append(("delete-namespace", name))
        self.namespaces.pop(name, None)


class FakeCustomApi:
    def __init__(self) -> None:
        self.objects: dict[tuple[str, str, str], dict[str, Any]] = {}
        self.calls: list[tuple[Any, ...]] = []
        self.ambiguous_create_plural: str | None = None
        self.hold_delete_plural: str | None = None

    @staticmethod
    def _key(kwargs: dict[str, Any]) -> tuple[str, str, str]:
        return (kwargs["namespace"], kwargs["plural"], kwargs["name"])

    def get_namespaced_custom_object(self, **kwargs: Any) -> dict[str, Any]:
        self.calls.append(("get", kwargs["namespace"], kwargs["plural"], kwargs["name"]))
        value = self.objects.get(self._key(kwargs))
        if value is None:
            raise _not_found()
        return copy.deepcopy(value)

    def create_namespaced_custom_object(self, **kwargs: Any) -> dict[str, Any]:
        body = copy.deepcopy(kwargs["body"])
        name = body["metadata"]["name"]
        body["metadata"].setdefault("generation", 1)
        body["metadata"].setdefault("resourceVersion", "1")
        key = (kwargs["namespace"], kwargs["plural"], name)
        self.calls.append(("create", *key, copy.deepcopy(body)))
        self.objects[key] = body
        if self.ambiguous_create_plural == kwargs["plural"]:
            self.ambiguous_create_plural = None
            raise ApiException(status=500, reason="connection closed after write")
        return copy.deepcopy(body)

    def patch_namespaced_custom_object(self, **kwargs: Any) -> dict[str, Any]:
        key = self._key(kwargs)
        body = copy.deepcopy(kwargs["body"])
        self.calls.append(("patch", *key, body))
        self.objects[key].update(body)
        return copy.deepcopy(self.objects[key])

    def delete_namespaced_custom_object(self, **kwargs: Any) -> None:
        key = self._key(kwargs)
        self.calls.append(("delete", *key, copy.deepcopy(kwargs.get("body"))))
        if self.hold_delete_plural != kwargs["plural"]:
            self.objects.pop(key, None)


def _adapter() -> tuple[PreviewAgentRegistrationAdapter, FakeCoreApi, FakeCustomApi]:
    core = FakeCoreApi()
    custom = FakeCustomApi()
    return (
        PreviewAgentRegistrationAdapter(core_api=core, custom_api=custom, now=lambda: NOW),
        core,
        custom,
    )


def _install_ready_material(core: FakeCoreApi, custom: FakeCustomApi) -> None:
    custom.objects[
        (CERTIFICATE_NAMESPACE, CERTIFICATE_PLURAL, certificate_name(PREVIEW_ID))
    ] = _ready_certificate()
    core.secrets[(CERTIFICATE_NAMESPACE, certificate_secret_name(PREVIEW_ID))] = (
        _leaf_secret()
    )


def _install_ready_mapping(custom: FakeCustomApi) -> None:
    custom.objects[(ARGO_NAMESPACE, EXTERNAL_SECRET_PLURAL, mapping_secret_name(PREVIEW_ID))] = (
        _ready_external_secret()
    )


def test_certificate_manifest_is_isolated_exact_and_bounded() -> None:
    manifest = build_certificate_manifest(_environment())
    assert manifest["metadata"] == {
        "name": certificate_name(PREVIEW_ID),
        "namespace": CERTIFICATE_NAMESPACE,
        "labels": registration_labels(PREVIEW_ID),
        "annotations": {ENVIRONMENT_UID_ANNOTATION: ENVIRONMENT_UID},
    }
    assert manifest["spec"] == {
        "secretName": certificate_secret_name(PREVIEW_ID),
        "duration": CERTIFICATE_DURATION,
        "renewBefore": CERTIFICATE_RENEW_BEFORE,
        "commonName": agent_name(PREVIEW_ID),
        "usages": ["client auth", "digital signature", "key encipherment"],
        "issuerRef": {
            "name": CLUSTER_ISSUER_NAME,
            "kind": "ClusterIssuer",
            "group": "cert-manager.io",
        },
        "privateKey": {"algorithm": "RSA", "size": 2048, "rotationPolicy": "Always"},
        "secretTemplate": {
            "labels": registration_labels(PREVIEW_ID),
            "annotations": {ENVIRONMENT_UID_ANNOTATION: ENVIRONMENT_UID},
        },
    }


def test_mapping_external_secret_contract_is_exact() -> None:
    manifest = build_mapping_external_secret(_environment())
    target_labels = {
        **registration_labels(PREVIEW_ID),
        ARGO_SECRET_TYPE_LABEL: "cluster",
    }
    assert manifest == {
        "apiVersion": f"{EXTERNAL_SECRET_GROUP}/{EXTERNAL_SECRET_VERSION}",
        "kind": "ExternalSecret",
        "metadata": {
            "name": mapping_secret_name(PREVIEW_ID),
            "namespace": ARGO_NAMESPACE,
            "labels": registration_labels(PREVIEW_ID),
            "annotations": registration_annotations(ENVIRONMENT_UID),
        },
        "spec": {
            "refreshInterval": "1m",
            "secretStoreRef": {"name": EXTERNAL_SECRET_STORE_NAME, "kind": "SecretStore"},
            "target": {
                "name": mapping_secret_name(PREVIEW_ID),
                "creationPolicy": "Owner",
                "deletionPolicy": "Delete",
                "template": {
                    "engineVersion": "v2",
                    "type": "Opaque",
                    "metadata": {
                        "labels": target_labels,
                        "annotations": registration_annotations(ENVIRONMENT_UID),
                    },
                    "data": {
                        "name": agent_name(PREVIEW_ID),
                        "server": (
                            "https://argocd-agent-resource-proxy:9090"
                            f"?agentName={agent_name(PREVIEW_ID)}"
                        ),
                        "config": (
                            '{"tlsClientConfig":{"caData":"{{ .ca | b64enc }}",'
                            '"certData":"{{ .cert | b64enc }}","insecure":false,'
                            '"keyData":"{{ .key | b64enc }}"}}'
                        ),
                    },
                },
            },
            "data": [
                {
                    "secretKey": "ca",
                    "remoteRef": {
                        "key": certificate_secret_name(PREVIEW_ID),
                        "property": "ca.crt",
                    },
                },
                {
                    "secretKey": "cert",
                    "remoteRef": {
                        "key": certificate_secret_name(PREVIEW_ID),
                        "property": "tls.crt",
                    },
                },
                {
                    "secretKey": "key",
                    "remoteRef": {
                        "key": certificate_secret_name(PREVIEW_ID),
                        "property": "tls.key",
                    },
                },
            ],
        },
    }


def test_ensure_waits_for_certificate_and_recovers_ambiguous_create() -> None:
    adapter, _core, custom = _adapter()
    custom.ambiguous_create_plural = CERTIFICATE_PLURAL
    status = adapter.ensure(_environment())
    assert status.ready is False
    assert status.reason == "WaitingForCertificate"
    assert (CERTIFICATE_NAMESPACE, CERTIFICATE_PLURAL, certificate_name(PREVIEW_ID)) in custom.objects


def test_ready_material_creates_mapping_then_waits_for_eso_ready() -> None:
    adapter, core, custom = _adapter()
    _install_ready_material(core, custom)
    waiting = adapter.ensure(_environment())
    assert waiting.ready is False
    assert waiting.reason == "WaitingForRegistrationMapping"
    key = (ARGO_NAMESPACE, EXTERNAL_SECRET_PLURAL, mapping_secret_name(PREVIEW_ID))
    assert custom.objects[key]["spec"] == build_mapping_external_secret(_environment())["spec"]
    custom.objects[key] = _ready_external_secret()
    registered = adapter.ensure(_environment())
    assert registered.ready is True
    assert registered.reason == "Registered"
    secret_calls = [call for call in core.calls if "secret" in call[0]]
    assert secret_calls
    assert {call[1] for call in secret_calls} == {CERTIFICATE_NAMESPACE}


def test_ambiguous_external_secret_create_is_reread_and_proved() -> None:
    adapter, core, custom = _adapter()
    _install_ready_material(core, custom)
    custom.ambiguous_create_plural = EXTERNAL_SECRET_PLURAL
    assert adapter.ensure(_environment()).reason == "WaitingForRegistrationMapping"
    assert (ARGO_NAMESPACE, EXTERNAL_SECRET_PLURAL, mapping_secret_name(PREVIEW_ID)) in custom.objects


def test_stale_external_secret_generation_is_not_ready() -> None:
    adapter, core, custom = _adapter()
    _install_ready_material(core, custom)
    stale = _ready_external_secret()
    stale["metadata"]["generation"] = 2
    custom.objects[(ARGO_NAMESPACE, EXTERNAL_SECRET_PLURAL, mapping_secret_name(PREVIEW_ID))] = stale
    assert adapter.ensure(_environment()).reason == "WaitingForRegistrationMapping"


def test_hostile_external_secret_is_never_adopted_or_patched() -> None:
    adapter, core, custom = _adapter()
    _install_ready_material(core, custom)
    hostile = build_mapping_external_secret(_environment())
    hostile["metadata"]["annotations"][ENVIRONMENT_UID_ANNOTATION] = "attacker"
    key = (ARGO_NAMESPACE, EXTERNAL_SECRET_PLURAL, mapping_secret_name(PREVIEW_ID))
    custom.objects[key] = hostile
    with pytest.raises(PreviewAgentRegistrationOwnershipError):
        adapter.ensure(_environment())
    assert custom.objects[key] == hostile
    assert not any(call[0] == "patch" for call in custom.calls)


def test_certificate_must_outlive_preview_by_full_margin() -> None:
    adapter, core, custom = _adapter()
    custom.objects[(CERTIFICATE_NAMESPACE, CERTIFICATE_PLURAL, certificate_name(PREVIEW_ID))] = (
        _ready_certificate(not_after=EXPIRES_AT + timedelta(hours=23))
    )
    core.secrets[(CERTIFICATE_NAMESPACE, certificate_secret_name(PREVIEW_ID))] = _leaf_secret()
    with pytest.raises(PreviewAgentRegistrationError, match="cleanup margin"):
        adapter.ensure(_environment())


@pytest.mark.parametrize(
    ("data", "message"),
    [
        (_valid_leaf_data(common_name="another-agent"), "common name"),
        (_valid_leaf_data(not_before=NOW + timedelta(minutes=1)), "currently valid"),
        (_valid_leaf_data(ca_permits_signing=False), "BasicConstraints"),
    ],
)
def test_leaf_identity_and_chain_constraints(data: dict[str, str], message: str) -> None:
    adapter, core, custom = _adapter()
    _install_ready_material(core, custom)
    core.secrets[(CERTIFICATE_NAMESPACE, certificate_secret_name(PREVIEW_ID))] = _leaf_secret(data=data)
    with pytest.raises(PreviewAgentRegistrationError, match=message):
        adapter.ensure(_environment())


def test_leaf_private_key_must_match() -> None:
    adapter, core, custom = _adapter()
    _install_ready_material(core, custom)
    material = _valid_leaf_data()
    material["tls.key"] = _valid_leaf_data()["tls.key"]
    core.secrets[(CERTIFICATE_NAMESPACE, certificate_secret_name(PREVIEW_ID))] = _leaf_secret(data=material)
    with pytest.raises(PreviewAgentRegistrationError, match="do not match"):
        adapter.ensure(_environment())


def test_leaf_must_verify_against_declared_ca_bundle() -> None:
    adapter, core, custom = _adapter()
    _install_ready_material(core, custom)
    material = _valid_leaf_data()
    material["ca.crt"] = _valid_leaf_data()["ca.crt"]
    core.secrets[(CERTIFICATE_NAMESPACE, certificate_secret_name(PREVIEW_ID))] = _leaf_secret(data=material)
    with pytest.raises(PreviewAgentRegistrationError, match="does not verify"):
        adapter.ensure(_environment())


@pytest.mark.parametrize(
    "data",
    [
        {},
        {"tls.crt": "***", "tls.key": "***", "ca.crt": "***"},
        {"tls.crt": "", "tls.key": "", "ca.crt": ""},
        {"tls.crt": 7, "tls.key": "value", "ca.crt": "value"},
    ],
)
def test_malformed_leaf_contract_is_rejected(data: dict[str, Any]) -> None:
    adapter, core, custom = _adapter()
    _install_ready_material(core, custom)
    core.secrets[(CERTIFICATE_NAMESPACE, certificate_secret_name(PREVIEW_ID))] = _leaf_secret(data=data)
    with pytest.raises(PreviewAgentRegistrationError):
        adapter.ensure(_environment())


def test_non_not_found_secret_query_error_fails_closed() -> None:
    adapter, core, custom = _adapter()
    custom.objects[(CERTIFICATE_NAMESPACE, CERTIFICATE_PLURAL, certificate_name(PREVIEW_ID))] = (
        _ready_certificate()
    )
    core.read_secret_error = ApiException(status=500, reason="apiserver unavailable")
    with pytest.raises(ApiException):
        adapter.ensure(_environment())


def test_cleanup_waits_for_mapping_gc_before_certificate_or_leaf() -> None:
    adapter, core, custom = _adapter()
    _install_ready_material(core, custom)
    _install_ready_mapping(custom)
    core.secrets[(ARGO_NAMESPACE, mapping_secret_name(PREVIEW_ID))] = _mapping_secret()
    namespace = {
        "metadata": {
            "name": agent_name(PREVIEW_ID),
            "labels": registration_labels(PREVIEW_ID),
            "annotations": registration_annotations(ENVIRONMENT_UID),
        }
    }
    core.namespaces[agent_name(PREVIEW_ID)] = namespace
    custom.hold_delete_plural = EXTERNAL_SECRET_PLURAL
    assert adapter.cleanup(preview_id=PREVIEW_ID, environment_uid=ENVIRONMENT_UID) is False
    assert (CERTIFICATE_NAMESPACE, CERTIFICATE_PLURAL, certificate_name(PREVIEW_ID)) in custom.objects
    assert (CERTIFICATE_NAMESPACE, certificate_secret_name(PREVIEW_ID)) in core.secrets

    custom.hold_delete_plural = None
    assert adapter.cleanup(preview_id=PREVIEW_ID, environment_uid=ENVIRONMENT_UID) is False
    assert (ARGO_NAMESPACE, mapping_secret_name(PREVIEW_ID)) not in core.secrets
    assert adapter.cleanup(preview_id=PREVIEW_ID, environment_uid=ENVIRONMENT_UID) is True
    assert custom.objects == {}
    assert core.secrets == {}
    assert core.namespaces == {}
    assert ("delete-secret", ARGO_NAMESPACE, mapping_secret_name(PREVIEW_ID)) in core.calls


def test_cleanup_waits_for_generated_mapping_secret_absence() -> None:
    adapter, core, custom = _adapter()
    core.secrets[(ARGO_NAMESPACE, mapping_secret_name(PREVIEW_ID))] = _mapping_secret()
    core.hold_delete_secret = (ARGO_NAMESPACE, mapping_secret_name(PREVIEW_ID))

    assert adapter.cleanup(preview_id=PREVIEW_ID, environment_uid=ENVIRONMENT_UID) is False
    assert (ARGO_NAMESPACE, mapping_secret_name(PREVIEW_ID)) in core.secrets

    core.hold_delete_secret = None
    assert adapter.cleanup(preview_id=PREVIEW_ID, environment_uid=ENVIRONMENT_UID) is False
    assert (ARGO_NAMESPACE, mapping_secret_name(PREVIEW_ID)) not in core.secrets
    assert adapter.cleanup(preview_id=PREVIEW_ID, environment_uid=ENVIRONMENT_UID) is True


def test_cleanup_preserves_finalizer_when_mapping_delete_is_denied() -> None:
    adapter, core, _custom = _adapter()
    core.secrets[(ARGO_NAMESPACE, mapping_secret_name(PREVIEW_ID))] = _mapping_secret(
        environment_uid="attacker"
    )
    core.delete_secret_errors[(ARGO_NAMESPACE, mapping_secret_name(PREVIEW_ID))] = ApiException(
        status=403, reason="admission denied hostile mapping"
    )

    with pytest.raises(ApiException, match="admission denied hostile mapping"):
        adapter.cleanup(preview_id=PREVIEW_ID, environment_uid=ENVIRONMENT_UID)
    assert (ARGO_NAMESPACE, mapping_secret_name(PREVIEW_ID)) in core.secrets


def test_cleanup_refuses_hostile_agent_namespace() -> None:
    adapter, core, _custom = _adapter()
    core.namespaces[agent_name(PREVIEW_ID)] = {
        "metadata": {
            "name": agent_name(PREVIEW_ID),
            "labels": registration_labels(PREVIEW_ID),
            "annotations": {ENVIRONMENT_UID_ANNOTATION: "attacker"},
        }
    }
    with pytest.raises(PreviewAgentRegistrationOwnershipError):
        adapter.cleanup(preview_id=PREVIEW_ID, environment_uid=ENVIRONMENT_UID)
    assert agent_name(PREVIEW_ID) in core.namespaces


def test_custom_api_contract_is_fixed() -> None:
    adapter, _core, custom = _adapter()
    adapter.ensure(_environment())
    assert custom.calls[0][:4] == (
        "get",
        CERTIFICATE_NAMESPACE,
        CERTIFICATE_PLURAL,
        certificate_name(PREVIEW_ID),
    )
    created = next(call for call in custom.calls if call[0] == "create")
    assert created[1:4] == (
        CERTIFICATE_NAMESPACE,
        CERTIFICATE_PLURAL,
        certificate_name(PREVIEW_ID),
    )

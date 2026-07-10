from __future__ import annotations

import base64
import binascii
from collections.abc import Mapping
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Any, Callable, Protocol

from cryptography import x509
from cryptography.exceptions import InvalidSignature, UnsupportedAlgorithm
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import dsa, ec, ed25519, ed448, rsa
from cryptography.x509.oid import ExtendedKeyUsageOID, NameOID
from kubernetes.client.exceptions import ApiException


REGISTRATION_FINALIZER = "preview.stacks.io/agent-registration"
ARGO_NAMESPACE = "argocd"
CERTIFICATE_NAMESPACE = "preview-agent-certs"
EXPORT_NAMESPACE = CERTIFICATE_NAMESPACE
CERTIFICATE_GROUP = "cert-manager.io"
CERTIFICATE_VERSION = "v1"
CERTIFICATE_PLURAL = "certificates"
CERTIFICATE_DURATION = "216h"
CERTIFICATE_RENEW_BEFORE = "24h"
CERTIFICATE_EXPIRY_MARGIN = timedelta(hours=24)
CLUSTER_ISSUER_NAME = "argocd-agent-ca-cluster-issuer"
EXTERNAL_SECRET_GROUP = "external-secrets.io"
EXTERNAL_SECRET_VERSION = "v1"
EXTERNAL_SECRET_PLURAL = "externalsecrets"
EXTERNAL_SECRET_STORE_NAME = "preview-agent-registration-store"

MANAGED_LABEL = "preview.stacks.io/managed"
PREVIEW_NAME_LABEL = "preview.stacks.io/preview-name"
AGENT_NAME_LABEL = "preview.stacks.io/agent-name"
ENVIRONMENT_UID_ANNOTATION = "preview.stacks.io/preview-environment-uid"
ARGO_SECRET_TYPE_LABEL = "argocd.argoproj.io/secret-type"


class PreviewAgentRegistrationError(RuntimeError):
    pass


class PreviewAgentRegistrationOwnershipError(PreviewAgentRegistrationError):
    pass


class PreviewAgentEnvironment(Protocol):
    id: str
    uid: str
    expires_at: datetime


@dataclass(frozen=True)
class PreviewAgentRegistrationStatus:
    agent_name: str
    ready: bool
    reason: str
    certificate_not_after: datetime | None = None

    def as_status(self) -> dict[str, Any]:
        return {
            "agentName": self.agent_name,
            "ready": self.ready,
            "reason": self.reason,
            "certificateNotAfter": (
                self.certificate_not_after.astimezone(UTC)
                .isoformat()
                .replace("+00:00", "Z")
                if self.certificate_not_after is not None
                else None
            ),
            "transport": "one-shot",
        }


def _status(exc: Exception) -> int | None:
    return getattr(exc, "status", None)


def _field(value: Any, snake_name: str, camel_name: str | None = None) -> Any:
    if isinstance(value, Mapping):
        return value.get(camel_name or snake_name)
    return getattr(value, snake_name, None)


def _mapping(value: Any) -> Mapping[str, Any] | None:
    return value if isinstance(value, Mapping) else None


def _metadata(value: Any) -> Any:
    return _field(value, "metadata") or {}


def _labels(value: Any) -> dict[str, str]:
    return dict(_field(_metadata(value), "labels") or {})


def _annotations(value: Any) -> dict[str, str]:
    return dict(_field(_metadata(value), "annotations") or {})


def _name(value: Any) -> str:
    return str(_field(_metadata(value), "name") or "")


def _namespace(value: Any) -> str:
    return str(_field(_metadata(value), "namespace") or "")


def _parse_timestamp(value: Any, description: str) -> datetime:
    if not isinstance(value, str) or not value.endswith("Z"):
        raise PreviewAgentRegistrationError(f"{description} is not RFC3339 UTC")
    try:
        parsed = datetime.fromisoformat(value[:-1] + "+00:00")
    except ValueError as exc:
        raise PreviewAgentRegistrationError(
            f"{description} is not RFC3339 UTC"
        ) from exc
    return parsed.astimezone(UTC)


def agent_name(preview_id: str) -> str:
    return f"preview-{preview_id}"


def registration_labels(preview_id: str) -> dict[str, str]:
    return {
        MANAGED_LABEL: "true",
        PREVIEW_NAME_LABEL: preview_id,
        AGENT_NAME_LABEL: agent_name(preview_id),
    }


def registration_annotations(environment_uid: str) -> dict[str, str]:
    return {ENVIRONMENT_UID_ANNOTATION: environment_uid}


def certificate_name(preview_id: str) -> str:
    return f"{agent_name(preview_id)}-agent-client"


def certificate_secret_name(preview_id: str) -> str:
    return f"{agent_name(preview_id)}-agent-cert"


def mapping_secret_name(preview_id: str) -> str:
    return f"cluster-{agent_name(preview_id)}"


def export_secret_name(preview_id: str) -> str:
    return certificate_secret_name(preview_id)


def build_certificate_manifest(environment: PreviewAgentEnvironment) -> dict[str, Any]:
    labels = registration_labels(environment.id)
    annotations = registration_annotations(environment.uid)
    return {
        "apiVersion": "cert-manager.io/v1",
        "kind": "Certificate",
        "metadata": {
            "name": certificate_name(environment.id),
            "namespace": CERTIFICATE_NAMESPACE,
            "labels": labels,
            "annotations": annotations,
        },
        "spec": {
            "secretName": certificate_secret_name(environment.id),
            "duration": CERTIFICATE_DURATION,
            "renewBefore": CERTIFICATE_RENEW_BEFORE,
            "commonName": agent_name(environment.id),
            "usages": ["client auth", "digital signature", "key encipherment"],
            "issuerRef": {
                "name": CLUSTER_ISSUER_NAME,
                "kind": "ClusterIssuer",
                "group": "cert-manager.io",
            },
            "privateKey": {
                "algorithm": "RSA",
                "size": 2048,
                "rotationPolicy": "Always",
            },
            "secretTemplate": {
                "labels": labels,
                "annotations": annotations,
            },
        },
    }


def build_mapping_external_secret(
    environment: PreviewAgentEnvironment,
) -> dict[str, Any]:
    target_labels = {
        **registration_labels(environment.id),
        ARGO_SECRET_TYPE_LABEL: "cluster",
    }
    return {
        "apiVersion": f"{EXTERNAL_SECRET_GROUP}/{EXTERNAL_SECRET_VERSION}",
        "kind": "ExternalSecret",
        "metadata": {
            "name": mapping_secret_name(environment.id),
            "namespace": ARGO_NAMESPACE,
            "labels": registration_labels(environment.id),
            "annotations": registration_annotations(environment.uid),
        },
        "spec": {
            "refreshInterval": "1m",
            "secretStoreRef": {
                "name": EXTERNAL_SECRET_STORE_NAME,
                "kind": "SecretStore",
            },
            "target": {
                "name": mapping_secret_name(environment.id),
                "creationPolicy": "Owner",
                "deletionPolicy": "Delete",
                "template": {
                    "engineVersion": "v2",
                    "type": "Opaque",
                    "metadata": {
                        "labels": target_labels,
                        "annotations": registration_annotations(environment.uid),
                    },
                    "data": {
                        "name": agent_name(environment.id),
                        "server": (
                            "https://argocd-agent-resource-proxy:9090"
                            f"?agentName={agent_name(environment.id)}"
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
                        "key": certificate_secret_name(environment.id),
                        "property": "ca.crt",
                    },
                },
                {
                    "secretKey": "cert",
                    "remoteRef": {
                        "key": certificate_secret_name(environment.id),
                        "property": "tls.crt",
                    },
                },
                {
                    "secretKey": "key",
                    "remoteRef": {
                        "key": certificate_secret_name(environment.id),
                        "property": "tls.key",
                    },
                },
            ],
        },
    }


class PreviewAgentRegistrationAdapter:
    def __init__(
        self,
        *,
        core_api: Any,
        custom_api: Any,
        now: Callable[[], datetime] | None = None,
    ) -> None:
        self.core_api = core_api
        self.custom_api = custom_api
        self.now = now or (lambda: datetime.now(UTC))

    def ensure(
        self, environment: PreviewAgentEnvironment
    ) -> PreviewAgentRegistrationStatus:
        certificate = self._upsert_certificate(environment)
        ready, not_after = self._certificate_readiness(certificate, environment)
        if not ready:
            return PreviewAgentRegistrationStatus(
                agent_name=agent_name(environment.id),
                ready=False,
                reason="WaitingForCertificate",
            )
        leaf = self._get_secret(
            CERTIFICATE_NAMESPACE, certificate_secret_name(environment.id)
        )
        if leaf is None:
            return PreviewAgentRegistrationStatus(
                agent_name=agent_name(environment.id),
                ready=False,
                reason="WaitingForCertificateSecret",
                certificate_not_after=not_after,
            )
        self._assert_owned(
            leaf,
            environment_id=environment.id,
            environment_uid=environment.uid,
            expected_namespace=CERTIFICATE_NAMESPACE,
            expected_name=certificate_secret_name(environment.id),
        )
        leaf_data = self._leaf_data(leaf)
        assert not_after is not None
        self._validate_leaf_certificate(
            leaf_data,
            environment=environment,
            certificate_not_after=not_after,
        )
        external_secret = self._upsert_mapping_external_secret(environment)
        if not self._mapping_readiness(external_secret):
            return PreviewAgentRegistrationStatus(
                agent_name=agent_name(environment.id),
                ready=False,
                reason="WaitingForRegistrationMapping",
                certificate_not_after=not_after,
            )
        return PreviewAgentRegistrationStatus(
            agent_name=agent_name(environment.id),
            ready=True,
            reason="Registered",
            certificate_not_after=not_after,
        )

    def cleanup(self, *, preview_id: str, environment_uid: str) -> bool:
        self._delete_mapping_external_secret(preview_id, environment_uid)
        if self._get_mapping_external_secret(preview_id) is not None:
            return False
        if not self._delete_mapping_secret(preview_id):
            return False
        self._delete_certificate(preview_id, environment_uid)
        self._delete_secret(
            namespace=CERTIFICATE_NAMESPACE,
            name=certificate_secret_name(preview_id),
            preview_id=preview_id,
            environment_uid=environment_uid,
        )
        self._delete_agent_namespace(preview_id, environment_uid)
        return self._all_absent(preview_id)

    def _get_certificate(self, preview_id: str) -> dict[str, Any] | None:
        try:
            return self.custom_api.get_namespaced_custom_object(
                group=CERTIFICATE_GROUP,
                version=CERTIFICATE_VERSION,
                namespace=CERTIFICATE_NAMESPACE,
                plural=CERTIFICATE_PLURAL,
                name=certificate_name(preview_id),
            )
        except ApiException as exc:
            if _status(exc) == 404:
                return None
            raise

    def _get_secret(self, namespace: str, name: str) -> Any | None:
        try:
            return self.core_api.read_namespaced_secret(
                namespace=namespace, name=name
            )
        except ApiException as exc:
            if _status(exc) == 404:
                return None
            raise

    def _get_namespace(self, name: str) -> Any | None:
        try:
            return self.core_api.read_namespace(name=name)
        except ApiException as exc:
            if _status(exc) == 404:
                return None
            raise

    def _assert_owned(
        self,
        value: Any,
        *,
        environment_id: str,
        environment_uid: str,
        expected_namespace: str,
        expected_name: str,
    ) -> None:
        if _name(value) != expected_name or _namespace(value) != expected_namespace:
            raise PreviewAgentRegistrationOwnershipError(
                "registration object name or namespace does not match"
            )
        labels = _labels(value)
        if any(
            labels.get(key) != expected
            for key, expected in registration_labels(environment_id).items()
        ) or _annotations(value).get(ENVIRONMENT_UID_ANNOTATION) != environment_uid:
            raise PreviewAgentRegistrationOwnershipError(
                "registration object belongs to another PreviewEnvironment"
            )

    def _upsert_certificate(self, environment: PreviewAgentEnvironment) -> Any:
        desired = build_certificate_manifest(environment)
        existing = self._get_certificate(environment.id)
        if existing is None:
            try:
                return self.custom_api.create_namespaced_custom_object(
                    group=CERTIFICATE_GROUP,
                    version=CERTIFICATE_VERSION,
                    namespace=CERTIFICATE_NAMESPACE,
                    plural=CERTIFICATE_PLURAL,
                    body=desired,
                )
            except ApiException:
                existing = self._get_certificate(environment.id)
                if existing is None:
                    raise
        self._assert_owned(
            existing,
            environment_id=environment.id,
            environment_uid=environment.uid,
            expected_namespace=CERTIFICATE_NAMESPACE,
            expected_name=certificate_name(environment.id),
        )
        if existing.get("spec") != desired["spec"]:
            return self.custom_api.patch_namespaced_custom_object(
                group=CERTIFICATE_GROUP,
                version=CERTIFICATE_VERSION,
                namespace=CERTIFICATE_NAMESPACE,
                plural=CERTIFICATE_PLURAL,
                name=certificate_name(environment.id),
                body={"spec": desired["spec"]},
            )
        return existing

    def _certificate_readiness(
        self, certificate: Mapping[str, Any], environment: PreviewAgentEnvironment
    ) -> tuple[bool, datetime | None]:
        status = certificate.get("status")
        if not isinstance(status, Mapping):
            return False, None
        conditions = status.get("conditions")
        ready = any(
            isinstance(condition, Mapping)
            and condition.get("type") == "Ready"
            and str(condition.get("status", "")).lower() == "true"
            for condition in conditions or []
        )
        if not ready:
            return False, None
        not_after = _parse_timestamp(
            status.get("notAfter"), "Certificate status.notAfter"
        )
        required_not_after = environment.expires_at.astimezone(
            UTC
        ) + CERTIFICATE_EXPIRY_MARGIN
        if not_after < required_not_after:
            raise PreviewAgentRegistrationError(
                "agent Certificate expires before the preview cleanup margin"
            )
        return True, not_after

    def _leaf_data(self, secret: Any) -> dict[str, str]:
        if _field(secret, "type") != "kubernetes.io/tls":
            raise PreviewAgentRegistrationError(
                "agent Certificate Secret has the wrong type"
            )
        data = dict(_field(secret, "data") or {})
        if set(data) != {"tls.crt", "tls.key", "ca.crt"}:
            raise PreviewAgentRegistrationError(
                "agent Certificate Secret has an invalid data contract"
            )
        for key, value in data.items():
            if not isinstance(value, str):
                raise PreviewAgentRegistrationError(
                    f"agent Certificate Secret {key} is invalid"
                )
            try:
                decoded = base64.b64decode(value, validate=True)
            except (binascii.Error, ValueError) as exc:
                raise PreviewAgentRegistrationError(
                    f"agent Certificate Secret {key} is invalid"
                ) from exc
            if not decoded:
                raise PreviewAgentRegistrationError(
                    f"agent Certificate Secret {key} is empty"
                )
        return data

    def _validate_leaf_certificate(
        self,
        data: Mapping[str, str],
        *,
        environment: PreviewAgentEnvironment,
        certificate_not_after: datetime,
    ) -> None:
        try:
            certificate = x509.load_pem_x509_certificate(
                base64.b64decode(data["tls.crt"], validate=True)
            )
            private_key = serialization.load_pem_private_key(
                base64.b64decode(data["tls.key"], validate=True), password=None
            )
            ca_certificates = x509.load_pem_x509_certificates(
                base64.b64decode(data["ca.crt"], validate=True)
            )
        except (TypeError, ValueError) as exc:
            raise PreviewAgentRegistrationError(
                "agent Certificate Secret does not contain valid PEM material"
            ) from exc
        if not ca_certificates:
            raise PreviewAgentRegistrationError(
                "agent Certificate Secret has an empty CA bundle"
            )
        common_names = certificate.subject.get_attributes_for_oid(NameOID.COMMON_NAME)
        if len(common_names) != 1 or common_names[0].value != agent_name(environment.id):
            raise PreviewAgentRegistrationError(
                "agent Certificate leaf common name does not match the preview agent"
            )
        public_key = certificate.public_key()
        if not isinstance(public_key, rsa.RSAPublicKey) or public_key.key_size != 2048:
            raise PreviewAgentRegistrationError(
                "agent Certificate leaf is not an RSA-2048 key"
            )
        if (
            private_key.public_key().public_bytes(
                serialization.Encoding.DER,
                serialization.PublicFormat.SubjectPublicKeyInfo,
            )
            != public_key.public_bytes(
                serialization.Encoding.DER,
                serialization.PublicFormat.SubjectPublicKeyInfo,
            )
        ):
            raise PreviewAgentRegistrationError(
                "agent Certificate leaf and private key do not match"
            )
        try:
            extended_usage = certificate.extensions.get_extension_for_class(
                x509.ExtendedKeyUsage
            ).value
        except x509.ExtensionNotFound as exc:
            raise PreviewAgentRegistrationError(
                "agent Certificate leaf has no extended key usage"
            ) from exc
        if ExtendedKeyUsageOID.CLIENT_AUTH not in extended_usage:
            raise PreviewAgentRegistrationError(
                "agent Certificate leaf is not valid for client authentication"
            )
        try:
            key_usage = certificate.extensions.get_extension_for_class(
                x509.KeyUsage
            ).value
        except x509.ExtensionNotFound as exc:
            raise PreviewAgentRegistrationError(
                "agent Certificate leaf has no key usage"
            ) from exc
        if not key_usage.digital_signature or not key_usage.key_encipherment:
            raise PreviewAgentRegistrationError(
                "agent Certificate leaf lacks the required key usages"
            )
        now = self.now().astimezone(UTC)
        if now < certificate.not_valid_before_utc or now >= certificate.not_valid_after_utc:
            raise PreviewAgentRegistrationError(
                "agent Certificate leaf is not currently valid"
            )
        self._verify_leaf_chain(certificate, ca_certificates, now=now)
        required_not_after = environment.expires_at.astimezone(
            UTC
        ) + CERTIFICATE_EXPIRY_MARGIN
        leaf_not_after = certificate.not_valid_after_utc
        if leaf_not_after < required_not_after:
            raise PreviewAgentRegistrationError(
                "agent Certificate leaf expires before the preview cleanup margin"
            )
        if leaf_not_after != certificate_not_after:
            raise PreviewAgentRegistrationError(
                "agent Certificate leaf expiry does not match Certificate status"
            )

    def _verify_leaf_chain(
        self,
        certificate: x509.Certificate,
        ca_certificates: list[x509.Certificate],
        *,
        now: datetime,
    ) -> None:
        issuers: list[x509.Certificate] = []
        for ca_certificate in ca_certificates:
            try:
                constraints = ca_certificate.extensions.get_extension_for_class(
                    x509.BasicConstraints
                ).value
            except x509.ExtensionNotFound as exc:
                raise PreviewAgentRegistrationError(
                    "agent Certificate CA is missing BasicConstraints"
                ) from exc
            if not constraints.ca:
                raise PreviewAgentRegistrationError(
                    "agent Certificate CA BasicConstraints does not permit signing"
                )
            try:
                ca_key_usage = ca_certificate.extensions.get_extension_for_class(
                    x509.KeyUsage
                ).value
            except x509.ExtensionNotFound:
                ca_key_usage = None
            if ca_key_usage is not None and not ca_key_usage.key_cert_sign:
                raise PreviewAgentRegistrationError(
                    "agent Certificate CA key usage does not permit signing"
                )
            if (
                now < ca_certificate.not_valid_before_utc
                or now >= ca_certificate.not_valid_after_utc
            ):
                raise PreviewAgentRegistrationError(
                    "agent Certificate CA is not currently valid"
                )
            if certificate.issuer == ca_certificate.subject:
                issuers.append(ca_certificate)
        if not issuers:
            raise PreviewAgentRegistrationError(
                "agent Certificate leaf issuer is absent from the CA bundle"
            )
        for issuer in issuers:
            try:
                self._verify_signature(certificate, issuer)
                return
            except (InvalidSignature, TypeError, ValueError, UnsupportedAlgorithm):
                continue
        raise PreviewAgentRegistrationError(
            "agent Certificate leaf signature does not verify against the CA bundle"
        )

    @staticmethod
    def _verify_signature(
        certificate: x509.Certificate, issuer: x509.Certificate
    ) -> None:
        public_key = issuer.public_key()
        if isinstance(public_key, rsa.RSAPublicKey):
            public_key.verify(
                certificate.signature,
                certificate.tbs_certificate_bytes,
                certificate.signature_algorithm_parameters,
                certificate.signature_hash_algorithm,
            )
        elif isinstance(public_key, ec.EllipticCurvePublicKey):
            public_key.verify(
                certificate.signature,
                certificate.tbs_certificate_bytes,
                certificate.signature_algorithm_parameters,
            )
        elif isinstance(public_key, dsa.DSAPublicKey):
            public_key.verify(
                certificate.signature,
                certificate.tbs_certificate_bytes,
                certificate.signature_hash_algorithm,
            )
        elif isinstance(
            public_key, (ed25519.Ed25519PublicKey, ed448.Ed448PublicKey)
        ):
            public_key.verify(
                certificate.signature,
                certificate.tbs_certificate_bytes,
            )
        else:
            raise UnsupportedAlgorithm("unsupported CA public key type")

    def _get_mapping_external_secret(self, preview_id: str) -> dict[str, Any] | None:
        try:
            return self.custom_api.get_namespaced_custom_object(
                group=EXTERNAL_SECRET_GROUP,
                version=EXTERNAL_SECRET_VERSION,
                namespace=ARGO_NAMESPACE,
                plural=EXTERNAL_SECRET_PLURAL,
                name=mapping_secret_name(preview_id),
            )
        except ApiException as exc:
            if _status(exc) == 404:
                return None
            raise

    def _upsert_mapping_external_secret(
        self, environment: PreviewAgentEnvironment
    ) -> dict[str, Any]:
        desired = build_mapping_external_secret(environment)
        existing = self._get_mapping_external_secret(environment.id)
        if existing is None:
            try:
                return self.custom_api.create_namespaced_custom_object(
                    group=EXTERNAL_SECRET_GROUP,
                    version=EXTERNAL_SECRET_VERSION,
                    namespace=ARGO_NAMESPACE,
                    plural=EXTERNAL_SECRET_PLURAL,
                    body=desired,
                )
            except ApiException:
                existing = self._get_mapping_external_secret(environment.id)
                if existing is None:
                    raise
        self._assert_owned(
            existing,
            environment_id=environment.id,
            environment_uid=environment.uid,
            expected_namespace=ARGO_NAMESPACE,
            expected_name=mapping_secret_name(environment.id),
        )
        if existing.get("spec") != desired["spec"]:
            return self.custom_api.patch_namespaced_custom_object(
                group=EXTERNAL_SECRET_GROUP,
                version=EXTERNAL_SECRET_VERSION,
                namespace=ARGO_NAMESPACE,
                plural=EXTERNAL_SECRET_PLURAL,
                name=mapping_secret_name(environment.id),
                body={"spec": desired["spec"]},
            )
        return existing

    def _mapping_readiness(self, external_secret: Mapping[str, Any]) -> bool:
        metadata = _mapping(external_secret.get("metadata")) or {}
        status = _mapping(external_secret.get("status"))
        if status is None:
            return False
        generation = metadata.get("generation")
        observed_generation = status.get("observedGeneration")
        if (
            observed_generation is not None
            and generation is not None
            and observed_generation != generation
        ):
            return False
        conditions = status.get("conditions")
        return any(
            isinstance(condition, Mapping)
            and condition.get("type") == "Ready"
            and str(condition.get("status", "")).lower() == "true"
            for condition in conditions or []
        )

    def _delete_mapping_external_secret(
        self, preview_id: str, environment_uid: str
    ) -> None:
        existing = self._get_mapping_external_secret(preview_id)
        if existing is None:
            return
        self._assert_owned(
            existing,
            environment_id=preview_id,
            environment_uid=environment_uid,
            expected_namespace=ARGO_NAMESPACE,
            expected_name=mapping_secret_name(preview_id),
        )
        try:
            self.custom_api.delete_namespaced_custom_object(
                group=EXTERNAL_SECRET_GROUP,
                version=EXTERNAL_SECRET_VERSION,
                namespace=ARGO_NAMESPACE,
                plural=EXTERNAL_SECRET_PLURAL,
                name=mapping_secret_name(preview_id),
                body={"propagationPolicy": "Foreground"},
            )
        except ApiException as exc:
            if _status(exc) != 404:
                raise

    def _delete_secret(
        self,
        *,
        namespace: str,
        name: str,
        preview_id: str,
        environment_uid: str,
    ) -> None:
        existing = self._get_secret(namespace, name)
        if existing is None:
            return
        self._assert_owned(
            existing,
            environment_id=preview_id,
            environment_uid=environment_uid,
            expected_namespace=namespace,
            expected_name=name,
        )
        try:
            self.core_api.delete_namespaced_secret(namespace=namespace, name=name)
        except ApiException as exc:
            if _status(exc) != 404:
                raise

    def _delete_certificate(self, preview_id: str, environment_uid: str) -> None:
        existing = self._get_certificate(preview_id)
        if existing is None:
            return
        self._assert_owned(
            existing,
            environment_id=preview_id,
            environment_uid=environment_uid,
            expected_namespace=CERTIFICATE_NAMESPACE,
            expected_name=certificate_name(preview_id),
        )
        try:
            self.custom_api.delete_namespaced_custom_object(
                group=CERTIFICATE_GROUP,
                version=CERTIFICATE_VERSION,
                namespace=CERTIFICATE_NAMESPACE,
                plural=CERTIFICATE_PLURAL,
                name=certificate_name(preview_id),
                body={"propagationPolicy": "Foreground"},
            )
        except ApiException as exc:
            if _status(exc) != 404:
                raise

    def _delete_mapping_secret(self, preview_id: str) -> bool:
        """Delete by derived name; a later 404 is the absence proof.

        The controller deliberately has no read access to Secrets in the Argo
        namespace. Admission validates the old object's exact preview ownership
        tuple before allowing this delete.
        """
        try:
            self.core_api.delete_namespaced_secret(
                namespace=ARGO_NAMESPACE,
                name=mapping_secret_name(preview_id),
            )
        except ApiException as exc:
            if _status(exc) == 404:
                return True
            raise
        return False

    def _delete_agent_namespace(
        self, preview_id: str, environment_uid: str
    ) -> None:
        name = agent_name(preview_id)
        existing = self._get_namespace(name)
        if existing is None:
            return
        self._assert_owned(
            existing,
            environment_id=preview_id,
            environment_uid=environment_uid,
            expected_namespace="",
            expected_name=name,
        )
        try:
            self.core_api.delete_namespace(name=name)
        except ApiException as exc:
            if _status(exc) != 404:
                raise

    def _all_absent(self, preview_id: str) -> bool:
        return all(
            value is None
            for value in (
                self._get_mapping_external_secret(preview_id),
                self._get_certificate(preview_id),
                self._get_secret(
                    CERTIFICATE_NAMESPACE, certificate_secret_name(preview_id)
                ),
                self._get_namespace(agent_name(preview_id)),
            )
        )

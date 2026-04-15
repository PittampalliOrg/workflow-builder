"""PKCE helpers for OAuth 2.0 authorization code flow."""

import hashlib
import secrets
from base64 import urlsafe_b64encode


def _base64url_encode(data: bytes) -> str:
    return urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def generate_code_verifier() -> str:
    return _base64url_encode(secrets.token_bytes(32))


def generate_code_challenge(verifier: str) -> str:
    digest = hashlib.sha256(verifier.encode("ascii")).digest()
    return _base64url_encode(digest)


def generate_state() -> str:
    return _base64url_encode(secrets.token_bytes(32))

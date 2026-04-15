from __future__ import annotations

import hashlib
import importlib
import os
import sys
import time
from base64 import urlsafe_b64decode

import pytest

root = os.path.join(os.path.dirname(__file__), "..")
if root not in sys.path:
    sys.path.insert(0, root)

crypto = importlib.import_module("src.oauth.crypto")
types_mod = importlib.import_module("src.oauth.types")
manager_mod = importlib.import_module("src.oauth.manager")


def _make_manager():
    manager = manager_mod.OAuthManager(state_store_name="test-store")
    cache: dict[str, dict] = {}

    manager._save_state = lambda key, value: cache.__setitem__(key, value)  # type: ignore[method-assign]
    manager._load_state = lambda key: cache.get(key)  # type: ignore[method-assign]
    manager._delete_state = lambda key: cache.pop(key, None)  # type: ignore[method-assign]
    return manager


def test_pkce_challenge_uses_sha256() -> None:
    verifier = crypto.generate_code_verifier()
    challenge = crypto.generate_code_challenge(verifier)
    padded = challenge + "=" * (-len(challenge) % 4)
    assert urlsafe_b64decode(padded) == hashlib.sha256(verifier.encode("ascii")).digest()


def test_pkce_values_are_urlsafe() -> None:
    verifier = crypto.generate_code_verifier()
    state = crypto.generate_state()
    assert len(verifier) == 43
    assert len(state) == 43
    assert not set(verifier + state).intersection({"+", "/", "="})


def test_oauth_tokens_round_trip() -> None:
    tokens = types_mod.OAuthTokens(
        access_token="access",
        refresh_token="refresh",
        expires_at=123,
        scopes=["user:inference"],
        subscription_type="max",
    )
    assert types_mod.OAuthTokens(**tokens.model_dump()) == tokens


def test_start_login_persists_state() -> None:
    manager = _make_manager()
    result = manager.start_login()
    raw = manager._load_state("oauth:login_state")
    assert "claude.ai" in result["authorize_url"]
    assert result["completion_mode"] == "manual_paste"
    assert raw is not None
    login_state = types_mod.OAuthLoginState(**raw)
    assert login_state.redirect_uri == manager_mod.DEFAULT_REDIRECT_URI
    assert login_state.state == login_state.code_verifier


def test_parse_callback_code_from_url() -> None:
    manager = _make_manager()
    code, state = manager._parse_callback_code(
        "https://console.anthropic.com/oauth/code/callback?code=abc123&state=state456"
    )
    assert code == "abc123"
    assert state == "state456"


def test_parse_callback_code_hash_delimited() -> None:
    manager = _make_manager()
    code, state = manager._parse_callback_code("abc123#state456")
    assert code == "abc123"
    assert state == "state456"


def test_parse_callback_code_only() -> None:
    manager = _make_manager()
    code, state = manager._parse_callback_code("abc123")
    assert code == "abc123"
    assert state is None


def test_auth_status_unauthenticated() -> None:
    assert _make_manager().get_auth_status() == {"authenticated": False}


def test_auth_status_authenticated() -> None:
    manager = _make_manager()
    manager._save_tokens(
        types_mod.OAuthTokens(
            access_token="token",
            expires_at=int(time.time() * 1000) + 3600_000,
            email="user@example.test",
            subscription_type="max",
        )
    )
    status = manager.get_auth_status()
    assert status["authenticated"] is True
    assert status["email"] == "user@example.test"
    assert status["subscription_type"] == "max"


@pytest.mark.asyncio
async def test_logout_clears_tokens() -> None:
    manager = _make_manager()
    manager._save_tokens(types_mod.OAuthTokens(access_token="token", expires_at=1))
    await manager.logout()
    assert manager.get_access_token() is None

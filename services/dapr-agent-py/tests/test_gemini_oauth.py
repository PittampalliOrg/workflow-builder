from __future__ import annotations

import importlib
import os
import sys
import time

import pytest

root = os.path.join(os.path.dirname(__file__), "..")
if root not in sys.path:
    sys.path.insert(0, root)

manager_mod = importlib.import_module("src.gemini_oauth.manager")
types_mod = importlib.import_module("src.gemini_oauth.types")


def _make_manager(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv("GEMINI_OAUTH_CLIENT_ID", "client-123.apps.googleusercontent.com")
    monkeypatch.setenv("GEMINI_OAUTH_REDIRECT_URI", "https://agent.example.test/gemini-oauth/callback")
    manager = manager_mod.GeminiOAuthManager(state_store_name="test-store")
    cache: dict[str, dict] = {}

    manager._save_state = lambda key, value: cache.__setitem__(key, value)  # type: ignore[method-assign]
    manager._load_state = lambda key: cache.get(key)  # type: ignore[method-assign]
    manager._delete_state = lambda key: cache.pop(key, None)  # type: ignore[method-assign]
    return manager


def test_start_login_persists_pkce_state(monkeypatch: pytest.MonkeyPatch) -> None:
    manager = _make_manager(monkeypatch)
    result = manager.start_login()
    raw = manager._load_state("gemini_oauth:login_state")

    assert result["completion_mode"] == "callback_or_manual_paste"
    assert result["authorize_url"].startswith("https://accounts.google.com/o/oauth2/v2/auth?")
    assert "code_challenge_method=S256" in result["authorize_url"]
    assert raw is not None

    state = types_mod.GeminiOAuthLoginState(**raw)
    assert state.redirect_uri == "https://agent.example.test/gemini-oauth/callback"
    assert "https://www.googleapis.com/auth/cloud-platform" in state.scopes


@pytest.mark.asyncio
async def test_complete_login_exchanges_code_and_saves_tokens(monkeypatch: pytest.MonkeyPatch) -> None:
    manager = _make_manager(monkeypatch)
    login = manager.start_login()

    def post_form(url: str, payload: dict[str, str], timeout: int) -> dict:
        assert url == manager_mod.TOKEN_URL
        assert payload["grant_type"] == "authorization_code"
        assert payload["client_id"] == "client-123.apps.googleusercontent.com"
        assert payload["code_verifier"]
        return {
            "access_token": "access-123",
            "refresh_token": "refresh-123",
            "id_token": "id-123",
            "expires_in": 3600,
            "scope": "openid email profile https://www.googleapis.com/auth/cloud-platform",
        }

    async def fetch_userinfo(access_token: str) -> dict:
        assert access_token == "access-123"
        return {"email": "user@example.test", "name": "Test User"}

    manager._post_form = post_form  # type: ignore[method-assign]
    manager._fetch_userinfo = fetch_userinfo  # type: ignore[method-assign]
    callback_url = f"https://agent.example.test/gemini-oauth/callback?code=code-123&state={login['state']}"
    tokens = await manager.complete_login(callback_url)
    status = manager.get_auth_status()

    assert tokens.access_token == "access-123"
    assert tokens.refresh_token == "refresh-123"
    assert status["authenticated"] is True
    assert status["email"] == "user@example.test"
    assert manager.get_auth_headers() == {"Authorization": "Bearer access-123"}


@pytest.mark.asyncio
async def test_refresh_token_uses_stored_refresh_token(monkeypatch: pytest.MonkeyPatch) -> None:
    manager = _make_manager(monkeypatch)
    manager._save_tokens(types_mod.GeminiOAuthTokens(
        access_token="old-access",
        refresh_token="refresh-123",
        expires_at=int(time.time() * 1000) + 60_000,
        scopes=["openid"],
        email="user@example.test",
    ))

    def post_form(url: str, payload: dict[str, str], timeout: int) -> dict:
        assert payload["grant_type"] == "refresh_token"
        assert payload["refresh_token"] == "refresh-123"
        return {"access_token": "new-access", "expires_in": 3600}

    async def fetch_userinfo(access_token: str) -> dict:
        assert access_token == "new-access"
        return {"email": "user@example.test"}

    manager._post_form = post_form  # type: ignore[method-assign]
    manager._fetch_userinfo = fetch_userinfo  # type: ignore[method-assign]
    updated = await manager.refresh_token()

    assert updated is not None
    assert updated.access_token == "new-access"
    assert updated.refresh_token == "refresh-123"


@pytest.mark.asyncio
async def test_logout_clears_tokens(monkeypatch: pytest.MonkeyPatch) -> None:
    manager = _make_manager(monkeypatch)
    manager._save_tokens(types_mod.GeminiOAuthTokens(access_token="access", expires_at=1))
    await manager.logout()
    assert manager.get_access_token() is None

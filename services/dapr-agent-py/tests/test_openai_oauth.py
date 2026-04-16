from __future__ import annotations

import base64
import importlib
import json
import os
import sys
import time
from urllib.error import HTTPError

import pytest

root = os.path.join(os.path.dirname(__file__), "..")
if root not in sys.path:
    sys.path.insert(0, root)

manager_mod = importlib.import_module("src.openai_oauth.manager")
types_mod = importlib.import_module("src.openai_oauth.types")


def _jwt(payload: dict) -> str:
    header = base64.urlsafe_b64encode(json.dumps({"alg": "none"}).encode()).rstrip(b"=")
    body = base64.urlsafe_b64encode(json.dumps(payload).encode()).rstrip(b"=")
    return f"{header.decode()}.{body.decode()}.sig"


def _make_manager():
    manager = manager_mod.OpenAIOAuthManager(state_store_name="test-store")
    cache: dict[str, dict] = {}

    manager._save_state = lambda key, value: cache.__setitem__(key, value)  # type: ignore[method-assign]
    manager._load_state = lambda key: cache.get(key)  # type: ignore[method-assign]
    manager._delete_state = lambda key: cache.pop(key, None)  # type: ignore[method-assign]
    return manager


def test_openai_token_metadata_from_jwt() -> None:
    exp = int(time.time()) + 3600
    token = _jwt({
        "email": "user@example.test",
        "exp": exp,
        "https://api.openai.com/auth": {
            "chatgpt_plan_type": "plus",
            "chatgpt_user_id": "user-123",
            "chatgpt_account_id": "account-456",
        },
    })
    manager = _make_manager()
    tokens = manager._tokens_from_response({
        "id_token": token,
        "access_token": "access",
        "refresh_token": "refresh",
    })
    assert tokens.email == "user@example.test"
    assert tokens.chatgpt_plan_type == "plus"
    assert tokens.chatgpt_user_id == "user-123"
    assert tokens.chatgpt_account_id == "account-456"
    assert tokens.expires_at == exp * 1000


def test_start_login_persists_device_state() -> None:
    manager = _make_manager()

    def post_json(url: str, payload: dict, timeout: int) -> dict:
        assert url.endswith("/api/accounts/deviceauth/usercode")
        assert payload["client_id"] == manager_mod.DEFAULT_CLIENT_ID
        return {
            "device_auth_id": "device-123",
            "user_code": "ABCD-EFGH",
            "interval": 3,
            "expires_in": 600,
        }

    manager._post_json = post_json  # type: ignore[method-assign]
    result = manager.start_login()
    raw = manager._load_state("openai_oauth:device_login_state")
    assert result["completion_mode"] == "device_code"
    assert result["verification_url"].endswith("/codex/device")
    assert result["user_code"] == "ABCD-EFGH"
    assert raw is not None
    state = types_mod.OpenAIDeviceLoginState(**raw)
    assert state.device_auth_id == "device-123"
    assert state.interval == 3


@pytest.mark.asyncio
async def test_poll_login_pending_on_403() -> None:
    manager = _make_manager()
    manager._save_state(
        "openai_oauth:device_login_state",
        types_mod.OpenAIDeviceLoginState(
            device_auth_id="device-123",
            user_code="ABCD-EFGH",
            verification_url="https://auth.openai.com/codex/device",
            interval=3,
            expires_at=int(time.time() * 1000) + 60_000,
            created_at=int(time.time() * 1000),
        ).model_dump(),
    )

    def post_json(url: str, payload: dict, timeout: int) -> dict:
        raise HTTPError(url, 403, "pending", {}, None)

    manager._post_json = post_json  # type: ignore[method-assign]
    result = await manager.poll_login()
    assert result["authenticated"] is False
    assert result["pending"] is True


@pytest.mark.asyncio
async def test_poll_login_success_saves_tokens() -> None:
    manager = _make_manager()
    manager._save_state(
        "openai_oauth:device_login_state",
        types_mod.OpenAIDeviceLoginState(
            device_auth_id="device-123",
            user_code="ABCD-EFGH",
            verification_url="https://auth.openai.com/codex/device",
            interval=3,
            expires_at=int(time.time() * 1000) + 60_000,
            created_at=int(time.time() * 1000),
        ).model_dump(),
    )
    token = _jwt({
        "email": "user@example.test",
        "exp": int(time.time()) + 3600,
        "https://api.openai.com/auth": {
            "chatgpt_plan_type": "team",
            "chatgpt_account_id": "account-123",
        },
    })

    def post_json(url: str, payload: dict, timeout: int) -> dict:
        assert url.endswith("/api/accounts/deviceauth/token")
        return {"authorization_code": "code-123", "code_verifier": "verifier-123"}

    def post_form(url: str, payload: dict, timeout: int) -> dict:
        assert url.endswith("/oauth/token")
        assert payload["grant_type"] == "authorization_code"
        assert payload["redirect_uri"].endswith("/deviceauth/callback")
        return {"id_token": token, "access_token": "access", "refresh_token": "refresh"}

    manager._post_json = post_json  # type: ignore[method-assign]
    manager._post_form = post_form  # type: ignore[method-assign]
    result = await manager.poll_login()
    status = manager.get_auth_status()
    assert result["authenticated"] is True
    assert status["authenticated"] is True
    assert status["email"] == "user@example.test"
    assert status["chatgpt_account_id"] == "account-123"


@pytest.mark.asyncio
async def test_logout_clears_openai_tokens() -> None:
    manager = _make_manager()
    manager._save_tokens(types_mod.OpenAIOAuthTokens(access_token="access", expires_at=1))
    await manager.logout()
    assert manager.get_access_token() is None

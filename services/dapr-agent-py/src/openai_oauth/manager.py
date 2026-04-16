"""Codex-style OpenAI OAuth manager.

This mirrors the OpenAI Codex CLI device-code flow:
- request a user code from auth.openai.com
- user authorizes at auth.openai.com/codex/device
- poll for an authorization code
- exchange that code with PKCE verifier for ChatGPT OAuth tokens

Tokens are stored in the configured Dapr state store, and only non-secret
metadata is exposed through status endpoints.
"""

from __future__ import annotations

import asyncio
import base64
import json
import logging
import os
import time
from typing import Any
from urllib.error import HTTPError
from urllib.parse import urlencode
import urllib.request

from .types import OpenAIDeviceLoginState, OpenAIOAuthTokens

logger = logging.getLogger(__name__)

DEFAULT_ISSUER = "https://auth.openai.com"
DEFAULT_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann"
DEFAULT_DEVICE_REDIRECT_PATH = "/deviceauth/callback"
DEFAULT_DEVICE_EXPIRES_SECONDS = 15 * 60

TOKEN_REFRESH_BUFFER_MS = 5 * 60 * 1000
TOKEN_EXCHANGE_TIMEOUT = 20
DEVICE_POLL_TIMEOUT = 20

STATE_KEY = "openai_oauth:tokens"
LOGIN_STATE_KEY = "openai_oauth:device_login_state"


def _now_ms() -> int:
    return int(time.time() * 1000)


def _issuer() -> str:
    return os.environ.get("OPENAI_CODEX_ISSUER", DEFAULT_ISSUER).rstrip("/")


def _client_id() -> str:
    return os.environ.get("OPENAI_CODEX_OAUTH_CLIENT_ID", DEFAULT_CLIENT_ID)


def _jwt_claims(token: str | None) -> dict[str, Any]:
    if not token:
        return {}
    try:
        parts = token.split(".")
        if len(parts) < 2:
            return {}
        payload = parts[1] + "=" * (-len(parts[1]) % 4)
        return json.loads(base64.urlsafe_b64decode(payload.encode("ascii")))
    except Exception:
        return {}


def _token_metadata(id_token: str | None, access_token: str | None = None) -> dict[str, Any]:
    claims = _jwt_claims(id_token) or _jwt_claims(access_token)
    auth_claims = claims.get("https://api.openai.com/auth")
    if not isinstance(auth_claims, dict):
        auth_claims = {}
    return {
        "email": (
            claims.get("email")
            or claims.get("https://api.openai.com/profile.email")
            or auth_claims.get("email")
        ),
        "chatgpt_plan_type": auth_claims.get("chatgpt_plan_type"),
        "chatgpt_user_id": (
            auth_claims.get("chatgpt_user_id")
            or auth_claims.get("user_id")
        ),
        "chatgpt_account_id": (
            claims.get("chatgpt_account_id")
            or auth_claims.get("chatgpt_account_id")
            or auth_claims.get("account_id")
        ),
        "exp": claims.get("exp"),
    }


class OpenAIOAuthManager:
    """Manage Codex-style OpenAI OAuth tokens in Dapr state."""

    def __init__(self, state_store_name: str | None = None) -> None:
        self._store = state_store_name or os.environ.get(
            "AGENT_STATE_STORE",
            "dapr-agent-py-statestore",
        )
        self._refresh_task: asyncio.Task | None = None
        self._refresh_lock = asyncio.Lock()
        self._cached_tokens: OpenAIOAuthTokens | None = None

    @property
    def _sidecar(self) -> str:
        host = os.environ.get("DAPR_HOST", "127.0.0.1")
        port = os.environ.get("DAPR_HTTP_PORT", "3500")
        return f"http://{host}:{port}"

    def _save_state(self, key: str, value: dict | str) -> None:
        payload = json.dumps([{"key": key, "value": json.dumps(value)}]).encode()
        req = urllib.request.Request(
            f"{self._sidecar}/v1.0/state/{self._store}",
            data=payload,
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        urllib.request.urlopen(req, timeout=5)

    def _load_state(self, key: str) -> dict | None:
        try:
            with urllib.request.urlopen(
                f"{self._sidecar}/v1.0/state/{self._store}/{key}",
                timeout=5,
            ) as resp:
                body = resp.read()
        except Exception:
            return None
        if not body:
            return None
        try:
            data = json.loads(body)
            if isinstance(data, str):
                data = json.loads(data)
            return data if isinstance(data, dict) else None
        except Exception:
            return None

    def _delete_state(self, key: str) -> None:
        req = urllib.request.Request(
            f"{self._sidecar}/v1.0/state/{self._store}/{key}",
            method="DELETE",
        )
        try:
            urllib.request.urlopen(req, timeout=5)
        except Exception:
            pass

    def _save_tokens(self, tokens: OpenAIOAuthTokens) -> None:
        self._cached_tokens = tokens
        self._save_state(STATE_KEY, tokens.model_dump())

    def _load_tokens(self) -> OpenAIOAuthTokens | None:
        if self._cached_tokens is not None:
            return self._cached_tokens
        data = self._load_state(STATE_KEY)
        if data is None:
            return None
        try:
            tokens = OpenAIOAuthTokens(**data)
            self._cached_tokens = tokens
            return tokens
        except Exception:
            logger.warning("Failed to parse stored OpenAI OAuth tokens")
            return None

    def _post_json(self, url: str, payload: dict[str, Any], timeout: int) -> dict[str, Any]:
        body = json.dumps(payload).encode()
        req = urllib.request.Request(
            url,
            data=body,
            headers={
                "Accept": "application/json",
                "Content-Type": "application/json",
                "User-Agent": "codex-cli/0.120 workflow-builder",
            },
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return json.loads(resp.read() or b"{}")

    def _post_form(self, url: str, payload: dict[str, str], timeout: int) -> dict[str, Any]:
        body = urlencode(payload).encode()
        req = urllib.request.Request(
            url,
            data=body,
            headers={
                "Accept": "application/json",
                "Content-Type": "application/x-www-form-urlencoded",
                "User-Agent": "codex-cli/0.120 workflow-builder",
            },
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return json.loads(resp.read() or b"{}")

    def start_login(self) -> dict[str, Any]:
        issuer = _issuer()
        api_base_url = f"{issuer}/api/accounts"
        data = self._post_json(
            f"{api_base_url}/deviceauth/usercode",
            {"client_id": _client_id()},
            timeout=TOKEN_EXCHANGE_TIMEOUT,
        )
        interval = int(data.get("interval") or 5)
        expires_in = int(data.get("expires_in") or DEFAULT_DEVICE_EXPIRES_SECONDS)
        state = OpenAIDeviceLoginState(
            device_auth_id=str(data["device_auth_id"]),
            user_code=str(data["user_code"]),
            verification_url=f"{issuer}/codex/device",
            interval=interval,
            expires_at=_now_ms() + expires_in * 1000,
            created_at=_now_ms(),
        )
        self._save_state(LOGIN_STATE_KEY, state.model_dump())
        return {
            "provider": "openai",
            "completion_mode": "device_code",
            "verification_url": state.verification_url,
            "user_code": state.user_code,
            "interval": state.interval,
            "expires_at": state.expires_at,
        }

    async def poll_login(self) -> dict[str, Any]:
        raw = self._load_state(LOGIN_STATE_KEY)
        if raw is None:
            raise ValueError("No pending OpenAI login found; start login again")
        state = OpenAIDeviceLoginState(**raw)
        if _now_ms() >= state.expires_at:
            self._delete_state(LOGIN_STATE_KEY)
            raise ValueError("OpenAI login code expired; start login again")

        issuer = _issuer()
        try:
            data = self._post_json(
                f"{issuer}/api/accounts/deviceauth/token",
                {
                    "device_auth_id": state.device_auth_id,
                    "user_code": state.user_code,
                },
                timeout=DEVICE_POLL_TIMEOUT,
            )
        except HTTPError as exc:
            if exc.code in (403, 404):
                return {
                    "authenticated": False,
                    "pending": True,
                    "interval": state.interval,
                    "expires_at": state.expires_at,
                }
            detail = exc.read().decode("utf-8", errors="replace")
            raise RuntimeError(f"OpenAI device auth failed ({exc.code}): {detail}") from exc

        code = data.get("authorization_code")
        code_verifier = data.get("code_verifier")
        if not code or not code_verifier:
            return {
                "authenticated": False,
                "pending": True,
                "interval": state.interval,
                "expires_at": state.expires_at,
            }

        tokens = await self._exchange_authorization_code(str(code), str(code_verifier))
        self._save_tokens(tokens)
        self._delete_state(LOGIN_STATE_KEY)
        self._ensure_refresh_task()
        return {
            "authenticated": True,
            "pending": False,
            "email": tokens.email,
            "chatgpt_plan_type": tokens.chatgpt_plan_type,
            "chatgpt_account_id": tokens.chatgpt_account_id,
            "expires_at": tokens.expires_at,
        }

    async def _exchange_authorization_code(
        self,
        code: str,
        code_verifier: str,
    ) -> OpenAIOAuthTokens:
        issuer = _issuer()
        token_data = self._post_form(
            f"{issuer}/oauth/token",
            {
                "grant_type": "authorization_code",
                "code": code,
                "redirect_uri": f"{issuer}{DEFAULT_DEVICE_REDIRECT_PATH}",
                "client_id": _client_id(),
                "code_verifier": code_verifier,
            },
            timeout=TOKEN_EXCHANGE_TIMEOUT,
        )
        return self._tokens_from_response(token_data)

    def _tokens_from_response(
        self,
        token_data: dict[str, Any],
        previous: OpenAIOAuthTokens | None = None,
    ) -> OpenAIOAuthTokens:
        id_token = token_data.get("id_token") or (previous.id_token if previous else None)
        access_token = token_data.get("access_token") or (previous.access_token if previous else None)
        if not access_token:
            raise RuntimeError("OpenAI OAuth response did not include an access token")
        metadata = _token_metadata(id_token, access_token)
        expires_at = None
        if metadata.get("exp"):
            expires_at = int(metadata["exp"]) * 1000
        elif token_data.get("expires_in"):
            expires_at = _now_ms() + int(token_data["expires_in"]) * 1000
        elif previous:
            expires_at = previous.expires_at
        else:
            expires_at = _now_ms() + 60 * 60 * 1000

        return OpenAIOAuthTokens(
            id_token=id_token,
            access_token=str(access_token),
            refresh_token=token_data.get("refresh_token")
            or (previous.refresh_token if previous else None),
            expires_at=expires_at,
            email=metadata.get("email") or (previous.email if previous else None),
            chatgpt_plan_type=metadata.get("chatgpt_plan_type")
            or (previous.chatgpt_plan_type if previous else None),
            chatgpt_user_id=metadata.get("chatgpt_user_id")
            or (previous.chatgpt_user_id if previous else None),
            chatgpt_account_id=metadata.get("chatgpt_account_id")
            or (previous.chatgpt_account_id if previous else None),
        )

    async def refresh_token(self) -> OpenAIOAuthTokens | None:
        async with self._refresh_lock:
            tokens = self._load_tokens()
            if tokens is None or tokens.refresh_token is None:
                return None
            try:
                data = self._post_json(
                    f"{_issuer()}/oauth/token",
                    {
                        "client_id": _client_id(),
                        "grant_type": "refresh_token",
                        "refresh_token": tokens.refresh_token,
                    },
                    timeout=TOKEN_EXCHANGE_TIMEOUT,
                )
            except Exception as exc:
                logger.error("OpenAI OAuth token refresh failed: %s", exc)
                return None
            updated = self._tokens_from_response(data, previous=tokens)
            self._save_tokens(updated)
            return updated

    def get_access_token(self) -> str | None:
        tokens = self._load_tokens()
        if tokens is None:
            return None
        if _now_ms() + TOKEN_REFRESH_BUFFER_MS >= tokens.expires_at:
            self._ensure_refresh_task()
        return tokens.access_token

    def get_auth_headers(self) -> dict[str, str] | None:
        tokens = self._load_tokens()
        if tokens is None:
            return None
        headers = {"Authorization": f"Bearer {tokens.access_token}"}
        if tokens.chatgpt_account_id:
            headers["chatgpt-account-id"] = tokens.chatgpt_account_id
        return headers

    def get_auth_status(self) -> dict[str, Any]:
        tokens = self._load_tokens()
        if tokens is None:
            pending = None
            raw = self._load_state(LOGIN_STATE_KEY)
            if raw:
                try:
                    state = OpenAIDeviceLoginState(**raw)
                    pending = {
                        "verification_url": state.verification_url,
                        "user_code": state.user_code,
                        "interval": state.interval,
                        "expires_at": state.expires_at,
                    }
                except Exception:
                    pending = None
            return {"authenticated": False, "pending_login": pending}
        now_ms = _now_ms()
        return {
            "authenticated": True,
            "email": tokens.email,
            "chatgpt_plan_type": tokens.chatgpt_plan_type,
            "chatgpt_user_id": tokens.chatgpt_user_id,
            "chatgpt_account_id": tokens.chatgpt_account_id,
            "expires_at": tokens.expires_at,
            "expired": now_ms >= tokens.expires_at,
        }

    async def logout(self) -> None:
        self._cached_tokens = None
        self._delete_state(STATE_KEY)
        self._delete_state(LOGIN_STATE_KEY)
        if self._refresh_task and not self._refresh_task.done():
            self._refresh_task.cancel()
        self._refresh_task = None

    def start_refresh_task(self) -> None:
        tokens = self._load_tokens()
        if tokens is not None and tokens.refresh_token is not None:
            self._ensure_refresh_task()

    def _ensure_refresh_task(self) -> None:
        if self._refresh_task is not None and not self._refresh_task.done():
            return
        try:
            loop = asyncio.get_running_loop()
            self._refresh_task = loop.create_task(self._refresh_loop())
        except RuntimeError:
            pass

    async def _refresh_loop(self) -> None:
        while True:
            tokens = self._load_tokens()
            if tokens is None or tokens.refresh_token is None:
                return
            sleep_ms = tokens.expires_at - TOKEN_REFRESH_BUFFER_MS - _now_ms()
            if sleep_ms > 0:
                await asyncio.sleep(sleep_ms / 1000)
            if await self.refresh_token() is None:
                logger.warning("OpenAI OAuth background token refresh failed; stopping loop")
                return


openai_oauth_manager = OpenAIOAuthManager()

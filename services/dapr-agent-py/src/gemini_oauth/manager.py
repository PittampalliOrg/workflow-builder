"""Google OAuth manager for Gemini/Vertex AI authentication.

Gemini CLI's interactive "Sign in with Google" flow uses Google OAuth with
PKCE and cloud-platform/profile scopes. This manager implements the same OAuth
shape in a server-friendly way: tokens are stored in Dapr state and model calls
can use the bearer token with Vertex AI Gemini endpoints.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import time
from typing import Any
import urllib.request
from urllib.parse import parse_qs, unquote, urlencode, urlparse

from src.oauth.crypto import generate_code_challenge, generate_code_verifier, generate_state

from .types import GeminiOAuthLoginState, GeminiOAuthTokens

logger = logging.getLogger(__name__)

AUTHORIZE_URL = "https://accounts.google.com/o/oauth2/v2/auth"
TOKEN_URL = "https://oauth2.googleapis.com/token"
USERINFO_URL = "https://openidconnect.googleapis.com/v1/userinfo"

DEFAULT_SCOPES = [
    "openid",
    "email",
    "profile",
    "https://www.googleapis.com/auth/cloud-platform",
]

TOKEN_REFRESH_BUFFER_MS = 5 * 60 * 1000
TOKEN_EXCHANGE_TIMEOUT = 20
USERINFO_TIMEOUT = 10

STATE_KEY = "gemini_oauth:tokens"
LOGIN_STATE_KEY = "gemini_oauth:login_state"


def _now_ms() -> int:
    return int(time.time() * 1000)


def _client_id() -> str | None:
    return os.environ.get("GEMINI_OAUTH_CLIENT_ID") or os.environ.get("GOOGLE_OAUTH_CLIENT_ID")


def _client_secret() -> str | None:
    return os.environ.get("GEMINI_OAUTH_CLIENT_SECRET") or os.environ.get("GOOGLE_OAUTH_CLIENT_SECRET")


def _callback_base_url() -> str:
    return (
        os.environ.get("GEMINI_OAUTH_CALLBACK_BASE_URL")
        or os.environ.get("OAUTH_CALLBACK_BASE_URL")
        or "https://dapr-agent-py.cnoe.localtest.me"
    ).rstrip("/")


def _redirect_uri() -> str:
    return os.environ.get("GEMINI_OAUTH_REDIRECT_URI") or f"{_callback_base_url()}/gemini-oauth/callback"


def _scopes() -> list[str]:
    raw = os.environ.get("GEMINI_OAUTH_SCOPES")
    if not raw:
        return DEFAULT_SCOPES
    return [scope for scope in raw.replace(",", " ").split() if scope]


def _configured_vertex_project() -> str | None:
    return os.environ.get("GOOGLE_CLOUD_PROJECT") or os.environ.get("GOOGLE_CLOUD_PROJECT_ID")


def _configured_vertex_location() -> str | None:
    return os.environ.get("GOOGLE_CLOUD_LOCATION") or os.environ.get("GOOGLE_VERTEX_LOCATION")


class GeminiOAuthManager:
    """Manage Google OAuth tokens in a Dapr state store."""

    def __init__(self, state_store_name: str | None = None) -> None:
        self._store = state_store_name or os.environ.get(
            "AGENT_STATE_STORE",
            "dapr-agent-py-statestore",
        )
        self._refresh_task: asyncio.Task | None = None
        self._refresh_lock = asyncio.Lock()
        self._cached_tokens: GeminiOAuthTokens | None = None

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

    def _save_tokens(self, tokens: GeminiOAuthTokens) -> None:
        self._cached_tokens = tokens
        self._save_state(STATE_KEY, tokens.model_dump())

    def _load_tokens(self) -> GeminiOAuthTokens | None:
        if self._cached_tokens is not None:
            return self._cached_tokens
        data = self._load_state(STATE_KEY)
        if data is None:
            return None
        try:
            tokens = GeminiOAuthTokens(**data)
            self._cached_tokens = tokens
            return tokens
        except Exception:
            logger.warning("Failed to parse stored Gemini OAuth tokens")
            return None

    def _post_form(self, url: str, payload: dict[str, str], timeout: int) -> dict[str, Any]:
        req = urllib.request.Request(
            url,
            data=urlencode(payload).encode(),
            headers={
                "Accept": "application/json",
                "Content-Type": "application/x-www-form-urlencoded",
                "User-Agent": "workflow-builder-gemini-oauth/1.0",
            },
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return json.loads(resp.read() or b"{}")

    async def _fetch_userinfo(self, access_token: str) -> dict[str, Any]:
        req = urllib.request.Request(
            USERINFO_URL,
            headers={
                "Accept": "application/json",
                "Authorization": f"Bearer {access_token}",
            },
            method="GET",
        )
        try:
            with urllib.request.urlopen(req, timeout=USERINFO_TIMEOUT) as resp:
                return json.loads(resp.read() or b"{}")
        except Exception as exc:
            logger.warning("Gemini OAuth userinfo fetch failed: %s", exc)
            return {}

    def start_login(self) -> dict[str, Any]:
        client_id = _client_id()
        if not client_id:
            raise ValueError("GEMINI_OAUTH_CLIENT_ID is not configured")

        verifier = generate_code_verifier()
        challenge = generate_code_challenge(verifier)
        state = generate_state()
        scopes = _scopes()
        redirect_uri = _redirect_uri()

        login_state = GeminiOAuthLoginState(
            code_verifier=verifier,
            code_challenge=challenge,
            state=state,
            redirect_uri=redirect_uri,
            scopes=scopes,
            created_at=_now_ms(),
        )
        self._save_state(LOGIN_STATE_KEY, login_state.model_dump())

        params = urlencode({
            "client_id": client_id,
            "redirect_uri": redirect_uri,
            "response_type": "code",
            "scope": " ".join(scopes),
            "code_challenge": challenge,
            "code_challenge_method": "S256",
            "state": state,
            "access_type": "offline",
            "prompt": "consent",
            "include_granted_scopes": "true",
        })
        return {
            "provider": "gemini",
            "authorize_url": f"{AUTHORIZE_URL}?{params}",
            "state": state,
            "redirect_uri": redirect_uri,
            "completion_mode": "callback_or_manual_paste",
        }

    async def complete_login(self, callback_code: str, state: str | None = None) -> GeminiOAuthTokens:
        code, parsed_state = self._parse_callback_code(callback_code)
        callback_state = state or parsed_state
        if callback_state is None:
            raw = self._load_state(LOGIN_STATE_KEY)
            if raw is None:
                raise ValueError("No pending Gemini login state found; start login again")
            callback_state = GeminiOAuthLoginState(**raw).state
        return await self.handle_callback(code, callback_state)

    async def handle_callback(self, code: str, state: str) -> GeminiOAuthTokens:
        client_id = _client_id()
        if not client_id:
            raise ValueError("GEMINI_OAUTH_CLIENT_ID is not configured")

        raw = self._load_state(LOGIN_STATE_KEY)
        if raw is None:
            raise ValueError("No pending Gemini login state found; start login again")
        login_state = GeminiOAuthLoginState(**raw)
        if login_state.state != state:
            raise ValueError("State mismatch")

        payload = {
            "grant_type": "authorization_code",
            "code": code,
            "redirect_uri": login_state.redirect_uri,
            "client_id": client_id,
            "code_verifier": login_state.code_verifier,
        }
        secret = _client_secret()
        if secret:
            payload["client_secret"] = secret

        token_data = self._post_form(TOKEN_URL, payload, timeout=TOKEN_EXCHANGE_TIMEOUT)
        tokens = await self._tokens_from_response(token_data, login_state.scopes)
        self._save_tokens(tokens)
        self._delete_state(LOGIN_STATE_KEY)
        self._ensure_refresh_task()
        logger.info("Gemini OAuth login complete email=%s", tokens.email)
        return tokens

    def _parse_callback_code(self, callback_code: str) -> tuple[str, str | None]:
        value = unquote(callback_code.strip())
        if not value:
            raise ValueError("Authorization code is required")

        if value.startswith("http://") or value.startswith("https://"):
            parsed = urlparse(value)
            query = parse_qs(parsed.query)
            code = query.get("code", [""])[0]
            state = query.get("state", [""])[0] or None
            if not code and parsed.fragment:
                fragment = parse_qs(parsed.fragment)
                code = fragment.get("code", [""])[0]
                state = state or fragment.get("state", [""])[0] or None
            if code:
                return code, state

        if "code=" in value:
            query_text = value.split("?", 1)[-1].lstrip("#")
            query = parse_qs(query_text)
            code = query.get("code", [""])[0]
            state = query.get("state", [""])[0] or None
            if code:
                return code, state

        if "#" in value:
            code, parsed_state = value.split("#", 1)
            return code.strip(), parsed_state.strip() or None

        return value, None

    async def _tokens_from_response(
        self,
        token_data: dict[str, Any],
        scopes: list[str] | None = None,
        previous: GeminiOAuthTokens | None = None,
    ) -> GeminiOAuthTokens:
        access_token = token_data.get("access_token") or (previous.access_token if previous else None)
        if not access_token:
            raise RuntimeError("Gemini OAuth response did not include an access token")
        refresh_token = token_data.get("refresh_token") or (previous.refresh_token if previous else None)
        expires_at = (
            _now_ms() + int(token_data.get("expires_in", 3600)) * 1000
            if token_data.get("expires_in")
            else (previous.expires_at if previous else _now_ms() + 3600 * 1000)
        )
        userinfo = await self._fetch_userinfo(str(access_token))
        token_scopes = str(token_data.get("scope") or "").split() or scopes or (previous.scopes if previous else [])
        return GeminiOAuthTokens(
            access_token=str(access_token),
            refresh_token=str(refresh_token) if refresh_token else None,
            id_token=token_data.get("id_token") or (previous.id_token if previous else None),
            token_type=str(token_data.get("token_type") or (previous.token_type if previous else "Bearer")),
            expires_at=expires_at,
            scopes=token_scopes,
            email=userinfo.get("email") or (previous.email if previous else None),
            name=userinfo.get("name") or (previous.name if previous else None),
            picture=userinfo.get("picture") or (previous.picture if previous else None),
        )

    async def refresh_token(self) -> GeminiOAuthTokens | None:
        async with self._refresh_lock:
            tokens = self._load_tokens()
            if tokens is None or tokens.refresh_token is None:
                return None
            client_id = _client_id()
            if not client_id:
                logger.error("Gemini OAuth refresh failed: GEMINI_OAUTH_CLIENT_ID is not configured")
                return None
            payload = {
                "grant_type": "refresh_token",
                "refresh_token": tokens.refresh_token,
                "client_id": client_id,
            }
            secret = _client_secret()
            if secret:
                payload["client_secret"] = secret
            try:
                data = self._post_form(TOKEN_URL, payload, timeout=TOKEN_EXCHANGE_TIMEOUT)
            except Exception as exc:
                logger.error("Gemini OAuth token refresh failed: %s", exc)
                return None
            updated = await self._tokens_from_response(data, previous=tokens)
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
        token = self.get_access_token()
        if not token:
            return None
        return {"Authorization": f"Bearer {token}"}

    def get_auth_status(self) -> dict[str, Any]:
        tokens = self._load_tokens()
        project = _configured_vertex_project()
        location = _configured_vertex_location()
        vertex_configured = bool(project and location)
        if tokens is None:
            pending = None
            raw = self._load_state(LOGIN_STATE_KEY)
            if raw:
                try:
                    state = GeminiOAuthLoginState(**raw)
                    pending = {
                        "redirect_uri": state.redirect_uri,
                        "scopes": state.scopes,
                        "created_at": state.created_at,
                    }
                except Exception:
                    pending = None
            return {
                "authenticated": False,
                "pending_login": pending,
                "vertex_configured": vertex_configured,
                "project": project,
                "location": location,
            }
        return {
            "authenticated": True,
            "email": tokens.email,
            "name": tokens.name,
            "expires_at": tokens.expires_at,
            "expired": _now_ms() >= tokens.expires_at,
            "scopes": tokens.scopes,
            "vertex_configured": vertex_configured,
            "project": project,
            "location": location,
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
                logger.warning("Gemini OAuth background token refresh failed; stopping loop")
                return


gemini_oauth_manager = GeminiOAuthManager()

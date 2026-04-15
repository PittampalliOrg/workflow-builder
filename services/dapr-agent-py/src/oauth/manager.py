"""OAuth manager for Claude subscription authentication."""

from __future__ import annotations

import asyncio
import json
import logging
import os
import time
import urllib.request
from urllib.parse import parse_qs, unquote, urlencode, urlparse

from .crypto import generate_code_challenge, generate_code_verifier
from .types import OAuthLoginState, OAuthTokens

logger = logging.getLogger(__name__)

CLIENT_ID = os.environ.get(
    "CLAUDE_CODE_OAUTH_CLIENT_ID",
    "9d1c250a-e61b-44d9-88ed-5944d1962f5e",
)
AUTHORIZE_URL = "https://claude.ai/oauth/authorize"
DEFAULT_REDIRECT_URI = "https://console.anthropic.com/oauth/code/callback"
TOKEN_URL = "https://console.anthropic.com/v1/oauth/token"
PROFILE_URL = "https://api.anthropic.com/api/oauth/profile"
SUCCESS_URL = "https://platform.claude.com/oauth/code/success?app=claude-code"

SCOPES = [
    "org:create_api_key",
    "user:profile",
    "user:inference",
]

TOKEN_REFRESH_BUFFER_MS = 5 * 60 * 1000
TOKEN_EXCHANGE_TIMEOUT = 15
PROFILE_FETCH_TIMEOUT = 10
OAUTH_BETA_HEADER = "oauth-2025-04-20"

STATE_KEY = "oauth:tokens"
LOGIN_STATE_KEY = "oauth:login_state"

_ORG_TYPE_MAP: dict[str, str] = {
    "claude_max": "max",
    "claude_pro": "pro",
    "claude_enterprise": "enterprise",
    "claude_team": "team",
}


class OAuthManager:
    """Manage OAuth login, token persistence, and refresh."""

    def __init__(self, state_store_name: str | None = None) -> None:
        self._store = state_store_name or os.environ.get(
            "AGENT_STATE_STORE",
            "dapr-agent-py-statestore",
        )
        self._refresh_task: asyncio.Task | None = None
        self._refresh_lock = asyncio.Lock()
        self._cached_tokens: OAuthTokens | None = None

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

    def _save_tokens(self, tokens: OAuthTokens) -> None:
        self._cached_tokens = tokens
        self._save_state(STATE_KEY, tokens.model_dump())

    def _load_tokens(self) -> OAuthTokens | None:
        if self._cached_tokens is not None:
            return self._cached_tokens
        data = self._load_state(STATE_KEY)
        if data is None:
            return None
        try:
            tokens = OAuthTokens(**data)
            self._cached_tokens = tokens
            return tokens
        except Exception:
            logger.warning("Failed to parse stored OAuth tokens")
            return None

    def start_login(self) -> dict:
        verifier = generate_code_verifier()
        challenge = generate_code_challenge(verifier)
        # Claude Code's public client returns CODE#STATE and expects STATE to be
        # the PKCE verifier during token exchange.
        state = verifier
        redirect_uri = os.environ.get("CLAUDE_CODE_OAUTH_REDIRECT_URI", DEFAULT_REDIRECT_URI)

        login_state = OAuthLoginState(
            code_verifier=verifier,
            code_challenge=challenge,
            state=state,
            redirect_uri=redirect_uri,
            created_at=int(time.time() * 1000),
        )
        self._save_state(LOGIN_STATE_KEY, login_state.model_dump())

        params = urlencode({
            "code": "true",
            "client_id": CLIENT_ID,
            "response_type": "code",
            "redirect_uri": redirect_uri,
            "scope": " ".join(SCOPES),
            "code_challenge": challenge,
            "code_challenge_method": "S256",
            "state": state,
        })
        return {
            "authorize_url": f"{AUTHORIZE_URL}?{params}",
            "state": state,
            "redirect_uri": redirect_uri,
            "completion_mode": "manual_paste",
        }

    async def complete_login(self, callback_code: str, state: str | None = None) -> OAuthTokens:
        code, parsed_state = self._parse_callback_code(callback_code)
        callback_state = state or parsed_state
        if callback_state is None:
            raw = self._load_state(LOGIN_STATE_KEY)
            if raw is None:
                raise ValueError("No pending login state found; start login again")
            callback_state = OAuthLoginState(**raw).state
        return await self.handle_callback(code, callback_state)

    async def handle_callback(self, code: str, state: str) -> OAuthTokens:
        raw = self._load_state(LOGIN_STATE_KEY)
        if raw is None:
            raise ValueError("No pending login state found; start login again")
        login_state = OAuthLoginState(**raw)
        if login_state.state != state:
            raise ValueError("State mismatch")

        token_data = await self._exchange_code(
            code=code,
            redirect_uri=login_state.redirect_uri,
            code_verifier=login_state.code_verifier,
            state=state,
        )
        profile = await self._fetch_profile(token_data["access_token"])
        expires_at = int(time.time() * 1000) + int(token_data["expires_in"]) * 1000
        tokens = OAuthTokens(
            access_token=token_data["access_token"],
            refresh_token=token_data.get("refresh_token"),
            expires_at=expires_at,
            scopes=str(token_data.get("scope", "")).split(),
            subscription_type=profile.get("subscription_type") if profile else None,
            rate_limit_tier=profile.get("rate_limit_tier") if profile else None,
            account_uuid=token_data.get("account", {}).get("uuid"),
            email=token_data.get("account", {}).get("email_address"),
            organization_uuid=token_data.get("organization", {}).get("uuid"),
        )
        self._save_tokens(tokens)
        self._delete_state(LOGIN_STATE_KEY)
        self._ensure_refresh_task()
        logger.info("OAuth login complete subscription=%s email=%s", tokens.subscription_type, tokens.email)
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

    async def refresh_token(self) -> OAuthTokens | None:
        async with self._refresh_lock:
            tokens = self._load_tokens()
            if tokens is None or tokens.refresh_token is None:
                return None
            body = json.dumps({
                "grant_type": "refresh_token",
                "refresh_token": tokens.refresh_token,
                "client_id": CLIENT_ID,
                "scope": " ".join(SCOPES),
            }).encode()
            req = urllib.request.Request(
                TOKEN_URL,
                data=body,
                headers={
                    "Content-Type": "application/json",
                    "anthropic-beta": OAUTH_BETA_HEADER,
                },
                method="POST",
            )
            try:
                with urllib.request.urlopen(req, timeout=TOKEN_EXCHANGE_TIMEOUT) as resp:
                    data = json.loads(resp.read())
            except Exception as exc:
                logger.error("OAuth token refresh failed: %s", exc)
                return None

            profile = await self._fetch_profile(data["access_token"])
            updated = OAuthTokens(
                access_token=data["access_token"],
                refresh_token=data.get("refresh_token") or tokens.refresh_token,
                expires_at=int(time.time() * 1000) + int(data["expires_in"]) * 1000,
                scopes=str(data.get("scope", "")).split(),
                subscription_type=profile.get("subscription_type") if profile else tokens.subscription_type,
                rate_limit_tier=profile.get("rate_limit_tier") if profile else tokens.rate_limit_tier,
                account_uuid=data.get("account", {}).get("uuid") or tokens.account_uuid,
                email=data.get("account", {}).get("email_address") or tokens.email,
                organization_uuid=data.get("organization", {}).get("uuid") or tokens.organization_uuid,
            )
            self._save_tokens(updated)
            return updated

    def get_access_token(self) -> str | None:
        tokens = self._load_tokens()
        if tokens is None:
            return None
        if int(time.time() * 1000) + TOKEN_REFRESH_BUFFER_MS >= tokens.expires_at:
            self._ensure_refresh_task()
        return tokens.access_token

    def is_authenticated(self) -> bool:
        return self._load_tokens() is not None

    def get_auth_status(self) -> dict:
        tokens = self._load_tokens()
        if tokens is None:
            return {"authenticated": False}
        now_ms = int(time.time() * 1000)
        return {
            "authenticated": True,
            "subscription_type": tokens.subscription_type,
            "email": tokens.email,
            "expires_at": tokens.expires_at,
            "expired": now_ms >= tokens.expires_at,
            "scopes": tokens.scopes,
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
            sleep_ms = tokens.expires_at - TOKEN_REFRESH_BUFFER_MS - int(time.time() * 1000)
            if sleep_ms > 0:
                await asyncio.sleep(sleep_ms / 1000)
            if await self.refresh_token() is None:
                logger.warning("Background token refresh failed; stopping loop")
                return

    async def _exchange_code(
        self,
        code: str,
        redirect_uri: str,
        code_verifier: str,
        state: str,
    ) -> dict:
        body = json.dumps({
            "grant_type": "authorization_code",
            "code": code,
            "redirect_uri": redirect_uri,
            "client_id": CLIENT_ID,
            "code_verifier": code_verifier,
            "state": state,
        }).encode()
        req = urllib.request.Request(
            TOKEN_URL,
            data=body,
            headers={
                "Content-Type": "application/json",
                "anthropic-beta": OAUTH_BETA_HEADER,
            },
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=TOKEN_EXCHANGE_TIMEOUT) as resp:
            if resp.status != 200:
                raise RuntimeError(f"Token exchange failed ({resp.status}): {resp.reason}")
            return json.loads(resp.read())

    async def _fetch_profile(self, access_token: str) -> dict | None:
        req = urllib.request.Request(
            PROFILE_URL,
            headers={
                "Authorization": f"Bearer {access_token}",
                "Content-Type": "application/json",
            },
            method="GET",
        )
        try:
            with urllib.request.urlopen(req, timeout=PROFILE_FETCH_TIMEOUT) as resp:
                data = json.loads(resp.read())
        except Exception as exc:
            logger.warning("OAuth profile fetch failed: %s", exc)
            return None
        org = data.get("organization") or {}
        return {
            "subscription_type": _ORG_TYPE_MAP.get(org.get("organization_type")),
            "rate_limit_tier": org.get("rate_limit_tier"),
        }


oauth_manager = OAuthManager()

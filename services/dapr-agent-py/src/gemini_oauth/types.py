"""Pydantic models for Google/Gemini OAuth state."""

from __future__ import annotations

from pydantic import BaseModel


class GeminiOAuthTokens(BaseModel):
    access_token: str
    refresh_token: str | None = None
    id_token: str | None = None
    token_type: str = "Bearer"
    expires_at: int
    scopes: list[str] = []
    email: str | None = None
    name: str | None = None
    picture: str | None = None


class GeminiOAuthLoginState(BaseModel):
    code_verifier: str
    code_challenge: str
    state: str
    redirect_uri: str
    scopes: list[str]
    created_at: int

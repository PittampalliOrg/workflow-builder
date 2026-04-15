"""Pydantic models for OAuth token state."""

from __future__ import annotations

from pydantic import BaseModel, Field


class OAuthTokens(BaseModel):
    access_token: str
    refresh_token: str | None = None
    expires_at: int
    scopes: list[str] = Field(default_factory=list)
    subscription_type: str | None = None
    rate_limit_tier: str | None = None
    account_uuid: str | None = None
    email: str | None = None
    organization_uuid: str | None = None


class OAuthLoginState(BaseModel):
    code_verifier: str
    code_challenge: str
    state: str
    redirect_uri: str
    created_at: int

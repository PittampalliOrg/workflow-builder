"""Pydantic models for OpenAI OAuth token state."""

from __future__ import annotations

from pydantic import BaseModel


class OpenAIOAuthTokens(BaseModel):
    id_token: str | None = None
    access_token: str
    refresh_token: str | None = None
    expires_at: int
    email: str | None = None
    chatgpt_plan_type: str | None = None
    chatgpt_user_id: str | None = None
    chatgpt_account_id: str | None = None


class OpenAIDeviceLoginState(BaseModel):
    device_auth_id: str
    user_code: str
    verification_url: str
    interval: int
    expires_at: int
    created_at: int

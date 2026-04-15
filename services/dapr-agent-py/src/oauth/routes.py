"""FastAPI routes for Claude OAuth login."""

from __future__ import annotations

import html
import logging
import os

from fastapi import APIRouter, Query, Request
from fastapi.responses import HTMLResponse, JSONResponse

from .manager import SUCCESS_URL, oauth_manager

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/oauth", tags=["oauth"])


@router.post("/login")
async def oauth_login(request: Request) -> JSONResponse:
    callback_base = os.environ.get("OAUTH_CALLBACK_BASE_URL")
    if not callback_base:
        callback_base = f"{request.url.scheme}://{request.url.netloc}"
    return JSONResponse(oauth_manager.start_login(callback_base))


@router.get("/callback")
async def oauth_callback(code: str = Query(...), state: str = Query(...)) -> HTMLResponse:
    try:
        tokens = await oauth_manager.handle_callback(code, state)
        subscription = html.escape(tokens.subscription_type or "unknown")
        email = html.escape(tokens.email or "unknown")
        return HTMLResponse(
            "<html><body>"
            "<h2>Login successful</h2>"
            f"<p>Subscription: {subscription}</p>"
            f"<p>Email: {email}</p>"
            f'<p><a href="{SUCCESS_URL}">Continue</a></p>'
            "<script>window.close()</script>"
            "</body></html>"
        )
    except Exception as exc:
        logger.error("OAuth callback failed: %s", exc)
        message = html.escape(str(exc))
        return HTMLResponse(
            f"<html><body><h2>Login failed</h2><p>{message}</p></body></html>",
            status_code=400,
        )


@router.get("/status")
async def oauth_status() -> JSONResponse:
    return JSONResponse(oauth_manager.get_auth_status())


@router.post("/logout")
async def oauth_logout() -> JSONResponse:
    await oauth_manager.logout()
    return JSONResponse({"status": "logged_out"})


@router.post("/refresh")
async def oauth_refresh() -> JSONResponse:
    tokens = await oauth_manager.refresh_token()
    if tokens is None:
        return JSONResponse({"refreshed": False}, status_code=400)
    return JSONResponse({"refreshed": True, "expires_at": tokens.expires_at})

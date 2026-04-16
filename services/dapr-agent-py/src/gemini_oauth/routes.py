"""FastAPI routes for Google/Gemini OAuth login."""

from __future__ import annotations

import logging
from html import escape

from fastapi import APIRouter, Query
from fastapi.responses import HTMLResponse, JSONResponse
from pydantic import BaseModel

from .manager import gemini_oauth_manager

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/gemini-oauth", tags=["gemini-oauth"])


class CompleteRequest(BaseModel):
    code: str
    state: str | None = None


@router.post("/login")
async def gemini_oauth_login() -> JSONResponse:
    try:
        return JSONResponse(gemini_oauth_manager.start_login())
    except Exception as exc:
        logger.error("Gemini OAuth login start failed: %s", exc)
        return JSONResponse({"message": str(exc)}, status_code=400)


@router.post("/complete")
async def gemini_oauth_complete(request: CompleteRequest) -> JSONResponse:
    try:
        tokens = await gemini_oauth_manager.complete_login(request.code, request.state)
        return JSONResponse(gemini_oauth_manager.get_auth_status())
    except Exception as exc:
        logger.error("Gemini OAuth complete failed: %s", exc)
        return JSONResponse({"message": str(exc)}, status_code=400)


@router.get("/callback")
async def gemini_oauth_callback(
    code: str | None = Query(None),
    state: str | None = Query(None),
    error: str | None = Query(None),
    error_description: str | None = Query(None),
) -> HTMLResponse:
    if error:
        detail = escape(error_description or error)
        return HTMLResponse(
            f"<h1>Gemini OAuth failed</h1><p>{detail}</p>",
            status_code=400,
        )
    if not code or not state:
        return HTMLResponse(
            "<h1>Gemini OAuth failed</h1><p>Missing code or state.</p>",
            status_code=400,
        )
    try:
        await gemini_oauth_manager.handle_callback(code, state)
    except Exception as exc:
        logger.error("Gemini OAuth callback failed: %s", exc)
        detail = escape(str(exc))
        return HTMLResponse(
            f"<h1>Gemini OAuth failed</h1><p>{detail}</p>",
            status_code=400,
        )
    return HTMLResponse(
        "<h1>Gemini OAuth connected</h1><p>You can close this window.</p>",
        status_code=200,
    )


@router.get("/status")
async def gemini_oauth_status() -> JSONResponse:
    return JSONResponse(gemini_oauth_manager.get_auth_status())


@router.post("/logout")
async def gemini_oauth_logout() -> JSONResponse:
    await gemini_oauth_manager.logout()
    return JSONResponse({"status": "logged_out"})


@router.post("/refresh")
async def gemini_oauth_refresh() -> JSONResponse:
    tokens = await gemini_oauth_manager.refresh_token()
    if tokens is None:
        return JSONResponse({"refreshed": False}, status_code=400)
    return JSONResponse({"refreshed": True, "expires_at": tokens.expires_at})

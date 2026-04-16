"""FastAPI routes for OpenAI OAuth login."""

from __future__ import annotations

import logging

from fastapi import APIRouter
from fastapi.responses import JSONResponse

from .manager import openai_oauth_manager

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/openai-oauth", tags=["openai-oauth"])


@router.post("/login")
async def openai_oauth_login() -> JSONResponse:
    try:
        return JSONResponse(openai_oauth_manager.start_login())
    except Exception as exc:
        logger.error("OpenAI OAuth login start failed: %s", exc)
        return JSONResponse({"message": str(exc)}, status_code=400)


@router.post("/poll")
async def openai_oauth_poll() -> JSONResponse:
    try:
        result = await openai_oauth_manager.poll_login()
        status = 202 if result.get("pending") else 200
        return JSONResponse(result, status_code=status)
    except Exception as exc:
        logger.error("OpenAI OAuth polling failed: %s", exc)
        return JSONResponse({"message": str(exc)}, status_code=400)


@router.post("/complete")
async def openai_oauth_complete() -> JSONResponse:
    return await openai_oauth_poll()


@router.get("/status")
async def openai_oauth_status() -> JSONResponse:
    return JSONResponse(openai_oauth_manager.get_auth_status())


@router.post("/logout")
async def openai_oauth_logout() -> JSONResponse:
    await openai_oauth_manager.logout()
    return JSONResponse({"status": "logged_out"})


@router.post("/refresh")
async def openai_oauth_refresh() -> JSONResponse:
    tokens = await openai_oauth_manager.refresh_token()
    if tokens is None:
        return JSONResponse({"refreshed": False}, status_code=400)
    return JSONResponse({"refreshed": True, "expires_at": tokens.expires_at})

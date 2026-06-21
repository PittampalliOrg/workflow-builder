"""In-pod reverse proxy for @playwright/mcp that records the AGENT's session.

Why this exists: @playwright/mcp gives each HTTP MCP *session* its own browser
context/page. cli-agent-py's video supervisor was a SEPARATE MCP session, so a
screencast it started recorded its own idle ``about:blank`` — never the agent's
navigated page (the blank-recording bug). This proxy sits between the agent
(claude/codex CLI) and the real @playwright/mcp server on :3100:

  * it forwards every request/response transparently (incl. SSE streams),
  * captures the agent's ``mcp-session-id`` from the upstream responses, and
  * injects ``browser_start_video`` on THAT session right after the agent's
    first ``browser_navigate``, so the recording follows the agent's real page.

``browser_video_sync`` later flushes with ``browser_stop_video`` on the same
session id (read via :func:`read_agent_session_id`).

Mounted as routes on the existing FastAPI app (no extra port/process). ALL
injection is best-effort — a proxy hiccup must never break the agent's browser.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
from pathlib import Path

import aiohttp
from fastapi import APIRouter, Request
from fastapi.responses import Response, StreamingResponse

logger = logging.getLogger(__name__)

UPSTREAM_URL = os.environ.get("PLAYWRIGHT_MCP_UPSTREAM_URL", "http://127.0.0.1:3100/mcp")
STATE_PATH = os.environ.get("PLAYWRIGHT_MCP_PROXY_STATE", "/sandbox/run/pw_mcp_session.json")
PROXY_PATH = os.environ.get("PLAYWRIGHT_MCP_PROXY_PATH", "/internal/pw-proxy/mcp")
VIDEO_SIZE = {"width": 1280, "height": 720}

# Headers that must not be copied verbatim across the proxy hop. content-type is
# handled separately via StreamingResponse(media_type=...) to avoid duplication.
_HOP_BY_HOP = {
    "connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
    "te", "trailers", "transfer-encoding", "upgrade",
    "content-length", "content-encoding", "host",
}

router = APIRouter()

_session_id: str | None = None
_video_started = False
_client: aiohttp.ClientSession | None = None
_lock = asyncio.Lock()


def _req_headers(headers) -> dict[str, str]:
    return {k: v for k, v in headers.items() if k.lower() not in _HOP_BY_HOP}


def _resp_headers(headers) -> dict[str, str]:
    skip = _HOP_BY_HOP | {"content-type"}
    return {k: v for k, v in headers.items() if k.lower() not in skip}


def _client_session() -> aiohttp.ClientSession:
    global _client
    if _client is None or _client.closed:
        # No total/read timeout: MCP streamable-HTTP responses (incl. the SSE
        # notification stream) can stay open for the life of the agent session.
        _client = aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=None))
    return _client


async def close_client() -> None:
    global _client
    if _client is not None and not _client.closed:
        try:
            await _client.close()
        except Exception:  # noqa: BLE001
            pass
    _client = None


def read_agent_session_id() -> str | None:
    """Read the captured agent MCP session id (used by browser_video_sync)."""
    try:
        data = json.loads(Path(STATE_PATH).read_text())
        sid = data.get("sessionId")
        return sid if isinstance(sid, str) and sid else None
    except Exception:  # noqa: BLE001
        return None


def _remember_session(sid: str) -> None:
    global _session_id
    if not sid or sid == _session_id:
        return
    _session_id = sid
    try:
        p = Path(STATE_PATH)
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(json.dumps({"sessionId": sid}))
    except Exception as exc:  # noqa: BLE001
        logger.debug("[pw-proxy] could not persist session id: %s", exc)


def _is_navigate(body: bytes) -> bool:
    if not body:
        return False
    try:
        msg = json.loads(body)
    except Exception:  # noqa: BLE001
        return False
    items = msg if isinstance(msg, list) else [msg]
    for it in items:
        if isinstance(it, dict) and it.get("method") == "tools/call":
            params = it.get("params") or {}
            if isinstance(params, dict) and params.get("name") == "browser_navigate":
                return True
    return False


async def _inject_start_video() -> None:
    """Start the screencast on the AGENT's session, exactly once (best-effort)."""
    global _video_started
    async with _lock:
        if _video_started or not _session_id:
            return
        _video_started = True
        sid = _session_id

    # playwright_mcp_client is sync urllib; run off the event loop.
    from src.playwright_mcp_client import browser_start_video

    try:
        # Let the agent's navigate settle so the page exists before recording.
        await asyncio.sleep(0.5)
        ok = await asyncio.get_event_loop().run_in_executor(
            None, lambda: browser_start_video(VIDEO_SIZE, session_id=sid)
        )
        logger.info("[pw-proxy] browser_start_video on agent session %s -> %s", sid, ok)
        if not ok:
            async with _lock:
                _video_started = False  # allow a later navigate to retry
    except Exception as exc:  # noqa: BLE001
        logger.warning("[pw-proxy] browser_start_video failed: %s", exc)
        async with _lock:
            _video_started = False


async def _proxy(request: Request, method: str) -> Response:
    body = await request.body()
    want_start = method == "POST" and not _video_started and _is_navigate(body)

    client = _client_session()
    try:
        resp = await client.request(
            method,
            UPSTREAM_URL,
            data=body if body else None,
            headers=_req_headers(request.headers),
            params=dict(request.query_params),
        )
    except Exception as exc:  # noqa: BLE001
        logger.warning("[pw-proxy] upstream %s failed: %s", method, exc)
        return Response(
            status_code=502,
            content=b'{"error":"pw-proxy upstream error"}',
            media_type="application/json",
        )

    sid = resp.headers.get("mcp-session-id")
    if sid:
        _remember_session(sid)

    async def _gen():
        try:
            async for chunk in resp.content.iter_any():
                yield chunk
        finally:
            resp.release()
            # Navigate is done once its response has fully streamed → the page
            # exists → start recording on the agent's session.
            if want_start and _session_id:
                asyncio.create_task(_inject_start_video())

    return StreamingResponse(
        _gen(),
        status_code=resp.status,
        headers=_resp_headers(resp.headers),
        media_type=resp.headers.get("content-type"),
    )


@router.post(PROXY_PATH)
async def pw_proxy_post(request: Request):
    return await _proxy(request, "POST")


@router.get(PROXY_PATH)
async def pw_proxy_get(request: Request):
    return await _proxy(request, "GET")


@router.delete(PROXY_PATH)
async def pw_proxy_delete(request: Request):
    return await _proxy(request, "DELETE")


def build_pw_proxy_router() -> APIRouter:
    return router

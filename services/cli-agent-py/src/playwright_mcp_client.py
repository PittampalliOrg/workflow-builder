"""Minimal streamable-HTTP MCP client for the in-pod @playwright/mcp server.

The Playwright-MCP critic connects to a SUPERVISOR-managed @playwright/mcp HTTP
server (see session_supervisor.py `_run_pw_mcp_loop`, launched with
`--caps=devtools`). cli-agent-py acts as a SECOND MCP client on that same server
to drive the video lifecycle the agent won't: `browser_start_video` at session
start and `browser_stop_video` at finalize. `browser_stop_video` finalizes the
.webm (page.screencast.stop) WITHOUT needing `browser_close` and returns the
saved path — unlike the deleted-on-close `contextOptions.recordVideo` path.

Synchronous urllib (mirrors browser_video_sync.py); safe to call from a workflow
activity loop. Best-effort by contract — every call swallows errors and returns a
falsey result rather than breaking the session.
"""

from __future__ import annotations

import json
import os
import re
import urllib.error
import urllib.request
from typing import Any

MCP_URL = os.environ.get("PLAYWRIGHT_MCP_HTTP_URL", "http://127.0.0.1:3100/mcp")
_TIMEOUT = float(os.environ.get("PLAYWRIGHT_MCP_HTTP_TIMEOUT_SECONDS", "30"))
_PROTOCOL_VERSION = "2025-03-26"


def _post(body: dict[str, Any], session_id: str | None) -> tuple[int, str, str | None]:
    headers = {
        "Content-Type": "application/json",
        "Accept": "application/json, text/event-stream",
    }
    if session_id:
        headers["Mcp-Session-Id"] = session_id
    req = urllib.request.Request(
        MCP_URL, data=json.dumps(body).encode("utf-8"), method="POST", headers=headers
    )
    try:
        with urllib.request.urlopen(req, timeout=_TIMEOUT) as resp:
            return (
                int(getattr(resp, "status", 200) or 200),
                resp.read().decode("utf-8", errors="replace"),
                resp.headers.get("mcp-session-id"),
            )
    except urllib.error.HTTPError as exc:
        return exc.code, exc.read().decode("utf-8", errors="replace"), None
    except Exception as exc:  # noqa: BLE001
        return 0, str(exc), None


def _parse(text: str) -> dict[str, Any] | None:
    """Parse a JSON or SSE (`data: {...}`) MCP response body."""
    text = text.strip()
    if not text:
        return None
    if text.startswith("{"):
        try:
            return json.loads(text)
        except Exception:  # noqa: BLE001
            return None
    for line in text.splitlines():
        if line.startswith("data:"):
            try:
                return json.loads(line[5:].strip())
            except Exception:  # noqa: BLE001
                return None
    return None


def _initialize() -> str | None:
    status, text, sid = _post(
        {
            "jsonrpc": "2.0",
            "id": 1,
            "method": "initialize",
            "params": {
                "protocolVersion": _PROTOCOL_VERSION,
                "capabilities": {},
                "clientInfo": {"name": "cli-agent-py-video-supervisor", "version": "1"},
            },
        },
        None,
    )
    if status != 200 or not sid:
        return None
    # Fire-and-forget the initialized notification on the same session.
    _post({"jsonrpc": "2.0", "method": "notifications/initialized"}, sid)
    return sid


def _call_tool(name: str, arguments: dict[str, Any]) -> dict[str, Any] | None:
    sid = _initialize()
    if not sid:
        return None
    status, text, _ = _post(
        {
            "jsonrpc": "2.0",
            "id": 2,
            "method": "tools/call",
            "params": {"name": name, "arguments": arguments},
        },
        sid,
    )
    if status != 200:
        return None
    return _parse(text)


def _result_text(envelope: dict[str, Any] | None) -> str:
    if not envelope:
        return ""
    result = envelope.get("result") if isinstance(envelope, dict) else None
    parts = (result or {}).get("content") if isinstance(result, dict) else None
    if not isinstance(parts, list):
        return ""
    return "\n".join(
        str(p.get("text"))
        for p in parts
        if isinstance(p, dict) and p.get("type") == "text" and p.get("text")
    )


def browser_start_video(size: dict[str, int] | None = None) -> bool:
    """Start screencast recording (requires --caps=devtools). Best-effort."""
    args: dict[str, Any] = {}
    if size:
        args["size"] = size
    env = _call_tool("browser_start_video", args)
    return env is not None and "error" not in (env or {})


_WEBM_RE = re.compile(r"(/\S+\.webm)")


def browser_stop_video() -> str | None:
    """Stop+flush the screencast and return the saved .webm path, or None."""
    env = _call_tool("browser_stop_video", {})
    text = _result_text(env)
    m = _WEBM_RE.search(text)
    return m.group(1) if m else None

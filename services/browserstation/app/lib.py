from __future__ import annotations

import os

import httpx


# Default for Chrome /json/version healthcheck via the chrome-sandbox nginx
# proxy on :9223. Was hardcoded 2.0s; configurable now because heavy pages
# or pod startup latency can briefly push past 2s and produce spurious
# "Chrome not ready" errors. Override with BROWSERSTATION_CHROME_HEALTHCHECK_
# TIMEOUT_SECONDS at the env level (read once at module import; restart pod
# to change).
_DEFAULT_CHROME_HEALTHCHECK_TIMEOUT = float(
    os.environ.get("BROWSERSTATION_CHROME_HEALTHCHECK_TIMEOUT_SECONDS", "5.0")
)


async def fetch_ws(ip: str, timeout: float | None = None):
    """Fetch the browser-level WebSocket URL from the sidecar proxy."""
    effective_timeout = (
        timeout if timeout is not None else _DEFAULT_CHROME_HEALTHCHECK_TIMEOUT
    )
    try:
        async with httpx.AsyncClient() as client:
            response = await client.get(
                f"http://{ip}:9223/json/version", timeout=effective_timeout
            )
        if response.status_code != 200:
            return None
        return response.json().get("webSocketDebuggerUrl", "")
    except Exception:
        return None

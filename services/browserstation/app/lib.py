import httpx


async def fetch_ws(ip: str, timeout: float = 2.0):
    """Fetch the browser-level WebSocket URL from the sidecar proxy."""
    try:
        async with httpx.AsyncClient() as client:
            response = await client.get(
                f"http://{ip}:9223/json/version", timeout=timeout
            )
        if response.status_code != 200:
            return None
        return response.json().get("webSocketDebuggerUrl", "")
    except Exception:
        return None

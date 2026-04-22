import asyncio
import logging
import uuid
from urllib.parse import urlsplit

from fastapi import HTTPException, WebSocket, WebSocketDisconnect
import httpx
import ray
from ray.util.state import list_actors
import websockets

from app.lib import fetch_ws
from app.models import ActorInfo, BrowserInfo, BrowserList, BrowserStatus, Health

logger = logging.getLogger(__name__)


@ray.remote(num_cpus=1)
class BrowserActor:
    """Actor that tracks one dedicated browser worker pod."""

    def __init__(self, browser_id: str):
        self.browser_id = browser_id
        self.pod_ip = ray.util.get_node_ip_address()

    async def get_info(self):
        ws_url = await fetch_ws(self.pod_ip)
        devtools_path = urlsplit(ws_url).path.lstrip("/") if ws_url else None
        return BrowserInfo(
            browser_id=self.browser_id,
            pod_ip=self.pod_ip,
            websocket_url=(
                f"/ws/browsers/{self.browser_id}/{devtools_path}"
                if devtools_path
                else None
            ),
            chrome_ready=bool(devtools_path),
        )


class BrowserService:
    async def health(self):
        try:
            ray_status = ray.is_initialized()
            alive_actors = list_actors(
                filters=[("class_name", "=", "BrowserActor"), ("state", "=", "ALIVE")]
            )
            pending_actors = list_actors(
                filters=[
                    ("class_name", "=", "BrowserActor"),
                    ("state", "=", "PENDING_CREATION"),
                ]
            )
            dead_actors = list_actors(
                filters=[("class_name", "=", "BrowserActor"), ("state", "=", "DEAD")]
            )

            browser_states = {
                "alive": len(alive_actors),
                "pending": len(pending_actors),
                "dead": len(dead_actors),
            }

            try:
                cluster = ray.cluster_resources()
                available = ray.available_resources()
            except Exception:
                cluster = {}
                available = {}

            return Health(
                status="healthy",
                ray_status=ray_status,
                browsers=browser_states,
                cluster=cluster,
                available=available,
            )
        except Exception as exc:
            raise HTTPException(status_code=503, detail=f"Unhealthy: {exc}") from exc

    async def create_browser(self):
        browser_id = str(uuid.uuid4())
        actor = BrowserActor.options(name=browser_id, lifetime="detached").remote(
            browser_id
        )
        await actor.get_info.remote()
        return ActorInfo(
            browser_id=browser_id,
            proxy_url=f"/ws/browsers/{browser_id}/devtools/browser",
        )

    async def list_browsers(self):
        alive_actors = list_actors(
            filters=[("class_name", "=", "BrowserActor"), ("state", "=", "ALIVE")]
        )
        pending_actors = list_actors(
            filters=[
                ("class_name", "=", "BrowserActor"),
                ("state", "=", "PENDING_CREATION"),
            ]
        )

        async def get_browser_info(actor):
            actor_handle = ray.get_actor(actor.name)
            info = await actor_handle.get_info.remote()
            return {
                "browser_id": actor.name,
                "state": "ALIVE",
                "websocket_url": info.websocket_url,
            }

        alive_browsers = [await get_browser_info(actor) for actor in alive_actors]
        pending_browsers = [
            {"browser_id": actor.name, "state": "PENDING", "websocket_url": None}
            for actor in pending_actors
        ]
        return BrowserList(browsers=alive_browsers + pending_browsers)

    async def get_browser(self, browser_id: str):
        try:
            actor = ray.get_actor(browser_id)
            return await actor.get_info.remote()
        except ValueError as exc:
            raise HTTPException(status_code=404, detail="Browser not found") from exc

    async def delete_browser(self, browser_id: str):
        try:
            actor = ray.get_actor(browser_id)
            ray.kill(actor)
            return BrowserStatus(browser_id=browser_id, status="closed")
        except ValueError as exc:
            raise HTTPException(status_code=404, detail="Browser not found") from exc
        except Exception as exc:
            raise HTTPException(
                status_code=500, detail=f"Failed to kill actor {exc}"
            ) from exc

    async def websocket_proxy(self, websocket: WebSocket, browser_id: str, path: str):
        await websocket.accept()

        try:
            actor = ray.get_actor(browser_id)
        except ValueError:
            await websocket.close(code=1008, reason="Browser not found")
            return

        info = await actor.get_info.remote()
        if not info.chrome_ready:
            await websocket.close(code=1011, reason="Chrome not ready")
            return

        try:
            async with httpx.AsyncClient() as client:
                response = await client.get(
                    f"http://{info.pod_ip}:9223/json/version", timeout=2
                )
                response.raise_for_status()
        except Exception as exc:
            await websocket.close(code=1011, reason=f"Chrome unreachable: {exc}")
            return

        chrome_ws_url = f"ws://{info.pod_ip}:9223/{path}"

        async with websockets.connect(chrome_ws_url, timeout=5) as chrome_ws:

            async def client_to_chrome():
                try:
                    while True:
                        msg = await websocket.receive_text()
                        await chrome_ws.send(msg)
                except WebSocketDisconnect:
                    pass

            async def chrome_to_client():
                try:
                    async for msg in chrome_ws:
                        await websocket.send_text(msg)
                except websockets.exceptions.ConnectionClosed:
                    pass

            await asyncio.gather(client_to_chrome(), chrome_to_client())

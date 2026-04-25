import asyncio
import logging
import os
import time
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


# Tunable timeouts. Defaults raised from the originals (2s, 5s) to absorb
# transient WS proxy and Chrome-startup latency observed under concurrent
# browser-use workloads. Override via env at the dapr-agent-py / browser-
# station Deployment level.
_CHROME_HEALTHCHECK_TIMEOUT = float(
    os.environ.get("BROWSERSTATION_CHROME_HEALTHCHECK_TIMEOUT_SECONDS", "5.0")
)
_WS_CONNECT_TIMEOUT = float(
    os.environ.get("BROWSERSTATION_WS_CONNECT_TIMEOUT_SECONDS", "10.0")
)
# TTL after which an alive BrowserActor gets force-killed by the reaper to
# clean up zombie browsers from orphaned executions. 0 disables.
_ACTOR_TTL_SECONDS = int(os.environ.get("BROWSERSTATION_ACTOR_TTL_SECONDS", "1800"))
# How often the reaper wakes up to check for over-TTL actors.
_ACTOR_REAPER_INTERVAL_SECONDS = int(
    os.environ.get("BROWSERSTATION_ACTOR_REAPER_INTERVAL_SECONDS", "60")
)


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
    # Track when each named actor was created so the reaper can kill it
    # after _ACTOR_TTL_SECONDS even if no client explicitly deletes it.
    # In-memory only; on restart the reaper falls back to letting Ray's
    # natural lifecycle reap idle actors at next reschedule.
    _actor_creation_times: dict[str, float] = {}

    def _find_actor(self, browser_id: str):
        actors = list_actors(filters=[("class_name", "=", "BrowserActor")])
        for actor in actors:
            if actor.name == browser_id:
                return actor
        return None

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
        BrowserActor.options(name=browser_id, lifetime="detached").remote(browser_id)
        self._actor_creation_times[browser_id] = time.monotonic()
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
        actor_record = self._find_actor(browser_id)
        if actor_record is None:
            raise HTTPException(status_code=404, detail="Browser not found")

        if actor_record.state == "PENDING_CREATION":
            return BrowserInfo(
                browser_id=browser_id,
                pod_ip="",
                websocket_url=None,
                chrome_ready=False,
            )

        if actor_record.state != "ALIVE":
            raise HTTPException(status_code=404, detail="Browser not found")

        try:
            actor = ray.get_actor(browser_id)
            return await actor.get_info.remote()
        except ValueError as exc:
            raise HTTPException(status_code=404, detail="Browser not found") from exc

    async def delete_browser(self, browser_id: str):
        try:
            actor = ray.get_actor(browser_id)
            ray.kill(actor)
            self._actor_creation_times.pop(browser_id, None)
            return BrowserStatus(browser_id=browser_id, status="closed")
        except ValueError as exc:
            raise HTTPException(status_code=404, detail="Browser not found") from exc
        except Exception as exc:
            raise HTTPException(
                status_code=500, detail=f"Failed to kill actor {exc}"
            ) from exc

    async def reap_stale_actors(self):
        """Periodic background task: kill BrowserActors older than
        BROWSERSTATION_ACTOR_TTL_SECONDS so orphan browsers from crashed
        executions don't accumulate. Started by the FastAPI lifespan
        on app startup; runs forever until shutdown.

        Cleanup of DEAD-state actors (cosmetic noise in /health) is
        handled implicitly: ray.kill on an already-DEAD actor is a no-op
        and safe to retry. We focus on ALIVE actors that have outlived
        their TTL since this is what causes resource leaks.
        """
        if _ACTOR_TTL_SECONDS <= 0:
            logger.info("Actor reaper disabled (BROWSERSTATION_ACTOR_TTL_SECONDS=0)")
            return

        logger.info(
            "Actor reaper started (ttl=%ds, interval=%ds)",
            _ACTOR_TTL_SECONDS,
            _ACTOR_REAPER_INTERVAL_SECONDS,
        )
        while True:
            try:
                now = time.monotonic()
                stale_ids = [
                    bid
                    for bid, created in list(self._actor_creation_times.items())
                    if (now - created) >= _ACTOR_TTL_SECONDS
                ]
                for bid in stale_ids:
                    age = now - self._actor_creation_times[bid]
                    try:
                        actor = ray.get_actor(bid)
                        ray.kill(actor)
                        logger.info(
                            "Reaper killed stale actor %s (age=%ds, ttl=%ds)",
                            bid,
                            age,
                            _ACTOR_TTL_SECONDS,
                        )
                    except ValueError:
                        # Actor already gone; just drop the bookkeeping entry.
                        logger.debug("Reaper: actor %s already gone", bid)
                    finally:
                        self._actor_creation_times.pop(bid, None)
            except Exception as exc:
                logger.warning("Actor reaper iteration failed: %s", exc)
            await asyncio.sleep(_ACTOR_REAPER_INTERVAL_SECONDS)

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
                    f"http://{info.pod_ip}:9223/json/version",
                    timeout=_CHROME_HEALTHCHECK_TIMEOUT,
                )
                response.raise_for_status()
        except Exception as exc:
            await websocket.close(code=1011, reason=f"Chrome unreachable: {exc}")
            return

        chrome_ws_url = f"ws://{info.pod_ip}:9223/{path}"

        async with websockets.connect(
            chrome_ws_url, timeout=_WS_CONNECT_TIMEOUT
        ) as chrome_ws:

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

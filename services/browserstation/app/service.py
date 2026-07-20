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

from app.actor_reaper import (
    ActorIdentity,
    merge_reconciled_actor_times,
    reconcile_actor_start_times,
    stale_actor_ages,
)
from app.lib import fetch_ws
from app.models import ActorInfo, BrowserInfo, BrowserList, BrowserStatus, Health
from app.websocket_transport import (
    UPSTREAM_TO_CLIENT,
    relay_websocket_messages,
    websocket_limits,
)

logger = logging.getLogger(__name__)

RAY_NAMESPACE = "browserstation"
QUEUED_ACTOR_STATES = ("PENDING_CREATION", "DEPENDENCIES_UNREADY", "RESTARTING")
REAPABLE_ACTOR_STATES = ("ALIVE", *QUEUED_ACTOR_STATES)


def _query_browser_actors(
    states: tuple[str, ...], *, all_namespaces: bool = False, detail: bool = False
):
    records = []
    for state in states:
        filters = [("class_name", "=", "BrowserActor"), ("state", "=", state)]
        if not all_namespaces:
            filters.append(("ray_namespace", "=", RAY_NAMESPACE))
        records.extend(list_actors(filters=filters, limit=10_000, detail=detail))
    return records


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
_WS_MAX_MESSAGE_BYTES, _WS_MAX_QUEUE = websocket_limits()
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
    # Monotonic start estimates are reconciled against Ray's live actor list on
    # every reaper pass. Deployed Ray 2.47 uses a stable first-seen fallback;
    # newer schemas can preserve exact age when start_time_ms is available.
    _actor_creation_times: dict[ActorIdentity, float] = {}

    async def _find_actor(self, browser_id: str):
        actors = await asyncio.to_thread(_query_browser_actors, REAPABLE_ACTOR_STATES)
        for actor in actors:
            if actor.name == browser_id:
                return actor
        return None

    async def health(self):
        try:
            ray_status = ray.is_initialized()
            actors = await asyncio.to_thread(
                _query_browser_actors, (*REAPABLE_ACTOR_STATES, "DEAD")
            )

            browser_states = {
                "alive": sum(actor.state == "ALIVE" for actor in actors),
                "pending": sum(actor.state in QUEUED_ACTOR_STATES for actor in actors),
                "dead": sum(actor.state == "DEAD" for actor in actors),
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
        await asyncio.to_thread(
            lambda: BrowserActor.options(
                name=browser_id,
                namespace=RAY_NAMESPACE,
                lifetime="detached",
            ).remote(browser_id)
        )
        self._actor_creation_times[(RAY_NAMESPACE, browser_id)] = time.monotonic()
        return ActorInfo(
            browser_id=browser_id,
            proxy_url=f"/ws/browsers/{browser_id}/devtools/browser",
        )

    async def list_browsers(self):
        actors = await asyncio.to_thread(_query_browser_actors, REAPABLE_ACTOR_STATES)
        alive_actors = [actor for actor in actors if actor.state == "ALIVE"]
        pending_actors = [
            actor for actor in actors if actor.state in QUEUED_ACTOR_STATES
        ]

        async def get_browser_info(actor):
            actor_handle = await asyncio.to_thread(
                ray.get_actor, actor.name, namespace=RAY_NAMESPACE
            )
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
        actor_record = await self._find_actor(browser_id)
        if actor_record is None:
            raise HTTPException(status_code=404, detail="Browser not found")

        if actor_record.state in QUEUED_ACTOR_STATES:
            return BrowserInfo(
                browser_id=browser_id,
                pod_ip="",
                websocket_url=None,
                chrome_ready=False,
            )

        if actor_record.state != "ALIVE":
            raise HTTPException(status_code=404, detail="Browser not found")

        try:
            actor = await asyncio.to_thread(
                ray.get_actor, browser_id, namespace=RAY_NAMESPACE
            )
            return await actor.get_info.remote()
        except ValueError as exc:
            raise HTTPException(status_code=404, detail="Browser not found") from exc

    async def delete_browser(self, browser_id: str):
        try:
            actor = await asyncio.to_thread(
                ray.get_actor, browser_id, namespace=RAY_NAMESPACE
            )
            await asyncio.to_thread(ray.kill, actor)
            self._actor_creation_times.pop((RAY_NAMESPACE, browser_id), None)
            return BrowserStatus(browser_id=browser_id, status="closed")
        except ValueError as exc:
            raise HTTPException(status_code=404, detail="Browser not found") from exc
        except Exception as exc:
            raise HTTPException(
                status_code=500, detail=f"Failed to kill actor {exc}"
            ) from exc

    async def reap_stale_actors_once(self):
        now_monotonic = time.monotonic()
        scan_start = dict(self._actor_creation_times)
        actors = await asyncio.to_thread(
            _query_browser_actors,
            REAPABLE_ACTOR_STATES,
            all_namespaces=True,
            detail=True,
        )
        reconciled = reconcile_actor_start_times(
            actors,
            scan_start,
            now_monotonic=now_monotonic,
            now_epoch_ms=time.time() * 1000,
        )
        merge_reconciled_actor_times(self._actor_creation_times, scan_start, reconciled)

        stale_actors = stale_actor_ages(
            reconciled,
            now_monotonic=now_monotonic,
            ttl_seconds=_ACTOR_TTL_SECONDS,
        )
        for (namespace, bid), age in stale_actors.items():
            try:
                actor = await asyncio.to_thread(ray.get_actor, bid, namespace=namespace)
                await asyncio.to_thread(ray.kill, actor)
                logger.info(
                    "Reaper killed stale actor %s (age=%ds, ttl=%ds)",
                    bid,
                    age,
                    _ACTOR_TTL_SECONDS,
                )
            except ValueError:
                logger.debug("Reaper: actor %s already gone", bid)
                self._actor_creation_times.pop((namespace, bid), None)
            except Exception as exc:
                # Retain the original age so a transient Ray failure is
                # retried on the next pass, not after another full TTL.
                logger.warning("Reaper failed to kill actor %s: %s", bid, exc)
            else:
                self._actor_creation_times.pop((namespace, bid), None)

    async def reap_stale_actors(self):
        """Periodic background task: kill BrowserActors older than
        BROWSERSTATION_ACTOR_TTL_SECONDS so orphan browsers from crashed
        executions don't accumulate. Started by the FastAPI lifespan
        on app startup; runs forever until shutdown.

        Cleanup is limited to active and queued BrowserActors; DEAD-state
        records are diagnostic history and do not consume worker capacity.
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
                await self.reap_stale_actors_once()
            except Exception as exc:
                logger.warning("Actor reaper iteration failed: %s", exc)
            await asyncio.sleep(_ACTOR_REAPER_INTERVAL_SECONDS)

    async def websocket_proxy(self, websocket: WebSocket, browser_id: str, path: str):
        await websocket.accept()

        try:
            actor = await asyncio.to_thread(
                ray.get_actor, browser_id, namespace=RAY_NAMESPACE
            )
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

        async def close_client() -> None:
            try:
                await websocket.close(code=1011, reason="Chrome connection closed")
            except (OSError, RuntimeError, WebSocketDisconnect):
                # The downstream may already have closed while the upstream
                # disconnect was propagating.
                pass

        try:
            async with websockets.connect(
                chrome_ws_url,
                open_timeout=_WS_CONNECT_TIMEOUT,
                max_size=_WS_MAX_MESSAGE_BYTES,
                max_queue=_WS_MAX_QUEUE,
            ) as chrome_ws:
                try:
                    completed = await relay_websocket_messages(
                        receive_client=websocket.receive_text,
                        send_upstream=chrome_ws.send,
                        upstream_messages=chrome_ws,
                        send_client=websocket.send_text,
                    )
                except WebSocketDisconnect:
                    return
                except websockets.exceptions.ConnectionClosed:
                    await close_client()
                    return

                if UPSTREAM_TO_CLIENT in completed:
                    await close_client()
        except Exception as exc:
            logger.warning("Chrome websocket proxy failed for %s: %s", browser_id, exc)
            await close_client()

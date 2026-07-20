import asyncio
from contextlib import asynccontextmanager
import logging

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
import ray

from .routes import router, service as browser_service
from .service import RAY_NAMESPACE

logger = logging.getLogger(__name__)


@asynccontextmanager
async def lifespan(app: FastAPI):
    logger.info("Initializing Ray connection...")
    if not ray.is_initialized():
        ray.init(address="auto", namespace=RAY_NAMESPACE)
    logger.info("Ray initialized successfully")

    # Background reaper for stale BrowserActors. Configurable via
    # BROWSERSTATION_ACTOR_TTL_SECONDS / BROWSERSTATION_ACTOR_REAPER_
    # INTERVAL_SECONDS env vars (see service.py).
    reaper_task = asyncio.create_task(browser_service.reap_stale_actors())
    try:
        yield
    finally:
        reaper_task.cancel()
        try:
            await reaper_task
        except asyncio.CancelledError:
            pass


app = FastAPI(
    title="BrowserStation",
    description="In-cluster browser pool control plane",
    version="2.0",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(router)

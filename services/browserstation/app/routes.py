import os

from fastapi import APIRouter, Depends, HTTPException, WebSocket
from fastapi.security import APIKeyHeader

from app.models import ActorInfo, BrowserInfo, BrowserList, BrowserStatus, Health

from .service import BrowserService

router = APIRouter()
service = BrowserService()

API_KEY = os.getenv("BROWSERSTATION_API_KEY")
api_key_header = APIKeyHeader(name="X-API-Key", auto_error=False)


async def verify_api_key(api_key: str = Depends(api_key_header)):
    if API_KEY and api_key != API_KEY:
        raise HTTPException(status_code=401, detail="Invalid API key")
    return api_key


@router.get("/", response_model=Health)
async def health():
    return await service.health()


@router.post(
    "/browsers", dependencies=[Depends(verify_api_key)], response_model=ActorInfo
)
async def create_browser():
    return await service.create_browser()


@router.get(
    "/browsers", dependencies=[Depends(verify_api_key)], response_model=BrowserList
)
async def list_browsers():
    return await service.list_browsers()


@router.get(
    "/browsers/{browser_id}",
    dependencies=[Depends(verify_api_key)],
    response_model=BrowserInfo,
)
async def get_browser(browser_id: str):
    return await service.get_browser(browser_id)


@router.delete(
    "/browsers/{browser_id}",
    dependencies=[Depends(verify_api_key)],
    response_model=BrowserStatus,
)
async def close_browser(browser_id: str):
    return await service.delete_browser(browser_id)


@router.websocket("/ws/browsers/{browser_id}/{path:path}")
async def websocket_proxy(websocket: WebSocket, browser_id: str, path: str):
    await service.websocket_proxy(websocket, browser_id, path)

import os
import secrets

from fastapi import APIRouter, Depends, HTTPException, Response, WebSocket
from fastapi.security import APIKeyHeader
from fastapi.responses import JSONResponse

from app.models import (
    ActorInfo,
    BrowserInfo,
    BrowserList,
    BrowserStatus,
    Health,
    LeaseAdmissionLease,
    LeaseAdmissionRelease,
    LeaseAdmissionRequest,
)

from .service import (
    BrowserService,
    LeaseAdmissionConflictError,
    LeaseAdmissionDrainingError,
)

router = APIRouter()
service = BrowserService()

API_KEY = os.getenv("BROWSERSTATION_API_KEY")
ROLLOUT_API_KEY = os.getenv("BROWSERSTATION_ROLLOUT_API_KEY") or API_KEY
api_key_header = APIKeyHeader(name="X-API-Key", auto_error=False)


def _api_keys_match(provided: str, expected: str) -> bool:
    try:
        return secrets.compare_digest(
            provided.encode("utf-8"), expected.encode("utf-8")
        )
    except UnicodeEncodeError:
        return False


async def verify_api_key(api_key: str = Depends(api_key_header)):
    if API_KEY and (not api_key or not _api_keys_match(api_key, API_KEY)):
        raise HTTPException(status_code=401, detail="Invalid API key")
    return api_key


async def verify_rollout_api_key(api_key: str = Depends(api_key_header)):
    if (
        not ROLLOUT_API_KEY
        or not api_key
        or not _api_keys_match(api_key, ROLLOUT_API_KEY)
    ):
        raise HTTPException(status_code=401, detail="Invalid API key")
    return api_key


@router.get("/", response_model=Health)
async def health():
    return await service.health()


@router.put(
    "/internal/rollout/lease-admission",
    dependencies=[Depends(verify_rollout_api_key)],
    response_model=LeaseAdmissionLease,
)
async def begin_lease_admission(request: LeaseAdmissionRequest):
    try:
        return await service.begin_lease_admission(
            request.contract_sha256,
            str(request.holder_uid),
            request.ttl_seconds,
            request.lease_token,
        )
    except LeaseAdmissionConflictError as exc:
        return JSONResponse(
            status_code=409,
            content={"code": "lease_admission_conflict", "detail": str(exc)},
        )


@router.delete(
    "/internal/rollout/lease-admission",
    dependencies=[Depends(verify_rollout_api_key)],
    status_code=204,
)
async def end_lease_admission(request: LeaseAdmissionRelease):
    try:
        await service.end_lease_admission(
            request.contract_sha256,
            str(request.holder_uid),
            request.lease_token,
        )
    except LeaseAdmissionConflictError as exc:
        return JSONResponse(
            status_code=409,
            content={"code": "lease_admission_conflict", "detail": str(exc)},
        )
    return Response(status_code=204)


@router.post(
    "/browsers", dependencies=[Depends(verify_api_key)], response_model=ActorInfo
)
async def create_browser():
    try:
        return await service.create_browser()
    except LeaseAdmissionDrainingError as exc:
        return JSONResponse(
            status_code=503,
            headers={"Retry-After": str(exc.retry_after_seconds)},
            content={
                "code": "lease_admission_draining",
                "detail": str(exc),
            },
        )


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

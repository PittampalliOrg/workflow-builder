from typing import List, Optional
from uuid import UUID

from pydantic import BaseModel, Field


class LeaseAdmissionOwner(BaseModel):
    contract_sha256: str = Field(pattern=r"^[0-9a-f]{64}$")
    holder_uid: UUID


class LeaseAdmissionRequest(LeaseAdmissionOwner):
    ttl_seconds: int = Field(default=30, ge=5, le=120)


class LeaseAdmissionStatus(BaseModel):
    accepting_new_leases: bool
    contract_sha256: Optional[str] = None
    expires_in_seconds: Optional[float] = None


class Health(BaseModel):
    status: str
    ray_status: bool
    browsers: dict
    cluster: dict
    available: dict
    lease_admission: LeaseAdmissionStatus


class BrowserInfo(BaseModel):
    browser_id: UUID
    pod_ip: str
    websocket_url: Optional[str] = None
    chrome_ready: bool


class ActorInfo(BaseModel):
    browser_id: UUID
    proxy_url: str


class BrowserStatus(BaseModel):
    browser_id: UUID
    status: str


class BrowserList(BaseModel):
    browsers: List[dict]

from typing import List, Optional
from uuid import UUID

from pydantic import BaseModel


class Health(BaseModel):
    status: str
    ray_status: bool
    browsers: dict
    cluster: dict
    available: dict


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

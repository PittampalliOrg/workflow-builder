"""Runtime composition root for application ports and infrastructure adapters."""

from __future__ import annotations

from functools import lru_cache

from src.adapters.harness_durable_media import HarnessDurableMediaAdapter
from src.adapters.pillow_workspace_image import PillowWorkspaceImageAdapter
from src.ports.durable_media import DurableMediaPort
from src.ports.workspace_image import WorkspaceImagePort


@lru_cache(maxsize=16)
def durable_media_port(workspace_root: str) -> DurableMediaPort:
    return HarnessDurableMediaAdapter(workspace_root)


@lru_cache(maxsize=16)
def workspace_image_port(workspace_root: str) -> WorkspaceImagePort:
    return PillowWorkspaceImageAdapter(workspace_root)

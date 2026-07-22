"""Runtime composition root for application ports and infrastructure adapters."""

from __future__ import annotations

import os
from functools import lru_cache

from src.adapters.harness_durable_media import HarnessDurableMediaAdapter
from src.adapters.pillow_workspace_image import PillowWorkspaceImageAdapter
from src.adapters.workflow_builder_runtime_start_authority import (
    WorkflowBuilderRuntimeStartAuthorityAdapter,
)
from src.ports.durable_media import DurableMediaPort
from src.ports.runtime_start_authority import RuntimeStartAuthorityPort
from src.ports.workspace_image import WorkspaceImagePort


@lru_cache(maxsize=16)
def durable_media_port(workspace_root: str) -> DurableMediaPort:
    return HarnessDurableMediaAdapter(workspace_root)


@lru_cache(maxsize=16)
def workspace_image_port(workspace_root: str) -> WorkspaceImagePort:
    return PillowWorkspaceImageAdapter(workspace_root)


@lru_cache(maxsize=1)
def runtime_start_authority_port() -> RuntimeStartAuthorityPort:
    return WorkflowBuilderRuntimeStartAuthorityAdapter(
        internal_token=os.environ.get("INTERNAL_API_TOKEN", ""),
        workflow_builder_app_id=os.environ.get(
            "WORKFLOW_BUILDER_APP_ID", "workflow-builder"
        ),
        dapr_http_port=os.environ.get("DAPR_HTTP_PORT", "3500"),
    )

"""Runtime composition root for application ports and infrastructure adapters."""

from __future__ import annotations

import os
from functools import lru_cache

from src.adapters.workflow_builder_runtime_start_authority import (
    WorkflowBuilderRuntimeStartAuthorityAdapter,
)
from src.ports.runtime_start_authority import RuntimeStartAuthorityPort


@lru_cache(maxsize=1)
def runtime_start_authority_port() -> RuntimeStartAuthorityPort:
    return WorkflowBuilderRuntimeStartAuthorityAdapter(
        internal_token=os.environ.get("INTERNAL_API_TOKEN", ""),
        workflow_builder_app_id=os.environ.get(
            "WORKFLOW_BUILDER_APP_ID", "workflow-builder"
        ),
        dapr_http_port=os.environ.get("DAPR_HTTP_PORT", "3500"),
    )

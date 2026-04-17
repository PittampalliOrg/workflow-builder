"""
Spawn-session activity for the workflow↔session bridge.

Called by ``sw_workflow.py`` when ``WORKFLOW_USE_SESSIONS=true`` for a
``durable/run`` node. Creates the ephemeral agent row + session row in
workflow-builder's DB via an internal endpoint and returns the child
workflow input that the orchestrator then passes to a Dapr
``call_child_workflow("session_workflow", ...)`` call.

Durability:
  * Idempotent — the orchestrator passes a deterministic ``sessionId``
    derived from ``{workflow_execution_id}__{node_id}__run__{index}``.
    The endpoint short-circuits if a row already exists so Dapr activity
    retries don't duplicate writes.
  * No polling or long waits here — this is a short activity. The real
    wait happens in the orchestrator's ``call_child_workflow`` call on
    ``session_workflow`` right after this activity returns.
  * Does not hold any non-deterministic state in memory between yields;
    activity replay is safe.
"""

from __future__ import annotations

import logging
import os
from typing import Any

import requests

from tracing import start_activity_span

logger = logging.getLogger(__name__)


def spawn_session_for_workflow(ctx, input_data: dict[str, Any]) -> dict[str, Any]:
    """Create (or look up) a session row for a ``durable/run`` node.

    Input keys (all required unless noted):
        ``sessionId``           deterministic id = child_instance_id
        ``workflowId``          source workflow id
        ``nodeId``              SW 1.0 task name
        ``agentConfig``         inline agent config from the node's args
        ``environmentConfig``   optional environment config dict
        ``vaultIds``            optional list of vault ids
        ``userId``              workflow execution owner
        ``projectId``           optional project scoping
        ``workflowExecutionId`` DB row id for the parent execution
        ``parentExecutionId``   Dapr instance id of the parent workflow
        ``initialMessage``      optional kickoff prompt text
        ``title``               optional session title

    Returns a dict matching ``/api/internal/sessions/ensure-for-workflow``:
        { sessionId, agentId, agentVersion, childInput, reused }
    """
    with start_activity_span("spawn_session_for_workflow"):
        workflow_builder_url = os.environ.get(
            "WORKFLOW_BUILDER_URL",
            "http://workflow-builder.workflow-builder.svc.cluster.local:3000",
        ).rstrip("/")
        internal_token = os.environ.get("INTERNAL_API_TOKEN", "")
        if not internal_token:
            raise RuntimeError(
                "INTERNAL_API_TOKEN is not configured — workflow↔session bridge requires it"
            )

        session_id = str(input_data.get("sessionId") or "").strip()
        if not session_id:
            raise RuntimeError("spawn_session_for_workflow: sessionId is required")

        payload: dict[str, Any] = {
            "sessionId": session_id,
            "workflowId": input_data.get("workflowId") or "",
            "nodeId": input_data.get("nodeId") or "",
            "workflowExecutionId": input_data.get("workflowExecutionId"),
            "parentExecutionId": input_data.get("parentExecutionId"),
            "userId": input_data.get("userId") or "",
            "projectId": input_data.get("projectId"),
            "agentConfig": input_data.get("agentConfig") or {},
            "environmentConfig": input_data.get("environmentConfig"),
            "vaultIds": input_data.get("vaultIds") or [],
            "initialMessage": input_data.get("initialMessage"),
            "title": input_data.get("title"),
        }

        endpoint = f"{workflow_builder_url}/api/internal/sessions/ensure-for-workflow"
        try:
            response = requests.post(
                endpoint,
                json=payload,
                headers={"X-Internal-Token": internal_token},
                timeout=30,
            )
        except requests.exceptions.RequestException as exc:
            logger.warning(
                "[spawn_session] HTTP error calling %s: %s", endpoint, exc
            )
            raise RuntimeError(
                f"spawn_session_for_workflow: request failed: {exc}"
            ) from exc

        if response.status_code >= 400:
            body_preview = response.text[:800] if response.text else "<empty>"
            raise RuntimeError(
                f"spawn_session_for_workflow: HTTP {response.status_code} from BFF: {body_preview}"
            )

        try:
            body = response.json()
        except ValueError as exc:
            raise RuntimeError(
                f"spawn_session_for_workflow: invalid JSON from BFF: {exc}"
            ) from exc

        if not isinstance(body, dict):
            raise RuntimeError(
                f"spawn_session_for_workflow: expected object from BFF, got {type(body).__name__}"
            )

        child_input = body.get("childInput")
        if not isinstance(child_input, dict):
            raise RuntimeError(
                "spawn_session_for_workflow: BFF did not return childInput"
            )

        return {
            "sessionId": body.get("sessionId") or session_id,
            "agentId": body.get("agentId"),
            "agentVersion": body.get("agentVersion"),
            "childInput": child_input,
            "reused": bool(body.get("reused")),
        }

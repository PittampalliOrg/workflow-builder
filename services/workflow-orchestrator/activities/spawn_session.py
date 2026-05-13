"""
Spawn-session activity for the workflow↔session bridge.

Called by ``sw_workflow.py`` for every ``durable/run`` node that targets
``dapr-agent-py`` (structural invariant after Deploy B of the CMA-
alignment plan — the previous ``WORKFLOW_USE_SESSIONS=true`` feature
flag was removed once the bridge stabilized). Creates the ephemeral
agent row + session row in workflow-builder's DB via an internal
endpoint and returns the child workflow input that the orchestrator
then passes to a Dapr ``call_child_workflow("session_workflow", ...)``
call.

Durability:
  * Idempotent — the orchestrator passes a deterministic ``sessionId``
    derived from ``{workflow_execution_id}__{node_id}__run__{index}``.
    The endpoint short-circuits if a row already exists so Dapr activity
    retries don't duplicate writes.
  * Polling is intentionally contained in this activity when the BFF reports
    that a per-session agent host is still queued. Dapr workflow code must not
    add readiness timers around this path because that mutates parent workflow
    history and can trip replay nondeterminism during high fanout runs.
  * Does not hold any workflow state in memory between yields; activity retries
    are safe because the BFF endpoint is idempotent for ``sessionId``.
"""

from __future__ import annotations

import logging
import os
import time
from typing import Any

import requests

from tracing import set_current_span_attrs, start_activity_span

logger = logging.getLogger(__name__)

DEFAULT_AGENT_SESSION_HOST_READY_POLL_SECONDS = 5
DEFAULT_AGENT_SESSION_HOST_READY_TIMEOUT_SECONDS = 600


def _int_env(name: str, default: int, *, minimum: int = 1) -> int:
    try:
        return max(minimum, int(os.environ.get(name, str(default))))
    except (TypeError, ValueError):
        return max(minimum, default)


def _is_agent_session_app_id(value: Any) -> bool:
    return isinstance(value, str) and value.strip().startswith("agent-session-")


def _agent_session_host_status(value: dict[str, Any]) -> str | None:
    status = value.get("agentHostStatus") or value.get("status")
    return status.strip().lower() if isinstance(status, str) and status.strip() else None


def _agent_session_host_is_ready(value: str | None) -> bool:
    return value in {"ready", "running"}


def _post_ensure_for_workflow(
    endpoint: str,
    payload: dict[str, Any],
    internal_token: str,
) -> dict[str, Any]:
    try:
        # The BFF may synchronously wait for host readiness for a short window.
        # Keep the HTTP timeout above the BFF cap so slow readiness reports are
        # returned as queued/ready instead of client-side disconnects.
        response = requests.post(
            endpoint,
            json=payload,
            headers={"X-Internal-Token": internal_token},
            timeout=90,
        )
    except requests.exceptions.RequestException as exc:
        logger.warning("[spawn_session] HTTP error calling %s: %s", endpoint, exc)
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
    return body


def _ensure_agent_session_host_ready(
    endpoint: str,
    payload: dict[str, Any],
    internal_token: str,
) -> dict[str, Any]:
    poll_seconds = _int_env(
        "AGENT_SESSION_HOST_READY_POLL_SECONDS",
        DEFAULT_AGENT_SESSION_HOST_READY_POLL_SECONDS,
    )
    timeout_seconds = _int_env(
        "AGENT_SESSION_HOST_READY_TIMEOUT_SECONDS",
        DEFAULT_AGENT_SESSION_HOST_READY_TIMEOUT_SECONDS,
    )
    deadline = time.monotonic() + timeout_seconds
    body = _post_ensure_for_workflow(endpoint, payload, internal_token)

    while True:
        agent_app_id = body.get("agentAppId")
        if not _is_agent_session_app_id(agent_app_id):
            return body

        host_status = _agent_session_host_status(body)
        if host_status is None or _agent_session_host_is_ready(host_status):
            return body

        if time.monotonic() >= deadline:
            raise TimeoutError(
                f"agent workflow host {agent_app_id} did not become ready before "
                f"scheduling session_workflow; last status={host_status}"
            )

        time.sleep(poll_seconds)
        body = _post_ensure_for_workflow(endpoint, payload, internal_token)


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
    otel = input_data.get("_otel") if isinstance(input_data.get("_otel"), dict) else None
    set_current_span_attrs({
        "session.id": input_data.get("sessionId"),
        "workflow.id": input_data.get("workflowId"),
        "workflow.execution.id": input_data.get("workflowExecutionId"),
        "workflow.parent_instance_id": input_data.get("parentExecutionId"),
        "node.id": input_data.get("nodeId"),
        "agent.id": input_data.get("agentId"),
        "agent.version": input_data.get("agentVersion"),
        "agent.slug": input_data.get("agentSlug"),
        "agent.app_id": input_data.get("agentAppId"),
        "project.id": input_data.get("projectId"),
        "user.id": input_data.get("userId"),
        "sandbox.workspace_ref": input_data.get("workspaceRef"),
        "sandbox.name": input_data.get("sandboxName"),
        "sandbox.cwd": input_data.get("cwd"),
        "agent.max_iterations": input_data.get("maxIterations"),
        "agent.timeout_minutes": input_data.get("timeoutMinutes"),
        "benchmark.run_id": input_data.get("benchmarkRunId"),
        "benchmark.instance_id": input_data.get("benchmarkInstanceId"),
        "session.vault_count": len(input_data.get("vaultIds") or []),
    })
    with start_activity_span("activity.spawn_session_for_workflow", otel):
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
            "benchmarkRunId": input_data.get("benchmarkRunId"),
            "benchmarkInstanceId": input_data.get("benchmarkInstanceId"),
            "userId": input_data.get("userId") or "",
            "projectId": input_data.get("projectId"),
            "agentConfig": input_data.get("agentConfig") or {},
            "instructionBundle": input_data.get("instructionBundle")
            if isinstance(input_data.get("instructionBundle"), dict)
            else None,
            "environmentConfig": input_data.get("environmentConfig"),
            "vaultIds": input_data.get("vaultIds") or [],
            "initialMessage": input_data.get("initialMessage"),
            "title": input_data.get("title"),
            # Forward the per-agent runtime identity so the BFF can wake
            # the target pod before returning. Without the wake, the parent's
            # subsequent ctx.call_child_workflow times out because the agent-
            # runtime pod is scaled to 0 and not registered with Dapr
            # placement. See src/routes/api/internal/sessions/ensure-for-workflow.
            "agentId": input_data.get("agentId"),
            "agentVersion": input_data.get("agentVersion"),
            "agentAppId": input_data.get("agentAppId"),
            "agentSlug": input_data.get("agentSlug"),
            # Sandbox plumbing forwarded to the BFF's buildChildInput so
            # session_workflow → agent_workflow can bind the OpenShell sandbox.
            "workspaceRef": input_data.get("workspaceRef"),
            "sandboxName": input_data.get("sandboxName"),
            "cwd": input_data.get("cwd"),
            "timeoutMinutes": input_data.get("timeoutMinutes"),
            "maxIterations": input_data.get("maxIterations"),
            "mlflowContext": input_data.get("mlflowContext")
            if isinstance(input_data.get("mlflowContext"), dict)
            else None,
        }

        endpoint = f"{workflow_builder_url}/api/internal/sessions/ensure-for-workflow"
        body = _ensure_agent_session_host_ready(endpoint, payload, internal_token)

        child_input = body.get("childInput")
        if not isinstance(child_input, dict):
            raise RuntimeError(
                "spawn_session_for_workflow: BFF did not return childInput"
            )

        return {
            "sessionId": body.get("sessionId") or session_id,
            "agentId": body.get("agentId"),
            "agentVersion": body.get("agentVersion"),
            "agentSlug": body.get("agentSlug"),
            "agentAppId": body.get("agentAppId"),
            "agentHostStatus": body.get("agentHostStatus") or body.get("status"),
            "childInput": child_input,
            "reused": bool(body.get("reused")),
        }

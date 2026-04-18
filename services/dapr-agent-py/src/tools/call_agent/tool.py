"""CallAgent tool -- delegate to a peer agent via the workflow-builder BFF.

Companion to the TypeScript `AgentConfig.callableAgents` + resolver path
in the workflow-builder SvelteKit app. The resolver enriches every
`durable/run` task body with
`callableAgents: [{slug, agentId, appId, team, registryKey}, ...]`
and `spawn.ts` does the same for UI-started sessions. This tool reads
that per-run list from a thread-local set by `agent_workflow`, resolves
the requested peer, and POSTs to the workflow-builder BFF's
`/api/internal/sessions/spawn-peer` endpoint — which creates a real
`sessions` DB row (visible in the UI + navigable via the sessions
list) and kicks off `session_workflow` durably on Dapr.

Dapr durability notes:
- The tool runs inside `run_tool` activity. Activity retries are
  idempotent here because the BFF endpoint keys off a deterministic
  `sessionId` we generate (`ca-<uuid:16>-<slug:20>`). Retries after the
  row is created short-circuit to the existing row.
- The child `session_workflow` is spawned by the BFF via
  `spawnSessionWorkflow`, which posts to dapr-agent-py's
  `/internal/sessions/spawn` endpoint — that path is already used by
  every UI-initiated session and carries Dapr's native durability.
- The parent receives a `child_instance_id`; it can poll via the
  existing `ReadSessionEvents` tool or let the delegation be
  fire-and-forget.
"""

from __future__ import annotations

import json
import logging
import os
import uuid
from typing import Any

from dapr.clients import DaprClient

from .._callable_agents_context import get_callable_agents_context

logger = logging.getLogger(__name__)

_WORKFLOW_BUILDER_APP_ID = os.environ.get(
    "WORKFLOW_BUILDER_APP_ID", "workflow-builder"
)
_INTERNAL_TOKEN_ENV = "INTERNAL_API_TOKEN"


def _find_peer(
    callable_agents: list[dict[str, Any]], name: str
) -> dict[str, Any] | None:
    target = name.strip().lower()
    for entry in callable_agents:
        slug = str(entry.get("slug", "")).strip().lower()
        if slug == target:
            return entry
    return None


def call_agent(name: str, prompt: str) -> str:
    """Delegate a task to a peer agent. Spawns a new CMA-shape session on
    the peer's app_id via the workflow-builder BFF; returns the child
    session id so the parent can poll for results with ReadSessionEvents.
    """
    if not name or not str(name).strip():
        return "Error: `name` is required (peer agent slug)."
    if not prompt or not str(prompt).strip():
        return "Error: `prompt` is required (task for the peer)."

    ctx = get_callable_agents_context()
    if not ctx or not ctx.callable_agents:
        return (
            "Error: no peer agents configured for this session. "
            "Set callableAgents on the agent config and re-publish."
        )

    peer = _find_peer(ctx.callable_agents, name)
    if peer is None:
        allowed = ", ".join(sorted(p.get("slug", "?") for p in ctx.callable_agents))
        return (
            f"Error: peer '{name}' is not on this agent's callableAgents list. "
            f"Allowed peers: {allowed}"
        )

    slug = str(peer.get("slug"))
    peer_agent_id = str(peer.get("agentId", ""))
    if not peer_agent_id:
        return f"Error: peer '{slug}' has no agentId (malformed registry entry)."

    # Deterministic child id so Dapr activity retries don't double-spawn.
    # Dapr caps workflow instance IDs at 64 chars; keep this under.
    truncated_slug = slug[:20] if slug else "peer"
    child_session_id = f"ca-{uuid.uuid4().hex[:16]}-{truncated_slug}"

    token = os.environ.get(_INTERNAL_TOKEN_ENV, "").strip()
    if not token:
        return json.dumps(
            {
                "error": (
                    "INTERNAL_API_TOKEN not configured; the BFF spawn-peer "
                    "endpoint requires internal-token auth."
                )
            }
        )

    payload: dict[str, Any] = {
        "sessionId": child_session_id,
        "peerAgentId": peer_agent_id,
        "prompt": prompt.strip(),
        "parentSessionId": ctx.parent_session_id,
        "parentInstanceId": ctx.parent_instance_id,
        "title": f"Delegated from {ctx.parent_session_id or 'agent'}: {prompt.strip()[:40]}",
    }

    try:
        with DaprClient() as client:
            response = client.invoke_method(
                app_id=_WORKFLOW_BUILDER_APP_ID,
                method_name="api/internal/sessions/spawn-peer",
                http_verb="POST",
                data=json.dumps(payload).encode("utf-8"),
                content_type="application/json",
                headers={"X-Internal-Token": token},
                timeout=15,
            )
            body_text = (
                response.text()
                if hasattr(response, "text")
                else response.data.decode("utf-8")
            )
    except Exception as exc:  # noqa: BLE001
        logger.warning("[call_agent] invoke failed for peer %s: %s", slug, exc)
        return json.dumps(
            {
                "error": (
                    f"Failed to reach workflow-builder BFF to spawn peer "
                    f"'{slug}': {type(exc).__name__}: {exc}"
                )
            }
        )

    try:
        response_body = json.loads(body_text)
    except Exception:  # pragma: no cover
        response_body = {"raw": body_text}

    result = {
        "status": "dispatched"
        if response_body.get("daprInstanceId")
        else response_body.get("reused", False) and "already_running" or "pending",
        "peer": slug,
        "peer_app_id": str(peer.get("appId") or "dapr-agent-py"),
        "child_session_id": response_body.get("sessionId") or child_session_id,
        "dapr_instance_id": response_body.get("daprInstanceId"),
        "registry_team": str(peer.get("team") or ctx.registry_team or ""),
        "registry_key": peer.get("registryKey"),
        "reused": bool(response_body.get("reused")),
        "hint": (
            f"Child session is visible in the workspace sessions list as "
            f"id={response_body.get('sessionId') or child_session_id}. "
            f"Use ReadSessionEvents with session_id='{response_body.get('sessionId') or child_session_id}' "
            "to poll the peer's progress and retrieve its final answer."
        ),
    }
    if response_body.get("error"):
        result["warning"] = response_body["error"]
    return json.dumps(result, indent=2)


from .prompt import get_call_agent_tool_description

call_agent.__doc__ = get_call_agent_tool_description()

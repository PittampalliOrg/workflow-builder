"""CallAgent tool -- delegate to a peer agent via Dapr Agents' registry.

Companion to the TypeScript `AgentConfig.callableAgents` + resolver path
in the workflow-builder SvelteKit app. The resolver enriches every
`durable/run` task body with `callableAgents: [{slug, agentId, appId, team,
registryKey}, ...]`. This tool reads that per-run list from a
thread-local set by `agent_workflow`, resolves the requested peer, and
kicks off a child workflow via Dapr's HTTP workflow API.

Fire-and-forget by default: returns the child session/instance ID
immediately. The parent can use the ReadSessionEvents tool (or its own
workflow pattern) to pull progress updates.
"""

from __future__ import annotations

import json
import os
import urllib.error
import urllib.request
import uuid
from typing import Any

from .._callable_agents_context import get_callable_agents_context


def _dapr_base() -> str:
    port = os.environ.get("DAPR_HTTP_PORT", "3500")
    return f"http://localhost:{port}"


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
    """Delegate a task to a peer agent registered in the Dapr registry."""
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

    app_id = str(peer.get("appId") or "dapr-agent-py")
    team = str(peer.get("team") or ctx.registry_team or "")
    slug = str(peer.get("slug"))

    # Dapr caps workflow instance IDs at 64 chars. Keep this short:
    # 3 (prefix) + 16 (uuid) + 1 (sep) + <=20 (slug) = <=40 chars.
    # Parent-id linkage flows through the payload.source block below.
    truncated_slug = slug[:20] if slug else "peer"
    child_instance_id = f"ca-{uuid.uuid4().hex[:16]}-{truncated_slug}"

    # We spawn `session_workflow` (our CMA session-loop workflow) rather
    # than `agent_workflow` directly. session_workflow gives the peer a
    # full CMA-shape session (status events, transcript, auto-terminate),
    # which shows up in the sessions list and is navigable via the UI.
    # The peer's runtime resolves its agentConfig from `sessionId` when
    # autoTerminateAfterEndTurn is set — a single-turn dispatch.
    workflow_name = "session_workflow"

    payload: dict[str, Any] = {
        "sessionId": child_instance_id,
        "initialEvents": [
            {
                "type": "user.message",
                "content": [{"type": "text", "text": prompt.strip()}],
            }
        ],
        # Fire-and-forget: child runs one turn, emits status_idle, terminates.
        "autoTerminateAfterEndTurn": True,
        # Provenance — the peer session's event log captures this so the
        # UI can render the parent → child link.
        "source": {
            "kind": "call_agent",
            "parent_app_id": os.environ.get("DAPR_APP_ID", "dapr-agent-py"),
            "parent_instance_id": ctx.parent_instance_id,
            "parent_session_id": ctx.parent_session_id,
        },
        "registryTeam": team,
        "peerSlug": slug,
    }

    url = (
        f"{_dapr_base()}/v1.0-alpha1/workflows/{app_id}/{workflow_name}/start"
        f"?instanceID={child_instance_id}"
    )

    req = urllib.request.Request(
        url,
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            body = resp.read().decode("utf-8", errors="replace")
            status = resp.status
    except urllib.error.HTTPError as exc:
        return (
            f"Error: Dapr rejected child-workflow start for peer '{slug}' "
            f"(HTTP {exc.code}): {exc.read().decode('utf-8', errors='replace')[:400]}"
        )
    except Exception as exc:  # pragma: no cover
        return (
            f"Error dispatching child workflow for peer '{slug}': "
            f"{type(exc).__name__}: {exc}"
        )
    if status >= 400:
        return (
            f"Error: Dapr rejected child-workflow start for peer '{slug}' "
            f"(HTTP {status}): {body[:400]}"
        )

    result = {
        "status": "dispatched",
        "peer": slug,
        "peer_app_id": app_id,
        "child_instance_id": child_instance_id,
        "registry_team": team,
        "registry_key": peer.get("registryKey"),
        "hint": (
            f"Use ReadSessionEvents with session_id='{child_instance_id}' to "
            "poll the peer's progress and retrieve its final answer."
        ),
    }
    return json.dumps(result, indent=2)


from .prompt import get_call_agent_tool_description

call_agent.__doc__ = get_call_agent_tool_description()

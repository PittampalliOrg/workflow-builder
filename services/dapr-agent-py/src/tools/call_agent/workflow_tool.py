"""CallAgent workflow-tool variant (Approach B).

Unlike the legacy `tool.py` (which is a plain function that POSTs to the BFF
and returns fire-and-forget), this variant runs inline in the parent
`agent_workflow` generator via the SDK's `WorkflowContextInjectedTool`
dispatch path. Yielding on the child workflow Task returns the peer's
final answer synchronously; the SDK wraps it as a ToolMessage and feeds
it to the LLM in the same turn — no polling via ReadSessionEvents needed.

Durability:
- Parent's `yield ctx.call_child_workflow(call_peer_session_workflow, instance_id=det:call)`
  is event-sourced; replay re-attaches to the same wrapper, never double-spawns.
- The wrapper workflow (in main.py) yields an activity + session_workflow,
  both durable.
- The peer session's own workflow instance remains the session id
  (`ca-<uuid:16>-<slug:20>`, ≤40 chars), while the wrapper gets a short suffix.
"""

from __future__ import annotations

import uuid
from typing import Any, Optional

from pydantic import BaseModel, Field

from dapr_agents.tool.workflow.tool_context import WorkflowContextInjectedTool

from .._callable_agents_context import get_callable_agents_context
from .prompt import get_call_agent_tool_description


class CallAgentArgs(BaseModel):
    name: str = Field(
        ...,
        description=(
            "Peer agent slug (must be on this agent's callableAgents list). "
            "Slug matching is case-insensitive."
        ),
    )
    prompt: str = Field(
        ...,
        description=(
            "Full task for the peer. The peer starts a fresh session with "
            "no history, so include context the peer needs to act."
        ),
    )


def _schedule_peer_session(
    ctx: Any,
    name: str,
    prompt: str,
    _source_agent: Optional[str] = None,
    _child_instance_id: Optional[str] = None,
) -> Any:
    """Executor for the CallAgent workflow-tool.

    Called synchronously by the SDK's dispatch loop inside the parent
    agent_workflow generator. MUST return a Dapr Task (unyielded
    ``ctx.call_child_workflow(...)`` result), not a generator.
    """
    if not name or not str(name).strip():
        raise ValueError("CallAgent `name` is required (peer agent slug).")
    if not prompt or not str(prompt).strip():
        raise ValueError("CallAgent `prompt` is required (task for the peer).")

    peer_ctx = get_callable_agents_context()
    if not peer_ctx or not peer_ctx.callable_agents:
        raise RuntimeError(
            "no peer agents configured for this session. Set callableAgents "
            "on the agent config and re-publish."
        )

    target = name.strip().lower()
    peer = next(
        (
            p
            for p in peer_ctx.callable_agents
            if str(p.get("slug", "")).strip().lower() == target
        ),
        None,
    )
    if peer is None:
        allowed = ", ".join(
            sorted(str(p.get("slug", "?")) for p in peer_ctx.callable_agents)
        )
        raise ValueError(
            f"peer '{name}' is not on this agent's callableAgents list. "
            f"Allowed peers: {allowed}"
        )

    slug = str(peer.get("slug", "")) or "peer"
    peer_agent_id = str(peer.get("agentId", ""))
    if not peer_agent_id:
        raise RuntimeError(
            f"peer '{slug}' has no agentId (malformed registry entry)."
        )

    # Deterministic child session id. The wrapper uses a suffixed instance id
    # so the inner session_workflow can own the bare session id.
    truncated_slug = slug[:20] if slug else "peer"
    child_instance_id = (
        _child_instance_id or f"ca-{uuid.uuid4().hex[:16]}-{truncated_slug}"
    )

    # Per-agent-runtime plan: peer's appId comes from the registry entry
    # populated by the BFF's dual-write (which reads agents.runtime_app_id).
    # Derive `agent-runtime-<slug>` as a fallback so older registry rows
    # written before the new column was populated still route cleanly.
    peer_app_id = str(peer.get("appId") or "").strip()
    if not peer_app_id:
        peer_app_id = f"agent-runtime-{slug}"

    workflow_input = {
        "sessionId": child_instance_id,
        "peerAgentId": peer_agent_id,
        "peerSlug": slug,
        "peerAppId": peer_app_id,
        "registryTeam": peer.get("team") or peer_ctx.registry_team,
        "prompt": prompt.strip(),
        "parentSessionId": peer_ctx.parent_session_id,
        "parentInstanceId": peer_ctx.parent_instance_id,
        "title": f"Delegated: {prompt.strip()[:60]}",
    }

    # NOTE: the wrapper workflow (call_peer_session_workflow) is registered
    # on *every* dapr-agent-py pod. Cross-runtime routing to a
    # dapr-agent-py-testing peer would use `app_id="dapr-agent-py-testing"`
    # here; for now both runtimes share the workflow and we let the BFF
    # resolve the peer's runtime inside the activity.
    return ctx.call_child_workflow(
        workflow="call_peer_session_workflow",
        input=workflow_input,
        instance_id=f"{child_instance_id}:call",
    )


class CallAgentWorkflowTool(WorkflowContextInjectedTool):
    """WorkflowContextInjectedTool that delegates to a peer agent by name.

    Detected by dapr-agents' dispatch loop at
    ``dapr_agents/agents/durable.py:522-560`` via ``isinstance(tool_obj,
    WorkflowContextInjectedTool)`` and routed through inline
    ``ctx.call_child_workflow`` instead of the ``run_tool`` activity —
    giving the parent LLM the peer's final answer in the same turn.
    """


def build_call_agent_workflow_tool() -> CallAgentWorkflowTool:
    return CallAgentWorkflowTool(
        name="CallAgent",
        description=get_call_agent_tool_description(),
        func=_schedule_peer_session,
        args_model=CallAgentArgs,
    )

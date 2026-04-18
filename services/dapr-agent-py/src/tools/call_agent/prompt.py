"""Prompt and constants for the CallAgent tool.

Counterpart of Dapr Agents' native call_agent primitive (from
dapr_agents.workflow.utils.core.call_agent). Exposes peer-agent
invocation to the LLM when the parent agent has a non-empty
AgentConfig.callableAgents list.
"""

CALL_AGENT_TOOL_NAME = "call_agent"


def get_call_agent_tool_description() -> str:
    return """Delegate a task to a peer agent registered in the Dapr agent registry.

Spawns a new session on the peer agent's app_id with the supplied prompt,
and returns the child session's instance ID. Use ReadSessionEvents with
that ID to poll progress, or let the parent return without waiting if the
delegation is fire-and-forget.

Peers are restricted to those configured on this agent's `callableAgents`
list and currently `registered` in the Dapr registry. Invoking a peer not
on the allow-list returns an error.

## When to use
- Multi-step work a specialized peer does better (e.g., "ask coding-assistant
  to scaffold a Python module while I focus on deployment")
- Parallel delegation of independent subtasks

## Arguments
- `name`: the peer agent's slug (e.g., "coding-assistant"). Must match a
  slug from your callableAgents list.
- `prompt`: the full user-style request to hand to the peer. Be specific
  — the peer starts a fresh session and has none of your context.
"""

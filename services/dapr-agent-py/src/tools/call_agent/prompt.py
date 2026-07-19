"""Prompt and constants for the CallAgent tool.

Counterpart of Dapr Agents' native call_agent primitive (from
dapr_agents.workflow.utils.core.call_agent). Exposes peer-agent
invocation to the LLM when the parent agent has a non-empty
AgentConfig.callableAgents list.
"""

CALL_AGENT_TOOL_NAME = "call_agent"


def get_call_agent_tool_description() -> str:
    return """Delegate a task to a peer agent registered in the Dapr agent registry.

Spawns a new session on the peer agent's app_id with the supplied prompt
and returns without waiting for the peer to finish. The tool result is a
JSON object containing the child session's ID (`child_session_id`) — the
child appears in the sessions list as a child of your run. The peer runs
asynchronously: use the ReadSessionEvents tool with that session ID to
poll its progress and retrieve its final answer, or treat the delegation
as fire-and-forget.

(A deployment may instead enable the synchronous variant via
AGENT_CALL_AGENT_NATIVE=1; then this tool waits for the peer to finish
and the tool result is the peer's final answer text, returned in the
same turn. The asynchronous polling flow above is the default.)

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

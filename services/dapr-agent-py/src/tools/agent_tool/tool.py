"""AgentSpawn tool -- spawn sub-agent workflows via Dapr child workflows."""

from __future__ import annotations

import json


def agent_spawn(
    prompt: str,
    description: str = "",
    target_agent: str | None = None,
) -> str:
    """Spawn a sub-agent to handle a complex task. Optionally specify a target agent by name for delegation."""
    if not prompt or not prompt.strip():
        return "Error: No prompt provided for the sub-agent."

    payload: dict = {
        "task": prompt.strip(),
        "source": "parent-agent",
    }

    if description:
        payload["description"] = description.strip()

    if target_agent:
        payload["target_agent"] = target_agent.strip()
        payload["workflow_name"] = f"dapr.agents.{target_agent.strip()}.workflow"

    return json.dumps(payload, indent=2)

from .prompt import get_agent_tool_description
agent_spawn.__doc__ = get_agent_tool_description()

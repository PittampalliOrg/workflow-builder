"""Prompt and constants for the AgentSpawn tool.

Ported from claude-code-src/main/tools/AgentTool/prompt.ts (simplified)
"""

AGENT_TOOL_NAME = "agent_spawn"


def get_agent_tool_description() -> str:
    return """Launch a sub-agent to handle a complex, multi-step task autonomously.

The agent_spawn tool launches a specialized agent that can work on a task independently.

## When to use
- Complex tasks requiring multiple tool calls
- Tasks that can run independently from the main conversation
- Delegation to a specific named agent

## When NOT to use
- Simple, single-step operations
- Tasks that require immediate results in the current turn

## Writing the prompt
- Explain what you're trying to accomplish and why
- Describe what you've already learned or ruled out
- Give enough context that the agent can make judgment calls
- Include file paths, line numbers, what specifically to change if applicable"""

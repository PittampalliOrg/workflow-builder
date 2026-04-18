"""Agent tools -- Python ports of Claude Code's default tool suite.

All tools are registered as AgentTool instances via ``from_func`` so they
integrate seamlessly with the Dapr durable agent workflow.

Tool names match the original Claude Code TypeScript tool names exactly:
Read, Write, Edit, Bash, Glob, Grep, etc.
"""

from __future__ import annotations

from dapr_agents.tool.base import AgentTool

from .agent_tool.tool import agent_spawn
from .ask_user.tool import ask_user
from .call_agent.tool import call_agent
from .bash_tool.tool import bash_run
from .file_edit.tool import file_edit
from .file_read.tool import file_read
from .file_write.tool import file_write
from .glob_tool.tool import glob_search
from .grep_tool.tool import grep_search
from .mcp_resources.tool import list_mcp_resources, read_mcp_resource
from .notebook_edit.tool import notebook_edit
from .read_session_events.tool import read_session_events
from .send_message.tool import send_message
from .skill_tool.tool import run_skill
from .task_output.tool import task_output
from .task_stop.tool import task_stop
from .todo_write.tool import todo_write
from .web_fetch.tool import web_fetch
from .web_search.tool import web_search


def _tool(func, name: str) -> AgentTool:
    """Create an AgentTool with an explicit name matching Claude Code."""
    t = AgentTool.from_func(func)
    t.name = name
    return t


# Tool names match claude-code-src exactly:
# FileReadTool → "Read", FileWriteTool → "Write", etc.
all_tools: list[AgentTool] = [
    # File operations (names match Claude Code: Read, Write, Edit)
    _tool(file_read, "Read"),
    _tool(file_write, "Write"),
    _tool(file_edit, "Edit"),
    _tool(notebook_edit, "NotebookEdit"),
    # Search (names match Claude Code: Glob, Grep)
    _tool(glob_search, "Glob"),
    _tool(grep_search, "Grep"),
    # Shell (name matches Claude Code: Bash)
    _tool(bash_run, "Bash"),
    # Web access
    _tool(web_fetch, "WebFetch"),
    _tool(web_search, "WebSearch"),
    # Agent / task management
    _tool(agent_spawn, "Agent"),
    # Peer-agent invocation via Dapr agent registry. Always registered;
    # per-run allow-list is injected via the callable_agents thread-local
    # by agent_workflow.
    _tool(call_agent, "CallAgent"),
    _tool(task_output, "TaskOutput"),
    _tool(task_stop, "TaskStop"),
    _tool(todo_write, "TodoWrite"),
    # Communication
    _tool(ask_user, "AskUser"),
    _tool(send_message, "SendMessage"),
    # Skills
    _tool(run_skill, "Skill"),
    # MCP resources
    _tool(list_mcp_resources, "ListMcpResources"),
    _tool(read_mcp_resource, "ReadMcpResource"),
    # Session event log (Anthropic CMA getEvents() pattern). Meaningful when
    # agentConfig.contextStrategy == "event_log" — then compaction is off
    # and the agent re-fetches earlier events from the durable log instead.
    _tool(read_session_events, "ReadSessionEvents"),
]

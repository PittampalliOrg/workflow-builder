"""ADK FunctionTool registry — wraps dapr-agent-py tool bodies for ADK.

Each tool body (in `bash_tool/tool.py`, `file_read/tool.py`, etc.) is a plain
Python function ported verbatim from dapr-agent-py. Here we wrap them with the
legacy `@with_session_events` fallback and adopt them as
`FunctionTool` instances under the canonical Claude-Code-shaped names
(`Read`, `Write`, `Edit`, `Bash`, ...).

Canonical CMA tool events are emitted by `src.telemetry.diagrid_adk` from the
durable `execute_tool_activity` wrapper so every ADK tool, including
non-native tools, carries the stable Diagrid tool call id.

The 18 tools are then attached to the LlmAgent's `.tools` list. Diagrid's
`_register_agent_tools()` walks that list at runner construction and
populates `_tool_registry`, where `execute_tool_activity` looks them up by
name when the LLM emits a tool_call.

Tool docstrings are populated from each tool's `prompt.py` description —
`FunctionTool` shows that text to the model as `description=`.
"""

from __future__ import annotations

import logging
from typing import Any

from google.adk.tools import FunctionTool

# Import each tool's underlying function — bodies are verbatim ports from
# dapr-agent-py.
from .ask_user.tool import ask_user as _ask_user
from .bash_tool.tool import bash_run as _bash_run
from .file_edit.tool import file_edit as _file_edit
from .file_read.tool import file_read as _file_read
from .file_write.tool import file_write as _file_write
from .glob_tool.tool import glob_search as _glob_search
from .grep_tool.tool import grep_search as _grep_search
from .mcp_resources.tool import (
    list_mcp_resources as _list_mcp_resources,
    read_mcp_resource as _read_mcp_resource,
)
from .notebook_edit.tool import notebook_edit as _notebook_edit
from .read_session_events.tool import read_session_events as _read_session_events
from .send_message.tool import send_message as _send_message
from .skill_tool.tool import run_skill as _run_skill
from .task_output.tool import task_output as _task_output
from .task_stop.tool import task_stop as _task_stop
from .todo_write.tool import todo_write as _todo_write
from .web_fetch.tool import web_fetch as _web_fetch
from .web_search.tool import web_search as _web_search

from ._wrappers import with_session_events

logger = logging.getLogger(__name__)


def _adopt(fn: Any, tool_name: str) -> FunctionTool:
    """Wrap a plain function as a named ADK `FunctionTool` with session-event
    publishing baked in."""
    wrapped = with_session_events(tool_name)(fn)
    tool = FunctionTool(wrapped)
    # ADK's FunctionTool derives its `name` from `func.__name__` by default —
    # override to match Claude-Code's tool name vocabulary.
    try:
        tool.name = tool_name
    except Exception:  # noqa: BLE001
        pass
    return tool


# All 18 native tools, in declaration order matching dapr-agent-py.
all_adk_tools: list[FunctionTool] = [
    # File operations
    _adopt(_file_read, "Read"),
    _adopt(_file_write, "Write"),
    _adopt(_file_edit, "Edit"),
    _adopt(_notebook_edit, "NotebookEdit"),
    # Search
    _adopt(_glob_search, "Glob"),
    _adopt(_grep_search, "Grep"),
    # Shell
    _adopt(_bash_run, "Bash"),
    # Web access
    _adopt(_web_fetch, "WebFetch"),
    _adopt(_web_search, "WebSearch"),
    # Task management
    _adopt(_task_output, "TaskOutput"),
    _adopt(_task_stop, "TaskStop"),
    _adopt(_todo_write, "TodoWrite"),
    # Communication
    _adopt(_ask_user, "AskUser"),
    _adopt(_send_message, "SendMessage"),
    # Skills (disk-based custom-skill registry)
    _adopt(_run_skill, "Skill"),
    # MCP resources
    _adopt(_list_mcp_resources, "ListMcpResources"),
    _adopt(_read_mcp_resource, "ReadMcpResource"),
    # Session event log — see read_session_events/tool.py for context.
    _adopt(_read_session_events, "ReadSessionEvents"),
]


# Subagent spawn (Agent) — reimplemented for ADK in `agent_tool/tool.py`,
# not yet ported in v1 (uses dapr-agents `AgentTool` in the original).
# Once ported, append:
#     all_adk_tools.append(_adopt(_agent_spawn, "Agent"))
#
# Peer-agent invocation (CallAgent) — also deferred to v1.1; the workflow-
# context-injected variant is dapr-agents-specific and requires reimplementation
# against ADK's tool_context primitives.

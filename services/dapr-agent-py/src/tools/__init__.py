"""Agent tools -- Python ports of Claude Code's default tool suite.

All tools are registered as AgentTool instances via ``from_func`` so they
integrate seamlessly with the Dapr durable agent workflow.

Tool names match the original Claude Code TypeScript tool names exactly:
Read, Write, Edit, Bash, Glob, Grep, etc.
"""

from __future__ import annotations

import os

from dapr_agents.tool.base import AgentTool

from .agent_tool.tool import agent_spawn
from .ask_user.tool import ask_user
from .call_agent.tool import call_agent
from .call_agent.workflow_tool import build_call_agent_workflow_tool
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


def _is_native_call_agent_enabled() -> bool:
    raw = (os.environ.get("AGENT_CALL_AGENT_NATIVE") or "").strip().lower()
    return raw in {"1", "true", "yes"}


# Peer-agent invocation. Two registrations gated by feature flag:
#   AGENT_CALL_AGENT_NATIVE=0 (default) → HTTP-based fire-and-forget tool
#       (Approach A): LLM gets child_session_id, polls via ReadSessionEvents.
#   AGENT_CALL_AGENT_NATIVE=1            → WorkflowContextInjectedTool
#       (Approach B): SDK dispatches via ctx.call_child_workflow inline,
#       peer's final answer flows back as the tool_result in the same LLM
#       turn with full Dapr event-sourced durability.
if _is_native_call_agent_enabled():
    all_tools.append(build_call_agent_workflow_tool())
else:
    all_tools.append(_tool(call_agent, "CallAgent"))


# ---------------------------------------------------------------------------
# Bootstrap MCP tools at module-init time
# ---------------------------------------------------------------------------
#
# Per dapr-agents 1.0.1's canonical pattern (see quickstarts/06-agent-mcp-
# client-stdio and sdk-docs on tools=), MCP tools are loaded synchronously
# BEFORE the DurableAgent is constructed and passed via tools=[...]. Per-
# instance dynamic MCP (session_workflow → call_activity → mutate
# _mcp_configs_by_instance) fights the Dapr workflow determinism model:
# orchestrator bodies replay from the top, so in-memory state written from
# inside the orchestrator has no durable history. Activities are the
# correct side-effect channel, but their state still evaporates on pod
# restart. Static load-at-startup sidesteps both issues: tools live in
# self.tool_executor for the pod's lifetime; no durability problem.
#
# Controlled by env var DAPR_AGENT_PY_BOOTSTRAP_MCP_SERVERS_JSON —
# JSON list of entries:
#   [{"name": "playwright", "transport": "streamable_http",
#     "url": "http://playwright-mcp-service.workflow-builder.svc.cluster.local:3100/mcp"}]
# Empty / unset → no MCP bootstrap (default).

def _load_bootstrap_mcp_tools() -> list:
    import asyncio
    import json as _json
    import logging

    logger = logging.getLogger(__name__)

    raw = (os.environ.get("DAPR_AGENT_PY_BOOTSTRAP_MCP_SERVERS_JSON") or "").strip()
    if not raw:
        return []
    try:
        entries = _json.loads(raw)
    except _json.JSONDecodeError as exc:
        logger.warning(
            "[mcp-bootstrap] invalid JSON in DAPR_AGENT_PY_BOOTSTRAP_MCP_SERVERS_JSON: %s",
            exc,
        )
        return []
    if not isinstance(entries, list) or not entries:
        return []

    from dapr_agents.tool.mcp import MCPClient

    async def _connect_all() -> list:
        # persistent_connections=True keeps the underlying stdio/http
        # transport alive for the agent's lifetime — necessary for static
        # bootstrap because we're not closing the client between turns.
        client = MCPClient(persistent_connections=True)
        for entry in entries:
            if not isinstance(entry, dict):
                continue
            name = str(
                entry.get("name")
                or entry.get("server_name")
                or entry.get("serverName")
                or ""
            ).strip()
            transport = str(entry.get("transport") or "streamable_http").lower()
            if not name:
                continue
            try:
                if transport in ("streamable_http", "streamable-http", "http"):
                    await client.connect_streamable_http(
                        server_name=name,
                        url=str(entry.get("url") or ""),
                        headers=entry.get("headers"),
                    )
                elif transport == "sse":
                    await client.connect_sse(
                        server_name=name,
                        url=str(entry.get("url") or ""),
                        headers=entry.get("headers"),
                    )
                elif transport == "stdio":
                    await client.connect_stdio(
                        server_name=name,
                        command=str(entry.get("command") or ""),
                        args=entry.get("args"),
                        env=entry.get("env"),
                    )
                else:
                    logger.warning(
                        "[mcp-bootstrap] unsupported transport %r for %s",
                        transport,
                        name,
                    )
            except Exception as exc:  # noqa: BLE001
                logger.warning(
                    "[mcp-bootstrap] connect %s failed: %s", name, exc
                )
        return client.get_all_tools()

    # asyncio.run() works when no loop is running on the current thread
    # (this is the case at module-import time before anything starts).
    # MCPClient uses anyio task groups internally and gets confused when
    # the loop is swapped between threads, so we run on the main thread.
    try:
        tools = asyncio.run(_connect_all())
    except RuntimeError as exc:
        # Fallback: loop already running (e.g. reload path). Try new loop.
        logger.warning(
            "[mcp-bootstrap] asyncio.run failed (%s); trying new_event_loop", exc
        )
        loop = asyncio.new_event_loop()
        try:
            tools = loop.run_until_complete(_connect_all())
        finally:
            loop.close()
    except Exception as exc:  # noqa: BLE001
        logger.warning("[mcp-bootstrap] load failed: %s", exc)
        return []
    logger.warning(
        "[mcp-bootstrap] loaded %d MCP tool(s) from %d server(s)",
        len(tools),
        len(entries),
    )
    return tools


_bootstrap_mcp_tools = _load_bootstrap_mcp_tools()
if _bootstrap_mcp_tools:
    all_tools.extend(_bootstrap_mcp_tools)

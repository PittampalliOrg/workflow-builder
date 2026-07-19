"""Agent tools -- coding tool suite aligned to Moonshot's kimi-code v2 surface.

All tools are registered as AgentTool instances via ``from_func`` so they
integrate seamlessly with the Dapr durable agent workflow.

Tool names and wire schemas follow the kimi-code v2 CLI (what kimi-k3 was
most likely trained on): Read, Write, Edit, Bash, Glob, Grep, TodoList,
AskUserQuestion, etc. Aligned tools carry explicit pydantic args models
(per-parameter descriptions, ``additionalProperties: false``) wired via
``_tool(..., args_model=...)``; the kimi adapter serializes them with
``by_alias=True`` so dash-named Grep params (``-i``, ``-A`` ...) reach the
wire verbatim.
"""

from __future__ import annotations

import os

from dapr_agents.tool.base import AgentTool

from .agent_tool.tool import agent_spawn
from .ask_user.tool import AskUserQuestionArgs, ask_user
from .call_agent.tool import call_agent
from .call_agent.workflow_tool import build_call_agent_workflow_tool
from .workflow_script.workflow_tool import build_workflow_script_tool
from .bash_tool.tool import BashArgs, bash_run
from .file_edit.tool import EditArgs, file_edit
from .file_read.tool import ReadArgs, file_read
from .file_write.tool import WriteArgs, file_write
from .glob_tool.tool import GlobArgs, glob_search
from .grep_tool.tool import GrepArgs, grep_search
from .notebook_edit.tool import notebook_edit
from .read_media_file.tool import ReadMediaFileArgs, read_media_file
from .read_session_events.tool import read_session_events
from .send_message.tool import send_message
from .skill_tool.tool import run_skill
from .task_output.tool import task_output
from .task_stop.tool import task_stop
from .todo_write.tool import TodoListArgs, todo_list
from .web_fetch.tool import web_fetch
from .web_search.tool import web_search


def _tool(func, name: str, args_model=None) -> AgentTool:
    """Create an AgentTool with an explicit kimi-code-aligned name (+ schema)."""
    t = AgentTool.from_func(func)
    t.name = name
    if args_model is not None:
        t.args_model = args_model
    return t


# Tool names match Moonshot's kimi-code v2 CLI:
# Read/Write/Edit/Bash/Glob/Grep/TodoList/AskUserQuestion, etc.
all_tools: list[AgentTool] = [
    # File operations
    _tool(file_read, "Read", ReadArgs),
    _tool(file_write, "Write", WriteArgs),
    _tool(file_edit, "Edit", EditArgs),
    _tool(notebook_edit, "NotebookEdit"),
    # Media (kimi-code ReadMediaFile; images ride the multimodal marker into K3 vision)
    _tool(read_media_file, "ReadMediaFile", ReadMediaFileArgs),
    # Search
    _tool(glob_search, "Glob", GlobArgs),
    _tool(grep_search, "Grep", GrepArgs),
    # Shell
    _tool(bash_run, "Bash", BashArgs),
    # Web access
    _tool(web_fetch, "WebFetch"),
    _tool(web_search, "WebSearch"),
    # Agent / task management
    _tool(agent_spawn, "Agent"),
    _tool(task_output, "TaskOutput"),
    _tool(task_stop, "TaskStop"),
    _tool(todo_list, "TodoList", TodoListArgs),
    # Communication
    _tool(ask_user, "AskUserQuestion", AskUserQuestionArgs),
    _tool(send_message, "SendMessage"),
    # Skills
    _tool(run_skill, "Skill"),
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


def _is_workflow_tool_enabled() -> bool:
    raw = (os.environ.get("AGENT_WORKFLOW_TOOL") or "").strip().lower()
    return raw not in {"0", "false", "no", "off"}


# Agent-spawnable dynamic-script workflows (the Claude Code Workflow tool
# mirror). Approach-B WorkflowContextInjectedTool: the agent loop yields a
# local bridge workflow that starts the run through the BFF's internal API
# and durably polls to the result — see src/tools/workflow_script. Enabled
# by default; kill with AGENT_WORKFLOW_TOOL=0. Depth-1 recursion guard lives
# in the tool executor (script-spawned sessions are refused).
if _is_workflow_tool_enabled():
    all_tools.append(build_workflow_script_tool())


# ---------------------------------------------------------------------------
# MCP bootstrap (called from FastAPI @app.on_event("startup") in main.py)
# ---------------------------------------------------------------------------
#
# Per dapr-agents 1.0.1's canonical pattern, MCP tools are registered on
# the agent's tool_executor at startup and remain static for the pod's
# lifetime — per-instance dynamic MCP fights the Dapr workflow determinism
# model (orchestrator bodies replay from the top; in-memory state written
# from inside the orchestrator has no durable history).
#
# We cannot run the async connect at module-import time because uvicorn
# has already started its asyncio loop and `asyncio.run()` forbids nested
# loops. Instead, main.py installs a FastAPI startup hook that awaits
# `bootstrap_mcp_tools(agent)` after uvicorn is up.
#
# Controlled by env var DAPR_AGENT_PY_BOOTSTRAP_MCP_SERVERS_JSON —
# JSON list of entries:
#   [{"name": "playwright", "transport": "streamable_http",
#     "url": "http://playwright-mcp-service.workflow-builder.svc.cluster.local:3100/mcp"}]
# Empty / unset → no MCP bootstrap.

async def bootstrap_mcp_tools(agent) -> int:
    """Connect to every MCP server declared in the bootstrap env var and
    register the resulting tools on ``agent.tool_executor``. Safe to call
    once at FastAPI startup; no-op on subsequent calls (dedupes by tool
    name). Returns the number of tools added."""
    import json as _json
    import logging

    logger = logging.getLogger(__name__)

    raw = (os.environ.get("DAPR_AGENT_PY_BOOTSTRAP_MCP_SERVERS_JSON") or "").strip()
    if not raw:
        return 0
    try:
        entries = _json.loads(raw)
    except _json.JSONDecodeError as exc:
        logger.warning(
            "[mcp-bootstrap] invalid JSON in DAPR_AGENT_PY_BOOTSTRAP_MCP_SERVERS_JSON: %s",
            exc,
        )
        return 0
    if not isinstance(entries, list) or not entries:
        return 0

    from dapr_agents.tool.mcp import MCPClient

    # persistent_connections=False: the bootstrap session's anyio TaskGroup
    # is entered under the FastAPI startup task. When Dapr workflow
    # activities call a tool from a different asyncio task, reusing the
    # cached session fails silently at the anyio cancel-scope boundary —
    # the HTTP POST returns 200 but the streamed response can't be
    # delivered cross-task, so the MCP server immediately closes the
    # session and no tool_result ever surfaces.
    #
    # Ephemeral mode opens + closes a fresh session in the current
    # activity's task context, paying one extra initialize/tools/list
    # round-trip per call but correctly delivering the tool_result. Used
    # tools are still registered on agent.tool_executor at bootstrap —
    # the executor closure captures (client, server_name, tool_name), so
    # ephemeral connections happen at invocation time.
    client = MCPClient(persistent_connections=False)
    connected = 0
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
                continue
            connected += 1
        except Exception as exc:  # noqa: BLE001
            logger.warning(
                "[mcp-bootstrap] connect %s failed: %s", name, exc
            )
    if connected == 0:
        return 0

    # Playwright MCP's streamable_http mode occasionally returns 0 tools
    # on the first list despite the connect succeeding — retry a few times
    # with a small delay. Tools live on _server_tools dict populated by
    # _load_tools_from_session; retrying gives anyio tasks time to settle.
    tools = client.get_all_tools()
    if not tools:
        import asyncio as _asyncio_retry

        for attempt in range(1, 5):
            await _asyncio_retry.sleep(1.0 * attempt)
            # Refetch tools; MCPClient keeps sessions alive in persistent mode
            # so we re-call _load_tools_from_session for each server.
            for entry in entries:
                if not isinstance(entry, dict):
                    continue
                name = str(
                    entry.get("name")
                    or entry.get("server_name")
                    or entry.get("serverName")
                    or ""
                ).strip()
                if not name or name not in getattr(client, "_sessions", {}):
                    continue
                try:
                    await client._load_tools_from_session(
                        name, client._sessions[name]
                    )
                except Exception as exc:  # noqa: BLE001
                    logger.warning(
                        "[mcp-bootstrap] retry %d _load_tools_from_session %s failed: %s",
                        attempt,
                        name,
                        exc,
                    )
            tools = client.get_all_tools()
            if tools:
                logger.warning(
                    "[mcp-bootstrap] got %d tool(s) after %d retry attempt(s)",
                    len(tools),
                    attempt,
                )
                break
    logger.warning(
        "[mcp-bootstrap] client.get_all_tools() returned %d tool(s)",
        len(tools),
    )
    existing = {getattr(t, "name", None) for t in agent.tool_executor.list_tools()}
    added = 0
    for tool in tools:
        name = getattr(tool, "name", None)
        if name and name in existing:
            continue
        agent.tool_executor.register_tool(tool)
        added += 1
    logger.warning(
        "[mcp-bootstrap] connected %d server(s), added %d new tool(s) to agent",
        connected,
        added,
    )
    # Keep the MCPClient alive on the agent to prevent transport close.
    try:
        setattr(agent, "_bootstrap_mcp_client", client)
    except Exception:
        pass
    return added

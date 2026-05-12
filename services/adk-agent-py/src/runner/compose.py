"""Bootstrap the Diagrid `DaprWorkflowAgentRunner` and our `session_workflow`.

The Compose pattern:

1. `build_runner(agent)` instantiates `DaprWorkflowAgentRunner` with a stable
   `name=` derived from `AGENT_SLUG`. The runner internally:
   - Constructs a `WorkflowRuntime` (exposed as `runner._workflow_runtime`).
   - Registers Diagrid's `agent_workflow` under the canonical name
     `dapr.adk.<TitleCase(name)>.workflow` (see
     `diagrid.agent.core.workflow.naming.sanitize_agent_name`).
   - Registers `call_llm_activity` and `execute_tool_activity` on the same
     runtime.
   - Registers the agent's tools in Diagrid's global `_tool_registry` so
     `execute_tool_activity` can look them up by `tool_call.name`.

2. `register_session_workflow(runner)` reaches into `runner._workflow_runtime`
   and adds OUR `session_workflow` (the outer event-loop + autoTerminate
   driver) under the well-known name `session_workflow`. This is the name
   the workflow-orchestrator passes to `ctx.call_child_workflow(...)` with
   `app_id="agent-session-<sha20>"`.

3. `runner.start()` boots both workflows on the same daprd placement.

`_workflow_runtime` is a private attribute of `BaseWorkflowRunner` —
relying on it is the load-bearing risk in this integration. If a future
Diagrid release renames it, we'll need a small fork. Pinning Diagrid in
`pyproject.toml` and adding a unit test that imports the attribute name
will break the build early if it changes.
"""

from __future__ import annotations

import logging
import os
from typing import TYPE_CHECKING

from diagrid.agent.adk import DaprWorkflowAgentRunner
from diagrid.agent.adk.workflow import register_tool

from src.constants import AGENT_SLUG, MAX_ITERATIONS

if TYPE_CHECKING:
    from google.adk.agents import LlmAgent

logger = logging.getLogger(__name__)


def _register_tool_aliases(agent: "LlmAgent") -> None:
    """Register declaration-name aliases for ADK tools.

    Diagrid registers tools by `tool.name` (for example `Write`), but Gemini
    emits the function declaration name (for example `file_write`). Keep both
    names pointed at the same tool so durable tool execution can resolve model
    tool calls.
    """
    for tool in getattr(agent, "tools", []) or []:
        aliases: set[str] = set()
        tool_name = getattr(tool, "name", None)
        if isinstance(tool_name, str) and tool_name:
            aliases.add(tool_name)

        get_decl = getattr(tool, "_get_declaration", None)
        if callable(get_decl):
            try:
                declaration = get_decl()
                declaration_name = getattr(declaration, "name", None)
                if isinstance(declaration_name, str) and declaration_name:
                    aliases.add(declaration_name)
                    aliases.add(declaration_name.split(":")[-1])
            except Exception as exc:  # noqa: BLE001
                logger.debug(
                    "[adk-runner] declaration alias failed for %s: %s",
                    tool_name,
                    exc,
                )

        for alias in aliases:
            register_tool(alias, tool)
        if len(aliases) > 1:
            logger.info("[adk-runner] registered tool aliases %s", sorted(aliases))


def build_runner(agent: "LlmAgent") -> DaprWorkflowAgentRunner:
    """Construct the Diagrid runner; does NOT start it (call `runner.start()`).

    `name=` becomes part of the workflow name Diagrid registers
    (`dapr.adk.<TitleCase(name)>.workflow`). Stable per-pod so the
    workflow-orchestrator's `_resolve_native_agent_runtime` can target it.
    """
    name = AGENT_SLUG.strip() or "adk-agent-py"

    # Default Dapr sidecar gRPC port — Diagrid uses 50001 if `port` is unset.
    port = os.environ.get("DAPR_GRPC_PORT")

    runner = DaprWorkflowAgentRunner(
        agent=agent,
        name=name,
        port=port,
        max_iterations=MAX_ITERATIONS,
    )
    _register_tool_aliases(agent)
    logger.info(
        "[adk-runner] built DaprWorkflowAgentRunner name=%s diagrid_workflow=%s max_iter=%d",
        name,
        runner.workflow_name,
        MAX_ITERATIONS,
    )
    return runner


def register_session_workflow(
    runner: DaprWorkflowAgentRunner,
    *,
    declared_tools: list[object] | None = None,
) -> None:
    """Add our outer `session_workflow` to the same `WorkflowRuntime`.

    The session_workflow body (in `src/runner/session_workflow.py`) calls
    `ctx.call_child_workflow(runner.workflow_name, ...)` per turn — i.e. it
    invokes Diagrid's `agent_workflow` as a child. Same WorkflowRuntime →
    same daprd placement → no extra hop.
    """
    from src.runner.session_workflow import session_workflow_factory

    rt = getattr(runner, "_workflow_runtime", None)
    if rt is None:
        raise RuntimeError(
            "DaprWorkflowAgentRunner._workflow_runtime is None — Diagrid "
            "internals changed, this version is incompatible."
        )

    diagrid_workflow_name = runner.workflow_name
    declared_tools = list(
        declared_tools
        or getattr(getattr(runner, "_agent", None), "tools", [])
        or getattr(getattr(runner, "agent", None), "tools", [])
        or []
    )
    session_workflow = session_workflow_factory(
        diagrid_workflow_name,
        declared_tools=declared_tools,
    )
    rt.register_workflow(session_workflow, name="session_workflow")
    logger.info(
        "[adk-runner] registered session_workflow → child=%s on shared WorkflowRuntime",
        diagrid_workflow_name,
    )

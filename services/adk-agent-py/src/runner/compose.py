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

from src.constants import AGENT_SLUG, MAX_ITERATIONS

if TYPE_CHECKING:
    from google.adk.agents import LlmAgent

logger = logging.getLogger(__name__)


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
    logger.info(
        "[adk-runner] built DaprWorkflowAgentRunner name=%s diagrid_workflow=%s max_iter=%d",
        name,
        runner.workflow_name,
        MAX_ITERATIONS,
    )
    return runner


def register_session_workflow(runner: DaprWorkflowAgentRunner) -> None:
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
    session_workflow = session_workflow_factory(diagrid_workflow_name)
    rt.register_workflow(session_workflow, name="session_workflow")
    logger.info(
        "[adk-runner] registered session_workflow → child=%s on shared WorkflowRuntime",
        diagrid_workflow_name,
    )

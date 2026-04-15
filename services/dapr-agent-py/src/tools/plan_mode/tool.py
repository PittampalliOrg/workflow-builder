"""Plan mode tools — simplified to no-ops.

Planning is handled at the workflow level via agentConfig.tools filtering,
not via in-agent state transitions. These tools are retained for backward
compatibility but don't change agent behavior.

For planning workflows, configure read-only tools in the workflow spec:
  "agentConfig": { "tools": ["file_read", "glob_search", "grep_search", "bash_run"] }
"""

from __future__ import annotations

from .prompt import get_enter_plan_mode_description, get_exit_plan_mode_description


def enter_plan_mode() -> str:
    """Enter planning mode (no-op — planning is configured at workflow level)."""
    return "Plan mode acknowledged. Focus on exploration and analysis using read-only tools."


def exit_plan_mode(plan: str | None = None) -> str:
    """Exit planning mode and return the plan (no-op — plan is captured as agent output)."""
    if plan and plan.strip():
        return f"Plan recorded:\n\n{plan}"
    return "Plan mode complete."


enter_plan_mode.__doc__ = get_enter_plan_mode_description()
exit_plan_mode.__doc__ = get_exit_plan_mode_description()

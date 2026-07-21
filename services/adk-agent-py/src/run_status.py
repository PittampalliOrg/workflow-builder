"""Platform status contract for durable ADK agent runs."""

from __future__ import annotations

from collections.abc import Callable
from typing import Any, Protocol


class WorkflowStateClient(Protocol):
    def get_workflow_state(
        self,
        instance_id: str,
        *,
        fetch_payloads: bool,
    ) -> Any: ...


class AgentRunNotFoundError(LookupError):
    """Raised when the workflow-state port has no matching run."""


def resolve_agent_run_status(
    instance_id: str,
    *,
    summary: bool,
    app_id: str,
    client_factory: Callable[[], WorkflowStateClient],
) -> dict[str, Any]:
    """Read one workflow instance and normalize the shared runtime contract."""
    state = client_factory().get_workflow_state(
        instance_id,
        fetch_payloads=not summary,
    )
    if state is None:
        raise AgentRunNotFoundError("Agent run not found")

    runtime_status = getattr(
        state.runtime_status,
        "name",
        str(state.runtime_status),
    ).upper()
    payload: dict[str, Any] = {
        "instanceId": instance_id,
        "appId": app_id,
        "runtimeStatus": runtime_status,
        "runtime_status": runtime_status,
        "phase": runtime_status.lower(),
    }
    if not summary:
        payload.update(
            {
                "input": state.serialized_input,
                "outputs": state.serialized_output,
            }
        )
    return payload

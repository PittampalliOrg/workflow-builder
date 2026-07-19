"""Thread-local context for the call_agent tool.

The `call_agent` tool runs inside the `run_tool` activity, which doesn't
have access to the workflow context or the inbound message. But it needs
to know which peer agents the parent is allowed to invoke + which
registry team to look them up in.

`agent_workflow` reads `body.callableAgents` and `body.registryTeam` from
the inbound message and stashes them here keyed by worker thread. The
tool then retrieves them when it's invoked.

Because dapr-agents runs each turn in its own goroutine/thread, we key
by `threading.get_ident()`. When multiple tool calls from the same turn
happen sequentially on the same thread, they all see the same context.
Context is wiped at the end of each activity run.
"""

from __future__ import annotations

import threading
from dataclasses import dataclass, field
from typing import Any


@dataclass
class CallableAgentsContext:
    callable_agents: list[dict[str, Any]] = field(default_factory=list)
    registry_team: str | None = None
    parent_instance_id: str | None = None
    parent_session_id: str | None = None
    workflow_mcp_session_token: str | None = None


_contexts: dict[int, CallableAgentsContext] = {}
_lock = threading.Lock()


def set_callable_agents_context(
    callable_agents: list[dict[str, Any]],
    registry_team: str | None,
    parent_instance_id: str | None,
    parent_session_id: str | None,
    workflow_mcp_session_token: str | None = None,
) -> None:
    ctx = CallableAgentsContext(
        callable_agents=list(callable_agents or []),
        registry_team=registry_team,
        parent_instance_id=parent_instance_id,
        parent_session_id=parent_session_id,
        workflow_mcp_session_token=workflow_mcp_session_token,
    )
    with _lock:
        _contexts[threading.get_ident()] = ctx


def get_callable_agents_context() -> CallableAgentsContext | None:
    with _lock:
        return _contexts.get(threading.get_ident())


def clear_callable_agents_context() -> None:
    with _lock:
        _contexts.pop(threading.get_ident(), None)

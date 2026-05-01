"""Common telemetry attributes attached to every `claude_code.*` span/metric/event.

Port of `utils/telemetryAttributes.ts`. In the Dapr context:
- `session.id` maps to the Dapr workflow instance_id
- `workflow.execution.id` maps to the DB execution id (stashed via
  `set_session_context()` from the `agent_workflow` entry)
- `user.id` / `organization.id` / `user.email` / `user.account_uuid` come from
  the Azure Workload Identity or inbound auth envelope. The fields are
  populated when available and omitted otherwise — same pattern as the TS
  getOauthAccountInfo() path.
"""

from __future__ import annotations

import contextvars
import os
from dataclasses import dataclass
from typing import Any


@dataclass(frozen=True)
class SessionContext:
    instance_id: str = ""
    execution_id: str = ""
    turn: int | None = None
    config_revision: int | None = None
    config_hash: str = ""
    model_spec: str = ""
    llm_component: str = ""
    user_id: str = ""
    organization_id: str = ""
    user_email: str = ""
    user_account_uuid: str = ""
    terminal_type: str = ""


_session_context: contextvars.ContextVar[SessionContext] = contextvars.ContextVar(
    "claude_code_session_context", default=SessionContext()
)

_CARDINALITY_DEFAULTS = {
    "OTEL_METRICS_INCLUDE_SESSION_ID": True,
    "OTEL_METRICS_INCLUDE_VERSION": False,
    "OTEL_METRICS_INCLUDE_ACCOUNT_UUID": True,
}


def _is_env_truthy(raw: str | None) -> bool:
    if raw is None:
        return False
    return raw.strip().lower() in {"1", "true", "yes", "on"}


def _should_include(name: str) -> bool:
    default = _CARDINALITY_DEFAULTS[name]
    raw = os.environ.get(name)
    if raw is None:
        return default
    return _is_env_truthy(raw)


def set_session_context(
    *,
    instance_id: str = "",
    execution_id: str = "",
    turn: int | None = None,
    config_revision: int | None = None,
    config_hash: str | None = "",
    model_spec: str | None = "",
    llm_component: str | None = "",
    user_id: str = "",
    organization_id: str = "",
    user_email: str = "",
    user_account_uuid: str = "",
    terminal_type: str = "",
) -> contextvars.Token:
    """Set per-invocation session context. Returns token to reset later.

    Called at `agent_workflow` entry and `run_tool` activity entry so spans
    and metrics emitted inside carry the right session/execution IDs.
    """
    return _session_context.set(
        SessionContext(
            instance_id=instance_id,
            execution_id=execution_id,
            turn=turn,
            config_revision=config_revision,
            config_hash=config_hash or "",
            model_spec=model_spec or "",
            llm_component=llm_component or "",
            user_id=user_id,
            organization_id=organization_id,
            user_email=user_email,
            user_account_uuid=user_account_uuid,
            terminal_type=terminal_type,
        )
    )


def reset_session_context(token: contextvars.Token) -> None:
    _session_context.reset(token)


def get_session_context() -> SessionContext:
    return _session_context.get()


def get_telemetry_attributes() -> dict[str, Any]:
    """Common attributes for every `claude_code.*` span/metric/event."""
    ctx = _session_context.get()
    attrs: dict[str, Any] = {}

    if ctx.user_id:
        attrs["user.id"] = ctx.user_id

    if _should_include("OTEL_METRICS_INCLUDE_SESSION_ID"):
        if ctx.instance_id:
            attrs["session.id"] = ctx.instance_id
    if ctx.execution_id:
        attrs["workflow.execution.id"] = ctx.execution_id
    if ctx.turn is not None:
        attrs["agent.turn"] = ctx.turn
    if ctx.config_revision is not None:
        attrs["agent.config_revision"] = ctx.config_revision
    if ctx.config_hash:
        attrs["agent.config_hash"] = ctx.config_hash
    if ctx.model_spec:
        attrs["agent.model_spec"] = ctx.model_spec
    if ctx.llm_component:
        attrs["agent.llm_component"] = ctx.llm_component

    if _should_include("OTEL_METRICS_INCLUDE_VERSION"):
        version = os.environ.get("DAPR_AGENT_PY_VERSION") or os.environ.get(
            "APP_VERSION"
        )
        if version:
            attrs["app.version"] = version

    if ctx.organization_id:
        attrs["organization.id"] = ctx.organization_id
    if ctx.user_email:
        attrs["user.email"] = ctx.user_email
    if ctx.user_account_uuid and _should_include("OTEL_METRICS_INCLUDE_ACCOUNT_UUID"):
        attrs["user.account_uuid"] = ctx.user_account_uuid

    if ctx.terminal_type:
        attrs["terminal.type"] = ctx.terminal_type

    return attrs

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
    workflow_id: str = ""
    agent_id: str = ""
    agent_version: int | str | None = None
    agent_slug: str = ""
    agent_app_id: str = ""
    sandbox_name: str = ""
    turn: int | None = None
    config_revision: int | None = None
    config_hash: str = ""
    instruction_hash: str = ""
    model_spec: str = ""
    llm_component: str = ""
    user_id: str = ""
    organization_id: str = ""
    user_email: str = ""
    user_account_uuid: str = ""
    terminal_type: str = ""
    # Phase 3a v2: Prompt Workbench preset bindings carried by the BFF in
    # `agentConfig.promptPresetManifest`. `prompt_version_ids` is the
    # `resource_prompt_versions.id` (PK) per binding; `prompt_version_uris`
    # is the legacy Prompt Registry URI (when present). Both are comma-joined
    # for the span attribute value.
    prompt_version_ids: tuple[str, ...] = ()
    prompt_version_uris: tuple[str, ...] = ()


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
    workflow_id: str = "",
    agent_id: str = "",
    agent_version: int | str | None = None,
    agent_slug: str = "",
    agent_app_id: str = "",
    sandbox_name: str = "",
    turn: int | None = None,
    config_revision: int | None = None,
    config_hash: str | None = "",
    instruction_hash: str | None = "",
    model_spec: str | None = "",
    llm_component: str | None = "",
    user_id: str = "",
    organization_id: str = "",
    user_email: str = "",
    user_account_uuid: str = "",
    terminal_type: str = "",
    prompt_version_ids: tuple[str, ...] | list[str] | None = None,
    prompt_version_uris: tuple[str, ...] | list[str] | None = None,
) -> contextvars.Token:
    """Set per-invocation session context. Returns token to reset later.

    Called at `agent_workflow` entry and `run_tool` activity entry so spans
    and metrics emitted inside carry the right session/execution IDs.
    """
    return _session_context.set(
        SessionContext(
            instance_id=instance_id,
            execution_id=execution_id,
            workflow_id=workflow_id,
            agent_id=agent_id,
            agent_version=agent_version,
            agent_slug=agent_slug,
            agent_app_id=agent_app_id,
            sandbox_name=sandbox_name,
            turn=turn,
            config_revision=config_revision,
            config_hash=config_hash or "",
            instruction_hash=instruction_hash or "",
            model_spec=model_spec or "",
            llm_component=llm_component or "",
            user_id=user_id,
            organization_id=organization_id,
            user_email=user_email,
            user_account_uuid=user_account_uuid,
            terminal_type=terminal_type,
            prompt_version_ids=tuple(prompt_version_ids or ()),
            prompt_version_uris=tuple(prompt_version_uris or ()),
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
    if ctx.workflow_id:
        attrs["workflow.id"] = ctx.workflow_id
    if ctx.agent_id:
        attrs["agent.id"] = ctx.agent_id
    if ctx.agent_version is not None:
        attrs["agent.version"] = ctx.agent_version
    if ctx.agent_slug:
        attrs["agent.slug"] = ctx.agent_slug
    if ctx.agent_app_id:
        attrs["agent.app_id"] = ctx.agent_app_id
    if ctx.sandbox_name:
        attrs["sandbox.name"] = ctx.sandbox_name
    if ctx.turn is not None:
        attrs["agent.turn"] = ctx.turn
    if ctx.config_revision is not None:
        attrs["agent.config_revision"] = ctx.config_revision
    if ctx.config_hash:
        attrs["agent.config_hash"] = ctx.config_hash
    if ctx.instruction_hash:
        attrs["agent.instruction_hash"] = ctx.instruction_hash
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

    # Phase 3a v2: Prompt Workbench preset bindings carried by the BFF.
    # Single-value tags get a comma-joined list when multiple presets are
    # bound (typical: one static + one dynamic). The set is small (<5 in
    # practice), so a flat string remains efficient for ClickHouse filters.
    if ctx.prompt_version_ids:
        attrs["prompt_version_id"] = ",".join(ctx.prompt_version_ids)
    if ctx.prompt_version_uris:
        attrs["prompt_version"] = ",".join(ctx.prompt_version_uris)

    return attrs

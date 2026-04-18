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


# ---------------------------------------------------------------------------
# OpenTelemetry GenAI semantic conventions (dual-emitted alongside `claude_code.*`)
# ---------------------------------------------------------------------------

_GENAI_PROVIDER_BY_PREFIX: tuple[tuple[str, str], ...] = (
    ("claude", "anthropic"),
    ("anthropic", "anthropic"),
    ("gpt", "openai"),
    ("o1", "openai"),
    ("o3", "openai"),
    ("openai", "openai"),
    ("gemini", "google"),
    ("mistral", "mistral"),
    ("llama", "meta"),
    ("nvidia", "nvidia"),
    ("huggingface", "huggingface"),
)


def resolve_genai_provider(model: str | None) -> str | None:
    """Best-effort provider name for GenAI semconv from a model string."""
    if not model:
        return None
    lowered = model.lower()
    for prefix, provider in _GENAI_PROVIDER_BY_PREFIX:
        if prefix in lowered:
            return provider
    return None


def agent_name() -> str:
    return (
        os.environ.get("AGENT_NAME")
        or os.environ.get("DAPR_AGENT_PY_AGENT_NAME")
        or os.environ.get("AGENT_SERVICE_NAME")
        or ""
    )


def build_genai_llm_start_attrs(model: str | None) -> dict[str, Any]:
    """GenAI semconv attrs for an LLM request at span start."""
    attrs: dict[str, Any] = {"gen_ai.operation.name": "chat"}
    if model:
        attrs["gen_ai.request.model"] = model
    provider = resolve_genai_provider(model)
    if provider:
        attrs["gen_ai.provider.name"] = provider
    return attrs


def build_genai_llm_end_attrs(
    *,
    model: str | None = None,
    input_tokens: int | None = None,
    output_tokens: int | None = None,
    cache_read_tokens: int | None = None,
    cache_creation_tokens: int | None = None,
    error: str | None = None,
) -> dict[str, Any]:
    """GenAI semconv attrs for an LLM request at span end."""
    attrs: dict[str, Any] = {}
    if model:
        attrs["gen_ai.response.model"] = model
    if input_tokens is not None:
        attrs["gen_ai.usage.input_tokens"] = input_tokens
    if output_tokens is not None:
        attrs["gen_ai.usage.output_tokens"] = output_tokens
    if cache_read_tokens is not None:
        attrs["gen_ai.usage.cache_read.input_tokens"] = cache_read_tokens
    if cache_creation_tokens is not None:
        attrs["gen_ai.usage.cache_creation.input_tokens"] = cache_creation_tokens
    if error:
        attrs["error.type"] = error
    return attrs


def build_genai_tool_attrs(
    tool_name: str,
    *,
    tool_call_id: str | None = None,
) -> dict[str, Any]:
    attrs: dict[str, Any] = {
        "gen_ai.operation.name": "execute_tool",
        "gen_ai.tool.name": tool_name,
    }
    if tool_call_id:
        attrs["gen_ai.tool.call_id"] = tool_call_id
    return attrs


def build_genai_interaction_attrs() -> dict[str, Any]:
    attrs: dict[str, Any] = {"gen_ai.operation.name": "invoke_agent"}
    name = agent_name()
    if name:
        attrs["gen_ai.agent.name"] = name
    return attrs

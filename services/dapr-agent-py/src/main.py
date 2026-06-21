"""Minimal Python durable agent with hot-reload configuration."""

from __future__ import annotations

import logging
import asyncio
import json
import os
import posixpath
import re
import shlex
import threading
import time
import urllib.parse
import urllib.request
import uuid
from contextlib import asynccontextmanager
from dataclasses import replace
from typing import Any

from fastapi import FastAPI, HTTPException
from fastapi.encoders import jsonable_encoder
from google.protobuf import wrappers_pb2
from pydantic import BaseModel, Field


def _configure_durabletask_grpc_defaults() -> None:
    """Raise durabletask's worker channel limit before any workflow runtime starts."""
    try:
        import dapr.ext.workflow._durabletask.internal.shared as durabletask_shared
    except Exception:
        return
    try:
        max_message_bytes = max(
            1,
            int(os.environ.get("DAPR_WORKFLOW_GRPC_MAX_MESSAGE_BYTES", "16777216")),
        )
    except ValueError:
        max_message_bytes = 16 * 1024 * 1024
    existing = getattr(durabletask_shared, "DEFAULT_GRPC_KEEPALIVE_OPTIONS", ())
    merged = {
        str(key): value
        for key, value in existing
        if isinstance(key, str) and key
    }
    merged.setdefault("grpc.max_receive_message_length", max_message_bytes)
    merged.setdefault("grpc.max_send_message_length", max_message_bytes)
    durabletask_shared.DEFAULT_GRPC_KEEPALIVE_OPTIONS = tuple(merged.items())


_configure_durabletask_grpc_defaults()


def _env_bool(name: str) -> bool | None:
    raw = os.environ.get(name)
    if raw is None:
        return None
    normalized = raw.strip().lower()
    if normalized in {"1", "true", "yes", "on"}:
        return True
    if normalized in {"0", "false", "no", "off"}:
        return False
    return None


# ---------------------------------------------------------------------------
# OpenTelemetry initialization (must happen before FastAPI app creation)
# ---------------------------------------------------------------------------

from src.telemetry import init_telemetry, is_telemetry_ready
from src.telemetry.metrics import init_metrics as _init_claude_code_metrics
from src.benchmark_context import is_swebench_execution_context

_otel_ready = init_telemetry()
if _otel_ready:
    _init_claude_code_metrics()


def _start_checkpoint_span(tool_name: str, tool_call_id: str):
    """Return a context manager for a git-checkpoint span; no-op when OTEL is unavailable."""
    if not is_telemetry_ready():
        from contextlib import nullcontext

        return nullcontext()
    try:
        from opentelemetry import trace

        tracer = trace.get_tracer("dapr-agent-py.checkpoint")
        return tracer.start_as_current_span(
            "capture_code_checkpoint",
            attributes={
                "tool.name": tool_name or "",
                "tool.call_id": tool_call_id or "",
            },
        )
    except Exception:
        from contextlib import nullcontext

        return nullcontext()


# ---------------------------------------------------------------------------
# Agent setup (imported after OTEL so spans are captured)
# ---------------------------------------------------------------------------

from src.tools import all_tools
from src.tools.skill_tool import get_registry as get_skill_registry, load_skills_from_dir, parse_skill_md
from src.tools.skill_tool.models import SkillDefinition
from src.tools.skill_tool.prompt import format_skill_listings
from src.openshell_runtime import (
    DEFAULT_CWD,
    OpenShellRuntime,
    bind_runtime,
    get_runtime,
    reset_runtime,
)
from src.code_checkpoint import (
    capture_code_checkpoint,
    capture_run_diff,
    log_checkpoint_remote_status,
    restore_code_checkpoint,
    should_checkpoint_tool,
)
from src.tool_idempotency import (
    ToolResultCache,
    find_recorded_tool_result,
    tool_idempotency_enabled,
)
from src.capability_compiler import (
    emit_dapr_agent_py,
    safe_skill_segment as _safe_skill_segment,
    skill_package_entries,
)
from src.event_publisher import (
    drive_goal_stop_check,
    get_scoped_session,
    publish_session_event,
    scope_session,
    unscope_session,
)
from src.mcp_retry import connect_mcp_client_with_retries
from src.session_host_monitor import (
    benchmark_activity_age_seconds,
    benchmark_activity_is_recent,
    benchmark_activity_marker,
    decide_missing_workflow_action,
    normalize_nonterminal_timeout_action,
    terminal_hold_seconds_for_status,
    workflow_progress_marker,
)
from src.session_outputs import scan_and_upload as _scan_session_outputs
from src.session_config import (
    TERMINAL_CONTROL_EVENT_TYPES,
    apply_session_control_events,
    external_control_event_as_user_event,
)
from src.session_native import (
    build_continue_as_new_input,
    logical_turn_id,
    session_native_event_fields,
    session_workflow_instance_id,
    session_workflow_state_from_message,
    should_continue_session_as_new,
    terminal_stop_reason_from_events,
)
from src.effective_agent_config import (
    DEFAULT_LLM_COMPONENT,
    build_effective_agent_config,
    effective_audit_fields,
    resolve_llm_metadata,
    runtime_context_audit_cache_fields,
)
from src.runtime_config import (
    SESSION_RUNTIME_CONFIG_EVENT_TYPE,
    build_runtime_config_event,
    runtime_config_state_key,
)
from src.instruction_bundle import (
    assign_canonical_bundle_prompt_template,
    build_instruction_bundle,
    instruction_bundle_audit_payload,
)
from src.hooks import (
    HooksSnapshot,
    execute_notification_hooks,
    execute_post_tool_hooks,
    execute_post_tool_use_failure_hooks,
    execute_pre_tool_hooks,
    execute_session_end_hooks,
    execute_session_start_hooks,
    execute_stop_hooks,
    execute_user_prompt_submit_hooks,
    hooks_enabled,
)
from src.hooks.registry import empty_snapshot
from src.plugins import (
    apply_per_run as _apply_per_run_hooks,
    bootstrap as _bootstrap_hooks_and_plugins,
    clear_instance_snapshot as _clear_hook_snapshot,
    current_snapshot as _current_hook_snapshot,
    install_instance_snapshot as _install_hook_snapshot,
)
from src.dependency_guard import assert_dapr_agents_version

assert_dapr_agents_version()

from dapr_agents.agents.configs import (
    AgentExecutionConfig,
    AgentPubSubConfig,
    AgentRegistryConfig,
    AgentStateConfig,
    RuntimeConfigKey,
    RuntimeSubscriptionConfig,
    ToolExecutionMode,
    WorkflowRetryPolicy,
)
from dapr_agents.agents.schemas import TriggerAction
from dapr_agents.agents.durable import DurableAgent
from dapr_agents.hooks import Hooks as NativeHooks
from dapr_agents.hooks import LLMHookContext, Proceed
from dapr_agents.llm.dapr import DaprChatClient
from dapr_agents.storage.daprstores.stateservice import StateStoreService
from dapr_agents.tool.mcp import MCPClient
from dapr_agents.tool.workflow.agent_tool import AgentWorkflowTool
from dapr_agents.tool.workflow.tool_context import WorkflowContextInjectedTool
from dapr_agents.tool.utils.serialization import serialize_tool_result
from dapr_agents.types import AgentError, DaprWorkflowStatus, ToolMessage
from dapr_agents.workflow.decorators import message_router, workflow_entry
from dapr_agents.workflow.runners import AgentRunner

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s - %(name)s - %(levelname)s - %(message)s",
)
logger = logging.getLogger(__name__)

DEFAULT_MAX_ITERATIONS = int(os.environ.get("DAPR_AGENT_PY_MAX_ITERATIONS", "120"))
# When true, the Stop hook drives an in-process goal evaluation at each real
# turn-end (calls the BFF stop-check) instead of relying solely on the
# fire-and-forget status_idle event + cron backstop. Default off — the idle-loop
# remains the universal mechanism (other runtimes + this one when the flag is off).
GOAL_STOP_HOOK_ENABLED = (
    os.environ.get("DAPR_AGENT_PY_GOAL_STOP_HOOK", "false").lower() == "true"
)
# Circuit breaker: after this many consecutive empty (or failed) LLM
# responses within a single agent_workflow instance, raise to break the
# loop. 3 covers the occasional empty-text-only response while stopping
# runaway retries. See __init__ comment near _empty_llm_response_count_by_instance.
EMPTY_RESPONSE_THRESHOLD = int(
    os.environ.get("DAPR_AGENT_PY_EMPTY_RESPONSE_THRESHOLD", "3")
)
# Absolute cap on a single session event envelope's serialized size. Postgres
# jsonb has no hard limit other than TOAST (~1 GB), but bigger blobs fan out
# into the SSE stream, the consolidation fetch, and the client's in-memory
# buffer. 256 KB comfortably fits a verbose tool response while still letting
# the UI keep 500 events hot without OOM.
_MAX_ENVELOPE_BYTES = int(os.environ.get("DAPR_AGENT_PY_MAX_ENVELOPE_BYTES", "262144"))
_MAX_INSTRUCTION_AUDIT_BYTES = int(
    os.environ.get("DAPR_AGENT_PY_MAX_INSTRUCTION_AUDIT_BYTES", "131072")
)


def _native_llm_hook_logging_enabled() -> bool:
    return (
        _env_bool("DAPR_AGENT_NATIVE_LLM_HOOK_LOGGING_ENABLED")
        or _env_bool("DAPR_AGENT_NATIVE_HOOK_LOGGING_ENABLED")
        or False
    )


def _count_native_hook_items(value: Any) -> int:
    if isinstance(value, (list, tuple)):
        return len(value)
    if isinstance(value, dict):
        return len(value)
    return 0


def _native_llm_debug_payload(
    phase: str,
    ctx: LLMHookContext,
    assistant_message: dict[str, Any] | None = None,
) -> dict[str, Any]:
    payload = ctx.payload if isinstance(ctx.payload, dict) else {}
    messages = payload.get("messages")
    tools = payload.get("tools")
    response_format = payload.get("response_format")
    data: dict[str, Any] = {
        "phase": phase,
        "hook": f"{phase}_llm_call",
        "stepName": ctx.step_name,
        "stepKind": ctx.step_kind,
        "source": ctx.source,
        "messageCount": _count_native_hook_items(messages),
        "toolSchemaCount": _count_native_hook_items(tools),
        "hasToolChoice": payload.get("tool_choice") is not None,
        "responseFormat": (
            getattr(response_format, "__name__", None)
            or (type(response_format).__name__ if response_format is not None else None)
        ),
    }
    if assistant_message is not None:
        content = assistant_message.get("content")
        tool_calls = assistant_message.get("tool_calls")
        data.update(
            {
                "assistantRole": assistant_message.get("role"),
                "assistantContentChars": len(content) if isinstance(content, str) else 0,
                "assistantToolCallCount": _count_native_hook_items(tool_calls),
            }
        )
    return data


def _merge_native_hooks(
    existing: Any,
    *,
    before_llm_call: list[Any],
    after_llm_call: list[Any],
) -> NativeHooks:
    return NativeHooks(
        before_tool_call=list(getattr(existing, "before_tool_call", []) or []),
        after_tool_call=list(getattr(existing, "after_tool_call", []) or []),
        before_llm_call=[
            *list(getattr(existing, "before_llm_call", []) or []),
            *before_llm_call,
        ],
        after_llm_call=[
            *list(getattr(existing, "after_llm_call", []) or []),
            *after_llm_call,
        ],
    )


def _native_tool_hooks_configured(agent_obj: Any) -> bool:
    hooks = getattr(agent_obj, "_hooks", None)
    return bool(
        hooks
        and (
            getattr(hooks, "before_tool_call", None)
            or getattr(hooks, "after_tool_call", None)
        )
    )


def _install_native_llm_debug_hooks(agent_obj: Any) -> None:
    if not _native_llm_hook_logging_enabled():
        agent_obj._native_llm_hook_debug_enabled = False
        return

    def _publish(
        phase: str,
        ctx: LLMHookContext,
        assistant_message: dict[str, Any] | None = None,
    ) -> None:
        try:
            session_id, scoped_instance_id = get_scoped_session()
            instance_id = (
                scoped_instance_id
                or getattr(agent_obj, "_active_llm_instance_id", None)
                or ""
            )
            if not session_id and instance_id:
                session_id = getattr(agent_obj, "_session_id_by_instance", {}).get(
                    instance_id
                )
            if not session_id:
                return
            publish_session_event(
                session_id,
                "dapr_agents.native_llm_hook",
                _native_llm_debug_payload(phase, ctx, assistant_message),
                instance_id=instance_id or session_id,
            )
        except Exception as exc:  # noqa: BLE001
            logger.debug("[native-hooks] LLM hook debug publish failed: %s", exc)

    def _before_llm_call(ctx: LLMHookContext):
        _publish("before", ctx)
        return Proceed()

    def _after_llm_call(ctx: LLMHookContext, assistant_message: Any):
        _publish(
            "after",
            ctx,
            assistant_message if isinstance(assistant_message, dict) else {},
        )
        return Proceed()

    agent_obj._hooks = _merge_native_hooks(
        getattr(agent_obj, "_hooks", None),
        before_llm_call=[_before_llm_call],
        after_llm_call=[_after_llm_call],
    )
    agent_obj._native_llm_hook_debug_enabled = True
    logger.info("[native-hooks] Dapr Agents LLM hook debug logging enabled")


def _json_preview(value: Any, max_chars: int) -> str:
    """JSON-serialize `value` for display, truncated to `max_chars`. If
    the value isn't JSON-serializable, fall back to repr()."""
    try:
        s = json.dumps(value, default=str, ensure_ascii=False)
    except Exception:
        s = repr(value)
    if len(s) > max_chars:
        return s[:max_chars] + "…"
    return s


def _prepare_payload_with_preview(
    value: Any,
    *,
    mode: str,
    preview_len: int,
) -> tuple[Any, bool, int]:
    """Return (payload, oversized, size_bytes) for a session_events data
    value. `mode` is "text" (plain string) or "json" (arbitrary dict). When
    the serialized size exceeds `_MAX_ENVELOPE_BYTES`, payload is None and
    `oversized` is True; the caller substitutes a placeholder.
    """
    try:
        if mode == "text":
            size = len((value or "").encode("utf-8", "ignore")) if isinstance(value, str) else len(
                json.dumps(value, default=str, ensure_ascii=False).encode("utf-8", "ignore")
            )
        else:
            size = len(json.dumps(value, default=str, ensure_ascii=False).encode("utf-8", "ignore"))
    except Exception:
        size = 0
    if size > _MAX_ENVELOPE_BYTES:
        return (None, True, size)
    return (value, False, size)


def _tool_result_error(result: Any) -> str | None:
    """Return a compact error string from tool output that encoded failure."""
    if not isinstance(result, dict):
        return None
    direct = result.get("error")
    if direct:
        return str(direct).strip()[:1000]
    content = result.get("content")
    if isinstance(content, dict):
        raw = content.get("error")
        return str(raw).strip()[:1000] if raw else None
    if not isinstance(content, str):
        return None
    text = content.strip()
    if not text:
        return None
    if text.lower().startswith("error:"):
        return text[:1000]
    if text.startswith("{"):
        try:
            parsed = json.loads(text)
        except (TypeError, ValueError):
            return None
        if isinstance(parsed, dict) and parsed.get("error"):
            return str(parsed["error"]).strip()[:1000]
    return None


def _build_system_prompt(cwd: str, sandbox_name: str | None = None) -> str:
    """Build the system prompt with a structured <env> block.

    Mirrors the pattern from claude-code-src/main/constants/prompts.ts
    (computeSimpleEnvInfo) where the working directory is communicated
    in a structured <env> section of the system prompt.
    """
    env_lines = [f"Working directory: {cwd}"]
    if sandbox_name:
        env_lines.append(f"OpenShell sandbox: {sandbox_name}")
    env_block = "\n".join(env_lines)

    return f"""You are dapr-agent-py, a Dapr DurableAgent that works inside an OpenShell sandbox.

<env>
{env_block}
</env>

All file and command tools operate inside the active OpenShell sandbox, not inside the agent service container.

IMPORTANT -- Working directory:
- Your working directory is shown in the <env> block above.
- All tools resolve relative paths against the working directory. Use RELATIVE paths (e.g. "package.json", "src/app.html") — they automatically resolve to the correct location.
- Do NOT prefix paths with /sandbox/ — just use relative paths from the working directory.
- bash_run commands also execute in the working directory automatically.
- Treat /app as service implementation, not as a user workspace.

The sandbox is policy-governed, so filesystem and network access may be restricted. If a command fails, inspect the concise error and repair the smallest relevant issue before retrying.
"""


# Default system prompt used when no cwd is available yet
OPENSHELL_SYSTEM_PROMPT = _build_system_prompt("/sandbox")

def _coerce_agent_config(value: Any) -> dict[str, Any] | None:
    if isinstance(value, dict):
        return value
    if isinstance(value, str) and value.strip():
        try:
            parsed = json.loads(value)
        except json.JSONDecodeError:
            return None
        return parsed if isinstance(parsed, dict) else None
    return None


def _resolve_llm_component(message: dict, metadata: dict | None = None) -> str:
    """Extract modelSpec from agentConfig, metadata, or message and map to a Dapr component.

    Always returns a deterministic component name. Raises if an explicit
    modelSpec is provided but not found in the supported model map.
    """
    return resolve_llm_metadata(message=message, metadata=metadata or {})["llmComponent"]


def _incoming_instruction_bundle(message: dict[str, Any]) -> dict[str, Any]:
    return _parse_metadata(message.get("instructionBundle"))


def _instruction_prompt_source(message: dict[str, Any]) -> str:
    if message.get("workflowId") or message.get("nodeId") or message.get("autoTerminateAfterEndTurn"):
        return "workflow-node"
    return "session"


def _compose_turn_instruction_bundle(
    *,
    agent_config: dict[str, Any],
    message: dict[str, Any],
    prompt: str,
    cwd: str,
    sandbox_name: str | None,
    platform_system_sections: list[str] | None = None,
    hook_context: str | None = None,
    current_date: str | None = None,
    mcp_instructions: list[str] | None = None,
    control_override_fields: set[str] | None = None,
) -> dict[str, Any]:
    incoming = _incoming_instruction_bundle(message)
    incoming_agent = incoming.get("agent") if isinstance(incoming.get("agent"), dict) else {}
    config_hash = (
        str(incoming_agent.get("configHash")).strip()
        if isinstance(incoming_agent.get("configHash"), str)
        and incoming_agent.get("configHash").strip()
        else None
    )
    return build_instruction_bundle(
        agent_config=agent_config,
        raw_message=message,
        prompt=prompt,
        prompt_source=_instruction_prompt_source(message),
        cwd=cwd,
        sandbox_name=sandbox_name,
        platform_system_sections=platform_system_sections
        if platform_system_sections is not None
        else [_build_system_prompt(cwd, sandbox_name)],
        hook_context=hook_context,
        current_date=current_date,
        mcp_instructions=mcp_instructions,
        agent_id=str(message.get("agentId") or incoming_agent.get("id") or "").strip()
        or None,
        agent_version=_parse_int(message.get("agentVersion"))
        or _parse_int(incoming_agent.get("version")),
        agent_config_hash=config_hash,
        agent_slug=str(message.get("agentSlug") or incoming_agent.get("slug") or "").strip()
        or None,
        control_override_fields=control_override_fields,
    )


def _capture_prompt_state(agent_obj: Any) -> dict[str, Any]:
    helper = getattr(agent_obj, "prompting_helper", None)
    llm = getattr(agent_obj, "llm", None)
    return {
        "profile_role": getattr(agent_obj.profile, "role", None),
        "profile_goal": getattr(agent_obj.profile, "goal", None),
        "profile_instructions": list(getattr(agent_obj.profile, "instructions", None) or []),
        "profile_style_guidelines": list(
            getattr(agent_obj.profile, "style_guidelines", None) or []
        ),
        "profile_system_prompt": getattr(agent_obj.profile, "system_prompt", None),
        "helper_role": getattr(helper, "role", None) if helper is not None else None,
        "helper_goal": getattr(helper, "goal", None) if helper is not None else None,
        "helper_instructions": list(getattr(helper, "instructions", None) or [])
        if helper is not None
        else [],
        "helper_style_guidelines": list(getattr(helper, "style_guidelines", None) or [])
        if helper is not None
        else [],
        "helper_system_prompt": getattr(helper, "system_prompt", None)
        if helper is not None
        else None,
        "helper_prompt_template": getattr(helper, "prompt_template", None)
        if helper is not None
        else None,
        "agent_prompt_template": getattr(agent_obj, "prompt_template", None),
        "llm_prompt_template": getattr(llm, "prompt_template", None)
        if llm is not None
        else None,
        "llm_cache_ttl": getattr(llm, "_cache_ttl", None) if llm is not None else None,
        "llm_cache_key": getattr(llm, "_cache_key", None) if llm is not None else None,
    }


def _apply_instruction_prompt_state(
    agent_obj: Any,
    instruction_bundle: dict[str, Any] | None,
) -> None:
    if not isinstance(instruction_bundle, dict):
        return
    rendered = instruction_bundle.get("rendered")
    persona = instruction_bundle.get("persona")
    if not isinstance(rendered, dict) or not isinstance(persona, dict):
        return
    system_text = str(rendered.get("system") or "").strip()
    if not system_text:
        return
    role = str(persona.get("role") or getattr(agent_obj.profile, "role", "") or "").strip()
    goal = str(persona.get("goal") or getattr(agent_obj.profile, "goal", "") or "").strip()
    instructions = [
        str(item).strip()
        for item in (persona.get("instructions") if isinstance(persona.get("instructions"), list) else [])
        if str(item).strip()
    ]
    style_guidelines = [
        str(item).strip()
        for item in (
            persona.get("styleGuidelines")
            if isinstance(persona.get("styleGuidelines"), list)
            else []
        )
        if str(item).strip()
    ]

    agent_obj.profile.role = role
    agent_obj.profile.goal = goal
    agent_obj.profile.instructions = instructions
    if hasattr(agent_obj.profile, "style_guidelines"):
        agent_obj.profile.style_guidelines = style_guidelines
    agent_obj.profile.system_prompt = system_text

    helper = getattr(agent_obj, "prompting_helper", None)
    if helper is not None:
        helper.role = role
        helper.goal = goal
        helper.instructions = list(instructions)
        helper.style_guidelines = list(style_guidelines)
        helper.system_prompt = system_text

    # Stash cacheTtl on the LLM client so the Anthropic adapter's
    # patched_generate reads it without us having to plumb the bundle
    # through Dapr's chat-client API. Only '5m' / '1h' survive normalization;
    # default in build_instruction_bundle is '5m' so the field is always
    # present even when the agent profile doesn't set it.
    runtime_block = (
        instruction_bundle.get("runtime")
        if isinstance(instruction_bundle.get("runtime"), dict)
        else {}
    )
    raw_cache_ttl = runtime_block.get("cacheTtl")
    cache_ttl = "1h" if raw_cache_ttl == "1h" else "5m"
    # OpenAI prompt_cache_key — pins requests for the same agent profile to
    # the same cache shard. Granularity is per-agent-version. None for
    # ephemeral inline agents; the OpenAI adapter falls back to default
    # routing when the field is absent.
    from src.openai_adapter import derive_openai_cache_key

    openai_cache_key = derive_openai_cache_key(instruction_bundle)
    if getattr(agent_obj, "llm", None) is not None:
        agent_obj.llm._cache_ttl = cache_ttl
        agent_obj.llm._cache_key = openai_cache_key

    assign_canonical_bundle_prompt_template(agent_obj, instruction_bundle)


def _restore_prompt_state(agent_obj: Any, state: dict[str, Any]) -> None:
    agent_obj.profile.role = state.get("profile_role")
    agent_obj.profile.goal = state.get("profile_goal")
    agent_obj.profile.instructions = list(state.get("profile_instructions") or [])
    if hasattr(agent_obj.profile, "style_guidelines"):
        agent_obj.profile.style_guidelines = list(
            state.get("profile_style_guidelines") or []
        )
    agent_obj.profile.system_prompt = state.get("profile_system_prompt")

    helper = getattr(agent_obj, "prompting_helper", None)
    if helper is not None:
        helper.role = state.get("helper_role")
        helper.goal = state.get("helper_goal")
        helper.instructions = list(state.get("helper_instructions") or [])
        helper.style_guidelines = list(state.get("helper_style_guidelines") or [])
        helper.system_prompt = state.get("helper_system_prompt")
        helper.prompt_template = state.get("helper_prompt_template")
    agent_obj.prompt_template = state.get("agent_prompt_template")
    if getattr(agent_obj, "llm", None) is not None:
        agent_obj.llm.prompt_template = state.get("llm_prompt_template")
        # Restore cache_ttl alongside the prompt template so we never leak a
        # previous instance's TTL into the next call_llm activity.
        prior_ttl = state.get("llm_cache_ttl")
        if prior_ttl is None:
            if hasattr(agent_obj.llm, "_cache_ttl"):
                try:
                    delattr(agent_obj.llm, "_cache_ttl")
                except Exception:  # noqa: BLE001
                    agent_obj.llm._cache_ttl = None
        else:
            agent_obj.llm._cache_ttl = prior_ttl
        # Same restore dance for the OpenAI cache_key.
        prior_key = state.get("llm_cache_key")
        if prior_key is None:
            if hasattr(agent_obj.llm, "_cache_key"):
                try:
                    delattr(agent_obj.llm, "_cache_key")
                except Exception:  # noqa: BLE001
                    agent_obj.llm._cache_key = None
        else:
            agent_obj.llm._cache_key = prior_key

# ---------------------------------------------------------------------------
# Hot-reload configuration subscription
# ---------------------------------------------------------------------------


def on_config_change(key: str, value):
    # Operator-level hot reload only. User/session config changes flow through
    # durable session events so replay has a clear source of truth.
    logger.info("[hot-reload] %s = %s", key, value)


config = RuntimeSubscriptionConfig(
    store_name="runtime-config",
    keys=[
        # Profile
        RuntimeConfigKey.AGENT_ROLE,
        RuntimeConfigKey.AGENT_GOAL,
        RuntimeConfigKey.AGENT_INSTRUCTIONS,
        RuntimeConfigKey.AGENT_STYLE_GUIDELINES,
        RuntimeConfigKey.AGENT_SYSTEM_PROMPT,
        # Execution
        RuntimeConfigKey.MAX_ITERATIONS,
        RuntimeConfigKey.TOOL_CHOICE,
        # LLM
        RuntimeConfigKey.LLM_MODEL,
        RuntimeConfigKey.LLM_PROVIDER,
        RuntimeConfigKey.LLM_API_KEY,
    ],
    on_config_change=on_config_change,
)

# ---------------------------------------------------------------------------
# Infrastructure configs
# ---------------------------------------------------------------------------

AGENT_SERVICE_NAME = os.environ.get("AGENT_SERVICE_NAME", "dapr-agent-py")
AGENT_STATE_STORE = os.environ.get("AGENT_STATE_STORE", "dapr-agent-py-statestore")
AGENT_STATE_KEY_PREFIX = os.environ.get(
    "AGENT_STATE_KEY_PREFIX", f"{AGENT_SERVICE_NAME}:_workflow"
)
AGENT_MEMORY_KEY_PREFIX = os.environ.get(
    "AGENT_MEMORY_KEY_PREFIX", f"{AGENT_SERVICE_NAME}:_memory"
)
AGENT_PUBSUB_NAME = os.environ.get("DAPR_PUBSUB_NAME", "pubsub")
AGENT_TOPIC = os.environ.get("AGENT_TOPIC", f"{AGENT_SERVICE_NAME}.requests")
AGENT_BROADCAST_TOPIC = os.environ.get(
    "AGENT_BROADCAST_TOPIC", f"{AGENT_SERVICE_NAME}.broadcast"
)

state_config = AgentStateConfig(
    store=StateStoreService(store_name=AGENT_STATE_STORE)
)

pubsub_config = AgentPubSubConfig(
    pubsub_name=AGENT_PUBSUB_NAME,
    agent_topic=AGENT_TOPIC,
    broadcast_topic=AGENT_BROADCAST_TOPIC,
)

registry_config = AgentRegistryConfig(
    store=StateStoreService(
        store_name=os.environ.get("AGENT_REGISTRY_STORE", "agent-registry")
    ),
    team_name=os.environ.get("AGENT_REGISTRY_TEAM", "default"),
)

# ---------------------------------------------------------------------------
# Agent instance
# ---------------------------------------------------------------------------


def _parse_metadata(value: Any) -> dict[str, Any]:
    if isinstance(value, dict):
        return value
    if isinstance(value, str) and value.strip():
        try:
            parsed = json.loads(value)
        except json.JSONDecodeError:
            return {}
        return parsed if isinstance(parsed, dict) else {}
    return {}


def _extract_code_checkpoint_restore(
    message: dict[str, Any],
    metadata: dict[str, Any],
) -> dict[str, Any]:
    for value in (
        message.get("codeCheckpointRestore"),
        metadata.get("codeCheckpointRestore"),
        metadata.get("code_checkpoint_restore"),
    ):
        parsed = _parse_metadata(value)
        if parsed:
            return parsed
    return {}


def _parse_int(value: Any) -> int | None:
    if isinstance(value, bool) or value is None:
        return None
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        return None
    return parsed if parsed > 0 else None


def _save_plan_to_state(execution_id: str, plan_content: str) -> None:
    """Save plan content to Dapr state store at a well-known key.

    Mirrors Claude Code's pattern of persisting plans to disk
    (~/.claude/plans/{slug}.md), adapted for Dapr state store.
    The plan can be retrieved by the UI via: GET /v1.0/state/{store}/plan:{id}
    """
    sidecar = (
        f"http://{os.environ.get('DAPR_HOST', '127.0.0.1')}:"
        f"{os.environ.get('DAPR_HTTP_PORT', '3500')}"
    )
    store = AGENT_STATE_STORE
    key = f"plan:{execution_id}"
    payload = json.dumps([{
        "key": key,
        "value": json.dumps({"plan": plan_content, "file": "PLAN.md"}),
    }]).encode()
    req = urllib.request.Request(
        f"{sidecar}/v1.0/state/{store}",
        data=payload,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    urllib.request.urlopen(req, timeout=5)


def _runtime_context_state_key(instance_id: str) -> str:
    return f"runtime-context:{instance_id}"


def _session_cancel_state_key(instance_id: str) -> str:
    return f"session-cancel:{instance_id}"


def _runtime_context_candidate_ids(instance_id: str) -> list[str]:
    """Return context lookup keys for a durable activity instance id.

    Dapr Agent activity payloads can scope work to a turn id such as
    ``<workflow-instance>:turn-1`` while the runtime context is seeded once
    under the base workflow instance id. Prefer the exact key, then fall back
    to the base id so turn-scoped activities keep the selected model, sandbox,
    and allowed-tool context.
    """
    text = str(instance_id or "").strip()
    if not text:
        return []
    candidates = [text]
    base = re.sub(r":turn-\d+$", "", text)
    if base and base != text:
        candidates.append(base)
    return candidates


def _cancellation_candidate_ids(instance_id: str) -> list[str]:
    """Cancellation-flag lookup keys for a durable instance id.

    The raise-event endpoint writes ``session-cancel:{session_instance}``, but in
    auto-terminate (durable/run) mode the inner ``agent_workflow`` runs under a
    turn-scoped id ``<session>__turn__N`` (and some activity payloads use
    ``<session>:turn-N``). Check the exact key first, then fall back to the base
    session id so a mid-turn ``user.interrupt`` / ``session.terminate`` actually
    halts workflow-driven runs (previously the write/read keys never matched).
    """
    text = str(instance_id or "").strip()
    if not text:
        return []
    ids = [text]
    base = re.sub(r"__turn__\d+$", "", text)
    base = re.sub(r":turn-\d+$", "", base)
    if base and base != text and base not in ids:
        ids.append(base)
    return ids


def _save_agent_state_key(key: str, value: Any) -> None:
    sidecar = (
        f"http://{os.environ.get('DAPR_HOST', '127.0.0.1')}:"
        f"{os.environ.get('DAPR_HTTP_PORT', '3500')}"
    )
    store = AGENT_STATE_STORE
    encoded_key = urllib.parse.quote(key, safe="")
    payload = json.dumps(
        [{"key": key, "value": value, "metadata": {"partitionKey": encoded_key}}]
    ).encode("utf-8")
    req = urllib.request.Request(
        f"{sidecar}/v1.0/state/{store}",
        data=payload,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    urllib.request.urlopen(req, timeout=5)


def _save_session_cancellation_request(
    instance_id: str,
    event_name: str,
    payload: Any,
) -> None:
    event: dict[str, Any] = {"type": event_name}
    if isinstance(payload, dict):
        event.update(payload)
    else:
        event["data"] = payload
    _save_agent_state_key(_session_cancel_state_key(instance_id), event)


def _cancelled_agent_result(cancel_request: dict[str, Any]) -> dict[str, Any]:
    stop_reason = terminal_stop_reason_from_events([cancel_request]) or {
        "type": "terminated"
    }
    reason = str(
        cancel_request.get("reason")
        or stop_reason.get("reason")
        or "session cancelled"
    )
    return {
        "role": "assistant",
        "content": reason,
        "success": False,
        "cancelled": True,
        "error": reason,
        "stop_reason": stop_reason,
    }


def _clean_runtime_context(value: dict[str, Any]) -> dict[str, Any]:
    context: dict[str, Any] = {}
    agent_config = value.get("agentConfig") if isinstance(value.get("agentConfig"), dict) else {}
    effective_config = (
        value.get("effectiveAgentConfig")
        if isinstance(value.get("effectiveAgentConfig"), dict)
        else {}
    )
    instruction_bundle = (
        value.get("instructionBundle")
        if isinstance(value.get("instructionBundle"), dict)
        else {}
    )
    instruction_agent = (
        instruction_bundle.get("agent")
        if isinstance(instruction_bundle.get("agent"), dict)
        else {}
    )
    for key in (
        "executionId",
        "workflowId",
        "workflowExecutionId",
        "workflowActivityCorrelationId",
        "nodeId",
        "nodeName",
        "agentId",
        "agentVersion",
        "agentSlug",
        "agentAppId",
        "agentRuntime",
        "sandboxName",
        "cwd",
        "sessionId",
        "mlflowSessionId",
        "mlflowExperimentId",
        "mlflowTraceExperimentId",
        "mlflowRunId",
        "mlflowParentRunId",
        "mlflowActiveModelId",
        "mlflowActiveModelUri",
        "turnId",
        "workspaceRef",
        "llmComponent",
        "modelSpec",
        "provider",
        "providerModel",
        "configHash",
        "instructionHash",
        "systemPrompt",
        "permissionMode",
        "maxIterations",
        "maxTurns",
        "agentWorkflowMode",
    ):
        raw = value.get(key)
        if raw is None:
            context[key] = None
            continue
        text = str(raw).strip()
        context[key] = text or None
    fallback_fields = {
        "workflowId": value.get("workflow_id"),
        "workflowExecutionId": value.get("workflow_execution_id") or value.get("dbExecutionId"),
        "workflowActivityCorrelationId": value.get("workflow_activity_correlation_id"),
        "nodeId": value.get("workflowNodeId") or value.get("workflow_node_id"),
        "nodeName": value.get("workflowNodeName") or value.get("workflow_node_name"),
        "agentId": instruction_agent.get("id") or effective_config.get("id") or agent_config.get("id"),
        "agentVersion": instruction_agent.get("version")
        or effective_config.get("version")
        or agent_config.get("version"),
        "agentSlug": instruction_agent.get("slug")
        or effective_config.get("slug")
        or agent_config.get("slug"),
        "agentAppId": agent_config.get("agentAppId")
        or os.environ.get("APP_ID")
        or os.environ.get("DAPR_APP_ID"),
    }
    for key, raw in fallback_fields.items():
        if context.get(key) is not None or raw is None:
            continue
        text = str(raw).strip()
        context[key] = text or None
    allowed_tools = _normalize_allowed_tool_set(
        value.get("allowedTools") or value.get("allowed_tools")
    )
    if allowed_tools:
        context["allowedTools"] = sorted(allowed_tools)
    if isinstance(value.get("effectiveAgentConfig"), dict):
        context["effectiveAgentConfig"] = value["effectiveAgentConfig"]
        for key, audit_value in effective_audit_fields(value["effectiveAgentConfig"]).items():
            if context.get(key) is None:
                context[key] = audit_value
    if isinstance(value.get("instructionBundle"), dict):
        context["instructionBundle"] = value["instructionBundle"]
        rendered = value["instructionBundle"].get("rendered")
        if isinstance(rendered, dict) and isinstance(rendered.get("system"), str):
            context["systemPrompt"] = rendered["system"]
    if isinstance(value.get("mlflowContext"), dict):
        context["mlflowContext"] = value["mlflowContext"]
    for int_key in ("turn", "configRevision"):
        raw_int = value.get(int_key)
        if isinstance(raw_int, bool) or raw_int is None:
            continue
        try:
            context[int_key] = int(raw_int)
        except (TypeError, ValueError):
            continue
    context["cwd"] = context.get("cwd") or DEFAULT_CWD
    return context


def _runtime_context_audit_fields(context: dict[str, Any] | None) -> dict[str, Any]:
    if not isinstance(context, dict):
        return {}
    snapshot = context.get("effectiveAgentConfig")
    if isinstance(snapshot, dict):
        return effective_audit_fields(snapshot)
    out: dict[str, Any] = {}
    for key in (
        "turn",
        "configRevision",
        "configHash",
        "instructionHash",
        "templateName",
        "templateHash",
        "modelSpec",
        "llmComponent",
        "providerModel",
    ):
        value = context.get(key)
        if value is not None:
            out[key] = value
    return out


def _telemetry_context_kwargs(context: dict[str, Any] | None) -> dict[str, Any]:
    audit = _runtime_context_audit_fields(context)
    if not isinstance(context, dict):
        context = {}
    mlflow_context = (
        context.get("mlflowContext")
        if isinstance(context.get("mlflowContext"), dict)
        else {}
    )
    return {
        "workflow_id": context.get("workflowId"),
        "workflow_node_id": context.get("nodeId"),
        "workflow_node_name": context.get("nodeName"),
        "agent_id": context.get("agentId"),
        "agent_version": context.get("agentVersion"),
        "agent_slug": context.get("agentSlug"),
        "agent_app_id": context.get("agentAppId"),
        "sandbox_name": context.get("sandboxName"),
        "workspace_ref": context.get("workspaceRef"),
        "dapr_component": context.get("llmComponent")
        or context.get("agentAppId")
        or os.environ.get("APP_ID")
        or os.environ.get("DAPR_APP_ID"),
        "turn": audit.get("turn"),
        "config_revision": audit.get("configRevision"),
        "config_hash": audit.get("configHash"),
        "instruction_hash": audit.get("instructionHash"),
        "model_spec": audit.get("modelSpec"),
        "llm_component": audit.get("llmComponent"),
        "mlflow_model_id": context.get("mlflowActiveModelId")
        or mlflow_context.get("activeModelId"),
        "mlflow_model_uri": context.get("mlflowActiveModelUri")
        or mlflow_context.get("activeModelUri"),
        "mlflow_experiment_id": context.get("mlflowTraceExperimentId")
        or context.get("mlflowExperimentId")
        or mlflow_context.get("traceExperimentId")
        or mlflow_context.get("experimentId"),
        "mlflow_run_id": context.get("mlflowRunId") or mlflow_context.get("runId"),
        "mlflow_parent_run_id": context.get("mlflowParentRunId")
        or mlflow_context.get("parentRunId"),
        "mlflow_session_id": context.get("mlflowSessionId")
        or mlflow_context.get("mlflowSessionId")
        or context.get("sessionId"),
        "turn_id": context.get("turnId") or mlflow_context.get("turnId"),
        "workflow_trace_group_id": context.get("workflowTraceGroupId")
        or context.get("workflowExecutionId")
        or mlflow_context.get("traceGroupId"),
    }


def _sandbox_name_from_workspace_ref(workspace_ref: str | None) -> str | None:
    if not workspace_ref:
        return None
    normalized = workspace_ref.strip()
    if not normalized.startswith("ws_"):
        return None
    return "ws-" + normalized[3:].replace("_", "-").lower()


def _normalize_tool_lookup_name(name: str) -> str:
    return str(name or "").lower().replace(" ", "").replace("_", "")


_BUILTIN_TOOL_ALIASES: dict[str, tuple[str, ...]] = {
    _normalize_tool_lookup_name("execute_command"): ("Bash",),
    _normalize_tool_lookup_name("bash"): ("Bash",),
    _normalize_tool_lookup_name("read_file"): ("Read",),
    _normalize_tool_lookup_name("read"): ("Read",),
    _normalize_tool_lookup_name("write_file"): ("Write",),
    _normalize_tool_lookup_name("write"): ("Write",),
    _normalize_tool_lookup_name("edit_file"): ("Edit",),
    _normalize_tool_lookup_name("edit"): ("Edit",),
    _normalize_tool_lookup_name("list_files"): ("Glob",),
    _normalize_tool_lookup_name("glob_files"): ("Glob",),
    _normalize_tool_lookup_name("glob"): ("Glob",),
    _normalize_tool_lookup_name("grep_search"): ("Grep",),
    _normalize_tool_lookup_name("grep"): ("Grep",),
    _normalize_tool_lookup_name("web_search"): ("WebSearch",),
    _normalize_tool_lookup_name("web_fetch"): ("WebFetch",),
    _normalize_tool_lookup_name("notebook_edit"): ("NotebookEdit",),
    _normalize_tool_lookup_name("todo_write"): ("TodoWrite",),
    _normalize_tool_lookup_name("task_output"): ("TaskOutput",),
    _normalize_tool_lookup_name("task_stop"): ("TaskStop",),
    _normalize_tool_lookup_name("ask_user"): ("AskUser",),
    _normalize_tool_lookup_name("send_message"): ("SendMessage",),
    _normalize_tool_lookup_name("skill"): ("Skill",),
    _normalize_tool_lookup_name("agent"): ("Agent",),
    _normalize_tool_lookup_name("call_agent"): ("CallAgent",),
    _normalize_tool_lookup_name("list_mcp_resources"): ("ListMcpResources",),
    _normalize_tool_lookup_name("read_mcp_resource"): ("ReadMcpResource",),
    _normalize_tool_lookup_name("read_session_events"): ("ReadSessionEvents",),
}


def _normalize_allowed_tool_set(raw_tools: Any) -> set[str]:
    if not isinstance(raw_tools, list):
        return set()
    allowed: set[str] = set()
    for item in raw_tools:
        if not isinstance(item, str) or not item.strip():
            continue
        raw_name = item.strip()
        raw_lookup = _normalize_tool_lookup_name(raw_name)
        allowed.add(raw_lookup)
        for alias in _BUILTIN_TOOL_ALIASES.get(raw_lookup, ()):
            allowed.add(_normalize_tool_lookup_name(alias))
    return allowed


def _allowed_tools_from_agent_config(agent_config: dict[str, Any]) -> set[str]:
    raw_tools = agent_config.get("tools") or agent_config.get("allowedTools")
    return _normalize_allowed_tool_set(raw_tools)


# MCP server-name normalization + in-cluster URL qualification moved to the
# shared capability compiler (services/shared/capability_compiler/normalize.py,
# vendored to src/capability_compiler/); _extract_mcp_server_configs delegates
# to capability_compiler.mcp.emit_dapr_agent_py.


def _extract_mcp_server_configs(
    message: dict[str, Any],
) -> tuple[dict[str, dict[str, Any]], dict[str, set[str]]]:
    """Delegate to the shared capability compiler (byte-identical emit).

    The ``agentConfig`` coerce + invalid-JSON warning stay here (the call-site
    contract); the MCP translation itself lives in the vendored
    :func:`capability_compiler.mcp.emit_dapr_agent_py`.
    """
    agent_config = _coerce_agent_config(message.get("agentConfig"))
    if message.get("agentConfig") and not isinstance(agent_config, dict):
        logger.warning("[mcp] Skipping invalid JSON agentConfig")
    return emit_dapr_agent_py(agent_config)


def _extract_skill_configs(
    message: dict[str, Any],
) -> list[SkillDefinition]:
    """Extract skill definitions from ``agentConfig.skills``.

    Mirrors :func:`_extract_mcp_server_configs` for skill configuration
    passed via workflow trigger messages.
    """
    agent_config = message.get("agentConfig")
    if isinstance(agent_config, str) and agent_config.strip():
        try:
            agent_config = json.loads(agent_config)
        except json.JSONDecodeError:
            return []
    if not isinstance(agent_config, dict):
        return []
    raw_skills = agent_config.get("skills")
    if not isinstance(raw_skills, list):
        return []

    skills: list[SkillDefinition] = []
    for item in raw_skills:
        if not isinstance(item, dict):
            continue
        name = str(item.get("name") or "").strip()
        if not name:
            continue
        prompt = str(item.get("prompt") or "").strip()
        if not prompt:
            logger.warning("[skills] Skipping skill '%s' with empty prompt", name)
            continue
        allowed_tools_raw = item.get("allowed_tools") or item.get("allowedTools") or []
        allowed_tools = tuple(
            str(t).strip() for t in allowed_tools_raw if str(t).strip()
        ) if isinstance(allowed_tools_raw, list) else ()
        arguments_raw = item.get("arguments") or []
        arguments = tuple(
            str(a).strip() for a in arguments_raw if str(a).strip()
        ) if isinstance(arguments_raw, list) else ()
        package_files = _extract_skill_package_file_paths(item)
        skills.append(SkillDefinition(
            name=name,
            description=str(item.get("description") or ""),
            prompt=prompt,
            source="agentConfig",
            when_to_use=str(item.get("when_to_use") or item.get("whenToUse") or ""),
            allowed_tools=allowed_tools,
            arguments=arguments,
            argument_hint=str(item.get("argument_hint") or item.get("argumentHint") or ""),
            model_override=str(
                item.get("model")
                or item.get("modelOverride")
                or item.get("model_override")
                or ""
            ),
            user_invocable=bool(item.get("user_invocable", item.get("userInvocable", True))),
            disable_model_invocation=bool(
                item.get("disable_model_invocation", item.get("disableModelInvocation", False))
            ),
            package_files=package_files,
        ))
    return skills


def _extract_raw_skill_items(message: dict[str, Any]) -> list[dict[str, Any]]:
    agent_config = message.get("agentConfig")
    if isinstance(agent_config, str) and agent_config.strip():
        try:
            agent_config = json.loads(agent_config)
        except json.JSONDecodeError:
            return []
    if not isinstance(agent_config, dict):
        return []
    raw_skills = agent_config.get("skills")
    if not isinstance(raw_skills, list):
        return []
    return [item for item in raw_skills if isinstance(item, dict)]


def _extract_runtime_skill_refs(message: dict[str, Any]) -> list[dict[str, str]]:
    refs: list[dict[str, str]] = []
    for item in _extract_raw_skill_items(message):
        source = str(
            item.get("installSource")
            or item.get("sourceRepo")
            or item.get("source")
            or ""
        ).strip()
        skill_name = str(item.get("skillName") or item.get("name") or "").strip()
        if not source or not skill_name:
            continue
        source = re.sub(r"^https://github\.com/", "", source).strip("/")
        source = re.sub(r"^https://skills\.sh/", "", source).strip("/")
        if not re.match(r"^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$", source):
            logger.warning("[skills] Skipping skill with invalid install source: %s", source)
            continue
        if not re.match(r"^[A-Za-z0-9_. -]+$", skill_name):
            logger.warning("[skills] Skipping skill with invalid skill name: %s", skill_name)
            continue
        install_agent = str(item.get("installAgent") or "universal").strip() or "universal"
        allowed_tools_raw = item.get("allowedTools") or item.get("allowed_tools") or []
        allowed_tools = ",".join(
            str(tool).strip()
            for tool in (allowed_tools_raw if isinstance(allowed_tools_raw, list) else [])
            if str(tool).strip()
        )
        refs.append(
            {
                "source": source,
                "skill": skill_name,
                "install_agent": install_agent,
                "allowed_tools": allowed_tools,
            }
        )
    return refs


def _runtime_skill_run_dir(instance_id: str) -> str:
    return f"/sandbox/.workflow-builder/skill-runs/{_safe_skill_segment(instance_id or 'instance')}"


def _scan_runtime_skill_install_root(
    runtime,
    install_root: str,
    refs: list[dict[str, str]],
) -> list[SkillDefinition]:
    scan = runtime.run_python(
        """
import json, pathlib, sys
root = pathlib.Path(json.loads(sys.stdin.read())["root"])
items = []
for path in sorted(root.rglob("SKILL.md")):
    parts = set(path.parts)
    if "node_modules" in parts or ".git" in parts:
        continue
    try:
        items.append({
            "name": path.parent.name,
            "path": str(path),
            "package_path": str(path.parent),
            "content": path.read_text(encoding="utf-8"),
        })
    except Exception as exc:
        items.append({"name": path.parent.name, "path": str(path), "error": str(exc)})
print(json.dumps({"ok": True, "items": items}))
        """.strip(),
        {"root": install_root},
        timeout_seconds=60,
    )
    if not scan.get("ok"):
        raise RuntimeError(f"Failed to scan installed skills: {scan.get('output') or scan.get('error')}")
    try:
        payload = json.loads(scan.get("stdout") or "{}")
    except json.JSONDecodeError as exc:
        raise RuntimeError(f"Failed to parse installed skill scan: {exc}") from exc

    allowed_by_name = {
        ref["skill"]: tuple(part for part in ref.get("allowed_tools", "").split(",") if part)
        for ref in refs
    }
    loaded: list[SkillDefinition] = []
    for item in payload.get("items") or []:
        if not isinstance(item, dict) or not item.get("content"):
            continue
        fallback_name = str(item.get("name") or "skill")
        skill = parse_skill_md(str(item["content"]), name=fallback_name, source="agentConfig")
        allowed_tools = (
            allowed_by_name.get(skill.name)
            or allowed_by_name.get(fallback_name)
            or skill.allowed_tools
        )
        loaded.append(
            replace(
                skill,
                allowed_tools=allowed_tools,
                package_path=str(item.get("package_path") or ""),
                package_files=("SKILL.md",),
            )
        )
    return loaded


def _install_runtime_skill_refs(runtime, instance_id: str, refs: list[dict[str, str]]) -> list[SkillDefinition]:
    if not refs:
        return []
    install_root = _runtime_skill_run_dir(instance_id)
    for ref in refs:
        source_arg = f"{ref['source']}@{ref['skill']}"
        command = (
            f"mkdir -p {shlex.quote(install_root)} && "
            f"cd {shlex.quote(install_root)} && "
            "export SSL_CERT_FILE=${SSL_CERT_FILE:-/etc/ssl/certs/ca-certificates.crt} && "
            "export GIT_SSL_CAINFO=${GIT_SSL_CAINFO:-$SSL_CERT_FILE} && "
            f"npx --yes skills@1.5.0 add {shlex.quote(source_arg)} "
            f"--agent {shlex.quote(ref['install_agent'])} --copy --yes"
        )
        result = runtime.execute(command, timeout_seconds=180)
        if not result.get("ok"):
            raise RuntimeError(
                f"Failed to install skill {source_arg}: "
                f"{result.get('output') or result.get('error') or 'unknown error'}"
            )
        logger.info("[skills] Installed runtime skill %s into %s", source_arg, install_root)

    loaded = _scan_runtime_skill_install_root(runtime, install_root, refs)
    if not loaded:
        requested = ", ".join(f"{ref['source']}@{ref['skill']}" for ref in refs)
        raise RuntimeError(
            f"Installed runtime skill reference(s), but no SKILL.md files were loaded from "
            f"{install_root}: {requested}"
        )
    return loaded


def _extract_skill_package_entries(item: dict[str, Any]) -> list[dict[str, str]]:
    # Skill caps + path sanitization moved to the shared capability compiler
    # (services/shared/capability_compiler/skills.py). Delegates byte-identical
    # (str-only entries); the runtime.write_text loop + SkillDefinition coupling
    # stay below in _materialize_instance_skill_packages.
    return skill_package_entries(item)


def _extract_skill_package_file_paths(item: dict[str, Any]) -> tuple[str, ...]:
    return tuple(entry["path"] for entry in _extract_skill_package_entries(item))


def _materialize_instance_skill_packages(
    runtime,
    skills: list[SkillDefinition],
    instance_id: str,
    raw_skill_items: list[dict[str, Any]],
    *,
    write_files: bool,
) -> list[SkillDefinition]:
    """Write imported skill package files into the active sandbox.

    Imported skills may include references, scripts, or examples next to
    SKILL.md. The agent receives those files through agentConfig rather than
    through the image, so they need to be materialized into the current
    OpenShell workspace before the Skill tool advertises them.
    """
    updated: list[SkillDefinition] = []
    safe_instance = _safe_skill_segment(instance_id or "instance")
    items_by_name = {
        str(item.get("name") or "").strip(): item
        for item in raw_skill_items
        if isinstance(item, dict)
    }
    for skill in skills:
        item = items_by_name.get(skill.name) or {}
        package_entries = _extract_skill_package_entries(item)
        if not package_entries:
            updated.append(skill)
            continue
        package_dir = f"/sandbox/.workflow-builder/skills/{safe_instance}/{_safe_skill_segment(skill.name)}"
        if write_files:
            for entry in package_entries:
                target_path = posixpath.join(package_dir, entry["path"])
                result = runtime.write_text(target_path, entry["content"])
                if not result.get("ok"):
                    logger.warning(
                        "[skills] Failed to materialize %s for skill %s: %s",
                        entry["path"],
                        skill.name,
                        result.get("error") or result.get("output"),
                    )
            logger.info(
                "[skills] Materialized %d package file(s) for skill %s at %s",
                len(package_entries),
                skill.name,
                package_dir,
            )
        updated.append(
            replace(
                skill,
                package_path=package_dir,
                package_files=tuple(entry["path"] for entry in package_entries),
            )
        )
    return updated


class OpenShellDurableAgent(DurableAgent):
    """DurableAgent wrapper that targets the requested OpenShell sandbox."""

    # Execution context stashed by agent_workflow for activity overrides
    _exec_id: str | None = None
    _inst_id: str | None = None
    _active_llm_instance_id: str | None = None

    def __init__(self, *args: Any, **kwargs: Any) -> None:
        super().__init__(*args, **kwargs)
        self._mcp_configs_by_instance: dict[str, dict[str, dict[str, Any]]] = {}
        self._mcp_clients_by_instance: dict[str, MCPClient] = {}
        self._mcp_config_hash_by_instance: dict[str, str] = {}
        self._mcp_tools_by_instance: dict[str, dict[str, Any]] = {}
        self._allowed_tools_by_instance: dict[str, set[str]] = {}
        # Parallel to _mcp_tools_by_instance — maps the same normalized tool
        # lookup key to {server_name, transport} so run_tool can emit
        # mcp.tool_call events with the source server + transport without
        # re-scanning the MCPClient at call time.
        self._mcp_tool_sources_by_instance: dict[str, dict[str, dict[str, str]]] = {}
        self._mcp_allowed_tools_by_instance: dict[str, dict[str, set[str]]] = {}
        self._skills_by_instance: dict[str, list[SkillDefinition]] = {}
        self._workspace_ref_by_instance: dict[str, str] = {}
        # Per-instance session id: populated when session_workflow spawns
        # agent_workflow as a child. Activities thread it into
        # publish_session_event so every agent event lands in session_events.
        self._session_id_by_instance: dict[str, str] = {}
        self._execution_id_by_instance: dict[str, str] = {}
        self._openshell_context_by_instance: dict[str, dict[str, Any]] = {}
        self._agent_context_by_instance: dict[str, dict[str, Any]] = {}
        self._agent_context_lock = threading.RLock()
        self._runtime_config_by_instance: dict[str, dict[str, Any]] = {}
        self._runtime_config_by_session: dict[str, dict[str, Any]] = {}
        # Hooks/plugins: populated by plugins.integration.bootstrap(agent) at
        # service boot. Defaults keep the attributes safe to touch even when
        # DAPR_AGENT_PY_HOOKS_ENABLED=false.
        self._hook_registry = None
        self._plugin_registry = None
        self._base_hooks_snapshot: HooksSnapshot = empty_snapshot()
        self._hooks_snapshot_by_instance: dict[str, HooksSnapshot] = {}
        self._cwd_by_instance: dict[str, str] = {}
        # Compaction: per-instance resolved config + monotonic call_llm counter
        # used as the turn_index for idempotency markers.
        from src.compaction import CompactionConfig

        self._compaction_cfg_by_instance: dict[str, CompactionConfig] = {}
        self._compaction_call_count_by_instance: dict[str, int] = {}
        self._compaction_runs_by_instance: dict[str, int] = {}
        # Per-instance claude_code.interaction span handles (telemetry).
        # Populated on the first non-replay tick; ended in the workflow's
        # try/finally on non-replay ticks only.
        self._interaction_span_by_instance: dict[str, Any] = {}
        self._interaction_ctx_token_by_instance: dict[str, Any] = {}
        # Empty-response circuit breaker: tracks consecutive LLM invocations
        # that returned empty content AND no tool_calls (or failed outright),
        # per workflow instance. After EMPTY_RESPONSE_THRESHOLD consecutive
        # empties, call_llm raises to break agent_workflow out of a stuck
        # loop — mirrors the thinking-only-no-tool-use pattern documented
        # in anthropics/anthropic-sdk-python#1204 (Opus 4.7 + adaptive
        # thinking + tools occasionally emits stop_reason=end_turn with an
        # empty text block and no tool_use).
        self._empty_llm_response_count_by_instance: dict[str, int] = {}
        # Phase B — lifecycle metrics. Counters are incremented per call_llm /
        # run_tool from inside their durable activities (so values survive
        # replay). Final values are emitted as `instance.metrics_summary` from
        # terminal success/error paths, gated on `not ctx.is_replaying`.
        # turn_count = number of LLM calls. tool_call_count = number of
        # tool invocations. tool_histogram = {tool_name: count}.
        # termination_reason starts as None; a non-None value is set at each
        # AgentError/timeout/cancel site BEFORE the raise. If still None at
        # terminal emission time, we infer end_turn or max_iters by comparing
        # turn_count to max_iterations.
        self._turn_count_by_instance: dict[str, int] = {}
        self._tool_call_count_by_instance: dict[str, int] = {}
        self._tool_histogram_by_instance: dict[str, dict[str, int]] = {}
        self._termination_reason_by_instance: dict[str, str | None] = {}
        self._first_token_at_by_instance: dict[str, float] = {}
        self._first_tool_at_by_instance: dict[str, float] = {}
        self._workflow_started_at_by_instance: dict[str, float] = {}
        self._max_iterations_by_instance: dict[str, int] = {}
        # run_tool idempotency: (instance_id, tool_call_id) -> successful result.
        # Short-circuits a replayed/retried tool so its side effect runs at most
        # once (the activity is retried under self._retry_policy). See
        # src/tool_idempotency.py.
        self._tool_result_cache = ToolResultCache()

    def _custom_hooks_enabled_for_instance(
        self,
        instance_id: str,
        context: dict[str, Any] | None = None,
    ) -> bool:
        if not hooks_enabled():
            return False
        if is_swebench_execution_context(instance_id, context):
            return False
        mode = ""
        if isinstance(context, dict):
            mode = str(context.get("agentWorkflowMode") or "").strip()
        return mode != "strict_sequential"

    def _agent_workflow_strict_sequential(
        self,
        ctx,
        message: dict,
        *,
        force_repo_sequential: bool = False,
    ):
        """Run the standard durable-agent loop while scheduling tools one at a time.

        dapr-agents' built-in SEQUENTIAL mode still materializes every
        ctx.call_activity(...) task before awaiting the first one. Under load,
        Dapr observes that as a same-turn scheduling burst. This repo-owned
        wrapper creates and yields each tool activity only after the previous
        tool result has returned.
        """
        task = message.get("task")
        metadata = message.get("_message_metadata", {}) or {}
        otel_span_context = message.get("_otel_span_context")
        if "workflow_instance_id" in message:
            metadata["triggering_workflow_instance_id"] = message[
                "workflow_instance_id"
            ]

        trigger_instance_id = metadata.get("triggering_workflow_instance_id")
        source = metadata.get("source") or "direct"

        logger.info("Initial message from %s -> %s", source, self.name)

        yield ctx.call_activity(
            self._activity_name(self.record_initial_entry),
            input={
                "instance_id": ctx.instance_id,
                "source": source,
                "triggering_workflow_instance_id": trigger_instance_id,
                "trace_context": otel_span_context,
            },
            retry_policy=self._retry_policy,
        )

        # Always record this activity in durable history. ``load_tools`` is
        # idempotent and returns [] when no registry is present; branching on
        # the mutable in-process registry can make replay skip an activity that
        # the first execution scheduled.
        yield ctx.call_activity(
            self._activity_name(self.load_tools),
            retry_policy=self._retry_policy,
        )

        final_message: dict[str, Any] = {}
        turn = 0
        workflow_exc: Exception | None = None

        def cancellation_result_from_state() -> dict[str, Any] | None:
            cancel_state = yield ctx.call_activity(
                self._activity_name(self.check_cancellation_for_instance),
                input={"instance_id": ctx.instance_id},
                retry_policy=self._retry_policy,
            )
            if isinstance(cancel_state, dict) and cancel_state.get("cancelled"):
                request = cancel_state.get("request")
                return _cancelled_agent_result(
                    request if isinstance(request, dict) else {}
                )
            return None

        try:
            if self._orchestration_strategy and not force_repo_sequential:
                return (yield from super().agent_workflow(ctx, message))

            for turn in range(1, self.execution.max_iterations + 1):
                cancellation = yield from cancellation_result_from_state()
                if cancellation is not None:
                    self._termination_reason_by_instance[ctx.instance_id] = "cancelled"
                    final_message = cancellation
                    logger.info(
                        "Agent %s observed cancellation before turn %d (instance=%s)",
                        self.name,
                        turn,
                        ctx.instance_id,
                    )
                    break
                assistant_response: dict[str, Any] = yield ctx.call_activity(
                    self._activity_name(self.call_llm),
                    input={
                        "task": task,
                        "instance_id": ctx.instance_id,
                        "time": ctx.current_utc_datetime.isoformat(),
                        "source": source,
                    },
                    retry_policy=self._retry_policy,
                )
                tool_calls = assistant_response.get("tool_calls") or []
                if not tool_calls:
                    final_message = assistant_response
                    logger.debug(
                        "Agent %s produced final response on turn %d (instance=%s)",
                        self.name,
                        turn,
                        ctx.instance_id,
                    )
                    break

                cancellation = yield from cancellation_result_from_state()
                if cancellation is not None:
                    self._termination_reason_by_instance[ctx.instance_id] = "cancelled"
                    final_message = cancellation
                    logger.info(
                        "Agent %s observed cancellation after LLM turn %d before tools (instance=%s)",
                        self.name,
                        turn,
                        ctx.instance_id,
                    )
                    break

                ordered: list[dict[str, Any] | None] = [None] * len(tool_calls)
                tool_calls_by_id: dict[str, dict[str, Any]] = {}

                for idx, tc in enumerate(tool_calls):
                    cancellation = yield from cancellation_result_from_state()
                    if cancellation is not None:
                        self._termination_reason_by_instance[ctx.instance_id] = "cancelled"
                        final_message = cancellation
                        logger.info(
                            "Agent %s observed cancellation before tool %d on turn %d (instance=%s)",
                            self.name,
                            idx,
                            turn,
                            ctx.instance_id,
                        )
                        break
                    fn_name = tc["function"]["name"]
                    dispatch_time = ctx.current_utc_datetime.isoformat()
                    tool_obj = self.tool_executor.get_tool(fn_name)

                    if tool_obj and isinstance(tool_obj, WorkflowContextInjectedTool):
                        raw_args = tc["function"].get("arguments", "")
                        try:
                            args = json.loads(raw_args) if raw_args else {}
                        except json.JSONDecodeError as exc:
                            raise AgentError(
                                f"Failed to decode tool arguments for '{fn_name}': {exc}"
                            ) from exc
                        call_kwargs = {
                            "ctx": ctx,
                            "_source_agent": self.name,
                            **args,
                        }
                        is_agent_call = isinstance(tool_obj, AgentWorkflowTool)
                        child_instance_id = None
                        if is_agent_call:
                            child_instance_id = str(uuid.uuid4())
                            call_kwargs["_child_instance_id"] = child_instance_id
                        logger.info(
                            "[tool-dispatch] yielding sequential workflow tool instance=%s order=%d tool=%s call_id=%s",
                            ctx.instance_id,
                            idx,
                            fn_name,
                            tc.get("id"),
                        )
                        workflow_result = yield tool_obj(**call_kwargs)
                        ordered[idx] = ToolMessage(
                            content=serialize_tool_result(workflow_result),
                            role="tool",
                            name=fn_name,
                            tool_call_id=tc["id"],
                        ).model_dump()
                        tool_calls_by_id[tc["id"]] = {
                            "tool_call": tc,
                            "is_agent_call": is_agent_call,
                            "child_instance_id": child_instance_id,
                            "dispatch_time": dispatch_time,
                        }
                    else:
                        call_id = str(tc.get("id") or idx)
                        tool_payload = {
                            "tool_call": tc,
                            "instance_id": ctx.instance_id,
                            "time": dispatch_time,
                            "order": idx,
                        }
                        logger.info(
                            "[tool-dispatch] yielding sequential inline tool activity instance=%s order=%d tool=%s call_id=%s",
                            ctx.instance_id,
                            idx,
                            fn_name,
                            call_id,
                        )
                        ordered[idx] = yield ctx.call_activity(
                            self._activity_name(self.run_tool),
                            input=tool_payload,
                            retry_policy=self._retry_policy,
                        )
                        tool_calls_by_id[tc["id"]] = {
                            "tool_call": tc,
                            "is_agent_call": False,
                            "dispatch_time": dispatch_time,
                        }
                if final_message.get("cancelled"):
                    break

                tool_results = [tr for tr in ordered if tr is not None]
                yield ctx.call_activity(
                    self._activity_name(self.save_tool_results),
                    input={
                        "tool_results": tool_results,
                        "instance_id": ctx.instance_id,
                        "tool_calls_by_id": tool_calls_by_id,
                    },
                    retry_policy=self._retry_policy,
                )
                task = None
            else:
                base = final_message.get("content") or ""
                if base:
                    base = base.rstrip() + "\n\n"
                base += (
                    "I reached the maximum number of reasoning steps before I could finish. "
                    "Please rephrase or provide more detail so I can try again."
                )
                final_message = {"role": "assistant", "content": base}
                logger.warning(
                    "Agent %s hit max iterations (%d) without a final response (instance=%s)",
                    self.name,
                    self.execution.max_iterations,
                    ctx.instance_id,
                )
        except Exception as exc:  # noqa: BLE001
            logger.exception("Agent %s workflow failed: %s", self.name, exc)
            workflow_exc = exc
            final_message = {"role": "assistant", "content": f"Error: {str(exc)}"}

        if self.broadcast_topic_name and self.orchestrator:
            yield ctx.call_activity(
                self._activity_name(self.broadcast_to_team),
                input={"message": final_message},
                retry_policy=self._retry_policy,
            )

        if self.memory is not None:
            yield ctx.call_activity(
                self._activity_name(self.summarize),
                input={},
                retry_policy=self._retry_policy,
            )

        yield ctx.call_activity(
            self._activity_name(self.finalize_workflow),
            input={
                "instance_id": ctx.instance_id,
                "final_output": final_message.get("content", ""),
                "end_time": ctx.current_utc_datetime.isoformat(),
                "triggering_workflow_instance_id": trigger_instance_id,
            },
            retry_policy=self._retry_policy,
        )

        if workflow_exc is not None:
            verdict = DaprWorkflowStatus.FAILED
        elif turn == self.execution.max_iterations:
            ctx.set_custom_status("max_iterations_reached")
            verdict = DaprWorkflowStatus.COMPLETED
        else:
            verdict = DaprWorkflowStatus.COMPLETED
        logger.info(
            "Workflow %s finalized for agent %s with verdict=%s",
            ctx.instance_id,
            self.name,
            verdict,
        )

        if workflow_exc is not None:
            raise AgentError(
                f"Agent {self.name} workflow failed: {workflow_exc}"
            ) from workflow_exc

        return final_message

    def _activity_instance_id(self, ctx: Any, payload: Any) -> str:
        if isinstance(payload, dict):
            for key in ("instance_id", "instanceId"):
                value = payload.get(key)
                if isinstance(value, str) and value.strip():
                    return value.strip()
        for attr in ("workflow_id", "instance_id"):
            value = getattr(ctx, attr, None)
            if isinstance(value, str) and value.strip():
                return value.strip()
        return self._inst_id or ""

    def _remember_runtime_context(
        self,
        instance_id: str,
        context: dict[str, Any],
    ) -> dict[str, Any]:
        if not instance_id:
            return {}
        clean = _clean_runtime_context(context)
        sandbox_context = {
            "sandboxName": clean.get("sandboxName"),
            "cwd": clean.get("cwd") or DEFAULT_CWD,
            "sessionId": clean.get("sessionId"),
            "workspaceRef": clean.get("workspaceRef"),
            "executionId": clean.get("executionId"),
        }
        agent_context = runtime_context_audit_cache_fields(clean)
        for key in (
            "workflowId",
            "workflowExecutionId",
            "nodeId",
            "nodeName",
            "agentId",
            "agentVersion",
            "agentSlug",
            "agentAppId",
            "agentRuntime",
            "workspaceRef",
            "mlflowSessionId",
            "mlflowExperimentId",
            "mlflowTraceExperimentId",
            "mlflowRunId",
            "mlflowParentRunId",
            "mlflowActiveModelId",
            "mlflowActiveModelUri",
            "turnId",
            "autoTerminateAfterEndTurn",
        ):
            if clean.get(key) is not None:
                agent_context[key] = clean.get(key)
        if isinstance(clean.get("mlflowContext"), dict):
            agent_context["mlflowContext"] = dict(clean["mlflowContext"])
        if clean.get("llmComponent") is not None:
            agent_context["llmComponent"] = clean.get("llmComponent")
        agent_context.update(
            {
                "systemPrompt": clean.get("systemPrompt"),
                "instructionBundle": clean.get("instructionBundle"),
                "permissionMode": clean.get("permissionMode"),
                "allowedTools": clean.get("allowedTools"),
            }
        )
        with self._agent_context_lock:
            self._openshell_context_by_instance[instance_id] = sandbox_context
            self._agent_context_by_instance[instance_id] = agent_context
            if clean.get("sessionId"):
                self._session_id_by_instance[instance_id] = clean["sessionId"] or ""
            if clean.get("workspaceRef"):
                self._workspace_ref_by_instance[instance_id] = clean["workspaceRef"] or ""
            if clean.get("executionId"):
                self._execution_id_by_instance[instance_id] = clean["executionId"] or ""
            allowed_tools = _normalize_allowed_tool_set(clean.get("allowedTools"))
            if allowed_tools:
                self._allowed_tools_by_instance[instance_id] = allowed_tools
            else:
                self._allowed_tools_by_instance.pop(instance_id, None)
        return clean

    def _runtime_context_for_instance(self, instance_id: str) -> dict[str, Any]:
        candidates = _runtime_context_candidate_ids(instance_id)
        if not candidates:
            return {}
        for candidate in candidates:
            with self._agent_context_lock:
                sandbox_context = dict(
                    self._openshell_context_by_instance.get(candidate) or {}
                )
                agent_context = dict(
                    self._agent_context_by_instance.get(candidate) or {}
                )
            if sandbox_context or agent_context:
                context = {**sandbox_context, **agent_context}
                if candidate != candidates[0]:
                    self._remember_runtime_context(candidates[0], context)
                return context
        for candidate in candidates:
            state_value = _read_agent_state_key(_runtime_context_state_key(candidate))
            if isinstance(state_value, dict):
                context = self._remember_runtime_context(candidate, state_value)
                if candidate != candidates[0]:
                    self._remember_runtime_context(candidates[0], context)
                return context
        return {}

    def _is_tool_allowed_for_instance(self, instance_id: str, tool_name: str) -> bool:
        allowed_tools = None
        for candidate in _runtime_context_candidate_ids(instance_id):
            allowed_tools = self._allowed_tools_by_instance.get(candidate)
            if allowed_tools:
                break
        if not allowed_tools:
            return True
        return _normalize_tool_lookup_name(tool_name) in allowed_tools

    def _bind_openshell_runtime_for_instance(self, instance_id: str):
        context = self._runtime_context_for_instance(instance_id)
        runtime, token = bind_runtime(
            sandbox_name=context.get("sandboxName"),
            cwd=context.get("cwd") or DEFAULT_CWD,
            session_id=context.get("sessionId")
            or self._session_id_by_instance.get(instance_id),
        )
        return runtime, token

    def seed_runtime_context_for_instance(self, ctx, payload: dict) -> dict:
        instance_id = str(payload.get("instance_id") or payload.get("instanceId") or "").strip()
        if not instance_id:
            return {"ok": False, "reason": "no_instance_id"}
        raw_context = payload.get("context") if isinstance(payload.get("context"), dict) else payload
        context = self._remember_runtime_context(instance_id, raw_context)
        try:
            _save_agent_state_key(_runtime_context_state_key(instance_id), context)
        except Exception as exc:  # noqa: BLE001
            logger.warning(
                "[runtime-context] Failed to persist context for %s: %s",
                instance_id,
                exc,
            )
            raise
        return {
            "ok": True,
            "instance_id": instance_id,
            "sandboxName": context.get("sandboxName"),
            "cwd": context.get("cwd"),
        }

    def check_cancellation_for_instance(self, ctx, payload: dict) -> dict:
        instance_id = str(payload.get("instance_id") or payload.get("instanceId") or "").strip()
        if not instance_id:
            return {"cancelled": False, "reason": "no_instance_id"}
        for key_id in _cancellation_candidate_ids(instance_id):
            request = _read_agent_state_key(
                _session_cancel_state_key(key_id),
                timeout_seconds=1,
            )
            if isinstance(request, dict):
                return {"cancelled": True, "request": request}
        return {"cancelled": False}

    def _record_runtime_config_for_instance(
        self,
        instance_id: str,
        *,
        agent_config: dict[str, Any] | None = None,
        mcp_result: dict[str, Any] | None = None,
        source: str = "memory",
    ) -> dict[str, Any] | None:
        instance_id = str(instance_id or "").strip()
        if not instance_id:
            return None
        context = self._runtime_context_for_instance(instance_id)
        session_id = (
            str(context.get("sessionId") or "").strip()
            or self._session_id_by_instance.get(instance_id)
            or ""
        )
        if not session_id:
            return None
        effective_config = (
            context.get("effectiveAgentConfig")
            if isinstance(context.get("effectiveAgentConfig"), dict)
            else {}
        )
        instruction_bundle = (
            context.get("instructionBundle")
            if isinstance(context.get("instructionBundle"), dict)
            else {}
        )
        mlflow_context = (
            context.get("mlflowContext")
            if isinstance(context.get("mlflowContext"), dict)
            else {}
        )
        event = build_runtime_config_event(
            session_id=session_id,
            instance_id=instance_id,
            turn=context.get("turn"),
            config_revision=context.get("configRevision"),
            agent_config=agent_config or {},
            context=context,
            effective_config=effective_config,
            instruction_bundle=instruction_bundle,
            mcp_configs=self._mcp_configs_by_instance.get(instance_id) or {},
            mcp_allowed_tools=self._mcp_allowed_tools_by_instance.get(instance_id) or {},
            mcp_tools=self._mcp_tools_by_instance.get(instance_id) or {},
            mcp_result=mcp_result or {},
            skills=self._skills_by_instance.get(instance_id) or [],
            mlflow_context=mlflow_context,
            dapr_app_id=str(
                context.get("agentAppId")
                or os.environ.get("APP_ID")
                or os.environ.get("DAPR_APP_ID")
                or AGENT_SERVICE_NAME
            ),
            source=source,
        )
        self._runtime_config_by_instance[instance_id] = event
        self._runtime_config_by_session[session_id] = event
        try:
            _save_agent_state_key(runtime_config_state_key(instance_id), event)
            if session_id != instance_id:
                _save_agent_state_key(runtime_config_state_key(session_id), event)
        except Exception as exc:  # noqa: BLE001
            logger.warning(
                "[runtime-config] Failed to persist snapshot for %s: %s",
                instance_id,
                exc,
            )
        publish_session_event(
            session_id,
            SESSION_RUNTIME_CONFIG_EVENT_TYPE,
            event,
            source_event_id=event["id"],
            instance_id=instance_id,
        )
        return event

    def save_tool_results(self, ctx, payload: dict) -> None:
        from src.compaction.payloads import compact_save_tool_results_payload

        compacted_payload, stats = compact_save_tool_results_payload(payload or {})
        if stats.changed:
            logger.info(
                "[payload-compaction] bounded tool persistence for %s: %s",
                compacted_payload.get("instance_id"),
                stats.to_dict(),
            )
        return super().save_tool_results(ctx, compacted_payload)

    def _bounded_summarize_conversation(self, instance_id: str, entry: Any) -> dict:
        if not self.memory:
            return {"skipped": True, "reason": "memory_disabled"}
        messages = list(getattr(entry, "messages", []) or [])
        if not messages:
            logger.debug("No messages to summarize for instance_id=%s", instance_id)
            return {}

        from dapr_agents.agents.schemas import ConversationSummary
        from src.compaction.payloads import build_bounded_summary_task

        task = build_bounded_summary_task(
            messages,
            getattr(entry, "tool_history", None) or [],
        )
        summary_model = self.llm.generate(
            messages=[{"role": "user", "content": task}],
            response_format=ConversationSummary,
        )
        summary_content = (getattr(summary_model, "summary", "") or "").strip()
        if not summary_content:
            return {"skipped": True, "reason": "empty_summary"}

        summary_message: dict[str, Any] = {
            "role": "assistant",
            "content": summary_content,
            "name": self.name,
        }
        self.memory.add_message(summary_message, workflow_instance_id=instance_id)
        logger.info("Saved bounded summary to memory for instance_id=%s", instance_id)
        if getattr(self, "text_formatter", None):
            self.text_formatter.print_message(
                {**summary_message, "name": f"{self.name}"}
            )
        return {"content": summary_content}

    def summarize(self, ctx, payload: dict) -> dict:
        instance_id = str(getattr(ctx, "workflow_id", "") or "").strip()
        if not instance_id:
            instance_id = self._activity_instance_id(ctx, payload)
        context = self._runtime_context_for_instance(instance_id)
        if is_swebench_execution_context(instance_id, context):
            logger.info(
                "[memory] skipping conversation summary for SWE-bench workflow %s",
                instance_id,
            )
            return {"skipped": True, "reason": "swebench_benchmark_turn"}
        session_id = (
            str(context.get("sessionId") or "").strip()
            or self._session_id_by_instance.get(instance_id)
            or ""
        )
        auto_terminate = bool(context.get("autoTerminateAfterEndTurn"))
        if session_id and not auto_terminate:
            logger.info(
                "[memory] skipping long-term summary for session-native interactive workflow %s",
                instance_id,
            )
            return {
                "skipped": True,
                "reason": "session_native_compaction_owns_context",
            }

        try:
            entry = self._infra.get_state(instance_id)
        except Exception as exc:  # noqa: BLE001
            logger.warning(
                "[memory] summary skipped: state load failed for %s: %s",
                instance_id,
                exc,
            )
            return {
                "skipped": True,
                "reason": "state_load_failed",
                "error": str(exc)[:500],
            }

        try:
            return self._bounded_summarize_conversation(instance_id, entry)
        except Exception as exc:  # noqa: BLE001
            logger.warning(
                "[memory] bounded conversation summary failed for %s: %s",
                instance_id,
                exc,
            )
            try:
                publish_session_event(
                    session_id or None,
                    "agent.summary_failed",
                    {"reason": "summary_failed", "error": str(exc)[:500]},
                    instance_id=instance_id,
                )
            except Exception:
                pass
            return {
                "skipped": True,
                "reason": "summary_failed",
                "error": str(exc)[:500],
            }

    def _activate_instance_skills(self, instance_id: str) -> None:
        if not instance_id:
            return
        skills = self._skills_by_instance.get(instance_id)
        if skills:
            get_skill_registry().set_instance_skills(skills)

    async def _close_mcp_client_async(self, instance_id: str) -> None:
        client = self._mcp_clients_by_instance.pop(instance_id, None)
        self._mcp_config_hash_by_instance.pop(instance_id, None)
        self._mcp_tools_by_instance.pop(instance_id, None)
        self._mcp_tool_sources_by_instance.pop(instance_id, None)
        self._mcp_allowed_tools_by_instance.pop(instance_id, None)
        self._mcp_configs_by_instance.pop(instance_id, None)
        self._allowed_tools_by_instance.pop(instance_id, None)
        if client is not None:
            await client.close()

    def _close_mcp_client(self, instance_id: str) -> None:
        if not instance_id:
            return
        try:
            try:
                loop = asyncio.get_running_loop()
            except RuntimeError:
                self._run_asyncio_task(self._close_mcp_client_async(instance_id))
            else:
                loop.create_task(self._close_mcp_client_async(instance_id))
        except Exception as exc:
            logger.warning("[mcp] Failed to close MCP client for %s: %s", instance_id, exc)

    async def _ensure_mcp_client_async(self, instance_id: str) -> None:
        configs = self._mcp_configs_by_instance.get(instance_id) or {}
        if not configs:
            return
        config_hash = json.dumps(configs, sort_keys=True, default=str)
        if self._mcp_config_hash_by_instance.get(instance_id) == config_hash:
            return

        existing = self._mcp_clients_by_instance.get(instance_id)
        client = await connect_mcp_client_with_retries(
            configs,
            client_factory=lambda: MCPClient(persistent_connections=False),
            logger=logger,
            context=f"instance {instance_id}",
        )
        if existing is not None:
            try:
                await existing.close()
            except Exception as exc:  # noqa: BLE001
                logger.warning(
                    "[mcp] Failed to close previous MCP client for %s: %s",
                    instance_id,
                    exc,
                )
        allowed_tools_by_server = (
            self._mcp_allowed_tools_by_instance.get(instance_id) or {}
        )
        tools: dict[str, Any] = {}
        tool_sources: dict[str, dict[str, str]] = {}
        for server_name in configs:
            server_cfg = configs.get(server_name) or {}
            # Transport: try typed attr first, then dict lookup. Defaults
            # "stdio" because MCP's canonical default for unspecified
            # transport is stdio (aligns with the @modelcontextprotocol docs).
            transport = (
                str(server_cfg.get("transport") or "").strip()
                or str(server_cfg.get("type") or "").strip()
                or "stdio"
            )
            allowed_tools = allowed_tools_by_server.get(server_name)
            allowed_lookup = (
                {
                    _normalize_tool_lookup_name(tool_name)
                    for tool_name in allowed_tools
                    if str(tool_name).strip()
                }
                if allowed_tools
                else set()
            )
            for tool in client.get_server_tools(server_name):
                raw_tool_name = str(getattr(tool, "name", "") or "")
                wrapped_prefix = f"{server_name}_"
                if raw_tool_name.startswith(wrapped_prefix):
                    raw_tool_name = raw_tool_name[len(wrapped_prefix) :]
                raw_lookup = _normalize_tool_lookup_name(raw_tool_name)
                tool_lookup = _normalize_tool_lookup_name(
                    str(getattr(tool, "name", "") or "")
                )
                if allowed_lookup and not (
                    raw_lookup in allowed_lookup
                    or tool_lookup in allowed_lookup
                    or any(
                        raw_lookup.endswith(allowed)
                        or tool_lookup.endswith(allowed)
                        for allowed in allowed_lookup
                    )
                ):
                    logger.debug(
                        "[mcp] Skipping tool outside allowlist: %s.%s",
                        server_name,
                        raw_tool_name,
                    )
                    continue
                norm_key = _normalize_tool_lookup_name(tool.name)
                tools[norm_key] = tool
                tool_sources[norm_key] = {
                    "server": server_name,
                    "transport": transport,
                }
        self._mcp_clients_by_instance[instance_id] = client
        self._mcp_config_hash_by_instance[instance_id] = config_hash
        self._mcp_tools_by_instance[instance_id] = tools
        self._mcp_tool_sources_by_instance[instance_id] = tool_sources
        logger.warning(
            "[mcp] Connected %d MCP server(s), loaded %d tool(s) for instance %s",
            len(configs),
            len(tools),
            instance_id,
        )

    def _ensure_mcp_client(self, instance_id: str) -> bool:
        if not instance_id:
            return False
        try:
            self._run_asyncio_task(self._ensure_mcp_client_async(instance_id))
            return True
        except Exception as exc:
            logger.warning(
                "[mcp] Failed to connect MCP servers for instance %s: %s",
                instance_id,
                exc,
            )
            return False

    def get_llm_tools(self):
        tools = list(super().get_llm_tools())
        instance_id = self._active_llm_instance_id or ""
        mcp_tools = self._mcp_tools_by_instance.get(instance_id) or {}
        if mcp_tools:
            existing_names = {
                _normalize_tool_lookup_name(getattr(tool, "name", ""))
                for tool in tools
            }
            for key, tool in mcp_tools.items():
                if key in existing_names:
                    logger.warning("[mcp] Skipping MCP tool name collision: %s", tool.name)
                    continue
                tools.append(tool)

        allowed_tools = self._allowed_tools_by_instance.get(instance_id)
        if allowed_tools:
            before = len(tools)
            tools = [
                t
                for t in tools
                if _normalize_tool_lookup_name(getattr(t, "name", "")) in allowed_tools
            ]
            logger.info(
                "[tools] AgentConfig tools filter for %s: kept %d/%d tools (%s)",
                instance_id,
                len(tools),
                before,
                sorted(allowed_tools),
            )

        # Hard allowed-tools enforcement when a skill is active. Mirrors
        # Claude Code's tools/SkillTool/SkillTool.ts:775-806 contextModifier
        # — while a skill whose frontmatter declared `allowed-tools` is
        # running, the LLM only sees those tools (plus Skill itself, so it
        # can still chain-activate or terminate). Any unrelated tool call
        # the model attempts falls back to "tool not found" rather than
        # executing — safer than relying on the soft-enforcement header.
        from src.tools.skill_tool.tool import get_active_skill_allowed_tools

        allowed = get_active_skill_allowed_tools()
        if allowed:
            allowed_norm = {_normalize_tool_lookup_name(name) for name in allowed}
            # Always keep the Skill tool itself — matches Claude Code's carve-out.
            allowed_norm.add(_normalize_tool_lookup_name("Skill"))
            before = len(tools)
            tools = [
                t
                for t in tools
                if _normalize_tool_lookup_name(getattr(t, "name", "")) in allowed_norm
            ]
            logger.info(
                "[skills] Active-skill allowed_tools filter: kept %d/%d tools (%s)",
                len(tools),
                before,
                sorted(allowed_norm),
            )
        return tools

    @staticmethod
    def _message_role(message: Any) -> str | None:
        if isinstance(message, dict):
            role = message.get("role")
        else:
            role = getattr(message, "role", None)
        return str(role) if role is not None else None

    def _emit_active_context_usage(
        self,
        *,
        session_id: str | None,
        instance_id: str,
        execution_id: str,
        payload: dict[str, Any],
        context: dict[str, Any],
        component: str | None,
    ) -> None:
        """Emit local advisory context usage for the request about to hit the LLM."""
        if not session_id or not instance_id:
            return
        try:
            from src.compaction.tokens import active_context_usage_fields
            from src.telemetry.genai_attrs import set_activity_attrs

            entry = self._infra.get_state(instance_id)
            chat_history = self._reconstruct_conversation_history(
                instance_id,
                entry=entry,
            )
            messages = self.prompting_helper.build_initial_messages(
                user_input=payload.get("task") if isinstance(payload, dict) else None,
                chat_history=chat_history,
            )
            system_messages = [
                message
                for message in messages
                if self._message_role(message) == "system"
            ]
            active_messages = [
                message
                for message in messages
                if self._message_role(message) != "system"
            ]
            tools = self.get_llm_tools()
            model_id = (
                context.get("providerModel")
                or context.get("modelSpec")
                or component
            )
            if component and "anthropic" in str(component):
                try:
                    from src.anthropic_adapter import _get_anthropic_model

                    model_id = _get_anthropic_model(str(component))
                except Exception:
                    pass
            fields = active_context_usage_fields(
                model=str(model_id) if model_id else None,
                messages=active_messages,
                system_messages=system_messages,
                tools=tools,
            )
            request_hash = str(fields.get("context_request_hash") or fields.get("request_hash") or "")
            turn_id = context.get("turnId")
            mlflow_context = (
                context.get("mlflowContext")
                if isinstance(context.get("mlflowContext"), dict)
                else {}
            )
            event_data: dict[str, Any] = {
                "schemaVersion": "workflow-builder.agent_context_usage.v1",
                **fields,
                "model": model_id,
                "llmComponent": component,
                "modelSpec": context.get("modelSpec"),
                "providerModel": context.get("providerModel"),
                "sessionId": session_id,
                "instanceId": instance_id,
                "workflowExecutionId": context.get("workflowExecutionId") or execution_id,
                "executionId": execution_id,
                "turn": context.get("turn"),
                "turnId": turn_id,
                "configHash": context.get("configHash"),
                "instructionHash": context.get("instructionHash"),
                "mlflowExperimentId": context.get("mlflowExperimentId")
                or mlflow_context.get("experimentId"),
                "mlflowTraceExperimentId": context.get("mlflowTraceExperimentId")
                or mlflow_context.get("traceExperimentId"),
                "mlflowRunId": context.get("mlflowRunId") or mlflow_context.get("runId"),
                "mlflowParentRunId": context.get("mlflowParentRunId")
                or mlflow_context.get("parentRunId"),
                "mlflowSessionId": context.get("mlflowSessionId")
                or mlflow_context.get("mlflowSessionId")
                or session_id,
                "mlflowActiveModelId": context.get("mlflowActiveModelId")
                or mlflow_context.get("activeModelId"),
                "mlflowActiveModelUri": context.get("mlflowActiveModelUri")
                or mlflow_context.get("activeModelUri"),
            }
            set_activity_attrs(
                extra={
                    "llm.context.source": fields.get("context_source"),
                    "llm.context.count_method": fields.get("context_count_method"),
                    "llm.context.active_input_tokens": fields.get("context_input_tokens"),
                    "llm.context.active_used_percentage": fields.get(
                        "context_used_percentage"
                    ),
                    "llm.context.active_window_size": fields.get("context_window_size"),
                    "llm.context.message_count": fields.get("context_message_count"),
                    "llm.context.system_message_count": fields.get(
                        "context_system_message_count"
                    ),
                    "llm.context.tool_count": fields.get("context_tool_count"),
                }
            )
            source_event_id = (
                f"{instance_id}:{turn_id or 'turn'}:context_usage:{request_hash}"
                if request_hash
                else None
            )
            publish_session_event(
                session_id,
                "agent.context_usage",
                event_data,
                source_event_id=source_event_id,
                instance_id=instance_id,
            )
        except Exception as exc:  # noqa: BLE001
            logger.debug("[context-usage] active context emit failed: %s", exc)

    def call_llm(self, ctx, payload):
        """Publish llm_start/llm_complete streaming events with content."""
        # Re-apply Anthropic adapter on each call (survives durable workflow replay)
        try:
            from src.anthropic_adapter import patch_for_anthropic
            patch_for_anthropic(self.llm)
        except Exception:
            pass
        try:
            from src.openai_adapter import patch_for_openai
            patch_for_openai(self.llm)
        except Exception:
            pass
        try:
            from src.nvidia_adapter import patch_for_nvidia
            patch_for_nvidia(self.llm)
        except Exception:
            pass
        try:
            from src.foundry_adapter import patch_for_foundry
            patch_for_foundry(self.llm)
        except Exception:
            pass
        try:
            from src.together_adapter import patch_for_together
            patch_for_together(self.llm)
        except Exception:
            pass
        try:
            from src.deepseek_adapter import patch_for_deepseek
            patch_for_deepseek(self.llm)
        except Exception:
            pass
        try:
            from src.alibaba_adapter import patch_for_alibaba
            patch_for_alibaba(self.llm)
        except Exception:
            pass
        try:
            from src.kimi_adapter import patch_for_kimi
            patch_for_kimi(self.llm)
        except Exception:
            pass
        # Phase 2c v2: Gateway adapter patches LAST so it's the OUTERMOST
        # wrapper, getting first look at every generate() call. If a route
        # is configured for the active component AND the master + per-
        # provider feature flags are on, the call routes through the
        # Gateway instead of the legacy adapter. Otherwise falls through.
        try:
            from src.gateway_adapter import patch_for_gateway
            patch_for_gateway(self.llm)
        except Exception:
            pass
        inst_id = self._activity_instance_id(ctx, payload)
        context = self._runtime_context_for_instance(inst_id)
        exec_id = (
            context.get("executionId")
            or self._execution_id_by_instance.get(inst_id)
            or self._exec_id
            or ""
        )
        component = context.get("llmComponent") or getattr(self.llm, "_llm_component", None)
        _runtime, runtime_token = self._bind_openshell_runtime_for_instance(inst_id)
        self._activate_instance_skills(inst_id)
        self._ensure_mcp_client(inst_id)

        # Stamp workflow + agent context onto the current Dapr activity span
        # so the call_llm span is filterable in MLflow / ClickHouse by agent
        # slug, session id, and component without parsing the input/output
        # JSON blobs. The provider-specific gen_ai.* attrs land later, inside
        # the adapter's own enrichment block.
        try:
            from src.telemetry.genai_attrs import set_activity_attrs

            iteration = None
            try:
                iteration = self._compaction_call_count_by_instance.get(inst_id)
            except Exception:
                iteration = None
            agent_slug = (
                context.get("agentSlug")
                or getattr(self, "_agent_slug", None)
            )
            agent_name = getattr(self.profile, "name", None) if hasattr(self, "profile") else None
            set_activity_attrs(
                workflow_id=context.get("workflowId"),
                workflow_execution_id=exec_id,
                workflow_instance_id=inst_id,
                workflow_activity_correlation_id=context.get(
                    "workflowActivityCorrelationId"
                ),
                workflow_node_id=context.get("nodeId"),
                workflow_node_name=context.get("nodeName"),
                session_id=context.get("sessionId") or exec_id,
                agent_id=context.get("agentId"),
                agent_version=context.get("agentVersion"),
                agent_slug=str(agent_slug) if agent_slug else None,
                agent_app_id=context.get("agentAppId"),
                component=component,
                iteration=iteration,
                mlflow_span_type="CHAT_MODEL",
                extra={
                    "agent.name": agent_name,
                    "agent.max_iterations": context.get("maxIterations"),
                    "agent.timeout_minutes": context.get("timeoutMinutes"),
                    "sandbox.workspace_ref": context.get("workspaceRef"),
                    "sandbox.name": context.get("sandboxName"),
                    "sandbox.cwd": context.get("cwd"),
                    "agent.tools_count": (
                        len(self.tool_executor.list_tools())
                        if hasattr(self, "tool_executor")
                        else None
                    ),
                    "compaction.enabled": bool(
                        self._compaction_cfg_by_instance.get(inst_id)
                        and self._compaction_cfg_by_instance[inst_id].enabled
                    )
                    if hasattr(self, "_compaction_cfg_by_instance")
                    else None,
                    "instance.empty_streak": self._empty_llm_response_count_by_instance.get(inst_id, 0)
                    if hasattr(self, "_empty_llm_response_count_by_instance")
                    else None,
                },
            )
        except Exception as _attr_exc:  # noqa: BLE001
            logger.debug("[genai-attrs] call_llm activity enrichment failed: %s", _attr_exc)

        # ---- Context compaction (inline, same activity boundary) -----------
        # Runs BEFORE the base call_llm. If compaction triggers it rewrites
        # entry.messages via save_state; super().call_llm() will reload the
        # compacted state. Failures are advisory and never block call_llm.
        try:
            from src.anthropic_adapter import _call_anthropic_sdk, _get_anthropic_model
            from src.compaction import maybe_compact

            cfg = self._compaction_cfg_by_instance.get(inst_id)
            if cfg is not None and cfg.enabled:
                turn_index = self._compaction_call_count_by_instance.get(inst_id, 0)
                self._compaction_call_count_by_instance[inst_id] = turn_index + 1
                model_id = (
                    _get_anthropic_model(component)
                    if component and "anthropic" in component
                    else (component or None)
                )
                runtime_for_compact = get_runtime()
                result = maybe_compact(
                    self,
                    instance_id=inst_id,
                    execution_id=exec_id,
                    config=cfg,
                    model=model_id,
                    component=component,
                    caller=_call_anthropic_sdk,
                    turn_index=turn_index,
                    runtime=runtime_for_compact,
                    session_id=self._session_id_by_instance.get(inst_id),
                )
                if result.compacted:
                    self._compaction_runs_by_instance[inst_id] = (
                        self._compaction_runs_by_instance.get(inst_id, 0) + 1
                    )
                    logger.info(
                        "[compaction] inline pre-call_llm result: pre=%d post=%d dropped=%d",
                        result.pre_count,
                        result.post_count,
                        result.messages_dropped,
                    )
        except Exception as exc:  # noqa: BLE001
            logger.warning("[compaction] inline pass failed (continuing): %s", exc, exc_info=True)

        # ---- Pre-save state byte-budget guard (16 MiB durabletask cliff) ----
        # Compaction above is TOKEN-triggered; this is a separate BYTE safety
        # net that runs in the same activity boundary BEFORE save_state. When
        # the serialized entry.messages exceeds the configured budget it
        # deterministically offloads the oldest oversized (pairing-safe) bodies
        # so the persisted document never approaches the 16 MiB gRPC channel
        # limit, and emits a `state_size` telemetry field. Best-effort.
        try:
            from src.compaction.state_budget import (
                enforce_state_byte_budget,
                resolve_state_budget_config,
            )

            _state_budget_cfg = resolve_state_budget_config()
            if _state_budget_cfg.enabled:
                _budget_result = enforce_state_byte_budget(
                    self,
                    instance_id=inst_id,
                    session_id=self._session_id_by_instance.get(inst_id),
                    config=_state_budget_cfg,
                )
                if _budget_result.over_budget:
                    logger.warning(
                        "[state-budget] instance=%s over budget pre=%dB post=%dB "
                        "offloaded=%d budget=%dB",
                        inst_id,
                        _budget_result.pre_bytes,
                        _budget_result.post_bytes,
                        _budget_result.offloaded_count,
                        _state_budget_cfg.budget_bytes,
                    )
        except Exception as exc:  # noqa: BLE001
            logger.warning("[state-budget] guard failed (continuing): %s", exc, exc_info=True)

        sess_id = self._session_id_by_instance.get(inst_id)
        # Phase B — turn count + first-token timestamp. We're in a durable
        # activity; counter increments are idempotent across replays because
        # Dapr caches the activity's first-execution result and only re-runs
        # on worker failure.
        self._turn_count_by_instance[inst_id] = (
            self._turn_count_by_instance.get(inst_id, 0) + 1
        )
        turn_count = self._turn_count_by_instance[inst_id]
        if inst_id not in self._first_token_at_by_instance:
            import time as _time

            self._first_token_at_by_instance[inst_id] = _time.monotonic()
        try:
            max_iters = (
                self._max_iterations_by_instance.get(inst_id, 0)
                or DEFAULT_MAX_ITERATIONS
            )
            publish_session_event(
                sess_id,
                "agent.iteration",
                {"v": 1, "index": turn_count, "max": max_iters},
                instance_id=inst_id,
            )
        except Exception:
            pass
        try:
            publish_session_event(
                sess_id, "llm_start", {"model": component}, instance_id=inst_id
            )
        except Exception:
            pass
        # Scope session for the inner call chain — the provider adapters read
        # this contextvar to emit thinking/usage events with config audit fields.
        scope_token = scope_session(
            sess_id,
            inst_id,
            _runtime_context_audit_fields(context),
        )
        tel_session_token = None
        try:
            from src.telemetry import set_session_context

            tel_session_token = set_session_context(
                instance_id=inst_id,
                execution_id=exec_id,
                **_telemetry_context_kwargs(context),
            )
        except Exception as exc:  # noqa: BLE001
            logger.warning("[telemetry] llm session context failed: %s", exc)
        try:
            with self._agent_context_lock:
                previous_active_instance = self._active_llm_instance_id
                previous_component = getattr(self.llm, "_llm_component", None)
                previous_prompt_state = _capture_prompt_state(self)
                saved_tool_choice = None
                try:
                    if component:
                        self.llm._llm_component = component
                    _apply_instruction_prompt_state(
                        self,
                        context.get("instructionBundle")
                        if isinstance(context.get("instructionBundle"), dict)
                        else None,
                    )
                    if context.get("systemPrompt") and not context.get("instructionBundle"):
                        fallback_bundle = {
                            "persona": {
                                "role": self.profile.role,
                                "goal": self.profile.goal,
                                "instructions": list(self.profile.instructions or []),
                                "styleGuidelines": list(
                                    getattr(self.profile, "style_guidelines", None) or []
                                ),
                            },
                            "rendered": {"system": context["systemPrompt"]},
                        }
                        _apply_instruction_prompt_state(self, fallback_bundle)
                    active_component = getattr(self.llm, "_llm_component", None)
                    # Suppress tool_choice for Anthropic components — the
                    # Dapr langchaingo Anthropic adapter passes tool_choice as
                    # a string ("auto") but the Anthropic API expects a dict.
                    if active_component and "anthropic" in active_component:
                        saved_tool_choice = self.execution.tool_choice
                        self.execution.tool_choice = None
                    self._active_llm_instance_id = inst_id
                    self._emit_active_context_usage(
                        session_id=sess_id,
                        instance_id=inst_id,
                        execution_id=exec_id,
                        payload=payload if isinstance(payload, dict) else {},
                        context=context,
                        component=active_component or component,
                    )
                    result = super().call_llm(ctx, payload)
                finally:
                    self._active_llm_instance_id = previous_active_instance
                    self.llm._llm_component = previous_component
                    _restore_prompt_state(self, previous_prompt_state)
                    if saved_tool_choice is not None:
                        self.execution.tool_choice = saved_tool_choice
        except Exception as exc:
            try:
                publish_session_event(
                    sess_id, "llm_complete", {"content": "", "toolCalls": []},
                    instance_id=inst_id,
                )
            except Exception:
                pass
            # Count failures as "empty" for circuit-breaker purposes. Dapr's
            # activity-level retry will re-invoke us up to max_attempts=8
            # before the exception escapes; we want to short-circuit once
            # we've seen EMPTY_RESPONSE_THRESHOLD total empties for this
            # instance (across retries + real empty responses combined).
            streak = self._empty_llm_response_count_by_instance.get(inst_id, 0) + 1
            self._empty_llm_response_count_by_instance[inst_id] = streak
            if streak >= EMPTY_RESPONSE_THRESHOLD:
                logger.warning(
                    "[call-llm] circuit-breaker tripped after %d empty/failed LLM responses for instance %s; surfacing AgentError to break the loop",
                    streak, inst_id,
                )
                try:
                    publish_session_event(
                        sess_id,
                        "agent.circuit_breaker_tripped",
                        {
                            "reason": "llm_exception",
                            "streak": streak,
                            "threshold": EMPTY_RESPONSE_THRESHOLD,
                            "last_error": str(exc)[:200],
                        },
                        instance_id=inst_id,
                    )
                except Exception:
                    pass
                self._empty_llm_response_count_by_instance.pop(inst_id, None)
                self._termination_reason_by_instance[inst_id] = "circuit_breaker_failure"
                from dapr_agents.types.exceptions import AgentError
                raise AgentError(
                    f"LLM returned empty/failed responses {streak} consecutive times; "
                    "circuit breaker tripped to prevent runaway loop. "
                    "Likely cause: anthropics/anthropic-sdk-python#1204 "
                    "(thinking-only response) or persistent provider errors."
                ) from exc
            raise
        finally:
            unscope_session(scope_token)
            if tel_session_token is not None:
                try:
                    from src.telemetry.attributes import reset_session_context

                    reset_session_context(tel_session_token)
                except Exception:
                    pass
            try:
                reset_runtime(runtime_token)
            except Exception as exc:  # noqa: BLE001
                logger.warning("[runtime-context] reset failed after llm: %s", exc)
        # Extract content summary from the assistant message
        content = ""
        tool_calls = []
        if isinstance(result, dict):
            raw = result.get("content", "")
            if isinstance(raw, str):
                content = raw
            elif isinstance(raw, list):
                content = " ".join(
                    b.get("text", "") for b in raw if isinstance(b, dict) and b.get("type") == "text"
                )
            tc = result.get("tool_calls")
            if isinstance(tc, list):
                tool_calls = [
                    t.get("function", {}).get("name", "") for t in tc if isinstance(t, dict)
                ]
                try:
                    for idx, t in enumerate(tc):
                        if not isinstance(t, dict):
                            continue
                        function = t.get("function")
                        if not isinstance(function, dict):
                            function = {}
                        call_id = str(t.get("id") or "")
                        name = str(function.get("name") or "")
                        logger.info(
                            "[tool-dispatch] scheduled instance=%s session=%s order=%d tool=%s call_id=%s mode=%s",
                            inst_id,
                            sess_id,
                            idx,
                            name,
                            call_id,
                            getattr(self.execution, "tool_execution_mode", None),
                        )
                        publish_session_event(
                            sess_id,
                            "tool_activity.scheduled",
                            {
                                "toolName": name,
                                "toolCallId": call_id,
                                "order": idx,
                                "executionMode": str(
                                    getattr(self.execution, "tool_execution_mode", "")
                                ),
                                "workflowInstanceId": inst_id,
                            },
                            source_event_id=f"{call_id}:activity_scheduled" if call_id else None,
                            instance_id=inst_id,
                        )
                except Exception:
                    pass
        # Circuit-breaker bookkeeping on the success path: a response that
        # carries text content OR tool_calls resets the empty-streak counter;
        # a response with neither increments it. See EMPTY_RESPONSE_THRESHOLD.
        if content.strip() or tool_calls:
            self._empty_llm_response_count_by_instance.pop(inst_id, None)
        else:
            streak = self._empty_llm_response_count_by_instance.get(inst_id, 0) + 1
            self._empty_llm_response_count_by_instance[inst_id] = streak
            if streak >= EMPTY_RESPONSE_THRESHOLD:
                logger.warning(
                    "[call-llm] circuit-breaker tripped after %d empty-content LLM responses for instance %s; surfacing AgentError to break the loop",
                    streak, inst_id,
                )
                try:
                    cb_content, cb_oversized, cb_size = _prepare_payload_with_preview(
                        content, mode="text", preview_len=500,
                    )
                    cb_payload: dict[str, Any] = {
                        "content": cb_content if not cb_oversized else "",
                        "preview": (content[:500] if isinstance(content, str) else ""),
                        "toolCalls": tool_calls,
                    }
                    if cb_oversized:
                        cb_payload["oversized"] = True
                        cb_payload["size_bytes"] = cb_size
                    publish_session_event(
                        sess_id,
                        "llm_complete",
                        cb_payload,
                        instance_id=inst_id,
                    )
                except Exception:
                    pass
                try:
                    publish_session_event(
                        sess_id,
                        "agent.circuit_breaker_tripped",
                        {
                            "reason": "empty_response_content",
                            "streak": streak,
                            "threshold": EMPTY_RESPONSE_THRESHOLD,
                        },
                        instance_id=inst_id,
                    )
                except Exception:
                    pass
                self._empty_llm_response_count_by_instance.pop(inst_id, None)
                self._termination_reason_by_instance[inst_id] = "circuit_breaker_empty"
                from dapr_agents.types.exceptions import AgentError
                raise AgentError(
                    f"LLM returned empty responses {streak} consecutive times; "
                    "circuit breaker tripped to prevent runaway loop. "
                    "Likely cause: anthropics/anthropic-sdk-python#1204 "
                    "(thinking-only response with stop_reason=end_turn and no tool_use)."
                )
        try:
            lc_content, lc_oversized, lc_size = _prepare_payload_with_preview(
                content, mode="text", preview_len=500,
            )
            lc_payload: dict[str, Any] = {
                "content": lc_content if not lc_oversized else "",
                "preview": (content[:500] if isinstance(content, str) else ""),
                "toolCalls": tool_calls,
            }
            if lc_oversized:
                lc_payload["oversized"] = True
                lc_payload["size_bytes"] = lc_size
            publish_session_event(
                sess_id,
                "llm_complete",
                lc_payload,
                instance_id=inst_id,
            )
        except Exception:
            pass
        return result

    def run_tool(self, ctx, payload):
        """Publish tool_call_start/end streaming events with content."""
        inst_id = self._activity_instance_id(ctx, payload)
        context = self._runtime_context_for_instance(inst_id)
        exec_id = (
            context.get("executionId")
            or self._execution_id_by_instance.get(inst_id)
            or self._exec_id
            or ""
        )
        _runtime, runtime_token = self._bind_openshell_runtime_for_instance(inst_id)
        sess_id = self._session_id_by_instance.get(inst_id)
        tool_call = payload.get("tool_call", {})
        tool_call_id = str(tool_call.get("id") or "") if isinstance(tool_call, dict) else ""
        func = tool_call.get("function", {}) if isinstance(tool_call, dict) else {}
        tool_name = func.get("name", "unknown") if isinstance(func, dict) else "unknown"
        logger.info(
            "[tool-dispatch] run_tool entry instance=%s session=%s tool=%s call_id=%s",
            inst_id,
            sess_id,
            tool_name,
            tool_call_id,
        )
        # ---- run_tool idempotency (at-least-once -> effectively once) -------
        # A replayed/retried activity (transient failure, pod death mid-tool)
        # must not double-execute a side effect. Short-circuit-return a recorded
        # result keyed on (instance_id, tool_call_id): in-memory first (same-pod
        # retry), then a durable scan of entry.messages (cross-pod replay,
        # mirrors the compaction durable-sentinel pattern). See
        # src/tool_idempotency.py. Best-effort; never blocks a fresh tool.
        if tool_call_id and tool_idempotency_enabled():
            try:
                _cached_result = self._tool_result_cache.get(inst_id, tool_call_id)
                if _cached_result is None and _env_bool(
                    "DAPR_AGENT_PY_TOOL_IDEMPOTENCY_DURABLE_SCAN"
                ):
                    _entry = self._infra.get_state(inst_id)
                    _cached_result = find_recorded_tool_result(
                        list(getattr(_entry, "messages", []) or []), tool_call_id
                    )
                if _cached_result is not None:
                    logger.info(
                        "[tool-idempotency] replay hit instance=%s call_id=%s "
                        "tool=%s — returning cached result (no re-execution)",
                        inst_id,
                        tool_call_id,
                        tool_name,
                    )
                    try:
                        publish_session_event(
                            sess_id,
                            "tool_activity.replayed",
                            {
                                "toolName": tool_name,
                                "toolCallId": tool_call_id,
                                "workflowInstanceId": inst_id,
                            },
                            source_event_id=f"{tool_call_id}:replayed",
                            instance_id=inst_id,
                        )
                    except Exception:
                        pass
                    return _cached_result
            except Exception as exc:  # noqa: BLE001
                logger.warning("[tool-idempotency] entry check failed (continuing): %s", exc)
        try:
            publish_session_event(
                sess_id,
                "tool_activity.started",
                {
                    "toolName": tool_name,
                    "toolCallId": tool_call_id,
                    "workflowInstanceId": inst_id,
                },
                source_event_id=f"{tool_call_id}:activity_started" if tool_call_id else None,
                instance_id=inst_id,
            )
        except Exception:
            pass
        tool_args = {}
        raw_args = func.get("arguments", "")
        if isinstance(raw_args, str) and raw_args.strip():
            try:
                tool_args = json.loads(raw_args)
            except Exception:
                pass
        if (
            isinstance(tool_args, dict)
            and len(tool_args) == 1
            and "kwargs" in tool_args
            and isinstance(tool_args.get("kwargs"), dict)
        ):
            tool_args = tool_args["kwargs"]
        if not isinstance(tool_args, dict):
            tool_args = {}

        # Stamp GenAI semconv tool attrs + workflow context on the
        # `agent-session-X.run_tool` activity span so each tool call is
        # filterable by tool_name / args_size / agent / session without
        # parsing the JSON payload.
        try:
            from src.telemetry.genai_attrs import (
                get_current_span,
                set_activity_attrs,
            )

            agent_slug = context.get("agentSlug") or getattr(self, "_agent_slug", None)
            agent_name = getattr(self.profile, "name", None) if hasattr(self, "profile") else None
            args_size = None
            if isinstance(raw_args, str):
                args_size = len(raw_args)
            set_activity_attrs(
                workflow_id=context.get("workflowId"),
                workflow_execution_id=exec_id,
                workflow_instance_id=inst_id,
                workflow_activity_correlation_id=context.get(
                    "workflowActivityCorrelationId"
                ),
                workflow_node_id=context.get("nodeId"),
                workflow_node_name=context.get("nodeName"),
                session_id=context.get("sessionId") or sess_id or exec_id,
                agent_id=context.get("agentId"),
                agent_version=context.get("agentVersion"),
                agent_slug=str(agent_slug) if agent_slug else None,
                agent_app_id=context.get("agentAppId"),
                mlflow_span_type="TOOL",
                extra={
                    "agent.name": agent_name,
                    "tool.name": tool_name,
                    "tool.call_id": tool_call_id,
                    "tool.args.size_chars": args_size,
                    "tool.args.keys": (
                        ",".join(sorted(tool_args.keys()))[:200]
                        if isinstance(tool_args, dict)
                        else None
                    ),
                    "sandbox.workspace_ref": context.get("workspaceRef"),
                    "sandbox.name": context.get("sandboxName"),
                    "sandbox.cwd": context.get("cwd"),
                    "gen_ai.operation.name": "execute_tool",
                    "gen_ai.tool.name": tool_name,
                    "agent.tool_call_index": self._tool_call_count_by_instance.get(inst_id),
                },
            )
        except Exception as _attr_exc:  # noqa: BLE001
            logger.debug("[genai-attrs] run_tool activity enrichment failed: %s", _attr_exc)
        import time as _time_tool

        tool_started_at = _time_tool.monotonic()

        def _tool_elapsed_ms() -> int:
            return int((_time_tool.monotonic() - tool_started_at) * 1000)

        # Phase B — tool call count + histogram + first-tool timestamp.
        # Increment unconditionally (before the allow-list check) because we
        # want the counter to reflect attempts including denied calls; the
        # histogram is keyed on tool_name so callers can audit policy hits.
        self._tool_call_count_by_instance[inst_id] = (
            self._tool_call_count_by_instance.get(inst_id, 0) + 1
        )
        hist = self._tool_histogram_by_instance.setdefault(inst_id, {})
        hist[tool_name] = hist.get(tool_name, 0) + 1
        if inst_id not in self._first_tool_at_by_instance:
            import time as _time

            self._first_tool_at_by_instance[inst_id] = _time.monotonic()

        if not self._is_tool_allowed_for_instance(inst_id, tool_name):
            reason = f"Tool {tool_name} is disabled by this run's tool policy"
            try:
                publish_session_event(
                    sess_id,
                    "tool_call_error",
                    {
                        "toolName": tool_name,
                        "success": False,
                        "error": reason[:200],
                        "duration_ms": _tool_elapsed_ms(),
                    },
                    source_event_id=f"{tool_call_id}:blocked" if tool_call_id else None,
                    instance_id=inst_id,
                )
            except Exception:
                pass
            blocked_msg = ToolMessage(
                content=reason,
                role="tool",
                name=tool_name,
                tool_call_id=tool_call.get("id", "") if isinstance(tool_call, dict) else "",
            )
            try:
                self.text_formatter.print_message(blocked_msg)
            except Exception:
                pass
            return blocked_msg.model_dump()

        # Telemetry: start claude_code.tool span for this activity.
        # run_tool runs as its own Dapr activity (different call from the
        # workflow body) so we re-seed session context and start a fresh
        # tool span here. tool_input is only serialized when beta tracing
        # is enabled (add_tool_input_attributes gates internally).
        _tel_session_token = None
        _tel_tool_span = None
        try:
            from src.telemetry import (
                end_tool_span,
                set_session_context,
                start_tool_span,
            )

            _tel_session_token = set_session_context(
                instance_id=inst_id,
                execution_id=exec_id,
                **_telemetry_context_kwargs(context),
            )
            _tool_input_json = ""
            try:
                _tool_input_json = json.dumps(tool_args)[:8192]
            except Exception:
                _tool_input_json = ""
            _tel_tool_span = start_tool_span(
                tool_name,
                tool_attributes={"tool.call_id": tool_call_id},
                tool_input=_tool_input_json,
            )
        except Exception as exc:  # noqa: BLE001
            logger.warning("[telemetry] tool span start failed: %s", exc)

        try:
          custom_hooks_enabled = self._custom_hooks_enabled_for_instance(inst_id, context)
          hook_snapshot = _current_hook_snapshot(self, inst_id)
          cwd_for_hooks = self._cwd_by_instance.get(inst_id, "") or ""
          project_dir_for_hooks = cwd_for_hooks or os.environ.get("CLAUDE_PROJECT_DIR") or os.getcwd()
          if custom_hooks_enabled:
            # claude_code.tool.blocked_on_user wraps PreToolUse gating — it
            # represents "tool waiting on a permission/approval decision". Ends
            # with decision=allow|deny|updated_input (mirrors TS).
            _blocked_span = None
            try:
                from src.telemetry import (
                    end_tool_blocked_on_user_span,
                    start_tool_blocked_on_user_span,
                )

                _blocked_span = start_tool_blocked_on_user_span()
            except Exception as exc:  # noqa: BLE001
                logger.warning("[telemetry] blocked_on_user start failed: %s", exc)
            _block_decision = "allow"
            try:
                pre_agg = execute_pre_tool_hooks(
                    hook_snapshot,
                    tool_name=tool_name,
                    tool_use_id=tool_call_id,
                    tool_input=tool_args,
                    session_id=inst_id,
                    cwd=cwd_for_hooks,
                    project_dir=project_dir_for_hooks,
                    permission_mode=str(context.get("permissionMode") or "") or None,
                )
            except Exception as hook_exc:
                logger.warning("[hooks] PreToolUse error: %s", hook_exc)
                pre_agg = None
            if pre_agg is not None:
                if pre_agg.updated_input is not None:
                    tool_args = dict(pre_agg.updated_input)
                    logger.info("[hooks] PreToolUse updated input for %s", tool_name)
                    _block_decision = "updated_input"
                if pre_agg.any_block():
                    reason = pre_agg.blocking_reason or pre_agg.decision_reason or "blocked by hook"
                    logger.info("[hooks] PreToolUse blocked %s: %s", tool_name, reason)
                    _block_decision = "deny"
                    try:
                        publish_session_event(
                            sess_id,
                            "tool_call_error",
                            {
                                "toolName": tool_name,
                                "success": False,
                                "error": f"blocked by hook: {reason}"[:200],
                                "duration_ms": _tool_elapsed_ms(),
                            },
                            source_event_id=f"{tool_call_id}:blocked" if tool_call_id else None,
                            instance_id=inst_id,
                        )
                    except Exception:
                        pass
                    blocked_msg = ToolMessage(
                        content=f"Tool {tool_name} blocked by hook: {reason}",
                        role="tool",
                        name=tool_name,
                        tool_call_id=tool_call["id"],
                    )
                    try:
                        self.text_formatter.print_message(blocked_msg)
                    except Exception:
                        pass
                    # Record code_edit_tool.decision counter for Edit/Write/NotebookEdit.
                    if tool_name in ("Edit", "Write", "NotebookEdit"):
                        try:
                            from src.telemetry import record_code_edit_decision

                            record_code_edit_decision(decision="reject", tool=tool_name)
                        except Exception:
                            pass
                    try:
                        if _blocked_span is not None:
                            end_tool_blocked_on_user_span(
                                _blocked_span,
                                decision="deny",
                                source="PreToolUse",
                            )
                    except Exception:
                        pass
                    return blocked_msg.model_dump()
            if _blocked_span is not None:
                try:
                    end_tool_blocked_on_user_span(
                        _blocked_span,
                        decision=_block_decision,
                        source="PreToolUse",
                    )
                except Exception:
                    pass
            if tool_name in ("Edit", "Write", "NotebookEdit") and _block_decision in ("allow", "updated_input"):
                try:
                    from src.telemetry import record_code_edit_decision

                    record_code_edit_decision(decision="accept", tool=tool_name)
                except Exception:
                    pass

          try:
              full_args = tool_args if isinstance(tool_args, dict) else {}
              args_data, args_oversized, args_size = _prepare_payload_with_preview(
                  full_args,
                  mode="json",
                  preview_len=300,
              )
              start_payload: dict[str, Any] = {
                  "toolName": tool_name,
                  "args": args_data,
                  "input_preview": _json_preview(full_args, 300),
              }
              if args_oversized:
                  start_payload["oversized"] = True
                  start_payload["size_bytes"] = args_size
                  # Preserve top-level keys as a hint even when the full blob
                  # was dropped — lets the UI show "keys: foo, bar" instead of
                  # "(oversized)".
                  start_payload["args"] = {
                      k: "[omitted: oversized]"
                      for k in full_args.keys()
                  }
              publish_session_event(
                  sess_id,
                  "tool_call_start",
                  start_payload,
                  source_event_id=f"{tool_call_id}:start" if tool_call_id else None,
                  instance_id=inst_id,
              )
          except Exception:
              pass
          # claude_code.tool.execution wraps the actual dispatch — the MCP
          # arun() call or super().run_tool(...) — so we capture how long the
          # real work takes separately from hook/approval overhead.
          _exec_span = None
          _exec_success = False
          _exec_error: str | None = None
          # Pre-bind so the finally block can read it even if the try raises
          # before assignment in either the MCP or super().run_tool branch.
          result: Any = None
          try:
              from src.telemetry import (
                  end_tool_execution_span,
                  start_tool_execution_span,
              )

              _exec_span = start_tool_execution_span()
          except Exception as exc:  # noqa: BLE001
              logger.warning("[telemetry] tool.execution start failed: %s", exc)
          try:
              self._activate_instance_skills(inst_id)
              if inst_id and not (self._mcp_tools_by_instance.get(inst_id) or {}):
                  self._ensure_mcp_client(inst_id)
              mcp_tool = (self._mcp_tools_by_instance.get(inst_id) or {}).get(
                  _normalize_tool_lookup_name(tool_name)
              )
              if mcp_tool is not None:
                  async def _execute_mcp_tool():
                      return await mcp_tool.arun(**tool_args)

                  mcp_source = (
                      self._mcp_tool_sources_by_instance.get(inst_id) or {}
                  ).get(_normalize_tool_lookup_name(tool_name), {})
                  import time as _time_mcp
                  mcp_start = _time_mcp.monotonic()
                  try:
                      mcp_result = self._run_asyncio_task(_execute_mcp_tool())
                      serialized_result = serialize_tool_result(mcp_result)
                      try:
                          publish_session_event(
                              sess_id,
                              "mcp.tool_call",
                              {
                                  "tool_name": tool_name,
                                  "tool_use_id": tool_call_id,
                                  "server": mcp_source.get("server"),
                                  "transport": mcp_source.get("transport"),
                                  "duration_ms": int(
                                      (_time_mcp.monotonic() - mcp_start) * 1000
                                  ),
                                  "success": True,
                              },
                              instance_id=inst_id,
                          )
                      except Exception:
                          pass
                  except Exception as exc:
                      error = str(exc)
                      _exec_error = error
                      try:
                          publish_session_event(
                              sess_id,
                              "mcp.tool_call",
                              {
                                  "tool_name": tool_name,
                                  "tool_use_id": tool_call_id,
                                  "server": mcp_source.get("server"),
                                  "transport": mcp_source.get("transport"),
                                  "duration_ms": int(
                                      (_time_mcp.monotonic() - mcp_start) * 1000
                                  ),
                                  "success": False,
                                  "error": error[:200],
                              },
                              instance_id=inst_id,
                          )
                      except Exception:
                          pass
                      try:
                          publish_session_event(
                              sess_id,
                              "tool_call_error",
                              {
                                  "toolName": tool_name,
                                  "success": False,
                                  "error": error[:200],
                                  "duration_ms": _tool_elapsed_ms(),
                              },
                              source_event_id=f"{tool_call_id}:error" if tool_call_id else None,
                              instance_id=inst_id,
                          )
                      except Exception:
                          pass
                      tool_result = ToolMessage(
                          content=f"Tool {tool_name} failed: {error}",
                          role="tool",
                          name=tool_name,
                          tool_call_id=tool_call["id"],
                      )
                      try:
                          self.text_formatter.print_message(tool_result)
                      except Exception:
                          pass
                      if _exec_span is not None:
                          try:
                              end_tool_execution_span(
                                  _exec_span, success=False, error=error[:200]
                              )
                              _exec_span = None
                          except Exception:
                              pass
                      return tool_result.model_dump()
                  tool_result = ToolMessage(
                      content=serialized_result,
                      role="tool",
                      name=tool_name,
                      tool_call_id=tool_call["id"],
                  )
                  try:
                      self.text_formatter.print_message(tool_result)
                  except Exception:
                      pass
                  result = tool_result.model_dump()
              else:
                  result = super().run_tool(ctx, payload)
              _exec_error = _tool_result_error(result)
              _exec_success = _exec_error is None
          except Exception as exc:
              _exec_error = str(exc)
              if custom_hooks_enabled:
                  try:
                      execute_post_tool_use_failure_hooks(
                          hook_snapshot,
                          tool_name=tool_name,
                          tool_use_id=tool_call_id,
                          tool_input=tool_args,
                          error=str(exc),
                          session_id=inst_id,
                          cwd=cwd_for_hooks,
                          project_dir=project_dir_for_hooks,
                      )
                  except Exception as hook_exc:
                      logger.warning("[hooks] PostToolUseFailure error: %s", hook_exc)
              try:
                  publish_session_event(
                      sess_id,
                      "tool_call_error",
                      {
                          "toolName": tool_name,
                          "success": False,
                          "error": str(exc)[:200],
                          "duration_ms": _tool_elapsed_ms(),
                      },
                      source_event_id=f"{tool_call_id}:error" if tool_call_id else None,
                      instance_id=inst_id,
                  )
              except Exception:
                  pass
              raise
          finally:
              if _exec_span is not None:
                  try:
                      _tool_output_for_span: str | None = None
                      if _exec_success and isinstance(result, dict):
                          _content = result.get("content")
                          if isinstance(_content, str):
                              _tool_output_for_span = _content
                          elif _content is not None:
                              try:
                                  _tool_output_for_span = json.dumps(_content, default=str)
                              except (TypeError, ValueError):
                                  _tool_output_for_span = str(_content)
                      end_tool_execution_span(
                          _exec_span,
                          success=_exec_success,
                          error=_exec_error[:200] if _exec_error else None,
                          tool_output=_tool_output_for_span,
                      )
                  except Exception:
                      pass
          # Extract tool output summary
          output = ""
          if isinstance(result, dict):
              raw = result.get("content", "")
              if isinstance(raw, str):
                  output = raw[:500]
          if custom_hooks_enabled and isinstance(result, dict):
              try:
                  post_agg = execute_post_tool_hooks(
                      hook_snapshot,
                      tool_name=tool_name,
                      tool_use_id=tool_call_id,
                      tool_input=tool_args,
                      tool_response=result.get("content"),
                      session_id=inst_id,
                      cwd=cwd_for_hooks,
                      project_dir=project_dir_for_hooks,
                  )
              except Exception as hook_exc:
                  logger.warning("[hooks] PostToolUse error: %s", hook_exc)
                  post_agg = None
              if post_agg is not None:
                  if post_agg.updated_tool_output is not None:
                      result = dict(result)
                      result["content"] = post_agg.updated_tool_output
                      output = post_agg.updated_tool_output[:500] if isinstance(post_agg.updated_tool_output, str) else output
                  elif post_agg.additional_contexts:
                      merged = dict(result)
                      suffix = "\n\n[hook context]\n" + "\n".join(post_agg.additional_contexts)
                      if isinstance(merged.get("content"), str):
                          merged["content"] = merged["content"] + suffix
                          result = merged
                          output = merged["content"][:500]
          checkpoint = None
          if should_checkpoint_tool(tool_name):
              try:
                  with _start_checkpoint_span(tool_name, tool_call_id) as _span:
                      checkpoint = capture_code_checkpoint(
                          get_runtime(),
                          execution_id=exec_id,
                          instance_id=inst_id,
                          workspace_ref=self._workspace_ref_by_instance.get(inst_id),
                          tool_call_id=tool_call_id,
                          tool_name=tool_name,
                      )
                      if _span is not None and isinstance(checkpoint, dict):
                          try:
                              _span.set_attribute("checkpoint.status", str(checkpoint.get("status") or ""))
                              _span.set_attribute("checkpoint.beforeSha", str(checkpoint.get("beforeSha") or ""))
                              _span.set_attribute("checkpoint.afterSha", str(checkpoint.get("afterSha") or ""))
                              _span.set_attribute("checkpoint.remoteStatus", str(checkpoint.get("remoteStatus") or ""))
                              _span.set_attribute("checkpoint.fileCount", int(checkpoint.get("fileCount") or 0))
                              remote_err = checkpoint.get("remoteError")
                              if remote_err:
                                  _span.set_attribute("checkpoint.remoteError", str(remote_err)[:500])
                          except Exception:
                              pass
              except Exception as exc:
                  logger.warning("[checkpoint] failed after %s: %s", tool_name, exc)
          try:
              full_output = output or ""
              output_data, output_oversized, output_size = _prepare_payload_with_preview(
                  full_output,
                  mode="text",
                  preview_len=500,
              )
              payload: dict[str, Any] = {
                  "toolName": tool_name,
                  "success": _exec_error is None,
                  "output": output_data,
                  "output_preview": (full_output[:500] if isinstance(full_output, str) else ""),
                  "duration_ms": _tool_elapsed_ms(),
              }
              if _exec_error:
                  payload["error"] = _exec_error
                  payload["is_error"] = True
              if output_oversized:
                  payload["oversized"] = True
                  payload["size_bytes"] = output_size
              if checkpoint is not None:
                  payload["codeCheckpoint"] = checkpoint
              publish_session_event(
                  sess_id,
                  "tool_call_end",
                  payload,
                  source_event_id=f"{tool_call_id}:end" if tool_call_id else None,
                  instance_id=inst_id,
              )
          except Exception:
              pass
          # Record the SUCCESSFUL result for run_tool idempotency so a later
          # retry/replay of this same (instance_id, tool_call_id) short-circuits
          # without re-executing the side effect. Failed results are NOT cached
          # (they must stay retryable).
          if (
              tool_call_id
              and tool_idempotency_enabled()
              and _exec_error is None
              and isinstance(result, dict)
          ):
              try:
                  self._tool_result_cache.put(inst_id, tool_call_id, result)
              except Exception as exc:  # noqa: BLE001
                  logger.warning("[tool-idempotency] cache put failed: %s", exc)
          return result
        finally:
            try:
                reset_runtime(runtime_token)
            except Exception as exc:  # noqa: BLE001
                logger.warning("[runtime-context] reset failed after tool: %s", exc)
            # End claude_code.tool span + reset session context. Fires on every
            # exit path (successful return, exception, blocked-by-hook return).
            try:
                if _tel_tool_span is not None:
                    # Pass the tool's return value so obs.tool_spans.ToolResult
                    # (+ the claude_code.tool output.value) populate. `result` is
                    # only bound on the success path → locals().get is exception-safe.
                    _tool_result_json = None
                    _res_for_span = locals().get("result")
                    if _res_for_span is not None:
                        try:
                            _tool_result_json = json.dumps(_res_for_span, default=str)[:16384]
                        except Exception:
                            _tool_result_json = str(_res_for_span)[:16384]
                    end_tool_span(tool_result=_tool_result_json)
                from src.telemetry.attributes import reset_session_context

                if _tel_session_token is not None:
                    reset_session_context(_tel_session_token)
            except Exception as exc:  # noqa: BLE001
                logger.warning("[telemetry] tool span end failed: %s", exc)

    @workflow_entry
    @message_router(message_model=TriggerAction)
    def agent_workflow(self, ctx, message: dict):
        metadata = _parse_metadata(message.get("metadata")) | _parse_metadata(
            message.get("_message_metadata")
        )
        mlflow_context = (
            message.get("mlflowContext")
            if isinstance(message.get("mlflowContext"), dict)
            else metadata.get("mlflowContext")
            if isinstance(metadata.get("mlflowContext"), dict)
            else {}
        )
        if not ctx.is_replaying and mlflow_context:
            try:
                from src.telemetry.providers import set_mlflow_trace_experiment_for_context

                set_mlflow_trace_experiment_for_context(
                    str(
                        mlflow_context.get("traceExperimentId")
                        or mlflow_context.get("experimentId")
                        or ""
                    )
                )
            except Exception as exc:  # noqa: BLE001
                logger.debug("[telemetry] MLflow context destination skipped: %s", exc)
        sandbox_name = (
            str(message.get("sandboxName") or metadata.get("sandboxName") or "").strip()
            or _sandbox_name_from_workspace_ref(
                str(message.get("workspaceRef") or metadata.get("workspace_ref") or "")
            )
        )
        cwd = str(message.get("cwd") or metadata.get("cwd") or "").strip()
        session_id_raw = str(message.get("sessionId") or "").strip()

        # Keep the durable workflow body free of ContextVar binding. Dapr may
        # replay/resume the generator in a different Python context, while
        # activities bind their own runtime from the persisted per-instance
        # context before touching tools.
        runtime = OpenShellRuntime()
        runtime.set_sandbox_name(sandbox_name)
        runtime.set_cwd(cwd or DEFAULT_CWD)
        runtime.set_session_id(session_id_raw or None)
        code_checkpoint_restore = _extract_code_checkpoint_restore(message, metadata)

        if code_checkpoint_restore and not ctx.is_replaying:
            restore_result = restore_code_checkpoint(runtime, code_checkpoint_restore)
            try:
                _ctx_inst = getattr(ctx, "instance_id", None) or ""
                publish_session_event(
                    self._session_id_by_instance.get(_ctx_inst),
                    "state_snapshot",
                    {
                        "phase": "code_checkpoint_restore",
                        "success": bool(restore_result.get("ok")),
                        "codeCheckpointRestore": {
                            "checkpointId": code_checkpoint_restore.get("checkpointId"),
                            "afterSha": code_checkpoint_restore.get("afterSha"),
                            "remoteRef": code_checkpoint_restore.get("remoteRef"),
                            "repoPath": code_checkpoint_restore.get("repoPath"),
                        },
                        "result": restore_result,
                    },
                    source_event_id=f"restore:{code_checkpoint_restore.get('checkpointId') or code_checkpoint_restore.get('afterSha') or 'checkpoint'}",
                    instance_id=_ctx_inst,
                )
            except Exception:
                pass
            if not restore_result.get("ok"):
                raise RuntimeError(
                    f"Code checkpoint restore failed: {restore_result.get('error') or restore_result}"
                )
            restored_repo_path = str(code_checkpoint_restore.get("repoPath") or "").strip()
            if restored_repo_path:
                runtime.set_cwd(restored_repo_path)

        # Per-run instruction bundle from agentConfig + runtime context. Named
        # agents carry persona inside agentConfig; systemPrompt no longer
        # suppresses role/goal/instructions because the composer renders all
        # persona fields into one ordered system message.
        agent_config = _coerce_agent_config(message.get("agentConfig")) or {}
        effective_config = _parse_metadata(message.get("effectiveAgentConfig"))
        effective_fields = effective_audit_fields(effective_config)
        allowed_tools = _allowed_tools_from_agent_config(agent_config)
        previous_prompt_state = _capture_prompt_state(self)
        platform_system_sections = [_build_system_prompt(runtime.cwd, sandbox_name or None)]
        hook_contexts: list[str] = []
        instruction_bundle: dict[str, Any] = {}
        # Replay-safe: ctx.current_utc_datetime is captured at workflow start
        # and reused across replays, so the bundle hash stays deterministic.
        try:
            turn_date = ctx.current_utc_datetime.date().isoformat()
        except Exception:
            turn_date = None

        def refresh_instruction_bundle() -> None:
            nonlocal instruction_bundle
            instruction_bundle = _compose_turn_instruction_bundle(
                agent_config=agent_config,
                message=message,
                prompt=str(message.get("task") or message.get("prompt") or ""),
                cwd=runtime.cwd,
                sandbox_name=sandbox_name or None,
                platform_system_sections=platform_system_sections,
                hook_context="\n\n".join(hook_contexts) if hook_contexts else None,
                current_date=turn_date,
            )
            _apply_instruction_prompt_state(self, instruction_bundle)

        refresh_instruction_bundle()

        max_iterations = (
            _parse_int(message.get("maxIterations"))
            or _parse_int(message.get("maxTurns"))
            or _parse_int(metadata.get("maxIterations"))
            or _parse_int(metadata.get("maxTurns"))
        )
        instance_id = getattr(ctx, "instance_id", None) or ""
        requested_agent_workflow_mode = str(
            message.get("agentWorkflowMode") or metadata.get("agentWorkflowMode") or ""
        ).strip()
        strict_one_shot_agent_turn = (
            requested_agent_workflow_mode == "strict_sequential"
            or is_swebench_execution_context(instance_id, message)
        )
        custom_hooks_enabled = hooks_enabled() and not strict_one_shot_agent_turn

        # Prepend only non-overlapping context (cwd/sandbox are now in system prompt)
        task = message.get("task") or message.get("prompt")
        if isinstance(task, str):
            context_lines = []
            if message.get("workspaceRef"):
                context_lines.append(f"Workspace ref: {message.get('workspaceRef')}")
            stop_condition = message.get("stopCondition")
            if isinstance(stop_condition, str) and stop_condition.strip():
                context_lines.append(f"Stop condition: {stop_condition.strip()}")
            if context_lines:
                message = {
                    **message,
                    "task": "Execution context:\n"
                    + "\n".join(f"- {line}" for line in context_lines)
                    + "\n\n"
                    + task,
                }

        # Inject plan from PLAN.md if it exists in the sandbox.
        # Mirrors claude-code-src plan_file_reference attachment
        # (messages.ts:3636-3642): the plan content is prepended to the
        # user's first message so the agent has it in context without
        # needing an extra Read tool call.
        #
        # Guard with is_replaying: the sandbox read is a side effect that
        # should only happen on the initial execution, not on durable
        # workflow replays. The injected task is already persisted in the
        # workflow state after the first run.
        if not strict_one_shot_agent_turn and not ctx.is_replaying:
            try:
                plan_path = runtime.resolve_path("PLAN.md")
                plan_result = runtime.read_text(plan_path)
                if plan_result.get("ok") and plan_result.get("content"):
                    plan_content = str(plan_result["content"])
                    plan_injection = (
                        f"A plan file exists at PLAN.md\n\n"
                        f"Plan contents:\n\n{plan_content}\n\n"
                        f"If this plan is relevant to the current work "
                        f"and not already complete, continue working on it."
                    )
                    current_task = message.get("task") or message.get("prompt") or ""
                    if isinstance(current_task, str):
                        message = {
                            **message,
                            "task": plan_injection + "\n\n" + current_task,
                        }
                        logger.info(
                            "[plan] Injected PLAN.md (%d chars) into task",
                            len(plan_content),
                        )
            except Exception:
                pass  # No PLAN.md = first phase or no plan written

        # Select LLM component from the per-turn snapshot when present; fall
        # back to agentConfig.modelSpec or metadata.model for legacy callers.
        snapshot_llm = (
            effective_config.get("llm")
            if isinstance(effective_config, dict)
            and isinstance(effective_config.get("llm"), dict)
            else {}
        )
        llm_component = (
            str(snapshot_llm.get("llmComponent") or "").strip()
            or _resolve_llm_component(message, metadata)
        )
        previous_component = self.llm._llm_component
        self.llm._llm_component = llm_component
        if not ctx.is_replaying:
            logger.info("[model-select] Using LLM component: %s", llm_component)
            logger.info("[metadata] model=%s", metadata.get("model"))

        previous_max_iterations = self.execution.max_iterations
        if max_iterations:
            self.execution.max_iterations = max_iterations

        # Derive execution context for event streaming
        # Prefer db_execution_id (the workflow-builder database ID used by the UI)
        # over execution_id (the orchestrator's internal ID with sw-*-exec- prefix).
        execution_id = (
            str(message.get("dbExecutionId") or "").strip()
            or str(message.get("workflowExecutionId") or "").strip()
            or str(message.get("executionId") or "").strip()
            or metadata.get("db_execution_id")
            or metadata.get("dbExecutionId")
            or metadata.get("parentExecutionId")
            or metadata.get("parent_execution_id")
            or metadata.get("executionId")
            or metadata.get("execution_id")
            or instance_id
        )

        # Stash for activity overrides (call_llm, run_tool)
        self._exec_id = execution_id
        self._inst_id = instance_id

        mlflow_session_id = str(
            mlflow_context.get("mlflowSessionId")
            or message.get("mlflowSessionId")
            or session_id_raw
            or ""
        ).strip()
        turn_id = str(
            message.get("turnId")
            or mlflow_context.get("turnId")
            or instance_id
            or ""
        ).strip()
        if not ctx.is_replaying and mlflow_context:
            try:
                from src.telemetry.dapr_attributes import set_mlflow_trace_tags

                trace_tags: dict[str, Any] = {
                    "session.id": mlflow_session_id or session_id_raw,
                    "agent.session.id": session_id_raw,
                    "workflow_builder.session_id": session_id_raw,
                    "workflow_builder.mlflow_session_id": mlflow_session_id,
                    "workflow_builder.turn_id": turn_id,
                    "dapr.workflow.instance_id": instance_id,
                    "workflow.execution.id": execution_id,
                    "mlflow.run_id": mlflow_context.get("runId"),
                    "mlflow.parent_run_id": mlflow_context.get("parentRunId"),
                    "mlflow.modelId": mlflow_context.get("activeModelId"),
                    "mlflow.model.uri": mlflow_context.get("activeModelUri"),
                }
                set_mlflow_trace_tags(
                    trace_tags,
                    trace_name=f"agent.{message.get('agentSlug') or agent_config.get('slug') or 'unknown'}/turn.{turn_id or instance_id}",
                )
            except Exception as exc:  # noqa: BLE001
                logger.debug("[telemetry] turn trace-tag set failed: %s", exc)

        # Phase 4 bridge: when session_workflow spawns agent_workflow, it
        # inlines sessionId into the child's message dict. Stash per-instance
        # so activities can pass it to publish_session_event.
        if session_id_raw:
            self._session_id_by_instance[instance_id] = session_id_raw

        # Phase B — record effective max_iterations for activities, plus the
        # first non-replay start timestamp for latency metrics.
        self._max_iterations_by_instance[instance_id] = (
            max_iterations or self.execution.max_iterations or 0
        )
        if not ctx.is_replaying:
            import time as _time

            self._workflow_started_at_by_instance[instance_id] = _time.monotonic()

        # Set telemetry session context and start interaction span (first
        # non-replay tick only). Span end + context reset happen in the
        # workflow body's `try/finally` below, also gated on non-replay.
        if not ctx.is_replaying:
            try:
                from src.telemetry import (
                    log_otel_event,
                    record_session_start,
                    set_session_context,
                    start_interaction_span,
                )

                # Phase 3a v2: extract Prompt Workbench preset bindings from
                # the BFF-provided `agentConfig.promptPresetManifest` so the
                # interaction span can stamp `tag.prompt_version_id` /
                # `tag.prompt_version`. Single-string tag values; comma-joined
                # when an agent binds multiple presets.
                _prompt_manifest = agent_config.get("promptPresetManifest") if isinstance(
                    agent_config, dict
                ) else None
                _prompt_version_ids: list[str] = []
                _prompt_version_uris: list[str] = []
                if isinstance(_prompt_manifest, list):
                    for _entry in _prompt_manifest:
                        if not isinstance(_entry, dict):
                            continue
                        _pvid = _entry.get("promptVersionId") or _entry.get("prompt_version_id")
                        if isinstance(_pvid, str) and _pvid.strip():
                            _prompt_version_ids.append(_pvid.strip())
                        _uri = _entry.get("mlflowUri") or _entry.get("mlflow_uri")
                        if isinstance(_uri, str) and _uri.strip():
                            _prompt_version_uris.append(_uri.strip())
                tok = set_session_context(
                    instance_id=instance_id,
                    execution_id=execution_id,
                    workflow_id=str(message.get("workflowId") or ""),
                    workflow_node_id=str(message.get("nodeId") or ""),
                    workflow_node_name=str(
                        message.get("nodeName") or message.get("nodeId") or ""
                    ),
                    agent_id=str(message.get("agentId") or agent_config.get("id") or ""),
                    agent_version=message.get("agentVersion") or agent_config.get("version"),
                    agent_slug=str(message.get("agentSlug") or agent_config.get("slug") or ""),
                    agent_app_id=str(
                        message.get("agentAppId") or agent_config.get("agentAppId") or ""
                    ),
                    sandbox_name=str(message.get("sandboxName") or ""),
                    workspace_ref=str(message.get("workspaceRef") or ""),
                    turn=effective_fields.get("turn"),
                    config_revision=effective_fields.get("configRevision"),
                    config_hash=effective_fields.get("configHash"),
                    instruction_hash=effective_fields.get("instructionHash"),
                    model_spec=effective_fields.get("modelSpec"),
                    llm_component=effective_fields.get("llmComponent"),
                    mlflow_model_id=str(mlflow_context.get("activeModelId") or ""),
                    mlflow_model_uri=str(mlflow_context.get("activeModelUri") or ""),
                    mlflow_experiment_id=str(
                        mlflow_context.get("traceExperimentId")
                        or mlflow_context.get("experimentId")
                        or ""
                    ),
                    mlflow_run_id=str(mlflow_context.get("runId") or ""),
                    mlflow_parent_run_id=str(mlflow_context.get("parentRunId") or ""),
                    mlflow_session_id=str(
                        mlflow_context.get("mlflowSessionId")
                        or message.get("mlflowSessionId")
                        or session_id_raw
                        or ""
                    ),
                    turn_id=str(message.get("turnId") or ""),
                    prompt_version_ids=tuple(_prompt_version_ids),
                    prompt_version_uris=tuple(_prompt_version_uris),
                )
                self._interaction_ctx_token_by_instance[instance_id] = tok
                task_text = str(message.get("task") or message.get("prompt") or "")
                span = start_interaction_span(task_text)
                if span is not None:
                    self._interaction_span_by_instance[instance_id] = span
                record_session_start()
                # user_prompt event (mirrors TS processTextPrompt.ts call site).
                # Content is only included when OTEL_LOG_USER_PROMPTS=1.
                from src.telemetry.events import is_user_prompt_logging_enabled

                _user_prompt_event_attrs = {
                    "prompt_length": len(task_text),
                    "prompt": task_text if is_user_prompt_logging_enabled() else "<REDACTED>",
                }
                log_otel_event("user_prompt", _user_prompt_event_attrs)
                # Mirror the log record into a span event on the
                # claude_code.interaction span so the MLflow Trace UI's
                # Events tab and Phoenix render the prompt inline. The
                # log signal still ships independently.
                if span is not None:
                    try:
                        span.add_event(
                            "claude_code.user_prompt",
                            attributes={
                                k: str(v) for k, v in _user_prompt_event_attrs.items() if v is not None
                            },
                        )
                    except Exception:
                        pass
            except Exception as exc:  # noqa: BLE001
                logger.warning("[telemetry] interaction start failed: %s", exc)
        workspace_ref = str(
            message.get("workspaceRef")
            or metadata.get("workspaceRef")
            or metadata.get("workspace_ref")
            or ""
        ).strip()
        if workspace_ref:
            self._workspace_ref_by_instance[instance_id] = workspace_ref
        mcp_configs, mcp_allowed_tools = _extract_mcp_server_configs(message)
        if mcp_configs:
            self._mcp_configs_by_instance[instance_id] = mcp_configs
            self._mcp_allowed_tools_by_instance[instance_id] = mcp_allowed_tools
            logger.info(
                "[mcp] Registered %d MCP server config(s) for instance %s",
                len(mcp_configs),
                instance_id,
            )
        # Extract per-instance callable peer-agent allow-list. The TypeScript
        # resolver emits `body.callableAgents: [{slug, agentId, appId, team,
        # registryKey}, ...]` when the agent's AgentConfig.callableAgents is
        # non-empty; we stash it in a thread-local so the `call_agent` tool
        # (src/tools/call_agent) can find it when the LLM invokes it.
        try:
            from src.tools._callable_agents_context import (
                set_callable_agents_context,
            )

            raw_callable = message.get("callableAgents") or agent_config.get(
                "callableAgents"
            )
            if isinstance(raw_callable, list):
                callable_agents = [
                    item for item in raw_callable if isinstance(item, dict)
                ]
            else:
                callable_agents = []
            registry_team = (
                str(message.get("registryTeam") or "").strip()
                or str(agent_config.get("registryTeam") or "").strip()
                or None
            )
            set_callable_agents_context(
                callable_agents=callable_agents,
                registry_team=registry_team,
                parent_instance_id=instance_id,
                parent_session_id=session_id_raw or None,
            )
            if callable_agents and not ctx.is_replaying:
                logger.info(
                    "[call_agent] %d peer agent(s) available for instance %s: %s",
                    len(callable_agents),
                    instance_id,
                    ", ".join(
                        str(p.get("slug", "?")) for p in callable_agents
                    ),
                )
        except Exception as exc:  # noqa: BLE001
            logger.warning("[call_agent] context setup failed: %s", exc)
        # Extract per-instance skill configs (parallel to MCP extraction)
        skill_registry = get_skill_registry()
        raw_skill_items = _extract_raw_skill_items(message)
        runtime_skill_refs = _extract_runtime_skill_refs(message)
        instance_skill_defs = (
            _install_runtime_skill_refs(runtime, instance_id, runtime_skill_refs)
            if runtime_skill_refs and not ctx.is_replaying
            else []
        )
        if not instance_skill_defs:
            instance_skill_defs = _extract_skill_configs(message)
        if instance_skill_defs:
            instance_skill_defs = _materialize_instance_skill_packages(
                runtime,
                instance_skill_defs,
                instance_id,
                raw_skill_items,
                write_files=not ctx.is_replaying,
            )
            self._skills_by_instance[instance_id] = instance_skill_defs
            skill_registry.set_instance_skills(instance_skill_defs)
            logger.info(
                "[skills] Registered %d instance skill(s) for instance %s: %s",
                len(instance_skill_defs),
                instance_id,
                ", ".join(skill.name for skill in instance_skill_defs),
            )
        elif runtime_skill_refs and ctx.is_replaying:
            cached_skill_defs = self._skills_by_instance.get(instance_id) or []
            if not cached_skill_defs:
                try:
                    cached_skill_defs = _scan_runtime_skill_install_root(
                        runtime,
                        _runtime_skill_run_dir(instance_id),
                        runtime_skill_refs,
                    )
                except Exception as exc:
                    logger.warning(
                        "[skills] Failed to re-scan runtime skills for replayed instance %s: %s",
                        instance_id,
                        exc,
                    )
            if cached_skill_defs:
                self._skills_by_instance[instance_id] = cached_skill_defs
                skill_registry.set_instance_skills(cached_skill_defs)
                logger.info(
                    "[skills] Re-activated %d cached skill(s) for replayed instance %s: %s",
                    len(cached_skill_defs),
                    instance_id,
                    ", ".join(skill.name for skill in cached_skill_defs),
                )

        # Append skill listings to system prompt so the model knows what's available
        available_skills = skill_registry.list_available()
        if available_skills:
            skill_listing_block = format_skill_listings(available_skills)
            if skill_listing_block:
                platform_system_sections.append(skill_listing_block)
                refresh_instruction_bundle()

        if not ctx.is_replaying:
            logger.info("[exec-id] execution_id=%s instance_id=%s", execution_id, instance_id)

        # run_started is suppressed in the session stream — session_workflow's
        # session.status_running event is the canonical equivalent. No emit here.

        # Resolve per-run compaction config from agentConfig.compaction and
        # stash it on the agent so call_llm can pass it to maybe_compact.
        # This runs inside the orchestrator body; config is deterministic
        # for replay because it's derived from the trigger message which
        # is itself replayed.
        try:
            from src.compaction import resolve_config as _resolve_compaction_cfg

            self._compaction_cfg_by_instance[instance_id] = _resolve_compaction_cfg(message)
            self._compaction_call_count_by_instance.setdefault(instance_id, 0)
            self._compaction_runs_by_instance.setdefault(instance_id, 0)
        except Exception as exc:  # noqa: BLE001
            logger.warning("[compaction] config resolution failed: %s", exc)

        # Capture per-instance hooks snapshot (overlay per-run hooks/plugins
        # from agentConfig). Pure, deterministic — safe inside the workflow fn.
        if custom_hooks_enabled:
            effective_cwd = runtime.cwd or cwd or ""
            self._cwd_by_instance[instance_id] = effective_cwd
            try:
                base_snap = getattr(self, "_base_hooks_snapshot", None) or empty_snapshot()
                per_run_snap = _apply_per_run_hooks(
                    base_snap,
                    message,
                    plugin_registry=getattr(self, "_plugin_registry", None),
                )
                _install_hook_snapshot(self, instance_id, per_run_snap)
            except Exception as exc:
                logger.warning("[hooks] failed to build per-instance snapshot: %s", exc)

            # SessionStart + UserPromptSubmit hooks — fire on first execution only.
            # Follows the same non-durable pattern as PLAN.md injection above.
            if not ctx.is_replaying:
                snap = _current_hook_snapshot(self, instance_id)
                project_dir_hook = runtime.cwd or cwd or os.environ.get("CLAUDE_PROJECT_DIR") or os.getcwd()
                try:
                    start_agg = execute_session_start_hooks(
                        snap,
                        source="startup",
                        session_id=instance_id,
                        cwd=runtime.cwd or cwd or "",
                        project_dir=project_dir_hook,
                    )
                    if start_agg.additional_contexts:
                        hook_contexts.extend(start_agg.additional_contexts)
                        refresh_instruction_bundle()
                    if start_agg.initial_user_message and isinstance(message.get("task"), str):
                        message = {
                            **message,
                            "task": start_agg.initial_user_message + "\n\n" + str(message.get("task") or ""),
                        }
                        refresh_instruction_bundle()
                    if start_agg.any_block():
                        raise RuntimeError(
                            f"SessionStart hook blocked workflow: "
                            f"{start_agg.blocking_reason or start_agg.decision_reason or 'blocked'}"
                        )
                except RuntimeError:
                    raise
                except Exception as exc:
                    logger.warning("[hooks] SessionStart error: %s", exc)

                prompt_text = str(message.get("task") or message.get("prompt") or "")
                if prompt_text:
                    try:
                        submit_agg = execute_user_prompt_submit_hooks(
                            snap,
                            prompt=prompt_text,
                            session_id=instance_id,
                            cwd=runtime.cwd or cwd or "",
                            project_dir=project_dir_hook,
                        )
                        if submit_agg.additional_contexts:
                            message = {
                                **message,
                                "task": (message.get("task") or "")
                                + "\n\n"
                                + "\n\n".join(submit_agg.additional_contexts),
                            }
                            refresh_instruction_bundle()
                        if submit_agg.any_block():
                            raise RuntimeError(
                                f"UserPromptSubmit hook blocked workflow: "
                                f"{submit_agg.blocking_reason or submit_agg.decision_reason or 'blocked'}"
                            )
                    except RuntimeError:
                        raise
                    except Exception as exc:
                        logger.warning("[hooks] UserPromptSubmit error: %s", exc)

        effective_cwd = runtime.cwd or cwd or DEFAULT_CWD
        self._cwd_by_instance[instance_id] = effective_cwd
        refresh_instruction_bundle()
        instruction_agent = (
            instruction_bundle.get("agent")
            if isinstance(instruction_bundle.get("agent"), dict)
            else {}
        )
        runtime_context = {
            "executionId": execution_id,
            "workflowExecutionId": (
                message.get("workflowExecutionId")
                or message.get("dbExecutionId")
                or metadata.get("workflowExecutionId")
                or execution_id
            ),
            "workflowId": message.get("workflowId") or metadata.get("workflowId"),
            "workflowActivityCorrelationId": (
                message.get("workflowActivityCorrelationId")
                or metadata.get("workflowActivityCorrelationId")
            ),
            "nodeId": message.get("nodeId") or metadata.get("nodeId"),
            "nodeName": (
                message.get("nodeName")
                or metadata.get("nodeName")
                or message.get("nodeId")
                or metadata.get("nodeId")
            ),
            "agentId": message.get("agentId") or instruction_agent.get("id") or agent_config.get("id"),
            "agentVersion": message.get("agentVersion") or instruction_agent.get("version") or agent_config.get("version"),
            "agentSlug": (
                message.get("agentSlug")
                or instruction_agent.get("slug")
                or agent_config.get("slug")
            ),
            "agentAppId": (
                message.get("agentAppId")
                or agent_config.get("agentAppId")
                or os.environ.get("APP_ID")
                or os.environ.get("DAPR_APP_ID")
            ),
            "sandboxName": sandbox_name or None,
            "cwd": effective_cwd,
            "sessionId": session_id_raw or None,
            "workspaceRef": workspace_ref or None,
            "llmComponent": llm_component,
            "modelSpec": effective_fields.get("modelSpec"),
            "providerModel": effective_fields.get("providerModel"),
            "configHash": effective_fields.get("configHash"),
            "turn": effective_fields.get("turn"),
            "configRevision": effective_fields.get("configRevision"),
            "effectiveAgentConfig": effective_config,
            "instructionBundle": instruction_bundle,
            "instructionHash": instruction_bundle.get("instructionHash"),
            "templateName": instruction_bundle.get("templateName"),
            "templateHash": instruction_bundle.get("templateHash"),
            "systemPrompt": self.profile.system_prompt,
            "permissionMode": agent_config.get("permissionMode"),
            "allowedTools": sorted(allowed_tools),
            "agentWorkflowMode": (
                requested_agent_workflow_mode if requested_agent_workflow_mode else None
            ),
        }
        self._remember_runtime_context(instance_id, runtime_context)
        yield ctx.call_activity(
            self._activity_name(self.seed_runtime_context_for_instance),
            input={"instance_id": instance_id, "context": runtime_context},
        )

        metrics_emitted = False
        workflow_terminal = False

        def emit_metrics_summary_once() -> None:
            nonlocal metrics_emitted
            if metrics_emitted or ctx.is_replaying:
                return
            metrics_emitted = True
            try:
                reason = self._termination_reason_by_instance.get(instance_id)
                turn_count = self._turn_count_by_instance.get(instance_id, 0)
                max_iters = self._max_iterations_by_instance.get(instance_id, 0)
                if reason is None:
                    reason = (
                        "max_iters"
                        if (max_iters and turn_count >= max_iters)
                        else "end_turn"
                    )
                started_at = self._workflow_started_at_by_instance.get(instance_id)
                first_token_at = self._first_token_at_by_instance.get(instance_id)
                first_tool_at = self._first_tool_at_by_instance.get(instance_id)
                ttft_first_ms = (
                    int((first_token_at - started_at) * 1000)
                    if started_at and first_token_at
                    else None
                )
                ttft_first_tool_ms = (
                    int((first_tool_at - started_at) * 1000)
                    if started_at and first_tool_at
                    else None
                )
                metrics_turn = effective_fields.get("turn") or runtime_context.get("turn")
                publish_session_event(
                    self._session_id_by_instance.get(instance_id),
                    "instance.metrics_summary",
                    {
                        "turn": metrics_turn,
                        "turnId": runtime_context.get("turnId"),
                        "agentWorkflowMode": "session-native"
                        if runtime_context.get("sessionId")
                        else None,
                        "workflowInstanceId": instance_id,
                        "turn_count": turn_count,
                        "tool_call_count": self._tool_call_count_by_instance.get(
                            instance_id,
                            0,
                        ),
                        "tool_histogram": dict(
                            self._tool_histogram_by_instance.get(instance_id, {})
                        ),
                        "termination_reason": reason,
                        "ttft_first_ms": ttft_first_ms,
                        "ttft_first_tool_ms": ttft_first_tool_ms,
                        "max_iterations": max_iters or None,
                    },
                    source_event_id=f"{instance_id}:turn:{metrics_turn or 'unknown'}:metrics_summary",
                    instance_id=instance_id,
                )
            except Exception as exc:  # noqa: BLE001
                logger.warning(
                    "[metrics] failed to emit instance.metrics_summary: %s",
                    exc,
                )
            finally:
                self._turn_count_by_instance.pop(instance_id, None)
                self._tool_call_count_by_instance.pop(instance_id, None)
                self._tool_histogram_by_instance.pop(instance_id, None)
                self._termination_reason_by_instance.pop(instance_id, None)
                self._first_token_at_by_instance.pop(instance_id, None)
                self._first_tool_at_by_instance.pop(instance_id, None)
                self._workflow_started_at_by_instance.pop(instance_id, None)
                self._max_iterations_by_instance.pop(instance_id, None)
                try:
                    self._tool_result_cache.clear_instance(instance_id)
                except Exception:
                    pass

        agent_workflow_result = None
        try:
            # In dapr-agents 1.0.1 the base agent_workflow generator returns
            # the final assistant message via `return final_message`.
            # `yield from` evaluates to the subgenerator's return value, so
            # capture it; session_workflow relies on it flowing out as the
            # per-turn result (and CallAgent's tool_result content ultimately
            # comes from this dict's "content" field).
            requested_agent_workflow_mode = str(
                requested_agent_workflow_mode
                or runtime_context.get("agentWorkflowMode")
                or ""
            ).strip()
            force_repo_sequential = (
                strict_one_shot_agent_turn
                or requested_agent_workflow_mode == "strict_sequential"
                or is_swebench_execution_context(instance_id, runtime_context)
            )
            if (
                force_repo_sequential
                or (
                    getattr(self.execution, "tool_execution_mode", None)
                    == ToolExecutionMode.SEQUENTIAL
                    and not _native_tool_hooks_configured(self)
                )
            ):
                agent_workflow_result = yield from self._agent_workflow_strict_sequential(
                    ctx,
                    message,
                    force_repo_sequential=force_repo_sequential,
                )
            else:
                agent_workflow_result = yield from super().agent_workflow(ctx, message)
            workflow_terminal = True

            # After agent completes, check for PLAN.md and persist full content
            # to Dapr state store (mirrors Claude Code's file-based plan persistence).
            # This is intentionally disabled for strict/SWE-bench one-shot turns:
            # it is custom wrapper I/O outside the durable agent's core activity
            # sequence and is not needed for benchmark capacity runs.
            if not strict_one_shot_agent_turn and not ctx.is_replaying:
                try:
                    plan_path = runtime.resolve_path("PLAN.md")
                    logger.info("[plan] Attempting to read %s from sandbox %s", plan_path, sandbox_name)
                    plan_result = runtime.read_text(plan_path)
                    logger.info("[plan] read_text result: ok=%s, has_content=%s",
                                plan_result.get("ok"), bool(plan_result.get("content")))
                    if plan_result.get("ok") and plan_result.get("content"):
                        plan_content = str(plan_result["content"])
                        _save_plan_to_state(execution_id, plan_content)
                        publish_session_event(
                            self._session_id_by_instance.get(instance_id),
                            "plan_artifact",
                            {"content": plan_content, "file": "PLAN.md"},
                            instance_id=instance_id,
                        )
                        logger.info(
                            "[plan] Persisted PLAN.md (%d chars) to state store for %s",
                            len(plan_content),
                            execution_id,
                        )
                    elif not plan_result.get("ok"):
                        logger.info("[plan] PLAN.md not found or unreadable: %s",
                                    plan_result.get("error", "unknown"))
                except Exception as exc:
                    logger.warning("[plan] Failed to read/persist PLAN.md: %s", exc)

            # Scan /mnt/session/outputs/* and ship each file to the Files API
            # with purpose=output, scopeId=<session_id>. Gated on session_id
            # presence (no-op for standalone agent_workflow runs without a
            # session) and on `not ctx.is_replaying` so Dapr replay doesn't
            # produce duplicate file rows. Failures are logged and don't
            # affect the workflow result.
            session_id_for_outputs = self._session_id_by_instance.get(instance_id)
            if session_id_for_outputs and not ctx.is_replaying:
                try:
                    summary = _scan_session_outputs(session_id_for_outputs, runtime)
                    logger.info(
                        "[session-outputs] %s scan summary: %s",
                        session_id_for_outputs,
                        summary,
                    )
                except Exception as exc:  # noqa: BLE001
                    logger.warning(
                        "[session-outputs] scan failed for %s: %s",
                        session_id_for_outputs,
                        exc,
                    )

            if custom_hooks_enabled and not ctx.is_replaying:
                try:
                    snap = _current_hook_snapshot(self, instance_id)
                    project_dir_hook = runtime.cwd or cwd or os.environ.get("CLAUDE_PROJECT_DIR") or os.getcwd()
                    stop_agg = execute_stop_hooks(
                        snap,
                        session_id=instance_id,
                        cwd=runtime.cwd or cwd or "",
                        project_dir=project_dir_hook,
                    )
                    if stop_agg.any_block():
                        logger.info(
                            "[hooks] Stop hook returned block (advisory in v1): %s",
                            stop_agg.blocking_reason or stop_agg.decision_reason or "",
                        )
                except Exception as exc:
                    logger.warning("[hooks] Stop error: %s", exc)
            # Stop-hook goal drive (non-advisory): at this real turn-end, trigger
            # the BFF goal evaluator synchronously so completion/continuation is
            # decided reliably in-process — not dependent on the fire-and-forget
            # status_idle ingest + the 180s cron backstop. Side-effect ONLY (the
            # BFF enacts complete/continue via external events the workflow already
            # handles, so we never branch control flow here — replay-safe). No-op
            # for non-goal sessions. session_workflow tags this turn's idle reason
            # != end_turn so the inline BFF idle hook won't ALSO drive.
            if GOAL_STOP_HOOK_ENABLED and not ctx.is_replaying:
                try:
                    drive_goal_stop_check(
                        self._session_id_by_instance.get(instance_id)
                    )
                except Exception as exc:  # noqa: BLE001
                    logger.warning("[goal-stop-hook] drive failed: %s", exc)
            # run_complete is suppressed — session_workflow emits
            # session.status_idle when the agent finishes cleanly.
            if custom_hooks_enabled and not ctx.is_replaying:
                try:
                    snap = _current_hook_snapshot(self, instance_id)
                    project_dir_hook = runtime.cwd or cwd or os.environ.get("CLAUDE_PROJECT_DIR") or os.getcwd()
                    execute_session_end_hooks(
                        snap,
                        reason="other",
                        session_id=instance_id,
                        cwd=runtime.cwd or cwd or "",
                        project_dir=project_dir_hook,
                    )
                except Exception as exc:
                    logger.warning("[hooks] SessionEnd (success) error: %s", exc)
            # Durable per-run workspace diff: capture `git diff baseline..working`
            # over the agent workspace and persist it as a `diff` artifact so the
            # run's file changes survive sandbox reap (no live pod, no Gitea).
            # Best-effort, fires once (replay-guarded); never affects the run.
            if not ctx.is_replaying:
                try:
                    agent_ctx = self._agent_context_by_instance.get(instance_id) or {}
                    # Use the robustly-derived local execution_id (dbExecutionId /
                    # workflowExecutionId / executionId). `_execution_id_by_instance`
                    # is populated only from clean["executionId"], which the bridge
                    # often leaves empty → capture would silently skip.
                    diff_res = capture_run_diff(
                        execution_id=execution_id
                        or self._execution_id_by_instance.get(instance_id),
                        node_id=agent_ctx.get("nodeId") or metadata.get("nodeId"),
                        repo_path=runtime.cwd or cwd or "/sandbox",
                    )
                    logger.info("[run-diff] capture result: %s", diff_res)
                except Exception as exc:  # noqa: BLE001
                    logger.warning("[run-diff] capture failed: %s", exc)
            emit_metrics_summary_once()
            self._close_mcp_client(instance_id)
        except Exception as exc:
            workflow_terminal = True
            # run_error is suppressed — session_workflow emits session.status_errored
            # with stop_reason carrying the full error context.
            _ = exc  # retained for re-raise below
            # Phase B — pin termination_reason to "agent_error" if no more
            # specific reason was already set (e.g., circuit_breaker_*). The
            # finally-block emits the metrics summary using this value.
            self._termination_reason_by_instance.setdefault(instance_id, "agent_error")
            if custom_hooks_enabled and not ctx.is_replaying:
                try:
                    snap = _current_hook_snapshot(self, instance_id)
                    project_dir_hook = runtime.cwd or cwd or os.environ.get("CLAUDE_PROJECT_DIR") or os.getcwd()
                    execute_session_end_hooks(
                        snap,
                        reason="errored",
                        session_id=instance_id,
                        cwd=runtime.cwd or cwd or "",
                        project_dir=project_dir_hook,
                    )
                except Exception as hook_exc:
                    logger.warning("[hooks] SessionEnd (error) error: %s", hook_exc)
            emit_metrics_summary_once()
            self._close_mcp_client(instance_id)
            raise
        finally:
            # NOTE: finally fires on every Dapr orchestrator replay yield-point,
            # not just on true workflow completion. We used to pop per-instance
            # caches here, but that erased per-run hook snapshots + compaction
            # config BEFORE the next activity could read them. Leave the caches
            # intact; each replay's install/resolve block rewrites the entries
            # idempotently, so the memory footprint is bounded by the number of
            # concurrently-live workflow instances.
            #
            # The mutable process-wide settings below are also part of the
            # live workflow's execution environment. Restoring them on an
            # intermediate yield can make the first execution and replay walk
            # different action sequences, which durabletask reports as
            # NonDeterminismError ("previous execution called call_activity...").
            # Restore them only after the workflow body reaches a terminal
            # success/error path.
            if workflow_terminal:
                self.execution.max_iterations = previous_max_iterations
                self.llm._llm_component = previous_component
                _restore_prompt_state(self, previous_prompt_state)
                skill_registry.clear_instance_skills()
            # End the claude_code.interaction span + reset session context only
            # on real completion, not on intermediate replay/yield closure.
            if (
                workflow_terminal
                and not ctx.is_replaying
                and instance_id in self._interaction_span_by_instance
            ):
                try:
                    from src.telemetry import end_interaction_span, flush_telemetry
                    from src.telemetry.attributes import reset_session_context

                    end_interaction_span()
                    # Force the BatchSpanProcessor to push the root span before
                    # the activity returns. Without this, the root span can sit
                    # in the queue (or get dropped when the queue is full from
                    # a long, span-heavy turn) and MLflow keeps the trace
                    # marked IN_PROGRESS with no root, which renders empty in
                    # the MLflow Tracing UI even though child spans arrived.
                    flush_telemetry()
                    self._interaction_span_by_instance.pop(instance_id, None)
                    tok = self._interaction_ctx_token_by_instance.pop(
                        instance_id, None
                    )
                    if tok is not None:
                        try:
                            reset_session_context(tok)
                        except Exception:
                            pass
                except Exception as exc:  # noqa: BLE001
                    logger.warning("[telemetry] interaction end failed: %s", exc)

        return agent_workflow_result

    # ------------------------------------------------------------------
    # Session workflow (CMA-shape multi-turn loop)
    # ------------------------------------------------------------------

    def register_workflows(self, runtime) -> None:
        """Extend the base registration so `session_workflow` is visible to
        the Dapr workflow runtime alongside `agent_workflow` and
        `broadcast_listener`. Without this override, the base hard-codes
        only its two workflows and session_workflow instances fail
        immediately (worker has no entry in the registry).

        Also registers Approach-B peer-invocation machinery:
        `call_peer_session_workflow` (wrapper) and `create_peer_session_row`
        (activity). Both are no-ops unless the parent agent's LLM emits a
        CallAgent tool_call via the native workflow-tool path.
        """
        super().register_workflows(runtime)
        runtime.register_workflow(self.session_workflow)
        runtime.register_workflow(self.call_peer_session_workflow)
        # Activity that populates self._mcp_configs_by_instance[instance_id]
        # for the current session workflow turn. Yielded by session_workflow
        # before the inline agent turn so call_llm finds pre-seeded MCP configs
        # and `_ensure_mcp_client` connects.
        # This is the Dapr-compliant side-effect channel: dict mutations
        # and MCP stdio/http connections are banned from orchestrator bodies
        # (they re-run deterministically on every replay); activities ARE
        # allowed to have side effects (Dapr caches their return value and
        # only re-runs on worker failure).
        # Dapr Agents 1.0.3 scopes built-in activity names through
        # self._activity_name(...). Use the same convention for repo-owned
        # custom activities so every activity registration is agent-scoped.
        for activity in (
            self.create_peer_session_row,
            self.seed_mcp_for_instance,
            self.seed_runtime_context_for_instance,
            self.check_cancellation_for_instance,
        ):
            runtime.register_activity(
                self._named(activity, self._activity_name(activity))
            )

    @workflow_entry
    def call_peer_session_workflow(self, ctx, message: dict):
        """Two-step peer-delegation wrapper for Approach B.

        Input (built by CallAgentWorkflowTool):
            {
              sessionId: "ca-<uuid>-<slug>",  # deterministic, ≤64 chars
              peerAgentId, peerSlug,
              prompt,
              parentSessionId, parentInstanceId, registryTeam,
            }

        Flow:
          1. yield create_peer_session_row activity
             → BFF creates the `sessions` row (idempotent by sessionId)
             → activity returns resolved {agentConfig, environmentConfig,
                vaultIds, callableAgents, registryTeam}
          2. yield session_workflow as a child, passing that childInput +
             the user prompt as initialEvents + autoTerminate=true.
          3. Return the child's result dict so the parent agent_workflow's
             CallAgent tool_result carries the peer's final content back
             to the LLM in the same turn.

        Every yield is Dapr event-sourced. Deterministic `sessionId`
        ensures retries re-attach to the same row + same session_workflow
        instance rather than double-spawning. The wrapper workflow itself
        uses a suffixed instance id, so the inner session_workflow owns the
        bare session id.
        """
        row = yield ctx.call_activity(
            self._activity_name(self.create_peer_session_row),
            input=message,
        )
        if not isinstance(row, dict) or not row.get("sessionId"):
            raise RuntimeError(
                f"create_peer_session_row returned unexpected payload: {row!r}"
            )
        session_id = row["sessionId"]
        child_result = yield ctx.call_child_workflow(
            "session_workflow",
            input={
                "sessionId": session_id,
                "agentId": row.get("agentId") or message.get("peerAgentId"),
                "agentVersion": row.get("agentVersion"),
                "agentSlug": message.get("peerSlug"),
                "agentAppId": message.get("peerAppId"),
                "agentConfig": row.get("agentConfig") or {},
                "environmentConfig": row.get("environmentConfig") or {},
                "vaultIds": row.get("vaultIds") or [],
                "callableAgents": row.get("callableAgents") or [],
                "registryTeam": row.get("registryTeam"),
                "initialEvents": [
                    {
                        "type": "user.message",
                        "content": [
                            {"type": "text", "text": str(message.get("prompt") or "")}
                        ],
                    }
                ],
                "autoTerminateAfterEndTurn": True,
            },
            instance_id=session_id,
        )
        # session_workflow returns a dict with content/success/sessionId/turn.
        # Pass it through verbatim — the SDK serializes this as the CallAgent
        # tool's tool_result content, which the parent LLM sees directly.
        result = (
            child_result
            if isinstance(child_result, dict)
            else {"content": str(child_result or "")}
        )
        result.setdefault("sessionId", session_id)
        result.setdefault("peerSlug", message.get("peerSlug"))
        return result

    def create_peer_session_row(self, ctx, payload: dict) -> dict:
        """Activity: POST /api/internal/sessions/spawn-peer?skipSpawn=true
        to create (or fetch, if replayed) the peer's session row +
        pre-resolve the agentConfig / environmentConfig / callableAgents
        block so `call_peer_session_workflow` can spawn session_workflow
        without a second BFF round-trip.

        Idempotent: the BFF endpoint keys on the deterministic sessionId
        and short-circuits if the row already exists. Safe under activity
        retry.
        """
        import urllib.error
        import urllib.request

        session_id = str(payload.get("sessionId") or "").strip()
        peer_agent_id = str(payload.get("peerAgentId") or "").strip()
        if not session_id or not peer_agent_id:
            raise ValueError(
                "create_peer_session_row requires sessionId + peerAgentId"
            )

        token = os.environ.get("INTERNAL_API_TOKEN", "").strip()
        if not token:
            raise RuntimeError(
                "INTERNAL_API_TOKEN not configured on dapr-agent-py"
            )
        app_id = os.environ.get("WORKFLOW_BUILDER_APP_ID", "workflow-builder")
        dapr_http = os.environ.get("DAPR_HTTP_PORT", "3500")
        url = (
            f"http://localhost:{dapr_http}/v1.0/invoke/{app_id}"
            "/method/api/internal/sessions/spawn-peer"
        )
        body = {
            "sessionId": session_id,
            "peerAgentId": peer_agent_id,
            "prompt": payload.get("prompt") or "",
            "parentSessionId": payload.get("parentSessionId"),
            "parentInstanceId": payload.get("parentInstanceId"),
            "title": payload.get("title"),
            "skipSpawn": True,
        }
        req = urllib.request.Request(
            url,
            data=json.dumps(body).encode("utf-8"),
            headers={
                "Content-Type": "application/json",
                "X-Internal-Token": token,
            },
            method="POST",
        )
        try:
            with urllib.request.urlopen(req, timeout=15) as resp:
                text = resp.read().decode("utf-8", errors="replace")
        except urllib.error.HTTPError as exc:
            detail = exc.read().decode("utf-8", errors="replace")[:400]
            raise RuntimeError(
                f"spawn-peer rejected (HTTP {exc.code}): {detail}"
            ) from exc
        try:
            return json.loads(text)
        except Exception as exc:  # noqa: BLE001
            raise RuntimeError(
                f"spawn-peer returned non-JSON: {text[:200]!r}"
            ) from exc

    def seed_mcp_for_instance(
        self,
        ctx,
        payload: dict,
    ) -> dict:
        """Activity: seed the per-instance MCP cache so a downstream
        ``call_llm`` activity's ``_ensure_mcp_client`` can connect.

        Orchestrator bodies in Dapr workflows are deterministic and replayed
        from the top on every workflow wake-up — direct mutations to
        ``self._mcp_configs_by_instance[...]`` from inside ``session_workflow``
        are silently dropped because the mutation has no durable history.
        Activities ARE allowed to have side effects (Dapr caches their return
        value in history and only re-runs them on worker failure), so we do
        the stdio-MCP-or-HTTP-MCP setup here instead.

        Input (payload): ``{"instance_id": str, "agentConfig": dict}``.
        Returns: ``{"connected": [server_name, ...], "count": N}`` so the
        activity's effect is visible in the workflow's history log.
        """
        import sys as _sys
        _sys.stderr.write(
            f"[mcp-seed-activity] entered with keys={list(payload.keys()) if isinstance(payload, dict) else type(payload).__name__}\n"
        )
        _sys.stderr.flush()
        instance_id = str(payload.get("instance_id") or "").strip()
        if not instance_id:
            _sys.stderr.write("[mcp-seed-activity] no instance_id\n")
            _sys.stderr.flush()
            return {"connected": [], "count": 0, "reason": "no_instance_id"}
        agent_config = payload.get("agentConfig") or {}
        mcp_configs, mcp_allowed_tools = _extract_mcp_server_configs(
            {"agentConfig": agent_config}
        )
        _sys.stderr.write(
            f"[mcp-seed-activity] instance={instance_id} extracted={len(mcp_configs)} "
            f"names={list(mcp_configs.keys())}\n"
        )
        _sys.stderr.flush()
        if not mcp_configs:
            result = {"connected": [], "count": 0, "reason": "no_mcp_servers"}
            event = self._record_runtime_config_for_instance(
                instance_id,
                agent_config=agent_config,
                mcp_result=result,
            )
            if event:
                result["runtimeConfigEventId"] = event["id"]
            return result
        self._mcp_configs_by_instance[instance_id] = mcp_configs
        self._mcp_allowed_tools_by_instance[instance_id] = mcp_allowed_tools
        # Eagerly connect so the very first call_llm on this instance finds
        # already-populated tools. _ensure_mcp_client is idempotent — it
        # short-circuits via the config-hash cache if reinvoked with the
        # same configs on a call_llm replay.
        try:
            if not self._ensure_mcp_client(instance_id):
                result = {
                    "connected": [],
                    "count": len(mcp_configs),
                    "error": "connect_failed",
                }
                event = self._record_runtime_config_for_instance(
                    instance_id,
                    agent_config=agent_config,
                    mcp_result=result,
                )
                if event:
                    result["runtimeConfigEventId"] = event["id"]
                return result
        except Exception as exc:  # noqa: BLE001
            logger.warning(
                "[mcp] seed_mcp_for_instance %s: MCP connect failed: %s",
                instance_id,
                exc,
            )
            result = {
                "connected": [],
                "count": len(mcp_configs),
                "error": "connect_failed",
                "errorType": type(exc).__name__[:80],
            }
            event = self._record_runtime_config_for_instance(
                instance_id,
                agent_config=agent_config,
                mcp_result=result,
            )
            if event:
                result["runtimeConfigEventId"] = event["id"]
            return result
        connected_tools = self._mcp_tools_by_instance.get(instance_id) or {}
        logger.info(
            "[mcp] seed_mcp_for_instance %s: %d server(s), %d tool(s)",
            instance_id,
            len(mcp_configs),
            len(connected_tools),
        )
        result = {
            "connected": sorted(mcp_configs.keys()),
            "tool_count": len(connected_tools),
            "count": len(mcp_configs),
        }
        event = self._record_runtime_config_for_instance(
            instance_id,
            agent_config=agent_config,
            mcp_result=result,
        )
        if event:
            result["runtimeConfigEventId"] = event["id"]
        return result

    @workflow_entry
    def session_workflow(self, ctx, message: dict):
        """Multi-turn session loop that runs agent turns inside one Dapr
        workflow instance per session.

        The loop stays alive across user events via Dapr's
        ``wait_for_external_event`` pattern. Agent state is keyed by the
        session workflow instance id, so all turns share chat/tool history.

        Input shape::

            {
                "sessionId": "sesn_abc",
                "agentConfig": { ... },       # resolved by SvelteKit BFF
                "environmentConfig": { ... }, # resolved by SvelteKit BFF
                "vaultIds": [...],
                "initialEvents": [            # optional kickoff batch
                    {"type": "user.message", "content": [{"type":"text","text":"..."}]}
                ],
                "dbExecutionId": "...",       # optional workflow-execution correlation
            }

        Tool calls still run inside the Dapr Agents turn loop; this wrapper
        owns kickoff, multi-turn conversation, external-event input,
        graceful terminate, and workflow-history compaction.
        """
        session_id = str(message.get("sessionId") or "")
        if not session_id:
            raise RuntimeError("session_workflow requires sessionId")

        agent_cfg = _coerce_agent_config(message.get("agentConfig")) or {}
        env_cfg = message.get("environmentConfig") or {}
        vault_ids = message.get("vaultIds") or []
        db_execution_id = str(message.get("dbExecutionId") or "")
        mlflow_context = (
            message.get("mlflowContext")
            if isinstance(message.get("mlflowContext"), dict)
            else {}
        )
        if not ctx.is_replaying and mlflow_context:
            try:
                from src.telemetry.providers import set_mlflow_trace_experiment_for_context

                set_mlflow_trace_experiment_for_context(
                    str(
                        mlflow_context.get("traceExperimentId")
                        or mlflow_context.get("experimentId")
                        or ""
                    )
                )
            except Exception as exc:  # noqa: BLE001
                logger.debug("[session-workflow] MLflow context destination skipped: %s", exc)
        workflow_instance_id = session_workflow_instance_id(
            getattr(ctx, "instance_id", None),
            session_id,
        )
        continuation_state = session_workflow_state_from_message(message)
        pending = list(message.get("initialEvents") or [])
        # Workflow-bridge mode: when an orchestrator calls session_workflow as
        # a child workflow for a `durable/run` node, it wants a single-turn
        # request/response shape — spawn, run the initial turn, return the
        # result, and self-terminate. UI-initiated sessions leave this unset
        # so the multi-turn loop continues across user events.
        auto_terminate = bool(message.get("autoTerminateAfterEndTurn"))
        config_revision = int(continuation_state["configRevision"])
        control_override_fields: set[str] = set(
            continuation_state["controlOverrideFields"]
        )

        if not ctx.is_replaying:
            publish_session_event(
                session_id,
                "session.status_rescheduled",
                {
                    "vaultIds": vault_ids,
                    **session_native_event_fields(workflow_instance_id),
                },
            )
            # Phase 4 v2: set an agent-aware MLflow trace name + agent tags
            # ONCE at session entry so the Sessions/Traces UI shows
            # `agent.<slug>/session.<sessionId>` instead of generic
            # `session_workflow` defaults. The parent workflow already
            # exported spans under this trace_id (W3C propagated from
            # the orchestrator's call_child_workflow), so set_trace_tag
            # finds the trace_info row already.
            try:
                from src.telemetry.dapr_attributes import set_mlflow_trace_tags
                _agent_slug = (agent_cfg.get("slug") if isinstance(agent_cfg, dict) else None) or ""
                if not _agent_slug:
                    _app_id = os.environ.get("APP_ID") or os.environ.get("DAPR_APP_ID") or ""
                    if _app_id.startswith("agent-runtime-"):
                        _agent_slug = _app_id[len("agent-runtime-"):]
                _agent_slug = _agent_slug.strip() or "unknown"
                _display_name = f"agent.{_agent_slug}/session.{session_id}"
                _trace_tags: dict[str, Any] = {
                    "session.id": session_id,
                    "agent.session.id": session_id,
                    "workflow_builder.session_id": session_id,
                    "agent.slug": _agent_slug,
                }
                if db_execution_id:
                    _trace_tags["workflow.execution.id"] = db_execution_id
                    _trace_tags["workflow_builder.trace_group_id"] = db_execution_id
                for _key, _tag_key in (
                    ("experimentId", "mlflow.experiment_id"),
                    ("traceExperimentId", "mlflow.trace_experiment_id"),
                    ("runId", "mlflow.run_id"),
                    ("parentRunId", "mlflow.parent_run_id"),
                    ("mlflowSessionId", "workflow_builder.mlflow_session_id"),
                    ("activeModelId", "mlflow.modelId"),
                    ("activeModelUri", "mlflow.model.uri"),
                    ("activeModelUri", "agent.mlflow_uri"),
                ):
                    _value = mlflow_context.get(_key) if isinstance(mlflow_context, dict) else None
                    if _value:
                        _trace_tags[_tag_key] = str(_value)
                set_mlflow_trace_tags(_trace_tags, trace_name=_display_name)
                logger.info(
                    "[session-workflow] MLflow trace tags set: name=%s slug=%s",
                    _display_name,
                    _agent_slug,
                )
            except Exception as exc:  # noqa: BLE001
                logger.debug("[session-workflow] trace-tag set failed: %s", exc)

        turn_counter = int(continuation_state["turnCounter"])
        continuation_count = int(continuation_state["continuationCount"])
        # When the Stop-hook goal driver is active for this goal-mode session, tag
        # the turn-end idle reason != "end_turn" so the inline BFF idle hook
        # (goal-loop.ts) does NOT also drive — the Stop hook is the single driver
        # (the cron, which gates on idle TYPE not reason, stays a backstop).
        idle_stop_reason_type = (
            "goal_stop"
            if (GOAL_STOP_HOOK_ENABLED and not auto_terminate)
            else "end_turn"
        )
        while True:
            if not pending:
                if not ctx.is_replaying:
                    publish_session_event(
                        session_id,
                        "session.status_idle",
                        {
                            "stop_reason": {"type": idle_stop_reason_type},
                            **session_native_event_fields(workflow_instance_id),
                        },
                    )
                    # Mark this session as legitimately idle (waiting for the
                    # next user prompt) so the host-monitor keeps it warm rather
                    # than idle-terminating it. Cleared when the next turn runs.
                    _session_idle_waiting[workflow_instance_id] = True
                try:
                    batch = yield ctx.wait_for_external_event("session.user_events")
                except Exception as exc:  # noqa: BLE001
                    logger.warning(
                        "[session] %s wait_for_external_event failed: %s",
                        session_id,
                        exc,
                    )
                    break
                pending = list((batch or {}).get("events") or [])
                if not pending:
                    continue
                # A turn is starting — no longer idle-waiting.
                if not ctx.is_replaying:
                    _session_idle_waiting.pop(workflow_instance_id, None)

            agent_cfg, pending, config_changes = apply_session_control_events(
                agent_cfg,
                pending,
            )
            if config_changes:
                config_revision += 1
                for change in config_changes:
                    if isinstance(change, dict) and isinstance(change.get("changedKeys"), list):
                        control_override_fields.update(
                            str(key)
                            for key in change.get("changedKeys", [])
                            if str(key).strip()
                        )
                if not ctx.is_replaying:
                    next_cwd = str(
                        message.get("cwd")
                        or agent_cfg.get("cwd")
                        or DEFAULT_CWD
                    )
                    next_snapshot = build_effective_agent_config(
                        agent_config=agent_cfg,
                        raw_message=message,
                        turn=turn_counter + 1,
                        config_revision=config_revision,
                        cwd=next_cwd,
                    )
                    publish_session_event(
                        session_id,
                        "session.config_updated",
                        {
                            "changes": config_changes,
                            "applies": "next_turn",
                            "configRevision": config_revision,
                            "configHash": next_snapshot.get("configHash"),
                            "modelSpec": (
                                next_snapshot.get("llm", {}).get("modelSpec")
                                if isinstance(next_snapshot.get("llm"), dict)
                                else None
                            ),
                            "llmComponent": (
                                next_snapshot.get("llm", {}).get("llmComponent")
                                if isinstance(next_snapshot.get("llm"), dict)
                                else None
                            ),
                            **session_native_event_fields(workflow_instance_id),
                        },
                    )
                if not pending:
                    continue

            terminal_stop_reason = terminal_stop_reason_from_events(pending)
            if terminal_stop_reason:
                if not ctx.is_replaying:
                    publish_session_event(
                        session_id,
                        "session.status_terminating",
                        {
                            "stop_reason": terminal_stop_reason,
                            **session_native_event_fields(workflow_instance_id),
                        },
                    )
                    publish_session_event(
                        session_id,
                        "session.status_terminated",
                        {
                            "stop_reason": terminal_stop_reason,
                            **session_native_event_fields(workflow_instance_id),
                        },
                    )
                return

            # Extract the user.message text(s) + tool_confirmations / custom_tool_results.
            # For v1 we join all text content into a single "task" string; the
            # other event types pass through as context strings so agent_workflow
            # can see them in its prompt.
            task_text = _compose_turn_task(pending)
            pending = []
            turn_counter += 1
            turn_id = logical_turn_id(session_id, turn_counter)
            child_mlflow_context = dict(mlflow_context or {})
            child_mlflow_context.setdefault("mlflowSessionId", session_id)
            child_mlflow_context["turnId"] = turn_id
            child_cwd = str(
                message.get("cwd")
                or agent_cfg.get("cwd")
                or DEFAULT_CWD
            )
            child_sandbox_name = (
                str(message.get("sandboxName") or "").strip() or None
            )
            child_mlflow_session_id = str(
                child_mlflow_context.get("mlflowSessionId") or session_id
            ).strip()
            try:
                turn_date = ctx.current_utc_datetime.date().isoformat()
            except Exception:
                turn_date = None
            agent_turn_instance_id = (
                f"{workflow_instance_id}__turn__{turn_counter}"
                if auto_terminate
                else workflow_instance_id
            )
            instruction_bundle = _compose_turn_instruction_bundle(
                agent_config=agent_cfg,
                message=message,
                prompt=task_text,
                cwd=child_cwd,
                sandbox_name=child_sandbox_name,
                current_date=turn_date,
                control_override_fields=control_override_fields,
            )
            effective_config = build_effective_agent_config(
                agent_config=agent_cfg,
                raw_message=message,
                turn=turn_counter,
                config_revision=config_revision,
                cwd=child_cwd,
                instruction_bundle=instruction_bundle,
            )

            if not ctx.is_replaying:
                publish_session_event(
                    session_id,
                    "session.status_running",
                    {
                        "turn": turn_counter,
                        "turnId": turn_id,
                        **session_native_event_fields(workflow_instance_id),
                    },
                )
                publish_session_event(
                    session_id,
                    "session.instructions_applied",
                    {
                        "turn": turn_counter,
                        "turnId": turn_id,
                        "childInstanceId": agent_turn_instance_id,
                        **session_native_event_fields(workflow_instance_id),
                        "schemaVersion": instruction_bundle.get("schemaVersion"),
                        "instructionHash": instruction_bundle.get("instructionHash"),
                        **instruction_bundle_audit_payload(
                            instruction_bundle,
                            max_bytes=_MAX_INSTRUCTION_AUDIT_BYTES,
                        ),
                    },
                    source_event_id=f"{workflow_instance_id}:{turn_id}:instructions",
                )
                llm_snapshot = (
                    effective_config.get("llm")
                    if isinstance(effective_config.get("llm"), dict)
                    else {}
                )
                tools_snapshot = (
                    effective_config.get("tools")
                    if isinstance(effective_config.get("tools"), dict)
                    else {}
                )
                instruction_sources = (
                    effective_config.get("instructionSources")
                    if isinstance(effective_config.get("instructionSources"), list)
                    else []
                )
                publish_session_event(
                    session_id,
                    "session.turn_started",
                    {
                        "turn": turn_counter,
                        "turnId": turn_id,
                        "childInstanceId": agent_turn_instance_id,
                        **session_native_event_fields(workflow_instance_id),
                        "instructionHash": effective_config.get("instructionHash"),
                        "templateName": effective_config.get("templateName"),
                        "templateHash": effective_config.get("templateHash"),
                        "instructionBundleSchemaVersion": effective_config.get(
                            "instructionBundleSchemaVersion"
                        ),
                        "instructionSources": instruction_sources,
                        "instructionOverrides": [
                            item
                            for item in instruction_sources
                            if isinstance(item, dict)
                            and item.get("overrideKind") != "base"
                        ],
                        "instructionTextStored": effective_config.get(
                            "instructionTextStored"
                        ),
                        "configRevision": config_revision,
                        "configHash": effective_config.get("configHash"),
                        "modelSpec": llm_snapshot.get("modelSpec"),
                        "llmComponent": llm_snapshot.get("llmComponent"),
                        "providerModel": llm_snapshot.get("providerModel"),
                        "allowedTools": tools_snapshot.get("allowedTools") or [],
                        "mcpConfigHash": tools_snapshot.get("mcpConfigHash"),
                        "cwd": child_cwd,
                    },
                )

            # Build the agent turn input — same shape agent_workflow accepts.
            child_input = _freeze_session_child_input(
                session_id=session_id,
                agent_cfg=agent_cfg,
                env_cfg=env_cfg,
                vault_ids=vault_ids,
                db_execution_id=db_execution_id,
                turn=turn_counter,
                task=task_text,
                raw_message=message,
                effective_agent_config=effective_config,
                instruction_bundle=instruction_bundle,
                child_instance_id=agent_turn_instance_id,
                turn_id=turn_id,
                mlflow_context=child_mlflow_context,
            )
            if is_swebench_execution_context(agent_turn_instance_id, child_input):
                child_input["agentWorkflowMode"] = "strict_sequential"
                child_metadata_for_mode = _parse_metadata(
                    child_input.get("_message_metadata")
                )
                child_metadata_for_mode["agentWorkflowMode"] = "strict_sequential"
                child_input["_message_metadata"] = child_metadata_for_mode

            # Seed session-scoped runtime/MCP state through activities before
            # the inline agent turn. The agent workflow also rebuilds this
            # context deterministically, but the activity emits an inspection
            # snapshot and pre-connects MCP clients before the first LLM call.
            child_metadata = _parse_metadata(child_input.get("_message_metadata"))
            child_llm = (
                effective_config.get("llm")
                if isinstance(effective_config.get("llm"), dict)
                else {}
            )
            child_llm_component = (
                str(child_llm.get("llmComponent") or "").strip()
                or _resolve_llm_component(child_input, child_metadata)
            )
            child_audit_fields = effective_audit_fields(effective_config)
            child_runtime_context = {
                "executionId": db_execution_id or agent_turn_instance_id,
                "workflowExecutionId": (
                    child_input.get("workflowExecutionId")
                    or child_input.get("dbExecutionId")
                    or child_metadata.get("workflowExecutionId")
                    or db_execution_id
                    or agent_turn_instance_id
                ),
                "workflowId": child_input.get("workflowId") or message.get("workflowId"),
                "workflowActivityCorrelationId": (
                    child_input.get("workflowActivityCorrelationId")
                    or child_metadata.get("workflowActivityCorrelationId")
                    or message.get("workflowActivityCorrelationId")
                ),
                "nodeId": child_input.get("nodeId") or message.get("nodeId"),
                "nodeName": (
                    child_input.get("nodeName")
                    or message.get("nodeName")
                    or child_input.get("nodeId")
                    or message.get("nodeId")
                ),
                "agentId": (
                    child_input.get("agentId")
                    or message.get("agentId")
                    or agent_cfg.get("id")
                ),
                "agentVersion": child_input.get("agentVersion")
                or message.get("agentVersion")
                or agent_cfg.get("version"),
                "agentSlug": (
                    child_input.get("agentSlug")
                    or message.get("agentSlug")
                    or agent_cfg.get("slug")
                ),
                "agentAppId": (
                    child_input.get("agentAppId")
                    or message.get("agentAppId")
                    or agent_cfg.get("agentAppId")
                    or os.environ.get("APP_ID")
                    or os.environ.get("DAPR_APP_ID")
                ),
                "sandboxName": child_input.get("sandboxName") or None,
                "cwd": child_input.get("cwd") or DEFAULT_CWD,
                "sessionId": session_id,
                "mlflowSessionId": child_mlflow_session_id or session_id,
                "mlflowExperimentId": child_mlflow_context.get("experimentId"),
                "mlflowTraceExperimentId": child_mlflow_context.get(
                    "traceExperimentId"
                ),
                "mlflowRunId": child_mlflow_context.get("runId"),
                "mlflowParentRunId": child_mlflow_context.get("parentRunId"),
                "mlflowActiveModelId": child_mlflow_context.get("activeModelId"),
                "mlflowActiveModelUri": child_mlflow_context.get("activeModelUri"),
                "mlflowContext": child_mlflow_context,
                "autoTerminateAfterEndTurn": auto_terminate,
                "workspaceRef": child_input.get("workspaceRef") or None,
                "llmComponent": child_llm_component,
                "modelSpec": child_audit_fields.get("modelSpec"),
                "providerModel": child_audit_fields.get("providerModel"),
                "configHash": child_audit_fields.get("configHash"),
                "instructionHash": child_audit_fields.get("instructionHash"),
                "templateName": child_audit_fields.get("templateName"),
                "templateHash": child_audit_fields.get("templateHash"),
                "turnId": turn_id,
                "turn": child_audit_fields.get("turn"),
                "configRevision": child_audit_fields.get("configRevision"),
                "effectiveAgentConfig": effective_config,
                "instructionBundle": instruction_bundle,
                "systemPrompt": (
                    instruction_bundle.get("rendered", {}).get("system")
                    if isinstance(instruction_bundle.get("rendered"), dict)
                    else _build_system_prompt(
                        cwd=str(child_input.get("cwd") or DEFAULT_CWD),
                        sandbox_name=str(child_input.get("sandboxName") or "") or None,
                    )
                ),
                "permissionMode": agent_cfg.get("permissionMode"),
                "allowedTools": sorted(_allowed_tools_from_agent_config(agent_cfg)),
                "agentWorkflowMode": child_input.get("agentWorkflowMode"),
            }
            yield ctx.call_activity(
                self._activity_name(self.seed_runtime_context_for_instance),
                input={
                    "instance_id": agent_turn_instance_id,
                    "context": child_runtime_context,
                },
            )

            # Dapr-compliant MCP bridge: yield to the `seed_mcp_for_instance`
            # activity so the side-effect (populating self._mcp_configs_by_instance
            # + pre-connecting MCP clients) happens in a place where side
            # effects are allowed. Orchestrator bodies re-run deterministically
            # on every replay — direct `self.*` mutations from here have no
            # durable history and get dropped.
            try:
                yield ctx.call_activity(
                    self._activity_name(self.seed_mcp_for_instance),
                    input={
                        "instance_id": agent_turn_instance_id,
                        "agentConfig": agent_cfg,
                    },
                )
            except Exception as exc:  # noqa: BLE001
                # Non-fatal: if MCP seeding fails we still try the turn;
                # the agent just won't have MCP tools for this turn.
                logger.warning(
                    "[session] %s turn %d: seed_mcp_for_instance failed: %s",
                    session_id,
                    turn_counter,
                    exc,
                )

            try:
                if auto_terminate and not is_swebench_execution_context(
                    agent_turn_instance_id,
                    child_input,
                ):
                    # Non-SWE-bench workflow-bridge sessions are one-shot
                    # durable/run calls. Keep the agent loop in a real child
                    # workflow so the session wrapper and the agent's LLM/tool
                    # loop do not share Dapr action IDs.
                    turn_result = yield ctx.call_child_workflow(
                        getattr(self, "agent_workflow_name", "agent_workflow"),
                        input=child_input,
                        instance_id=agent_turn_instance_id,
                    )
                else:
                    # SWE-bench launches brand-new ephemeral agent-host app IDs
                    # under load. Running the turn inline avoids a second
                    # startup-time workflow actor while preserving the strict
                    # sequential agent loop and the session workflow's durable
                    # state.
                    turn_result = yield from self.agent_workflow(ctx, child_input)
            except Exception as exc:  # noqa: BLE001
                logger.warning(
                    "[session] %s turn %d failed: %s",
                    session_id,
                    turn_counter,
                    exc,
                )
                if not ctx.is_replaying:
                    publish_session_event(
                        session_id,
                        "session.error",
                        {
                            "turn": turn_counter,
                            "turnId": turn_id,
                            "error": str(exc)[:500],
                            **session_native_event_fields(workflow_instance_id),
                        },
                    )
                    publish_session_event(
                        session_id,
                        "session.status_terminated",
                        session_native_event_fields(workflow_instance_id),
                    )
                if auto_terminate:
                    return {
                        "success": False,
                        "content": str(exc)[:500],
                        "error": str(exc)[:500],
                        "sessionId": session_id,
                        "turn": turn_counter,
                        "agentWorkflowMode": "session-native",
                        "workflowInstanceId": workflow_instance_id,
                    }
                return

            # Workflow-bridge path: return the child's result to the parent
            # orchestrator and self-terminate. UI sessions skip this branch
            # and loop back to await the next user event.
            if auto_terminate:
                result_dict = (
                    turn_result
                    if isinstance(turn_result, dict)
                    else {"content": str(turn_result or "")}
                )
                cancelled = bool(result_dict.get("cancelled"))
                if not ctx.is_replaying:
                    if cancelled:
                        stop_reason = (
                            result_dict.get("stop_reason")
                            if isinstance(result_dict.get("stop_reason"), dict)
                            else {"type": "terminated"}
                        )
                        publish_session_event(
                            session_id,
                            "session.status_terminating",
                            {
                                "stop_reason": stop_reason,
                                **session_native_event_fields(workflow_instance_id),
                            },
                        )
                    else:
                        publish_session_event(
                            session_id,
                            "session.status_idle",
                            {
                                "stop_reason": {"type": "end_turn"},
                                **session_native_event_fields(workflow_instance_id),
                            },
                        )
                    publish_session_event(
                        session_id,
                        "session.status_terminated",
                        {
                            "reason": "cancelled"
                            if cancelled
                            else "auto_terminate_after_end_turn",
                            **(
                                {"stop_reason": result_dict.get("stop_reason")}
                                if cancelled and isinstance(result_dict.get("stop_reason"), dict)
                                else {}
                            ),
                            **session_native_event_fields(workflow_instance_id),
                        },
                    )
                result_dict.setdefault("success", not bool(result_dict.get("error")))
                result_dict.setdefault("sessionId", session_id)
                result_dict.setdefault("turn", turn_counter)
                result_dict.setdefault("agentWorkflowMode", "session-native")
                result_dict.setdefault("workflowInstanceId", workflow_instance_id)
                return result_dict

            try:
                from src.compaction import resolve_config as _resolve_compaction_cfg

                compaction_cfg = _resolve_compaction_cfg({"agentConfig": agent_cfg})
                compaction_runs = self._compaction_runs_by_instance.get(
                    workflow_instance_id,
                    0,
                )
                should_continue, continue_reason = should_continue_session_as_new(
                    auto_terminate=auto_terminate,
                    turn_counter=turn_counter,
                    compaction_runs=compaction_runs,
                    continue_as_new_turn_threshold=(
                        compaction_cfg.continue_as_new_turn_threshold
                    ),
                    continue_as_new_after_compactions=(
                        compaction_cfg.continue_as_new_after_compactions
                    ),
                )
            except Exception as exc:  # noqa: BLE001
                logger.warning("[session] continue_as_new policy check failed: %s", exc)
                should_continue = False
                continue_reason = None
            if should_continue and continue_reason:
                if not ctx.is_replaying:
                    publish_session_event(
                        session_id,
                        "session.status_rescheduled",
                        {
                            "turn": turn_counter,
                            "reason": "continue_as_new",
                            "continueAsNewReason": continue_reason,
                            **session_native_event_fields(workflow_instance_id),
                        },
                    )
                ctx.continue_as_new(
                    build_continue_as_new_input(
                        message=message,
                        agent_config=agent_cfg,
                        pending_events=pending,
                        turn_counter=turn_counter,
                        config_revision=config_revision,
                        control_override_fields=control_override_fields,
                        continuation_count=continuation_count,
                        reason=continue_reason,
                    ),
                    save_events=True,
                )
                return


def _compose_turn_task(events: list[dict]) -> str:
    """Collapse a batch of user events into a single task string that
    agent_workflow can consume. ``user.message`` text blocks concatenate;
    tool confirmations and custom-tool results append as bracketed notes.
    """
    parts: list[str] = []
    for ev in events:
        et = ev.get("type") or ""
        if et == "user.message":
            content = ev.get("content") or ev.get("data", {}).get("content") or []
            for block in content:
                if isinstance(block, dict) and block.get("type") == "text":
                    text = str(block.get("text") or "")
                    if text:
                        parts.append(text)
        elif et == "user.tool_confirmation":
            result = ev.get("result") or ev.get("data", {}).get("result")
            tool_use_id = ev.get("tool_use_id") or ev.get("data", {}).get("tool_use_id")
            parts.append(
                f"[tool_confirmation tool_use_id={tool_use_id} result={result}]"
            )
        elif et == "user.custom_tool_result":
            tool_use_id = ev.get("tool_use_id") or ev.get("data", {}).get("tool_use_id")
            content = ev.get("content") or ev.get("data", {}).get("content") or []
            text = "".join(
                str(b.get("text") or "") for b in content if isinstance(b, dict)
            )
            parts.append(
                f"[custom_tool_result tool_use_id={tool_use_id}] {text}"
            )
    return "\n\n".join(parts)


def _freeze_session_child_input(
    *,
    session_id: str,
    agent_cfg: dict,
    env_cfg: dict,
    vault_ids: list,
    db_execution_id: str,
    turn: int,
    task: str,
    raw_message: dict,
    effective_agent_config: dict | None = None,
    instruction_bundle: dict | None = None,
    child_instance_id: str | None = None,
    turn_id: str | None = None,
    mlflow_context: dict | None = None,
) -> dict:
    """Build the frozen input payload for a session-native agent turn.

    ``child_instance_id`` is retained as a legacy parameter name, but now
    carries the stable session workflow instance id. ``turn_id`` is a logical
    per-turn correlation id, not a Dapr workflow instance id.
    """
    # Sandbox plumbing — copy through whatever the BFF baked into the
    # session-start message; environmentConfig overrides for future turns.
    sandbox_policy = (env_cfg or {}).get("sandboxPolicy") or raw_message.get(
        "sandboxPolicy"
    )
    sandbox_name = raw_message.get("sandboxName") or ""
    workspace_ref = raw_message.get("workspaceRef") or ""
    cwd = raw_message.get("cwd") or agent_cfg.get("cwd") or "/sandbox"

    # call_agent plumbing: spawn.ts (SvelteKit BFF) enriches the raw
    # session-start payload with `callableAgents` (full {slug, agentId,
    # appId, team, registryKey} metadata) + `registryTeam` (the team
    # string used to key Dapr registry entries). Forward both so the
    # child agent_workflow can stash them in the call_agent thread-local.
    callable_agents = raw_message.get("callableAgents") or []
    registry_team = raw_message.get("registryTeam") or None
    max_turns = raw_message.get("maxTurns")
    if max_turns is None:
        max_turns = agent_cfg.get("maxTurns")
    max_iterations = raw_message.get("maxIterations")
    if max_iterations is None:
        max_iterations = agent_cfg.get("maxIterations") or agent_cfg.get("max_iterations")
    metadata = {
        "executionId": db_execution_id,
        "workflowExecutionId": raw_message.get("workflowExecutionId") or db_execution_id,
        "sessionId": session_id,
        "turn": turn,
    }
    for key in (
        "workflowId",
        "workflowActivityCorrelationId",
        "nodeId",
        "nodeName",
        "agentId",
        "agentVersion",
        "agentSlug",
        "agentAppId",
        "sandboxName",
        "workspaceRef",
        "cwd",
    ):
        if raw_message.get(key) is not None:
            metadata[key] = raw_message.get(key)
    mlflow_context = (
        mlflow_context
        if isinstance(mlflow_context, dict)
        else raw_message.get("mlflowContext")
        if isinstance(raw_message.get("mlflowContext"), dict)
        else {}
    )
    mlflow_session_id = str(
        mlflow_context.get("mlflowSessionId")
        or raw_message.get("mlflowSessionId")
        or session_id
    ).strip()
    if mlflow_context:
        metadata["mlflowContext"] = mlflow_context
        metadata["mlflowRunId"] = mlflow_context.get("runId")
        metadata["mlflowParentRunId"] = mlflow_context.get("parentRunId")
        metadata["mlflowExperimentId"] = mlflow_context.get("experimentId")
        metadata["mlflowTraceExperimentId"] = mlflow_context.get("traceExperimentId")
        metadata["mlflowSessionId"] = mlflow_session_id
        metadata["mlflowActiveModelId"] = mlflow_context.get("activeModelId")
        metadata["mlflowActiveModelUri"] = mlflow_context.get("activeModelUri")
    if turn_id:
        metadata["turnId"] = turn_id
    if child_instance_id:
        metadata["workflowInstanceId"] = child_instance_id
    if max_turns is not None:
        metadata["maxTurns"] = max_turns
    if max_iterations is not None:
        metadata["maxIterations"] = max_iterations

    child_input = {
        "task": task,
        "prompt": task,
        "sessionId": session_id,
        "mlflowSessionId": mlflow_session_id or session_id,
        "turnId": turn_id or child_instance_id,
        "workflowInstanceId": child_instance_id,
        "executionId": db_execution_id,
        "dbExecutionId": db_execution_id,
        "workflowExecutionId": db_execution_id,
        "workflowActivityCorrelationId": raw_message.get("workflowActivityCorrelationId"),
        "workflowId": raw_message.get("workflowId"),
        "nodeId": raw_message.get("nodeId"),
        "nodeName": raw_message.get("nodeName") or raw_message.get("nodeId"),
        "agentId": raw_message.get("agentId") or agent_cfg.get("id"),
        "agentVersion": raw_message.get("agentVersion") or agent_cfg.get("version"),
        "agentSlug": raw_message.get("agentSlug") or agent_cfg.get("slug"),
        "agentAppId": raw_message.get("agentAppId") or agent_cfg.get("agentAppId"),
        "mlflowContext": mlflow_context or None,
        "agentConfig": agent_cfg,
        "effectiveAgentConfig": effective_agent_config or {},
        "instructionBundle": instruction_bundle or {},
        "vaultIds": vault_ids,
        "sandboxPolicy": sandbox_policy,
        "sandboxName": sandbox_name,
        "workspaceRef": workspace_ref,
        "cwd": cwd,
        "timeoutMinutes": raw_message.get("timeoutMinutes"),
        "callableAgents": callable_agents,
        "registryTeam": registry_team,
        "_session_turn": turn,
        "_message_metadata": metadata,
    }
    if max_turns is not None:
        child_input["maxTurns"] = max_turns
    if max_iterations is not None:
        child_input["maxIterations"] = max_iterations
    return child_input


def _is_workflow_instance_missing_error(exc: Exception) -> bool:
    message = str(exc).lower()
    return (
        "no such instance exists" in message
        or "agent run not found" in message
        or "workflow instance not found" in message
    )


def _is_workflow_terminate_status_unknown_error(exc: Exception) -> bool:
    message = str(exc).lower()
    return (
        "dapr workflow terminate failed with http 500" in message
        or "dapr workflow terminate failed with http 503" in message
        or "dapr workflow terminate failed with http 504" in message
    )


# ---------------------------------------------------------------------------
# Load disk-based skills at startup
# ---------------------------------------------------------------------------

_SKILL_SEARCH_DIRS = [
    os.path.join(os.path.dirname(__file__), "..", "skills"),  # project skills/
    os.path.join(os.path.dirname(__file__), "..", ".claude", "skills"),
]

for _skills_dir in _SKILL_SEARCH_DIRS:
    _abs_dir = os.path.abspath(_skills_dir)
    if os.path.isdir(_abs_dir):
        _disk_skills = load_skills_from_dir(_abs_dir, source="disk")
        if _disk_skills:
            get_skill_registry().set_disk_skills(_disk_skills)
            logger.info("[skills] Loaded %d disk skill(s) from %s", len(_disk_skills), _abs_dir)

agent = OpenShellDurableAgent(
    name=AGENT_SERVICE_NAME,
    role="OpenShell Durable Coding Agent",
    goal="Help users inspect, modify, and execute code safely inside an OpenShell sandbox",
    system_prompt=OPENSHELL_SYSTEM_PROMPT,
    instructions=[
        "Think step by step",
        "Use the existing dapr-agent-py tools for all file and command work",
        "Keep command output concise",
    ],
    style_guidelines=["Be professional and direct"],
    llm=DaprChatClient(component_name=DEFAULT_LLM_COMPONENT),
    tools=all_tools,
    execution=AgentExecutionConfig(
        max_iterations=DEFAULT_MAX_ITERATIONS,
        tool_execution_mode=ToolExecutionMode.SEQUENTIAL,
    ),
    configuration=config,
    state=state_config,
    pubsub=pubsub_config,
    registry=registry_config,
    # Retry window widened from the dapr-agents default (~24s across 3
    # attempts) to ~140s across 8 attempts. Covers pod restart + image
    # pull + Dapr sidecar handshake when a worker dies mid-activity.
    # Layer A (anthropic max_retries=4) absorbs sub-5s blips SDK-internally;
    # this policy covers the longer pod-death window.
    retry_policy=WorkflowRetryPolicy(
        max_attempts=8,
        initial_backoff_seconds=4,
        max_backoff_seconds=45,
        backoff_multiplier=1.5,
    ),
    agent_metadata={
        "service": AGENT_SERVICE_NAME,
        "stateStore": AGENT_STATE_STORE,
        "stateSchema": "dapr-agents-durable-default",
        "stateKeyPrefix": AGENT_STATE_KEY_PREFIX,
        "memoryKeyPrefix": AGENT_MEMORY_KEY_PREFIX,
        "instancesEndpoint": "/agent/instances",
        "pubsub": AGENT_PUBSUB_NAME,
        "agentTopic": AGENT_TOPIC,
        "broadcastTopic": AGENT_BROADCAST_TOPIC,
    },
)

# Dapr Agents 1.0.3 native hooks are currently used only for optional LLM
# lifecycle diagnostics. Policy/tool gating remains on the repo-owned hook
# subsystem below, which has the Claude-compatible config surface.
try:
    _install_native_llm_debug_hooks(agent)
except Exception as exc:  # noqa: BLE001
    logger.warning("Native Dapr Agents hook wiring failed: %s", exc)

# Wire hooks + plugins. Safe to call even when feature flags are off —
# the attributes are attached with empty registries so downstream code
# can touch them unconditionally.
try:
    _bootstrap_hooks_and_plugins(agent)
except Exception as exc:
    logger.warning("Hooks/plugins bootstrap failed: %s", exc)


def _notification_hook_dispatcher(
    event_type: str,
    data: dict[str, Any],
    execution_id: str | None,
    instance_id: str | None,
) -> None:
    """Fire Notification hooks for eligible publisher events.

    Runs on a daemon thread (see event_publisher). Not part of the
    durable workflow contract — Notification hooks are advisory.
    """
    if not hooks_enabled():
        return
    instance_key = instance_id or ""
    try:
        snapshot = _current_hook_snapshot(agent, instance_key)
    except Exception:
        snapshot = getattr(agent, "_base_hooks_snapshot", None) or empty_snapshot()
    if snapshot is None or not snapshot.by_event:
        return
    message = str(data.get("error") or data.get("output") or data.get("message") or event_type)
    execute_notification_hooks(
        snapshot,
        message=message,
        session_id=instance_key,
        cwd=agent._cwd_by_instance.get(instance_key, "") if hasattr(agent, "_cwd_by_instance") else "",
        project_dir=os.environ.get("CLAUDE_PROJECT_DIR") or os.getcwd(),
        title=event_type,
        notification_type=event_type,
    )


def _session_event_audit_field_provider(instance_id: str | None) -> dict[str, Any]:
    if not instance_id:
        return {}
    try:
        return _runtime_context_audit_fields(agent._runtime_context_for_instance(instance_id))
    except Exception as exc:  # noqa: BLE001
        logger.debug("[session-audit] failed for %s: %s", instance_id, exc)
        return {}


try:
    from src.event_publisher import (
        set_audit_field_provider,
        set_incremental_tier_enabled,
        set_notification_dispatcher,
    )

    # dapr-agent-py declares registry capability `incrementalEvents: true` and
    # ships the runtime-internal telemetry modules the tier imports
    # (src.compaction.tokens, src.telemetry.session_tracing), so it opts in to
    # the shared publisher's incremental tier. Simpler runtimes
    # (claude-agent-py / adk-agent-py — `incrementalEvents: false`) leave the
    # gate at its OFF default, keeping the byte-identical vendored copy inert.
    set_incremental_tier_enabled(True)
    set_notification_dispatcher(_notification_hook_dispatcher)
    set_audit_field_provider(_session_event_audit_field_provider)
except Exception as exc:
    logger.warning("Notification dispatcher wiring failed: %s", exc)

# ---------------------------------------------------------------------------
# FastAPI application
# ---------------------------------------------------------------------------

# Patch DaprChatClient for Anthropic — the Dapr sidecar's langchaingo layer
# sends tool_choice as a string even when None/not-passed, breaking Anthropic.
# This is a Go-side bug that can't be fixed from Python.
try:
    from src.anthropic_adapter import patch_for_anthropic
    patch_for_anthropic(agent.llm)
except Exception as exc:
    logger.warning("Anthropic adapter patch failed: %s", exc)

try:
    from src.openai_adapter import patch_for_openai
    patch_for_openai(agent.llm)
except Exception as exc:
    logger.warning("OpenAI adapter patch failed: %s", exc)

try:
    from src.nvidia_adapter import patch_for_nvidia
    patch_for_nvidia(agent.llm)
except Exception as exc:
    logger.warning("NVIDIA adapter patch failed: %s", exc)

try:
    from src.foundry_adapter import patch_for_foundry
    patch_for_foundry(agent.llm)
except Exception as exc:
    logger.warning("Azure AI Foundry adapter patch failed: %s", exc)

try:
    from src.together_adapter import patch_for_together
    patch_for_together(agent.llm)
except Exception as exc:
    logger.warning("Together AI adapter patch failed: %s", exc)

try:
    from src.deepseek_adapter import patch_for_deepseek
    patch_for_deepseek(agent.llm)
except Exception as exc:
    logger.warning("DeepSeek adapter patch failed: %s", exc)

try:
    from src.alibaba_adapter import patch_for_alibaba
    patch_for_alibaba(agent.llm)
except Exception as exc:
    logger.warning("Alibaba adapter patch failed: %s", exc)

try:
    from src.kimi_adapter import patch_for_kimi
    patch_for_kimi(agent.llm)
except Exception as exc:
    logger.warning("Kimi adapter patch failed: %s", exc)

# Phase 2c v2: Gateway adapter patches LAST so it's the OUTERMOST wrapper —
# first to inspect every generate() call. If routing isn't configured for
# the active component, it falls through to whichever per-provider adapter
# claims it.
try:
    from src.gateway_adapter import patch_for_gateway
    patch_for_gateway(agent.llm)
except Exception as exc:
    logger.warning("Gateway adapter patch failed: %s", exc)

runner = AgentRunner()


@asynccontextmanager
async def lifespan(app: FastAPI):
    logger.info("%s starting", AGENT_SERVICE_NAME)
    # Re-run state-store instrumentation here (idempotent) as well as at
    # import-time init_telemetry(). The import-time call runs before logging is
    # configured AND before dapr_agents is fully loaded, so its patch can miss
    # the StateStoreService class the activity worker threads actually call.
    # Re-applying at lifespan startup — after imports + logging are settled —
    # guarantees the patch binds. Logged at WARNING so it's visible in pod logs.
    try:
        from src.telemetry.state_tracing import instrument_state_store
        from src.telemetry.providers import is_telemetry_ready

        instrument_state_store()
        from dapr_agents.storage.daprstores.stateservice import StateStoreService

        logger.warning(
            "[state-tracing] lifespan re-instrument: patched=%s telemetry_ready=%s",
            getattr(StateStoreService, "_wb_state_instrumented", False),
            is_telemetry_ready(),
        )
    except Exception as exc:  # noqa: BLE001
        logger.warning("[state-tracing] lifespan re-instrument failed: %s", exc)
    # Bootstrap MCP tools from the env-var manifest (DAPR_AGENT_PY_BOOTSTRAP_MCP_SERVERS_JSON).
    # Runs inside FastAPI's event loop so MCPClient's anyio transports work
    # correctly; skips cleanly if the env var is empty. Registers tools on
    # agent.tool_executor so every subsequent call_llm activity sees them
    # via get_llm_tools().
    try:
        from src.tools import bootstrap_mcp_tools as _bootstrap_mcp_tools

        added = await _bootstrap_mcp_tools(agent)
        if added:
            logger.info("[mcp-bootstrap] added %d tool(s) to agent", added)
    except Exception as exc:  # noqa: BLE001
        logger.warning("[mcp-bootstrap] startup hook failed: %s", exc)
    _start_session_host_monitor()
    # Surface whether the workspace git-checkpoint remote is active for
    # long-running coding sessions (plan 1e). Mid-run workspace recovery is
    # silently unavailable when WORKFLOW_CHECKPOINT_GIT_REMOTE_URL (+ creds)
    # is unset; this makes that observable at boot. Best-effort.
    try:
        log_checkpoint_remote_status()
    except Exception as exc:  # noqa: BLE001
        logger.warning("[checkpoint] startup status log failed: %s", exc)
    yield
    logger.info("%s shutting down", AGENT_SERVICE_NAME)
    runner.shutdown(agent)
    try:
        from src.telemetry import shutdown_telemetry

        shutdown_telemetry()
    except Exception as exc:
        logger.warning("Telemetry shutdown failed: %s", exc)


app = FastAPI(
    title=AGENT_SERVICE_NAME,
    description="Minimal Python durable agent with hot-reload",
    version="0.1.0",
    lifespan=lifespan,
)

# Wire agent pub/sub routes and HTTP endpoints onto the FastAPI app.
# When app= is provided, serve() returns the app without starting uvicorn.
runner.serve(agent, app=app, port=8002)

# Instrument FastAPI with OTEL
if _otel_ready:
    try:
        from opentelemetry.instrumentation.fastapi import FastAPIInstrumentor

        FastAPIInstrumentor.instrument_app(app, excluded_urls="healthz,readyz")
        logger.info("FastAPI OTEL instrumentation applied")
    except Exception as exc:
        logger.warning("FastAPI OTEL instrumentation failed: %s", exc)


def _parse_json(value: Any) -> Any:
    parsed = value
    while isinstance(parsed, str):
        text = parsed.strip()
        if not text:
            return parsed
        try:
            parsed = json.loads(text)
        except json.JSONDecodeError:
            return parsed
    return parsed


def _terminal_status(status: str) -> bool:
    return status in {"COMPLETED", "FAILED", "CANCELED", "TERMINATED"}


def _session_host_env(name: str, default: str = "") -> str:
    return os.environ.get(name, default).strip()


def _session_host_int(name: str, default: int, *, minimum: int = 1) -> int:
    try:
        return max(minimum, int(_session_host_env(name, str(default))))
    except ValueError:
        return max(minimum, default)


def _session_host_bool(name: str, default: bool) -> bool:
    raw = _session_host_env(name)
    if not raw:
        return default
    return raw.lower() in {"1", "true", "yes", "on"}


def _report_session_host_inference_failure(
    *,
    status: str,
    error: str,
    termination_reason: str,
) -> None:
    run_id = _session_host_env("DAPR_AGENT_SESSION_HOST_BENCHMARK_RUN_ID")
    instance_id = _session_host_env("DAPR_AGENT_SESSION_HOST_BENCHMARK_INSTANCE_ID")
    base_url = os.environ.get(
        "WORKFLOW_BUILDER_URL",
        "http://workflow-builder.workflow-builder.svc.cluster.local:3000",
    ).strip()
    token = os.environ.get("INTERNAL_API_TOKEN", "").strip()
    if not run_id or not instance_id or not base_url or not token:
        return
    url = (
        f"{base_url.rstrip('/')}/api/internal/benchmarks/runs/"
        f"{urllib.parse.quote(run_id, safe='')}/instances/"
        f"{urllib.parse.quote(instance_id, safe='')}/inference-failure"
    )
    body = json.dumps(
        {
            "status": status,
            "error": error,
            "terminationReason": termination_reason,
        }
    ).encode("utf-8")
    request = urllib.request.Request(
        url,
        data=body,
        headers={
            "Content-Type": "application/json",
            "X-Internal-Token": token,
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=10) as response:
            response.read()
        logger.info(
            "[session-host] reported benchmark inference failure run=%s instance=%s reason=%s",
            run_id,
            instance_id,
            termination_reason,
        )
    except Exception as exc:  # noqa: BLE001
        logger.warning(
            "[session-host] failed to report benchmark inference failure run=%s instance=%s: %s",
            run_id,
            instance_id,
            exc,
        )


def _session_host_benchmark_progress() -> dict[str, Any] | None:
    run_id = _session_host_env("DAPR_AGENT_SESSION_HOST_BENCHMARK_RUN_ID")
    instance_id = _session_host_env("DAPR_AGENT_SESSION_HOST_BENCHMARK_INSTANCE_ID")
    base_url = os.environ.get(
        "WORKFLOW_BUILDER_URL",
        "http://workflow-builder.workflow-builder.svc.cluster.local:3000",
    ).strip()
    token = os.environ.get("INTERNAL_API_TOKEN", "").strip()
    if not run_id or not instance_id or not base_url or not token:
        return None
    url = (
        f"{base_url.rstrip('/')}/api/internal/benchmarks/runs/"
        f"{urllib.parse.quote(run_id, safe='')}/instances/"
        f"{urllib.parse.quote(instance_id, safe='')}/progress"
    )
    request = urllib.request.Request(
        url,
        headers={"X-Internal-Token": token},
        method="GET",
    )
    with urllib.request.urlopen(request, timeout=10) as response:
        payload = json.loads(response.read().decode("utf-8"))
    return payload if isinstance(payload, dict) else None


def _start_session_host_monitor() -> None:
    instance_id = _session_host_env("DAPR_AGENT_SESSION_HOST_INSTANCE_ID")
    if not instance_id:
        return
    thread = threading.Thread(
        target=_run_session_host_monitor,
        args=(instance_id,),
        name="session-host-monitor",
        daemon=True,
    )
    thread.start()


def _shutdown_dapr_sidecar_for_job(instance_id: str) -> None:
    if not _session_host_bool("DAPR_AGENT_SESSION_HOST_SHUTDOWN_SIDECAR_ON_EXIT", True):
        return
    url = f"{_dapr_http_sidecar_url()}/v1.0/shutdown"
    request = urllib.request.Request(
        url,
        headers=_dapr_api_token_headers(),
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=2) as response:
            response.read()
        logger.info("[session-host] requested dapr sidecar shutdown for %s", instance_id)
    except Exception as exc:  # noqa: BLE001
        logger.warning(
            "[session-host] failed to request dapr sidecar shutdown for %s: %s",
            instance_id,
            exc,
        )


def _session_host_exit(instance_id: str, exit_code: int) -> None:
    _shutdown_dapr_sidecar_for_job(instance_id)
    os._exit(exit_code)


def _hold_session_host_after_terminal(
    instance_id: str,
    runtime_status: str,
    hold_seconds: int,
    poll_seconds: int,
) -> None:
    if hold_seconds <= 0:
        return
    logger.info(
        "[session-host] workflow %s terminal status=%s; holding pod for %ss before sidecar shutdown",
        instance_id,
        runtime_status,
        hold_seconds,
    )
    deadline = time.monotonic() + hold_seconds
    while True:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            return
        sidecar_error = _dapr_sidecar_health_error()
        if sidecar_error is not None:
            logger.warning(
                "[session-host] ending terminal hold for %s because dapr sidecar became unavailable: %s",
                instance_id,
                sidecar_error,
            )
            return
        time.sleep(min(max(1, poll_seconds), remaining))


# Set (in-process) by session_workflow when it goes idle waiting for the next
# user prompt, cleared when a turn starts. Read by the host-monitor to tell a
# legitimately-idle interactive session (waiting for the user) apart from a
# startup/mid-turn HANG. Keyed by workflow instance id; written only on the
# non-replay path (same gating as the session.status_idle publish).
_session_idle_waiting: dict[str, bool] = {}


def _run_session_host_monitor(instance_id: str) -> None:
    start_timeout = _session_host_int(
        "DAPR_AGENT_SESSION_HOST_START_TIMEOUT_SECONDS",
        900,
    )
    idle_timeout = _session_host_int(
        "DAPR_AGENT_SESSION_HOST_IDLE_TIMEOUT_SECONDS",
        300,
    )
    # Long backstop for a session that's legitimately idle (waiting for the next
    # user prompt): interactive sessions stay warm for follow-ups, but an
    # ABANDONED one is still reaped. Genuine startup/mid-turn hangs are caught by
    # the short idle_timeout above (they are never marked idle-waiting).
    abandoned_idle_timeout = _session_host_int(
        "DAPR_AGENT_SESSION_HOST_ABANDONED_IDLE_TIMEOUT_SECONDS",
        6 * 60 * 60,
    )
    missing_grace_seconds = _session_host_int(
        "DAPR_AGENT_SESSION_HOST_MISSING_GRACE_SECONDS",
        60,
        minimum=5,
    )
    poll_seconds = _session_host_int(
        "DAPR_AGENT_SESSION_HOST_POLL_SECONDS",
        10,
    )
    sidecar_ready_timeout = _session_host_int(
        "DAPR_AGENT_SESSION_HOST_SIDECAR_READY_TIMEOUT_SECONDS",
        120,
    )
    terminal_hold_seconds = _session_host_int(
        "DAPR_AGENT_SESSION_HOST_TERMINAL_HOLD_SECONDS",
        0,
        minimum=0,
    )
    nonterminal_timeout_action = normalize_nonterminal_timeout_action(
        _session_host_env("DAPR_AGENT_SESSION_HOST_NONTERMINAL_TIMEOUT_ACTION", "warn")
    )
    started_at = time.monotonic()
    first_seen_at: float | None = None
    last_workflow_progress_at: float | None = None
    last_workflow_progress_marker: str | None = None
    last_benchmark_progress_marker: str | None = None
    missing_since: float | None = None
    sidecar_unavailable_since: float | None = None
    logger.info(
        "[session-host] monitoring workflow instance %s start_timeout=%ss idle_timeout=%ss idle_action=%s missing_grace=%ss sidecar_ready_timeout=%ss terminal_hold=%ss",
        instance_id,
        start_timeout,
        idle_timeout,
        nonterminal_timeout_action,
        missing_grace_seconds,
        sidecar_ready_timeout,
        terminal_hold_seconds,
    )
    while True:
        elapsed = time.monotonic() - started_at
        if first_seen_at is None and elapsed > start_timeout:
            message = (
                f"[session-host] workflow {instance_id} was not observed within "
                f"{start_timeout}s; exiting"
            )
            logger.error(message)
            _report_session_host_inference_failure(
                status="timeout",
                error=message,
                termination_reason="session_host_start_timeout",
            )
            _session_host_exit(instance_id, 1)
        sidecar_error = _dapr_sidecar_health_error()
        if sidecar_error is not None:
            now = time.monotonic()
            if sidecar_unavailable_since is None:
                sidecar_unavailable_since = now
            unavailable_seconds = now - sidecar_unavailable_since
            if unavailable_seconds > sidecar_ready_timeout:
                message = (
                    "[session-host] dapr sidecar stayed unavailable for "
                    f"{int(unavailable_seconds)}s while monitoring {instance_id}: "
                    f"{sidecar_error}; exiting"
                )
                logger.error(message)
                _report_session_host_inference_failure(
                    status="error",
                    error=message,
                    termination_reason="session_host_sidecar_unavailable",
                )
                _session_host_exit(instance_id, 1)
            logger.warning(
                "[session-host] dapr sidecar unavailable while monitoring %s: %s",
                instance_id,
                sidecar_error,
            )
            time.sleep(poll_seconds)
            continue
        sidecar_unavailable_since = None
        workflow_missing = False
        try:
            state = _workflow_http_get_instance(instance_id)
        except Exception as exc:  # noqa: BLE001
            logger.warning("[session-host] status check for %s failed: %s", instance_id, exc)
            state = None
        else:
            workflow_missing = state is None
        if workflow_missing:
            now = time.monotonic()
            decision = decide_missing_workflow_action(
                first_seen_at=first_seen_at,
                missing_since=missing_since,
                now=now,
                missing_grace_seconds=missing_grace_seconds,
            )
            missing_since = decision.missing_since
            if decision.exit_code == 0:
                logger.warning(
                    "[session-host] workflow %s disappeared after observation; exiting cleanly",
                    instance_id,
                )
                _session_host_exit(instance_id, 0)
            if decision.exit_code == 1:
                logger.error(
                    "[session-host] workflow %s was missing for %ss; exiting",
                    instance_id,
                    int(now - missing_since),
                )
                _session_host_exit(instance_id, 1)
        if isinstance(state, dict) and state:
            missing_since = None
            now = time.monotonic()
            progress_marker = workflow_progress_marker(state)
            if first_seen_at is None:
                first_seen_at = now
                last_workflow_progress_at = now
                last_workflow_progress_marker = progress_marker
                logger.info("[session-host] observed workflow %s", instance_id)
            elif progress_marker and progress_marker != last_workflow_progress_marker:
                last_workflow_progress_at = now
                last_workflow_progress_marker = progress_marker
            elif last_workflow_progress_at is None:
                last_workflow_progress_at = first_seen_at
            runtime_status = str(
                state.get("runtimeStatus")
                or state.get("runtime_status")
                or state.get("status")
                or ""
            ).upper()
            if _terminal_status(runtime_status):
                exit_code = 0 if runtime_status == "COMPLETED" else 1
                hold_seconds = terminal_hold_seconds_for_status(
                    runtime_status,
                    terminal_hold_seconds,
                )
                _hold_session_host_after_terminal(
                    instance_id,
                    runtime_status,
                    hold_seconds,
                    poll_seconds,
                )
                logger.info(
                    "[session-host] workflow %s terminal status=%s; exiting code=%s",
                    instance_id,
                    runtime_status,
                    exit_code,
                )
                if exit_code != 0:
                    _report_session_host_inference_failure(
                        status=(
                            "cancelled"
                            if runtime_status in {"CANCELED", "TERMINATED"}
                            else "error"
                        ),
                        error=(
                            f"[session-host] workflow {instance_id} terminal "
                            f"status={runtime_status}"
                        ),
                        termination_reason="session_host_workflow_terminal",
                    )
                _session_host_exit(instance_id, exit_code)
            progress_age = now - (last_workflow_progress_at or first_seen_at)
            if progress_age > idle_timeout:
                try:
                    benchmark_progress = _session_host_benchmark_progress()
                except Exception as exc:  # noqa: BLE001
                    benchmark_progress = None
                    logger.warning(
                        "[session-host] benchmark progress check failed for %s: %s",
                        instance_id,
                        exc,
                    )
                if benchmark_progress and benchmark_activity_is_recent(
                    benchmark_progress,
                    idle_timeout_seconds=idle_timeout,
                ):
                    marker = benchmark_activity_marker(benchmark_progress)
                    activity_age = benchmark_activity_age_seconds(benchmark_progress)
                    if marker != last_benchmark_progress_marker:
                        logger.info(
                            "[session-host] workflow %s has benchmark session activity despite stale dapr status: age=%ss type=%s",
                            instance_id,
                            benchmark_progress.get("activityAgeSeconds"),
                            benchmark_progress.get("latestSessionEventType"),
                        )
                    last_benchmark_progress_marker = marker
                    last_workflow_progress_at = (
                        now - activity_age if activity_age is not None else now
                    )
                    time.sleep(poll_seconds)
                    continue
                # Legitimately idle interactive session waiting for the next user
                # prompt — keep it warm (don't idle-terminate) until the long
                # abandoned backstop. Genuine startup/mid-turn hangs are never
                # marked idle-waiting, so they still terminate at idle_timeout.
                if (
                    _session_idle_waiting.get(instance_id)
                    and progress_age <= abandoned_idle_timeout
                ):
                    logger.info(
                        "[session-host] workflow %s idle %ss awaiting next user prompt; keeping warm (abandoned backstop %ss)",
                        instance_id,
                        int(progress_age),
                        abandoned_idle_timeout,
                    )
                    time.sleep(poll_seconds)
                    continue
                if nonterminal_timeout_action == "terminate":
                    message = (
                        f"[session-host] workflow {instance_id} made no dapr status "
                        f"or benchmark session progress for {idle_timeout}s while non-terminal; terminating "
                        "workflow and exiting"
                    )
                    logger.error(message)
                    try:
                        _workflow_http_post(instance_id, "/terminate")
                    except FileNotFoundError:
                        logger.warning(
                            "[session-host] workflow %s disappeared during idle-timeout termination",
                            instance_id,
                        )
                        _session_host_exit(instance_id, 0)
                    except Exception as exc:  # noqa: BLE001
                        logger.warning(
                            "[session-host] terminate after idle timeout failed for %s: %s",
                            instance_id,
                            exc,
                        )
                    _report_session_host_inference_failure(
                        status="timeout",
                        error=message,
                        termination_reason="session_host_nonterminal_timeout",
                    )
                    _session_host_exit(instance_id, 1)
                logger.warning(
                    "[session-host] workflow %s made no dapr status or benchmark session progress for %ss while non-terminal; continuing to monitor",
                    instance_id,
                    idle_timeout,
                )
                last_workflow_progress_at = now
        time.sleep(poll_seconds)


def _taskhub_call(method: str, request: Any) -> Any:
    import grpc
    import dapr.ext.workflow._durabletask.internal.orchestrator_service_pb2_grpc as pb_grpc

    target = (
        f"{os.environ.get('DAPR_HOST', '127.0.0.1')}:"
        f"{os.environ.get('DAPR_GRPC_PORT', '50001')}"
    )
    timeout_seconds = float(os.environ.get("TASKHUB_RPC_TIMEOUT_SECONDS", "15"))
    stub = pb_grpc.TaskHubSidecarServiceStub(grpc.insecure_channel(target))
    return getattr(stub, method)(request, timeout=timeout_seconds)


def _dapr_http_sidecar_url() -> str:
    endpoint = os.environ.get("DAPR_HTTP_ENDPOINT", "").strip()
    if endpoint:
        return endpoint.rstrip("/")
    return (
        f"http://{os.environ.get('DAPR_HOST', '127.0.0.1')}:"
        f"{os.environ.get('DAPR_HTTP_PORT', '3500')}"
    )


def _dapr_sidecar_health_error() -> str | None:
    url = f"{_dapr_http_sidecar_url()}/v1.0/healthz/outbound"
    request = urllib.request.Request(
        url,
        headers=_dapr_api_token_headers(),
        method="GET",
    )
    try:
        with urllib.request.urlopen(request, timeout=2) as response:
            response.read()
        return None
    except urllib.error.HTTPError as exc:
        detail = _workflow_http_error_text(exc)
        return f"HTTP {exc.code}: {detail[:300]}"
    except Exception as exc:  # noqa: BLE001
        return str(exc)


def _agent_readyz_require_workflow_workers() -> bool:
    return _env_bool("DAPR_AGENT_READYZ_REQUIRE_WORKFLOW_WORKERS") is not False


def _agent_readyz_timeout_seconds() -> float:
    try:
        return max(
            0.5,
            float(os.environ.get("DAPR_AGENT_READYZ_TIMEOUT_SECONDS", "2")),
        )
    except ValueError:
        return 2.0


def _agent_workflow_runtime_status() -> tuple[bool, dict[str, Any]]:
    """Return whether this agent host has a Dapr workflow worker connected."""
    details: dict[str, Any] = {
        "daprHttpUrl": _dapr_http_sidecar_url(),
        "requireWorkflowWorkers": _agent_readyz_require_workflow_workers(),
    }
    if not details["requireWorkflowWorkers"]:
        return True, details
    request = urllib.request.Request(
        f"{_dapr_http_sidecar_url()}/v1.0/metadata",
        headers=_dapr_api_token_headers(),
        method="GET",
    )
    try:
        with urllib.request.urlopen(
            request,
            timeout=_agent_readyz_timeout_seconds(),
        ) as response:
            raw = response.read()
    except urllib.error.HTTPError as exc:
        detail = _workflow_http_error_text(exc)
        details["metadataError"] = f"HTTP {exc.code}: {detail[:300]}"
        return False, details
    except Exception as exc:  # noqa: BLE001
        details["metadataError"] = str(exc)
        return False, details
    try:
        payload = json.loads(raw.decode("utf-8")) if raw else {}
    except Exception as exc:  # noqa: BLE001
        details["metadataError"] = f"invalid metadata JSON: {exc}"
        return False, details
    if not isinstance(payload, dict):
        details["metadataError"] = "metadata response was not an object"
        return False, details
    workflows = (
        payload.get("workflows") if isinstance(payload.get("workflows"), dict) else {}
    )
    scheduler = (
        payload.get("scheduler") if isinstance(payload.get("scheduler"), dict) else {}
    )
    try:
        connected_workers = int(workflows.get("connectedWorkers") or 0)
    except (TypeError, ValueError):
        connected_workers = 0
    connected_schedulers = scheduler.get("connected_addresses")
    details.update(
        {
            "appId": payload.get("id"),
            "runtimeVersion": payload.get("runtimeVersion"),
            "workflowConnectedWorkers": connected_workers,
            "schedulerConnectedAddresses": (
                connected_schedulers if isinstance(connected_schedulers, list) else []
            ),
        }
    )
    if connected_workers < 1:
        details["error"] = "workflow runtime has no connected Dapr workflow workers"
        return False, details
    return True, details


def _workflow_http_timeout_seconds() -> float:
    try:
        return max(
            0.5,
            float(os.environ.get("DAPR_WORKFLOW_HTTP_TIMEOUT_SECONDS", "15")),
        )
    except ValueError:
        return 15.0


def _workflow_http_url(instance_id: str, suffix: str = "") -> str:
    encoded_id = urllib.parse.quote(instance_id, safe="")
    return f"{_dapr_http_sidecar_url()}/v1.0/workflows/dapr/{encoded_id}{suffix}"


def _workflow_http_error_text(exc: urllib.error.HTTPError) -> str:
    try:
        return exc.read().decode("utf-8", errors="replace")
    except Exception:
        return ""


def _workflow_http_error_is_missing(status_code: int, detail: str) -> bool:
    if status_code == 404:
        return True
    lowered = detail.lower()
    return (
        "no such instance" in lowered
        or "not found" in lowered
        or "does not exist" in lowered
        or "no workflow" in lowered
    )


def _dapr_api_token_headers() -> dict[str, str]:
    token = str(os.environ.get("DAPR_API_TOKEN") or "").strip()
    return {"dapr-api-token": token} if token else {}


def _workflow_http_get_instance(instance_id: str) -> dict[str, Any] | None:
    request = urllib.request.Request(
        _workflow_http_url(instance_id),
        headers=_dapr_api_token_headers(),
        method="GET",
    )
    try:
        with urllib.request.urlopen(
            request,
            timeout=_workflow_http_timeout_seconds(),
        ) as response:
            raw = response.read().decode("utf-8", errors="replace")
    except urllib.error.HTTPError as exc:
        detail = _workflow_http_error_text(exc)
        if _workflow_http_error_is_missing(exc.code, detail):
            return None
        raise RuntimeError(
            f"Dapr workflow status failed with HTTP {exc.code}: {detail[:500]}"
        ) from exc
    return _parse_json(raw)


def _workflow_http_post(instance_id: str, suffix: str) -> None:
    request = urllib.request.Request(
        _workflow_http_url(instance_id, suffix),
        headers=_dapr_api_token_headers(),
        method="POST",
    )
    try:
        with urllib.request.urlopen(
            request,
            timeout=_workflow_http_timeout_seconds(),
        ) as response:
            response.read()
    except urllib.error.HTTPError as exc:
        detail = _workflow_http_error_text(exc)
        if _workflow_http_error_is_missing(exc.code, detail):
            raise FileNotFoundError(detail or f"Workflow {instance_id} not found") from exc
        raise RuntimeError(
            f"Dapr workflow {suffix.strip('/')} failed with HTTP {exc.code}: {detail[:500]}"
        ) from exc


def _workflow_dict_value(payload: dict[str, Any], *keys: str) -> Any:
    for key in keys:
        if key in payload:
            return payload.get(key)
    return None


def _agent_run_status_state_timeout_seconds() -> float:
    try:
        return max(
            0.1,
            float(os.environ.get("AGENT_RUN_STATUS_STATE_TIMEOUT_SECONDS", "0.5")),
        )
    except ValueError:
        return 0.5


def _list_instance_ids(page_size: int) -> list[str]:
    import dapr.ext.workflow._durabletask.internal.protos as pb

    ids: list[str] = []
    continuation_token = ""
    while len(ids) < page_size:
        request = pb.ListInstanceIDsRequest(pageSize=min(200, page_size - len(ids)))
        if continuation_token:
            request.continuationToken = continuation_token
        response = _taskhub_call("ListInstanceIDs", request)
        ids.extend([str(item) for item in response.instanceIds])
        continuation_token = str(response.continuationToken or "")
        if not continuation_token:
            break
    return ids


def _runtime_status_name(value: Any) -> str:
    import dapr.ext.workflow._durabletask.internal.protos as pb

    try:
        return pb.OrchestrationStatus.Name(value).replace("ORCHESTRATION_STATUS_", "")
    except Exception:
        return str(value or "UNKNOWN").replace("ORCHESTRATION_STATUS_", "")


def _timestamp_iso(value: Any) -> str | None:
    if value is None:
        return None
    try:
        seconds = int(getattr(value, "seconds", 0) or 0)
        nanos = int(getattr(value, "nanos", 0) or 0)
        if seconds == 0 and nanos == 0:
            return None
        return value.ToDatetime().isoformat()
    except Exception:
        return None


def _wrapped_string(value: Any) -> str | None:
    text = getattr(value, "value", None)
    return text if isinstance(text, str) and text else None


class AgentRunHistoryEventResponse(BaseModel):
    eventId: int | None = None
    eventType: str
    timestamp: str | None = None
    name: str | None = None
    input: Any = None
    output: Any = None
    metadata: dict[str, Any] | None = None
    raw: dict[str, Any] | None = None


class AgentRunHistoryResponse(BaseModel):
    instanceId: str
    events: list[AgentRunHistoryEventResponse]


class RerunAgentRunRequest(BaseModel):
    fromEventId: int = Field(
        default=0,
        description="Durable history event ID to replay from. 0 replays from start.",
    )
    newInstanceId: str | None = Field(
        default=None,
        description="Optional explicit Dapr instance ID for the replay.",
    )
    input: Any = Field(
        default=None,
        description="Replacement input sent only when overwriteInput is true.",
    )
    overwriteInput: bool = Field(
        default=False,
        description="Pass replacement input to Dapr RerunWorkflowFromEvent.",
    )
    reason: str | None = None


class TerminateAgentRunRequest(BaseModel):
    reason: str | None = None


def _read_agent_state_key(key: str, timeout_seconds: float = 5) -> Any:
    store_name = AGENT_STATE_STORE
    encoded_key = urllib.parse.quote(key, safe="")
    sidecar = (
        f"http://{os.environ.get('DAPR_HOST', '127.0.0.1')}:"
        f"{os.environ.get('DAPR_HTTP_PORT', '3500')}"
    )
    url = (
        f"{sidecar}/v1.0/state/{urllib.parse.quote(store_name, safe='')}/{encoded_key}"
        f"?metadata.partitionKey={encoded_key}"
    )
    try:
        with urllib.request.urlopen(url, timeout=timeout_seconds) as response:
            raw = response.read().decode("utf-8")
    except Exception:
        return None
    return _parse_json(raw)


def _build_instance_payload(instance_id: str) -> dict[str, Any] | None:
    import dapr.ext.workflow._durabletask.internal.protos as pb

    response = _taskhub_call(
        "GetInstance",
        pb.GetInstanceRequest(instanceId=instance_id, getInputsAndOutputs=True),
    )
    if not getattr(response, "exists", False):
        return None

    state = response.orchestrationState
    runtime_status = _runtime_status_name(getattr(state, "orchestrationStatus", None))
    started_at = _timestamp_iso(getattr(state, "createdTimestamp", None))
    last_updated_at = _timestamp_iso(getattr(state, "lastUpdatedTimestamp", None))
    completed_at = _timestamp_iso(getattr(state, "completedTimestamp", None))
    input_payload = _parse_json(_wrapped_string(getattr(state, "input", None)))
    output_payload = _parse_json(_wrapped_string(getattr(state, "output", None)))
    workflow_state_key = f"{AGENT_STATE_KEY_PREFIX}_{instance_id}".lower()
    memory_key = f"{AGENT_MEMORY_KEY_PREFIX}_{instance_id}".lower()
    status_state_timeout = _agent_run_status_state_timeout_seconds()
    workflow_state = _read_agent_state_key(
        workflow_state_key,
        timeout_seconds=status_state_timeout,
    )
    memory_state = _read_agent_state_key(
        memory_key,
        timeout_seconds=status_state_timeout,
    )
    workflow_record = workflow_state if isinstance(workflow_state, dict) else {}
    input_record = input_payload if isinstance(input_payload, dict) else {}

    return {
        "input_value": input_record.get("task") or input_record.get("prompt") or "",
        "output": (
            json.dumps(output_payload)
            if isinstance(output_payload, dict)
            else output_payload
        ),
        "start_time": started_at or "",
        "end_time": completed_at
        or (last_updated_at if _terminal_status(runtime_status) else None),
        "status": runtime_status.lower(),
        "messages": workflow_record.get("messages") or [],
        "tool_history": workflow_record.get("tool_history") or [],
        "workflow_instance_id": instance_id,
        "session_id": input_record.get("sessionId") or input_record.get("session_id"),
        "source": workflow_record.get("source") or "dapr-agents-default-state",
        "workflow_name": AGENT_SERVICE_NAME,
        "error": workflow_record.get("error"),
        "state_key": workflow_state_key,
        "memory_key": memory_key,
        "memory": memory_state,
    }


def _normalize_history_event(event: Any) -> dict[str, Any]:
    """Normalize a durabletask HistoryEvent protobuf object for Workflow Ops."""
    from google.protobuf.json_format import MessageToDict

    payload_name = "unknown"
    payload = None
    for field_descriptor, value in event.ListFields():
        if field_descriptor.name in ("eventId", "timestamp", "router"):
            continue
        payload_name = field_descriptor.name
        payload = value
        break

    payload_dict = (
        MessageToDict(payload, preserving_proto_field_name=True)
        if payload is not None
        else {}
    )

    name_value = None
    for key in ("name", "event_name", "instance_id", "task_execution_id", "task_scheduled_id"):
        value = payload_dict.get(key)
        if isinstance(value, (str, int)):
            name_value = str(value)
            break

    input_value = payload_dict.get("input")
    if isinstance(input_value, dict):
        input_value = input_value.get("value", input_value)
    output_value = payload_dict.get("result")
    if isinstance(output_value, dict):
        output_value = output_value.get("value", output_value)
    if output_value is None and "failure_details" in payload_dict:
        output_value = payload_dict.get("failure_details")

    metadata: dict[str, Any] = {}
    if "orchestration_status" in payload_dict:
        metadata["status"] = _runtime_status_name(payload_dict["orchestration_status"])
    task_id = payload_dict.get("task_scheduled_id") or payload_dict.get("task_execution_id")
    if isinstance(task_id, (str, int)):
        metadata["taskId"] = str(task_id)
    failure_details = payload_dict.get("failure_details")
    if isinstance(failure_details, dict):
        error_message = failure_details.get("error_message")
        if isinstance(error_message, str) and error_message:
            metadata["error"] = error_message
        stack_trace = failure_details.get("stack_trace")
        if isinstance(stack_trace, dict):
            stack_trace = stack_trace.get("value")
        if isinstance(stack_trace, str) and stack_trace:
            metadata["stackTrace"] = stack_trace
    rerun_parent = payload_dict.get("rerun_parent_instance_info")
    if isinstance(rerun_parent, dict):
        source_instance_id = rerun_parent.get("instance_id")
        if isinstance(source_instance_id, str) and source_instance_id:
            metadata["rerunSourceInstanceId"] = source_instance_id
    version_value = payload_dict.get("version")
    if isinstance(version_value, dict):
        version_value = version_value.get("value")
    if isinstance(version_value, str) and version_value:
        metadata["version"] = version_value

    timestamp = None
    if hasattr(event, "timestamp") and event.HasField("timestamp"):
        timestamp = event.timestamp.ToDatetime().isoformat()

    event_id = int(event.eventId) if getattr(event, "eventId", 0) > 0 else None
    event_type = payload_name[0:1].upper() + payload_name[1:]

    return {
        "eventId": event_id,
        "eventType": event_type,
        "timestamp": timestamp,
        "name": name_value,
        "input": _parse_json(input_value),
        "output": _parse_json(output_value),
        "metadata": metadata or None,
        "raw": payload_dict or None,
    }


def _get_instance_history(instance_id: str) -> list[dict[str, Any]]:
    import dapr.ext.workflow._durabletask.internal.protos as pb

    response = _taskhub_call(
        "GetInstanceHistory",
        pb.GetInstanceHistoryRequest(instanceId=instance_id),
    )
    return [_normalize_history_event(event) for event in response.events]


def _build_agent_run_status_payload(
    instance_id: str,
    *,
    summary: bool = False,
) -> dict[str, Any] | None:
    workflow_payload = _workflow_http_get_instance(instance_id)
    if not isinstance(workflow_payload, dict):
        return None

    runtime_status = str(
        _workflow_dict_value(workflow_payload, "runtimeStatus", "runtime_status")
        or "UNKNOWN"
    ).upper()
    started_at = _workflow_dict_value(
        workflow_payload,
        "createdAt",
        "created_at",
        "startedAt",
        "started_at",
    )
    last_updated_at = _workflow_dict_value(
        workflow_payload,
        "lastUpdatedAt",
        "last_updated_at",
        "updatedAt",
        "updated_at",
    )
    completed_at = _workflow_dict_value(
        workflow_payload,
        "completedAt",
        "completed_at",
    )
    if summary:
        return {
            "instanceId": instance_id,
            "appId": AGENT_SERVICE_NAME,
            "runtimeStatus": runtime_status,
            "phase": runtime_status.lower(),
            "startedAt": started_at if isinstance(started_at, str) else None,
            "completedAt": (
                completed_at
                or (last_updated_at if _terminal_status(runtime_status) else None)
            ),
        }

    input_payload = _parse_json(
        _workflow_dict_value(
            workflow_payload,
            "input",
            "serializedInput",
            "serialized_input",
        )
    )
    output_payload = _parse_json(
        _workflow_dict_value(
            workflow_payload,
            "output",
            "serializedOutput",
            "serialized_output",
        )
    )
    workflow_state_key = f"{AGENT_STATE_KEY_PREFIX}_{instance_id}".lower()
    memory_key = f"{AGENT_MEMORY_KEY_PREFIX}_{instance_id}".lower()
    status_state_timeout = _agent_run_status_state_timeout_seconds()
    workflow_state = _read_agent_state_key(
        workflow_state_key,
        timeout_seconds=status_state_timeout,
    )
    memory_state = _read_agent_state_key(
        memory_key,
        timeout_seconds=status_state_timeout,
    )
    workflow_record = workflow_state if isinstance(workflow_state, dict) else {}

    error_value = None
    if isinstance(workflow_record.get("error"), str):
        error_value = workflow_record.get("error")
    elif isinstance(output_payload, dict) and isinstance(output_payload.get("error"), str):
        error_value = output_payload.get("error")

    return {
        "instanceId": instance_id,
        "appId": AGENT_SERVICE_NAME,
        "workflowId": "agent_workflow",
        "workflowName": AGENT_SERVICE_NAME,
        "runtimeStatus": runtime_status,
        "phase": runtime_status.lower(),
        "startedAt": started_at if isinstance(started_at, str) else None,
        "completedAt": (
            completed_at
            or (last_updated_at if _terminal_status(runtime_status) else None)
        ),
        "input": input_payload,
        "outputs": output_payload,
        "properties": (
            workflow_payload.get("properties")
            if isinstance(workflow_payload.get("properties"), dict)
            else None
        ),
        "error": error_value,
        "messages": workflow_record.get("messages") or [],
        "toolHistory": workflow_record.get("tool_history") or [],
        "memory": memory_state,
        "stateKey": workflow_state_key,
        "memoryKey": memory_key,
    }


@app.get("/agent/instances")
async def list_agent_instances(limit: int = 100) -> dict[str, Any]:
    normalized_limit = max(1, min(int(limit), 500))
    instances: dict[str, Any] = {}
    for instance_id in _list_instance_ids(normalized_limit):
        payload = _build_instance_payload(instance_id)
        if payload is not None:
            instances[instance_id] = payload
    return {
        "source": "dapr-agents-default-state",
        "storeName": AGENT_STATE_STORE,
        "agentName": AGENT_SERVICE_NAME,
        "stateKey": f"{AGENT_STATE_KEY_PREFIX}_<instance_id>",
        "memoryKey": f"{AGENT_MEMORY_KEY_PREFIX}_<instance_id>",
        "found": True,
        "instances": instances,
    }


@app.get("/api/v2/agent-runs/{instance_id}/status")
def get_agent_run_status(instance_id: str, summary: bool = False) -> dict[str, Any]:
    try:
        payload = _build_agent_run_status_payload(instance_id, summary=summary)
        if payload is None:
            raise HTTPException(status_code=404, detail="Agent run not found")
        return payload
    except HTTPException:
        raise
    except Exception as exc:
        logger.error("[agent-runs] Failed to get status for %s: %s", instance_id, exc)
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@app.get("/api/v2/agent-runs/{instance_id}/history", response_model=AgentRunHistoryResponse)
def get_agent_run_history(instance_id: str) -> AgentRunHistoryResponse:
    import dapr.ext.workflow._durabletask.internal.protos as pb

    try:
        response = _taskhub_call(
            "GetInstance",
            pb.GetInstanceRequest(instanceId=instance_id, getInputsAndOutputs=False),
        )
        if not getattr(response, "exists", False):
            raise HTTPException(status_code=404, detail="Agent run not found")
        events = _get_instance_history(instance_id)
        events.sort(key=lambda item: str(item.get("timestamp") or ""), reverse=True)
        return AgentRunHistoryResponse(
            instanceId=instance_id,
            events=[AgentRunHistoryEventResponse(**event) for event in events],
        )
    except HTTPException:
        raise
    except Exception as exc:
        logger.error("[agent-runs] Failed to get history for %s: %s", instance_id, exc)
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@app.post("/api/v2/agent-runs/{instance_id}/rerun")
def rerun_agent_run(
    instance_id: str,
    request: RerunAgentRunRequest = RerunAgentRunRequest(),
) -> dict[str, Any]:
    import dapr.ext.workflow._durabletask.internal.protos as pb

    try:
        response = _taskhub_call(
            "GetInstance",
            pb.GetInstanceRequest(instanceId=instance_id, getInputsAndOutputs=False),
        )
        if not getattr(response, "exists", False):
            raise HTTPException(status_code=404, detail="Agent run not found")

        event_id = max(0, int(request.fromEventId))
        rerun_request = pb.RerunWorkflowFromEventRequest(
            sourceInstanceID=instance_id,
            eventID=event_id,
        )
        new_instance_id = str(request.newInstanceId or "").strip()
        if new_instance_id:
            rerun_request.newInstanceID = new_instance_id
        if request.overwriteInput:
            rerun_request.overwriteInput = True
            rerun_request.input.CopyFrom(
                wrappers_pb2.StringValue(
                    value=json.dumps(jsonable_encoder(request.input)),
                )
            )

        rerun_response = _taskhub_call("RerunWorkflowFromEvent", rerun_request)
        actual_new_instance_id = str(getattr(rerun_response, "newInstanceID", "") or "")
        if not actual_new_instance_id:
            raise RuntimeError("Rerun succeeded but no newInstanceID was returned")

        logger.info(
            "[agent-runs] Rerun scheduled: source=%s event_id=%s new=%s reason=%s",
            instance_id,
            event_id,
            actual_new_instance_id,
            request.reason,
        )
        return {
            "success": True,
            "sourceInstanceId": instance_id,
            "fromEventId": event_id,
            "newInstanceId": actual_new_instance_id,
        }
    except HTTPException:
        raise
    except Exception as exc:
        logger.error("[agent-runs] Failed to rerun %s: %s", instance_id, exc)
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@app.post("/api/v2/agent-runs/{instance_id}/terminate")
def terminate_agent_run(
    instance_id: str,
    request: TerminateAgentRunRequest = TerminateAgentRunRequest(),
) -> dict[str, Any]:
    try:
        _workflow_http_post(instance_id, "/terminate")
        return {"success": True, "instanceId": instance_id}
    except TimeoutError:
        logger.warning(
            "[agent-runs] Terminate request timed out for %s; polling status will confirm closure",
            instance_id,
        )
        return {
            "success": True,
            "instanceId": instance_id,
            "terminationStatusUnknown": True,
        }
    except Exception as exc:
        if isinstance(exc, FileNotFoundError) or _is_workflow_instance_missing_error(exc):
            logger.info("[agent-runs] Terminate skipped for %s: already gone", instance_id)
            return {"success": True, "instanceId": instance_id, "alreadyGone": True}
        if _is_workflow_terminate_status_unknown_error(exc):
            logger.warning(
                "[agent-runs] Terminate returned a transient workflow error for %s; polling status will confirm closure: %s",
                instance_id,
                exc,
            )
            return {
                "success": True,
                "instanceId": instance_id,
                "terminationStatusUnknown": True,
            }
        logger.error("[agent-runs] Failed to terminate %s: %s", instance_id, exc)
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@app.post("/api/v2/agent-runs/{instance_id}/pause")
def pause_agent_run(instance_id: str) -> dict[str, Any]:
    try:
        from dapr.ext.workflow import DaprWorkflowClient

        # NB: the SDK method is pause_workflow (dapr-ext-workflow 1.17.x);
        # there is no suspend_workflow — calling it 500s at runtime.
        DaprWorkflowClient().pause_workflow(instance_id=instance_id)
        return {"success": True, "instanceId": instance_id}
    except Exception as exc:
        logger.error("[agent-runs] Failed to pause %s: %s", instance_id, exc)
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@app.post("/api/v2/agent-runs/{instance_id}/resume")
def resume_agent_run(instance_id: str) -> dict[str, Any]:
    try:
        from dapr.ext.workflow import DaprWorkflowClient

        DaprWorkflowClient().resume_workflow(instance_id=instance_id)
        return {"success": True, "instanceId": instance_id}
    except Exception as exc:
        logger.error("[agent-runs] Failed to resume %s: %s", instance_id, exc)
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@app.delete("/api/v2/agent-runs/{instance_id}")
def purge_agent_run(
    instance_id: str,
    force: bool = False,
    recursive: bool = False,
) -> dict[str, Any]:
    try:
        _workflow_http_post(instance_id, "/purge")
        return {
            "success": True,
            "instanceId": instance_id,
            "force": force,
            "recursive": recursive,
            "purgeAccepted": True,
            "isComplete": True,
        }
    except Exception as exc:
        if isinstance(exc, FileNotFoundError) or _is_workflow_instance_missing_error(exc):
            logger.info("[agent-runs] Purge skipped for %s: already gone", instance_id)
            return {
                "success": True,
                "instanceId": instance_id,
                "force": force,
                "recursive": recursive,
                "alreadyGone": True,
                "isComplete": True,
            }
        logger.error("[agent-runs] Failed to purge %s: %s", instance_id, exc)
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@app.get("/plan/{execution_id}")
async def get_plan(execution_id: str) -> dict:
    """Read a persisted plan from the Dapr state store."""
    key = f"plan:{execution_id}"
    plan_data = _read_agent_state_key(key)
    if plan_data is None:
        return {"plan": None}
    if isinstance(plan_data, dict) and "plan" in plan_data:
        return {"plan": plan_data["plan"]}
    if isinstance(plan_data, str):
        return {"plan": plan_data}
    return {"plan": None}


@app.get("/internal/runtime/instances/{instance_id}/config")
def get_runtime_config(instance_id: str) -> dict[str, Any]:
    """Return the latest CloudEvents runtime-config snapshot for an instance.

    The primary lookup is the in-memory snapshot written by the setup/MCP
    activity. State fallback keeps this endpoint useful after worker restarts.
    Passing the base session id returns the latest turn snapshot for that
    session when it is still in memory.
    """
    key = str(instance_id or "").strip()
    if not key:
        raise HTTPException(status_code=400, detail="instance_id is required")
    event = (
        agent._runtime_config_by_instance.get(key)
        or agent._runtime_config_by_session.get(key)
    )
    if event:
        return event
    state_value = _read_agent_state_key(runtime_config_state_key(key))
    if isinstance(state_value, dict):
        return state_value
    context = agent._runtime_context_for_instance(key)
    session_id = str(context.get("sessionId") or key).strip()
    if context and session_id:
        event = build_runtime_config_event(
            session_id=session_id,
            instance_id=key,
            turn=context.get("turn"),
            config_revision=context.get("configRevision"),
            context=context,
            effective_config=(
                context.get("effectiveAgentConfig")
                if isinstance(context.get("effectiveAgentConfig"), dict)
                else {}
            ),
            instruction_bundle=(
                context.get("instructionBundle")
                if isinstance(context.get("instructionBundle"), dict)
                else {}
            ),
            mlflow_context=(
                context.get("mlflowContext")
                if isinstance(context.get("mlflowContext"), dict)
                else {}
            ),
            dapr_app_id=str(
                context.get("agentAppId")
                or os.environ.get("APP_ID")
                or os.environ.get("DAPR_APP_ID")
                or AGENT_SERVICE_NAME
            ),
            source="memory",
        )
        agent._runtime_config_by_instance[key] = event
        agent._runtime_config_by_session[session_id] = event
        return event
    raise HTTPException(status_code=404, detail="Runtime config not found")


@app.post("/internal/sessions/spawn")
def spawn_session_endpoint(request: dict) -> dict:
    """Start a session_workflow instance on this sidecar (Phase 4 bridge).

    The BFF can't invoke the Dapr workflow HTTP API cross-app via
    placement — actor routing requires the workflow runtime to be
    registered on the initiating sidecar, and workflow-builder has
    none. Instead the BFF service-invokes this endpoint, and the call
    runs on dapr-agent-py's own sidecar which owns session_workflow.

    Body: { instanceId: str, payload: dict }
    """
    import dapr.ext.workflow._durabletask.internal.protos as pb

    instance_id = str(request.get("instanceId") or "").strip()
    if not instance_id:
        raise HTTPException(status_code=400, detail="instanceId is required")
    payload = request.get("payload") or {}

    create_request = pb.CreateInstanceRequest(
        instanceId=instance_id,
        name="session_workflow",
        input=wrappers_pb2.StringValue(value=json.dumps(payload)),
    )
    try:
        _taskhub_call("StartInstance", create_request)
    except Exception as exc:  # noqa: BLE001
        # StartInstance errors on duplicate instanceId — treat as idempotent.
        msg = str(exc)
        if "already exists" in msg.lower() or "ALREADY_EXISTS" in msg:
            logger.info("[spawn] instance %s already exists — reusing", instance_id)
        else:
            logger.exception("[spawn] StartInstance failed for %s", instance_id)
            raise HTTPException(status_code=500, detail=f"StartInstance failed: {msg}")

    return {"instanceId": instance_id, "ok": True}


@app.post("/internal/sessions/raise-event")
def raise_session_event_endpoint(request: dict) -> dict:
    """Raise an external event into a running session_workflow instance.

    Body: { instanceId: str, eventName: str, payload: dict }
    """
    import dapr.ext.workflow._durabletask.internal.protos as pb

    instance_id = str(request.get("instanceId") or "").strip()
    event_name = str(request.get("eventName") or "").strip()
    payload = request.get("payload") or {}
    if not instance_id or not event_name:
        raise HTTPException(status_code=400, detail="instanceId + eventName required")
    if event_name in TERMINAL_CONTROL_EVENT_TYPES:
        try:
            _save_session_cancellation_request(instance_id, event_name, payload)
        except Exception as exc:  # noqa: BLE001
            logger.warning(
                "[session] failed to persist cancellation request for %s: %s",
                instance_id,
                exc,
            )
    event_name, payload = external_control_event_as_user_event(event_name, payload)

    raise_request = pb.RaiseEventRequest(
        instanceId=instance_id,
        name=event_name,
        input=wrappers_pb2.StringValue(value=json.dumps(payload)),
    )
    try:
        _taskhub_call("RaiseEvent", raise_request)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=500, detail=f"RaiseEvent failed: {exc}")

    return {"ok": True}


@app.post("/api/grader-evaluate")
def grader_evaluate(payload: dict):
    """Synchronous one-shot LLM call for the workflow-builder evaluations
    `score_model` (Model labeler / Model scorer) graders.

    The BFF side calls this via Dapr service-invoke after waking the per-agent
    runtime pod. We bypass the workflow / agent runtime entirely and call the
    Anthropic SDK directly with the supplied system + user prompts. No tools,
    no compaction, no MCP — graders are stateless.

    Body shape:
        {
          "systemPrompt": str?,
          "userPrompt": str,
          "model": str? (component name),
          "responseSchema": dict? (JSON Schema; when set, request a strict
              tool-call response shaped like the schema),
          "responseToolName": str? (defaults to "emit_evaluation"),
        }

    Response:
        {
          "output": str,                 # text content (empty when toolUse set)
          "toolUse": {                   # present iff responseSchema was set
              "name": str,
              "input": dict,
          } | None,
        }
    """
    user_prompt = str(payload.get("userPrompt") or "").strip()
    system_prompt = str(payload.get("systemPrompt") or "")
    component = (
        str(payload.get("model") or "").strip()
        or os.environ.get("EVALUATIONS_GRADER_LLM_COMPONENT", "")
        or DEFAULT_LLM_COMPONENT
    )
    response_schema = payload.get("responseSchema")
    if response_schema is not None and not isinstance(response_schema, dict):
        raise HTTPException(status_code=400, detail="responseSchema must be a JSON object")
    response_tool_name = str(payload.get("responseToolName") or "emit_evaluation").strip()

    if not user_prompt:
        raise HTTPException(status_code=400, detail="userPrompt is required")

    try:
        from src.anthropic_adapter import _call_anthropic_sdk
    except Exception as exc:  # pragma: no cover - import failure surfaces config issue
        raise HTTPException(status_code=500, detail=f"adapter import failed: {exc}")

    messages = [{"role": "user", "content": user_prompt}]
    kwargs: dict = {}
    if system_prompt.strip():
        kwargs["system"] = system_prompt

    forced_tool: list[dict] | None = None
    if response_schema is not None:
        # Strict-mode forced single tool. Anthropic constrains the response to
        # the supplied input_schema (grammar-constrained decoding) and returns
        # a single tool_use block whose `input` is the schema-conformant dict.
        # See docs.anthropic.com/en/docs/agents-and-tools/tool-use/strict-tool-use
        forced_tool = [{
            "name": response_tool_name,
            "description": "Emit a strictly-typed evaluation result.",
            "input_schema": response_schema,
            "strict": True,
        }]
        kwargs["tool_choice"] = {"type": "tool", "name": response_tool_name}

    try:
        result = _call_anthropic_sdk(
            component=component,
            messages=messages,
            tools=forced_tool,
            **kwargs,
        )
    except Exception as exc:  # noqa: BLE001
        logger.warning("[grader-evaluate] LLM call failed: %s", exc)
        raise HTTPException(status_code=502, detail=f"LLM call failed: {exc}")

    content = result.get("content") if isinstance(result, dict) else None
    if isinstance(content, list):
        # Anthropic SDK returns a list of blocks; concatenate text blocks
        parts = []
        for block in content:
            if isinstance(block, dict) and block.get("type") == "text":
                parts.append(str(block.get("text", "")))
            elif hasattr(block, "type") and getattr(block, "type", "") == "text":
                parts.append(str(getattr(block, "text", "")))
        output = "".join(parts)
    else:
        output = str(content or "")

    tool_use_resp: dict | None = None
    tool_calls = result.get("tool_calls") if isinstance(result, dict) else None
    if isinstance(tool_calls, list) and tool_calls:
        first = tool_calls[0]
        fn = first.get("function") if isinstance(first, dict) else None
        if isinstance(fn, dict):
            args_raw = fn.get("arguments")
            args_dict: dict | None = None
            if isinstance(args_raw, str):
                try:
                    args_dict = json.loads(args_raw)
                except (ValueError, TypeError):
                    args_dict = None
            elif isinstance(args_raw, dict):
                args_dict = args_raw
            if isinstance(args_dict, dict):
                tool_use_resp = {"name": fn.get("name") or response_tool_name, "input": args_dict}

    return {"output": output, "toolUse": tool_use_resp}


@app.get("/healthz")
async def health_check() -> dict:
    return {"status": "healthy", "service": AGENT_SERVICE_NAME}


@app.get("/readyz")
async def readiness_check() -> dict:
    ready, runtime_status = _agent_workflow_runtime_status()
    if not ready:
        raise HTTPException(
            status_code=503,
            detail={
                "status": "not_ready",
                "service": AGENT_SERVICE_NAME,
                "code": "workflow_runtime_unavailable",
                "runtimeStatus": runtime_status,
            },
        )
    return {
        "status": "ready",
        "service": AGENT_SERVICE_NAME,
        "runtimeStatus": runtime_status,
    }

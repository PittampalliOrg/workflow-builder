"""CMA session-event helpers for Diagrid's durable ADK runner.

The Diagrid workflow/activity wrappers call these helpers from durable
activities or replay-guarded workflow sections. Payloads intentionally stay
small and use the same high-level fields as dapr-agent-py's session_events
where the event types overlap.
"""

from __future__ import annotations

import json
import logging
from typing import Any, Mapping

from src.event_publisher import publish_session_event

logger = logging.getLogger(__name__)

_PREVIEW_CHARS = 500
_MAX_JSON_CHARS = 12_000


def _clean_string(value: Any) -> str | None:
    if value is None:
        return None
    text = str(value).strip()
    return text or None


def _int_or_zero(value: Any) -> int:
    if value is None or isinstance(value, bool):
        return 0
    try:
        return int(value)
    except (TypeError, ValueError):
        return 0


def _jsonable(value: Any) -> Any:
    if value is None or isinstance(value, (str, int, float, bool)):
        return value
    if isinstance(value, Mapping):
        return {str(key): _jsonable(entry) for key, entry in value.items()}
    if isinstance(value, (list, tuple, set)):
        return [_jsonable(entry) for entry in value]
    if hasattr(value, "model_dump"):
        try:
            return _jsonable(value.model_dump(mode="json", exclude_none=True))
        except TypeError:
            return _jsonable(value.model_dump(exclude_none=True))
        except Exception:  # noqa: BLE001
            pass
    if hasattr(value, "to_dict"):
        try:
            return _jsonable(value.to_dict())
        except Exception:  # noqa: BLE001
            pass
    return str(value)


def _size_bytes(value: Any) -> int:
    try:
        return len(
            json.dumps(value, default=str, ensure_ascii=False).encode("utf-8", "ignore")
        )
    except Exception:
        return len(str(value).encode("utf-8", "ignore"))


def _compact_value(value: Any) -> tuple[Any, str | None, bool, int]:
    payload = _jsonable(value)
    size = _size_bytes(payload)
    preview = None
    oversized = size > _MAX_JSON_CHARS
    if isinstance(payload, str):
        preview = payload[:_PREVIEW_CHARS]
        if oversized:
            payload = (
                payload[:_MAX_JSON_CHARS]
                + f"... [+{len(payload) - _MAX_JSON_CHARS} chars truncated]"
            )
    else:
        try:
            preview = json.dumps(payload, default=str, ensure_ascii=False)[
                :_PREVIEW_CHARS
            ]
        except Exception:
            preview = str(payload)[:_PREVIEW_CHARS]
        if oversized:
            payload = {"preview": preview, "truncated": True}
    return payload, preview, oversized, size


def _tool_output_error(value: Any) -> str | None:
    payload = _jsonable(value)
    if isinstance(payload, Mapping):
        return _clean_string(payload.get("error"))
    if isinstance(payload, str):
        text = payload.strip()
        if text.lower().startswith("error:"):
            return text[:1000]
        if text.startswith("{"):
            try:
                parsed = json.loads(text)
            except (TypeError, ValueError):
                return None
            if isinstance(parsed, Mapping):
                return _clean_string(parsed.get("error"))
    return None


def _session_id(ctx: Mapping[str, Any]) -> str | None:
    return (
        _clean_string(ctx.get("agent.session.id"))
        or _clean_string(ctx.get("workflow_builder.session_id"))
        or _clean_string(ctx.get("session.id"))
    )


def _instance_id(ctx: Mapping[str, Any]) -> str:
    return (
        _clean_string(ctx.get("workflow.instance_id"))
        or _clean_string(ctx.get("workflow.execution.id"))
        or _clean_string(ctx.get("agent.session.id"))
        or "unknown-instance"
    )


def _iteration_index(ctx: Mapping[str, Any]) -> int:
    return _int_or_zero(ctx.get("agent.iteration")) + 1


def _source_event_id(
    ctx: Mapping[str, Any],
    phase: str,
    *,
    tool_call_id: Any | None = None,
) -> str:
    base = f"adk:{_instance_id(ctx)}:i{_iteration_index(ctx)}"
    if tool_call_id is None:
        return f"{base}:{phase}"
    return f"{base}:tool:{_clean_string(tool_call_id) or 'unknown-tool'}:{phase}"


def _provider_context(
    ctx: Mapping[str, Any],
    agent_config: Mapping[str, Any] | None = None,
) -> dict[str, Any]:
    cfg = agent_config or {}
    model = (
        _clean_string(cfg.get("model"))
        or _clean_string(ctx.get("gen_ai.request.model"))
        or _clean_string(ctx.get("llm.model"))
    )
    provider = (
        _clean_string(cfg.get("provider"))
        or _clean_string(ctx.get("gen_ai.system"))
        or "gemini"
    )
    component = (
        _clean_string(cfg.get("component_name"))
        or _clean_string(ctx.get("dapr.component"))
        or (f"llm-{provider}" if provider else None)
    )
    payload: dict[str, Any] = {
        "model": model or component,
        "provider": provider,
        "component": component,
        "agent_id": ctx.get("agent.id"),
        "agent_version": ctx.get("agent.version"),
        "agent_slug": ctx.get("agent.slug"),
        "agent_app_id": ctx.get("agent.app_id"),
        "workflow_execution_id": ctx.get("workflow.execution.id"),
        "workflow_node_id": ctx.get("workflow.node.id"),
        "workflow_node_name": ctx.get("workflow.node.name"),
    }
    return {key: value for key, value in payload.items() if value not in (None, "")}


def _publish(
    ctx: Mapping[str, Any],
    event_type: str,
    data: dict[str, Any],
    *,
    phase: str,
    tool_call_id: Any | None = None,
) -> None:
    session_id = _session_id(ctx)
    if not session_id:
        return
    try:
        publish_session_event(
            session_id,
            event_type,
            data,
            source_event_id=_source_event_id(ctx, phase, tool_call_id=tool_call_id),
            instance_id=_instance_id(ctx),
        )
    except Exception as exc:  # noqa: BLE001
        logger.debug("[adk-session-events] publish %s failed: %s", event_type, exc)


def publish_adk_iteration(
    ctx: Mapping[str, Any],
    agent_config: Mapping[str, Any] | None = None,
    *,
    max_iterations: Any = None,
) -> None:
    payload = {
        "v": 1,
        "index": _iteration_index(ctx),
        "max": _int_or_zero(max_iterations) or None,
        **_provider_context(ctx, agent_config),
    }
    _publish(ctx, "agent.iteration", payload, phase="iteration")


def publish_adk_llm_start(
    ctx: Mapping[str, Any],
    agent_config: Mapping[str, Any] | None = None,
) -> None:
    payload = _provider_context(ctx, agent_config)
    _publish(ctx, "llm_start", payload, phase="llm_start")


def publish_adk_llm_usage(
    ctx: Mapping[str, Any],
    agent_config: Mapping[str, Any] | None,
    usage: Mapping[str, Any] | None,
    *,
    duration_ms: float | None = None,
    success: bool = True,
    error: str | None = None,
) -> None:
    if not usage:
        return
    payload: dict[str, Any] = {
        **_provider_context(ctx, agent_config),
        **{key: value for key, value in dict(usage).items() if value is not None},
        "success": success,
    }
    if duration_ms is not None:
        payload["duration_ms"] = duration_ms
        payload.setdefault("ttft_ms", duration_ms)
    if error:
        payload["error"] = error[:200]
    _publish(ctx, "agent.llm_usage", payload, phase="llm_usage")


def publish_adk_tool_use(ctx: Mapping[str, Any], tool_call: Mapping[str, Any]) -> None:
    args = tool_call.get("args") if isinstance(tool_call, Mapping) else None
    payload_input, input_preview, oversized, size_bytes = _compact_value(args or {})
    payload: dict[str, Any] = {
        "tool_call_id": tool_call.get("id"),
        "name": tool_call.get("name"),
        "input": payload_input,
        "input_preview": input_preview,
        "oversized": oversized,
        "size_bytes": size_bytes,
    }
    payload.update(_provider_context(ctx))
    _publish(
        ctx,
        "agent.tool_use",
        {key: value for key, value in payload.items() if value is not None},
        phase="tool_use",
        tool_call_id=tool_call.get("id"),
    )


def publish_adk_tool_result(
    ctx: Mapping[str, Any],
    tool_result: Mapping[str, Any],
    *,
    duration_ms: float | None = None,
) -> None:
    output = tool_result.get("result")
    payload_output, output_preview, oversized, size_bytes = _compact_value(output)
    error = _clean_string(tool_result.get("error")) or _tool_output_error(output)
    payload: dict[str, Any] = {
        "tool_call_id": tool_result.get("tool_call_id"),
        "tool_name": tool_result.get("tool_name"),
        "output": payload_output,
        "output_preview": output_preview,
        "error": error,
        "success": error is None,
        "is_error": bool(error),
        "duration_ms": duration_ms,
        "oversized": oversized,
        "size_bytes": size_bytes,
    }
    payload.update(_provider_context(ctx))
    _publish(
        ctx,
        "agent.tool_result",
        {key: value for key, value in payload.items() if value is not None},
        phase="tool_result",
        tool_call_id=tool_result.get("tool_call_id"),
    )


def publish_adk_event_actions(
    ctx: Mapping[str, Any],
    tool_call: Mapping[str, Any],
    event_actions: Any,
) -> None:
    if event_actions is None:
        return
    tool_call_id = tool_call.get("id")
    base: dict[str, Any] = {
        "tool_call_id": tool_call_id,
        "tool_name": tool_call.get("name"),
        **_provider_context(ctx),
    }

    def emit(event_type: str, phase: str, key: str, value: Any) -> None:
        if value in (None, False, ""):
            return
        if isinstance(value, (dict, list, tuple, set)) and len(value) == 0:
            return
        compact, preview, oversized, size_bytes = _compact_value(value)
        payload = {
            **base,
            key: compact,
            "preview": preview,
            "oversized": oversized,
            "size_bytes": size_bytes,
        }
        _publish(
            ctx,
            event_type,
            {k: v for k, v in payload.items() if v is not None},
            phase=phase,
            tool_call_id=tool_call_id,
        )

    emit(
        "adk.state_delta",
        "state_delta",
        "state_delta",
        getattr(event_actions, "state_delta", None),
    )
    emit(
        "adk.artifact_delta",
        "artifact_delta",
        "artifact_delta",
        getattr(event_actions, "artifact_delta", None),
    )
    emit(
        "adk.auth_request",
        "auth_request",
        "requested_auth_configs",
        getattr(event_actions, "requested_auth_configs", None),
    )
    emit(
        "adk.tool_confirmation_request",
        "tool_confirmation_request",
        "requested_tool_confirmations",
        getattr(event_actions, "requested_tool_confirmations", None),
    )
    emit(
        "adk.transfer",
        "transfer",
        "transfer_to_agent",
        getattr(event_actions, "transfer_to_agent", None),
    )
    emit(
        "adk.escalation",
        "escalation",
        "escalate",
        getattr(event_actions, "escalate", None),
    )
    emit(
        "adk.ui_widget",
        "ui_widget",
        "render_ui_widgets",
        getattr(event_actions, "render_ui_widgets", None),
    )

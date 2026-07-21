"""Beta detailed tracing helpers.

Port of `utils/telemetry/betaSessionTracing.ts`. Gated on
`ENABLE_BETA_TRACING_DETAILED` (matches TS env flag). When enabled, spans
get content-heavy attributes (system_prompt, new_context, tools, model
output). All content is truncated at 60KB (Honeycomb's attribute limit).

Per-session dedup: system prompts and tool schemas emit a full-content OTEL
log event once per unique hash; subsequent requests with the same hash only
set the hash attribute on the span. Same pattern as TS `seenHashes`.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import threading
from typing import Any

from .content_sanitizer import (
    sanitize_content_for_telemetry,
    sanitize_text_for_telemetry,
)

MAX_CONTENT_SIZE = 60 * 1024  # 60KB — matches TS

_seen_hashes: set[str] = set()
_last_reported_message_hash: dict[str, str] = {}
_state_lock = threading.Lock()

_SYSTEM_REMINDER_RE = re.compile(
    r"^<system-reminder>\n?([\s\S]*?)\n?</system-reminder>$"
)


def _is_env_truthy(raw: str | None) -> bool:
    if raw is None:
        return False
    return raw.strip().lower() in {"1", "true", "yes", "on"}


def is_beta_tracing_enabled() -> bool:
    """Match TS `isBetaTracingEnabled()` — require the detail flag.

    The TS version also requires `BETA_TRACING_ENDPOINT` and runs GrowthBook
    gating for non-ant users; in the Python/Dapr deployment we only honor
    the env flag (internal deploy, no GrowthBook).
    """
    return _is_env_truthy(os.environ.get("ENABLE_BETA_TRACING_DETAILED"))


def truncate_content(
    content: str, max_size: int = MAX_CONTENT_SIZE
) -> tuple[str, bool]:
    content = sanitize_text_for_telemetry(content)
    if len(content) <= max_size:
        return content, False
    return (
        content[:max_size] + "\n\n[TRUNCATED - Content exceeds 60KB limit]",
        True,
    )


def _short_hash(content: str) -> str:
    return hashlib.sha256(content.encode("utf-8")).hexdigest()[:12]


def hash_system_prompt(prompt: str) -> str:
    return f"sp_{_short_hash(prompt)}"


def hash_tool_schema(tool_json: str) -> str:
    return _short_hash(tool_json)


def clear_beta_tracing_state() -> None:
    """Call after compaction — hashes become irrelevant once history is replaced."""
    with _state_lock:
        _seen_hashes.clear()
        _last_reported_message_hash.clear()


def _remember_hash_once(key: str) -> bool:
    """Return True the first time `key` is seen in this process."""
    with _state_lock:
        if key in _seen_hashes:
            return False
        _seen_hashes.add(key)
        return True


def extract_system_reminder(text: str) -> str | None:
    m = _SYSTEM_REMINDER_RE.match(text.strip())
    if not m:
        return None
    inner = m.group(1)
    return inner.strip() if inner is not None else None


def add_interaction_attributes(span: Any, user_prompt: str) -> None:
    """Equivalent of TS `addBetaInteractionAttributes`."""
    if not is_beta_tracing_enabled() or span is None:
        return
    safe_prompt = sanitize_text_for_telemetry(user_prompt)
    content, truncated = truncate_content(f"[USER PROMPT]\n{safe_prompt}")
    span.set_attribute("new_context", content)
    if truncated:
        span.set_attribute("new_context_truncated", True)
        span.set_attribute("new_context_original_length", len(user_prompt))


def add_llm_request_attributes(
    span: Any,
    *,
    system_prompt: str | None = None,
    query_source: str | None = None,
    tools_json: str | None = None,
    messages_for_api: list[dict[str, Any]] | None = None,
) -> None:
    """Equivalent of TS `addBetaLLMRequestAttributes`.

    Emits `system_prompt` + `tool` log events once per unique hash and sets
    per-span hash / preview / length attributes. `messages_for_api` is the
    list passed to the provider SDK; used to compute incremental new_context.
    """
    if not is_beta_tracing_enabled() or span is None:
        return

    # Late import — avoids circular import at module load.
    from .events import log_otel_event

    if system_prompt:
        prompt_hash = hash_system_prompt(system_prompt)
        span.set_attribute("system_prompt_hash", prompt_hash)
        span.set_attribute(
            "system_prompt_preview", sanitize_text_for_telemetry(system_prompt[:500])
        )
        span.set_attribute("system_prompt_length", len(system_prompt))
        if _remember_hash_once(prompt_hash):
            content, truncated = truncate_content(system_prompt)
            event_attrs = {
                "system_prompt_hash": prompt_hash,
                "system_prompt": content,
                "system_prompt_length": str(len(system_prompt)),
            }
            if truncated:
                event_attrs["system_prompt_truncated"] = "true"
            log_otel_event("system_prompt", event_attrs)
            try:
                span.add_event(
                    "claude_code.system_prompt",
                    attributes={
                        k: str(v) for k, v in event_attrs.items() if v is not None
                    },
                )
            except Exception:
                pass

    if tools_json:
        try:
            tools_array = json.loads(tools_json)
            if isinstance(tools_array, list):
                pairs = []
                for tool in tools_array:
                    if not isinstance(tool, dict):
                        continue
                    tool_str = json.dumps(
                        sanitize_content_for_telemetry(tool), sort_keys=True
                    )
                    th = hash_tool_schema(tool_str)
                    name = tool.get("name")
                    if not isinstance(name, str):
                        # OpenAI/DeepSeek-style tool defs nest the name under
                        # function.name. Fall through to "unknown" only when
                        # neither the flat nor the nested form has a string.
                        fn = tool.get("function")
                        if isinstance(fn, dict):
                            candidate = fn.get("name")
                            if isinstance(candidate, str):
                                name = candidate
                    if not isinstance(name, str):
                        name = "unknown"
                    pairs.append((name, th, tool_str))

                span.set_attribute(
                    "tools",
                    json.dumps([{"name": n, "hash": h} for n, h, _ in pairs]),
                )
                span.set_attribute("tools_count", len(pairs))

                for name, th, tool_str in pairs:
                    if _remember_hash_once(f"tool_{th}"):
                        content, truncated = truncate_content(tool_str)
                        event_attrs = {
                            "tool_name": name,
                            "tool_hash": th,
                            "tool": content,
                        }
                        if truncated:
                            event_attrs["tool_truncated"] = "true"
                        log_otel_event("tool", event_attrs)
                        try:
                            span.add_event(
                                "claude_code.tool",
                                attributes={
                                    k: str(v)
                                    for k, v in event_attrs.items()
                                    if v is not None
                                },
                            )
                        except Exception:
                            pass
        except (ValueError, TypeError):
            span.set_attribute("tools_parse_error", True)

    # Incremental new_context — tracked per query_source like TS.
    if messages_for_api and query_source:
        _apply_new_context(span, query_source, messages_for_api)


def _hash_message(message: dict[str, Any]) -> str:
    try:
        payload = json.dumps(message.get("content"), sort_keys=True, default=str)
    except (TypeError, ValueError):
        payload = str(message.get("content"))
    return f"msg_{_short_hash(payload)}"


def _apply_new_context(
    span: Any, query_source: str, messages: list[dict[str, Any]]
) -> None:
    with _state_lock:
        last_hash = _last_reported_message_hash.get(query_source)

    start_idx = 0
    if last_hash:
        for i, msg in enumerate(messages):
            if _hash_message(msg) == last_hash:
                start_idx = i + 1
                break

    new_messages = [m for m in messages[start_idx:] if m.get("role") == "user"]
    if not new_messages:
        return

    context_parts: list[str] = []
    system_reminders: list[str] = []
    for msg in new_messages:
        content = msg.get("content")
        if isinstance(content, str):
            safe_content = sanitize_text_for_telemetry(content)
            reminder = extract_system_reminder(safe_content)
            if reminder is not None:
                system_reminders.append(reminder)
            else:
                context_parts.append(f"[USER]\n{safe_content}")
        elif isinstance(content, list):
            for block in content:
                if not isinstance(block, dict):
                    continue
                btype = block.get("type")
                if btype == "text" and isinstance(block.get("text"), str):
                    safe_text = sanitize_text_for_telemetry(block["text"])
                    reminder = extract_system_reminder(safe_text)
                    if reminder is not None:
                        system_reminders.append(reminder)
                    else:
                        context_parts.append(f"[USER]\n{safe_text}")
                elif btype == "tool_result":
                    raw = block.get("content")
                    result_content = (
                        sanitize_text_for_telemetry(raw)
                        if isinstance(raw, str)
                        else json.dumps(
                            sanitize_content_for_telemetry(raw), default=str
                        )
                    )
                    reminder = extract_system_reminder(result_content)
                    tool_use_id = block.get("tool_use_id", "")
                    if reminder is not None:
                        system_reminders.append(reminder)
                    else:
                        context_parts.append(
                            f"[TOOL RESULT: {tool_use_id}]\n{result_content}"
                        )

    if context_parts:
        full_ctx = "\n\n---\n\n".join(context_parts)
        content, truncated = truncate_content(full_ctx)
        span.set_attribute("new_context", content)
        span.set_attribute("new_context_message_count", len(new_messages))
        if truncated:
            span.set_attribute("new_context_truncated", True)
            span.set_attribute("new_context_original_length", len(full_ctx))
    if system_reminders:
        full_rem = "\n\n---\n\n".join(system_reminders)
        content, truncated = truncate_content(full_rem)
        span.set_attribute("system_reminders", content)
        span.set_attribute("system_reminders_count", len(system_reminders))
        if truncated:
            span.set_attribute("system_reminders_truncated", True)
            span.set_attribute("system_reminders_original_length", len(full_rem))

    last_message = messages[-1]
    with _state_lock:
        _last_reported_message_hash[query_source] = _hash_message(last_message)


def add_llm_response_attributes(
    end_attrs: dict[str, Any],
    *,
    model_output: str | None = None,
    thinking_output: str | None = None,
) -> None:
    """Equivalent of TS `addBetaLLMResponseAttributes`."""
    if not is_beta_tracing_enabled():
        return

    if model_output is not None:
        content, truncated = truncate_content(model_output)
        end_attrs["response.model_output"] = content
        if truncated:
            end_attrs["response.model_output_truncated"] = True
            end_attrs["response.model_output_original_length"] = len(model_output)

    if thinking_output is not None:
        content, truncated = truncate_content(thinking_output)
        end_attrs["response.thinking_output"] = content
        if truncated:
            end_attrs["response.thinking_output_truncated"] = True
            end_attrs["response.thinking_output_original_length"] = len(thinking_output)


def add_tool_input_attributes(span: Any, tool_name: str, tool_input: str) -> None:
    if not is_beta_tracing_enabled() or span is None:
        return
    safe_input = sanitize_text_for_telemetry(tool_input)
    content, truncated = truncate_content(f"[TOOL INPUT: {tool_name}]\n{safe_input}")
    span.set_attribute("tool_input", content)
    if truncated:
        span.set_attribute("tool_input_truncated", True)
        span.set_attribute("tool_input_original_length", len(tool_input))


def add_tool_result_attributes(
    end_attrs: dict[str, Any], tool_name: str, tool_result: str
) -> None:
    if not is_beta_tracing_enabled():
        return
    safe_result = sanitize_text_for_telemetry(tool_result)
    content, truncated = truncate_content(f"[TOOL RESULT: {tool_name}]\n{safe_result}")
    end_attrs["new_context"] = content
    if truncated:
        end_attrs["new_context_truncated"] = True
        end_attrs["new_context_original_length"] = len(tool_result)

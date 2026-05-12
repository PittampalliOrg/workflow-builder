"""OpenAI Responses API adapter for DaprChatClient."""

from __future__ import annotations

import json
import logging
import os
from typing import Any
from urllib.error import HTTPError
import urllib.request

from src.instruction_bundle import SYSTEM_PROMPT_DYNAMIC_BOUNDARY
from src.provider_conformance import (
    build_llm_chat_response,
    parse_structured_response,
    strict_json_schema,
)

logger = logging.getLogger(__name__)

# Mirror the Anthropic adapter's threshold so cross-provider telemetry uses
# the same eligibility cut. OpenAI's automatic prefix cache requires ≥1024
# tokens (≈4000 chars), same minimum as Anthropic's manual cache_control.
SYSTEM_PROMPT_CACHE_THRESHOLD_CHARS = int(
    os.environ.get("DAPR_AGENT_PY_SYSTEM_PROMPT_CACHE_THRESHOLD_CHARS", "4000")
)

COMPONENT_MODEL_MAP: dict[str, str] = {
    "llm-openai-gpt5": "gpt-5.4",
    "llm-openai-o3": "o3",
}


def _is_openai_component(component: str) -> bool:
    return component in COMPONENT_MODEL_MAP or "openai" in component.lower()


def _get_openai_model(component: str) -> str:
    return COMPONENT_MODEL_MAP.get(component, os.environ.get("OPENAI_DEFAULT_MODEL", "gpt-5.4"))


def _tool_schema(tool: Any) -> dict[str, Any]:
    schema: dict[str, Any] = {"type": "object", "properties": {}}
    if hasattr(tool, "args_model") and tool.args_model:
        try:
            schema = tool.args_model.model_json_schema()
        except Exception:
            schema = {"type": "object", "properties": {}}
    return {
        "type": "function",
        "name": tool.name,
        "description": getattr(tool, "description", "") or tool.name,
        "parameters": schema,
    }


def derive_openai_cache_key(bundle: dict[str, Any] | None) -> str | None:
    """Build a stable `prompt_cache_key` from an instruction bundle.

    OpenAI hashes `(org_id, prompt_prefix)` to pick a cache shard by default,
    which means different pods can land on different backends and cold-start
    each one. Passing a stable key pins all requests for the same agent
    profile to the same shard.

    Granularity is per-agent-version: bumping the agent (a republish) creates
    a new key, which is correct because the underlying content changed
    anyway. We don't include configHash directly — agent_version already
    captures content identity.

    Returns None when we can't derive a stable key (ephemeral inline
    workflow agents without an id+version pair). Callers should treat None
    as "don't pass the field" so OpenAI's default routing applies.
    """
    if not isinstance(bundle, dict):
        return None
    agent = bundle.get("agent") or {}
    agent_id = agent.get("id")
    version = agent.get("version")
    if isinstance(agent_id, str) and agent_id and isinstance(version, int):
        return f"{agent_id}:{version}"
    slug = agent.get("slug")
    if isinstance(slug, str) and slug and isinstance(version, int):
        return f"{slug}:{version}"
    config_hash = agent.get("configHash")
    if isinstance(config_hash, str) and config_hash:
        return f"cfg:{config_hash[:16]}"
    return None


def _measure_openai_prompt(system: str | None) -> tuple[str | None, dict[str, Any]]:
    """Split a bundle-rendered system string at SYSTEM_PROMPT_DYNAMIC_BOUNDARY,
    return the sentinel-stripped text plus telemetry mirroring the Anthropic
    adapter's shape.

    OpenAI doesn't expose `cache_control`; the server caches any prefix
    ≥1024 tokens automatically. The sentinel is meaningless to the OpenAI
    API, so we strip it before sending. The telemetry still captures the
    bundle's intended static/dynamic split so cross-provider dashboards
    can compare prefix sizes apples-to-apples.

    `cache_ttl` is always `'auto'` for OpenAI — the server picks 5–10 min
    (sometimes longer off-peak) and there's no API knob. `cache_breakpoints`
    is `1` when eligible (the implicit prefix-match breakpoint) else `0`.
    """
    empty = {
        "prefix_chars": 0,
        "tail_chars": 0,
        "cache_eligible": False,
        "cache_breakpoints": 0,
        "cache_ttl": "auto",
    }
    if not system or not isinstance(system, str) or not system.strip():
        return system if system else None, empty
    if SYSTEM_PROMPT_DYNAMIC_BOUNDARY not in system:
        prefix_chars = len(system)
        return system, {
            "prefix_chars": prefix_chars,
            "tail_chars": 0,
            "cache_eligible": prefix_chars >= SYSTEM_PROMPT_CACHE_THRESHOLD_CHARS,
            "cache_breakpoints": 1
            if prefix_chars >= SYSTEM_PROMPT_CACHE_THRESHOLD_CHARS
            else 0,
            "cache_ttl": "auto",
        }
    static_text, _, dynamic_text = system.partition(SYSTEM_PROMPT_DYNAMIC_BOUNDARY)
    static_text = static_text.strip()
    dynamic_text = dynamic_text.strip()
    eligible = len(static_text) >= SYSTEM_PROMPT_CACHE_THRESHOLD_CHARS
    joined = (
        f"{static_text}\n\n{dynamic_text}".strip() if dynamic_text else static_text
    )
    return joined, {
        "prefix_chars": len(static_text),
        "tail_chars": len(dynamic_text),
        "cache_eligible": eligible,
        "cache_breakpoints": 1 if eligible else 0,
        "cache_ttl": "auto",
    }


def _convert_tools_for_openai(tools: list[Any] | None) -> list[dict[str, Any]] | None:
    if not tools:
        return None
    converted = [_tool_schema(tool) for tool in tools]
    if not converted:
        return None
    # Deterministic order matters for OpenAI's prefix-match cache: any
    # reshuffle (MCP reconnect, plugin add/remove) breaks the prefix and
    # silently drops the hit rate. Mirror anthropic_adapter._convert_tools_for_anthropic.
    converted.sort(key=lambda t: t.get("name") or "")
    return converted


def _message_attr(message: Any, name: str, default: Any = None) -> Any:
    if isinstance(message, dict):
        return message.get(name, default)
    return getattr(message, name, default)


def _as_text(content: Any) -> str:
    if content is None:
        return ""
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts: list[str] = []
        for item in content:
            if isinstance(item, dict):
                if item.get("type") in {"text", "input_text", "output_text"}:
                    parts.append(str(item.get("text", "")))
                elif "content" in item:
                    parts.append(str(item.get("content", "")))
                else:
                    parts.append(json.dumps(item, ensure_ascii=False))
            else:
                parts.append(str(item))
        return "\n".join(part for part in parts if part)
    return str(content)


def _normalize_messages(
    prompt: Any,
    raw_messages: list[Any] | None,
) -> tuple[str | None, list[dict[str, Any]]]:
    instructions: list[str] = []
    items: list[dict[str, Any]] = []

    source: list[Any]
    if raw_messages and isinstance(raw_messages, list):
        source = raw_messages
    elif isinstance(prompt, list):
        source = prompt
    elif isinstance(prompt, str) and prompt:
        source = [{"role": "user", "content": prompt}]
    else:
        source = [{"role": "user", "content": "Continue."}]

    for message in source:
        role = _message_attr(message, "role", "user")
        content = _message_attr(message, "content", "")

        if role == "system":
            text = _as_text(content)
            if text:
                instructions.append(text)
            continue

        if role == "tool":
            call_id = _message_attr(message, "tool_call_id", "")
            if call_id:
                items.append({
                    "type": "function_call_output",
                    "call_id": call_id,
                    "output": _as_text(content) or "ok",
                })
            else:
                items.append({"role": "user", "content": _as_text(content) or "ok"})
            continue

        if role == "assistant":
            text = _as_text(content)
            if text:
                items.append({"role": "assistant", "content": text})
            tool_calls = _message_attr(message, "tool_calls", None) or []
            for call in tool_calls:
                fn = call.get("function", {}) if isinstance(call, dict) else {}
                items.append({
                    "type": "function_call",
                    "call_id": call.get("id", "") if isinstance(call, dict) else "",
                    "name": fn.get("name", ""),
                    "arguments": fn.get("arguments", "{}"),
                })
            continue

        text = _as_text(content)
        items.append({"role": "user" if role not in {"user", "assistant"} else role, "content": text or "Continue."})

    if not items:
        items.append({"role": "user", "content": "Continue."})
    return "\n\n".join(instructions) if instructions else None, items


def _extract_openai_response(
    response: dict[str, Any],
) -> tuple[str, list[dict[str, Any]], list[str]]:
    """Returns (content, tool_calls, thinking_blocks).

    Responses API emits `{type: "reasoning", summary: [{type:"summary_text",
    text:"..."}]}` items when `reasoning.summary` is set. We pull those out
    as thinking blocks so they land in session_events as agent.thinking
    rather than getting mixed into the assistant message.
    """
    content_parts: list[str] = []
    tool_calls: list[dict[str, Any]] = []
    thinking_blocks: list[str] = []
    for item in response.get("output") or []:
        item_type = item.get("type")
        if item_type == "message":
            for part in item.get("content") or []:
                if isinstance(part, dict) and part.get("type") == "output_text":
                    content_parts.append(str(part.get("text") or ""))
        elif item_type == "function_call":
            call_id = str(item.get("call_id") or item.get("id") or "")
            tool_calls.append({
                "id": call_id,
                "type": "function",
                "function": {
                    "name": str(item.get("name") or ""),
                    "arguments": str(item.get("arguments") or "{}"),
                },
            })
        elif item_type == "reasoning":
            for summary in item.get("summary") or []:
                if isinstance(summary, dict):
                    text = str(summary.get("text") or "")
                    if text.strip():
                        thinking_blocks.append(text)
    return "".join(content_parts), tool_calls, thinking_blocks


def _emit_thinking(thinking_blocks: list[str]) -> None:
    """Emit agent.thinking events from OpenAI reasoning summaries via the
    contextvar set by main.py:call_llm."""
    if not thinking_blocks:
        return
    try:
        from src.event_publisher import get_scoped_session, publish_session_event

        sid, iid = get_scoped_session()
        if not sid:
            return
        for text in thinking_blocks:
            publish_session_event(
                sid,
                "agent.thinking",
                {"content": [{"type": "text", "text": text}]},
                instance_id=iid,
            )
    except Exception as exc:  # noqa: BLE001
        logger.debug("[openai-responses] thinking emit failed: %s", exc)


def _auth_headers() -> tuple[dict[str, str], str]:
    api_key_headers = _api_key_auth_headers()
    if api_key_headers:
        return api_key_headers

    raise RuntimeError("No OpenAI authentication configured. Set OPENAI_API_KEY.")


def _api_key_auth_headers() -> tuple[dict[str, str], str] | None:
    api_key = os.environ.get("OPENAI_API_KEY")
    if not api_key:
        return None
    return {"Authorization": f"Bearer {api_key}"}, "openai-api-key"


def _make_openai_request(
    url: str,
    body: dict[str, Any],
    auth_headers: dict[str, str],
) -> urllib.request.Request:
    return urllib.request.Request(
        url,
        data=json.dumps(body).encode(),
        headers={
            **auth_headers,
            "Accept": "application/json",
            "Content-Type": "application/json",
        },
        method="POST",
    )


def _publish_llm_usage(
    *,
    model: str,
    usage: dict[str, Any] | None,
    ttft_ms: float | None,
    success: bool,
    duration_ms: float | None = None,
    error: str | None = None,
    prompt_cache_telemetry: dict[str, Any] | None = None,
) -> None:
    try:
        from src.event_publisher import (
            get_scoped_audit_fields,
            get_scoped_session,
            publish_session_event,
        )

        sid, iid = get_scoped_session()
        if not sid:
            return
        usage = usage or {}
        input_tokens = int(
            usage.get("input_tokens") or usage.get("prompt_tokens") or 0
        )
        output_tokens = int(
            usage.get("output_tokens") or usage.get("completion_tokens") or 0
        )
        cache_read = int(
            (usage.get("input_tokens_details") or {}).get("cached_tokens") or 0
        )
        payload: dict[str, Any] = {
            "model": model,
            **get_scoped_audit_fields(),
            "input_tokens": input_tokens,
            "output_tokens": output_tokens,
            "cache_read_input_tokens": cache_read,
            # OpenAI doesn't break out cache writes — the server pays for them
            # implicitly at the same per-token rate as normal input. Always 0
            # on OpenAI events so the dashboard's apples-to-apples comparison
            # vs Anthropic stays meaningful.
            "cache_creation_input_tokens": 0,
            "ttft_ms": ttft_ms,
            "recovery_attempts": 0,
            "success": success,
        }
        if duration_ms is not None:
            payload["duration_ms"] = duration_ms
        if prompt_cache_telemetry:
            payload["prompt_prefix_chars"] = prompt_cache_telemetry.get(
                "prefix_chars", 0
            )
            payload["prompt_tail_chars"] = prompt_cache_telemetry.get("tail_chars", 0)
            payload["prompt_cache_eligible"] = bool(
                prompt_cache_telemetry.get("cache_eligible", False)
            )
            payload["prompt_cache_breakpoints"] = int(
                prompt_cache_telemetry.get("cache_breakpoints", 0) or 0
            )
            payload["prompt_cache_ttl"] = prompt_cache_telemetry.get(
                "cache_ttl", "auto"
            )
        if error:
            payload["error"] = error[:200]
        publish_session_event(
            sid,
            "agent.llm_usage",
            payload,
            instance_id=iid,
        )
    except Exception as exc:  # noqa: BLE001
        logger.debug("[session-event] openai llm_usage emit failed: %s", exc)


def _call_openai_responses(
    component: str,
    messages: list[dict[str, Any]],
    instructions: str | None,
    tools: list[Any] | None = None,
    max_tokens: int | None = None,
    response_format: Any = None,
    cache_key: str | None = None,
) -> dict[str, Any]:
    model = _get_openai_model(component)
    # Strip the bundle's static/dynamic boundary sentinel before sending —
    # OpenAI doesn't recognize it and would treat it as literal text. The
    # measurement gives us the same prefix/tail telemetry the Anthropic
    # adapter emits so cross-provider dashboards line up.
    instructions, prompt_cache_telemetry = _measure_openai_prompt(instructions)
    # claude_code.llm_request span wraps the whole OpenAI Responses call.
    import time as _time

    llm_span = None
    llm_start = _time.monotonic()
    try:
        from src.telemetry import start_llm_request_span

        llm_span = start_llm_request_span(
            model,
            fast_mode=False,
            query_source="dapr_agent_py.openai_adapter",
            system_prompt=instructions,
            tools_json=json.dumps(_convert_tools_for_openai(tools))
            if tools
            else None,
            messages_for_api=list(messages),
        )
    except Exception as exc:  # noqa: BLE001
        logger.warning("[telemetry] llm_request (openai) start failed: %s", exc)
    headers, auth_mode = _auth_headers()
    request_headers = {
        **headers,
        "Accept": "application/json",
        "Content-Type": "application/json",
    }
    request_body: dict[str, Any] = {
        "model": model,
        "input": messages,
        "store": False,
    }
    if instructions:
        request_body["instructions"] = instructions
    # `prompt_cache_key` is OpenAI's routing hint that pins requests for the
    # same logical workload to the same cache shard. Without it, requests
    # from different pods can hash to different backends and each pays its
    # own cold-start. With it, the cluster behaves as one cache consumer.
    # Empty / None means defer to default routing — safer than sending an
    # unstable key.
    if cache_key:
        request_body["prompt_cache_key"] = cache_key
    converted_tools = _convert_tools_for_openai(tools)
    if converted_tools:
        request_body["tools"] = converted_tools
        request_body["parallel_tool_calls"] = True
    # Greppable per-turn line that mirrors the Anthropic adapter's. `mode=prefix`
    # and `cache_ttl=auto` distinguish the OpenAI side; production logs grep the
    # same way for both providers. `breakpoints` is 1 (implicit prefix-match)
    # when the static prefix crosses the threshold, plus 1 for the tool list
    # if any tools are present — same accounting as the Anthropic side.
    logger.info(
        "[instruction-bundle] mode=%s breakpoints=%d prefix_chars=%d tail_chars=%d cache_ttl=%s provider=openai",
        "prefix" if prompt_cache_telemetry["cache_eligible"] else "legacy",
        prompt_cache_telemetry["cache_breakpoints"]
        + (1 if converted_tools else 0),
        prompt_cache_telemetry["prefix_chars"],
        prompt_cache_telemetry["tail_chars"],
        prompt_cache_telemetry["cache_ttl"],
    )
    if llm_span is not None:
        try:
            llm_span.set_attribute(
                "prompt.prefix_chars", prompt_cache_telemetry["prefix_chars"]
            )
            llm_span.set_attribute(
                "prompt.tail_chars", prompt_cache_telemetry["tail_chars"]
            )
            llm_span.set_attribute(
                "prompt.cache_eligible", prompt_cache_telemetry["cache_eligible"]
            )
            llm_span.set_attribute(
                "prompt.cache_breakpoints",
                prompt_cache_telemetry["cache_breakpoints"]
                + (1 if converted_tools else 0),
            )
            llm_span.set_attribute(
                "prompt.cache_ttl", prompt_cache_telemetry["cache_ttl"]
            )
            if cache_key:
                llm_span.set_attribute("prompt.cache_key", cache_key)
            if converted_tools:
                import hashlib as _hashlib

                tools_hash = _hashlib.sha1(
                    ",".join(t.get("name") or "" for t in converted_tools).encode(
                        "utf-8"
                    )
                ).hexdigest()
                llm_span.set_attribute("prompt.tools_hash", tools_hash)
                llm_span.set_attribute("prompt.tools_count", len(converted_tools))
        except Exception as exc:  # noqa: BLE001
            logger.debug("[telemetry] openai prompt-cache attrs set failed: %s", exc)
    if max_tokens:
        request_body["max_output_tokens"] = max_tokens
    if model.startswith("gpt-5") or model.startswith("o"):
        effort = os.environ.get("OPENAI_REASONING_EFFORT", "medium")
        # summary="detailed" tells the Responses API to echo back reasoning
        # summaries in the output; without it we'd get reasoning tokens
        # charged but no visible content for agent.thinking.
        summary = os.environ.get("OPENAI_REASONING_SUMMARY", "detailed")
        request_body["reasoning"] = {"effort": effort, "summary": summary}
    if response_format is not None:
        try:
            schema = strict_json_schema(response_format.model_json_schema())
            request_body["text"] = {
                "format": {
                    "type": "json_schema",
                    "name": response_format.__name__,
                    "schema": schema,
                    "strict": True,
                }
            }
        except Exception:
            request_body["text"] = {"format": {"type": "json_object"}}

    url = os.environ.get("OPENAI_RESPONSES_URL", "https://api.openai.com/v1/responses")
    timeout = int(os.environ.get("OPENAI_RESPONSES_TIMEOUT_SECONDS", "180"))
    req = _make_openai_request(url, request_body, request_headers)
    logger.info(
        "[openai-responses] Calling %s with %d messages, %d tools, auth=%s",
        model,
        len(messages),
        len(converted_tools or []),
        auth_mode,
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            data = json.loads(resp.read() or b"{}")
    except HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")
        _publish_llm_usage(
            model=model,
            usage=None,
            ttft_ms=(_time.monotonic() - llm_start) * 1000.0,
            duration_ms=(_time.monotonic() - llm_start) * 1000.0,
            success=False,
            error=detail,
            prompt_cache_telemetry=prompt_cache_telemetry,
        )
        raise RuntimeError(f"OpenAI Responses API failed ({exc.code}): {detail}") from exc

    content, tool_calls, thinking_blocks = _extract_openai_response(data)
    _emit_thinking(thinking_blocks)
    result: dict[str, Any] = {
        "role": "assistant",
        "content": content or None,
        "metadata": {
            "provider": "openai-responses",
            "model": model,
            "auth_mode": auth_mode,
            "response_id": data.get("id"),
            "status": data.get("status"),
        },
    }
    if tool_calls:
        result["tool_calls"] = tool_calls
        result["content"] = content or ""

    # End claude_code.llm_request span + record token metrics.
    if llm_span is not None:
        try:
            from src.telemetry import end_llm_request_span, record_tokens

            usage = data.get("usage") or {}
            input_tokens = int(
                usage.get("input_tokens") or usage.get("prompt_tokens") or 0
            )
            output_tokens = int(
                usage.get("output_tokens") or usage.get("completion_tokens") or 0
            )
            cache_read = int(
                (usage.get("input_tokens_details") or {}).get("cached_tokens") or 0
            )
            duration_ms = (_time.monotonic() - llm_start) * 1000.0
            end_llm_request_span(
                llm_span,
                input_tokens=input_tokens or None,
                output_tokens=output_tokens or None,
                cache_read_tokens=cache_read or None,
                success=True,
                has_tool_call=bool(tool_calls),
                ttft_ms=duration_ms,
                model_output=content or None,
            )
            record_tokens(type_="input", count=input_tokens, model=model)
            record_tokens(type_="output", count=output_tokens, model=model)
            if cache_read:
                record_tokens(type_="cacheRead", count=cache_read, model=model)
        except Exception as exc:  # noqa: BLE001
            logger.warning("[telemetry] llm_request (openai) end failed: %s", exc)
    _publish_llm_usage(
        model=model,
        usage=data.get("usage") or {},
        ttft_ms=(_time.monotonic() - llm_start) * 1000.0,
        duration_ms=(_time.monotonic() - llm_start) * 1000.0,
        success=True,
        prompt_cache_telemetry=prompt_cache_telemetry,
    )

    # Surface usage on the result.metadata + stamp GenAI semconv attrs on the
    # active Dapr activity span.
    duration_ms = (_time.monotonic() - llm_start) * 1000.0
    raw_usage = data.get("usage") or {}
    result["metadata"]["usage"] = raw_usage
    result["metadata"]["duration_ms"] = duration_ms
    try:
        from src.telemetry.genai_attrs import (
            set_genai_request_attrs,
            set_genai_response_attrs,
        )

        set_genai_request_attrs(
            system="openai",
            request_model=model,
            max_tokens=max_tokens,
            tools_count=len(tools) if tools else None,
            response_format=(
                response_format.__name__
                if response_format is not None and hasattr(response_format, "__name__")
                else None
            ),
            streaming=False,
        )
        set_genai_response_attrs(
            response_model=data.get("model") or model,
            response_id=data.get("id"),
            finish_reason=data.get("status"),
            usage=raw_usage,
            duration_ms=duration_ms,
            tool_calls_count=len(tool_calls) if tool_calls else None,
            output_chars=len(content) if isinstance(content, str) else None,
        )
    except Exception as _attr_exc:  # noqa: BLE001
        logger.debug("[genai-attrs] openai span enrichment failed: %s", _attr_exc)

    return result


def patch_for_openai(llm_client: Any) -> None:
    """Patch DaprChatClient to use OpenAI Responses directly for OpenAI models."""

    from dapr_agents.llm.dapr.chat import DaprChatClient

    if getattr(DaprChatClient, "_openai_patched", False):
        return

    original_generate = DaprChatClient.generate

    def patched_generate(self: Any, *args: Any, **kwargs: Any) -> Any:
        component = getattr(self, "_llm_component", None)
        if component and _is_openai_component(component):
            prompt = args[0] if args else kwargs.get("prompt", "")
            raw_messages = kwargs.get("messages")
            tools = kwargs.get("tools")
            max_tokens = kwargs.get("max_tokens")
            response_format = kwargs.get("response_format")

            instructions, messages = _normalize_messages(prompt, raw_messages)
            # `_cache_key` is stashed by main.py's _apply_instruction_prompt_state
            # at activity entry, derived from the bundle's agent identity. None
            # for ephemeral inline workflow agents — falls back to OpenAI's
            # default routing.
            cache_key = getattr(self, "_cache_key", None)
            result = _call_openai_responses(
                component,
                messages,
                instructions,
                tools=tools,
                max_tokens=max_tokens,
                response_format=response_format,
                cache_key=cache_key,
            )

            if response_format is not None:
                return parse_structured_response(
                    response_format,
                    result.get("content", "") or "",
                )

            return build_llm_chat_response(
                content=result.get("content", "") or "",
                tool_calls=result.get("tool_calls") or None,
                metadata=result.get("metadata") or {},
            )

        return original_generate(self, *args, **kwargs)

    DaprChatClient.generate = patched_generate
    DaprChatClient._openai_patched = True
    logger.info("[openai-responses] Patched DaprChatClient class for OpenAI direct calls")

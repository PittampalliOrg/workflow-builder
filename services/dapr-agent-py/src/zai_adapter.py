"""Direct Z.AI GLM chat-completions adapter for DaprChatClient.

Z.AI GLM V4 exposes an OpenAI-compatible chat completions API at
https://api.zai.com. Keep direct Z.AI GLM models on the same durable-agent
contract as Together, Foundry, and NVIDIA: normal calls return LLMChatResponse
and structured calls return the requested Pydantic model.
"""

from __future__ import annotations

import json
import logging
import os
import time
from typing import Any
from urllib.error import HTTPError
import urllib.request

from src.provider_conformance import (
    build_llm_chat_response,
    ensure_chat_completions_history,
    parse_structured_response,
)

logger = logging.getLogger(__name__)

COMPONENT_MODEL_MAP: dict[str, str] = {
    "llm-glm-5.2": "glm-5.2",
    "llm-zai-glm-5.2": "glm-5.2",
    # Faster GLM-5 family variants (non-vision → coding-plan endpoint, same quota
    # as glm-5.2). glm-5-turbo ~1.6x and glm-5.1 ~3x faster than glm-5.2.
    "llm-glm-5-turbo": "glm-5-turbo",
    "llm-zai-glm-5-turbo": "glm-5-turbo",
    "llm-glm-5.1": "glm-5.1",
    "llm-zai-glm-5.1": "glm-5.1",
    "llm-glm-5v-turbo": "glm-5v-turbo",
    "llm-zai-glm-5v-turbo": "glm-5v-turbo",
}

# GLM-V context windows are far smaller than Anthropic's, and each Playwright
# screenshot is ~100-500KB base64. Keep only the last N image parts in context
# (parity with anthropic_adapter's DAPR_AGENT_PY_MAX_IMAGE_TOOL_RESULTS).
MAX_IMAGE_TOOL_RESULTS_IN_CONTEXT = int(
    os.environ.get("DAPR_AGENT_PY_MAX_IMAGE_TOOL_RESULTS", "3")
)


def _is_zai_component(component: str) -> bool:
    text = str(component or "")
    return text in COMPONENT_MODEL_MAP or text.startswith("llm-glm-5") or text.startswith("llm-zai-")


def _get_zai_model(component: str) -> str:
    return COMPONENT_MODEL_MAP.get(
        component,
        os.environ.get("ZAI_DEFAULT_MODEL", "glm-5.2"),
    )


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


def _is_zai_paas_component(component: str | None) -> bool:
    """True if a component should route to the pay-as-you-go /paas/v4 endpoint
    (drawn from account balance) rather than the GLM Coding-Plan /coding/paas/v4
    endpoint. The VLM (glm-5v-turbo) is PAAS-only."""
    model = _get_zai_model(component or "")
    extra = {
        c.strip()
        for c in os.environ.get("ZAI_PAAS_COMPONENTS", "").split(",")
        if c.strip()
    }
    return model.startswith("glm-5v") or "vlm" in model or str(component) in extra


def _zai_base_url(component: str | None) -> str:
    """Per-model base URL. An explicit ZAI_BASE_URL overrides everything
    (back-compat). Otherwise PAAS/VLM components use ZAI_PAAS_BASE_URL
    (.../paas/v4) and coding-plan components use ZAI_CODING_BASE_URL
    (.../coding/paas/v4)."""
    explicit = os.environ.get("ZAI_BASE_URL")
    if explicit:
        return explicit
    if _is_zai_paas_component(component):
        return os.environ.get("ZAI_PAAS_BASE_URL", "https://api.z.ai/api/paas/v4")
    return os.environ.get(
        "ZAI_CODING_BASE_URL", "https://api.z.ai/api/coding/paas/v4"
    )


def _data_url_from_image_block(b: dict[str, Any]) -> str | None:
    """Extract a data: (or http) image URL from a content image block, handling
    Anthropic-native ({source:{media_type,data}}), MCP/generic ({data,mimeType})
    and OpenAI ({image_url:{url}}) shapes."""
    src = b.get("source")
    if isinstance(src, dict):
        if src.get("url"):
            return str(src["url"])
        data = src.get("data")
        if data:
            mt = src.get("media_type") or src.get("mediaType") or "image/png"
            return f"data:{mt};base64,{data}"
    data = b.get("data")
    if data:
        mt = b.get("mimeType") or b.get("mediaType") or b.get("media_type") or "image/png"
        return f"data:{mt};base64,{data}"
    iu = b.get("image_url")
    if isinstance(iu, dict) and iu.get("url"):
        return str(iu["url"])
    if isinstance(iu, str) and iu:
        return iu
    return None


def _to_zai_content_parts(content: Any) -> tuple[list[dict[str, Any]], bool]:
    """Map a message content value to OpenAI-style content parts (text +
    image_url). Returns (parts, has_image). Plain strings yield a single text
    part; non-image lists collapse to text parts."""
    if not isinstance(content, list):
        text = _as_text(content)
        return ([{"type": "text", "text": text}] if text else [], False)
    parts: list[dict[str, Any]] = []
    has_image = False
    for item in content:
        if isinstance(item, dict):
            t = item.get("type")
            if t in {"image", "image_url"} or item.get("source") or item.get("mimeType"):
                url = _data_url_from_image_block(item)
                if url:
                    parts.append({"type": "image_url", "image_url": {"url": url}})
                    has_image = True
                    continue
            if t in {"text", "input_text", "output_text"}:
                txt = str(item.get("text", ""))
                if txt:
                    parts.append({"type": "text", "text": txt})
                continue
            txt = _as_text(item)
            if txt:
                parts.append({"type": "text", "text": txt})
        else:
            txt = str(item)
            if txt:
                parts.append({"type": "text", "text": txt})
    return parts, has_image


def _cap_zai_image_parts(
    image_parts: list[dict[str, Any]], keep_last: int
) -> list[dict[str, Any]]:
    if keep_last <= 0:
        return []
    return image_parts[-keep_last:]


def _normalize_tool_call(call: Any) -> dict[str, Any] | None:
    if not isinstance(call, dict):
        return None
    raw_function = call.get("function")
    function = raw_function if isinstance(raw_function, dict) else {}
    name = str(function.get("name") or call.get("name") or "").strip()
    if not name:
        return None
    raw_args = function.get("arguments", call.get("arguments", "{}"))
    arguments = raw_args if isinstance(raw_args, str) else json.dumps(raw_args or {})
    call_id = str(call.get("id") or call.get("call_id") or "").strip()
    return {
        "id": call_id,
        "type": "function",
        "function": {
            "name": name,
            "arguments": arguments or "{}",
        },
    }


def _normalize_messages_for_zai(
    prompt: Any,
    raw_messages: list[Any] | None,
) -> list[dict[str, Any]]:
    if raw_messages and isinstance(raw_messages, list):
        source = raw_messages
    elif isinstance(prompt, list):
        source = prompt
    elif isinstance(prompt, str) and prompt:
        source = [{"role": "user", "content": prompt}]
    else:
        source = [{"role": "user", "content": "Continue."}]

    messages: list[dict[str, Any]] = []
    # Images from tool results cannot ride on OpenAI-style `tool` messages, and
    # injecting a `user` image message inline breaks role-order when a turn made
    # multiple tool calls. Collect tool-result images here and append them as ONE
    # trailing user message (role-order-safe; latest screenshot last — exactly
    # where a visual critic judges it).
    pending_images: list[dict[str, Any]] = []
    for message in source:
        role = str(_message_attr(message, "role", "user") or "user")
        raw_content = _message_attr(message, "content", "")
        text = _as_text(raw_content)

        if role == "system":
            if text:
                messages.append({"role": "system", "content": text})
            continue

        if role == "assistant":
            item: dict[str, Any] = {"role": "assistant", "content": text or None}
            tool_calls = _message_attr(message, "tool_calls", None) or []
            normalized = [
                call
                for call in (_normalize_tool_call(call) for call in tool_calls)
                if call is not None
            ]
            if normalized:
                item["tool_calls"] = normalized
            if item["content"] is None and not normalized:
                item["content"] = ""
            messages.append(item)
            continue

        if role == "tool":
            parts, has_image = _to_zai_content_parts(raw_content)
            if has_image:
                pending_images.extend(
                    p for p in parts if p.get("type") == "image_url"
                )
                text_blob = "\n".join(
                    p["text"] for p in parts if p.get("type") == "text"
                ) or "[screenshot returned; image attached below]"
            else:
                text_blob = text or "ok"
            call_id = str(_message_attr(message, "tool_call_id", "") or "").strip()
            if call_id:
                messages.append({
                    "role": "tool",
                    "tool_call_id": call_id,
                    "content": text_blob,
                })
            else:
                messages.append({"role": "user", "content": text_blob})
            continue

        # user / other roles: preserve inline images as content parts.
        parts, has_image = _to_zai_content_parts(raw_content)
        if has_image:
            messages.append({
                "role": "user" if role not in {"user", "assistant"} else role,
                "content": parts or [{"type": "text", "text": "Continue."}],
            })
        else:
            messages.append({
                "role": "user" if role not in {"user", "assistant"} else role,
                "content": text or "Continue.",
            })

    if pending_images:
        capped = _cap_zai_image_parts(
            pending_images, MAX_IMAGE_TOOL_RESULTS_IN_CONTEXT
        )
        if capped:
            messages.append({
                "role": "user",
                "content": [
                    {
                        "type": "text",
                        "text": "Screenshot(s) returned by the browser tool (most recent last):",
                    },
                    *capped,
                ],
            })

    if not messages:
        messages.append({"role": "user", "content": "Continue."})
    return ensure_chat_completions_history(messages, provider="zai")


def _tool_parameters(tool: Any) -> dict[str, Any]:
    if isinstance(tool, dict):
        params = tool.get("parameters")
        if isinstance(params, dict):
            return params
        fn = tool.get("function")
        if isinstance(fn, dict) and isinstance(fn.get("parameters"), dict):
            return fn["parameters"]
    args_model = getattr(tool, "args_model", None)
    if args_model:
        try:
            schema = args_model.model_json_schema()
            if isinstance(schema, dict):
                return schema
        except Exception:
            pass
    return {"type": "object", "properties": {}}


def _tool_name(tool: Any) -> str:
    if isinstance(tool, dict):
        fn = tool.get("function")
        if isinstance(fn, dict) and fn.get("name"):
            return str(fn["name"])
        return str(tool.get("name") or "")
    return str(getattr(tool, "name", "") or "")


def _tool_description(tool: Any, name: str) -> str:
    if isinstance(tool, dict):
        fn = tool.get("function")
        if isinstance(fn, dict) and fn.get("description"):
            return str(fn["description"])
        if tool.get("description"):
            return str(tool["description"])
    return str(getattr(tool, "description", "") or name)


def _convert_tools_for_zai_chat(
    tools: list[Any] | None,
) -> list[dict[str, Any]] | None:
    if not tools:
        return None
    converted: list[dict[str, Any]] = []
    for tool in tools:
        name = _tool_name(tool)
        if not name:
            continue
        converted.append({
            "type": "function",
            "function": {
                "name": name,
                "description": _tool_description(tool, name),
                "parameters": _tool_parameters(tool),
            },
        })
    if not converted:
        return None
    converted.sort(key=lambda item: item["function"].get("name") or "")
    return converted


def _with_structured_output_tool(
    converted_tools: list[dict[str, Any]] | None,
    schema: dict[str, Any],
) -> list[dict[str, Any]]:
    """Append the synthetic StructuredOutput tool whose parameters ARE the
    call's JSON Schema (per-request definition — the tool is never registered
    on the executor; src/main.py's run_tool intercepts it by name). Replaces a
    same-named entry defensively and keeps the deterministic name sort."""
    from src.structured_output import (
        STRUCTURED_OUTPUT_TOOL_NAME,
        structured_output_tool_definition,
    )

    tools = [
        tool
        for tool in (converted_tools or [])
        if (tool.get("function") or {}).get("name") != STRUCTURED_OUTPUT_TOOL_NAME
    ]
    tools.append(structured_output_tool_definition(schema))
    tools.sort(key=lambda item: item["function"].get("name") or "")
    return tools


def _extract_zai_response(
    response: dict[str, Any],
) -> tuple[str, list[dict[str, Any]], str | None, str]:
    choices = response.get("choices") or []
    if not choices or not isinstance(choices[0], dict):
        return "", [], None, ""
    choice = choices[0]
    message = choice.get("message") if isinstance(choice.get("message"), dict) else {}
    content = _as_text(message.get("content"))
    reasoning_content = _as_text(
        message.get("reasoning_content")
        or message.get("reasoning")
        or message.get("thinking")
    )
    tool_calls = [
        call
        for call in (
            _normalize_tool_call(call) for call in (message.get("tool_calls") or [])
        )
        if call is not None
    ]
    finish_reason = choice.get("finish_reason")
    return content, tool_calls, str(finish_reason) if finish_reason else None, reasoning_content


def _auth_headers(component: str | None = None) -> tuple[dict[str, str], str]:
    # PAAS/VLM components may use a separate pay-as-you-go key (ZAI_PAAS_API_KEY);
    # default to the account-level ZAI_API_KEY for both endpoints.
    use_paas = component is not None and _is_zai_paas_component(component)
    paas_key = os.environ.get("ZAI_PAAS_API_KEY") if use_paas else None
    api_key = paas_key or os.environ.get("ZAI_API_KEY")
    if not api_key:
        raise RuntimeError("No Z.AI GLM authentication configured. Set ZAI_API_KEY.")
    return {"Authorization": f"Bearer {api_key}"}, (
        "zai-paas-key" if paas_key else "zai-api-key"
    )


def _user_agent() -> str:
    configured = os.environ.get("ZAI_USER_AGENT", "").strip()
    if configured:
        return configured
    return "workflow-builder-dapr-agent-py/1.0"


def _make_zai_request(
    url: str,
    body: dict[str, Any],
    auth_headers: dict[str, str],
) -> urllib.request.Request:
    return urllib.request.Request(
        url,
        data=json.dumps(body).encode("utf-8"),
        headers={
            **auth_headers,
            "Accept": "application/json",
            "Content-Type": "application/json",
            "User-Agent": _user_agent(),
        },
        method="POST",
    )


def _header(exc: HTTPError, *names: str) -> str | None:
    headers = exc.headers
    if not headers:
        return None
    for name in names:
        value = headers.get(name)
        if value:
            return str(value)
    return None


def _retry_after_seconds(exc: HTTPError) -> float:
    retry_after = _header(exc, "Retry-After", "retry-after")
    if retry_after:
        try:
            return max(0.0, float(retry_after))
        except ValueError:
            pass

    retry_after_ms = _header(
        exc,
        "Retry-After-Ms",
        "retry-after-ms",
        "X-RateLimit-Reset-Ms",
        "x-ratelimit-reset-ms",
    )
    if retry_after_ms:
        try:
            return max(0.0, float(retry_after_ms) / 1000.0)
        except ValueError:
            pass

    reset = _header(exc, "X-RateLimit-Reset", "x-ratelimit-reset")
    if reset:
        try:
            parsed = float(reset)
            now = time.time()
            return max(0.0, parsed - now) if parsed > now else max(0.0, parsed)
        except ValueError:
            pass

    return max(
        0.0,
        float(os.environ.get("ZAI_RATE_LIMIT_BACKOFF_SECONDS", "65")),
    )


def _rate_limit_max_retries() -> int:
    return max(0, int(os.environ.get("ZAI_RATE_LIMIT_MAX_RETRIES", "3")))


def _publish_llm_usage(
    *,
    model: str,
    usage: dict[str, Any] | None,
    ttft_ms: float | None,
    duration_ms: float | None,
    success: bool,
    error: str | None = None,
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
        # z.ai GLM is OpenAI-compatible: it reports prompt-cache hits under the
        # OpenAI-standard prompt_tokens_details.cached_tokens (NOT deepseek's
        # prompt_cache_hit_tokens). Read the OpenAI fields first, fall back to
        # deepseek's for safety. input_tokens MUST be NET of cache reads (the
        # dapr-agent-py invariant — gross over-burns goal budgets ~20x).
        prompt_tokens = int(
            usage.get("prompt_tokens") or usage.get("input_tokens") or 0
        )
        prompt_cache_hit = int(
            (usage.get("prompt_tokens_details") or {}).get("cached_tokens")
            or (usage.get("input_tokens_details") or {}).get("cached_tokens")
            or usage.get("prompt_cache_hit_tokens")
            or 0
        )
        prompt_cache_miss = int(usage.get("prompt_cache_miss_tokens") or 0)
        input_tokens = (
            prompt_cache_miss
            if prompt_cache_miss
            else max(0, prompt_tokens - prompt_cache_hit)
        )
        payload: dict[str, Any] = {
            "model": model,
            **get_scoped_audit_fields(),
            "input_tokens": input_tokens,
            "output_tokens": int(
                usage.get("completion_tokens") or usage.get("output_tokens") or 0
            ),
            "cache_read_input_tokens": prompt_cache_hit,
            "cache_creation_input_tokens": 0,
            "ttft_ms": ttft_ms,
            "duration_ms": duration_ms,
            "recovery_attempts": 0,
            "success": success,
        }
        if error:
            payload["error"] = error[:200]
        publish_session_event(sid, "agent.llm_usage", payload, instance_id=iid)
    except Exception as exc:  # noqa: BLE001
        logger.debug("[session-event] zai llm_usage emit failed: %s", exc)


def _reasoning_effort(override: str | None = None) -> str:
    """Resolve the GLM reasoning_effort value.

    ``override`` is the per-agent ``agentConfig.reasoningEffort`` (e.g. from a
    dynamic-script ``agent(..., {effort})`` opt) and WINS over the env default.
    GLM's endpoint accepts high|max here, so the Claude Code vocabulary
    collapses: {xhigh,max} -> max, {low,medium,high} -> high.
    """
    effort = (override or os.environ.get("ZAI_REASONING_EFFORT", "max")).strip().lower()
    if effort in {"xhigh", "max"}:
        return "max"
    if effort in {"low", "medium", "high"}:
        return "high"
    return "max"


def _apply_zai_output_mode(
    request_body: dict[str, Any],
    *,
    structured: bool,
    tool_chat: bool = False,
    reasoning_effort: str | None = None,
    native_json_schema: dict[str, Any] | None = None,
) -> None:
    if structured:
        request_body["thinking"] = {"type": "disabled"}
        request_body["response_format"] = {"type": "json_object"}
        return
    if tool_chat:
        request_body["thinking"] = {"type": "disabled"}
        return
    request_body["thinking"] = {"type": "enabled"}
    request_body["reasoning_effort"] = _reasoning_effort(reasoning_effort)
    # Tier-2 structured output for dynamic-script agent(..., {schema}) routed to
    # GLM: GLM's "structured output" is only json_object (valid JSON, NOT
    # schema-shape enforced — GLM has no strict json_schema mode). Force valid
    # JSON while KEEPING thinking on (distinct from the thinking-off `structured`
    # path above), so verify/critic reasoning is preserved. The prompt
    # <output-contract> conveys the shape and the journal validates it.
    if native_json_schema is not None:
        request_body["response_format"] = {"type": "json_object"}


def _messages_contain_json_instruction(messages: list[dict[str, Any]]) -> bool:
    for message in messages:
        if "json" in _as_text(message.get("content")).lower():
            return True
    return False


def _ensure_json_instruction(messages: list[dict[str, Any]]) -> list[dict[str, Any]]:
    if _messages_contain_json_instruction(messages):
        return messages

    instructed = list(messages)
    instruction = "Return a valid JSON object only."
    if instructed and instructed[0].get("role") == "system":
        first = dict(instructed[0])
        content = _as_text(first.get("content")).strip()
        first["content"] = f"{content}\n\n{instruction}" if content else instruction
        instructed[0] = first
    else:
        instructed.insert(0, {"role": "system", "content": instruction})
    return instructed


def _call_zai_chat(
    component: str,
    messages: list[dict[str, Any]],
    tools: list[Any] | None = None,
    max_tokens: int | None = None,
    response_format: Any = None,
    tool_choice: Any = None,
    reasoning_effort: str | None = None,
    native_json_schema: dict[str, Any] | None = None,
    structured_output_tool: bool = False,
) -> dict[str, Any]:
    model = _get_zai_model(component)
    converted_tools = _convert_tools_for_zai_chat(tools)
    # Structured-output TOOL mode (agentConfig.structuredOutputMode == "tool"):
    # deliver the schema as a first-class tool definition instead of
    # response_format json_object — GLM's tool_choice honors only "auto", so
    # enforcement is availability + prompt + the agent-loop guard (exactly the
    # Claude Code design). json_object stays the fallback mode below.
    if structured_output_tool and isinstance(native_json_schema, dict):
        converted_tools = _with_structured_output_tool(
            converted_tools, native_json_schema
        )

    llm_span = None
    llm_start = time.monotonic()
    try:
        from src.telemetry import start_llm_request_span

        llm_span = start_llm_request_span(
            model,
            fast_mode=False,
            query_source="dapr_agent_py.zai_adapter",
            system_prompt="\n\n".join(
                str(item.get("content") or "")
                for item in messages
                if item.get("role") == "system"
            )
            or None,
            tools_json=json.dumps(converted_tools) if converted_tools else None,
            messages_for_api=list(messages),
        )
    except Exception as exc:  # noqa: BLE001
        logger.warning("[telemetry] llm_request (zai) start failed: %s", exc)

    headers, auth_mode = _auth_headers(component)
    # Per-model endpoint: GLM Coding-Plan models (glm-5.2) use the /coding/paas/v4
    # path (funded by the GLM Coding subscription quota); the VLM (glm-5v-turbo) is
    # PAAS-only and uses /paas/v4 (drawn from account balance — a Coding-Plan key
    # on /paas/v4 returns error 1113 "Insufficient balance"). An explicit
    # ZAI_BASE_URL overrides both (back-compat). See _zai_base_url.
    base_url = _zai_base_url(component)
    url = os.environ.get(
        "ZAI_CHAT_COMPLETIONS_URL",
        f"{base_url.rstrip('/')}/chat/completions",
    )
    timeout = int(os.environ.get("ZAI_TIMEOUT_SECONDS", "300"))
    # GLM V4/V5 are REASONING models — they spend completion tokens on an internal
    # reasoning pass BEFORE emitting content/tool_calls. A 4096 cap is too small:
    # the reasoning eats the whole budget and the response comes back with EMPTY
    # content + no tool_calls, which trips the empty-response circuit breaker. Match
    # the DeepSeek fix (DEEPSEEK_MAX_TOKENS 4096->32000) so the reasoning pass plus
    # the actual answer both fit. Still escalates further on truncation below.
    output_cap = max_tokens or int(os.environ.get("ZAI_MAX_TOKENS", "32000"))
    request_body: dict[str, Any] = {
        "model": model,
        "messages": (
            _ensure_json_instruction(messages)
            if response_format is not None
            else messages
        ),
        "max_tokens": output_cap,
        "stream": False,
    }
    if converted_tools:
        request_body["tools"] = converted_tools
        if tool_choice in (None, "", "auto"):
            request_body["tool_choice"] = "auto"
        elif isinstance(tool_choice, dict):
            request_body["tool_choice"] = tool_choice
        elif tool_choice in {"none", "required"}:
            request_body["tool_choice"] = tool_choice
        else:
            logger.warning(
                "[zai-chat] ignoring unsupported forced tool_choice=%r",
                tool_choice,
            )
            request_body["tool_choice"] = "auto"
    _apply_zai_output_mode(
        request_body,
        structured=response_format is not None,
        tool_chat="tools" in request_body,
        reasoning_effort=reasoning_effort,
        # Only honored when the Pydantic response_format (memory path) is absent,
        # so the thinking-off `structured` path and this thinking-on native path
        # never collide. Tool mode delivers the schema via the StructuredOutput
        # tool definition instead — never combine it with json_object (the
        # intermediate turns are tool calls, not JSON text).
        native_json_schema=(
            native_json_schema
            if response_format is None and not structured_output_tool
            else None
        ),
    )

    image_msgs = sum(
        1
        for m in messages
        if isinstance(m.get("content"), list)
        and any(
            isinstance(p, dict) and p.get("type") == "image_url"
            for p in m["content"]
        )
    )
    logger.info(
        "[zai-chat] Calling %s with %d messages (%d w/ images), %d tools, auth=%s, base=%s",
        model,
        len(messages),
        image_msgs,
        len(converted_tools or []),
        auth_mode,
        base_url,
    )
    data: dict[str, Any]
    rate_limit_retries = _rate_limit_max_retries()
    # Empty-content retry: Z.AI GLM's own JSON-mode docs say
    # "the API may occasionally return empty content" for `response_format:
    # json_object` and recommend "handle the occasional empty content
    # response on the client side"
    # (https://api-docs.zai.com/guides/json_mode). Retry the request
    # before propagating the failure — typical end-to-end recovery is 1
    # retry. Configurable via ZAI_EMPTY_CONTENT_RETRIES (default 3).
    empty_content_retries = int(
        os.environ.get("ZAI_EMPTY_CONTENT_RETRIES", "3")
    )
    # Reasoning-model length escalation: Z.AI GLM V4 spends completion tokens on
    # the internal reasoning pass BEFORE emitting content. If max_tokens is too
    # low it returns finish_reason=length with EMPTY content (the reasoning ate
    # the whole budget). Rather than surface an empty response to the circuit
    # breaker, escalate max_tokens and retry (parity with anthropic_adapter's
    # length handling). Configurable via ZAI_LENGTH_ESCALATIONS /
    # ZAI_MAX_TOKENS_CEILING.
    max_length_escalations = int(
        os.environ.get("ZAI_LENGTH_ESCALATIONS", "2")
    )
    length_ceiling = int(os.environ.get("ZAI_MAX_TOKENS_CEILING", "65536"))
    rate_attempt = 0
    empty_attempt = 0
    length_escalations = 0
    content: str = ""
    tool_calls: list[dict[str, Any]] = []
    finish_reason: str | None = None
    reasoning_content: str = ""
    try:
        while True:
            req = _make_zai_request(url, request_body, headers)
            try:
                with urllib.request.urlopen(req, timeout=timeout) as resp:
                    data = json.loads(resp.read() or b"{}")
            except HTTPError as exc:
                detail = exc.read().decode("utf-8", errors="replace")
                if exc.code == 429 and rate_attempt < rate_limit_retries:
                    delay = _retry_after_seconds(exc)
                    rate_attempt += 1
                    logger.warning(
                        "[zai-chat] 429 rate limit from %s; retrying in %.1fs "
                        "(attempt %d/%d): %s",
                        model,
                        delay,
                        rate_attempt,
                        rate_limit_retries,
                        detail[:300],
                    )
                    time.sleep(delay)
                    continue
                raise RuntimeError(
                    f"Z.AI GLM Chat API failed ({exc.code}): {detail}"
                ) from exc

            content, tool_calls, finish_reason, reasoning_content = (
                _extract_zai_response(data)
            )
            # Reasoning consumed the whole output budget → empty content with the
            # response truncated. Escalate max_tokens and retry so the answer isn't
            # lost (and the empty-response circuit breaker isn't tripped by a
            # recoverable truncation). GLM does not always label this
            # finish_reason="length" — observed truncated empty responses come back
            # finish_reason="stop" with completion_tokens pinned at the cap — so
            # detect truncation by completion_tokens reaching the cap too, not just
            # the finish_reason label.
            current_cap = int(request_body.get("max_tokens") or output_cap)
            usage_now = data.get("usage") if isinstance(data.get("usage"), dict) else {}
            completion_now = int(usage_now.get("completion_tokens") or 0)
            truncated_empty = finish_reason == "length" or (
                current_cap > 0 and completion_now >= current_cap
            )
            if (
                truncated_empty
                and not content.strip()
                and not tool_calls
                and length_escalations < max_length_escalations
                and current_cap < length_ceiling
            ):
                length_escalations += 1
                new_cap = min(current_cap * 2, length_ceiling)
                logger.warning(
                    "[zai-chat] truncated empty content (finish_reason=%s, "
                    "completion_tokens=%d) on %s; escalating max_tokens %d->%d "
                    "(attempt %d/%d)%s",
                    finish_reason,
                    completion_now,
                    model,
                    current_cap,
                    new_cap,
                    length_escalations,
                    max_length_escalations,
                    " (reasoning_content present)" if reasoning_content else "",
                )
                request_body["max_tokens"] = new_cap
                continue
            # Retry on empty-content responses when the caller asked for
            # structured output. Z.AI GLM's API treats this as a known
            # intermittent edge case.
            if (
                response_format is not None
                and not content.strip()
                and empty_attempt < empty_content_retries
            ):
                empty_attempt += 1
                backoff_s = 0.5 * empty_attempt
                logger.warning(
                    "[zai-chat] empty content for structured "
                    "response_format on %s; retrying %d/%d after %.1fs%s",
                    model,
                    empty_attempt,
                    empty_content_retries,
                    backoff_s,
                    " (reasoning_content present)" if reasoning_content else "",
                )
                time.sleep(backoff_s)
                continue
            break
    except Exception as exc:
        elapsed = (time.monotonic() - llm_start) * 1000.0
        _publish_llm_usage(
            model=model,
            usage=None,
            ttft_ms=elapsed,
            duration_ms=elapsed,
            success=False,
            error=str(exc),
        )
        raise

    usage = data.get("usage") if isinstance(data.get("usage"), dict) else {}
    duration_ms = (time.monotonic() - llm_start) * 1000.0
    if response_format is not None and not content.strip():
        # Exhausted retries — propagate.
        error = (
            "Z.AI GLM Chat API returned empty assistant content for "
            f"structured response_format={getattr(response_format, '__name__', response_format)!r}"
            f" after {empty_attempt} empty-content retries"
        )
        if reasoning_content:
            error += "; reasoning_content was present but is not structured output"
        _publish_llm_usage(
            model=model,
            usage=usage,
            ttft_ms=duration_ms,
            duration_ms=duration_ms,
            success=False,
            error=error,
        )
        raise RuntimeError(error)

    if llm_span is not None:
        try:
            from src.telemetry import end_llm_request_span, record_tokens

            gross_input = int(
                usage.get("prompt_tokens") or usage.get("input_tokens") or 0
            )
            cache_read = int(
                (usage.get("prompt_tokens_details") or {}).get("cached_tokens")
                or (usage.get("input_tokens_details") or {}).get("cached_tokens")
                or usage.get("prompt_cache_hit_tokens")
                or 0
            )
            input_tokens = max(0, gross_input - cache_read)
            output_tokens = int(
                usage.get("completion_tokens") or usage.get("output_tokens") or 0
            )
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
        except Exception as exc:  # noqa: BLE001
            logger.warning("[telemetry] llm_request (zai) end failed: %s", exc)

    _publish_llm_usage(
        model=model,
        usage=usage,
        ttft_ms=duration_ms,
        duration_ms=duration_ms,
        success=True,
    )
    result: dict[str, Any] = {
        "role": "assistant",
        "content": content or "",
        "metadata": {
            "provider": "zai-chat",
            "model": model,
            "auth_mode": auth_mode,
            "id": data.get("id"),
            "finish_reason": finish_reason,
            "usage": usage,
            "duration_ms": duration_ms,
        },
    }
    if reasoning_content:
        result["metadata"]["reasoning_content_present"] = True
    if tool_calls:
        result["tool_calls"] = tool_calls

    try:
        from src.telemetry.genai_attrs import (
            set_genai_request_attrs,
            set_genai_response_attrs,
        )

        set_genai_request_attrs(
            system="zai",
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
            finish_reason=finish_reason,
            usage=usage,
            duration_ms=duration_ms,
            tool_calls_count=len(tool_calls) if tool_calls else None,
            output_chars=len(content) if isinstance(content, str) else None,
        )
    except Exception as _attr_exc:  # noqa: BLE001
        logger.debug("[genai-attrs] zai span enrichment failed: %s", _attr_exc)

    return result


def patch_for_zai(llm_client: Any) -> None:
    """Patch DaprChatClient to use Z.AI GLM's OpenAI-compatible chat endpoint."""

    from dapr_agents.llm.dapr.chat import DaprChatClient

    if getattr(DaprChatClient, "_zai_patched", False):
        return

    original_generate = DaprChatClient.generate

    def patched_generate(self: Any, *args: Any, **kwargs: Any) -> Any:
        component = getattr(self, "_llm_component", None)
        if component and _is_zai_component(component):
            prompt = args[0] if args else kwargs.get("prompt", "")
            raw_messages = kwargs.get("messages")
            tools = kwargs.get("tools")
            max_tokens = kwargs.get("max_tokens")
            response_format = kwargs.get("response_format")
            tool_choice = kwargs.get("tool_choice")

            messages = _normalize_messages_for_zai(
                prompt,
                raw_messages if isinstance(raw_messages, list) else None,
            )
            result = _call_zai_chat(
                component,
                messages,
                tools=tools,
                max_tokens=max_tokens,
                response_format=response_format,
                tool_choice=tool_choice,
                # Per-agent effort (agentConfig.reasoningEffort) — stamped onto
                # the client by call_llm alongside _llm_component; the env
                # default applies only when unset.
                reasoning_effort=getattr(self, "_reasoning_effort", None),
                # Tier-2 structured output (dynamic-script schema on GLM): force
                # json_object with thinking kept on. Returns text → journal
                # validates. Only when the Pydantic response_format is absent.
                native_json_schema=(
                    getattr(self, "_response_json_schema", None)
                    if response_format is None
                    else None
                ),
                # Tool mode (structuredOutputMode == "tool"): inject the
                # StructuredOutput tool definition carrying the schema instead
                # of json_object; the agent loop enforces + finalizes.
                structured_output_tool=(
                    getattr(self, "_structured_output_mode", None) == "tool"
                    and response_format is None
                ),
            )

            if response_format is not None:
                structured_content = result.get("content", "") or ""
                # Z.AI GLM intermittently returns EMPTY content (its documented
                # intermittent-empty-response behavior). Feeding "" to
                # parse_structured_response makes pydantic-v2 mis-construct a
                # ValidationError ("ValidationError.__new__() missing 1 required
                # positional argument: 'line_errors'"), which surfaces as a FATAL
                # "Activity task #N failed" and terminates the durable session —
                # bypassing the empty-response circuit breaker. Raise a clean
                # AgentError instead so the breaker counts it as an empty response
                # and degrades gracefully (matches the non-structured empty path).
                if not structured_content.strip():
                    from dapr_agents.types import AgentError

                    raise AgentError(
                        "Z.AI GLM returned empty content for a structured-output "
                        "call (response_format set); treating as an empty response."
                    )
                return parse_structured_response(
                    response_format,
                    structured_content,
                )

            return build_llm_chat_response(
                content=result.get("content", "") or "",
                tool_calls=result.get("tool_calls") or None,
                metadata=result.get("metadata") or {},
            )

        return original_generate(self, *args, **kwargs)

    DaprChatClient.generate = patched_generate
    DaprChatClient._zai_patched = True
    logger.info("[zai-chat] Patched DaprChatClient class for Z.AI GLM direct calls")

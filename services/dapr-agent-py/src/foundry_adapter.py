"""Azure AI Foundry chat-completions adapter for DaprChatClient.

Foundry direct models such as DeepSeek and Kimi are exposed through the
OpenAI-compatible chat completions API. Keep them on the same durable-agent
contract as NVIDIA: normal calls return LLMChatResponse and structured calls
return the requested Pydantic model.
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
    strict_json_schema,
)

logger = logging.getLogger(__name__)

COMPONENT_MODEL_MAP: dict[str, str] = {
    "llm-foundry-deepseek-v4-flash": "DeepSeek-V4-Flash",
    "llm-foundry-kimi-k26": "Kimi-K2.6",
}


def _is_foundry_component(component: str) -> bool:
    return component in COMPONENT_MODEL_MAP or "foundry" in str(component or "").lower()


def _get_foundry_model(component: str) -> str:
    return COMPONENT_MODEL_MAP.get(
        component,
        os.environ.get("AZURE_AI_FOUNDRY_DEFAULT_MODEL", "DeepSeek-V4-Flash"),
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


def _normalize_messages_for_foundry(
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
    for message in source:
        role = str(_message_attr(message, "role", "user") or "user")
        text = _as_text(_message_attr(message, "content", ""))

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
            call_id = str(_message_attr(message, "tool_call_id", "") or "").strip()
            if call_id:
                messages.append({
                    "role": "tool",
                    "tool_call_id": call_id,
                    "content": text or "ok",
                })
            else:
                messages.append({"role": "user", "content": text or "ok"})
            continue

        messages.append({
            "role": "user" if role not in {"user", "assistant"} else role,
            "content": text or "Continue.",
        })

    if not messages:
        messages.append({"role": "user", "content": "Continue."})
    return ensure_chat_completions_history(messages, provider="azure-ai-foundry")


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


def _convert_tools_for_foundry_chat(
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


def _extract_foundry_response(
    response: dict[str, Any],
) -> tuple[str, list[dict[str, Any]], str | None, str]:
    choices = response.get("choices") or []
    if not choices or not isinstance(choices[0], dict):
        return "", [], None, ""
    choice = choices[0]
    message = choice.get("message") if isinstance(choice.get("message"), dict) else {}
    content = _as_text(message.get("content"))
    reasoning_content = _as_text(message.get("reasoning_content"))
    tool_calls = [
        call
        for call in (
            _normalize_tool_call(call) for call in (message.get("tool_calls") or [])
        )
        if call is not None
    ]
    finish_reason = choice.get("finish_reason")
    return content, tool_calls, str(finish_reason) if finish_reason else None, reasoning_content


def _auth_headers() -> tuple[dict[str, str], str]:
    api_key = os.environ.get("AZURE_AI_FOUNDRY_API_KEY")
    if not api_key:
        raise RuntimeError(
            "No Azure AI Foundry authentication configured. "
            "Set AZURE_AI_FOUNDRY_API_KEY."
        )
    return {
        "api-key": api_key,
        "Authorization": f"Bearer {api_key}",
    }, "azure-ai-foundry-api-key"


def _make_foundry_request(
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
        },
        method="POST",
    )


def _retry_after_seconds(exc: HTTPError) -> float:
    header = exc.headers.get("Retry-After") if exc.headers else None
    if header:
        try:
            return max(0.0, float(header))
        except ValueError:
            pass
    return max(
        0.0,
        float(os.environ.get("AZURE_AI_FOUNDRY_RATE_LIMIT_BACKOFF_SECONDS", "65")),
    )


def _rate_limit_max_retries() -> int:
    return max(0, int(os.environ.get("AZURE_AI_FOUNDRY_RATE_LIMIT_MAX_RETRIES", "3")))


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
        payload: dict[str, Any] = {
            "model": model,
            **get_scoped_audit_fields(),
            "input_tokens": int(
                usage.get("prompt_tokens") or usage.get("input_tokens") or 0
            ),
            "output_tokens": int(
                usage.get("completion_tokens") or usage.get("output_tokens") or 0
            ),
            "cache_read_input_tokens": 0,
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
        logger.debug("[session-event] foundry llm_usage emit failed: %s", exc)


def _call_foundry_chat(
    component: str,
    messages: list[dict[str, Any]],
    tools: list[Any] | None = None,
    max_tokens: int | None = None,
    response_format: Any = None,
    tool_choice: Any = None,
) -> dict[str, Any]:
    model = _get_foundry_model(component)
    converted_tools = _convert_tools_for_foundry_chat(tools)

    llm_span = None
    llm_start = time.monotonic()
    try:
        from src.telemetry import start_llm_request_span

        llm_span = start_llm_request_span(
            model,
            fast_mode=False,
            query_source="dapr_agent_py.foundry_adapter",
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
        logger.warning("[telemetry] llm_request (foundry) start failed: %s", exc)

    headers, auth_mode = _auth_headers()
    base_url = os.environ.get(
        "AZURE_AI_FOUNDRY_BASE_URL",
        "https://vinod-1064-resource.services.ai.azure.com/openai/v1",
    )
    url = os.environ.get(
        "AZURE_AI_FOUNDRY_CHAT_COMPLETIONS_URL",
        f"{base_url.rstrip('/')}/chat/completions",
    )
    timeout = int(os.environ.get("AZURE_AI_FOUNDRY_TIMEOUT_SECONDS", "600"))
    output_cap = max_tokens or int(os.environ.get("AZURE_AI_FOUNDRY_MAX_TOKENS", "1024"))
    request_body: dict[str, Any] = {
        "model": model,
        "messages": messages,
        "max_tokens": output_cap,
        "stream": False,
    }
    if converted_tools:
        request_body["tools"] = converted_tools
        if tool_choice in (None, "", "auto"):
            request_body["tool_choice"] = "auto"
        elif tool_choice == "none":
            request_body["tool_choice"] = "none"
        else:
            logger.warning(
                "[foundry-chat] ignoring unsupported forced tool_choice=%r",
                tool_choice,
            )
            request_body["tool_choice"] = "auto"
    if response_format is not None:
        try:
            schema = strict_json_schema(response_format.model_json_schema())
            request_body["response_format"] = {
                "type": "json_schema",
                "json_schema": {
                    "name": response_format.__name__,
                    "schema": schema,
                    "strict": True,
                },
            }
        except Exception:
            request_body["response_format"] = {"type": "json_object"}

    logger.info(
        "[foundry-chat] Calling %s with %d messages, %d tools, auth=%s",
        model,
        len(messages),
        len(converted_tools or []),
        auth_mode,
    )
    data: dict[str, Any]
    rate_limit_retries = _rate_limit_max_retries()
    attempt = 0
    try:
        while True:
            req = _make_foundry_request(url, request_body, headers)
            try:
                with urllib.request.urlopen(req, timeout=timeout) as resp:
                    data = json.loads(resp.read() or b"{}")
                break
            except HTTPError as exc:
                detail = exc.read().decode("utf-8", errors="replace")
                if exc.code == 429 and attempt < rate_limit_retries:
                    delay = _retry_after_seconds(exc)
                    attempt += 1
                    logger.warning(
                        "[foundry-chat] 429 rate limit from %s; retrying in %.1fs "
                        "(attempt %d/%d): %s",
                        model,
                        delay,
                        attempt,
                        rate_limit_retries,
                        detail[:300],
                    )
                    time.sleep(delay)
                    continue
                raise RuntimeError(
                    f"Azure AI Foundry Chat API failed ({exc.code}): {detail}"
                ) from exc
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

    content, tool_calls, finish_reason, reasoning_content = _extract_foundry_response(data)
    usage = data.get("usage") if isinstance(data.get("usage"), dict) else {}
    duration_ms = (time.monotonic() - llm_start) * 1000.0
    if response_format is not None and not content.strip():
        error = (
            "Azure AI Foundry Chat API returned empty assistant content for "
            f"structured response_format={getattr(response_format, '__name__', response_format)!r}"
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

            input_tokens = int(
                usage.get("prompt_tokens") or usage.get("input_tokens") or 0
            )
            output_tokens = int(
                usage.get("completion_tokens") or usage.get("output_tokens") or 0
            )
            end_llm_request_span(
                llm_span,
                input_tokens=input_tokens or None,
                output_tokens=output_tokens or None,
                success=True,
                has_tool_call=bool(tool_calls),
                ttft_ms=duration_ms,
                model_output=content or None,
            )
            record_tokens(type_="input", count=input_tokens, model=model)
            record_tokens(type_="output", count=output_tokens, model=model)
        except Exception as exc:  # noqa: BLE001
            logger.warning("[telemetry] llm_request (foundry) end failed: %s", exc)

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
            "provider": "azure-ai-foundry-chat",
            "model": model,
            "auth_mode": auth_mode,
            "id": data.get("id"),
            "finish_reason": finish_reason,
        },
    }
    if reasoning_content:
        result["metadata"]["reasoning_content_present"] = True
    if tool_calls:
        result["tool_calls"] = tool_calls
    return result


def patch_for_foundry(llm_client: Any) -> None:
    """Patch DaprChatClient to use Foundry's OpenAI-compatible chat endpoint."""

    from dapr_agents.llm.dapr.chat import DaprChatClient

    if getattr(DaprChatClient, "_foundry_patched", False):
        return

    original_generate = DaprChatClient.generate

    def patched_generate(self: Any, *args: Any, **kwargs: Any) -> Any:
        component = getattr(self, "_llm_component", None)
        if component and _is_foundry_component(component):
            prompt = args[0] if args else kwargs.get("prompt", "")
            raw_messages = kwargs.get("messages")
            tools = kwargs.get("tools")
            max_tokens = kwargs.get("max_tokens")
            response_format = kwargs.get("response_format")
            tool_choice = kwargs.get("tool_choice")

            messages = _normalize_messages_for_foundry(
                prompt,
                raw_messages if isinstance(raw_messages, list) else None,
            )
            result = _call_foundry_chat(
                component,
                messages,
                tools=tools,
                max_tokens=max_tokens,
                response_format=response_format,
                tool_choice=tool_choice,
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
    DaprChatClient._foundry_patched = True
    logger.info("[foundry-chat] Patched DaprChatClient class for Foundry direct calls")

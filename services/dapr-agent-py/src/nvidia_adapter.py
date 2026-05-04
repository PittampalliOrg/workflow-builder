"""NVIDIA Chat Completions adapter for DaprChatClient.

NVIDIA's hosted NIM endpoint is OpenAI-compatible, but dapr-agent-py uses
the OpenAI Responses adapter for OpenAI models. This narrow adapter keeps
NVIDIA on the chat-completions shape that Dapr Agents upstream uses.
"""

from __future__ import annotations

import json
import logging
import os
from typing import Any
from urllib.error import HTTPError
import urllib.request

logger = logging.getLogger(__name__)

COMPONENT_MODEL_MAP: dict[str, str] = {
    "llm-nvidia-llama31-8b": "meta/llama-3.1-8b-instruct",
}


def _is_nvidia_component(component: str) -> bool:
    return (
        component in COMPONENT_MODEL_MAP
        or "nvidia" in str(component or "").lower()
    )


def _get_nvidia_model(component: str) -> str:
    return COMPONENT_MODEL_MAP.get(
        component,
        os.environ.get("NVIDIA_DEFAULT_MODEL", "meta/llama-3.1-8b-instruct"),
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


def _normalize_messages_for_nvidia(
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
        content = _message_attr(message, "content", "")
        text = _as_text(content)

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
    return messages


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


def _convert_tools_for_nvidia_chat(
    tools: list[Any] | None,
) -> list[dict[str, Any]] | None:
    if not tools:
        return None
    converted: list[dict[str, Any]] = []
    for tool in tools:
        name = _tool_name(tool)
        if not name:
            continue
        converted.append(
            {
                "type": "function",
                "function": {
                    "name": name,
                    "description": _tool_description(tool, name),
                    "parameters": _tool_parameters(tool),
                },
            }
        )
    if not converted:
        return None
    converted.sort(key=lambda item: item["function"].get("name") or "")
    return converted


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


def _extract_nvidia_response(
    response: dict[str, Any],
) -> tuple[str, list[dict[str, Any]], str | None]:
    choices = response.get("choices") or []
    if not choices or not isinstance(choices[0], dict):
        return "", [], None
    choice = choices[0]
    message = choice.get("message") if isinstance(choice.get("message"), dict) else {}
    content = _as_text(message.get("content"))
    tool_calls = [
        call
        for call in (
            _normalize_tool_call(call) for call in (message.get("tool_calls") or [])
        )
        if call is not None
    ]
    finish_reason = choice.get("finish_reason")
    return content, tool_calls, str(finish_reason) if finish_reason else None


def _auth_headers() -> tuple[dict[str, str], str]:
    api_key = os.environ.get("NVIDIA_API_KEY")
    if not api_key:
        raise RuntimeError("No NVIDIA authentication configured. Set NVIDIA_API_KEY.")
    return {"Authorization": f"Bearer {api_key}"}, "nvidia-api-key"


def _make_nvidia_request(
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
        logger.debug("[session-event] nvidia llm_usage emit failed: %s", exc)


def _call_nvidia_chat(
    component: str,
    messages: list[dict[str, Any]],
    tools: list[Any] | None = None,
    max_tokens: int | None = None,
) -> dict[str, Any]:
    model = _get_nvidia_model(component)
    converted_tools = _convert_tools_for_nvidia_chat(tools)
    import time as _time

    llm_span = None
    llm_start = _time.monotonic()
    try:
        from src.telemetry import start_llm_request_span

        llm_span = start_llm_request_span(
            model,
            fast_mode=False,
            query_source="dapr_agent_py.nvidia_adapter",
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
        logger.warning("[telemetry] llm_request (nvidia) start failed: %s", exc)

    headers, auth_mode = _auth_headers()
    base_url = os.environ.get("NVIDIA_BASE_URL", "https://integrate.api.nvidia.com/v1")
    url = os.environ.get(
        "NVIDIA_CHAT_COMPLETIONS_URL",
        f"{base_url.rstrip('/')}/chat/completions",
    )
    timeout = int(os.environ.get("NVIDIA_TIMEOUT_SECONDS", "180"))
    output_cap = max_tokens or int(os.environ.get("NVIDIA_MAX_TOKENS", "1024"))
    request_body: dict[str, Any] = {
        "model": model,
        "messages": messages,
        "max_tokens": output_cap,
        "stream": False,
    }
    if converted_tools:
        request_body["tools"] = converted_tools
        request_body["tool_choice"] = "auto"

    req = _make_nvidia_request(url, request_body, headers)
    logger.info(
        "[nvidia-chat] Calling %s with %d messages, %d tools, auth=%s",
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
        elapsed = (_time.monotonic() - llm_start) * 1000.0
        _publish_llm_usage(
            model=model,
            usage=None,
            ttft_ms=elapsed,
            duration_ms=elapsed,
            success=False,
            error=detail,
        )
        raise RuntimeError(f"NVIDIA Chat API failed ({exc.code}): {detail}") from exc
    except Exception as exc:
        elapsed = (_time.monotonic() - llm_start) * 1000.0
        _publish_llm_usage(
            model=model,
            usage=None,
            ttft_ms=elapsed,
            duration_ms=elapsed,
            success=False,
            error=str(exc),
        )
        raise

    content, tool_calls, finish_reason = _extract_nvidia_response(data)
    usage = data.get("usage") if isinstance(data.get("usage"), dict) else {}
    duration_ms = (_time.monotonic() - llm_start) * 1000.0
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
            logger.warning("[telemetry] llm_request (nvidia) end failed: %s", exc)

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
            "provider": "nvidia-chat",
            "model": model,
            "auth_mode": auth_mode,
            "id": data.get("id"),
            "finish_reason": finish_reason,
        },
    }
    if tool_calls:
        result["tool_calls"] = tool_calls
    return result


def patch_for_nvidia(llm_client: Any) -> None:
    """Patch DaprChatClient to use NVIDIA's OpenAI-compatible chat endpoint."""

    from dapr_agents.llm.dapr.chat import DaprChatClient

    if getattr(DaprChatClient, "_nvidia_patched", False):
        return

    original_generate = DaprChatClient.generate

    def patched_generate(self: Any, *args: Any, **kwargs: Any) -> Any:
        component = getattr(self, "_llm_component", None)
        if component and _is_nvidia_component(component):
            from dapr_agents.types.message import (
                AssistantMessage,
                LLMChatCandidate,
                LLMChatResponse,
            )

            prompt = args[0] if args else kwargs.get("prompt", "")
            raw_messages = kwargs.get("messages")
            tools = kwargs.get("tools")
            max_tokens = kwargs.get("max_tokens")
            response_format = kwargs.get("response_format")

            messages = _normalize_messages_for_nvidia(
                prompt,
                raw_messages if isinstance(raw_messages, list) else None,
            )
            result = _call_nvidia_chat(
                component,
                messages,
                tools=tools,
                max_tokens=max_tokens,
            )

            if response_format is not None and result.get("content"):
                content_text = str(result["content"])
                try:
                    return response_format.model_validate_json(content_text)
                except Exception:
                    try:
                        return response_format.model_validate(json.loads(content_text))
                    except Exception:
                        pass

            msg = AssistantMessage(
                content=result.get("content", "") or "",
                role="assistant",
            )
            if result.get("tool_calls"):
                msg.tool_calls = result["tool_calls"]
            finish_reason = "tool_use" if result.get("tool_calls") else "end_turn"
            return LLMChatResponse(
                results=[LLMChatCandidate(message=msg, finish_reason=finish_reason)],
                metadata=result.get("metadata") or {},
            )

        return original_generate(self, *args, **kwargs)

    DaprChatClient.generate = patched_generate
    DaprChatClient._nvidia_patched = True
    logger.info("[nvidia-chat] Patched DaprChatClient class for NVIDIA direct calls")

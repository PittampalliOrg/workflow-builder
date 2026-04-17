"""OpenAI Responses API adapter for DaprChatClient.

The OpenAI components normally go through Dapr conversation components. This
adapter lets dapr-agent-py use ChatGPT OAuth tokens captured by the Codex-style
device flow while preserving API-key fallback.
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


def _convert_tools_for_openai(tools: list[Any] | None) -> list[dict[str, Any]] | None:
    if not tools:
        return None
    converted = [_tool_schema(tool) for tool in tools]
    return converted or None


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


def _extract_openai_response(response: dict[str, Any]) -> tuple[str, list[dict[str, Any]]]:
    content_parts: list[str] = []
    tool_calls: list[dict[str, Any]] = []
    for item in response.get("output") or []:
        if item.get("type") == "message":
            for part in item.get("content") or []:
                if isinstance(part, dict) and part.get("type") == "output_text":
                    content_parts.append(str(part.get("text") or ""))
        elif item.get("type") == "function_call":
            call_id = str(item.get("call_id") or item.get("id") or "")
            tool_calls.append({
                "id": call_id,
                "type": "function",
                "function": {
                    "name": str(item.get("name") or ""),
                    "arguments": str(item.get("arguments") or "{}"),
                },
            })
    return "".join(content_parts), tool_calls


def _auth_headers() -> tuple[dict[str, str], str]:
    try:
        from src.openai_oauth.manager import openai_oauth_manager

        headers = openai_oauth_manager.get_auth_headers()
        if headers:
            return headers, "openai-oauth"
    except Exception:
        pass

    api_key_headers = _api_key_auth_headers()
    if api_key_headers:
        return api_key_headers

    raise RuntimeError(
        "No OpenAI authentication configured. Set OPENAI_API_KEY or connect OpenAI OAuth."
    )


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


def _strict_json_schema(schema: dict[str, Any]) -> dict[str, Any]:
    strict_schema = json.loads(json.dumps(schema))

    def visit(node: Any) -> None:
        if isinstance(node, dict):
            properties = node.get("properties")
            if isinstance(properties, dict):
                node["additionalProperties"] = False
                existing_required = node.get("required")
                required = existing_required if isinstance(existing_required, list) else []
                node["required"] = list(dict.fromkeys([*required, *properties.keys()]))
                for value in properties.values():
                    visit(value)
            for key in ("$defs", "definitions"):
                defs = node.get(key)
                if isinstance(defs, dict):
                    for value in defs.values():
                        visit(value)
            for key in ("items", "anyOf", "oneOf", "allOf"):
                value = node.get(key)
                if isinstance(value, list):
                    for item in value:
                        visit(item)
                else:
                    visit(value)
        elif isinstance(node, list):
            for item in node:
                visit(item)

    visit(strict_schema)
    return strict_schema


def _call_openai_responses(
    component: str,
    messages: list[dict[str, Any]],
    instructions: str | None,
    tools: list[Any] | None = None,
    max_tokens: int | None = None,
    response_format: Any = None,
) -> dict[str, Any]:
    model = _get_openai_model(component)
    # claude_code.llm_request span — wraps the whole OpenAI Responses call
    # including the OAuth→API-key fallback retry path.
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
    converted_tools = _convert_tools_for_openai(tools)
    if converted_tools:
        request_body["tools"] = converted_tools
        request_body["parallel_tool_calls"] = True
    if max_tokens:
        request_body["max_output_tokens"] = max_tokens
    if model.startswith("gpt-5") or model.startswith("o"):
        effort = os.environ.get("OPENAI_REASONING_EFFORT", "medium")
        request_body["reasoning"] = {"effort": effort}
    if response_format is not None:
        try:
            schema = _strict_json_schema(response_format.model_json_schema())
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
        api_key_headers = _api_key_auth_headers()
        if auth_mode == "openai-oauth" and exc.code in {401, 403} and api_key_headers:
            auth_headers, auth_mode = api_key_headers
            retry_req = _make_openai_request(url, request_body, auth_headers)
            logger.warning(
                "[openai-responses] OAuth auth failed with HTTP %s; retrying with OPENAI_API_KEY",
                exc.code,
            )
            try:
                with urllib.request.urlopen(retry_req, timeout=timeout) as resp:
                    data = json.loads(resp.read() or b"{}")
            except HTTPError as retry_exc:
                detail = retry_exc.read().decode("utf-8", errors="replace")
                raise RuntimeError(
                    f"OpenAI Responses API failed ({retry_exc.code}): {detail}"
                ) from retry_exc
        else:
            raise RuntimeError(f"OpenAI Responses API failed ({exc.code}): {detail}") from exc

    content, tool_calls = _extract_openai_response(data)
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

            instructions, messages = _normalize_messages(prompt, raw_messages)
            result = _call_openai_responses(
                component,
                messages,
                instructions,
                tools=tools,
                max_tokens=max_tokens,
                response_format=response_format,
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
    DaprChatClient._openai_patched = True
    logger.info("[openai-responses] Patched DaprChatClient class for OpenAI direct calls")

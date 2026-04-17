"""Gemini/Vertex AI OAuth adapter for DaprChatClient.

When Google OAuth tokens and Vertex AI project settings are available, this
adapter calls the public Vertex AI Gemini generateContent endpoint directly.
Otherwise the normal Dapr conversation component remains the fallback.
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
    "llm-google-gemini": "gemini-3.1-pro",
}


def _is_gemini_component(component: str) -> bool:
    lowered = component.lower()
    return component in COMPONENT_MODEL_MAP or "gemini" in lowered or "google" in lowered


def _get_gemini_model(component: str) -> str:
    return COMPONENT_MODEL_MAP.get(component, os.environ.get("GEMINI_VERTEX_MODEL", "gemini-3.1-pro"))


def _vertex_project() -> str | None:
    return os.environ.get("GOOGLE_CLOUD_PROJECT") or os.environ.get("GOOGLE_CLOUD_PROJECT_ID")


def _vertex_location() -> str | None:
    return os.environ.get("GOOGLE_CLOUD_LOCATION") or os.environ.get("GOOGLE_VERTEX_LOCATION")


def _vertex_generate_content_url(project: str, location: str, model: str) -> str:
    normalized_location = location.strip()
    host = "aiplatform.googleapis.com"
    if normalized_location.lower() != "global":
        host = f"{normalized_location}-aiplatform.googleapis.com"
    return (
        f"https://{host}/v1/projects/{project}"
        f"/locations/{normalized_location}/publishers/google/models/{model}:generateContent"
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


def _tool_schema(tool: Any) -> dict[str, Any]:
    schema: dict[str, Any] = {"type": "object", "properties": {}}
    if hasattr(tool, "args_model") and tool.args_model:
        try:
            schema = tool.args_model.model_json_schema()
        except Exception:
            schema = {"type": "object", "properties": {}}
    return {
        "name": tool.name,
        "description": getattr(tool, "description", "") or tool.name,
        "parameters": schema,
    }


def _convert_tools_for_gemini(tools: list[Any] | None) -> list[dict[str, Any]] | None:
    if not tools:
        return None
    declarations = [_tool_schema(tool) for tool in tools]
    return [{"functionDeclarations": declarations}] if declarations else None


def _normalize_messages(
    prompt: Any,
    raw_messages: list[Any] | None,
) -> tuple[str | None, list[dict[str, Any]]]:
    system_parts: list[str] = []
    contents: list[dict[str, Any]] = []

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
                system_parts.append(text)
            continue
        if role == "assistant":
            parts: list[dict[str, Any]] = []
            text = _as_text(content)
            if text:
                parts.append({"text": text})
            for call in _message_attr(message, "tool_calls", None) or []:
                fn = call.get("function", {}) if isinstance(call, dict) else {}
                args = fn.get("arguments", "{}")
                try:
                    parsed_args = json.loads(args) if isinstance(args, str) else args
                except Exception:
                    parsed_args = {"arguments": str(args)}
                parts.append({
                    "functionCall": {
                        "name": fn.get("name", ""),
                        "args": parsed_args if isinstance(parsed_args, dict) else {"arguments": parsed_args},
                    }
                })
            if parts:
                contents.append({"role": "model", "parts": parts})
            continue
        if role == "tool":
            call_id = _message_attr(message, "tool_call_id", "")
            text = _as_text(content) or "ok"
            prefix = f"Tool result {call_id}: " if call_id else "Tool result: "
            contents.append({"role": "user", "parts": [{"text": f"{prefix}{text}"}]})
            continue

        text = _as_text(content) or "Continue."
        contents.append({"role": "user", "parts": [{"text": text}]})

    if not contents:
        contents.append({"role": "user", "parts": [{"text": "Continue."}]})
    return "\n\n".join(system_parts) if system_parts else None, contents


def _extract_gemini_response(
    response: dict[str, Any],
) -> tuple[str, list[dict[str, Any]], list[str]]:
    """Returns (content, tool_calls, thinking_blocks).

    With `thinkingConfig.includeThoughts = true`, the Vertex API tags
    thought-summary parts with `thought: true`. We keep those separate from
    the final content so the session UI can render them as collapsible
    reasoning blocks rather than prepending them to the assistant message.
    """
    content_parts: list[str] = []
    tool_calls: list[dict[str, Any]] = []
    thinking_blocks: list[str] = []
    candidates = response.get("candidates") or []
    if not candidates:
        return "", [], []
    for index, part in enumerate(candidates[0].get("content", {}).get("parts") or []):
        is_thought = bool(part.get("thought"))
        if "text" in part:
            text = str(part.get("text") or "")
            if is_thought:
                if text.strip():
                    thinking_blocks.append(text)
            else:
                content_parts.append(text)
        fn = part.get("functionCall")
        if isinstance(fn, dict):
            name = str(fn.get("name") or "")
            args = fn.get("args") or {}
            tool_calls.append({
                "id": f"gemini-{index}-{name}",
                "type": "function",
                "function": {
                    "name": name,
                    "arguments": json.dumps(args, ensure_ascii=False),
                },
            })
    return "".join(content_parts), tool_calls, thinking_blocks


def _emit_thinking(thinking_blocks: list[str]) -> None:
    """Emit agent.thinking events for each thought-summary part. Session id
    comes from the contextvar set by main.py:call_llm, mirroring the
    Anthropic adapter.
    """
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
        logger.debug("[gemini-vertex] thinking emit failed: %s", exc)


def _model_supports_thinking(model: str) -> bool:
    """Gemini 2.5+/3.x expose thought summaries. 1.5/2.0 don't. Whitelist
    narrowly — unknown models get no thinking config (safe default)."""
    lowered = model.lower()
    return (
        "gemini-2.5" in lowered
        or "gemini-3" in lowered
        or "gemini-exp" in lowered
    )


def _auth_headers() -> dict[str, str] | None:
    try:
        from src.gemini_oauth.manager import gemini_oauth_manager

        return gemini_oauth_manager.get_auth_headers()
    except Exception:
        return None


def _call_vertex_gemini(
    component: str,
    contents: list[dict[str, Any]],
    system_instruction: str | None,
    tools: list[Any] | None = None,
    max_tokens: int | None = None,
    response_format: Any = None,
) -> dict[str, Any]:
    headers = _auth_headers()
    project = _vertex_project()
    location = _vertex_location()
    if not headers or not project or not location:
        raise RuntimeError("Gemini OAuth or Vertex AI project/location is not configured")

    model = _get_gemini_model(component)
    # claude_code.llm_request span for the Vertex Gemini call.
    import time as _time

    llm_span = None
    llm_start = _time.monotonic()
    try:
        from src.telemetry import start_llm_request_span

        llm_span = start_llm_request_span(
            model,
            fast_mode=False,
            query_source="dapr_agent_py.gemini_adapter",
            system_prompt=system_instruction,
            messages_for_api=list(contents),
        )
    except Exception as exc:  # noqa: BLE001
        logger.warning("[telemetry] llm_request (gemini) start failed: %s", exc)
    request_headers = {
        **headers,
        "Accept": "application/json",
        "Content-Type": "application/json",
    }
    body: dict[str, Any] = {"contents": contents}
    if system_instruction:
        body["systemInstruction"] = {"parts": [{"text": system_instruction}]}
    converted_tools = _convert_tools_for_gemini(tools)
    if converted_tools:
        body["tools"] = converted_tools
    generation_config: dict[str, Any] = {}
    if max_tokens:
        generation_config["maxOutputTokens"] = max_tokens
    if response_format is not None:
        generation_config["responseMimeType"] = "application/json"
    # Opt into thought summaries on 2.5+/3.x. thinkingBudget=-1 means
    # "dynamic"; Gemini picks the budget like Anthropic's adaptive mode.
    if _model_supports_thinking(model):
        generation_config["thinkingConfig"] = {
            "thinkingBudget": -1,
            "includeThoughts": True,
        }
    if generation_config:
        body["generationConfig"] = generation_config

    url = _vertex_generate_content_url(project, location, model)
    timeout = int(os.environ.get("GEMINI_VERTEX_TIMEOUT_SECONDS", "180"))
    req = urllib.request.Request(
        url,
        data=json.dumps(body).encode(),
        headers=request_headers,
        method="POST",
    )
    logger.info(
        "[gemini-vertex] Calling %s with %d contents, %d tools",
        model,
        len(contents),
        len(converted_tools[0]["functionDeclarations"] if converted_tools else []),
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            data = json.loads(resp.read() or b"{}")
    except HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"Vertex AI Gemini API failed ({exc.code}): {detail}") from exc

    content, tool_calls, thinking_blocks = _extract_gemini_response(data)
    _emit_thinking(thinking_blocks)
    result: dict[str, Any] = {
        "role": "assistant",
        "content": content or None,
        "metadata": {
            "provider": "vertex-ai-gemini",
            "model": model,
            "project": project,
            "location": location,
        },
    }
    if tool_calls:
        result["tool_calls"] = tool_calls
        result["content"] = content or ""

    if llm_span is not None:
        try:
            from src.telemetry import end_llm_request_span, record_tokens

            usage = (data.get("usageMetadata") or {}) if isinstance(data, dict) else {}
            input_tokens = int(usage.get("promptTokenCount") or 0)
            output_tokens = int(usage.get("candidatesTokenCount") or 0)
            duration_ms = (_time.monotonic() - llm_start) * 1000.0
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
            logger.warning("[telemetry] llm_request (gemini) end failed: %s", exc)
    return result


def _can_use_vertex_oauth() -> bool:
    return bool(_auth_headers() and _vertex_project() and _vertex_location())


def patch_for_gemini(llm_client: Any) -> None:
    """Patch DaprChatClient to use Vertex AI Gemini when OAuth is available."""

    from dapr_agents.llm.dapr.chat import DaprChatClient

    if getattr(DaprChatClient, "_gemini_patched", False):
        return

    original_generate = DaprChatClient.generate

    def patched_generate(self: Any, *args: Any, **kwargs: Any) -> Any:
        component = getattr(self, "_llm_component", None)
        if component and _is_gemini_component(component) and _can_use_vertex_oauth():
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

            system_instruction, contents = _normalize_messages(prompt, raw_messages)
            result = _call_vertex_gemini(
                component,
                contents,
                system_instruction,
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
    DaprChatClient._gemini_patched = True
    logger.info("[gemini-vertex] Patched DaprChatClient class for Gemini OAuth calls")

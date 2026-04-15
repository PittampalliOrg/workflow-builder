"""Anthropic SDK adapter for DaprChatClient.

Monkey-patches the DaprChatClient to use the Anthropic SDK directly
when the target component is an Anthropic conversation component.
This bypasses the Dapr conversation API which has a langchaingo bug
where tool_choice is sent as a string instead of a dict.

Recovery logic mirrors claude-code-src/main/query.ts:
- Default max_tokens with escalation on first hit
- Multi-turn recovery (up to 3 continuation attempts)
- Partial response preserved and model instructed to resume

Usage:
    from src.anthropic_adapter import patch_for_anthropic
    patch_for_anthropic(agent.llm)
"""

from __future__ import annotations

import json
import logging
import os
from typing import Any

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Token limit constants (mirrors claude-code-src/main/utils/context.ts)
# ---------------------------------------------------------------------------

# Conservative default — matches Claude Code's capped slot-reservation default.
# Most responses fit well within this; those that don't trigger escalation.
CAPPED_DEFAULT_MAX_TOKENS = int(
    os.environ.get("DAPR_AGENT_PY_MAX_TOKENS", "16384")
)

# Escalation target when the capped default is exhausted.
# Claude Code uses 64k; Opus 4.6 supports up to 128k output.
ESCALATED_MAX_TOKENS = int(
    os.environ.get("DAPR_AGENT_PY_ESCALATED_MAX_TOKENS", "64000")
)

# Maximum continuation attempts after escalation
# (mirrors MAX_OUTPUT_TOKENS_RECOVERY_LIMIT in query.ts)
MAX_OUTPUT_TOKENS_RECOVERY_LIMIT = 3

# Recovery message injected between continuation attempts
# (mirrors query.ts lines 1225-1227)
_RECOVERY_MESSAGE = (
    "Output token limit hit. Resume directly — no apology, no recap of what "
    "you were doing. Pick up mid-thought if that is where the cut happened. "
    "Break remaining work into smaller pieces."
)

# Model mapping: Dapr component name → Anthropic model ID
COMPONENT_MODEL_MAP: dict[str, str] = {
    "llm-anthropic-sonnet": "claude-sonnet-4-6",
    "llm-anthropic-opus": "claude-opus-4-6",
    "llm-anthropic-haiku": "claude-haiku-4-5-20251001",
}


def _is_anthropic_component(component: str) -> bool:
    """Check if a component name maps to an Anthropic model."""
    return component in COMPONENT_MODEL_MAP or "anthropic" in component.lower()


def _get_anthropic_model(component: str) -> str:
    """Get the Anthropic model ID for a component name."""
    return COMPONENT_MODEL_MAP.get(component, "claude-sonnet-4-6-20250414")


def _convert_tools_for_anthropic(tools: list[Any] | None) -> list[dict] | None:
    """Convert AgentTool objects to Anthropic tool format."""
    if not tools:
        return None

    anthropic_tools = []
    for tool in tools:
        schema = {}
        if hasattr(tool, "args_model") and tool.args_model:
            try:
                schema = tool.args_model.model_json_schema()
            except Exception:
                schema = {"type": "object", "properties": {}}
        else:
            schema = {"type": "object", "properties": {}}

        anthropic_tools.append({
            "name": tool.name,
            "description": getattr(tool, "description", "") or tool.name,
            "input_schema": schema,
        })

    return anthropic_tools if anthropic_tools else None


def _extract_response(response: Any) -> tuple[str, list[dict]]:
    """Extract text content and tool_calls from an Anthropic response."""
    content = ""
    tool_calls = []
    for block in response.content:
        if block.type == "text":
            content += block.text
        elif block.type == "tool_use":
            tool_calls.append({
                "id": block.id,
                "type": "function",
                "function": {
                    "name": block.name,
                    "arguments": json.dumps(block.input),
                },
            })
    return content, tool_calls


def _response_to_assistant_message(
    content: str, tool_calls: list[dict],
) -> list[dict]:
    """Convert extracted response into Anthropic message content blocks.

    Used to append a partial assistant response back into the conversation
    for continuation.
    """
    blocks: list[dict] = []
    if content:
        blocks.append({"type": "text", "text": content})
    for tc in tool_calls:
        fn = tc.get("function", {})
        blocks.append({
            "type": "tool_use",
            "id": tc.get("id", ""),
            "name": fn.get("name", ""),
            "input": json.loads(fn.get("arguments", "{}"))
            if isinstance(fn.get("arguments"), str)
            else fn.get("arguments", {}),
        })
    return blocks


def _call_anthropic_sdk(
    component: str,
    messages: list[dict],
    tools: list[Any] | None = None,
    max_tokens: int = CAPPED_DEFAULT_MAX_TOKENS,
    **kwargs: Any,
) -> dict[str, Any]:
    """Call the Anthropic API with automatic recovery on max_tokens truncation.

    Recovery mirrors claude-code-src/main/query.ts:
      1. Escalation: retry same request at ESCALATED_MAX_TOKENS (silent, once)
      2. Multi-turn recovery: append partial response + recovery message,
         re-call API (up to MAX_OUTPUT_TOKENS_RECOVERY_LIMIT times)
      3. Merge all partial responses into a single complete response
    """
    import anthropic

    api_key = os.environ.get("ANTHROPIC_API_KEY")
    if not api_key:
        raise RuntimeError("ANTHROPIC_API_KEY environment variable not set")

    client = anthropic.Anthropic(api_key=api_key)
    model = _get_anthropic_model(component)
    anthropic_tools = _convert_tools_for_anthropic(tools)

    # Patch empty user messages (Anthropic rejects whitespace-only content)
    patched_messages = []
    for m in messages:
        c = m.get("content")
        if m.get("role") == "user" and isinstance(c, str) and not c.strip():
            patched_messages.append({**m, "content": "Continue."})
        elif m.get("role") == "user" and not c:
            patched_messages.append({**m, "content": "Continue."})
        else:
            patched_messages.append(m)

    # -- Attempt 1: initial request at current max_tokens -----------------

    request_kwargs: dict[str, Any] = {
        "model": model,
        "max_tokens": max_tokens,
        "messages": patched_messages,
    }
    if anthropic_tools:
        request_kwargs["tools"] = anthropic_tools

    logger.info(
        "[anthropic-sdk] Calling %s with %d messages, %d tools, max_tokens=%d",
        model, len(patched_messages), len(anthropic_tools or []), max_tokens,
    )

    response = client.messages.create(**request_kwargs)
    content, tool_calls = _extract_response(response)

    # -- Layer 1: Escalation retry (mirrors query.ts lines 1193-1221) -----
    # If we hit max_tokens at the capped default, retry the SAME request
    # with ESCALATED_MAX_TOKENS. No recovery message, no multi-turn — just
    # a clean retry with a higher limit. Fires once.

    if (
        response.stop_reason == "max_tokens"
        and max_tokens < ESCALATED_MAX_TOKENS
    ):
        logger.info(
            "[anthropic-sdk] max_tokens hit at %d, escalating to %d",
            max_tokens, ESCALATED_MAX_TOKENS,
        )
        request_kwargs["max_tokens"] = ESCALATED_MAX_TOKENS
        response = client.messages.create(**request_kwargs)
        content, tool_calls = _extract_response(response)
        max_tokens = ESCALATED_MAX_TOKENS

    # -- Layer 2: Multi-turn recovery (mirrors query.ts lines 1223-1252) --
    # If still truncated after escalation, preserve the partial response and
    # ask the model to continue. Repeat up to MAX_OUTPUT_TOKENS_RECOVERY_LIMIT.

    recovery_count = 0
    accumulated_content = content
    accumulated_tool_calls = list(tool_calls)

    while (
        response.stop_reason == "max_tokens"
        and recovery_count < MAX_OUTPUT_TOKENS_RECOVERY_LIMIT
    ):
        recovery_count += 1
        logger.info(
            "[anthropic-sdk] max_tokens recovery attempt %d/%d",
            recovery_count, MAX_OUTPUT_TOKENS_RECOVERY_LIMIT,
        )

        # Build continuation: original messages + partial assistant + recovery
        assistant_blocks = _response_to_assistant_message(content, tool_calls)
        continuation_messages = list(patched_messages)
        if assistant_blocks:
            continuation_messages.append({
                "role": "assistant",
                "content": assistant_blocks,
            })
        continuation_messages.append({
            "role": "user",
            "content": _RECOVERY_MESSAGE,
        })

        request_kwargs["messages"] = continuation_messages
        request_kwargs["max_tokens"] = max_tokens

        response = client.messages.create(**request_kwargs)
        content, tool_calls = _extract_response(response)

        # Accumulate: append new content and tool_calls
        if content:
            accumulated_content += content
        accumulated_tool_calls.extend(tool_calls)

    if recovery_count > 0 and response.stop_reason == "max_tokens":
        logger.warning(
            "[anthropic-sdk] Recovery exhausted after %d attempts, "
            "response may still be truncated",
            recovery_count,
        )

    # Use accumulated values if recovery was attempted
    if recovery_count > 0:
        content = accumulated_content
        tool_calls = accumulated_tool_calls

    # Build the final result
    result: dict[str, Any] = {
        "role": "assistant",
        "content": content or None,
    }
    if tool_calls:
        result["tool_calls"] = tool_calls
        result["content"] = content or ""

    return result


def patch_for_anthropic(llm_client: Any) -> None:
    """Patch a DaprChatClient to use Anthropic SDK for Anthropic components.

    Since DaprChatClient is a Pydantic model (can't set arbitrary attributes),
    we patch the class method instead of the instance.
    """
    from dapr_agents.llm.dapr.chat import DaprChatClient

    # Only patch once
    if getattr(DaprChatClient, "_anthropic_patched", False):
        return

    original_generate = DaprChatClient.generate

    def patched_generate(self: Any, *args: Any, **kwargs: Any) -> Any:
        component = getattr(self, "_llm_component", None)
        logger.info("[anthropic-sdk] generate called, component=%s, has_tools=%s, has_messages=%s",
                     component, bool(kwargs.get("tools")), bool(kwargs.get("messages")))

        if component and _is_anthropic_component(component):
            from dapr_agents.types.message import LLMChatResponse, LLMChatCandidate, AssistantMessage

            prompt = args[0] if args else kwargs.get("prompt", "")
            raw_messages = kwargs.get("messages")
            tools = kwargs.get("tools")
            max_tokens = kwargs.get("max_tokens", CAPPED_DEFAULT_MAX_TOKENS)
            response_format = kwargs.get("response_format")

            messages = []
            if raw_messages and isinstance(raw_messages, list):
                for m in raw_messages:
                    if isinstance(m, dict):
                        role = m.get("role", "user")
                        content = m.get("content", "")
                        if role == "system":
                            continue
                        if role == "tool":
                            messages.append({
                                "role": "user",
                                "content": [{"type": "tool_result",
                                             "tool_use_id": m.get("tool_call_id", ""),
                                             "content": str(content)[:5000] if content else "ok"}]
                            })
                        elif role == "assistant" and m.get("tool_calls"):
                            content_blocks = []
                            if content and isinstance(content, str) and content.strip():
                                content_blocks.append({"type": "text", "text": content})
                            for call in m["tool_calls"]:
                                fn = call.get("function", {}) if isinstance(call, dict) else {}
                                content_blocks.append({
                                    "type": "tool_use",
                                    "id": call.get("id", "") if isinstance(call, dict) else "",
                                    "name": fn.get("name", ""),
                                    "input": json.loads(fn.get("arguments", "{}")) if isinstance(fn.get("arguments"), str) else fn.get("arguments", {}),
                                })
                            messages.append({"role": "assistant", "content": content_blocks})
                        else:
                            messages.append({"role": role, "content": content})
                    elif hasattr(m, "role"):
                        role = getattr(m, "role", "user")
                        content = getattr(m, "content", "")
                        if role == "system":
                            continue
                        if role == "tool":
                            messages.append({
                                "role": "user",
                                "content": [{"type": "tool_result",
                                             "tool_use_id": getattr(m, "tool_call_id", ""),
                                             "content": str(content)[:5000] if content else "ok"}]
                            })
                        else:
                            msg_dict = {"role": role, "content": content}
                            tc = getattr(m, "tool_calls", None)
                            if tc and role == "assistant":
                                content_blocks = []
                                if content:
                                    content_blocks.append({"type": "text", "text": content})
                                for call in tc:
                                    fn = call.get("function", {}) if isinstance(call, dict) else {}
                                    content_blocks.append({
                                        "type": "tool_use",
                                        "id": call.get("id", "") if isinstance(call, dict) else "",
                                        "name": fn.get("name", ""),
                                        "input": json.loads(fn.get("arguments", "{}")) if isinstance(fn.get("arguments"), str) else fn.get("arguments", {}),
                                    })
                                msg_dict["content"] = content_blocks
                            messages.append(msg_dict)
            elif isinstance(prompt, str) and prompt:
                messages = [{"role": "user", "content": prompt}]
            elif isinstance(prompt, list):
                messages = prompt

            # Merge consecutive same-role messages (Anthropic requires alternating roles)
            merged = []
            for msg in messages:
                if merged and merged[-1]["role"] == msg["role"]:
                    prev_content = merged[-1]["content"]
                    curr_content = msg["content"]
                    if isinstance(prev_content, str):
                        prev_content = [{"type": "text", "text": prev_content}]
                    elif not isinstance(prev_content, list):
                        prev_content = [prev_content]
                    if isinstance(curr_content, str):
                        curr_content = [{"type": "text", "text": curr_content}]
                    elif not isinstance(curr_content, list):
                        curr_content = [curr_content]
                    merged[-1]["content"] = prev_content + curr_content
                else:
                    merged.append(msg)
            messages = merged

            try:
                result = _call_anthropic_sdk(
                    component, messages, tools=tools, max_tokens=max_tokens
                )

                # If response_format is set (structured output), parse the
                # content as the requested Pydantic model and return it directly.
                if response_format is not None and result.get("content"):
                    import re as _re
                    content_text = str(result["content"])

                    parsed = None
                    try:
                        parsed = json.loads(content_text)
                    except (ValueError, json.JSONDecodeError):
                        match = _re.search(r'```(?:json)?\s*\n?(.*?)\n?```', content_text, _re.DOTALL)
                        if match:
                            try:
                                parsed = json.loads(match.group(1).strip())
                            except (ValueError, json.JSONDecodeError):
                                pass

                    if parsed is not None:
                        try:
                            return response_format.model_validate(parsed)
                        except Exception:
                            pass

                    try:
                        field_names = list(response_format.model_fields.keys())
                        if field_names:
                            return response_format(**{field_names[0]: content_text})
                    except Exception:
                        pass

                msg = AssistantMessage(
                    content=result.get("content", ""),
                    role="assistant",
                )
                if result.get("tool_calls"):
                    msg.tool_calls = result["tool_calls"]

                finish_reason = "tool_use" if result.get("tool_calls") else "end_turn"

                return LLMChatResponse(
                    results=[LLMChatCandidate(
                        message=msg,
                        finish_reason=finish_reason,
                    )],
                    metadata={
                        "provider": "anthropic-sdk",
                        "model": _get_anthropic_model(component),
                    },
                )
            except Exception as exc:
                logger.error("[anthropic-sdk] Direct call failed: %s", exc)
                raise

        return original_generate(self, *args, **kwargs)

    DaprChatClient.generate = patched_generate
    DaprChatClient._anthropic_patched = True
    logger.info("[anthropic-sdk] Patched DaprChatClient class for Anthropic direct SDK calls")

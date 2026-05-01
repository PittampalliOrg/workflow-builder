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

from src.instruction_bundle import SYSTEM_PROMPT_DYNAMIC_BOUNDARY

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

# Image tool_result compaction: keep only the last N image-bearing tool_results
# in the prompt. Older ones get replaced with a text placeholder that preserves
# the tool_use_id link but drops the base64 payload. Each Playwright screenshot
# is ~100–500KB base64 (>50k tokens); 16 of them can blow Anthropic's 1M-token
# prompt limit (observed on run rea90ZntWG3DdFKTnOOZO: 2,992,291 tokens → HTTP 400).
MAX_IMAGE_TOOL_RESULTS_IN_CONTEXT = int(
    os.environ.get("DAPR_AGENT_PY_MAX_IMAGE_TOOL_RESULTS", "3")
)

# Anthropic public-API ephemeral prompt caching needs a cached prefix of at
# least 1024 tokens (Opus/Sonnet) or 512 (Haiku). 4000 chars is a conservative
# proxy for ≥1024 tokens of typical English markdown — below this we send the
# system as a plain string and skip the breakpoint (caching would be a no-op).
SYSTEM_PROMPT_CACHE_THRESHOLD_CHARS = int(
    os.environ.get("DAPR_AGENT_PY_PROMPT_CACHE_THRESHOLD_CHARS", "4000")
)

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
    "llm-anthropic-opus": "claude-opus-4-7",
    "llm-anthropic-haiku": "claude-haiku-4-5-20251001",
}


def _is_anthropic_component(component: str) -> bool:
    """Check if a component name maps to an Anthropic model."""
    return component in COMPONENT_MODEL_MAP or "anthropic" in component.lower()


def _get_anthropic_model(component: str) -> str:
    """Get the Anthropic model ID for a component name."""
    return COMPONENT_MODEL_MAP.get(component, "claude-sonnet-4-6-20250414")


def _convert_tools_for_anthropic(tools: list[Any] | None) -> list[dict] | None:
    """Convert tools to Anthropic tool format.

    Accepts either AgentTool-like objects (the agent path: `tool.name`,
    `tool.description`, `tool.args_model.model_json_schema()`) or already-
    formatted Anthropic dicts (`{"name", "description"?, "input_schema",
    "strict"?}`). The grader-evaluate path passes dicts directly so the
    caller can supply a strict response schema without wrapping it in an
    AgentTool.
    """
    if not tools:
        return None

    anthropic_tools = []
    for tool in tools:
        if isinstance(tool, dict):
            name = tool.get("name")
            if not name:
                continue
            schema = tool.get("input_schema") or {"type": "object", "properties": {}}
            entry: dict = {
                "name": name,
                "description": tool.get("description") or name,
                "input_schema": schema,
            }
            if tool.get("strict") is True:
                entry["strict"] = True
            anthropic_tools.append(entry)
            continue

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

    if not anthropic_tools:
        return None
    # Deterministic order so the prompt-cache key over (system + tools) stays
    # stable across turns even when the upstream tool list shuffles (MCP
    # reconnects, hooks/plugins add or remove tools).
    anthropic_tools.sort(key=lambda t: t.get("name") or "")
    return anthropic_tools


def _build_system_param(system: Any) -> tuple[Any, dict[str, Any]]:
    """Convert a system kwarg into the Anthropic SDK shape and emit telemetry.

    When the static prefix (everything before SYSTEM_PROMPT_DYNAMIC_BOUNDARY)
    exceeds SYSTEM_PROMPT_CACHE_THRESHOLD_CHARS, returns a
    `list[TextBlockParam]` with `cache_control={"type":"ephemeral"}` on the
    static block. Below threshold (or no boundary), returns a plain string
    with the boundary stripped — caching would be a no-op anyway and a string
    has lower request overhead.

    Returns (system_param, telemetry_dict). The telemetry dict carries
    `prefix_chars`, `tail_chars`, `cache_eligible`, `cache_breakpoints`.
    """
    empty_tel = {
        "prefix_chars": 0,
        "tail_chars": 0,
        "cache_eligible": False,
        "cache_breakpoints": 0,
    }
    if system is None:
        return None, empty_tel
    if isinstance(system, list):
        # Caller pre-shaped — count breakpoints + characters for telemetry
        # but do not mutate.
        prefix_chars = sum(
            len(b.get("text", ""))
            for b in system
            if isinstance(b, dict) and b.get("cache_control")
        )
        tail_chars = sum(
            len(b.get("text", ""))
            for b in system
            if isinstance(b, dict) and not b.get("cache_control")
        )
        breakpoints = sum(
            1 for b in system if isinstance(b, dict) and b.get("cache_control")
        )
        return system, {
            "prefix_chars": prefix_chars,
            "tail_chars": tail_chars,
            "cache_eligible": prefix_chars >= SYSTEM_PROMPT_CACHE_THRESHOLD_CHARS,
            "cache_breakpoints": breakpoints,
        }
    if not isinstance(system, str) or not system.strip():
        return system if system else None, empty_tel

    if SYSTEM_PROMPT_DYNAMIC_BOUNDARY not in system:
        return system, {
            "prefix_chars": 0,
            "tail_chars": len(system),
            "cache_eligible": False,
            "cache_breakpoints": 0,
        }

    # Split on the FIRST boundary occurrence — bundle intent wins even if a
    # defensive merge double-stamped the sentinel further downstream.
    static_text, _, dynamic_text = system.partition(SYSTEM_PROMPT_DYNAMIC_BOUNDARY)
    static_text = static_text.strip()
    dynamic_text = dynamic_text.strip()

    if len(static_text) < SYSTEM_PROMPT_CACHE_THRESHOLD_CHARS:
        # Below threshold — strip the sentinel and forward as a single string.
        joined = (
            f"{static_text}\n\n{dynamic_text}".strip() if dynamic_text else static_text
        )
        return joined, {
            "prefix_chars": len(static_text),
            "tail_chars": len(dynamic_text),
            "cache_eligible": False,
            "cache_breakpoints": 0,
        }

    blocks: list[dict[str, Any]] = [
        {
            "type": "text",
            "text": static_text,
            "cache_control": {"type": "ephemeral"},
        }
    ]
    if dynamic_text:
        blocks.append({"type": "text", "text": dynamic_text})
    return blocks, {
        "prefix_chars": len(static_text),
        "tail_chars": len(dynamic_text),
        "cache_eligible": True,
        "cache_breakpoints": 1,
    }


def _contains_image_block(content: Any) -> bool:
    """True if any element in a content list looks like an Anthropic image block."""
    if not isinstance(content, list):
        return False
    return any(
        isinstance(b, dict) and b.get("type") == "image"
        for b in content
    )


def _strip_images_from_tool_result(
    tool_result_block: dict[str, Any],
    tool_use_id: str,
) -> dict[str, Any]:
    """Return a tool_result block with any image content replaced by a short
    text placeholder so the tool_use↔tool_result link stays intact but the
    base64 payload is dropped."""
    body = tool_result_block.get("content")
    if isinstance(body, list):
        new_blocks: list[dict[str, Any]] = []
        image_count = 0
        for b in body:
            if isinstance(b, dict) and b.get("type") == "image":
                image_count += 1
                continue
            new_blocks.append(b)
        if image_count:
            new_blocks.append({
                "type": "text",
                "text": f"[compacted: {image_count} screenshot(s) dropped from context to fit prompt budget]",
            })
        if not new_blocks:
            new_blocks.append({"type": "text", "text": "[compacted screenshot]"})
        return {
            **tool_result_block,
            "content": new_blocks,
        }
    return tool_result_block


def _compact_image_tool_results(
    messages: list[dict[str, Any]],
    *,
    keep_last: int,
) -> list[dict[str, Any]]:
    """Walk messages, find user-role tool_result blocks that embed image
    content, and keep only the last `keep_last` intact. Older image-bearing
    tool_results get their image blocks replaced by a placeholder.

    Idempotent + deterministic: pass same messages, get same result; no network
    calls, no state. Safe to run on every generate() call even inside Dapr
    workflow replays.
    """
    if keep_last < 0:
        return messages

    # First pass: identify indices of (message_idx, block_idx) for every
    # tool_result block that contains images.
    image_positions: list[tuple[int, int]] = []
    for mi, msg in enumerate(messages):
        role = msg.get("role") if isinstance(msg, dict) else None
        content = msg.get("content") if isinstance(msg, dict) else None
        if role != "user" or not isinstance(content, list):
            continue
        for bi, block in enumerate(content):
            if isinstance(block, dict) and block.get("type") == "tool_result":
                if _contains_image_block(block.get("content")):
                    image_positions.append((mi, bi))

    if len(image_positions) <= keep_last:
        return messages

    # Everything except the last `keep_last` gets compacted.
    to_compact = set(image_positions[:-keep_last]) if keep_last > 0 else set(image_positions)
    if not to_compact:
        return messages

    compacted_msgs: list[dict[str, Any]] = []
    for mi, msg in enumerate(messages):
        content = msg.get("content") if isinstance(msg, dict) else None
        if not isinstance(content, list):
            compacted_msgs.append(msg)
            continue
        new_content = []
        touched = False
        for bi, block in enumerate(content):
            if (mi, bi) in to_compact and isinstance(block, dict):
                new_content.append(
                    _strip_images_from_tool_result(block, block.get("tool_use_id", ""))
                )
                touched = True
            else:
                new_content.append(block)
        if touched:
            compacted_msgs.append({**msg, "content": new_content})
        else:
            compacted_msgs.append(msg)

    logger.info(
        "[anthropic-sdk] compacted %d old image tool_result(s); kept last %d",
        len(to_compact),
        min(keep_last, len(image_positions)),
    )

    # Surface the compaction in the session stream so the UI can annotate the
    # transcript with "N older screenshots collapsed" instead of silently
    # losing them. Best-effort; safe during replays because daemon-thread
    # publish is idempotent at the ingest layer via sourceEventId.
    try:
        from src.event_publisher import get_scoped_session, publish_session_event

        sid, iid = get_scoped_session()
        if sid:
            publish_session_event(
                sid,
                "agent.thread_images_compacted",
                {
                    "collapsed": len(to_compact),
                    "kept": min(keep_last, len(image_positions)),
                    "total_image_tool_results": len(image_positions),
                    "keep_last": keep_last,
                },
                instance_id=iid,
            )
    except Exception as exc:  # noqa: BLE001
        logger.debug("[session-event] thread_images_compacted emit failed: %s", exc)

    return compacted_msgs


def _content_to_text(content: Any) -> str:
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


def _normalize_messages_for_anthropic(
    prompt: Any,
    raw_messages: list[Any] | None,
) -> tuple[str | None, list[dict[str, Any]]]:
    system_parts: list[str] = []
    messages: list[dict[str, Any]] = []

    source: list[Any]
    if raw_messages and isinstance(raw_messages, list):
        source = raw_messages
    elif isinstance(prompt, list):
        source = prompt
    elif isinstance(prompt, str) and prompt:
        source = [{"role": "user", "content": prompt}]
    else:
        source = []

    for m in source:
        if isinstance(m, dict):
            role = m.get("role", "user")
            content = m.get("content", "")
            if role == "system":
                text = _content_to_text(content).strip()
                if text:
                    system_parts.append(text)
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
                text = _content_to_text(content).strip()
                if text:
                    system_parts.append(text)
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

    return "\n\n".join(system_parts) if system_parts else None, messages


def _extract_response(response: Any) -> tuple[str, list[dict], list[str]]:
    """Extract text content, tool_calls, and thinking blocks from a response."""
    content = ""
    tool_calls = []
    thinking_blocks: list[str] = []
    for block in response.content:
        if block.type == "text":
            content += block.text
        elif block.type == "thinking":
            # block.thinking is the thinking text; empty when display="omitted"
            t = getattr(block, "thinking", "") or ""
            if t:
                thinking_blocks.append(t)
        elif block.type == "tool_use":
            tool_calls.append({
                "id": block.id,
                "type": "function",
                "function": {
                    "name": block.name,
                    "arguments": json.dumps(block.input),
                },
            })
    return content, tool_calls, thinking_blocks


def _emit_thinking(thinking_blocks: list[str]) -> None:
    """Emit agent.thinking session events for each non-empty thinking block.
    Session id/instance id come from the contextvar set by main.py:call_llm.
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
        logger.debug("[anthropic-sdk] thinking emit failed: %s", exc)


def _model_supports_adaptive_thinking(model: str) -> bool:
    """Adaptive thinking is Opus 4.6+ only; Sonnet 4.6 supports it too but
    behavior differs slightly. Keep the whitelist narrow — opus-4-6 + opus-4-7."""
    return model.startswith("claude-opus-4-6") or model.startswith("claude-opus-4-7")


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


_STREAM_DELTAS_ENABLED = os.environ.get(
    "DAPR_AGENT_PY_STREAM_DELTAS", "true"
).strip().lower() in ("1", "true", "yes", "on")

# Coalescing thresholds for delta emission. Keep small so the UI stays lively
# but not so small that we flood the ingest endpoint. 80ms is short enough to
# look real-time, long enough to batch multiple tokens into one POST.
_DELTA_COALESCE_MS = int(os.environ.get("DAPR_AGENT_PY_DELTA_COALESCE_MS", "80"))
_DELTA_COALESCE_BYTES = int(
    os.environ.get("DAPR_AGENT_PY_DELTA_COALESCE_BYTES", "2048")
)


def _delta_event_type(delta_kind: str) -> str | None:
    if delta_kind == "text_delta":
        return "agent.message_delta"
    if delta_kind == "thinking_delta":
        return "agent.thinking_delta"
    if delta_kind == "input_json_delta":
        return "agent.tool_input_delta"
    return None


def _stream_final_message(client: Any, **request_kwargs: Any) -> Any:
    """Run a streaming messages request and return the final aggregated Message.

    Anthropic rejects non-streaming calls it estimates will exceed 10 minutes
    (400 "Streaming is required for operations that may take longer than 10
    minutes"). This helper uses `client.messages.stream(...)` and returns the
    final aggregated `Message`, which has the same shape as the response from
    `client.messages.create(...)`, so downstream extraction logic can stay
    unchanged. See https://github.com/anthropics/anthropic-sdk-python#long-requests.

    When DAPR_AGENT_PY_STREAM_DELTAS is on (default), this also publishes
    coalesced delta events into the session event stream so the UI can show
    partial assistant content as it arrives. Coalescing happens per
    (content_block_index, delta_kind) key; flushes on elapsed-ms /
    byte-size / ContentBlockStop whichever fires first.
    """
    import time

    try:
        from src.event_publisher import (
            get_scoped_session,
            publish_session_event,
        )
    except Exception:  # noqa: BLE001
        get_scoped_session = None  # type: ignore[assignment]
        publish_session_event = None  # type: ignore[assignment]

    sid: str | None = None
    iid: str | None = None
    deltas_on = _STREAM_DELTAS_ENABLED and publish_session_event is not None
    if deltas_on and get_scoped_session is not None:
        try:
            sid, iid = get_scoped_session()
        except Exception:  # noqa: BLE001
            sid, iid = None, None
        if not sid:
            deltas_on = False

    # Per content_block buffer: {idx: {"kind": str, "buf": str,
    #                                   "cumulative": int, "opened_at_ns": int,
    #                                   "tool_use_id": str | None}}
    buffers: dict[int, dict[str, Any]] = {}

    def flush_block(idx: int) -> None:
        entry = buffers.get(idx)
        if not entry or not entry.get("buf"):
            return
        ev_type = _delta_event_type(entry["kind"])
        if ev_type is None:
            entry["buf"] = ""
            return
        payload: dict[str, Any] = {
            "content_block_index": idx,
            "text": entry["buf"],
            "cumulative_len": entry["cumulative"],
        }
        if entry.get("tool_use_id"):
            payload["tool_use_id"] = entry["tool_use_id"]
            payload["partial_json"] = entry["buf"]
        try:
            publish_session_event(  # type: ignore[misc]
                sid,
                ev_type,
                payload,
                instance_id=iid,
            )
        except Exception as exc:  # noqa: BLE001
            logger.debug("[delta-emit] publish failed: %s", exc)
        entry["buf"] = ""

    def flush_all() -> None:
        for idx in list(buffers.keys()):
            flush_block(idx)

    with client.messages.stream(**request_kwargs) as stream:
        # Iterate typed events so we can fork deltas into the session stream.
        # We still have to fully drain before get_final_message(); the SDK's
        # internal aggregator needs the iterator consumed.
        for event in stream:
            if not deltas_on:
                continue
            etype = getattr(event, "type", None)
            if etype == "content_block_start":
                idx = int(getattr(event, "index", 0) or 0)
                block = getattr(event, "content_block", None)
                block_type = getattr(block, "type", None)
                tool_use_id = (
                    getattr(block, "id", None)
                    if block_type == "tool_use"
                    else None
                )
                # Pre-seed the buffer with empty state; the kind is set when
                # the first delta lands (text_delta / thinking_delta / etc.).
                buffers[idx] = {
                    "kind": "",
                    "buf": "",
                    "cumulative": 0,
                    "opened_at_ns": time.monotonic_ns(),
                    "tool_use_id": tool_use_id,
                }
            elif etype == "content_block_delta":
                idx = int(getattr(event, "index", 0) or 0)
                delta = getattr(event, "delta", None)
                delta_kind = getattr(delta, "type", None)
                if not delta_kind:
                    continue
                text_chunk = (
                    getattr(delta, "text", None)
                    or getattr(delta, "thinking", None)
                    or getattr(delta, "partial_json", None)
                    or ""
                )
                if not text_chunk:
                    continue
                entry = buffers.setdefault(
                    idx,
                    {
                        "kind": delta_kind,
                        "buf": "",
                        "cumulative": 0,
                        "opened_at_ns": time.monotonic_ns(),
                        "tool_use_id": None,
                    },
                )
                if not entry["kind"]:
                    entry["kind"] = delta_kind
                entry["buf"] += text_chunk
                entry["cumulative"] += len(text_chunk)
                # Flush on size threshold.
                if len(entry["buf"].encode("utf-8", "ignore")) >= _DELTA_COALESCE_BYTES:
                    flush_block(idx)
                    entry["opened_at_ns"] = time.monotonic_ns()
                    continue
                # Flush on time threshold.
                age_ms = (time.monotonic_ns() - entry["opened_at_ns"]) / 1_000_000
                if age_ms >= _DELTA_COALESCE_MS:
                    flush_block(idx)
                    entry["opened_at_ns"] = time.monotonic_ns()
            elif etype == "content_block_stop":
                idx = int(getattr(event, "index", 0) or 0)
                flush_block(idx)
        # Final safety flush before requesting the aggregated message.
        if deltas_on:
            flush_all()
        return stream.get_final_message()


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
    api_key = os.environ.get("ANTHROPIC_API_KEY")
    if not api_key:
        raise RuntimeError("No Anthropic authentication configured. Set ANTHROPIC_API_KEY.")
    import anthropic

    # max_retries enables SDK-internal retry for 5xx, 429, and transient
    # connection errors (via httpx). Short sidecar-churn blips get absorbed
    # inside the activity body so Dapr's activity-level retry never has to
    # fire. See also the WorkflowRetryPolicy tuning in main.py that covers
    # the longer pod-death window.
    client = anthropic.Anthropic(
        api_key=api_key,
        max_retries=4,
    )
    model = _get_anthropic_model(component)
    anthropic_tools = _convert_tools_for_anthropic(tools)
    if anthropic_tools:
        # Cache breakpoint on the last tool — when system + tools are stable
        # turn-to-turn, breakpoint A (static system) hits even if the tool
        # tail churns; this breakpoint B then hits when tools are stable too.
        anthropic_tools[-1] = {
            **anthropic_tools[-1],
            "cache_control": {"type": "ephemeral"},
        }

    # Build the cache-aware system param. The bundle's rendered.system carries
    # the boundary sentinel between static prefix and dynamic tail; above the
    # threshold we split into a list[TextBlockParam] with cache_control on the
    # static block, otherwise we forward as a plain (boundary-stripped) string.
    system_param, prompt_cache_telemetry = _build_system_param(kwargs.get("system"))

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

    # claude_code.llm_request span — wraps the whole call including
    # SDK-internal retries, escalation, and multi-turn recovery. Token
    # counts are summed across retries at end_llm_request_span. Matches
    # TS behavior where endLLMRequestSpan reports aggregate usage.
    llm_span = None
    agg_input_tokens = 0
    agg_output_tokens = 0
    agg_cache_read = 0
    agg_cache_create = 0
    llm_start_monotonic = 0.0
    ttft_ms_recorded: float | None = None
    try:
        import time as _time

        from src.telemetry import start_llm_request_span

        llm_span = start_llm_request_span(
            model,
            fast_mode=False,
            query_source="dapr_agent_py.anthropic_adapter",
            system_prompt=kwargs.get("system") if isinstance(kwargs.get("system"), str) else None,
            tools_json=json.dumps(anthropic_tools) if anthropic_tools else None,
            messages_for_api=list(patched_messages),
        )
        llm_start_monotonic = _time.monotonic()
    except Exception as exc:  # noqa: BLE001
        logger.warning("[telemetry] llm_request start failed: %s", exc)

    # -- Attempt 1: initial request at current max_tokens -----------------

    request_kwargs: dict[str, Any] = {
        "model": model,
        "max_tokens": max_tokens,
        "messages": patched_messages,
    }
    if anthropic_tools:
        request_kwargs["tools"] = anthropic_tools
    # Forward optional pass-through kwargs to the SDK. `system` and
    # `tool_choice` are accepted by `messages.create`/`messages.stream`
    # directly. `tool_choice={"type":"tool","name":"emit_evaluation"}` is the
    # forced-tool path used by the score_model labeler grader to guarantee a
    # JSON-shaped response (see /api/grader-evaluate).
    if system_param is not None and system_param != "":
        request_kwargs["system"] = system_param
    forced_tool_choice = (
        isinstance(kwargs.get("tool_choice"), dict)
        and kwargs["tool_choice"].get("type") == "tool"
    )
    if kwargs.get("tool_choice") is not None:
        request_kwargs["tool_choice"] = kwargs["tool_choice"]
    # Enable adaptive thinking on Opus 4.6/4.7. `display: "summarized"` opts
    # into receiving thinking text (Opus 4.7 omits by default) so we can
    # stream it into session_events as agent.thinking. Note: sampling params
    # (temperature, top_p, top_k) must NOT be set on Opus 4.7 when thinking
    # is enabled — this adapter doesn't set them, so we're safe.
    # Anthropic also rejects thinking + tool_choice={type:"tool"} (forced
    # single-tool selection); suppress thinking in that case.
    if _model_supports_adaptive_thinking(model) and not forced_tool_choice:
        request_kwargs["thinking"] = {"type": "adaptive", "display": "summarized"}

    logger.info(
        "[anthropic-sdk] Calling %s with %d messages, %d tools, max_tokens=%d",
        model, len(patched_messages), len(anthropic_tools or []), max_tokens,
    )
    # Greppable per-turn line so production logs surface whether the cache
    # path actually fired and how big each half of the prompt was.
    logger.info(
        "[instruction-bundle] mode=%s breakpoints=%d prefix_chars=%d tail_chars=%d",
        "sectioned" if prompt_cache_telemetry["cache_eligible"] else "legacy",
        prompt_cache_telemetry["cache_breakpoints"]
        + (1 if anthropic_tools else 0),
        prompt_cache_telemetry["prefix_chars"],
        prompt_cache_telemetry["tail_chars"],
    )
    # Stamp prompt-cache attributes on the active llm_request span so Phoenix
    # / Jaeger surface them alongside cache_creation/cache_read tokens.
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
                + (1 if anthropic_tools else 0),
            )
            if anthropic_tools:
                # Hash of sorted tool names — flips when MCP servers reconnect or
                # plugins add/remove tools, which is the silent invalidator of
                # the cache hit.
                import hashlib as _hashlib

                tools_hash = _hashlib.sha1(
                    ",".join(t.get("name") or "" for t in anthropic_tools).encode(
                        "utf-8"
                    )
                ).hexdigest()
                llm_span.set_attribute("prompt.tools_hash", tools_hash)
                llm_span.set_attribute("prompt.tools_count", len(anthropic_tools))
        except Exception as exc:  # noqa: BLE001
            logger.debug("[telemetry] prompt-cache attrs set failed: %s", exc)

    try:
        response = _stream_final_message(client, **request_kwargs)
        content, tool_calls, thinking_blocks = _extract_response(response)
        _emit_thinking(thinking_blocks)
        if ttft_ms_recorded is None and llm_span is not None:
            import time as _time

            ttft_ms_recorded = (_time.monotonic() - llm_start_monotonic) * 1000.0
        _u = getattr(response, "usage", None)
        if _u is not None:
            agg_input_tokens += int(getattr(_u, "input_tokens", 0) or 0)
            agg_output_tokens += int(getattr(_u, "output_tokens", 0) or 0)
            agg_cache_read += int(getattr(_u, "cache_read_input_tokens", 0) or 0)
            agg_cache_create += int(getattr(_u, "cache_creation_input_tokens", 0) or 0)
    except Exception as exc:
        if llm_span is not None:
            try:
                from src.telemetry import end_llm_request_span

                end_llm_request_span(
                    llm_span,
                    input_tokens=agg_input_tokens or None,
                    output_tokens=agg_output_tokens or None,
                    cache_read_tokens=agg_cache_read or None,
                    cache_creation_tokens=agg_cache_create or None,
                    success=False,
                    error=str(exc)[:500],
                )
            except Exception:
                pass
        # Emit a usage event even on failure so the UI can show the caller
        # consumed tokens before the error. recovery_count is not yet defined
        # here (failure occurred in Attempt 1); use 0.
        try:
            from src.event_publisher import (
                get_scoped_session,
                get_scoped_audit_fields,
                publish_session_event,
            )

            sid, iid = get_scoped_session()
            if sid:
                publish_session_event(
                    sid,
                    "agent.llm_usage",
                    {
                        "model": model,
                        **get_scoped_audit_fields(),
                        "input_tokens": agg_input_tokens,
                        "output_tokens": agg_output_tokens,
                        "cache_read_input_tokens": agg_cache_read,
                        "cache_creation_input_tokens": agg_cache_create,
                        "ttft_ms": ttft_ms_recorded,
                        "recovery_attempts": 0,
                        "success": False,
                        "error": str(exc)[:200],
                    },
                    instance_id=iid,
                )
        except Exception as pub_exc:  # noqa: BLE001
            logger.debug("[session-event] llm_usage failure emit failed: %s", pub_exc)
        raise

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
        response = _stream_final_message(client, **request_kwargs)
        content, tool_calls, thinking_blocks = _extract_response(response)
        _emit_thinking(thinking_blocks)
        _u = getattr(response, "usage", None)
        if _u is not None:
            agg_input_tokens += int(getattr(_u, "input_tokens", 0) or 0)
            agg_output_tokens += int(getattr(_u, "output_tokens", 0) or 0)
            agg_cache_read += int(getattr(_u, "cache_read_input_tokens", 0) or 0)
            agg_cache_create += int(getattr(_u, "cache_creation_input_tokens", 0) or 0)
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

        response = _stream_final_message(client, **request_kwargs)
        content, tool_calls, thinking_blocks = _extract_response(response)
        _emit_thinking(thinking_blocks)
        _u = getattr(response, "usage", None)
        if _u is not None:
            agg_input_tokens += int(getattr(_u, "input_tokens", 0) or 0)
            agg_output_tokens += int(getattr(_u, "output_tokens", 0) or 0)
            agg_cache_read += int(getattr(_u, "cache_read_input_tokens", 0) or 0)
            agg_cache_create += int(getattr(_u, "cache_creation_input_tokens", 0) or 0)

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

    # End claude_code.llm_request span + record token/cost metrics.
    if llm_span is not None:
        try:
            from src.telemetry import (
                end_llm_request_span,
                record_cost,
                record_tokens,
            )

            end_llm_request_span(
                llm_span,
                input_tokens=agg_input_tokens or None,
                output_tokens=agg_output_tokens or None,
                cache_read_tokens=agg_cache_read or None,
                cache_creation_tokens=agg_cache_create or None,
                success=True,
                has_tool_call=bool(tool_calls),
                ttft_ms=ttft_ms_recorded,
                model_output=content or None,
            )
            record_tokens(type_="input", count=agg_input_tokens, model=model)
            record_tokens(type_="output", count=agg_output_tokens, model=model)
            record_tokens(type_="cacheRead", count=agg_cache_read, model=model)
            record_tokens(type_="cacheCreation", count=agg_cache_create, model=model)
            # Cost estimate left to caller — adapter doesn't own pricing.
            _ = record_cost  # suppress unused until pricing lands
        except Exception as exc:  # noqa: BLE001
            logger.warning("[telemetry] llm_request end failed: %s", exc)

    # Mirror usage metrics onto the session event stream so the UI can show
    # prompt-cache efficiency per turn without cross-referencing Phoenix.
    try:
        from src.event_publisher import get_scoped_session, publish_session_event
        from src.event_publisher import get_scoped_audit_fields

        sid, iid = get_scoped_session()
        if sid:
            publish_session_event(
                sid,
                "agent.llm_usage",
                {
                    "model": model,
                    **get_scoped_audit_fields(),
                    "input_tokens": agg_input_tokens,
                    "output_tokens": agg_output_tokens,
                    "cache_read_input_tokens": agg_cache_read,
                    "cache_creation_input_tokens": agg_cache_create,
                    "ttft_ms": ttft_ms_recorded,
                    "recovery_attempts": recovery_count,
                    "success": True,
                    "prompt_prefix_chars": prompt_cache_telemetry["prefix_chars"],
                    "prompt_tail_chars": prompt_cache_telemetry["tail_chars"],
                    "prompt_cache_eligible": prompt_cache_telemetry["cache_eligible"],
                    "prompt_cache_breakpoints": prompt_cache_telemetry[
                        "cache_breakpoints"
                    ]
                    + (1 if anthropic_tools else 0),
                },
                instance_id=iid,
            )
    except Exception as exc:  # noqa: BLE001
        logger.debug("[session-event] llm_usage emit failed: %s", exc)

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

            system_prompt, messages = _normalize_messages_for_anthropic(
                prompt,
                raw_messages if isinstance(raw_messages, list) else None,
            )
            explicit_system = kwargs.get("system")
            if isinstance(explicit_system, str) and explicit_system.strip():
                system_prompt = (
                    explicit_system.strip()
                    if not system_prompt
                    else explicit_system.strip() + "\n\n" + system_prompt
                )

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

            # Image-compaction: Playwright screenshot tool_results accumulate
            # ~100-500KB base64 per image; 16 of them can blow Anthropic's 1M
            # token prompt cap (observed on run rea90ZntWG3DdFKTnOOZO —
            # 2.99M tokens HTTP 400). Keep only the most-recent
            # MAX_IMAGE_TOOL_RESULTS_IN_CONTEXT images; replace older image
            # blocks inside tool_result content with a short placeholder that
            # preserves the tool_use_id association so the model sees a valid
            # structured response, just without the pixel payload.
            messages = _compact_image_tool_results(
                messages,
                keep_last=MAX_IMAGE_TOOL_RESULTS_IN_CONTEXT,
            )

            try:
                result = _call_anthropic_sdk(
                    component,
                    messages,
                    tools=tools,
                    max_tokens=max_tokens,
                    system=system_prompt,
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

"""Compaction engine — the body that runs inline inside call_llm.

Designed to be **called synchronously from the existing `call_llm`
activity override in OpenShellDurableAgent**. No new Dapr activity is
registered; no extra `yield` is added to the orchestrator body. This
keeps workflow history growth identical to today.

Durability semantics (verified against Dapr Python Durable Task docs):
  - The activity body IS the durability unit. Dapr retries the activity
    from the top on transient failure.
  - We engineer retry-idempotency by scanning existing `entry.messages`
    for a __COMPACT_BOUNDARY__ sentinel whose `turn_index` matches the
    current turn; if found, we short-circuit and return the cached
    result without a second LLM call or state write.
  - State is written once via `agent.save_state(instance_id, entry=entry)`
    using the same ETag-protected path as the base call_llm.
"""
from __future__ import annotations

import json
import logging
import os
import time
from dataclasses import dataclass, asdict
from datetime import datetime, timezone
from typing import Any, Callable, Optional

from .config import CompactionConfig
from .microcompact import microcompact_messages
from .pairing import select_preserved_tail
from .prompts import format_compact_summary, get_compact_prompt
from .tokens import (
    count_tokens,
    get_auto_compact_threshold,
    heuristic_token_count,
)

logger = logging.getLogger(__name__)


_BOUNDARY_SENTINEL = "__COMPACT_BOUNDARY__ "
_SUMMARY_OPEN = "<compact_summary>"
_SUMMARY_CLOSE = "</compact_summary>"
_PLAN_ATTACHMENT_PREFIX = "[plan-reattach]"
_SKILLS_ATTACHMENT_PREFIX = "[skills-reattach]"
_MCP_ATTACHMENT_PREFIX = "[mcp-tools-reattach]"

# Ported from claude-code-src/main/services/compact/compact.ts:243
# (truncateHeadForPTLRetry). 3 retries matches MAX_RETRY_COUNT there.
_PTL_MAX_RETRIES = 3


@dataclass
class CompactionResult:
    compacted: bool
    pre_count: int = 0
    post_count: int = 0
    messages_dropped: int = 0
    messages_preserved: int = 0
    ptl_retries: int = 0
    trigger: str = "auto"
    reason: str = ""
    summary_preview: str = ""

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


# ---------------------------------------------------------------------------
# Helpers to read/write messages on the AgentWorkflowEntry (duck-typed: the
# engine does not import upstream Pydantic classes directly so tests can pass
# in lightweight fakes).
# ---------------------------------------------------------------------------


def _msg_role(m: Any) -> str:
    if isinstance(m, dict):
        return str(m.get("role") or "")
    return str(getattr(m, "role", "") or "")


def _msg_content(m: Any) -> Any:
    if isinstance(m, dict):
        return m.get("content")
    return getattr(m, "content", None)


def _find_latest_boundary_metadata(messages: list[Any]) -> Optional[dict[str, Any]]:
    """Scan from the end for the most recent compact boundary marker and return
    its parsed JSON metadata. Returns None if no boundary is present."""
    for m in reversed(messages):
        if _msg_role(m) != "system":
            continue
        content = _msg_content(m)
        if not isinstance(content, str) or not content.startswith(_BOUNDARY_SENTINEL):
            continue
        raw = content[len(_BOUNDARY_SENTINEL):]
        try:
            return json.loads(raw)
        except json.JSONDecodeError:
            return None
    return None


def _make_message(agent: Any, *, role: str, content: str) -> Any:
    """Construct an AgentWorkflowMessage-compatible object.

    We try to import the upstream schema; if that fails (tests running
    without dapr-agents installed) we fall back to a plain dict that the
    rest of the pipeline can still handle.
    """
    try:
        from dapr_agents.agents.schemas import AgentWorkflowMessage

        return AgentWorkflowMessage(role=role, content=content)
    except Exception:
        return {"role": role, "content": content}


def _build_boundary_marker(
    agent: Any,
    *,
    metadata: dict[str, Any],
) -> Any:
    return _make_message(
        agent,
        role="system",
        content=_BOUNDARY_SENTINEL + json.dumps(metadata, separators=(",", ":")),
    )


def _build_summary_message(agent: Any, *, summary: str) -> Any:
    body = f"{_SUMMARY_OPEN}\n{summary}\n{_SUMMARY_CLOSE}"
    return _make_message(agent, role="user", content=body)


def _render_transcript(messages: list[Any]) -> str:
    """Render messages as a plain-text transcript for the summarization LLM."""
    lines: list[str] = []
    for m in messages:
        role = _msg_role(m)
        content = _msg_content(m)
        if isinstance(content, str):
            text = content
        elif isinstance(content, list):
            parts: list[str] = []
            for block in content:
                if isinstance(block, dict):
                    if block.get("type") == "text":
                        parts.append(str(block.get("text") or ""))
                    elif block.get("type") == "tool_use":
                        parts.append(
                            f"[tool_use {block.get('name','')}({json.dumps(block.get('input') or {}, default=str)[:500]})]"
                        )
                    elif block.get("type") == "tool_result":
                        inner = block.get("content")
                        if isinstance(inner, str):
                            parts.append(inner)
                        elif isinstance(inner, list):
                            for ib in inner:
                                if isinstance(ib, dict) and ib.get("type") == "text":
                                    parts.append(str(ib.get("text") or ""))
            text = "\n".join(parts)
        else:
            text = str(content or "")
        if not text.strip():
            continue
        lines.append(f"[{role}] {text}")
    return "\n\n".join(lines)


# ---------------------------------------------------------------------------
# Summarization LLM call (abstracted behind a caller so tests can mock it)
# ---------------------------------------------------------------------------


AnthropicCaller = Callable[..., dict[str, Any]]


def _call_summary_llm(
    *,
    component: str,
    messages: list[dict[str, Any]],
    max_tokens: int,
    caller: AnthropicCaller,
) -> str:
    """Invoke the Anthropic SDK (via caller) and return the raw summary text.

    The caller is typically `src.anthropic_adapter._call_anthropic_sdk`,
    which already implements the output-token escalation path. The
    summarization prompt sits in a SYSTEM-role message of `messages`.
    """
    result = caller(
        component,
        messages,
        tools=None,
        max_tokens=max_tokens,
    )
    content = result.get("content") if isinstance(result, dict) else None
    if not isinstance(content, str):
        content = "" if content is None else str(content)
    return content


def _ptl_trim_head(transcript_messages: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Drop the oldest group (assistant + its matched tool results) to shrink
    the prompt for PTL retry. Mirrors truncateHeadForPTLRetry in compact.ts.

    We work on the already-flattened [user, assistant_prompt] payload where
    the transcript sits inside the user message content. This is a simple
    head-trim: drop the first assistant/tool chunk from the transcript
    text. In practice we just drop the first 20% of the rendered transcript.
    """
    if not transcript_messages:
        return transcript_messages
    # The transcript is carried as the last "user" message's content. Trim
    # that content by 25% from the head.
    out = list(transcript_messages)
    if out and out[-1].get("role") == "user" and isinstance(out[-1].get("content"), str):
        text = out[-1]["content"]
        cut = len(text) // 4
        out[-1] = {
            **out[-1],
            "content": "[...earlier transcript trimmed for PTL retry...]\n\n" + text[cut:],
        }
    return out


# ---------------------------------------------------------------------------
# Post-compact attachments (PLAN, skills, MCP tools)
# ---------------------------------------------------------------------------


def _post_compact_attachments(
    agent: Any,
    *,
    instance_id: str,
    runtime: Any,
) -> tuple[list[Any], list[str]]:
    """Return (attachment_messages, preview_tags) for post-compact re-injection.

    Tags are short labels shipped in the PostCompact hook payload so
    plugins can see what was restored.
    """
    attachments: list[Any] = []
    tags: list[str] = []

    # 1. PLAN.md
    try:
        if runtime is not None:
            plan_path = runtime.resolve_path("PLAN.md")
            plan_result = runtime.read_text(plan_path)
            if plan_result.get("ok") and plan_result.get("content"):
                plan_content = str(plan_result["content"])
                attachments.append(
                    _make_message(
                        agent,
                        role="user",
                        content=f"{_PLAN_ATTACHMENT_PREFIX}\nA plan file exists at PLAN.md.\n\nPlan contents:\n\n{plan_content}",
                    )
                )
                tags.append("plan")
    except Exception as exc:  # noqa: BLE001
        logger.debug("[compaction] PLAN.md attachment skipped: %s", exc)

    # 2. Skills
    try:
        skills = getattr(agent, "_skills_by_instance", {}).get(instance_id) or []
        if skills:
            names = [getattr(s, "name", None) or (s.get("name") if isinstance(s, dict) else None) for s in skills]
            names = [n for n in names if n]
            if names:
                attachments.append(
                    _make_message(
                        agent,
                        role="user",
                        content=f"{_SKILLS_ATTACHMENT_PREFIX} Available skills: {', '.join(names)}",
                    )
                )
                tags.append(f"skills:{len(names)}")
    except Exception as exc:  # noqa: BLE001
        logger.debug("[compaction] skills attachment skipped: %s", exc)

    # 3. MCP tools
    try:
        mcp_tools = getattr(agent, "_mcp_tools_by_instance", {}).get(instance_id) or {}
        if mcp_tools:
            names = sorted(mcp_tools.keys())
            attachments.append(
                _make_message(
                    agent,
                    role="user",
                    content=f"{_MCP_ATTACHMENT_PREFIX} Registered MCP tools: {', '.join(names)}",
                )
            )
            tags.append(f"mcp:{len(names)}")
    except Exception as exc:  # noqa: BLE001
        logger.debug("[compaction] MCP attachment skipped: %s", exc)

    return attachments, tags


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------


def maybe_compact(
    agent: Any,
    *,
    instance_id: str,
    execution_id: str,
    config: CompactionConfig,
    model: str | None,
    component: str | None,
    caller: AnthropicCaller,
    turn_index: int = 0,
    runtime: Any = None,
    anthropic_client: Any = None,
) -> CompactionResult:
    """Decide and (if needed) run compaction. Idempotent on retry.

    This function is invoked synchronously from OpenShellDurableAgent.call_llm
    (the activity body) BEFORE delegating to super().call_llm. If compaction
    runs, the state is rewritten and super().call_llm will reload the
    compacted state.

    Returns a CompactionResult describing what happened; callers should
    use `compacted` + `reason` for branching, never mutate the result.
    """
    if not config.enabled:
        return CompactionResult(compacted=False, reason="disabled")

    # Lazy import so tests that don't install event_publisher can still run.
    from ..event_publisher import (
        publish_compaction_complete,
        publish_compaction_start,
    )

    # 1. Load state (the activity is the durability unit — load is fine here)
    entry = agent._infra.get_state(instance_id)
    messages = list(getattr(entry, "messages", []) or [])

    # 2. Retry-idempotency guard: has a boundary already been written for
    # the current len(messages)? We embed message_count in the marker so
    # replay safety is tied to durable state (not a fragile in-memory
    # counter that gets reset on orchestrator replay-finally).
    existing = _find_latest_boundary_metadata(messages)
    if existing and int(existing.get("message_count_at_save", -1)) == len(messages):
        logger.info(
            "[compaction] idempotency hit for instance=%s len(messages)=%d — returning cached result",
            instance_id,
            len(messages),
        )
        return CompactionResult(
            compacted=True,
            pre_count=int(existing.get("pre_count") or 0),
            post_count=int(existing.get("post_count") or 0),
            messages_dropped=int(existing.get("messages_dropped") or 0),
            messages_preserved=int(existing.get("messages_preserved") or 0),
            trigger=str(existing.get("trigger") or "auto"),
            reason="idempotent_replay",
        )

    # 3. Count tokens
    pre_count = count_tokens(
        messages,
        model=model,
        anthropic_client=anthropic_client,
    )

    if not config.auto_compact_enabled:
        return CompactionResult(
            compacted=False, pre_count=pre_count, reason="auto_compact_disabled"
        )

    threshold = get_auto_compact_threshold(
        model,
        window_override=config.auto_compact_window,
        summary_reserve=config.summary_reserve,
        buffer_tokens=config.buffer_tokens,
    )
    if pre_count < threshold:
        return CompactionResult(
            compacted=False, pre_count=pre_count, reason="below_threshold"
        )

    # 4. Emit start event
    try:
        publish_compaction_start(
            execution_id=execution_id,
            instance_id=instance_id,
            pre_count=pre_count,
            threshold=threshold,
            trigger="auto",
        )
    except Exception:
        pass

    # 5. PreCompact hook
    custom_instructions = config.custom_instructions
    try:
        from ..hooks import (
            execute_pre_compact_hooks,
            hooks_enabled,
        )
        from ..plugins.integration import current_snapshot as _current_hook_snapshot

        if hooks_enabled():
            snap = _current_hook_snapshot(agent, instance_id)
            cwd_for_hooks = getattr(agent, "_cwd_by_instance", {}).get(instance_id, "") or ""
            project_dir = cwd_for_hooks or os.environ.get("CLAUDE_PROJECT_DIR") or os.getcwd()
            pre_agg = execute_pre_compact_hooks(
                snap,
                trigger="auto",
                custom_instructions=custom_instructions,
                session_id=instance_id,
                cwd=cwd_for_hooks,
                project_dir=project_dir,
                pre_count=pre_count,
                message_count=len(messages),
            )
            if pre_agg.any_block():
                reason = pre_agg.blocking_reason or pre_agg.decision_reason or "blocked"
                try:
                    publish_compaction_complete(
                        execution_id=execution_id,
                        instance_id=instance_id,
                        pre_count=pre_count,
                        post_count=pre_count,
                        messages_dropped=0,
                        messages_preserved=len(messages),
                        trigger="auto",
                        reason=f"pre_compact_blocked:{reason}",
                        success=False,
                    )
                except Exception:
                    pass
                return CompactionResult(
                    compacted=False,
                    pre_count=pre_count,
                    reason=f"pre_compact_blocked:{reason}",
                )
            # A hook may have supplied additional instructions.
            if pre_agg.additional_contexts:
                extra = "\n\n".join(pre_agg.additional_contexts)
                custom_instructions = (
                    (custom_instructions + "\n\n" + extra) if custom_instructions else extra
                )
    except Exception as exc:  # noqa: BLE001
        logger.warning("[compaction] PreCompact hook error: %s", exc)

    # 6. Microcompact pass (trims large tool results)
    trimmed_messages, _saved_chars = microcompact_messages(messages)

    # 7. Pairing-safe tail
    tail = select_preserved_tail(trimmed_messages, config.preserve_last_n)

    # 8. Build summary LLM request
    system_prompt = get_compact_prompt(custom_instructions)
    transcript = _render_transcript(trimmed_messages)
    # The LLM receives: [system-framing-via-user-message, user-transcript]. We
    # package the framing as a user message because our adapter strips system
    # messages and the framing lives naturally at the top of the user turn.
    base_payload: list[dict[str, Any]] = [
        {
            "role": "user",
            "content": system_prompt + "\n\n----- CONVERSATION TRANSCRIPT -----\n\n" + transcript,
        },
    ]

    # 9. Summary LLM call with PTL retry (compact.ts:truncateHeadForPTLRetry)
    component_for_summary = component or "llm-anthropic-sonnet"
    raw_summary = ""
    ptl_retries = 0
    last_exc: Exception | None = None
    payload = base_payload
    for attempt in range(_PTL_MAX_RETRIES + 1):
        try:
            raw_summary = _call_summary_llm(
                component=component_for_summary,
                messages=payload,
                max_tokens=config.max_output_tokens,
                caller=caller,
            )
            last_exc = None
            break
        except Exception as exc:  # noqa: BLE001
            last_exc = exc
            msg = str(exc).lower()
            # Anthropic "input too long" signal — try trimming and retrying.
            if "prompt is too long" in msg or "too many tokens" in msg:
                ptl_retries += 1
                payload = _ptl_trim_head(payload)
                logger.info(
                    "[compaction] PTL retry %d/%d after input overflow",
                    ptl_retries,
                    _PTL_MAX_RETRIES,
                )
                continue
            raise

    if last_exc is not None:
        # PTL retries exhausted. Surface failure cleanly.
        try:
            publish_compaction_complete(
                execution_id=execution_id,
                instance_id=instance_id,
                pre_count=pre_count,
                post_count=pre_count,
                messages_dropped=0,
                messages_preserved=len(messages),
                ptl_retries=ptl_retries,
                trigger="auto",
                reason="ptl_retries_exhausted",
                success=False,
                error=str(last_exc)[:500],
            )
        except Exception:
            pass
        return CompactionResult(
            compacted=False,
            pre_count=pre_count,
            ptl_retries=ptl_retries,
            reason="ptl_retries_exhausted",
        )

    # 10. Parse summary
    summary_text = format_compact_summary(raw_summary) or raw_summary.strip()
    if not summary_text:
        return CompactionResult(
            compacted=False, pre_count=pre_count, reason="empty_summary"
        )

    # 11. Build new messages: [boundary, summary, *tail, *attachments]
    attachments, attachment_tags = _post_compact_attachments(
        agent, instance_id=instance_id, runtime=runtime
    )

    # Compute post-count estimate BEFORE constructing the boundary so it can
    # be embedded in the marker metadata.
    new_messages_no_boundary: list[Any] = []
    summary_msg = _build_summary_message(agent, summary=summary_text)
    new_messages_no_boundary.append(summary_msg)
    new_messages_no_boundary.extend(tail)
    new_messages_no_boundary.extend(attachments)
    post_count_estimate = heuristic_token_count(new_messages_no_boundary)

    boundary_metadata = {
        "trigger": "auto",
        "pre_count": pre_count,
        "post_count": post_count_estimate,
        "turn_index": turn_index,
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "messages_dropped": max(0, len(messages) - len(tail)),
        "messages_preserved": len(tail),
        # Used for retry-idempotency: len(entry.messages) AFTER we
        # finish rewriting. See step 2's guard above.
        "message_count_at_save": (
            1  # boundary itself
            + 1  # summary user message
            + len(tail)
            # attachments added below; we update this value post-construction
        ),
    }
    boundary = _build_boundary_marker(agent, metadata=boundary_metadata)
    new_messages = [boundary, summary_msg, *tail, *attachments]

    # 12. PostCompact hook (advisory; can extend attachments via additional_contexts)
    try:
        from ..hooks import execute_post_compact_hooks, hooks_enabled
        from ..plugins.integration import current_snapshot as _current_hook_snapshot

        if hooks_enabled():
            snap = _current_hook_snapshot(agent, instance_id)
            cwd_for_hooks = getattr(agent, "_cwd_by_instance", {}).get(instance_id, "") or ""
            project_dir = cwd_for_hooks or os.environ.get("CLAUDE_PROJECT_DIR") or os.getcwd()
            post_agg = execute_post_compact_hooks(
                snap,
                summary=summary_text,
                pre_count=pre_count,
                post_count=post_count_estimate,
                attachments_preview=list(attachment_tags),
                session_id=instance_id,
                cwd=cwd_for_hooks,
                project_dir=project_dir,
                trigger="auto",
            )
            if post_agg.additional_contexts:
                for ctx_text in post_agg.additional_contexts:
                    new_messages.append(
                        _make_message(agent, role="user", content=f"[post-compact] {ctx_text}")
                    )
                attachment_tags.append(f"post-hook:{len(post_agg.additional_contexts)}")
    except Exception as exc:  # noqa: BLE001
        logger.warning("[compaction] PostCompact hook error: %s", exc)

    # Finalize message_count_at_save NOW that all messages (including
    # PostCompact-hook additions) are known, and rewrite the boundary
    # marker content with the accurate count for idempotency checks.
    final_count = len(new_messages)
    boundary_metadata["message_count_at_save"] = final_count
    new_boundary_content = _BOUNDARY_SENTINEL + json.dumps(
        boundary_metadata, separators=(",", ":")
    )
    if isinstance(new_messages[0], dict):
        new_messages[0]["content"] = new_boundary_content
    else:
        try:
            new_messages[0].content = new_boundary_content
        except Exception:
            pass

    # 13. Persist via same ETag path. Small retry loop for rare races.
    for etag_attempt in range(3):
        try:
            entry.messages = new_messages
            # In dapr_agents 0.13 the entry is a reference tracked by
            # _infra.state; mutating entry.messages above is enough, and
            # save_state() persists _infra.state to the store.
            agent.save_state(instance_id)
            break
        except Exception as exc:  # noqa: BLE001
            logger.warning(
                "[compaction] save_state attempt %d failed: %s",
                etag_attempt + 1,
                exc,
            )
            time.sleep(0.1 * (2**etag_attempt))
            try:
                entry = agent._infra.get_state(instance_id)
                # If someone else already wrote a boundary for this turn, yield
                # to their copy and return idempotent.
                existing_after = _find_latest_boundary_metadata(
                    list(getattr(entry, "messages", []) or [])
                )
                if existing_after and int(
                    existing_after.get("message_count_at_save", -1)
                ) == len(list(getattr(entry, "messages", []) or [])):
                    return CompactionResult(
                        compacted=True,
                        pre_count=int(existing_after.get("pre_count") or pre_count),
                        post_count=int(existing_after.get("post_count") or post_count_estimate),
                        messages_dropped=int(existing_after.get("messages_dropped") or 0),
                        messages_preserved=int(existing_after.get("messages_preserved") or 0),
                        reason="etag_conflict_concurrent",
                    )
            except Exception:
                pass
    else:
        try:
            publish_compaction_complete(
                execution_id=execution_id,
                instance_id=instance_id,
                pre_count=pre_count,
                post_count=post_count_estimate,
                messages_dropped=len(messages) - len(tail),
                messages_preserved=len(tail),
                ptl_retries=ptl_retries,
                trigger="auto",
                reason="etag_conflict",
                success=False,
            )
        except Exception:
            pass
        return CompactionResult(
            compacted=False,
            pre_count=pre_count,
            reason="etag_conflict",
            ptl_retries=ptl_retries,
        )

    # 14. Emit completion event
    try:
        publish_compaction_complete(
            execution_id=execution_id,
            instance_id=instance_id,
            pre_count=pre_count,
            post_count=post_count_estimate,
            messages_dropped=len(messages) - len(tail),
            messages_preserved=len(tail),
            ptl_retries=ptl_retries,
            trigger="auto",
            reason="ok",
            success=True,
        )
    except Exception:
        pass

    logger.info(
        "[compaction] ok instance=%s turn=%d pre=%d post=%d dropped=%d preserved=%d ptl=%d",
        instance_id,
        turn_index,
        pre_count,
        post_count_estimate,
        len(messages) - len(tail),
        len(tail),
        ptl_retries,
    )

    return CompactionResult(
        compacted=True,
        pre_count=pre_count,
        post_count=post_count_estimate,
        messages_dropped=len(messages) - len(tail),
        messages_preserved=len(tail),
        ptl_retries=ptl_retries,
        trigger="auto",
        reason="ok",
        summary_preview=summary_text[:200],
    )


__all__ = ["CompactionResult", "maybe_compact"]

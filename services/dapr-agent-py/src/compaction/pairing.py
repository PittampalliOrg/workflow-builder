"""Pairing-safe tail selection for compaction.

When we truncate conversation history we cannot leave behind:
  - an assistant message with tool_calls but no matching tool results, or
  - a tool result whose tool_use_id doesn't appear in any preceding
    assistant message's tool_calls.

Anthropic's API rejects either shape with a 400. This module selects a
tail slice that is always pair-complete.

Message shape (compatible with AgentWorkflowMessage dumped to dict or
held as a Pydantic model):
    role: "user" | "assistant" | "tool" | "system"
    content: str | list[...]
    tool_calls: list[{"id": str, ...}] | None
    tool_call_id: str | None
"""
from __future__ import annotations

from typing import Any


def _msg_role(msg: Any) -> str:
    if isinstance(msg, dict):
        return str(msg.get("role") or "")
    return str(getattr(msg, "role", "") or "")


def _msg_tool_call_id(msg: Any) -> str | None:
    if isinstance(msg, dict):
        val = msg.get("tool_call_id")
    else:
        val = getattr(msg, "tool_call_id", None)
    return str(val) if val else None


def _msg_tool_call_ids(msg: Any) -> list[str]:
    if isinstance(msg, dict):
        calls = msg.get("tool_calls") or []
    else:
        calls = getattr(msg, "tool_calls", None) or []
    ids: list[str] = []
    for c in calls:
        if isinstance(c, dict):
            cid = c.get("id")
        else:
            cid = getattr(c, "id", None)
        if cid:
            ids.append(str(cid))
    return ids


def _is_compact_boundary(msg: Any) -> bool:
    """Compact boundary markers are role=system, content begins with sentinel."""
    if _msg_role(msg) != "system":
        return False
    content = msg.get("content") if isinstance(msg, dict) else getattr(msg, "content", None)
    if isinstance(content, str) and content.startswith("__COMPACT_BOUNDARY__ "):
        return True
    return False


def select_preserved_tail(messages: list[Any], n: int) -> list[Any]:
    """Return a slice of the last `n` messages, extended so tool_use/tool_result
    pairs are never split across the boundary.

    Algorithm:
      1. Start with the last n messages.
      2. If the first selected message is a tool result, back up to include
         the assistant message whose tool_calls produced that id (and any
         earlier tool results it also produced, which means we may back
         up further).
      3. Scan inside the selection: if any assistant message has tool_calls
         but a referenced id is missing from the selection (or from messages
         that come later in `messages`), extend forward until all ids are
         accounted for — or drop the assistant message entirely if we can't.
      4. If we hit a compact boundary marker while walking backward, STOP:
         the boundary itself is a natural pair-safe break and going further
         back would also drag in already-summarized content.
    """
    if n <= 0 or not messages:
        return []
    total = len(messages)
    start = max(0, total - n)

    # Pre-compute: which tool_use ids precede each index?
    # We only need "is id `X` produced by an assistant at index < i somewhere in the
    # full list" — simpler than constructing an index.
    all_tool_call_ids_before: list[set[str]] = []
    acc: set[str] = set()
    for m in messages:
        all_tool_call_ids_before.append(set(acc))
        acc.update(_msg_tool_call_ids(m))

    # Step 2: if the starting slice begins with a tool result, back up to the
    # assistant that produced it.
    while start < total:
        head = messages[start]
        role = _msg_role(head)
        if _is_compact_boundary(head):
            break
        if role != "tool":
            break
        need_id = _msg_tool_call_id(head)
        if not need_id:
            # orphan tool result we can't pair — drop it by advancing past it
            start += 1
            continue
        # walk backward to find the assistant with this id
        j = start - 1
        while j >= 0:
            if _is_compact_boundary(messages[j]):
                # Found boundary before producer — keep boundary out of tail;
                # advance start past this unrecoverable tool message.
                start += 1
                break
            if _msg_role(messages[j]) == "assistant" and need_id in _msg_tool_call_ids(
                messages[j]
            ):
                start = j
                break
            j -= 1
        else:
            # no producer found — drop orphan
            start += 1
            continue
        # re-run loop in case new start also begins with a tool result that
        # paired to a different assistant further back
        continue

    # Step 3: every assistant message in the slice must have all its
    # tool_call ids satisfied by tool results that appear WITHIN the slice
    # or elsewhere in the full `messages` list after it. The simpler invariant
    # is: every tool_call_id in the slice must have a matching tool result
    # somewhere. If the producing assistant is in the slice but its tool
    # result is not, we either extend the end of the slice or drop the
    # assistant.
    #
    # We extend forward inside `messages`: if the tail stops at total and
    # tool results are missing, we can't extend. In practice the tail is
    # anchored to the end of history, so "forward" is no-op — any missing
    # tool_result simply doesn't exist, and we must drop the producing
    # assistant to keep the pair invariant.

    tail = list(messages[start:total])
    while True:
        needed: set[str] = set()
        provided: set[str] = set()
        for m in tail:
            if _msg_role(m) == "assistant":
                needed.update(_msg_tool_call_ids(m))
            elif _msg_role(m) == "tool":
                tid = _msg_tool_call_id(m)
                if tid:
                    provided.add(tid)
        missing = needed - provided
        if not missing:
            break
        # remove assistants whose tool_calls reference any missing id, plus
        # their orphaned tool results that may have slipped in
        new_tail: list[Any] = []
        dropped_ids: set[str] = set()
        for m in tail:
            if _msg_role(m) == "assistant" and missing & set(_msg_tool_call_ids(m)):
                dropped_ids.update(_msg_tool_call_ids(m))
                continue
            if _msg_role(m) == "tool" and _msg_tool_call_id(m) in dropped_ids:
                continue
            new_tail.append(m)
        if len(new_tail) == len(tail):
            break  # can't make progress (shouldn't happen, safety)
        tail = new_tail

    return tail


__all__ = ["select_preserved_tail"]

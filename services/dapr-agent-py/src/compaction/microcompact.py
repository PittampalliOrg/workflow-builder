"""Microcompaction — trim large tool-result bodies pre-summarization.

Ported from claude-code-src/main/services/compact/microCompact.ts. Large
tool results (Bash stdout, file reads, web fetches, etc.) eat the majority
of context in long runs. Truncating them BEFORE the summarization LLM
call both shrinks the token count we pay for and speeds up summarization.

Key invariants:
  - Never trim the last N tool results (fresh context for the current turn).
  - Preserve the head of the content so the model can still tell what the
    tool was doing (file path, first rows, etc.).
  - Idempotent: applying twice produces the same output.
"""
from __future__ import annotations

from typing import Any


# Tools whose results are typically verbose and safe to trim.
_COMPACTABLE_TOOLS: frozenset[str] = frozenset({
    "bash",
    "Bash",
    "file_read",
    "Read",
    "read_file",
    "grep",
    "Grep",
    "glob",
    "Glob",
    "web_fetch",
    "WebFetch",
    "web_search",
    "WebSearch",
    "file_edit",
    "Edit",
    "file_write",
    "Write",
})

_MICROCOMPACT_MARKER = "[Old tool result content cleared \u2014 microcompacted]"
_DEFAULT_THRESHOLD_CHARS = 2000
_DEFAULT_KEEP_LAST_N = 3
_HEAD_PREVIEW_CHARS = 400


def _content_str(msg: Any) -> str | None:
    content = msg.get("content") if isinstance(msg, dict) else getattr(msg, "content", None)
    if isinstance(content, str):
        return content
    return None


def _set_content(msg: Any, value: str) -> None:
    if isinstance(msg, dict):
        msg["content"] = value
    else:
        try:
            setattr(msg, "content", value)
        except Exception:
            pass


def _tool_name(msg: Any) -> str:
    if isinstance(msg, dict):
        return str(msg.get("name") or msg.get("tool_name") or "")
    return str(getattr(msg, "name", None) or getattr(msg, "tool_name", "") or "")


def _is_tool_message(msg: Any) -> bool:
    role = msg.get("role") if isinstance(msg, dict) else getattr(msg, "role", None)
    return role == "tool"


def _already_microcompacted(text: str) -> bool:
    return _MICROCOMPACT_MARKER in text


def microcompact_messages(
    messages: list[Any],
    *,
    threshold_chars: int = _DEFAULT_THRESHOLD_CHARS,
    keep_last_n: int = _DEFAULT_KEEP_LAST_N,
) -> tuple[list[Any], int]:
    """Return (new_list, chars_saved). Mutates copies, not originals.

    Messages outside _COMPACTABLE_TOOLS or smaller than `threshold_chars`
    are left untouched. The last `keep_last_n` tool messages are always
    preserved regardless of size.
    """
    if not messages:
        return [], 0

    # Identify indexes of tool messages to consider, preserving last N.
    tool_indexes = [i for i, m in enumerate(messages) if _is_tool_message(m)]
    if keep_last_n > 0:
        preserve_indexes = set(tool_indexes[-keep_last_n:])
    else:
        preserve_indexes = set()

    out: list[Any] = []
    chars_saved = 0
    for idx, msg in enumerate(messages):
        if not _is_tool_message(msg) or idx in preserve_indexes:
            out.append(msg)
            continue
        name = _tool_name(msg)
        if name and name not in _COMPACTABLE_TOOLS:
            out.append(msg)
            continue
        text = _content_str(msg)
        if text is None or len(text) < threshold_chars or _already_microcompacted(text):
            out.append(msg)
            continue

        # Copy (dict or pydantic-style) before mutating.
        if isinstance(msg, dict):
            new_msg = dict(msg)
        else:
            try:
                new_msg = msg.model_copy(deep=False)  # type: ignore[attr-defined]
            except Exception:
                try:
                    new_msg = type(msg)(**msg.model_dump())  # type: ignore[attr-defined]
                except Exception:
                    out.append(msg)
                    continue

        head = text[:_HEAD_PREVIEW_CHARS]
        new_text = f"{head}\n\n{_MICROCOMPACT_MARKER} (was {len(text)} chars)"
        _set_content(new_msg, new_text)
        chars_saved += len(text) - len(new_text)
        out.append(new_msg)

    return out, chars_saved


__all__ = ["microcompact_messages", "_MICROCOMPACT_MARKER"]

"""Compact image-bearing `tool_results` from the Diagrid messages list.

Diagrid's `Message.tool_results` carries `result` as an arbitrary JSON value;
our tools serialize images as `{"type": "image", "base64": "..."}` blocks
(or as base64-prefixed strings, depending on the tool). Gemini's 1M-token
context window can still be exceeded once dozens of screenshots accumulate
across turns, so we drop all but the last `ADK_AGENT_PY_MAX_IMAGE_TOOL_RESULTS`
image blocks, replacing earlier ones with placeholder text.

Called from `session_workflow` BEFORE constructing the child input
(`AgentWorkflowInput.messages`). Idempotent — running it on already-compacted
messages is a no-op.
"""

from __future__ import annotations

import logging
from typing import Any

from src.constants import MAX_IMAGE_TOOL_RESULTS

logger = logging.getLogger(__name__)

_PLACEHOLDER = "[image tool_result compacted away to save context]"


def _looks_like_image(value: Any) -> bool:
    """Best-effort detection of image-bearing tool_result values.

    Supports three shapes our FunctionTool wrappers produce:
    - dict with `{"type": "image"}` or `{"mime_type": "image/..."}`
    - dict with `{"image_url": ...}`
    - str that starts with `data:image/` or is base64-encoded PNG/JPEG
    """
    if isinstance(value, dict):
        if str(value.get("type") or "").lower() == "image":
            return True
        if "image_url" in value or "imageUrl" in value:
            return True
        mime = str(value.get("mime_type") or value.get("mimeType") or "").lower()
        if mime.startswith("image/"):
            return True
        return False
    if isinstance(value, str) and value.startswith("data:image/"):
        return True
    return False


def compact_image_tool_results(
    messages: list[dict[str, Any]],
    *,
    keep_last: int = MAX_IMAGE_TOOL_RESULTS,
) -> list[dict[str, Any]]:
    """Return a copy of `messages` with all but the last `keep_last`
    image-bearing tool_result `result` fields replaced by a placeholder.
    """
    if keep_last < 0:
        return messages

    image_indices: list[tuple[int, int]] = []
    for mi, msg in enumerate(messages or []):
        for ti, tr in enumerate(msg.get("tool_results") or []):
            if _looks_like_image(tr.get("result")):
                image_indices.append((mi, ti))

    if len(image_indices) <= keep_last:
        return messages

    drop = set(image_indices[: len(image_indices) - keep_last])
    if not drop:
        return messages

    compacted: list[dict[str, Any]] = []
    for mi, msg in enumerate(messages or []):
        new_msg = dict(msg)
        if msg.get("tool_results"):
            new_results: list[dict[str, Any]] = []
            for ti, tr in enumerate(msg["tool_results"]):
                if (mi, ti) in drop:
                    new_results.append({**tr, "result": _PLACEHOLDER})
                else:
                    new_results.append(tr)
            new_msg["tool_results"] = new_results
        compacted.append(new_msg)

    logger.info(
        "[image-compaction] dropped %d/%d image tool_result block(s)",
        len(drop),
        len(image_indices),
    )
    return compacted

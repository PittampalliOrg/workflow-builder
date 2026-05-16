"""Bounded payload helpers for Dapr Agents durable state.

These helpers are deterministic and side-effect free. They are called from
existing activities before upstream dapr-agents persists tool messages and
tool_history, so workflow yield order and activity registration stay stable.
"""

from __future__ import annotations

import copy
import json
import logging
import os
from dataclasses import asdict, dataclass
from typing import Any

logger = logging.getLogger(__name__)

DEFAULT_MAX_TOOL_ARGUMENT_BYTES = 12_288
DEFAULT_MAX_TOOL_RESULT_CHARS = 12_288
DEFAULT_MAX_TOOL_HISTORY_ARGUMENT_CHARS = 2_048
DEFAULT_MAX_SUMMARY_TOOL_HISTORY_CHARS = 32_768
DEFAULT_MAX_SUMMARY_CONVERSATION_CHARS = 65_536
TRUNCATION_MARKER_PREFIX = "[... truncated by dapr-agent-py payload compaction:"


def _env_int(name: str, default: int) -> int:
    raw = os.environ.get(name)
    if raw is None or raw.strip() == "":
        return default
    try:
        return max(0, int(raw))
    except ValueError:
        logger.warning("[payload-compaction] invalid int for %s=%r; using %d", name, raw, default)
        return default


@dataclass(frozen=True)
class PayloadCompactionConfig:
    max_tool_argument_bytes: int = DEFAULT_MAX_TOOL_ARGUMENT_BYTES
    max_tool_result_chars: int = DEFAULT_MAX_TOOL_RESULT_CHARS
    max_tool_history_argument_chars: int = DEFAULT_MAX_TOOL_HISTORY_ARGUMENT_CHARS
    max_summary_tool_history_chars: int = DEFAULT_MAX_SUMMARY_TOOL_HISTORY_CHARS
    max_summary_conversation_chars: int = DEFAULT_MAX_SUMMARY_CONVERSATION_CHARS

    @classmethod
    def from_env(cls) -> "PayloadCompactionConfig":
        return cls(
            max_tool_argument_bytes=_env_int(
                "DAPR_AGENT_PY_MAX_TOOL_ARGUMENT_BYTES",
                DEFAULT_MAX_TOOL_ARGUMENT_BYTES,
            ),
            max_tool_result_chars=_env_int(
                "DAPR_AGENT_PY_MAX_TOOL_RESULT_CHARS",
                DEFAULT_MAX_TOOL_RESULT_CHARS,
            ),
            max_tool_history_argument_chars=_env_int(
                "DAPR_AGENT_PY_MAX_TOOL_HISTORY_ARGUMENT_CHARS",
                DEFAULT_MAX_TOOL_HISTORY_ARGUMENT_CHARS,
            ),
            max_summary_tool_history_chars=_env_int(
                "DAPR_AGENT_PY_MAX_SUMMARY_TOOL_HISTORY_CHARS",
                DEFAULT_MAX_SUMMARY_TOOL_HISTORY_CHARS,
            ),
            max_summary_conversation_chars=_env_int(
                "DAPR_AGENT_PY_MAX_SUMMARY_CONVERSATION_CHARS",
                DEFAULT_MAX_SUMMARY_CONVERSATION_CHARS,
            ),
        )


@dataclass
class PayloadCompactionStats:
    tool_results_compacted: int = 0
    tool_arguments_compacted: int = 0
    original_result_chars: int = 0
    compacted_result_chars: int = 0
    original_argument_bytes: int = 0
    compacted_argument_bytes: int = 0

    @property
    def changed(self) -> bool:
        return self.tool_results_compacted > 0 or self.tool_arguments_compacted > 0

    def to_dict(self) -> dict[str, Any]:
        data = asdict(self)
        data["changed"] = self.changed
        return data


def _to_json(value: Any) -> str:
    try:
        return json.dumps(value, default=str, ensure_ascii=False, sort_keys=True)
    except Exception:
        return repr(value)


def _truncate_text(text: str, limit: int, *, unit: str = "chars") -> tuple[str, bool]:
    if limit <= 0:
        limit = 1
    if text.startswith(TRUNCATION_MARKER_PREFIX):
        return text, False
    if len(text) <= limit:
        return text, False
    marker = (
        f"{TRUNCATION_MARKER_PREFIX} original_{unit}={len(text)} "
        f"limit_{unit}={limit}] "
    )
    keep = max(0, limit - len(marker))
    return marker + text[:keep], True


def _truncate_json_bytes(text: str, limit: int) -> tuple[str, bool, int, int]:
    original_bytes = len(text.encode("utf-8", "ignore"))
    if text.startswith(TRUNCATION_MARKER_PREFIX) or original_bytes <= limit:
        return text, False, original_bytes, original_bytes
    marker = (
        f"{TRUNCATION_MARKER_PREFIX} original_bytes={original_bytes} "
        f"limit_bytes={limit}] "
    )
    keep_bytes = max(0, limit - len(marker.encode("utf-8")))
    encoded = text.encode("utf-8", "ignore")[:keep_bytes]
    truncated = marker + encoded.decode("utf-8", "ignore")
    return truncated, True, original_bytes, len(truncated.encode("utf-8", "ignore"))


def _compact_value(
    value: Any,
    *,
    max_string_chars: int,
    max_depth: int = 5,
    max_items: int = 40,
    max_keys: int = 80,
) -> Any:
    if max_depth <= 0:
        return f"{TRUNCATION_MARKER_PREFIX} max_depth_reached]"
    if isinstance(value, str):
        return _truncate_text(value, max_string_chars)[0]
    if isinstance(value, list):
        items = [
            _compact_value(
                item,
                max_string_chars=max_string_chars,
                max_depth=max_depth - 1,
                max_items=max_items,
                max_keys=max_keys,
            )
            for item in value[:max_items]
        ]
        if len(value) > max_items:
            items.append(f"{TRUNCATION_MARKER_PREFIX} original_items={len(value)} limit_items={max_items}]")
        return items
    if isinstance(value, tuple):
        return _compact_value(
            list(value),
            max_string_chars=max_string_chars,
            max_depth=max_depth,
            max_items=max_items,
            max_keys=max_keys,
        )
    if isinstance(value, dict):
        out: dict[str, Any] = {}
        for idx, key in enumerate(sorted(value.keys(), key=lambda item: str(item))):
            if idx >= max_keys:
                out["__truncated_keys__"] = (
                    f"{TRUNCATION_MARKER_PREFIX} original_keys={len(value)} limit_keys={max_keys}]"
                )
                break
            out[str(key)] = _compact_value(
                value[key],
                max_string_chars=max_string_chars,
                max_depth=max_depth - 1,
                max_items=max_items,
                max_keys=max_keys,
            )
        return out
    return value


def compact_tool_arguments_json(
    raw_args: Any,
    *,
    config: PayloadCompactionConfig,
) -> tuple[str, bool, int, int]:
    """Return a JSON string safe for durable tool_history argument parsing."""
    if raw_args is None:
        raw_text = ""
    elif isinstance(raw_args, str):
        raw_text = raw_args
    else:
        raw_text = _to_json(raw_args)

    original_bytes = len(raw_text.encode("utf-8", "ignore"))
    if original_bytes <= config.max_tool_argument_bytes and not raw_text.startswith(TRUNCATION_MARKER_PREFIX):
        return raw_text, False, original_bytes, original_bytes

    try:
        parsed = json.loads(raw_text) if raw_text else {}
    except (TypeError, ValueError):
        parsed = raw_text

    compacted_value = _compact_value(
        parsed,
        max_string_chars=config.max_tool_history_argument_chars,
    )
    compacted_json = _to_json(compacted_value)
    compacted_json, changed_by_bytes, before, after = _truncate_json_bytes(
        compacted_json,
        config.max_tool_argument_bytes,
    )
    return compacted_json, True, original_bytes or before, after


def compact_save_tool_results_payload(
    payload: dict[str, Any],
    *,
    config: PayloadCompactionConfig | None = None,
) -> tuple[dict[str, Any], PayloadCompactionStats]:
    """Bound tool result content and tool-call arguments before persistence."""
    cfg = config or PayloadCompactionConfig.from_env()
    compacted = copy.deepcopy(payload)
    stats = PayloadCompactionStats()

    tool_results = compacted.get("tool_results")
    if isinstance(tool_results, list):
        for item in tool_results:
            if not isinstance(item, dict):
                continue
            content = item.get("content")
            content_text = content if isinstance(content, str) else _to_json(content)
            stats.original_result_chars += len(content_text)
            bounded, changed = _truncate_text(
                content_text,
                cfg.max_tool_result_chars,
                unit="chars",
            )
            stats.compacted_result_chars += len(bounded)
            if changed or not isinstance(content, str):
                item["content"] = bounded
                if changed:
                    stats.tool_results_compacted += 1

    calls_by_id = compacted.get("tool_calls_by_id")
    if isinstance(calls_by_id, dict):
        for call_info in calls_by_id.values():
            if not isinstance(call_info, dict):
                continue
            tool_call = call_info.get("tool_call")
            if not isinstance(tool_call, dict):
                continue
            fn = tool_call.get("function")
            if not isinstance(fn, dict):
                continue
            bounded_args, changed, before, after = compact_tool_arguments_json(
                fn.get("arguments", ""),
                config=cfg,
            )
            stats.original_argument_bytes += before
            stats.compacted_argument_bytes += after
            if changed:
                fn["arguments"] = bounded_args
                stats.tool_arguments_compacted += 1

    return compacted, stats


def _message_content_text(message: Any) -> str:
    if isinstance(message, dict):
        content = message.get("content")
    else:
        content = getattr(message, "content", None)
    if isinstance(content, str):
        return content
    return _to_json(content)


def _message_role(message: Any) -> str:
    if isinstance(message, dict):
        return str(message.get("role") or "unknown")
    return str(getattr(message, "role", None) or "unknown")


def build_bounded_summary_task(
    messages_list: list[Any],
    tool_history: Any,
    *,
    config: PayloadCompactionConfig | None = None,
) -> str:
    """Build the upstream summary prompt using bounded previews only."""
    cfg = config or PayloadCompactionConfig.from_env()
    lines: list[str] = []
    for message in messages_list:
        role = _message_role(message)
        content = _message_content_text(message)
        bounded, _changed = _truncate_text(content, 4_096)
        lines.append(f"{role}: {bounded}")
    conversation_text = "\n".join(lines)
    conversation_text, _ = _truncate_text(
        conversation_text,
        cfg.max_summary_conversation_chars,
    )

    if tool_history is None:
        tool_list: Any = []
    elif isinstance(tool_history, list):
        tool_list = [
            _compact_value(
                record.model_dump() if hasattr(record, "model_dump") else record,
                max_string_chars=cfg.max_tool_history_argument_chars,
            )
            for record in tool_history
        ]
    else:
        tool_list = _compact_value(
            tool_history,
            max_string_chars=cfg.max_tool_history_argument_chars,
        )
    tool_text = _to_json(tool_list)
    tool_text, _ = _truncate_text(tool_text, cfg.max_summary_tool_history_chars)

    return (
        "Summarize the following conversation and any tool usage concisely for long-term memory storage. "
        "Focus on key facts, decisions, and outcomes.\n\n"
        "Conversation:\n"
        f"{conversation_text}\n\n"
        "Tool calls/results:\n"
        f"{tool_text}"
    )


__all__ = [
    "DEFAULT_MAX_SUMMARY_CONVERSATION_CHARS",
    "DEFAULT_MAX_SUMMARY_TOOL_HISTORY_CHARS",
    "DEFAULT_MAX_TOOL_ARGUMENT_BYTES",
    "DEFAULT_MAX_TOOL_HISTORY_ARGUMENT_CHARS",
    "DEFAULT_MAX_TOOL_RESULT_CHARS",
    "PayloadCompactionConfig",
    "PayloadCompactionStats",
    "TRUNCATION_MARKER_PREFIX",
    "build_bounded_summary_task",
    "compact_save_tool_results_payload",
    "compact_tool_arguments_json",
]

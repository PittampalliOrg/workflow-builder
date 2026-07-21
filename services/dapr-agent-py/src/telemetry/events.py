"""OTEL log-record events (`com.anthropic.claude_code.events`).

Port of `utils/telemetry/events.ts`. Emits `claude_code.<event>` log records
with monotonically-increasing `event.sequence` and the common telemetry
attributes. Used for system_prompt / tool / user_prompt events that would
otherwise bloat span attributes.
"""

from __future__ import annotations

import itertools
import logging
import os
import threading
from datetime import datetime, timezone
from typing import Any

from .attributes import get_telemetry_attributes
from .content_sanitizer import (
    sanitize_content_for_telemetry,
    sanitize_text_for_telemetry,
)
from .providers import get_event_logger

logger = logging.getLogger(__name__)

_seq_counter = itertools.count()
_warned_no_logger = False
_warn_lock = threading.Lock()
_prompt_id_ctx = threading.local()


def _is_env_truthy(raw: str | None) -> bool:
    if raw is None:
        return False
    return raw.strip().lower() in {"1", "true", "yes", "on"}


def is_user_prompt_logging_enabled() -> bool:
    return _is_env_truthy(os.environ.get("OTEL_LOG_USER_PROMPTS"))


def redact_if_disabled(content: str) -> str:
    return content if is_user_prompt_logging_enabled() else "<REDACTED>"


def set_prompt_id(prompt_id: str | None) -> None:
    _prompt_id_ctx.value = prompt_id or ""


def get_prompt_id() -> str:
    return getattr(_prompt_id_ctx, "value", "") or ""


def emit_user_prompt_event(span: Any, prompt: str) -> None:
    """Emit the prompt log and its span-event mirror from one safe envelope."""
    event_attrs: dict[str, Any] = {
        "prompt_length": len(prompt),
        "prompt": (
            sanitize_text_for_telemetry(prompt)
            if is_user_prompt_logging_enabled()
            else "<REDACTED>"
        ),
    }
    log_otel_event("user_prompt", event_attrs)
    if span is None:
        return
    try:
        span.add_event(
            "claude_code.user_prompt",
            attributes={
                key: str(value)
                for key, value in event_attrs.items()
                if value is not None
            },
        )
    except Exception:  # noqa: BLE001
        pass


def log_otel_event(event_name: str, metadata: dict[str, Any] | None = None) -> None:
    """Emit a `claude_code.<event_name>` log record.

    Silently no-ops when the logger provider is not initialized. Values in
    `metadata` are stringified to keep attribute cardinality predictable.
    """
    global _warned_no_logger
    event_logger = get_event_logger()
    if event_logger is None:
        if not _warned_no_logger:
            with _warn_lock:
                if not _warned_no_logger:
                    _warned_no_logger = True
                    logger.warning(
                        "[3P telemetry] Event dropped (no event logger): %s",
                        event_name,
                    )
        return

    attrs: dict[str, Any] = dict(get_telemetry_attributes())
    attrs["event.name"] = event_name
    attrs["event.timestamp"] = datetime.now(timezone.utc).isoformat()
    attrs["event.sequence"] = next(_seq_counter)

    prompt_id = get_prompt_id()
    if prompt_id:
        attrs["prompt.id"] = prompt_id

    if metadata:
        for k, v in metadata.items():
            if v is None:
                continue
            safe_value = sanitize_content_for_telemetry(v)
            attrs[k] = (
                safe_value
                if isinstance(safe_value, (str, bool, int, float))
                else str(safe_value)
            )

    try:
        from opentelemetry._logs import LogRecord, SeverityNumber

        now_ns = int(datetime.now(timezone.utc).timestamp() * 1_000_000_000)
        record = LogRecord(
            timestamp=now_ns,
            observed_timestamp=now_ns,
            severity_number=SeverityNumber.INFO,
            severity_text="INFO",
            body=f"claude_code.{event_name}",
            attributes=attrs,
        )
        event_logger.emit(record)
    except Exception as exc:  # noqa: BLE001
        logger.warning("log_otel_event failed for %s: %s", event_name, exc)

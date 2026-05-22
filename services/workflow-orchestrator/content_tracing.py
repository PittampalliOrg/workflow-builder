"""Request/response content capture for workflow-orchestrator spans.

Emits OpenInference ``input.value`` / ``output.value`` span attributes — the
same convention ``services/dapr-agent-py/src/telemetry/state_tracing.py`` uses
and the Service Graph drill-down drawer (``drilldown-io.svelte`` /
``parseIoValue``) renders. This lets workflow *action* hops carry their actual
request/response payloads, not just size/status metadata.

Gating: **on by default** for these backend hops (the payloads are bounded
JSON, capped at 60 KB and secret-redacted — unlike the agent's image-overflow
concern, span attributes only flow to ClickHouse, never back into an LLM
context). Set ``ENABLE_REQUEST_CONTENT_TRACING=false`` (or ``0``/``no``/``off``)
to opt a service out. ``ENABLE_BETA_TRACING_DETAILED`` truthy also forces it on.

Redaction is conservative: any dict key whose name matches a secret-ish pattern
has its value replaced with ``"[REDACTED]"`` before serialization. The
orchestrator never holds plaintext credentials (function-router owns
decryption), but redaction is applied here too so the helper is reusable and
safe if a payload ever carries a token.
"""

from __future__ import annotations

import json
import os
import re
from typing import Any

# Match dapr-agent-py state_tracing: 60 KB per value.
DEFAULT_MAX_BYTES = 60_000

_TRUTHY = {"1", "true", "yes", "on"}
_FALSY = {"0", "false", "no", "off"}

# Key names whose values must never be serialized into spans.
_REDACT_KEY_RE = re.compile(
    r"(token|secret|password|passwd|api[_-]?key|authorization|auth|credential|"
    r"bearer|private[_-]?key|client[_-]?secret|refresh[_-]?token|access[_-]?token|"
    r"session[_-]?token|cookie|x-api-key)",
    re.IGNORECASE,
)

_REDACTED = "[REDACTED]"
_MAX_REDACT_DEPTH = 12


def _is_truthy(value: str | None) -> bool:
    return (value or "").strip().lower() in _TRUTHY


def content_tracing_enabled() -> bool:
    """True when request/response content should be stamped onto spans.

    On by default; only an explicit ``ENABLE_REQUEST_CONTENT_TRACING`` falsy
    value disables it (beta tracing always forces it on).
    """
    if _is_truthy(os.environ.get("ENABLE_BETA_TRACING_DETAILED")):
        return True
    return (os.environ.get("ENABLE_REQUEST_CONTENT_TRACING") or "").strip().lower() not in _FALSY


def redact(obj: Any, _depth: int = 0) -> Any:
    """Deep-copy ``obj`` replacing secret-ish dict values with ``[REDACTED]``."""
    if _depth > _MAX_REDACT_DEPTH:
        return "[redaction-depth-exceeded]"
    if isinstance(obj, dict):
        out: dict[Any, Any] = {}
        for k, v in obj.items():
            if isinstance(k, str) and _REDACT_KEY_RE.search(k):
                out[k] = _REDACTED
            else:
                out[k] = redact(v, _depth + 1)
        return out
    if isinstance(obj, (list, tuple)):
        return [redact(v, _depth + 1) for v in obj]
    return obj


def _serialize(obj: Any) -> str:
    if isinstance(obj, str):
        return obj
    try:
        return json.dumps(obj, default=str, ensure_ascii=False)
    except Exception:
        return str(obj)


def io_attributes(
    prefix: str,
    obj: Any,
    *,
    max_bytes: int = DEFAULT_MAX_BYTES,
) -> dict[str, Any]:
    """Build OpenInference ``<prefix>.value`` attributes for ``obj``.

    ``prefix`` is ``"input"`` or ``"output"``. Returns an empty dict when
    content tracing is disabled or ``obj`` is None, so callers can splat the
    result into ``set_current_span_attrs`` unconditionally.
    """
    if obj is None or not content_tracing_enabled():
        return {}
    serialized = _serialize(redact(obj))
    if not serialized:
        return {}
    encoded = serialized.encode("utf-8")
    truncated = len(encoded) > max_bytes
    value = encoded[:max_bytes].decode("utf-8", errors="ignore") if truncated else serialized
    attrs: dict[str, Any] = {
        f"{prefix}.value": value,
        f"{prefix}.mime_type": "application/json",
    }
    if truncated:
        attrs[f"{prefix}.value_truncated"] = True
        attrs[f"{prefix}.value_original_length"] = len(encoded)
    return attrs

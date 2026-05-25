"""Capture Dapr state-store content on spans for debugging.

The auto-instrumented `/dapr.proto.runtime.v1.Dapr/SaveState|GetState` gRPC spans
(emitted by the Dapr SDK) carry only metadata — not the key or value. We wrap
`dapr_agents` `StateStoreService` load/save methods (used by BOTH the agent state
store and the agent-registry store) in an application span that records:

  - `db.key`        — always (the qualified state key)
  - `input.value`   — the state request envelope, including write values
  - `output.value`  — the loaded value or write acknowledgement/error envelope

The underlying gRPC SaveState/GetState span becomes a child of this span, so the
service-graph drill-down (which already renders input.value/output.value +
attributes) shows the actual state transferred. Content is JSON-serialized and
truncated to 60KB (`truncate_content`).
"""

from __future__ import annotations

import contextlib
import functools
import json
import logging
import os
import re
from typing import Any

from .beta import _is_env_truthy, is_beta_tracing_enabled, truncate_content
from .providers import get_tracer

logger = logging.getLogger(__name__)

# Tracks which state ops have logged their first-invocation diagnostic.
_fired_ops: set[str] = set()
_REDACTED = "[REDACTED]"
_MAX_REDACT_DEPTH = 12
_SENSITIVE_KEY_PARTS = (
    "api_key",
    "apikey",
    "authorization",
    "bearer",
    "client_secret",
    "password",
    "secret",
)
_SENSITIVE_KEY_EXACT = {"access_token", "auth_token", "refresh_token", "token"}
_SENSITIVE_KEY_RE = re.compile(r"(x-api-key|private[_-]?key|session[_-]?token)", re.IGNORECASE)
_MISSING = object()


def _state_content_enabled() -> bool:
    """Capture state values when the broad beta flag OR a dedicated narrow flag is
    set. The narrow flag lets state content be enabled WITHOUT turning on all the
    other (heavy) beta LLM-content tracing."""
    return is_beta_tracing_enabled() or _is_env_truthy(
        os.environ.get("ENABLE_STATE_CONTENT_TRACING")
    )


def _to_json(value: Any) -> str:
    try:
        if hasattr(value, "model_dump"):
            value = value.model_dump()
        return json.dumps(_redact_for_span(value), default=str)
    except Exception:
        return str(value)


def _redact_for_span(value: Any, depth: int = 0) -> Any:
    if depth > _MAX_REDACT_DEPTH:
        return "[redaction-depth-exceeded]"
    if isinstance(value, dict):
        redacted: dict[str, Any] = {}
        for key, item in value.items():
            key_text = str(key)
            key_norm = key_text.replace("-", "_").lower()
            if (
                key_norm in _SENSITIVE_KEY_EXACT
                or key_norm.endswith("_token")
                or _SENSITIVE_KEY_RE.search(key_text)
                or any(part in key_norm for part in _SENSITIVE_KEY_PARTS)
            ):
                redacted[key_text] = _REDACTED
            else:
                redacted[key_text] = _redact_for_span(item, depth + 1)
        return redacted
    if isinstance(value, (list, tuple)):
        return [_redact_for_span(item, depth + 1) for item in value]
    return value


def _set_io(span: Any, attr: str, value: Any) -> None:
    """Set input.value/output.value (+ mime) on the span, gated + truncated."""
    if span is None or value is None or not _state_content_enabled():
        return
    try:
        content, truncated = truncate_content(_to_json(value))
        if not content:
            return
        span.set_attribute(attr, content)
        span.set_attribute(
            "input.mime_type" if attr == "input.value" else "output.mime_type",
            "application/json",
        )
        if truncated:
            span.set_attribute(f"{attr}_truncated", True)
    except Exception as exc:  # noqa: BLE001
        logger.debug("[state-tracing] set %s failed: %s", attr, exc)


def _key_label(self: Any, key: Any) -> str:
    if isinstance(key, (list, tuple)):
        return ",".join(str(k) for k in key)[:512]
    if isinstance(key, dict):
        return ",".join(str(k) for k in key.keys())[:512]
    try:
        return str(self._qualify(key))
    except Exception:
        return str(key)


def _read_request_payload(op: str, key_label: str) -> dict[str, Any]:
    return {"operation": op, "key": key_label}


def _write_request_payload(op: str, key_label: str, value: Any) -> dict[str, Any]:
    payload: dict[str, Any] = {"operation": op}
    if key_label:
        payload["key"] = key_label
    if value is not _MISSING:
        payload["value"] = value
    return payload


def _write_value_from_call(args: tuple[Any, ...], kwargs: dict[str, Any]) -> Any:
    for name in ("value", "items", "operations"):
        if name in kwargs:
            return kwargs[name]
    if len(args) > 1:
        return args[1]
    if args:
        return args[0]
    return _MISSING


def _write_output_payload(result: Any = None, *, error: BaseException | None = None) -> dict[str, Any]:
    if error is not None:
        return {"ok": False, "error": str(error)}
    if result is None:
        return {"ok": True}
    return {"ok": True, "result": result}


def instrument_state_store() -> None:
    """Monkeypatch StateStoreService load/save methods to capture content. Idempotent."""
    try:
        from dapr_agents.storage.daprstores.stateservice import StateStoreService
    except Exception as exc:  # noqa: BLE001
        logger.warning("[state-tracing] StateStoreService import failed: %s", exc)
        return
    if getattr(StateStoreService, "_wb_state_instrumented", False):
        return

    def _span(self: Any, op: str, key_label: str):
        # Resolve the tracer LAZILY, per call. instrument_state_store() runs
        # during telemetry init BEFORE providers._ready flips True, so a tracer
        # fetched here at patch time would be None and silently no-op forever.
        # Fetching at call time means spans start emitting as soon as telemetry
        # is ready, regardless of instrumentation ordering.
        tracer = get_tracer()
        if tracer is None:
            return contextlib.nullcontext(None)
        return tracer.start_as_current_span(
            f"state.{op}",
            attributes={
                "db.system": "state",
                "db.name": getattr(self, "store_name", "state"),
                "db.operation": op,
                "db.statement": op,
                "db.key": key_label,
                "openinference.span.kind": "CHAIN",
            },
        )

    def _diag_first_call(op: str) -> None:
        # One-shot WARNING so pod logs prove the wrapper actually fires in the
        # live process (distinguishes "patch never bound" from "patched but the
        # call path / tracer differs"). Cheap: a single set membership check.
        if op not in _fired_ops:
            _fired_ops.add(op)
            logger.debug(
                "[state-tracing] wrapper fired: op=%s tracer=%s",
                op,
                "yes" if get_tracer() is not None else "none",
            )

    def wrap_read(orig, op: str):
        @functools.wraps(orig)
        def fn(self, *args, **kwargs):
            _diag_first_call(op)
            key = kwargs.get("key", kwargs.get("keys", args[0] if args else None))
            key_label = _key_label(self, key)
            with _span(self, op, key_label) as span:
                _set_io(span, "input.value", _read_request_payload(op, key_label))
                try:
                    result = orig(self, *args, **kwargs)
                except Exception as exc:
                    _set_io(span, "output.value", {"ok": False, "error": str(exc)})
                    raise
                _set_io(span, "output.value", result)
                return result

        return fn

    def wrap_write(orig, op: str):
        @functools.wraps(orig)
        def fn(self, *args, **kwargs):
            _diag_first_call(op)
            key = kwargs.get("key", kwargs.get("keys", args[0] if args else None))
            key_label = _key_label(self, key)
            value = _write_value_from_call(args, kwargs)
            with _span(self, op, key_label) as span:
                _set_io(span, "input.value", _write_request_payload(op, key_label, value))
                try:
                    result = orig(self, *args, **kwargs)
                except Exception as exc:
                    _set_io(span, "output.value", _write_output_payload(error=exc))
                    raise
                _set_io(span, "output.value", _write_output_payload(result))
                return result

        return fn

    def wrap_delete(orig, op: str):
        @functools.wraps(orig)
        def fn(self, *args, **kwargs):
            _diag_first_call(op)
            key = kwargs.get("key", kwargs.get("keys", args[0] if args else None))
            key_label = _key_label(self, key)
            with _span(self, op, key_label) as span:
                _set_io(span, "input.value", _read_request_payload(op, key_label))
                try:
                    result = orig(self, *args, **kwargs)
                except Exception as exc:
                    _set_io(span, "output.value", _write_output_payload(error=exc))
                    raise
                _set_io(span, "output.value", _write_output_payload(result))
                return result

        return fn

    for name, kind in (
        ("load", "read"),
        ("load_with_etag", "read"),
        ("load_many", "read"),
        ("save", "write"),
        ("delete", "delete"),
        ("save_many", "write"),
        ("execute_transaction", "write"),
    ):
        orig = getattr(StateStoreService, name, None)
        if orig is None:
            continue
        if kind == "read":
            wrapped = wrap_read(orig, name)
        elif kind == "delete":
            wrapped = wrap_delete(orig, name)
        else:
            wrapped = wrap_write(orig, name)
        setattr(StateStoreService, name, wrapped)

    StateStoreService._wb_state_instrumented = True
    logger.info("[state-tracing] StateStoreService instrumented for content capture")

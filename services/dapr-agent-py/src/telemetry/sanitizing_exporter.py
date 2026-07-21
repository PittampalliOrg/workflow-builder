"""Final OpenTelemetry export boundary for content sanitization."""

from __future__ import annotations

import json
from collections.abc import Mapping, Sequence
from typing import Any

from opentelemetry._logs import LogRecord
from opentelemetry.sdk._logs import ReadableLogRecord
from opentelemetry.sdk._logs.export import LogRecordExporter
from opentelemetry.sdk.resources import Resource
from opentelemetry.sdk.trace import Event, ReadableSpan
from opentelemetry.sdk.trace.export import SpanExporter
from opentelemetry.trace import Link, Status, StatusCode

from .content_sanitizer import (
    sanitize_content_for_telemetry,
    sanitize_text_for_telemetry,
)


_SANITIZATION_FAILED = "[TELEMETRY_SANITIZATION_FAILED]"


def _otel_attribute_value(value: Any) -> Any:
    """Return an OTel-compatible sanitized scalar or scalar sequence."""
    try:
        safe_value = sanitize_content_for_telemetry(value)
    except Exception:  # noqa: BLE001
        return _SANITIZATION_FAILED
    if isinstance(safe_value, (str, bool, int, float)):
        return safe_value
    if isinstance(safe_value, (list, tuple)) and all(
        isinstance(item, (str, bool, int, float)) for item in safe_value
    ):
        return list(safe_value)
    try:
        return sanitize_text_for_telemetry(
            json.dumps(safe_value, default=str, ensure_ascii=False)
        )
    except Exception:  # noqa: BLE001
        return _SANITIZATION_FAILED


def _sanitize_attributes(
    attributes: Mapping[str, Any] | None,
) -> dict[str, Any]:
    try:
        safe_attributes = sanitize_content_for_telemetry(dict(attributes or {}))
        if not isinstance(safe_attributes, dict):
            return {"telemetry.sanitization.failed": True}
        return {
            sanitize_text_for_telemetry(str(key)): _otel_attribute_value(value)
            for key, value in safe_attributes.items()
        }
    except Exception:  # noqa: BLE001
        return {"telemetry.sanitization.failed": True}


def _sanitize_resource(resource: Resource) -> Resource:
    return Resource(
        _sanitize_attributes(resource.attributes),
        schema_url=(
            sanitize_text_for_telemetry(resource.schema_url)
            if resource.schema_url
            else None
        ),
    )


def _sanitize_status(status: Status) -> Status:
    description = status.description
    if not description:
        return status
    safe_description = sanitize_text_for_telemetry(description)
    if safe_description == description:
        return status
    return Status(status.status_code, safe_description)


def _canonical_span_status(
    span: ReadableSpan,
    attributes: Mapping[str, Any],
) -> Status:
    """Restore canonical tool failures after upstream wrappers mark returns OK."""
    if (
        attributes.get("openinference.span.kind") == "TOOL"
        and attributes.get("success") is False
    ):
        error = attributes.get("error")
        description = error if isinstance(error, str) and error else None
        return Status(StatusCode.ERROR, description)
    return _sanitize_status(span.status)


def _sanitize_log_body(value: Any) -> Any:
    try:
        safe_value = sanitize_content_for_telemetry(value)
        if safe_value is None or isinstance(safe_value, (str, bool, int, float)):
            return safe_value
        serialized = sanitize_text_for_telemetry(
            json.dumps(safe_value, default=str, ensure_ascii=False)
        )
        return json.loads(serialized)
    except Exception:  # noqa: BLE001
        return _SANITIZATION_FAILED


def sanitize_readable_span(span: ReadableSpan) -> ReadableSpan:
    """Clone a finished span with every exported content surface sanitized."""
    attributes = _sanitize_attributes(span.attributes)
    events = tuple(
        Event(
            sanitize_text_for_telemetry(event.name),
            attributes=_sanitize_attributes(event.attributes),
            timestamp=event.timestamp,
        )
        for event in span.events
    )
    links = tuple(
        Link(link.context, attributes=_sanitize_attributes(link.attributes))
        for link in span.links
    )
    return ReadableSpan(
        name=sanitize_text_for_telemetry(span.name),
        context=span.context,
        parent=span.parent,
        resource=_sanitize_resource(span.resource),
        attributes=attributes,
        events=events,
        links=links,
        kind=span.kind,
        status=_canonical_span_status(span, attributes),
        start_time=span.start_time,
        end_time=span.end_time,
        instrumentation_scope=span.instrumentation_scope,
    )


def _failed_span(span: ReadableSpan) -> ReadableSpan:
    return ReadableSpan(
        name="telemetry.sanitization.failed",
        context=span.context,
        parent=span.parent,
        resource=Resource({}),
        attributes={"telemetry.sanitization.failed": True},
        kind=span.kind,
        status=Status(span.status.status_code),
        start_time=span.start_time,
        end_time=span.end_time,
        instrumentation_scope=span.instrumentation_scope,
    )


def sanitize_readable_log(record: ReadableLogRecord) -> ReadableLogRecord:
    """Clone a finished log record with its body and attributes sanitized."""
    source = record.log_record
    return ReadableLogRecord(
        log_record=LogRecord(
            timestamp=source.timestamp,
            observed_timestamp=source.observed_timestamp,
            context=source.context,
            trace_id=source.trace_id,
            span_id=source.span_id,
            trace_flags=source.trace_flags,
            severity_text=(
                sanitize_text_for_telemetry(source.severity_text)
                if source.severity_text
                else None
            ),
            severity_number=source.severity_number,
            body=_sanitize_log_body(source.body),
            attributes=_sanitize_attributes(source.attributes),
            event_name=(
                sanitize_text_for_telemetry(source.event_name)
                if source.event_name
                else None
            ),
        ),
        resource=_sanitize_resource(record.resource),
        instrumentation_scope=record.instrumentation_scope,
        limits=record.limits,
    )


def _failed_log(record: ReadableLogRecord) -> ReadableLogRecord:
    source = record.log_record
    return ReadableLogRecord(
        log_record=LogRecord(
            timestamp=source.timestamp,
            observed_timestamp=source.observed_timestamp,
            context=source.context,
            trace_id=source.trace_id,
            span_id=source.span_id,
            trace_flags=source.trace_flags,
            severity_number=source.severity_number,
            body=_SANITIZATION_FAILED,
            attributes={"telemetry.sanitization.failed": True},
        ),
        resource=Resource({}),
        instrumentation_scope=record.instrumentation_scope,
        limits=record.limits,
    )


class SanitizingSpanExporter(SpanExporter):
    """Sanitize immutable finished spans immediately before OTLP serialization."""

    def __init__(self, delegate: SpanExporter) -> None:
        self._delegate = delegate

    def export(self, spans: Sequence[ReadableSpan]):  # noqa: ANN201
        sanitized: list[ReadableSpan] = []
        for span in spans:
            try:
                sanitized.append(sanitize_readable_span(span))
            except Exception:  # noqa: BLE001
                sanitized.append(_failed_span(span))
        return self._delegate.export(tuple(sanitized))

    def shutdown(self) -> None:
        self._delegate.shutdown()

    def force_flush(self, timeout_millis: int = 30000) -> bool:
        result = self._delegate.force_flush(timeout_millis=timeout_millis)
        return True if result is None else bool(result)


class SanitizingLogExporter(LogRecordExporter):
    """Sanitize immutable finished log records before OTLP serialization."""

    def __init__(self, delegate: LogRecordExporter) -> None:
        self._delegate = delegate

    def export(self, batch: Sequence[ReadableLogRecord]):  # noqa: ANN201
        sanitized: list[ReadableLogRecord] = []
        for record in batch:
            try:
                sanitized.append(sanitize_readable_log(record))
            except Exception:  # noqa: BLE001
                sanitized.append(_failed_log(record))
        return self._delegate.export(tuple(sanitized))

    def shutdown(self) -> None:
        self._delegate.shutdown()


__all__ = [
    "SanitizingLogExporter",
    "SanitizingSpanExporter",
    "sanitize_readable_log",
    "sanitize_readable_span",
]

"""Regression coverage for the final OpenTelemetry export boundary."""

from __future__ import annotations

import json
import os
import sys


root = os.path.join(os.path.dirname(__file__), "..")
if root not in sys.path:
    sys.path.insert(0, root)


def test_dapr_activity_post_return_output_is_sanitized_before_export():
    from dapr_agents.observability.wrappers.workflow_task import (
        WorkflowActivityRegistrationWrapper,
    )
    from opentelemetry import trace
    from opentelemetry.sdk.trace import TracerProvider
    from opentelemetry.sdk.trace.export import SimpleSpanProcessor
    from opentelemetry.sdk.trace.export.in_memory_span_exporter import (
        InMemorySpanExporter,
    )

    from src.telemetry.sanitizing_exporter import SanitizingSpanExporter

    payload = "c2NyZWVuc2hvdC1ieXRlcw=="
    data_uri = f"data:image/png;base64,{payload}"
    signed_url = (
        "https://artifact-user:artifact-password@artifacts.example/"
        "runs/exec-1/screenshots/frame.png?response-content-type=image%2Fpng&"
        "X-Amz-Signature=secret-signature&access_token=secret-token"
    )
    result = {
        "content": [
            {
                "type": "image_url",
                "image_url": {
                    "url": data_uri,
                    "storageRef": "browser-artifacts/exec-1/frame.png",
                },
            },
            {
                "type": "input_audio",
                "input_audio": {"data": payload, "format": "wav"},
            },
        ],
        "artifactUrl": signed_url,
        "Authorization": "Bearer secret-bearer",
    }

    delegate = InMemorySpanExporter()
    provider = TracerProvider()
    provider.add_span_processor(SimpleSpanProcessor(SanitizingSpanExporter(delegate)))
    tracer = provider.get_tracer("test.sanitizing-exporter")

    class TestAgent:
        name = "test-agent"

        def run_tool(self, _ctx, _request):
            trace.get_current_span().add_event(
                "tool.output",
                {
                    "result": json.dumps(result),
                    "authorization": "Authorization: Bearer secret-bearer",
                },
            )
            return result

    wrapped = WorkflowActivityRegistrationWrapper(tracer)._wrap_activity(
        TestAgent().run_tool
    )
    returned = wrapped(
        None,
        {
            "artifactUrl": signed_url,
            "accessToken": "camel-access-token",
            "refreshToken": "camel-refresh-token",
            "authToken": "camel-auth-token",
        },
    )

    # The exporter adapter must never mutate provider or durable return values.
    assert returned is result
    assert returned["content"][0]["image_url"]["url"] == data_uri
    assert returned["content"][1]["input_audio"]["data"] == payload

    spans = delegate.get_finished_spans()
    assert len(spans) == 1
    span = spans[0]
    assert span.name == "test-agent.run_tool"
    exported = json.dumps(dict(span.attributes), sort_keys=True)
    exported_events = json.dumps(
        [dict(event.attributes or {}) for event in span.events], sort_keys=True
    )

    for safe_export in (exported, exported_events):
        assert payload not in safe_export
        assert "data:image" not in safe_export
        assert "secret-signature" not in safe_export
        assert "secret-token" not in safe_export
        assert "secret-bearer" not in safe_export
        assert "artifact-password" not in safe_export
        assert "REDACTED_INLINE_MEDIA" in safe_export

    assert "artifacts.example" in exported
    assert "/runs/exec-1/screenshots/frame.png" in exported
    assert "response-content-type" in exported
    assert "browser-artifacts/exec-1/frame.png" in exported
    assert "camel-access-token" not in exported
    assert "camel-refresh-token" not in exported
    assert "camel-auth-token" not in exported


def test_exporter_default_string_fallback_is_sanitized_again():
    from opentelemetry.sdk.trace import ReadableSpan

    from src.telemetry.sanitizing_exporter import sanitize_readable_span

    class OpaqueArtifact:
        def __str__(self) -> str:
            return (
                "https://artifacts.example/run/frame.png?"
                "X-Amz-Signature=opaque-signature"
            )

    sanitized = sanitize_readable_span(
        ReadableSpan(name="opaque", attributes={"artifact": OpaqueArtifact()})
    )
    value = sanitized.attributes["artifact"]

    assert "opaque-signature" not in value
    assert "artifacts.example/run/frame.png" in value
    assert "X-Amz-Signature" in value


def test_export_boundary_redacts_scalar_sensitive_attributes_by_key():
    from opentelemetry.sdk.resources import Resource
    from opentelemetry.sdk.trace import Event, ReadableSpan
    from opentelemetry.trace import Link, SpanContext, TraceFlags

    from src.telemetry.sanitizing_exporter import sanitize_readable_span

    link_context = SpanContext(
        trace_id=1,
        span_id=2,
        is_remote=False,
        trace_flags=TraceFlags.SAMPLED,
    )
    sanitized = sanitize_readable_span(
        ReadableSpan(
            name="sensitive-attributes",
            attributes={"accessToken": "raw-span-access-token"},
            events=(
                Event(
                    "credentials",
                    attributes={"authorization": "raw-event-authorization"},
                ),
            ),
            links=(Link(link_context, attributes={"x-api-key": "raw-link-key"}),),
            resource=Resource({"refreshToken": "raw-resource-refresh-token"}),
        )
    )

    serialized = json.dumps(
        {
            "attributes": dict(sanitized.attributes or {}),
            "events": [dict(event.attributes or {}) for event in sanitized.events],
            "links": [dict(link.attributes or {}) for link in sanitized.links],
            "resource": dict(sanitized.resource.attributes),
        },
        sort_keys=True,
    )
    for secret in (
        "raw-span-access-token",
        "raw-event-authorization",
        "raw-link-key",
        "raw-resource-refresh-token",
    ):
        assert secret not in serialized
    assert serialized.count("[REDACTED]") == 4


def test_log_export_boundary_sanitizes_body_and_attributes():
    from opentelemetry._logs import LogRecord
    from opentelemetry.sdk._logs import ReadableLogRecord
    from opentelemetry.sdk._logs.export import InMemoryLogRecordExporter
    from opentelemetry.sdk.resources import Resource

    from src.telemetry.sanitizing_exporter import SanitizingLogExporter

    payload = "c2NyZWVuc2hvdC1ieXRlcw=="

    class OpaqueLogValue:
        def __str__(self) -> str:
            return (
                "https://artifacts.example/opaque.png?"
                "X-Amz-Signature=opaque-log-signature"
            )

    delegate = InMemoryLogRecordExporter()
    exporter = SanitizingLogExporter(delegate)
    exporter.export(
        [
            ReadableLogRecord(
                log_record=LogRecord(
                    body={
                        "image": f"data:image/png;base64,{payload}",
                        "url": (
                            "https://artifacts.example/frame.png?"
                            "X-Amz-Signature=log-signature"
                        ),
                        "opaque": OpaqueLogValue(),
                    },
                    attributes={
                        "authorization": "Authorization: Bearer log-bearer",
                        "authToken": "raw-log-auth-token",
                    },
                ),
                resource=Resource.create(
                    {
                        "service.name": "test",
                        "accessToken": "raw-log-resource-token",
                    }
                ),
            )
        ]
    )

    exported = delegate.get_finished_logs()[0].log_record
    serialized = json.dumps(
        {
            "body": exported.body,
            "attributes": dict(exported.attributes or {}),
            "resource": dict(delegate.get_finished_logs()[0].resource.attributes),
        },
        sort_keys=True,
    )
    assert payload not in serialized
    assert "data:image" not in serialized
    assert "log-signature" not in serialized
    assert "opaque-log-signature" not in serialized
    assert "log-bearer" not in serialized
    assert "raw-log-auth-token" not in serialized
    assert "raw-log-resource-token" not in serialized
    assert "REDACTED_INLINE_MEDIA" in serialized
    assert "artifacts.example/frame.png" in serialized
    assert "artifacts.example/opaque.png" in serialized

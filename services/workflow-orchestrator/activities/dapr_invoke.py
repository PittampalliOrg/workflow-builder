"""Shared Dapr service invocation helper.

Wraps DaprClient().invoke_method() to return a (status_code, json_body, raw_text)
tuple, mirroring the httpx/requests response signature callers already expect.
"""

from __future__ import annotations

import json

from dapr.clients import DaprClient
from content_tracing import io_attributes


def _set_span_attrs(span, attributes: dict | None) -> None:
    if not span or not attributes:
        return
    for key, value in attributes.items():
        if value is None:
            continue
        try:
            span.set_attribute(str(key), value)
        except Exception:
            pass


def _dapr_invoke_span(app_id: str, method_name: str, payload: dict):
    try:
        from opentelemetry import trace

        tracer = trace.get_tracer("workflow-orchestrator.dapr-invoke")
        span = tracer.start_span(f"dapr.invoke {app_id}/{method_name}")
        _set_span_attrs(
            span,
            {
                "dapr.operation": "dapr.service.invoke",
                "dapr.target_service": app_id,
                "dapr.method": method_name,
                "http.request.method": "POST",
                **io_attributes(
                    "input",
                    {
                        "app_id": app_id,
                        "method": method_name,
                        "body": payload,
                    },
                ),
            },
        )
        return span
    except Exception:
        return None


def dapr_invoke(
    app_id: str,
    method_name: str,
    payload: dict,
    *,
    timeout: int = 300,
    metadata: dict[str, str] | None = None,
) -> tuple[int, dict, str]:
    """Invoke a Dapr service method, returning (status_code, json_body, raw_text).

    All exceptions (timeouts, transport errors, HTTP errors raised by the SDK)
    are normalized to (500, {"error": msg}, msg). Callers that need to
    distinguish timeouts can pattern-match on the error string.
    """
    span = _dapr_invoke_span(app_id, method_name, payload)
    dapr_metadata = (
        tuple((str(k), str(v)) for k, v in metadata.items() if v)
        if isinstance(metadata, dict)
        else None
    )
    try:
        with DaprClient() as client:
            response = client.invoke_method(
                app_id=app_id,
                method_name=method_name,
                data=json.dumps(payload),
                http_verb="POST",
                timeout=timeout,
                metadata=dapr_metadata,
            )
            text = response.text() if hasattr(response, "text") else response.data.decode("utf-8")
            try:
                body = json.loads(text) if text else {}
            except (json.JSONDecodeError, ValueError):
                body = {}
            _set_span_attrs(
                span,
                {
                    "http.response.status_code": 200,
                    **io_attributes(
                        "output",
                        {
                            "status": 200,
                            "body": body if body else text,
                        },
                    ),
                },
            )
            return 200, body, text
    except Exception as exc:
        error_msg = str(exc)
        _set_span_attrs(
            span,
            {
                "http.response.status_code": 500,
                "error.message": error_msg[:500],
                **io_attributes(
                    "output",
                    {
                        "status": 500,
                        "error": error_msg,
                    },
                ),
            },
        )
        try:
            from opentelemetry.trace import Status, StatusCode

            if span:
                span.record_exception(exc)
                span.set_status(Status(StatusCode.ERROR, error_msg[:500]))
        except Exception:
            pass
        return 500, {"error": error_msg}, error_msg
    finally:
        if span:
            try:
                span.end()
            except Exception:
                pass


def dapr_invoke_or_raise(
    app_id: str,
    method_name: str,
    payload: dict,
    *,
    timeout: int = 300,
    service_label: str = "",
    metadata: dict[str, str] | None = None,
) -> dict:
    """Invoke a Dapr service method, returning the JSON body or raising RuntimeError."""
    status, body, text = dapr_invoke(
        app_id,
        method_name,
        payload,
        timeout=timeout,
        metadata=metadata,
    )
    if status >= 400:
        body_preview = text[:1200] if text else "<empty>"
        raise RuntimeError(
            f"{service_label} failed with HTTP {status}: {body_preview}"
        )
    if not isinstance(body, dict):
        raise RuntimeError(
            f"{service_label} returned invalid response type: {type(body).__name__}"
        )
    return body

"""Shared Dapr service invocation helper.

Wraps DaprClient().invoke_method() to return a (status_code, json_body, raw_text)
tuple, mirroring the httpx/requests response signature callers already expect.
"""

from __future__ import annotations

import json

from dapr.clients import DaprClient


def dapr_invoke(
    app_id: str,
    method_name: str,
    payload: dict,
    *,
    timeout: int = 300,
) -> tuple[int, dict, str]:
    """Invoke a Dapr service method, returning (status_code, json_body, raw_text).

    All exceptions (timeouts, transport errors, HTTP errors raised by the SDK)
    are normalized to (500, {"error": msg}, msg). Callers that need to
    distinguish timeouts can pattern-match on the error string.
    """
    try:
        with DaprClient() as client:
            response = client.invoke_method(
                app_id=app_id,
                method_name=method_name,
                data=json.dumps(payload),
                http_verb="POST",
                timeout=timeout,
            )
            text = response.text() if hasattr(response, "text") else response.data.decode("utf-8")
            try:
                body = json.loads(text) if text else {}
            except (json.JSONDecodeError, ValueError):
                body = {}
            return 200, body, text
    except Exception as exc:
        error_msg = str(exc)
        return 500, {"error": error_msg}, error_msg


def dapr_invoke_or_raise(
    app_id: str,
    method_name: str,
    payload: dict,
    *,
    timeout: int = 300,
    service_label: str = "",
) -> dict:
    """Invoke a Dapr service method, returning the JSON body or raising RuntimeError."""
    status, body, text = dapr_invoke(app_id, method_name, payload, timeout=timeout)
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

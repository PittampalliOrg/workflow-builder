"""HTTP hook executor.

Ported from claude-code-src/main/utils/hooks/execHttpHook.ts.

POSTs JSON input to an external URL and parses the JSON response.
"""

from __future__ import annotations

import json
import logging
import os
import urllib.request
from typing import Any

from ..helpers import (
    hook_result_from_output,
    parse_hook_json_output,
)
from ..types import (
    HttpHookConfig,
    HookOutcome,
    HookResult,
)

logger = logging.getLogger(__name__)

DEFAULT_HTTP_TIMEOUT = 30  # seconds


def _interpolate_headers(
    headers: dict[str, str],
    allowed_env_vars: tuple[str, ...],
) -> dict[str, str]:
    """Interpolate $VAR_NAME references in header values.

    Only variables listed in *allowed_env_vars* are substituted.
    """
    result: dict[str, str] = {}
    for key, value in headers.items():
        for var in allowed_env_vars:
            placeholder = f"${var}"
            if placeholder in value:
                value = value.replace(placeholder, os.environ.get(var, ""))
        result[key] = value
    return result


def exec_http_hook(
    hook: HttpHookConfig,
    input_json: str,
    *,
    timeout: int | None = None,
) -> HookResult:
    """Execute an HTTP POST hook synchronously."""
    effective_timeout = timeout or hook.timeout or DEFAULT_HTTP_TIMEOUT
    url = hook.url

    if not url:
        return HookResult(outcome=HookOutcome.NON_BLOCKING_ERROR)

    headers = _interpolate_headers(hook.headers, hook.allowed_env_vars)
    headers.setdefault("Content-Type", "application/json")

    req = urllib.request.Request(
        url,
        data=input_json.encode("utf-8"),
        headers=headers,
        method="POST",
    )

    try:
        with urllib.request.urlopen(req, timeout=effective_timeout) as resp:
            body = resp.read().decode("utf-8", errors="replace")
    except Exception as exc:
        logger.warning("HTTP hook failed: %s — %s", url, exc)
        return HookResult(outcome=HookOutcome.NON_BLOCKING_ERROR)

    output = parse_hook_json_output(body)
    return hook_result_from_output(output, command_desc=f"http:{url}")

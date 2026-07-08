"""Bound every MCP tool call with a total per-request timeout.

The upstream MCP client (dapr-agents 1.0.4 -> mcp SDK 1.27.x) constructs its
``ClientSession`` WITHOUT ``read_timeout_seconds``, and dapr-agents calls
``session.call_tool(...)`` without a per-request timeout. In that configuration
``BaseSession.send_request`` runs ``anyio.fail_after(None)`` -- a no-op -- so a
tool call whose JSON-RPC response never arrives waits forever. The only bound is
httpx's inter-byte read gap (default ~30s), which a server that keeps the
streamable-HTTP / SSE connection alive with keep-alive bytes (while never
delivering the final result) defeats -- the failure mode behind a multi-minute
reviewer wedge on a stalled ``trace_get_logs`` call (dev->hub ClickHouse egress
stalled while the MCP SSE stream stayed open).

This installs a process-wide, idempotent wrapper on ``ClientSession.__init__``
that injects a default ``read_timeout_seconds`` when the caller supplies none.
``BaseSession.send_request`` then applies ``anyio.fail_after(<seconds>)`` to
every request (including ``call_tool``), so a stalled MCP call raises instead of
hanging and surfaces to the agent as a tool error it can react to. Callers that
pass an explicit ``read_timeout_seconds`` (positionally or by keyword) are left
untouched.

Tunable via ``DAPR_AGENT_MCP_TOOL_TIMEOUT_SECONDS`` (default 180). Set it to 0
to disable (restores the unbounded upstream behavior). It is a BACKSTOP against
infinite hangs, not an aggressive cap -- raise it if a runtime hosts legitimate
long-running MCP tools (e.g. lengthy browser flows) that exceed the default.
"""

from __future__ import annotations

import logging
import os
from datetime import timedelta
from typing import Any

logger = logging.getLogger(__name__)

_DEFAULT_TIMEOUT_SECONDS = 180.0
_ENV_VAR = "DAPR_AGENT_MCP_TOOL_TIMEOUT_SECONDS"
_PATCH_FLAG = "_dapr_agent_py_tool_timeout_seconds"
_WRAPPED_ATTR = "__wrapped_init__"


def resolve_timeout_seconds(override: float | None = None) -> float:
    """Resolve the configured MCP tool-call timeout (seconds).

    ``override`` wins; otherwise ``DAPR_AGENT_MCP_TOOL_TIMEOUT_SECONDS``;
    otherwise the module default. A non-numeric env value falls back to the
    default. A value <= 0 means "disabled".
    """
    if override is not None:
        return float(override)
    raw = (os.environ.get(_ENV_VAR) or "").strip()
    if not raw:
        return _DEFAULT_TIMEOUT_SECONDS
    try:
        return float(raw)
    except ValueError:
        return _DEFAULT_TIMEOUT_SECONDS


def _make_patched_init(base_init: Any, default_td: timedelta) -> Any:
    def patched_init(self: Any, *args: Any, **kwargs: Any) -> Any:
        # ClientSession.__init__(self, read_stream, write_stream,
        #   read_timeout_seconds=None, ...). Inject our default only when the
        # caller passed neither the keyword nor a 3rd positional arg.
        if "read_timeout_seconds" not in kwargs and len(args) < 3:
            kwargs["read_timeout_seconds"] = default_td
        return base_init(self, *args, **kwargs)

    setattr(patched_init, _WRAPPED_ATTR, base_init)
    return patched_init


def _patch_class(cls: Any, resolved: float) -> bool:
    """Apply/refresh/remove the timeout wrapper on ``cls.__init__``.

    Idempotent: re-installing with the same resolved value is a no-op; a
    different value unwraps the prior patch before re-patching (never nests).
    Returns True if a default timeout is now enforced on ``cls``.
    """
    original = cls.__init__
    if getattr(original, _PATCH_FLAG, None) == resolved:
        return resolved > 0
    base = getattr(original, _WRAPPED_ATTR, original)

    if resolved <= 0:
        if original is not base:
            cls.__init__ = base  # type: ignore[method-assign]
        return False

    patched = _make_patched_init(base, timedelta(seconds=resolved))
    setattr(patched, _PATCH_FLAG, resolved)
    cls.__init__ = patched  # type: ignore[method-assign]
    return True


def install_mcp_tool_call_timeout(timeout_seconds: float | None = None) -> bool:
    """Idempotently bound MCP requests with a session read timeout.

    Returns True if a default timeout is now enforced, False if disabled
    (resolved <= 0) or the mcp SDK is unavailable.
    """
    resolved = resolve_timeout_seconds(timeout_seconds)
    try:
        from mcp.client.session import ClientSession
    except Exception as exc:  # noqa: BLE001
        logger.debug("[mcp-timeout] mcp SDK unavailable, skipping install: %s", exc)
        return False

    already = getattr(ClientSession.__init__, _PATCH_FLAG, None)
    enforced = _patch_class(ClientSession, resolved)
    if already == resolved:
        return enforced
    if enforced:
        logger.info(
            "[mcp-timeout] MCP tool-call timeout enforced: %.1fs (env %s; backstop against unbounded streamable-HTTP hangs)",
            resolved,
            _ENV_VAR,
        )
    else:
        logger.info("[mcp-timeout] MCP tool-call timeout disabled (%s<=0)", _ENV_VAR)
    return enforced

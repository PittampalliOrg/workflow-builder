"""Retry helpers for MCP client startup.

Generated piece MCP services are Knative services and may need a short cold
start window before accepting streamable HTTP sessions. Keep retry policy
centralized so startup and per-instance MCP wiring behave consistently.
"""

from __future__ import annotations

import asyncio
import inspect
import logging
import os
from collections.abc import Awaitable, Callable, Mapping
from typing import Any


ClientFactory = Callable[[], Any]
SleepFn = Callable[[float], Awaitable[Any]]


def _positive_int_env(name: str, default: int) -> int:
    raw = (os.environ.get(name) or "").strip()
    if not raw:
        return default
    try:
        value = int(raw)
    except ValueError:
        return default
    return value if value > 0 else default


def _nonnegative_float_env(name: str, default: float) -> float:
    raw = (os.environ.get(name) or "").strip()
    if not raw:
        return default
    try:
        value = float(raw)
    except ValueError:
        return default
    return value if value >= 0 else default


async def _close_client(client: Any, logger: logging.Logger) -> None:
    close = getattr(client, "close", None)
    if not callable(close):
        return
    try:
        result = close()
        if inspect.isawaitable(result):
            await result
    except Exception as exc:  # noqa: BLE001
        logger.debug("[mcp] failed to close MCP client after connect attempt: %s", exc)


def _tool_count(client: Any) -> int:
    get_all_tools = getattr(client, "get_all_tools", None)
    if not callable(get_all_tools):
        return 0
    tools = get_all_tools()
    if tools is None:
        return 0
    try:
        return len(tools)
    except TypeError:
        return sum(1 for _ in tools)


async def connect_mcp_client_with_retries(
    configs: Mapping[str, Any],
    *,
    client_factory: ClientFactory,
    logger: logging.Logger | None = None,
    context: str = "instance",
    max_attempts: int | None = None,
    initial_delay_seconds: float | None = None,
    max_delay_seconds: float = 10.0,
    retry_empty_tools: bool = True,
    sleep: SleepFn = asyncio.sleep,
) -> Any:
    """Create and connect an MCP client, retrying transient cold-start misses.

    A successful MCP initialize call that returns zero tools is also retried by
    default. The runtime only exposes MCP tools to the LLM, so an empty tool
    surface after connect is usually as harmful as a connect failure.
    """

    log = logger or logging.getLogger(__name__)
    # Ensure every MCP tool call is bounded by a total per-request timeout before
    # we connect any client. Upstream leaves ClientSession.read_timeout_seconds
    # unset, so a stalled streamable-HTTP response (e.g. a slow trace tool whose
    # SSE stream stays open) would otherwise hang the run_tool activity forever.
    # Idempotent: the class is patched once for the process.
    try:
        from src.mcp_tool_timeout import install_mcp_tool_call_timeout

        install_mcp_tool_call_timeout()
    except Exception as exc:  # noqa: BLE001
        log.debug("[mcp] could not install MCP tool-call timeout: %s", exc)
    attempts = (
        max_attempts
        if max_attempts is not None
        else _positive_int_env("DAPR_AGENT_PY_MCP_CONNECT_ATTEMPTS", 4)
    )
    attempts = max(1, int(attempts))
    initial_delay = (
        initial_delay_seconds
        if initial_delay_seconds is not None
        else _nonnegative_float_env("DAPR_AGENT_PY_MCP_CONNECT_RETRY_DELAY_SECONDS", 2.0)
    )
    initial_delay = max(0.0, float(initial_delay))
    max_delay = max(initial_delay, float(max_delay_seconds))
    server_count = len(configs)

    for attempt in range(1, attempts + 1):
        client = client_factory()
        try:
            await client.connect_from_config(dict(configs))
            tools = _tool_count(client)
            if not retry_empty_tools or tools > 0 or attempt == attempts:
                if retry_empty_tools and tools == 0:
                    log.warning(
                        "[mcp] MCP connect completed with 0 tool(s) after %d attempt(s) for %s",
                        attempt,
                        context,
                    )
                return client

            await _close_client(client, log)
            delay = min(max_delay, initial_delay * attempt)
            log.warning(
                "[mcp] MCP connect attempt %d/%d for %s returned 0 tool(s) from %d server(s); retrying in %.1fs",
                attempt,
                attempts,
                context,
                server_count,
                delay,
            )
        except Exception as exc:  # noqa: BLE001
            await _close_client(client, log)
            if attempt == attempts:
                raise
            delay = min(max_delay, initial_delay * attempt)
            log.warning(
                "[mcp] MCP connect attempt %d/%d failed for %s (%d server(s)): %s; retrying in %.1fs",
                attempt,
                attempts,
                context,
                server_count,
                exc,
                delay,
            )

        if delay > 0:
            await sleep(delay)

    raise RuntimeError("MCP connect retry loop exhausted unexpectedly")

from __future__ import annotations

import asyncio
import os
from collections.abc import AsyncIterable, Awaitable, Callable, Mapping
from typing import Optional, TypeVar


DEFAULT_WS_MAX_MESSAGE_BYTES = 16 * 1024 * 1024
MAX_WS_MAX_MESSAGE_BYTES = 32 * 1024 * 1024
WS_MAX_MESSAGE_BYTES_ENV = "BROWSERSTATION_WS_MAX_MESSAGE_BYTES"
DEFAULT_WS_MAX_QUEUE = 1
MAX_WS_MAX_QUEUE = 4
WS_MAX_QUEUE_ENV = "BROWSERSTATION_WS_MAX_QUEUE"
MAX_WS_DECODED_BUFFER_BYTES = 128 * 1024 * 1024

CLIENT_TO_UPSTREAM = "client_to_upstream"
UPSTREAM_TO_CLIENT = "upstream_to_client"

Message = TypeVar("Message")


def _bounded_positive_int(
    *,
    environ: Mapping[str, str],
    name: str,
    default: int,
    maximum: int,
) -> int:
    raw_value = environ.get(name, str(default))
    try:
        value = int(raw_value)
    except ValueError as exc:
        raise ValueError(f"{name} must be an integer") from exc
    if value <= 0 or value > maximum:
        raise ValueError(f"{name} must be between 1 and {maximum}")
    return value


def websocket_max_message_bytes(
    environ: Optional[Mapping[str, str]] = None,
) -> int:
    """Return the bounded Chrome-to-proxy websocket frame limit."""
    values = os.environ if environ is None else environ
    return _bounded_positive_int(
        environ=values,
        name=WS_MAX_MESSAGE_BYTES_ENV,
        default=DEFAULT_WS_MAX_MESSAGE_BYTES,
        maximum=MAX_WS_MAX_MESSAGE_BYTES,
    )


def websocket_max_queue(environ: Optional[Mapping[str, str]] = None) -> int:
    """Return the bounded number of decoded Chrome frames buffered per lane."""
    values = os.environ if environ is None else environ
    return _bounded_positive_int(
        environ=values,
        name=WS_MAX_QUEUE_ENV,
        default=DEFAULT_WS_MAX_QUEUE,
        maximum=MAX_WS_MAX_QUEUE,
    )


def websocket_limits(
    environ: Optional[Mapping[str, str]] = None,
) -> tuple[int, int]:
    """Return frame and queue bounds under one decoded-memory budget."""
    values = os.environ if environ is None else environ
    max_message_bytes = websocket_max_message_bytes(values)
    max_queue = websocket_max_queue(values)
    # websockets 11 can use up to four bytes per decoded text character.
    decoded_buffer_bytes = 4 * max_message_bytes * max_queue
    if decoded_buffer_bytes > MAX_WS_DECODED_BUFFER_BYTES:
        raise ValueError(
            f"websocket receive buffer exceeds {MAX_WS_DECODED_BUFFER_BYTES} bytes"
        )
    return max_message_bytes, max_queue


async def _cancel_and_wait(tasks: set[asyncio.Task[None]]) -> None:
    for task in tasks:
        if not task.done():
            task.cancel()
    if tasks:
        await asyncio.gather(*tasks, return_exceptions=True)


async def relay_websocket_messages(
    *,
    receive_client: Callable[[], Awaitable[Message]],
    send_upstream: Callable[[Message], Awaitable[None]],
    upstream_messages: AsyncIterable[Message],
    send_client: Callable[[Message], Awaitable[None]],
) -> frozenset[str]:
    """Relay both directions until either side ends, then stop its sibling."""

    async def client_to_upstream() -> None:
        while True:
            await send_upstream(await receive_client())

    async def upstream_to_client() -> None:
        async for message in upstream_messages:
            await send_client(message)

    tasks = {
        CLIENT_TO_UPSTREAM: asyncio.create_task(
            client_to_upstream(), name=CLIENT_TO_UPSTREAM
        ),
        UPSTREAM_TO_CLIENT: asyncio.create_task(
            upstream_to_client(), name=UPSTREAM_TO_CLIENT
        ),
    }
    try:
        done, pending = await asyncio.wait(
            set(tasks.values()), return_when=asyncio.FIRST_COMPLETED
        )
        await _cancel_and_wait(pending)

        # Retrieve results after the sibling has stopped so an exception in one
        # direction cannot strand the other direction in a receive call.
        for task in done:
            task.result()
        return frozenset(name for name, task in tasks.items() if task in done)
    finally:
        await _cancel_and_wait(set(tasks.values()))

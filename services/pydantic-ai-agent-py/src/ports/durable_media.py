"""Port for keeping binary media out of durable workflow payloads."""

from __future__ import annotations

from typing import Any, Protocol


class DurableMediaPort(Protocol):
    """Externalize and restore Pydantic AI message media."""

    async def externalize(
        self, node: Any, *, preserve_references: bool = False
    ) -> Any: ...

    async def restore(
        self,
        node: Any,
        *,
        max_media_items: int | None = None,
        max_request_images: int | None = None,
        max_request_bytes: int | None = None,
    ) -> Any: ...

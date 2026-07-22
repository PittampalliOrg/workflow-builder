"""Port for measuring the runtime's durable transport representation."""

from __future__ import annotations

from typing import Any, Protocol


class DurablePayloadCodecPort(Protocol):
    def size_bytes(self, payload: Any) -> int: ...

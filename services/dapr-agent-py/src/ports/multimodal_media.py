"""Port for moving visual media out of durable workflow payloads."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Protocol


@dataclass(frozen=True)
class OffloadedMediaReference:
    """Provider-readable media reference safe to persist in workflow history."""

    uri: str
    provider: str
    file_id: str
    media_type: str
    size_bytes: int
    sha256: str


class MultimodalMediaOffloadPort(Protocol):
    """Store image bytes and return a compact provider-readable reference."""

    def upload_image(
        self,
        image: bytes,
        media_type: str,
        *,
        label: str | None = None,
    ) -> OffloadedMediaReference: ...

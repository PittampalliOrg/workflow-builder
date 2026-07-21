"""Application port for reading workspace images as bounded model input."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Protocol


class WorkspaceImageError(ValueError):
    """A workspace path cannot be delivered as a bounded image."""


@dataclass(frozen=True)
class WorkspaceImage:
    data: bytes
    media_type: str
    source_path: str
    original_size: tuple[int, int]
    delivered_size: tuple[int, int]
    mode: str


class WorkspaceImagePort(Protocol):
    """Read and transform an image without exposing filesystem/Pillow details."""

    def read_image(
        self,
        path: str,
        *,
        region: dict[str, int] | None = None,
        full_resolution: bool = False,
    ) -> WorkspaceImage: ...

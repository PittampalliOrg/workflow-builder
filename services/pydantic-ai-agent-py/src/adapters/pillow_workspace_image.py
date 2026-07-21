"""Confined local-filesystem/Pillow adapter for workspace image input."""

from __future__ import annotations

import io
import os
import stat
from pathlib import Path
from typing import Any

from src.ports.workspace_image import (
    WorkspaceImage,
    WorkspaceImageError,
    WorkspaceImagePort,
)

_MAX_FILE_BYTES = 100 * 1024 * 1024
_MAX_IMAGE_PIXELS = 25_000_000
_LONG_EDGE_PX = 1568
_IMAGE_MEDIA_TYPES = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".gif": "image/gif",
}


def _region_box(region: dict[str, int], width: int, height: int) -> tuple[int, ...]:
    required = {"x", "y", "width", "height"}
    if set(region) != required or any(
        isinstance(region[key], bool) or not isinstance(region[key], int)
        for key in required
    ):
        raise WorkspaceImageError(
            "region must contain only integer x, y, width, and height"
        )
    if region["x"] < 0 or region["y"] < 0:
        raise WorkspaceImageError("region x and y must be non-negative")
    if region["width"] <= 0 or region["height"] <= 0:
        raise WorkspaceImageError("region width and height must be positive")
    left = min(region["x"], width)
    top = min(region["y"], height)
    right = min(region["x"] + region["width"], width)
    bottom = min(region["y"] + region["height"], height)
    if right <= left or bottom <= top:
        raise WorkspaceImageError(f"region lies outside the {width}x{height} image")
    return left, top, right, bottom


def _encode_image(image: Any, source_type: str) -> tuple[bytes, str]:
    output = io.BytesIO()
    if source_type == "image/jpeg":
        image.convert("RGB").save(output, format="JPEG", quality=88)
        return output.getvalue(), "image/jpeg"
    if image.mode not in ("RGB", "RGBA", "L"):
        image = image.convert("RGBA" if "A" in (image.mode or "") else "RGB")
    image.save(output, format="PNG")
    return output.getvalue(), "image/png"


class PillowWorkspaceImageAdapter(WorkspaceImagePort):
    """Read regular image files through a confined file descriptor."""

    def __init__(self, workspace_root: str | Path) -> None:
        self._root = Path(workspace_root).resolve()

    def _read_confined(self, raw_path: str) -> tuple[Path, bytes]:
        candidate = Path(raw_path).expanduser()
        if not candidate.is_absolute():
            candidate = self._root / candidate
        try:
            resolved = candidate.resolve(strict=True)
            resolved.relative_to(self._root)
        except (OSError, ValueError) as exc:
            raise WorkspaceImageError(
                "path must exist and remain inside the agent workspace"
            ) from exc

        flags = os.O_RDONLY | getattr(os, "O_CLOEXEC", 0) | getattr(os, "O_NOFOLLOW", 0)
        try:
            fd = os.open(resolved, flags)
        except OSError as exc:
            raise WorkspaceImageError(f"could not open {resolved}: {exc}") from exc
        try:
            opened = Path(f"/proc/self/fd/{fd}").resolve(strict=True)
            try:
                opened.relative_to(self._root)
            except ValueError as exc:
                raise WorkspaceImageError(
                    "path changed while opening and left the agent workspace"
                ) from exc
            file_stat = os.fstat(fd)
            if not stat.S_ISREG(file_stat.st_mode):
                raise WorkspaceImageError("path must name a regular file")
            if file_stat.st_size <= 0 or file_stat.st_size > _MAX_FILE_BYTES:
                raise WorkspaceImageError(
                    f"file is {file_stat.st_size} bytes; the limit is 100 MB"
                )
            chunks: list[bytes] = []
            remaining = _MAX_FILE_BYTES + 1
            while remaining > 0:
                chunk = os.read(fd, min(1024 * 1024, remaining))
                if not chunk:
                    break
                chunks.append(chunk)
                remaining -= len(chunk)
            payload = b"".join(chunks)
            if len(payload) > _MAX_FILE_BYTES:
                raise WorkspaceImageError("file grew beyond the 100 MB limit")
            return opened, payload
        finally:
            os.close(fd)

    def read_image(
        self,
        path: str,
        *,
        region: dict[str, int] | None = None,
        full_resolution: bool = False,
    ) -> WorkspaceImage:
        resolved, raw = self._read_confined(path)
        source_type = _IMAGE_MEDIA_TYPES.get(resolved.suffix.lower())
        if source_type is None:
            raise WorkspaceImageError(
                "unsupported media type; expected png, jpg, jpeg, webp, or gif"
            )

        from PIL import Image, ImageOps, UnidentifiedImageError

        try:
            with Image.open(io.BytesIO(raw)) as opened:
                opened.seek(0)
                width, height = opened.size
                if width <= 0 or height <= 0 or width * height > _MAX_IMAGE_PIXELS:
                    raise WorkspaceImageError(
                        f"decoded image is {width}x{height}; the limit is "
                        f"{_MAX_IMAGE_PIXELS:,} pixels"
                    )
                image = ImageOps.exif_transpose(opened).copy()
        except WorkspaceImageError:
            raise
        except (UnidentifiedImageError, OSError, ValueError) as exc:
            raise WorkspaceImageError(f"{resolved} is not a readable image: {exc}") from exc

        original_size = image.size
        if region is not None:
            box = _region_box(region, *original_size)
            delivered = image.crop(box)
            mode = (
                f"cropped to region ({box[0]}, {box[1]}, "
                f"{box[2] - box[0]}x{box[3] - box[1]})"
            )
        elif full_resolution or max(image.size) <= _LONG_EDGE_PX:
            delivered = image
            mode = "native resolution" if full_resolution else "untouched"
        else:
            scale = _LONG_EDGE_PX / max(image.size)
            target = (
                max(1, round(image.width * scale)),
                max(1, round(image.height * scale)),
            )
            delivered = image.resize(target, Image.Resampling.LANCZOS)
            mode = "downsampled"

        try:
            payload, output_type = _encode_image(delivered, source_type)
        except (OSError, ValueError) as exc:
            raise WorkspaceImageError(f"could not process {resolved}: {exc}") from exc
        if len(payload) > _MAX_FILE_BYTES:
            raise WorkspaceImageError("processed image exceeds the 100 MB output limit")
        return WorkspaceImage(
            data=payload,
            media_type=output_type,
            source_path=str(resolved),
            original_size=original_size,
            delivered_size=delivered.size,
            mode=mode,
        )

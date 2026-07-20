"""ReadMediaFile tool — read image files into kimi-k3 vision.

Mirrors Moonshot's kimi-code ReadMediaFile
(packages/agent-core-v2/src/agent/media/tools/read-media.ts): large images are
downsampled for the vision limits, an optional region crop is delivered at full
fidelity, and the result's <system> block reports mime type, byte size, original
dimensions, and delivery mode.

Image bytes are returned inside the shared multimodal marker
(src/mcp_multimodal.py) so they survive Dapr's string-only ToolMessage schema
and can be handled uniformly with MCP screenshots. The durable-agent activity
boundary uploads inline images through the multimodal-media port and persists
only the compact Kimi ``ms://`` reference. K3 recovers that reference as a
native image_url part on the next turn.

Image files only. Video upload is not implemented by the current media port.
"""

from __future__ import annotations

import base64
import io
import json
import os
from typing import Any

from pydantic import BaseModel, ConfigDict, Field

from src.mcp_multimodal import _MARKER, _MARKER_VERSION
from src.openshell_runtime import get_runtime
from .._security import expand_path
from .prompt import get_read_media_file_description

# Mirrors kimi-code: refuse files over 100 MB.
_MAX_FILE_BYTES = 100 * 1024 * 1024
# Vision-friendly max long edge for downsampled overviews (matches the common
# 1568px guidance; kimi-code downsamples to fit model limits the same way).
_LONG_EDGE_PX = 1568
_IMAGE_MEDIA_TYPES = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".gif": "image/gif",
}
_VIDEO_EXTENSIONS = {".mp4", ".webm", ".mov", ".mkv", ".avi"}


class ReadMediaFileRegion(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True)

    x: int = Field(
        ge=0, description="Left edge of the crop, in original-image pixels."
    )
    y: int = Field(ge=0, description="Top edge of the crop, in original-image pixels.")
    width: int = Field(gt=0, description="Crop width, in original-image pixels.")
    height: int = Field(gt=0, description="Crop height, in original-image pixels.")


class ReadMediaFileArgs(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True)

    path: str = Field(
        description="Path to the image file to read (png, jpeg, webp, or gif)."
    )
    region: ReadMediaFileRegion | None = Field(
        None,
        description=(
            "Optional crop rectangle in original-image pixels, delivered at full "
            "fidelity. Use after a downsampled overview to inspect fine detail "
            "(small text, dense UI)."
        ),
    )
    full_resolution: bool = Field(
        False,
        description=(
            "Skip the default downscaling and view the whole image at native "
            "resolution."
        ),
    )


def _fmt_bytes(n: int) -> str:
    if n >= 1024 * 1024:
        return f"{n / (1024 * 1024):.1f} MB"
    if n >= 1024:
        return f"{n / 1024:.0f} KB"
    return f"{n} B"


def _downsample(img: Any, width: int, height: int) -> tuple[Any, str]:
    long_edge = max(width, height)
    if long_edge <= _LONG_EDGE_PX:
        return img, "untouched"
    scale = _LONG_EDGE_PX / long_edge
    new_size = (max(1, round(width * scale)), max(1, round(height * scale)))
    from PIL import Image

    return img.resize(new_size, Image.LANCZOS), "downsampled"


def _encode(img: Any, media_type: str) -> tuple[bytes, str]:
    out = io.BytesIO()
    if media_type == "image/jpeg":
        img.convert("RGB").save(out, format="JPEG", quality=88)
        return out.getvalue(), "image/jpeg"
    if img.mode not in ("RGB", "RGBA", "L"):
        img = img.convert("RGBA") if "A" in (img.mode or "") else img.convert("RGB")
    img.save(out, format="PNG")
    return out.getvalue(), "image/png"


def read_media_file(
    path: str,
    region: ReadMediaFileRegion | dict[str, Any] | None = None,
    full_resolution: bool = False,
) -> str:
    """Read an image file and return it as viewable media for the model.

    Returns the multimodal marker JSON (concise text + image block) so the
    image is recovered into kimi-k3's vision on the next turn. All failures
    return "Error: ..." strings (house convention) so the model can correct.
    """
    if not path or not str(path).strip():
        return "Error: No path provided."
    resolved = expand_path(str(path).strip())
    ext = os.path.splitext(resolved)[1].lower()
    if ext in _VIDEO_EXTENSIONS:
        return (
            f"Error: {resolved} is a video file; this ReadMediaFile supports "
            "image files only (video requires the Moonshot file-upload service, "
            "which is not wired in this runtime)."
        )
    media_type = _IMAGE_MEDIA_TYPES.get(ext)
    if media_type is None:
        return (
            f"Error: {resolved} is not a supported image file "
            f"(expected one of: {', '.join(sorted(_IMAGE_MEDIA_TYPES))})."
        )

    runtime = get_runtime()
    try:
        stat = runtime.stat_path(resolved)
    except Exception as exc:  # noqa: BLE001
        return f"Error: could not stat {resolved}: {exc}"
    if not stat.get("ok") or not stat.get("exists"):
        return f"Error: file not found: {resolved}"

    try:
        read = runtime.read_bytes_base64(resolved, max_bytes=_MAX_FILE_BYTES)
    except Exception as exc:  # noqa: BLE001
        return f"Error: could not read {resolved}: {exc}"
    if not read.get("ok"):
        reason = read.get("error") or "unknown"
        if reason == "too_large":
            return f"Error: {resolved} is {read.get('size')} bytes; the limit is 100 MB."
        return f"Error: could not read {resolved}: {reason}"
    try:
        raw = base64.b64decode(read["base64"])
    except Exception as exc:  # noqa: BLE001
        return f"Error: could not decode {resolved}: {exc}"

    from PIL import Image, UnidentifiedImageError

    try:
        img = Image.open(io.BytesIO(raw))
        img.load()
    except (UnidentifiedImageError, OSError, ValueError) as exc:
        return f"Error: {resolved} is not a readable image: {exc}"
    if getattr(img, "is_animated", False):
        img.seek(0)  # first frame only
    orig_w, orig_h = img.size

    if isinstance(region, dict):
        try:
            region = ReadMediaFileRegion(**region)
        except Exception as exc:  # noqa: BLE001
            return f"Error: invalid region: {exc}"

    if region is not None:
        left = max(0, min(region.x, orig_w))
        top = max(0, min(region.y, orig_h))
        right = max(0, min(region.x + region.width, orig_w))
        bottom = max(0, min(region.y + region.height, orig_h))
        if right - left <= 0 or bottom - top <= 0:
            return (
                f"Error: region ({region.x}, {region.y}, {region.width}x"
                f"{region.height}) lies outside the {orig_w}x{orig_h} image."
            )
        deliver = img.crop((left, top, right, bottom))
        mode = f"cropped to region ({left}, {top}, {right - left}x{bottom - top})"
    elif full_resolution:
        deliver = img
        mode = "native resolution"
    else:
        deliver, mode = _downsample(img, orig_w, orig_h)

    try:
        out_bytes, out_mime = _encode(deliver, media_type)
    except Exception as exc:  # noqa: BLE001
        return f"Error: could not encode {resolved}: {exc}"

    out_w, out_h = deliver.size
    if (out_w, out_h) == (orig_w, orig_h):
        dims = f"{orig_w}x{orig_h}"
    else:
        dims = f"{orig_w}x{orig_h} -> {out_w}x{out_h}"
    text = (
        f"Read {resolved}\n"
        f"<system>{out_mime}, {_fmt_bytes(len(out_bytes))}, {dims}, {mode}</system>"
    )

    payload = {
        _MARKER: _MARKER_VERSION,
        "content": [
            {"type": "text", "text": text},
            {
                "type": "image",
                "data": base64.b64encode(out_bytes).decode("ascii"),
                "mimeType": out_mime,
            },
        ],
    }
    return json.dumps(payload, ensure_ascii=False, separators=(",", ":"))


read_media_file.__doc__ = get_read_media_file_description()

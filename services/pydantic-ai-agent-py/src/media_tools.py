"""Application tool that delivers workspace image pixels to Pydantic AI."""

from __future__ import annotations

from typing import Annotated, Any

from pydantic import Field
from pydantic_ai import BinaryContent
from pydantic_ai.toolsets import FunctionToolset

from src.ports.workspace_image import WorkspaceImageError, WorkspaceImagePort

PathArg = Annotated[str, Field(description="Image path inside the agent workspace.")]
RegionArg = Annotated[
    dict[str, int] | None,
    Field(
        description=(
            "Optional crop with integer x, y, width, and height in original-image pixels."
        )
    ),
]
FullResolutionArg = Annotated[
    bool,
    Field(description="View the entire image at native resolution."),
]


def _fmt_bytes(size: int) -> str:
    if size >= 1024 * 1024:
        return f"{size / (1024 * 1024):.1f} MB"
    if size >= 1024:
        return f"{size / 1024:.0f} KB"
    return f"{size} B"


def build_media_toolset(image_reader: WorkspaceImagePort) -> FunctionToolset[Any]:
    """Build the ReadMediaFile tool against the workspace-image port."""

    def read_media_file(
        path: PathArg,
        region: RegionArg = None,
        full_resolution: FullResolutionArg = False,
    ) -> Any:
        """Read an image so the vision model can inspect its actual pixels.

        Large images are downsampled for an overview. Use region with original
        pixel coordinates for fine UI details, or full_resolution for the
        native image. Files larger than 100 MB and video files are rejected.
        """
        if not str(path or "").strip():
            return "Error: No path provided."
        if str(path).lower().endswith((".mp4", ".webm", ".mov", ".mkv", ".avi")):
            return (
                "Error: video input requires a provider Files endpoint, which "
                "is not available on the configured Kimi-for-Coding endpoint."
            )
        try:
            image = image_reader.read_image(
                str(path).strip(),
                region=region,
                full_resolution=full_resolution,
            )
        except WorkspaceImageError as exc:
            return f"Error: could not read {path}: {exc}"

        dimensions = f"{image.original_size[0]}x{image.original_size[1]}"
        if image.delivered_size != image.original_size:
            dimensions += (
                f" -> {image.delivered_size[0]}x{image.delivered_size[1]}"
            )
        description = (
            f"Read {image.source_path}\n"
            f"<system>{image.media_type}, {_fmt_bytes(len(image.data))}, "
            f"{dimensions}, {image.mode}</system>"
        )
        return [
            description,
            BinaryContent(data=image.data, media_type=image.media_type),
        ]

    toolset: FunctionToolset[Any] = FunctionToolset(id="pydantic-ai-media")
    toolset.add_function(
        read_media_file,
        name="ReadMediaFile",
        description=read_media_file.__doc__,
        strict=False,
    )
    return toolset

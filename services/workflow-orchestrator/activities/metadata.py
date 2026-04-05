"""
Activity metadata helpers for workflow-builder cataloging.

The default discovery path remains signature-based auto-discovery. This module
adds an explicit, opt-in metadata convention for activities that should be
surfaced as public-callable workflow actions.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Callable, TypeVar
F = TypeVar("F", bound=Callable[..., Any])

METADATA_ATTR = "__workflow_builder_activity_metadata__"


@dataclass(frozen=True)
class ActivityMetadata:
    """Explicit metadata attached to a Dapr activity function."""

    public_callable: bool = False
    display_name: str | None = None
    description: str | None = None
    category: str | None = None
    tags: tuple[str, ...] = field(default_factory=tuple)
    sw_name: str | None = None
    input_schema: dict[str, Any] | None = None
    output_schema: dict[str, Any] | None = None

    @property
    def visibility(self) -> str:
        return "public-callable" if self.public_callable else "inspect-only"


def schema_object(
    properties: dict[str, Any] | None = None,
    *,
    required: list[str] | tuple[str, ...] | None = None,
    description: str | None = None,
    additional_properties: bool | dict[str, Any] | None = True,
) -> dict[str, Any]:
    schema: dict[str, Any] = {
        "type": "object",
        "properties": properties or {},
    }
    if required:
        schema["required"] = list(required)
    if description:
        schema["description"] = description
    if additional_properties is not None:
        schema["additionalProperties"] = additional_properties
    return schema


def schema_string(
    *,
    description: str | None = None,
    enum: list[str] | tuple[str, ...] | None = None,
    default: str | None = None,
) -> dict[str, Any]:
    schema: dict[str, Any] = {"type": "string"}
    if description:
        schema["description"] = description
    if enum:
        schema["enum"] = list(enum)
    if default is not None:
        schema["default"] = default
    return schema


def schema_integer(
    *,
    description: str | None = None,
    minimum: int | None = None,
    default: int | None = None,
) -> dict[str, Any]:
    schema: dict[str, Any] = {"type": "integer"}
    if description:
        schema["description"] = description
    if minimum is not None:
        schema["minimum"] = minimum
    if default is not None:
        schema["default"] = default
    return schema


def schema_boolean(*, description: str | None = None, default: bool | None = None) -> dict[str, Any]:
    schema: dict[str, Any] = {"type": "boolean"}
    if description:
        schema["description"] = description
    if default is not None:
        schema["default"] = default
    return schema


def schema_array(
    items: dict[str, Any] | None = None,
    *,
    description: str | None = None,
    default: list[Any] | None = None,
) -> dict[str, Any]:
    schema: dict[str, Any] = {"type": "array"}
    if items is not None:
        schema["items"] = items
    if description:
        schema["description"] = description
    if default is not None:
        schema["default"] = default
    return schema


def schema_any_object(*, description: str | None = None) -> dict[str, Any]:
    return schema_object(
        description=description,
        additional_properties=True,
    )


def activity_metadata(
    *,
    public_callable: bool = False,
    display_name: str | None = None,
    description: str | None = None,
    category: str | None = None,
    tags: list[str] | tuple[str, ...] | None = None,
    sw_name: str | None = None,
    input_schema: dict[str, Any] | None = None,
    output_schema: dict[str, Any] | None = None,
) -> Callable[[F], F]:
    """Attach builder metadata to an activity function."""

    normalized_tags = tuple(
        str(tag).strip() for tag in (tags or []) if str(tag).strip()
    )

    def decorator(fn: F) -> F:
        metadata = ActivityMetadata(
            public_callable=public_callable,
            display_name=display_name,
            description=description,
            category=category,
            tags=normalized_tags,
            sw_name=sw_name,
            input_schema=input_schema,
            output_schema=output_schema,
        )
        setattr(fn, METADATA_ATTR, metadata)
        return fn

    return decorator


def get_activity_metadata(fn: Callable[..., Any]) -> ActivityMetadata | None:
    """Return explicit metadata for an activity if present."""
    metadata = getattr(fn, METADATA_ATTR, None)
    if isinstance(metadata, ActivityMetadata):
        return metadata
    return None

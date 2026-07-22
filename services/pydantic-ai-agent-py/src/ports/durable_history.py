"""Application boundary for reference-backed durable model transcripts."""

from __future__ import annotations

from typing import Any, Protocol


class DurableHistoryError(Exception):
    """Base error for durable transcript operations."""


class DurableHistoryInvalidReferenceError(DurableHistoryError):
    """A transcript or message reference does not match the supported format."""


class DurableHistoryIntegrityError(DurableHistoryError):
    """Stored transcript data is missing, malformed, or fails an integrity check."""


class DurableHistoryBudgetError(DurableHistoryError):
    """A full transcript exceeds the configured durable storage budget."""

    def __init__(self, *, actual_bytes: int, max_bytes: int) -> None:
        self.actual_bytes = actual_bytes
        self.max_bytes = max_bytes
        super().__init__(
            f"durable transcript is {actual_bytes} bytes; maximum is {max_bytes} bytes"
        )


class DurableHistorySerializationError(DurableHistoryError):
    """A transcript cannot be represented as canonical JSON without data loss."""


class DurableHistoryPort(Protocol):
    """Persist immutable messages and ordered transcripts behind opaque refs."""

    def save(self, messages: list[dict[str, Any]]) -> str: ...

    def load(self, reference: str) -> list[dict[str, Any]]: ...

    def save_message(self, message: dict[str, Any]) -> str: ...

    def load_message(self, reference: str) -> dict[str, Any]: ...

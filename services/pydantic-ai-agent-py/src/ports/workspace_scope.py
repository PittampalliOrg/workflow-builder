"""Application boundary for selecting a confined agent working directory."""

from __future__ import annotations

from pathlib import Path
from typing import Protocol


class WorkspaceScopeError(ValueError):
    """A requested working directory is not a valid workspace scope."""


class WorkspaceScopePort(Protocol):
    """Resolve a canonical starting cwd inside the workspace root."""

    def resolve(self, requested_cwd: str | None = None) -> Path: ...

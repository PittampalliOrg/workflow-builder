"""Canonical local-filesystem adapter for agent working directories."""

from __future__ import annotations

from pathlib import Path

from src.ports.workspace_scope import WorkspaceScopeError, WorkspaceScopePort


class ConfinedWorkspaceScopeAdapter(WorkspaceScopePort):
    """Select an existing working directory below one canonical workspace root.

    This adapter validates the initial cwd used by workspace-aware capabilities.
    The runtime's pod sandbox, not a process cwd, is the filesystem security
    boundary for shell commands.
    """

    def __init__(self, workspace_root: str | Path) -> None:
        root = Path(workspace_root)
        try:
            root.mkdir(parents=True, exist_ok=True)
            resolved = root.resolve(strict=True)
        except (OSError, RuntimeError, ValueError) as exc:
            raise WorkspaceScopeError(
                "The configured agent workspace root is unavailable."
            ) from exc
        if not resolved.is_dir():
            raise WorkspaceScopeError(
                "The configured agent workspace root is not a directory."
            )
        self._root = resolved

    def resolve(self, requested_cwd: str | None = None) -> Path:
        if requested_cwd is None:
            return self._root
        if not isinstance(requested_cwd, str):
            raise WorkspaceScopeError(
                "The requested agent working directory must be a string."
            )
        if not requested_cwd.strip():
            return self._root

        candidate = Path(requested_cwd.strip())
        if not candidate.is_absolute():
            candidate = self._root / candidate
        try:
            canonical_candidate = candidate.resolve(strict=False)
        except (OSError, RuntimeError, ValueError) as exc:
            raise WorkspaceScopeError(
                "The requested agent working directory does not exist."
            ) from exc
        try:
            canonical_candidate.relative_to(self._root)
        except ValueError as exc:
            raise WorkspaceScopeError(
                "The requested agent working directory is outside the workspace root."
            ) from exc
        try:
            resolved = candidate.resolve(strict=True)
        except (OSError, RuntimeError, ValueError) as exc:
            raise WorkspaceScopeError(
                "The requested agent working directory does not exist."
            ) from exc
        try:
            resolved.relative_to(self._root)
        except ValueError as exc:
            raise WorkspaceScopeError(
                "The requested agent working directory is outside the workspace root."
            ) from exc
        if not resolved.is_dir():
            raise WorkspaceScopeError(
                "The requested agent working directory is not a directory."
            )
        return resolved

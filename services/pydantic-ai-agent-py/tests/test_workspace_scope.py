from __future__ import annotations

from pathlib import Path

import pytest

from src.adapters.confined_workspace_scope import ConfinedWorkspaceScopeAdapter
from src.ports.workspace_scope import WorkspaceScopeError


def test_workspace_scope_defaults_to_canonical_root(tmp_path: Path):
    root = tmp_path / "workspace"
    scope = ConfinedWorkspaceScopeAdapter(root)

    assert scope.resolve() == root.resolve()
    assert scope.resolve("") == root.resolve()


def test_workspace_scope_accepts_relative_and_in_root_absolute_paths(tmp_path: Path):
    root = tmp_path / "workspace"
    repo = root / "repo"
    repo.mkdir(parents=True)
    scope = ConfinedWorkspaceScopeAdapter(root)

    assert scope.resolve("repo") == repo.resolve()
    assert scope.resolve(str(repo)) == repo.resolve()


@pytest.mark.parametrize("requested", ["../outside", "repo/../../outside"])
def test_workspace_scope_rejects_traversal_escape(tmp_path: Path, requested: str):
    root = tmp_path / "workspace"
    root.mkdir()
    scope = ConfinedWorkspaceScopeAdapter(root)

    with pytest.raises(WorkspaceScopeError, match="outside the workspace root"):
        scope.resolve(requested)


def test_workspace_scope_rejects_absolute_and_symlink_escape(tmp_path: Path):
    root = tmp_path / "workspace"
    outside = tmp_path / "outside"
    root.mkdir()
    outside.mkdir()
    (root / "escape").symlink_to(outside, target_is_directory=True)
    scope = ConfinedWorkspaceScopeAdapter(root)

    for requested in (str(outside), "escape"):
        with pytest.raises(WorkspaceScopeError, match="outside the workspace root"):
            scope.resolve(requested)


def test_workspace_scope_rejects_missing_and_non_directory_paths(tmp_path: Path):
    root = tmp_path / "workspace"
    root.mkdir()
    (root / "file.txt").write_text("not a directory", encoding="utf-8")
    scope = ConfinedWorkspaceScopeAdapter(root)

    with pytest.raises(WorkspaceScopeError, match="does not exist"):
        scope.resolve("missing")
    with pytest.raises(WorkspaceScopeError, match="not a directory"):
        scope.resolve("file.txt")


def test_workspace_scope_rejects_non_string_request(tmp_path: Path):
    scope = ConfinedWorkspaceScopeAdapter(tmp_path / "workspace")

    with pytest.raises(WorkspaceScopeError, match="must be a string"):
        scope.resolve(7)  # type: ignore[arg-type]


def test_workspace_scope_normalizes_embedded_nul_as_invalid_cwd(tmp_path: Path):
    scope = ConfinedWorkspaceScopeAdapter(tmp_path / "workspace")

    with pytest.raises(WorkspaceScopeError, match="does not exist"):
        scope.resolve("bad\x00path")

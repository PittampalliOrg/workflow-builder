from __future__ import annotations

import gzip
import json
import struct
import subprocess
import tarfile
from io import BytesIO
from pathlib import Path

import pytest

import src.preview_workspace as workspace
from src.preview_workspace import PreviewWorkspaceError


def git(repo: Path, *args: str) -> str:
    return subprocess.check_output(["git", *args], cwd=repo, text=True).strip()


def checkout(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> tuple[Path, str]:
    repo = tmp_path / "repo"
    repo.mkdir()
    git(repo, "init", "-q")
    git(repo, "config", "user.email", "test@example.com")
    git(repo, "config", "user.name", "Test")
    (repo / "services/demo/src/routes/(admin)/executions/[executionId]").mkdir(
        parents=True
    )
    (repo / "services/shared/contract").mkdir(parents=True)
    (repo / "services/demo/src/routes/(admin)/executions/[executionId]/page.ts").write_text(
        "baseline\n"
    )
    (repo / "services/demo/src/delete.ts").write_text("delete me\n")
    (repo / "services/shared/contract/schema.json").write_text('{"v":1}\n')
    (repo / ".gitignore").write_text("services/demo/src/*.ignored\n")
    git(repo, "add", ".")
    git(repo, "commit", "-qm", "baseline")
    revision = git(repo, "rev-parse", "HEAD")
    monkeypatch.setattr(workspace, "CHECKOUT", repo)
    monkeypatch.setattr(workspace, "SEED_LOCK", tmp_path / "seed.lock")
    return repo, revision


def payload(revision: str) -> dict[str, object]:
    return {
        "sourceRevision": revision,
        "repoSubdir": "services/demo",
        "syncPaths": ["src"],
        "stageMappings": [
            {"from": "../shared/contract", "to": ".contract-fixtures"}
        ],
        "diffScope": [
            "services/demo/src/routes/(admin)",
            "services/demo/src/delete.ts",
        ],
    }


def decode(envelope: bytes) -> tuple[dict[str, object], list[str]]:
    metadata_size = struct.unpack(">I", envelope[:4])[0]
    metadata = json.loads(envelope[4 : 4 + metadata_size])
    archive = gzip.decompress(envelope[4 + metadata_size :])
    with tarfile.open(fileobj=BytesIO(archive), mode="r:") as tar:
        names = tar.getnames()
    return metadata, names


def test_capture_compares_bytes_to_exact_tree_and_resolves_parent_mapping(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    repo, revision = checkout(tmp_path, monkeypatch)
    route = repo / "services/demo/src/routes/(admin)/executions/[executionId]/page.ts"
    git(repo, "update-index", "--assume-unchanged", route.relative_to(repo).as_posix())
    route.write_text("changed despite assume-unchanged\n")

    metadata, names = decode(workspace.capture_preview_workspace(payload(revision)))

    assert metadata["changedPaths"] == [
        "services/demo/src/routes/(admin)/executions/[executionId]/page.ts"
    ]
    assert "src/routes/(admin)/executions/[executionId]/page.ts" in names
    assert ".contract-fixtures/schema.json" in names
    assert metadata["fileCount"] > 0
    assert metadata["memberCount"] >= metadata["fileCount"]
    assert str(metadata["archiveSha256"]).startswith("sha256:")


def test_capture_carries_deletion_in_changed_paths_for_replace_sync(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    repo, revision = checkout(tmp_path, monkeypatch)
    (repo / "services/demo/src/delete.ts").unlink()

    metadata, names = decode(workspace.capture_preview_workspace(payload(revision)))

    assert "services/demo/src/delete.ts" in metadata["changedPaths"]
    assert "src/delete.ts" not in names


def test_capture_rejects_ignored_files_inside_transfer_roots(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    repo, revision = checkout(tmp_path, monkeypatch)
    ignored = repo / "services/demo/src/generated.ignored"
    ignored.write_text("not transferable\n")
    request = payload(revision)
    request["diffScope"] = [*request["diffScope"], "services/demo/src/generated.ignored"]

    with pytest.raises(PreviewWorkspaceError, match="ignored files"):
        workspace.capture_preview_workspace(request)


def test_capture_rejects_overlapping_destinations(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _, revision = checkout(tmp_path, monkeypatch)
    request = payload(revision)
    request["stageMappings"] = [
        {"from": "../shared/contract", "to": "src/staged"}
    ]

    with pytest.raises(PreviewWorkspaceError, match="destinations overlap"):
        workspace.capture_preview_workspace(request)


def test_capture_rejects_staged_out_of_scope_file(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    repo, revision = checkout(tmp_path, monkeypatch)
    rogue = repo / "services/demo/src/out-of-scope.ts"
    rogue.write_text("staged but not authorized\n")
    git(repo, "add", rogue.relative_to(repo).as_posix())

    with pytest.raises(PreviewWorkspaceError, match="outside the execution diff scope"):
        workspace.capture_preview_workspace(payload(revision))


def test_capture_ignores_index_removal_when_building_archive(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    repo, revision = checkout(tmp_path, monkeypatch)
    route = "services/demo/src/routes/(admin)/executions/[executionId]/page.ts"
    git(repo, "rm", "--cached", "-q", route)

    metadata, names = decode(workspace.capture_preview_workspace(payload(revision)))

    assert metadata["changedPaths"] == []
    assert "src/routes/(admin)/executions/[executionId]/page.ts" in names


def test_capture_disables_git_replace_objects(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    repo, revision = checkout(tmp_path, monkeypatch)
    empty_tree = git(repo, "mktree")
    replacement = git(repo, "commit-tree", empty_tree, "-m", "replacement")
    git(repo, "replace", revision, replacement)

    metadata, names = decode(workspace.capture_preview_workspace(payload(revision)))

    assert metadata["changedPaths"] == []
    assert "src/routes/(admin)/executions/[executionId]/page.ts" in names

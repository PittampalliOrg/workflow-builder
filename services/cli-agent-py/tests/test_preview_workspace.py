from __future__ import annotations

import gzip
import hashlib
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
    (
        repo / "services/demo/src/routes/(admin)/executions/[executionId]/page.ts"
    ).write_text("baseline\n")
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
        "stageMappings": [{"from": "../shared/contract", "to": ".contract-fixtures"}],
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
    request["diffScope"] = [
        *request["diffScope"],
        "services/demo/src/generated.ignored",
    ]

    with pytest.raises(PreviewWorkspaceError, match="ignored files"):
        workspace.capture_preview_workspace(request)


def test_capture_rejects_overlapping_destinations(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _, revision = checkout(tmp_path, monkeypatch)
    request = payload(revision)
    request["stageMappings"] = [{"from": "../shared/contract", "to": "src/staged"}]

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


def source_bundle(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> tuple[bytes, int, str]:
    repo, revision = checkout(tmp_path, monkeypatch)
    git(repo, "remote", "add", "origin", workspace.ALLOWED_REPOSITORY)
    git(
        repo,
        "remote",
        "set-url",
        "origin",
        f"https://github.com/{workspace.ALLOWED_REPOSITORY}.git",
    )
    bundle, file_count = workspace.source_preview_workspace_bundle(
        {
            "repository": workspace.ALLOWED_REPOSITORY,
            "sourceRevision": revision,
        }
    )
    return bundle, file_count, revision


def import_payload(bundle: bytes, file_count: int, revision: str) -> dict[str, object]:
    return {
        "repository": workspace.ALLOWED_REPOSITORY,
        "sourceRevision": revision,
        "repoSubdir": ".",
        "bundleSha256": f"sha256:{hashlib.sha256(bundle).hexdigest()}",
        "sourceFileCount": file_count,
    }


def test_source_bundle_imports_exact_self_contained_checkout_without_credentials(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    bundle, file_count, revision = source_bundle(tmp_path, monkeypatch)
    destination = tmp_path / "imported"
    monkeypatch.delenv("GITHUB_TOKEN", raising=False)
    monkeypatch.setattr(workspace, "CHECKOUT", destination)
    monkeypatch.setattr(workspace, "SEED_LOCK", tmp_path / "import.lock")

    receipt = workspace.import_preview_workspace_bundle(
        bundle, import_payload(bundle, file_count, revision)
    )

    assert receipt == {"reused": False, "fileCount": file_count}
    assert git(destination, "rev-parse", "HEAD") == revision
    assert git(destination, "remote", "get-url", "origin") == (
        f"https://github.com/{workspace.ALLOWED_REPOSITORY}.git"
    )
    assert (destination / ".git").is_dir()
    assert not list(tmp_path.glob(".wfb-seed-*"))


def test_non_root_source_seed_exports_a_self_contained_bundle(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    origin = tmp_path / "origin.git"
    source = tmp_path / "source"
    subprocess.check_call(["git", "init", "-q", "--bare", origin])
    source.mkdir()
    git(source, "init", "-q")
    git(source, "config", "user.email", "test@example.com")
    git(source, "config", "user.name", "Test")
    (source / "page.ts").write_text("first\n")
    git(source, "add", "page.ts")
    git(source, "commit", "-qm", "first")
    (source / "page.ts").write_text("second\n")
    git(source, "commit", "-qam", "second")
    revision = git(source, "rev-parse", "HEAD")
    git(source, "remote", "add", "origin", str(origin))
    git(source, "push", "-q", "origin", "HEAD:main")

    physical_checkout = tmp_path / "physical" / "repo"
    physical_checkout.parent.mkdir()
    monkeypatch.setattr(workspace, "CHECKOUT", physical_checkout)
    monkeypatch.setattr(workspace, "SEED_LOCK", tmp_path / "physical-seed.lock")
    monkeypatch.setenv("GITHUB_TOKEN", "test-only")
    real_git = workspace._git
    fetch_calls: list[tuple[str, ...]] = []
    repository_url = f"https://github.com/{workspace.ALLOWED_REPOSITORY}.git"

    def local_source_git(
        args: list[str], cwd: Path, env: dict[str, str] | None = None
    ) -> bytes:
        effective = list(args)
        if effective[:3] == ["remote", "add", "origin"]:
            effective[3] = str(origin)
        elif effective == ["remote", "get-url", "origin"]:
            return repository_url.encode()
        if effective and effective[0] == "fetch":
            fetch_calls.append(tuple(effective))
        return real_git(effective, cwd, env)

    monkeypatch.setattr(workspace, "_git", local_source_git)
    seed_receipt = workspace.seed_preview_workspace(
        {
            "repository": workspace.ALLOWED_REPOSITORY,
            "sourceRevision": revision,
            "repoSubdir": ".",
        }
    )
    bundle, file_count = workspace.source_preview_workspace_bundle(
        {
            "repository": workspace.ALLOWED_REPOSITORY,
            "sourceRevision": revision,
        }
    )

    assert seed_receipt == {"reused": False, "fileCount": file_count}
    assert fetch_calls == [("fetch", "-q", "origin", revision)]
    assert git(physical_checkout, "rev-list", "--count", "HEAD") == "2"

    monkeypatch.setattr(workspace, "_git", real_git)
    destination = tmp_path / "imported"
    monkeypatch.setattr(workspace, "CHECKOUT", destination)
    monkeypatch.setattr(workspace, "SEED_LOCK", tmp_path / "import.lock")
    monkeypatch.delenv("GITHUB_TOKEN", raising=False)

    receipt = workspace.import_preview_workspace_bundle(
        bundle, import_payload(bundle, file_count, revision)
    )

    assert receipt == {"reused": False, "fileCount": file_count}
    assert git(destination, "rev-list", "--count", "HEAD") == "2"
    subprocess.check_call(["git", "fsck", "--strict", "--no-dangling"], cwd=destination)


def test_source_bundle_reuse_requires_unchanged_exact_checkout(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    bundle, file_count, revision = source_bundle(tmp_path, monkeypatch)
    destination = tmp_path / "imported"
    monkeypatch.setattr(workspace, "CHECKOUT", destination)
    monkeypatch.setattr(workspace, "SEED_LOCK", tmp_path / "import.lock")
    request = import_payload(bundle, file_count, revision)
    workspace.import_preview_workspace_bundle(bundle, request)

    assert workspace.import_preview_workspace_bundle(bundle, request) == {
        "reused": True,
        "fileCount": file_count,
    }


@pytest.mark.parametrize(
    ("mutate", "match"),
    [
        (
            lambda bundle, revision: bundle.replace(
                b"# v2 git bundle\n",
                f"# v2 git bundle\n-{revision} prerequisite\n".encode(),
                1,
            ),
            "prerequisites",
        ),
        (
            lambda bundle, revision: bundle.replace(
                b"\n\n", f"\n{revision} refs/heads/extra\n\n".encode(), 1
            ),
            "advertise only",
        ),
    ],
)
def test_source_bundle_rejects_prerequisites_and_multiple_refs(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    mutate: object,
    match: str,
) -> None:
    bundle, file_count, revision = source_bundle(tmp_path, monkeypatch)
    changed = mutate(bundle, revision)  # type: ignore[operator]
    monkeypatch.setattr(workspace, "CHECKOUT", tmp_path / "imported")
    monkeypatch.setattr(workspace, "SEED_LOCK", tmp_path / "import.lock")

    with pytest.raises(PreviewWorkspaceError, match=match):
        workspace.import_preview_workspace_bundle(
            changed, import_payload(changed, file_count, revision)
        )


def test_source_bundle_rejects_digest_size_and_file_count_before_publish(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    bundle, file_count, revision = source_bundle(tmp_path, monkeypatch)
    destination = tmp_path / "imported"
    monkeypatch.setattr(workspace, "CHECKOUT", destination)
    monkeypatch.setattr(workspace, "SEED_LOCK", tmp_path / "import.lock")
    wrong_digest = import_payload(bundle, file_count, revision)
    wrong_digest["bundleSha256"] = f"sha256:{'0' * 64}"
    with pytest.raises(PreviewWorkspaceError, match="receipt is invalid"):
        workspace.import_preview_workspace_bundle(bundle, wrong_digest)

    monkeypatch.setattr(workspace, "MAX_SOURCE_BUNDLE_BYTES", len(bundle) - 1)
    with pytest.raises(PreviewWorkspaceError, match="receipt is invalid"):
        workspace.import_preview_workspace_bundle(
            bundle, import_payload(bundle, file_count, revision)
        )
    monkeypatch.setattr(workspace, "MAX_SOURCE_BUNDLE_BYTES", 64 * 1024 * 1024)

    with pytest.raises(PreviewWorkspaceError, match="file count changed"):
        workspace.import_preview_workspace_bundle(
            bundle, import_payload(bundle, file_count + 1, revision)
        )
    assert not destination.exists()


def test_source_bundle_counts_directories_before_checkout(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    bundle, file_count, revision = source_bundle(tmp_path, monkeypatch)
    destination = tmp_path / "imported"
    monkeypatch.setattr(workspace, "CHECKOUT", destination)
    monkeypatch.setattr(workspace, "SEED_LOCK", tmp_path / "import.lock")
    monkeypatch.setattr(workspace, "MAX_MEMBERS", file_count)
    real_git = workspace._git
    calls: list[tuple[str, ...]] = []

    def recording_git(
        args: list[str], cwd: Path, env: dict[str, str] | None = None
    ) -> bytes:
        calls.append(tuple(args))
        return real_git(args, cwd, env)

    monkeypatch.setattr(workspace, "_git", recording_git)

    with pytest.raises(PreviewWorkspaceError, match="member limit"):
        workspace.import_preview_workspace_bundle(
            bundle, import_payload(bundle, file_count, revision)
        )

    assert not any(args and args[0] == "checkout" for args in calls)
    assert not destination.exists()
    assert not list(tmp_path.glob(".wfb-seed-*"))


def test_checkout_receipt_counts_directories_as_bounded_members(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    repo, revision = checkout(tmp_path, monkeypatch)
    repository_url = f"https://github.com/{workspace.ALLOWED_REPOSITORY}.git"
    git(repo, "remote", "add", "origin", repository_url)
    file_count = sum(
        1
        for path in repo.rglob("*")
        if path.is_file() and ".git" not in path.relative_to(repo).parts
    )
    monkeypatch.setattr(workspace, "MAX_MEMBERS", file_count)

    with pytest.raises(PreviewWorkspaceError, match="canonical checkout.*member limit"):
        workspace._checkout_receipt(revision, repository_url)


def test_source_bundle_checks_expanded_bytes_before_checkout(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    bundle, file_count, revision = source_bundle(tmp_path, monkeypatch)
    destination = tmp_path / "imported"
    monkeypatch.setattr(workspace, "CHECKOUT", destination)
    monkeypatch.setattr(workspace, "SEED_LOCK", tmp_path / "import.lock")
    monkeypatch.setattr(workspace, "MAX_EXPANDED_BYTES", 1)
    real_git = workspace._git
    calls: list[tuple[str, ...]] = []

    def recording_git(
        args: list[str], cwd: Path, env: dict[str, str] | None = None
    ) -> bytes:
        calls.append(tuple(args))
        return real_git(args, cwd, env)

    monkeypatch.setattr(workspace, "_git", recording_git)

    with pytest.raises(PreviewWorkspaceError, match="expanded byte limit"):
        workspace.import_preview_workspace_bundle(
            bundle, import_payload(bundle, file_count, revision)
        )

    assert not any(args and args[0] == "checkout" for args in calls)
    assert not destination.exists()
    assert not list(tmp_path.glob(".wfb-seed-*"))


def test_source_bundle_export_uses_private_temporary_directory(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    real_git = workspace._git
    observed_directory: Path | None = None
    monkeypatch.setattr(workspace.tempfile, "tempdir", str(tmp_path))

    def guarded_git(
        args: list[str], cwd: Path, env: dict[str, str] | None = None
    ) -> bytes:
        nonlocal observed_directory
        if args[:2] == ["bundle", "create"]:
            bundle_path = Path(args[2])
            observed_directory = bundle_path.parent
            assert observed_directory.parent == tmp_path
            assert observed_directory.stat().st_mode & 0o777 == 0o700
            assert not bundle_path.exists()
        return real_git(args, cwd, env)

    monkeypatch.setattr(workspace, "_git", guarded_git)

    bundle, file_count, _revision = source_bundle(tmp_path, monkeypatch)

    assert bundle
    assert file_count > 0
    assert observed_directory is not None
    assert not observed_directory.exists()

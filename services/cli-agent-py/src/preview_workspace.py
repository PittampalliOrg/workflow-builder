"""Purpose-specific shared-workspace seed and capture operations.

The BFF owns authorization and sends only server-derived catalog coordinates.
This module never accepts a shell command, receiver URL, or receiver credential.
"""

from __future__ import annotations

import fcntl
import gzip
import hashlib
import io
import json
import os
import re
import shutil
import stat
import struct
import subprocess
import tarfile
import tempfile
from contextlib import contextmanager
from pathlib import Path, PurePosixPath
from typing import Any

CHECKOUT = Path("/sandbox/work/repo")
SEED_LOCK = Path("/sandbox/work/.wfb-preview-workspace-seed.lock")
ALLOWED_REPOSITORY = "PittampalliOrg/workflow-builder"
MAX_ARCHIVE_BYTES = 25 * 1024 * 1024
MAX_EXPANDED_BYTES = 128 * 1024 * 1024
MAX_METADATA_BYTES = 2 * 1024 * 1024
MAX_MEMBERS = 20_000
MAX_CHANGED_PATHS = 3_000
FULL_SHA = re.compile(r"^[0-9a-f]{40}$")
REPOSITORY = re.compile(r"^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$")


class PreviewWorkspaceError(Exception):
    def __init__(self, status: int, detail: str) -> None:
        super().__init__(detail)
        self.status = status
        self.detail = detail


def _object(payload: Any) -> dict[str, Any]:
    if not isinstance(payload, dict):
        raise PreviewWorkspaceError(400, "JSON object body required")
    return payload


def _exact_keys(payload: dict[str, Any], allowed: set[str]) -> None:
    if set(payload) != allowed:
        raise PreviewWorkspaceError(400, "preview workspace payload shape is invalid")


def _repository(value: Any) -> str:
    if (
        not isinstance(value, str)
        or not REPOSITORY.fullmatch(value)
        or value != ALLOWED_REPOSITORY
    ):
        raise PreviewWorkspaceError(400, "preview workspace repository is invalid")
    return value


def _revision(value: Any) -> str:
    if not isinstance(value, str) or not FULL_SHA.fullmatch(value):
        raise PreviewWorkspaceError(400, "preview workspace revision is invalid")
    return value


def _safe_relative_path(value: Any, field: str, *, allow_dot: bool = False) -> str:
    if allow_dot and value == ".":
        return "."
    if not isinstance(value, str):
        raise PreviewWorkspaceError(400, f"{field} is invalid")
    parts = value.split("/")
    if (
        not value
        or len(value.encode("utf-8")) > 512
        or value.startswith("/")
        or "\\" in value
        or any(ord(char) < 32 or ord(char) == 127 for char in value)
        or any(part in {"", ".", ".."} for part in parts)
    ):
        raise PreviewWorkspaceError(400, f"{field} is invalid")
    return value


def _safe_subdir(value: Any) -> str:
    return _safe_relative_path(value, "repoSubdir", allow_dot=True)


def _inside(candidate: Path, root: Path) -> bool:
    try:
        candidate.relative_to(root)
        return True
    except ValueError:
        return False


def _assert_plain_directory(path: Path, field: str) -> None:
    try:
        info = path.lstat()
    except FileNotFoundError as exc:
        raise PreviewWorkspaceError(409, f"{field} is missing") from exc
    if stat.S_ISLNK(info.st_mode) or not stat.S_ISDIR(info.st_mode):
        raise PreviewWorkspaceError(409, f"{field} is not a plain directory")


def _git_environment(extra: dict[str, str] | None = None) -> dict[str, str]:
    environment = {
        key: value for key, value in os.environ.items() if not key.startswith("GIT_")
    }
    environment.update(
        {
            "GIT_CONFIG_NOSYSTEM": "1",
            "GIT_CONFIG_GLOBAL": os.devnull,
            "GIT_NO_REPLACE_OBJECTS": "1",
            "GIT_OPTIONAL_LOCKS": "0",
            "GIT_TERMINAL_PROMPT": "0",
        }
    )
    environment.update(extra or {})
    return environment


def _git(args: list[str], cwd: Path, env: dict[str, str] | None = None) -> bytes:
    try:
        return subprocess.check_output(
            ["git", *args],
            cwd=cwd,
            env=env or _git_environment(),
            stderr=subprocess.DEVNULL,
            timeout=300,
        )
    except (subprocess.CalledProcessError, subprocess.TimeoutExpired) as exc:
        raise PreviewWorkspaceError(
            409, "exact source checkout operation failed"
        ) from exc


def _checkout_receipt(revision: str, repository_url: str) -> dict[str, Any]:
    _assert_plain_directory(CHECKOUT, "canonical checkout")
    _assert_plain_directory(CHECKOUT / ".git", "canonical checkout metadata")
    head = _git(["rev-parse", "HEAD"], CHECKOUT).decode().strip()
    remote = _git(["remote", "get-url", "origin"], CHECKOUT).decode().strip()
    if head != revision or remote != repository_url:
        raise PreviewWorkspaceError(409, "canonical checkout identity changed")
    file_count = 0
    for root, dirs, files in os.walk(CHECKOUT, followlinks=False):
        root_path = Path(root)
        if root_path == CHECKOUT:
            dirs[:] = [name for name in dirs if name != ".git"]
        for name in [*dirs, *files]:
            info = (root_path / name).lstat()
            if stat.S_ISLNK(info.st_mode):
                raise PreviewWorkspaceError(
                    409, "canonical checkout contains a symbolic link"
                )
        file_count += len(files)
        if file_count > MAX_MEMBERS:
            raise PreviewWorkspaceError(413, "canonical checkout exceeds file limit")
    if file_count < 1:
        raise PreviewWorkspaceError(409, "canonical checkout is empty")
    return {"reused": True, "fileCount": file_count}


@contextmanager
def _seed_lock() -> Any:
    flags = os.O_RDWR | os.O_CREAT | getattr(os, "O_CLOEXEC", 0)
    flags |= getattr(os, "O_NOFOLLOW", 0)
    try:
        fd = os.open(SEED_LOCK, flags, 0o600)
    except OSError as exc:
        raise PreviewWorkspaceError(
            409, "preview workspace seed lock is unsafe"
        ) from exc
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
            raise PreviewWorkspaceError(409, "preview workspace seed lock is unsafe")
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as exc:
            raise PreviewWorkspaceError(
                409, "preview workspace seed is already in progress"
            ) from exc
        yield
    finally:
        os.close(fd)


def seed_preview_workspace(payload: Any) -> dict[str, Any]:
    body = _object(payload)
    _exact_keys(body, {"repository", "sourceRevision", "repoSubdir"})
    repository = _repository(body["repository"])
    revision = _revision(body["sourceRevision"])
    _safe_subdir(body["repoSubdir"])
    repository_url = f"https://github.com/{repository}.git"

    if CHECKOUT.exists() or CHECKOUT.is_symlink():
        return _checkout_receipt(revision, repository_url)

    with _seed_lock():
        staging: Path | None = None
        askpass: Path | None = None
        try:
            if CHECKOUT.exists() or CHECKOUT.is_symlink():
                return _checkout_receipt(revision, repository_url)
            token = os.environ.get("GITHUB_TOKEN", "")
            if not token:
                raise PreviewWorkspaceError(503, "GitHub credential is unavailable")
            staging = Path(tempfile.mkdtemp(prefix=".wfb-seed-", dir=CHECKOUT.parent))
            fd, askpass_name = tempfile.mkstemp(prefix="wfb-askpass-", dir="/tmp")
            askpass = Path(askpass_name)
            with os.fdopen(fd, "wb") as handle:
                handle.write(
                    (
                        "#!/bin/sh\n"
                        'case "$1" in *Username*) printf "%s\\n" x-access-token ;; '
                        '*) printf "%s\\n" "$GITHUB_TOKEN" ;; esac\n'
                    ).encode()
                )
            askpass.chmod(0o700)
            git_env = _git_environment({"GIT_ASKPASS": str(askpass)})
            _git(["init", "-q"], staging, git_env)
            _git(["remote", "add", "origin", repository_url], staging, git_env)
            _git(["fetch", "-q", "--depth=1", "origin", revision], staging, git_env)
            _git(["checkout", "-q", "--detach", "FETCH_HEAD"], staging, git_env)
            if _git(["rev-parse", "HEAD"], staging).decode().strip() != revision:
                raise PreviewWorkspaceError(
                    409, "exact source checkout verification failed"
                )
            if CHECKOUT.exists() or CHECKOUT.is_symlink():
                raise PreviewWorkspaceError(
                    409, "canonical checkout path already exists"
                )
            staging.rename(CHECKOUT)
            staging = None
            receipt = _checkout_receipt(revision, repository_url)
            return {**receipt, "reused": False}
        finally:
            if askpass is not None:
                askpass.unlink(missing_ok=True)
            if staging is not None:
                shutil.rmtree(staging, ignore_errors=True)


def _workspace_files() -> list[str]:
    files: list[str] = []
    for root, directories, names in os.walk(CHECKOUT, followlinks=False):
        root_path = Path(root)
        if root_path == CHECKOUT:
            directories[:] = [name for name in directories if name != ".git"]
        for name in directories:
            info = (root_path / name).lstat()
            if stat.S_ISLNK(info.st_mode) or not stat.S_ISDIR(info.st_mode):
                raise PreviewWorkspaceError(
                    409, "workspace contains an unsafe directory"
                )
        for name in names:
            path = root_path / name
            info = path.lstat()
            if (
                stat.S_ISLNK(info.st_mode)
                or not stat.S_ISREG(info.st_mode)
                or info.st_nlink != 1
                or info.st_size > MAX_EXPANDED_BYTES
            ):
                raise PreviewWorkspaceError(409, "workspace contains an unsafe file")
            relative = path.relative_to(CHECKOUT).as_posix()
            _safe_relative_path(relative, "workspace path")
            files.append(relative)
            if len(files) > MAX_MEMBERS:
                raise PreviewWorkspaceError(413, "workspace exceeds file limit")
    return sorted(files)


def _ignored_paths(paths: list[str]) -> list[str]:
    if not paths:
        return []
    payload = b"".join(path.encode("utf-8") + b"\0" for path in paths)
    try:
        result = subprocess.run(
            [
                "git",
                "-c",
                f"core.excludesFile={os.devnull}",
                "check-ignore",
                "--no-index",
                "-z",
                "--stdin",
            ],
            cwd=CHECKOUT,
            env=_git_environment(),
            input=payload,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            timeout=300,
            check=False,
        )
    except subprocess.TimeoutExpired as exc:
        raise PreviewWorkspaceError(409, "workspace ignore check timed out") from exc
    if result.returncode not in {0, 1}:
        raise PreviewWorkspaceError(409, "workspace ignore check failed")
    try:
        ignored = [part.decode("utf-8") for part in result.stdout.split(b"\0") if part]
    except UnicodeDecodeError as exc:
        raise PreviewWorkspaceError(409, "git returned a non-UTF-8 path") from exc
    allowed = set(paths)
    for value in ignored:
        _safe_relative_path(value, "ignored path")
        if value not in allowed:
            raise PreviewWorkspaceError(409, "workspace ignore check escaped its input")
    return sorted(set(ignored))


def _baseline_entries(revision: str) -> dict[str, tuple[str, str]]:
    raw = _git(["ls-tree", "-r", "-z", "--full-tree", revision], CHECKOUT)
    entries: dict[str, tuple[str, str]] = {}
    for row in (part for part in raw.split(b"\0") if part):
        try:
            metadata, encoded_path = row.split(b"\t", 1)
            mode, kind, object_id = metadata.decode("ascii").split(" ")
            path = encoded_path.decode("utf-8")
        except (UnicodeDecodeError, ValueError) as exc:
            raise PreviewWorkspaceError(409, "exact source tree is invalid") from exc
        _safe_relative_path(path, "source tree path")
        if kind != "blob" or mode not in {"100644", "100755"}:
            raise PreviewWorkspaceError(
                409, "exact source tree contains an unsupported entry"
            )
        if path in entries:
            raise PreviewWorkspaceError(409, "exact source tree contains duplicates")
        entries[path] = (mode, object_id)
    return entries


def _open_regular(path: Path) -> tuple[int, os.stat_result]:
    flags = os.O_RDONLY | getattr(os, "O_CLOEXEC", 0)
    flags |= getattr(os, "O_NOFOLLOW", 0)
    try:
        fd = os.open(path, flags)
    except (FileNotFoundError, NotADirectoryError):
        raise
    except OSError as exc:
        raise PreviewWorkspaceError(
            409, "workspace file cannot be opened safely"
        ) from exc
    info = os.fstat(fd)
    if (
        not stat.S_ISREG(info.st_mode)
        or info.st_nlink != 1
        or info.st_size > MAX_EXPANDED_BYTES
    ):
        os.close(fd)
        raise PreviewWorkspaceError(409, "workspace contains an unsafe file")
    return fd, info


def _workspace_blob(path: str, algorithm: str) -> tuple[str, str]:
    source = _source_path(".", path, allow_parent=False)
    fd, info = _open_regular(source)
    digest = hashlib.new(algorithm)
    digest.update(f"blob {info.st_size}\0".encode())
    try:
        with os.fdopen(fd, "rb") as handle:
            while chunk := handle.read(1024 * 1024):
                digest.update(chunk)
    except OSError as exc:
        raise PreviewWorkspaceError(
            409, "workspace file changed during capture"
        ) from exc
    mode = "100755" if info.st_mode & 0o111 else "100644"
    return mode, digest.hexdigest()


def _changed_paths(
    revision: str, roots: list[str]
) -> tuple[list[str], list[str], list[str]]:
    algorithm = _git(["rev-parse", "--show-object-format"], CHECKOUT).decode().strip()
    if algorithm not in {"sha1", "sha256"}:
        raise PreviewWorkspaceError(409, "git object format is unsupported")
    baseline = _baseline_entries(revision)
    workspace = set(_workspace_files())
    changed: set[str] = set()
    for path, expected in baseline.items():
        try:
            actual = _workspace_blob(path, algorithm)
        except (FileNotFoundError, NotADirectoryError):
            changed.add(path)
            continue
        if actual != expected:
            changed.add(path)
    untracked = sorted(workspace.difference(baseline))
    changed.update(untracked)
    ignored = _ignored_paths(
        [path for path in untracked if _in_scope(path, roots)]
    )
    ordered = sorted(changed)
    if len(ordered) > MAX_CHANGED_PATHS:
        raise PreviewWorkspaceError(413, "workspace has too many changed paths")
    return ordered, ignored, sorted(workspace)


def _in_scope(path: str, prefixes: list[str]) -> bool:
    return any(path == prefix or path.startswith(f"{prefix}/") for prefix in prefixes)


def _source_path(repo_subdir: str, relative: str, *, allow_parent: bool) -> Path:
    lexical = PurePosixPath(repo_subdir) / PurePosixPath(relative)
    if lexical.is_absolute() or (not allow_parent and ".." in lexical.parts):
        raise PreviewWorkspaceError(400, "catalog source path is invalid")
    candidate = CHECKOUT.joinpath(*lexical.parts)
    resolved = candidate.resolve(strict=False)
    if not _inside(resolved, CHECKOUT):
        raise PreviewWorkspaceError(400, "catalog source path escapes the repository")
    # Every existing component must be a plain directory/file, never a symlink.
    current = CHECKOUT
    for part in candidate.relative_to(CHECKOUT).parts:
        current = current / part
        try:
            info = current.lstat()
        except FileNotFoundError:
            break
        if stat.S_ISLNK(info.st_mode):
            raise PreviewWorkspaceError(409, "workspace contains a symbolic link")
    return candidate


def _add_directory(
    archive: tarfile.TarFile,
    destination: str,
    counters: dict[str, int],
) -> None:
    destination = destination.strip("/")
    _safe_relative_path(destination, "archive destination")
    if destination in counters["names"]:
        if destination not in counters["directories"]:
            raise PreviewWorkspaceError(409, "archive destination overlaps a file")
        return
    parent = PurePosixPath(destination).parent.as_posix()
    if parent != ".":
        _add_directory(archive, parent, counters)
    member = tarfile.TarInfo(destination)
    member.uid = member.gid = 0
    member.uname = member.gname = ""
    member.mtime = 0
    member.mode = 0o755
    member.type = tarfile.DIRTYPE
    member.size = 0
    counters["members"] += 1
    if counters["members"] > MAX_MEMBERS:
        raise PreviewWorkspaceError(413, "workspace archive exceeds member limit")
    counters["directories"].add(destination)
    counters["names"].add(destination)
    archive.addfile(member)


def _add_file(
    archive: tarfile.TarFile,
    source: Path,
    destination: str,
    counters: dict[str, Any],
) -> None:
    _safe_relative_path(destination, "archive destination")
    if destination in counters["names"]:
        raise PreviewWorkspaceError(409, "archive contains a duplicate destination")
    fd, info = _open_regular(source)
    parent = PurePosixPath(destination).parent.as_posix()
    if parent != ".":
        _add_directory(archive, parent, counters)
    member = tarfile.TarInfo(destination)
    member.uid = member.gid = 0
    member.uname = member.gname = ""
    member.mtime = 0
    member.mode = stat.S_IMODE(info.st_mode) & 0o777
    member.type = tarfile.REGTYPE
    member.size = info.st_size
    counters["members"] += 1
    counters["files"] += 1
    counters["bytes"] += info.st_size
    if (
        counters["members"] > MAX_MEMBERS
        or counters["files"] > MAX_MEMBERS
        or counters["bytes"] > MAX_EXPANDED_BYTES
    ):
        os.close(fd)
        raise PreviewWorkspaceError(413, "workspace archive exceeds byte limit")
    counters["names"].add(destination)
    with os.fdopen(fd, "rb") as handle:
        archive.addfile(member, handle)


def capture_preview_workspace(payload: Any) -> bytes:
    body = _object(payload)
    _exact_keys(
        body,
        {
            "sourceRevision",
            "repoSubdir",
            "syncPaths",
            "stageMappings",
            "diffScope",
        },
    )
    revision = _revision(body["sourceRevision"])
    repo_subdir = _safe_subdir(body["repoSubdir"])
    sync_paths_raw = body["syncPaths"]
    mappings_raw = body["stageMappings"]
    diff_scope_raw = body["diffScope"]
    if (
        not isinstance(sync_paths_raw, list)
        or not sync_paths_raw
        or len(sync_paths_raw) > 128
    ):
        raise PreviewWorkspaceError(400, "syncPaths is invalid")
    sync_paths = [_safe_relative_path(path, "sync path") for path in sync_paths_raw]
    if not isinstance(mappings_raw, list) or len(mappings_raw) > 128:
        raise PreviewWorkspaceError(400, "stageMappings is invalid")
    mappings: list[tuple[str, str]] = []
    for item in mappings_raw:
        if not isinstance(item, dict) or set(item) != {"from", "to"}:
            raise PreviewWorkspaceError(400, "stage mapping is invalid")
        source = item["from"]
        if (
            not isinstance(source, str)
            or not source
            or len(source.encode("utf-8")) > 512
            or "\\" in source
            or any(ord(char) < 32 or ord(char) == 127 for char in source)
            or source.startswith("/")
        ):
            raise PreviewWorkspaceError(400, "stage mapping source is invalid")
        mappings.append(
            (
                source,
                _safe_relative_path(item["to"], "stage mapping target"),
            )
        )
    if diff_scope_raw is None:
        diff_scope = None
    elif isinstance(diff_scope_raw, list) and 0 < len(diff_scope_raw) <= 128:
        diff_scope = [
            _safe_relative_path(prefix, "diff scope") for prefix in diff_scope_raw
        ]
    else:
        raise PreviewWorkspaceError(400, "diffScope is invalid")

    _assert_plain_directory(CHECKOUT, "canonical checkout")
    _assert_plain_directory(CHECKOUT / ".git", "canonical checkout metadata")
    if _git(["rev-parse", "HEAD"], CHECKOUT).decode().strip() != revision:
        raise PreviewWorkspaceError(409, "canonical checkout revision changed")

    roots: list[str] = []
    archive_specs: list[tuple[str, str]] = []
    for relative in sync_paths:
        source = _source_path(repo_subdir, relative, allow_parent=False)
        source_relative = source.resolve(strict=False).relative_to(CHECKOUT).as_posix()
        roots.append(source_relative)
        archive_specs.append((source_relative, relative))
    for source_relative, destination in mappings:
        source = _source_path(repo_subdir, source_relative, allow_parent=True)
        resolved_source = source.resolve(strict=False).relative_to(CHECKOUT).as_posix()
        roots.append(resolved_source)
        archive_specs.append((resolved_source, destination))
    for index, (_, destination) in enumerate(archive_specs):
        for _, other in archive_specs[index + 1 :]:
            if (
                destination == other
                or destination.startswith(f"{other}/")
                or other.startswith(f"{destination}/")
            ):
                raise PreviewWorkspaceError(409, "catalog archive destinations overlap")

    changed, ignored, workspace_files = _changed_paths(revision, roots)
    if diff_scope is None:
        raise PreviewWorkspaceError(409, "preview workspace diff scope is required")
    if any(not _in_scope(path, diff_scope) for path in changed):
        raise PreviewWorkspaceError(
            409, "workspace contains changes outside the execution diff scope"
        )
    if any(not _in_scope(path, roots) for path in changed):
        raise PreviewWorkspaceError(
            409, "workspace contains changes outside catalog sync roots"
        )
    if ignored:
        raise PreviewWorkspaceError(
            409, "workspace contains ignored files under catalog sync roots"
        )

    # Archive only tracked files plus non-ignored untracked files. Ignored
    # scratch/build output is neither applied nor able to bypass diffScope.
    eligible = [path for path in workspace_files if _in_scope(path, roots)]
    raw_tar = io.BytesIO()
    counters: dict[str, Any] = {
        "members": 0,
        "files": 0,
        "bytes": 0,
        "directories": set(),
        "names": set(),
    }
    with tarfile.open(
        fileobj=raw_tar, mode="w", format=tarfile.USTAR_FORMAT
    ) as archive:
        for source_root, destination_root in archive_specs:
            source_path = _source_path(".", source_root, allow_parent=False)
            try:
                source_info = source_path.lstat()
            except FileNotFoundError:
                source_info = None
            if source_info is not None:
                if stat.S_ISLNK(source_info.st_mode):
                    raise PreviewWorkspaceError(
                        409, "workspace contains a symbolic link"
                    )
                if stat.S_ISDIR(source_info.st_mode):
                    _add_directory(archive, destination_root, counters)
                elif not stat.S_ISREG(source_info.st_mode):
                    raise PreviewWorkspaceError(
                        409, "workspace contains a special entry"
                    )
            for repository_path in eligible:
                if not _in_scope(repository_path, [source_root]):
                    continue
                source = _source_path(".", repository_path, allow_parent=False)
                if not source.exists():
                    continue
                suffix = PurePosixPath(repository_path).relative_to(
                    PurePosixPath(source_root)
                )
                destination = (
                    destination_root
                    if suffix.as_posix() == "."
                    else f"{destination_root}/{suffix.as_posix()}"
                )
                _add_file(archive, source, destination, counters)
    raw_archive = raw_tar.getvalue()
    if len(raw_archive) > MAX_EXPANDED_BYTES:
        raise PreviewWorkspaceError(413, "workspace archive exceeds expanded limit")
    changed_after, ignored_after, workspace_files_after = _changed_paths(
        revision, roots
    )
    if (
        changed_after != changed
        or ignored_after != ignored
        or workspace_files_after != workspace_files
    ):
        raise PreviewWorkspaceError(409, "workspace changed during capture")
    compressed = gzip.compress(raw_archive, compresslevel=6, mtime=0)
    if len(compressed) > MAX_ARCHIVE_BYTES:
        raise PreviewWorkspaceError(413, "workspace archive exceeds compressed limit")
    metadata = json.dumps(
        {
            "changedPaths": changed,
            "fileCount": counters["files"],
            "memberCount": counters["members"],
            "expandedBytes": counters["bytes"],
            "archiveSha256": f"sha256:{hashlib.sha256(compressed).hexdigest()}",
        },
        separators=(",", ":"),
        sort_keys=True,
    ).encode()
    if len(metadata) > MAX_METADATA_BYTES:
        raise PreviewWorkspaceError(413, "workspace metadata exceeds byte limit")
    return struct.pack(">I", len(metadata)) + metadata + compressed

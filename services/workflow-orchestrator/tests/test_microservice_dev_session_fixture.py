from __future__ import annotations

import base64
import copy
import hashlib
import json
import os
import posixpath
import shlex
import shutil
import stat
import subprocess
import sys
import tarfile
from pathlib import Path

from core.sw_expressions import evaluate_expression


REPOSITORY_ROOT = Path(__file__).resolve().parents[3]
FIXTURE_PATH = (
    REPOSITORY_ROOT
    / "scripts"
    / "fixtures"
    / "generator-critic"
    / "microservice-dev-session.json"
)
CATALOG_PATH = (
    REPOSITORY_ROOT / "services" / "shared" / "dev-preview-service-catalog.json"
)
SERVICES = (
    "workflow-builder",
    "workflow-orchestrator",
    "function-router",
    "mcp-gateway",
    "workflow-mcp-server",
)
HEREDOC_START = "python3 - <<'PY_PREVIEW_METADATA'\n"
HEREDOC_END = "\nPY_PREVIEW_METADATA\n"


def preview_services() -> list[dict[str, object]]:
    catalog = json.loads(CATALOG_PATH.read_text(encoding="utf-8"))
    descriptors = {entry["service"]: entry for entry in catalog["services"]}
    result = []
    for service in SERVICES:
        descriptor = descriptors[service]
        info = copy.deepcopy(descriptor["source"])
        info.update(
            {
                "ready": True,
                "url": (
                    f"https://{service}.example.test:"
                    f"{descriptor['development']['port']}"
                ),
                "healthPath": descriptor["development"]["healthPath"],
                "syncUrl": f"https://{service}.example.test/__sync",
                "syncCapability": f"capability {service}'s",
            }
        )
        result.append({"service": service, "ok": True, "info": info})
    return result


def evaluated_clone_command(
    previews: list[dict[str, object]], source_revision: str = "a" * 40
) -> str:
    fixture = json.loads(FIXTURE_PATH.read_text(encoding="utf-8"))
    expression = next(
        entry["clone_repo"]["with"]["command"]
        for entry in fixture["do"]
        if "clone_repo" in entry
    )
    return evaluate_expression(
        expression,
        {
            "trigger": {
                "repoUrl": "PittampalliOrg/workflow-builder",
                "sourceRevision": source_revision,
                "mode": "preview-native",
                "services": list(SERVICES),
            },
            "provision_preview": {"services": previews},
        },
    )


def metadata_script(command: str) -> str:
    start = command.index(HEREDOC_START) + len(HEREDOC_START)
    end = command.index(HEREDOC_END, start)
    return command[start:end]


def run_metadata_script(
    script: str,
    previews: list[dict[str, object]],
    cwd: Path,
) -> subprocess.CompletedProcess[str]:
    encoded = base64.b64encode(
        json.dumps(previews, separators=(",", ":")).encode("utf-8")
    ).decode("ascii")
    return subprocess.run(
        [sys.executable, "-c", script],
        cwd=cwd,
        env={**os.environ, "PREVIEWS_B64": encoded},
        capture_output=True,
        text=True,
        timeout=10,
        check=False,
    )


def repository_path(base: str, relative: str) -> str:
    return posixpath.normpath(posixpath.join(base, relative)).removeprefix("./")


def run_process(
    args: list[str],
    *,
    cwd: Path,
    env: dict[str, str] | None = None,
    timeout: int = 30,
) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        args,
        cwd=cwd,
        env=env,
        capture_output=True,
        text=True,
        timeout=timeout,
        check=False,
    )


def run_git(cwd: Path, *args: str) -> subprocess.CompletedProcess[str]:
    return run_process([shutil.which("git") or "git", *args], cwd=cwd)


def create_smoke_origin(
    root: Path, previews: list[dict[str, object]]
) -> tuple[Path, str]:
    origin = root / "origin"
    origin.mkdir()
    initialized = run_git(origin, "init", "-q", "-b", "main")
    assert initialized.returncode == 0, initialized.stderr
    assert run_git(origin, "config", "user.name", "fixture").returncode == 0
    assert (
        run_git(origin, "config", "user.email", "fixture@example.test").returncode == 0
    )

    paths = {"scripts/dev-sync/sync.sh"}
    for entry in previews:
        info = entry["info"]
        assert isinstance(info, dict)
        base = info["repoSubdir"]
        for path in info["syncPaths"]:
            paths.add(repository_path(base, path))
        for mapping in [*info["extraSync"], *info["captureOnly"]]:
            paths.add(repository_path(base, mapping["from"]))
    for relative in sorted(paths - {"scripts/dev-sync/sync.sh"}):
        directory = origin / relative
        directory.mkdir(parents=True, exist_ok=True)
        (directory / "probe.txt").write_text(f"{relative}\n", encoding="utf-8")

    sync_target = origin / "scripts" / "dev-sync" / "sync.sh"
    sync_target.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(REPOSITORY_ROOT / "scripts" / "dev-sync" / "sync.sh", sync_target)
    assert run_git(origin, "add", "-A").returncode == 0
    committed = run_git(origin, "commit", "-qm", "fixture origin")
    assert committed.returncode == 0, committed.stderr
    revision = run_git(origin, "rev-parse", "HEAD")
    assert revision.returncode == 0
    return origin, revision.stdout.strip()


def create_restricted_tool_path(root: Path, origin: Path) -> Path:
    tool_dir = root / "tools"
    tool_dir.mkdir()
    required = (
        "awk",
        "base64",
        "basename",
        "cat",
        "chmod",
        "cp",
        "cut",
        "date",
        "dirname",
        "grep",
        "gzip",
        "ln",
        "ls",
        "mkdir",
        "mktemp",
        "mv",
        "python3",
        "rm",
        "sed",
        "sha256sum",
        "sleep",
        "sort",
        "tar",
        "tr",
    )
    for name in required:
        source = sys.executable if name == "python3" else shutil.which(name)
        assert source, f"required test tool is unavailable: {name}"
        (tool_dir / name).symlink_to(source)

    real_git = shutil.which("git")
    assert real_git
    git_wrapper = tool_dir / "git"
    git_wrapper.write_text(
        f"#!{sys.executable}\n"
        "import os\n"
        "import sys\n"
        f"real_git = {real_git!r}\n"
        "args = sys.argv[1:]\n"
        "if args and args[0] == 'clone':\n"
        "    args = [os.environ['SMOKE_ORIGIN'] if value.startswith('https://github.com/') else value for value in args]\n"
        "os.execv(real_git, [real_git, *args])\n",
        encoding="utf-8",
    )
    git_wrapper.chmod(0o700)

    fake_curl = tool_dir / "curl"
    fake_curl.write_text(
        f"#!{sys.executable}\n"
        "import json\n"
        "import os\n"
        "import subprocess\n"
        "import sys\n"
        "from pathlib import Path\n"
        "from urllib.parse import urlsplit\n"
        "args = sys.argv[1:]\n"
        "archive = None\n"
        "output = None\n"
        "headers = {}\n"
        "for index, value in enumerate(args):\n"
        "    if value == '--data-binary' and index + 1 < len(args): archive = args[index + 1].removeprefix('@')\n"
        "    if value == '-o' and index + 1 < len(args): output = args[index + 1]\n"
        "    if value == '-H' and index + 1 < len(args):\n"
        "        name, separator, content = args[index + 1].partition(':')\n"
        "        if separator: headers[name.strip().lower()] = content.strip()\n"
        "url = next((value for value in reversed(args) if value.startswith(('http://', 'https://'))), '')\n"
        "hostname = urlsplit(url).hostname or ''\n"
        "service = headers.get('x-sync-service') or hostname.partition('.')[0]\n"
        "status_dir = Path(os.environ['SYNC_STATUS_DIR'])\n"
        "status_dir.mkdir(parents=True, exist_ok=True)\n"
        "status_path = status_dir / f'{service}.json'\n"
        "if archive:\n"
        "    listed = subprocess.run(['tar', '-tzf', archive], capture_output=True, text=True, check=False)\n"
        "    with open(os.environ['SYNC_CAPTURE'], 'a', encoding='utf-8') as handle: handle.write(listed.stdout)\n"
        "    status_path.write_text(json.dumps({'ok': True, 'generation': headers.get('x-sync-generation'), 'syncService': service}), encoding='utf-8')\n"
        "if output and url.endswith('/__status'):\n"
        "    Path(output).write_text(status_path.read_text(encoding='utf-8'), encoding='utf-8')\n"
        "elif output and output != '/dev/null':\n"
        "    Path(output).write_text('{\"ok\":true}', encoding='utf-8')\n"
        "sys.stdout.write('200')\n",
        encoding="utf-8",
    )
    fake_curl.chmod(0o700)
    assert not (tool_dir / "jq").exists()
    return tool_dir


def test_clone_command_materializes_catalog_metadata_without_jq(tmp_path: Path) -> None:
    previews = preview_services()
    command = evaluated_clone_command(previews)

    assert "jq" not in command
    assert HEREDOC_START in command
    assert "base64.b64decode(encoded, validate=True)" in command
    assert "shlex.quote(value)" in command
    assert "https://x-access-token:" not in command
    assert command.index("export GIT_ASKPASS") < command.index("git clone")
    assert command.index("config credential.helper") < command.index(
        "sparse-checkout init"
    )

    result = run_metadata_script(metadata_script(command), previews, tmp_path)
    assert result.returncode == 0, result.stderr
    assert result.stdout == ""
    assert result.stderr == ""
    assert (
        json.loads((tmp_path / ".preview-services.json").read_text(encoding="utf-8"))
        == previews
    )

    expected_paths = {"scripts/dev-sync/sync.sh"}
    for entry in previews:
        info = entry["info"]
        assert isinstance(info, dict)
        base = info["repoSubdir"]
        for path in info["syncPaths"]:
            expected_paths.add(repository_path(base, path))
        for mapping in [*info["extraSync"], *info["captureOnly"]]:
            expected_paths.add(repository_path(base, mapping["from"]))
    actual_paths = set(
        (tmp_path / ".sparse-paths").read_text(encoding="utf-8").splitlines()
    )
    assert actual_paths == expected_paths
    assert "." not in actual_paths
    assert "services/shared/workflow-data-contract" in actual_paths
    assert "skaffold/dev/workflow-orchestrator/Dockerfile.dev" in actual_paths

    sync_dir = tmp_path / ".syncenv.d"
    assert stat.S_IMODE(sync_dir.stat().st_mode) == 0o700
    assert sorted(path.name for path in sync_dir.iterdir()) == sorted(SERVICES)
    for entry in previews:
        service = entry["service"]
        info = entry["info"]
        assert isinstance(service, str)
        assert isinstance(info, dict)
        combined = [*info["extraSync"], *info["captureOnly"]]
        values = {
            "SERVICE": service,
            "SUBDIR": info["repoSubdir"],
            "PATHS": " ".join(info["syncPaths"]),
            "SYNCURL": info["syncUrl"],
            "HEALTHURL": info["url"].rstrip("/") + info["healthPath"],
            "SYNC_TOKEN": info["syncCapability"],
            "EXTRASYNC": " ".join(
                f"{mapping['from']}:{mapping['to']}" for mapping in combined
            ),
        }
        expected = "".join(
            f"{key}={shlex.quote(value)}\n" for key, value in values.items()
        )
        sync_file = sync_dir / service
        assert sync_file.read_text(encoding="utf-8") == expected
        assert stat.S_IMODE(sync_file.stat().st_mode) == 0o600

    summary = (tmp_path / ".preview-services-summary").read_text(encoding="utf-8")
    assert summary == f"{','.join(SERVICES)}\n"
    assert "capability" not in summary
    for name in (
        ".preview-services.json",
        ".sparse-paths",
        ".preview-services-summary",
    ):
        assert stat.S_IMODE((tmp_path / name).stat().st_mode) == 0o600


def test_metadata_materializer_rejects_escape_and_duplicate_before_writes(
    tmp_path: Path,
) -> None:
    previews = preview_services()
    command = evaluated_clone_command(previews)
    script = metadata_script(command)

    unsafe = copy.deepcopy(previews)
    unsafe[0]["info"]["repoSubdir"] = ".."
    unsafe_dir = tmp_path / "unsafe"
    unsafe_dir.mkdir()
    unsafe_result = run_metadata_script(script, unsafe, unsafe_dir)
    assert unsafe_result.returncode == 4
    assert (
        unsafe_result.stderr
        == "failed to materialize trusted preview service metadata\n"
    )
    assert not (unsafe_dir / ".syncenv.d").exists()

    duplicate = copy.deepcopy(previews)
    duplicate.append(copy.deepcopy(duplicate[0]))
    duplicate_dir = tmp_path / "duplicate"
    duplicate_dir.mkdir()
    duplicate_result = run_metadata_script(script, duplicate, duplicate_dir)
    assert duplicate_result.returncode == 4
    assert duplicate_result.stderr == (
        "failed to materialize trusted preview service metadata\n"
    )
    assert not (duplicate_dir / ".syncenv.d").exists()


def test_evaluated_archive_handoff_activates_locally_and_preserves_hot_edits(
    tmp_path: Path,
) -> None:
    previews = preview_services()
    origin, revision = create_smoke_origin(tmp_path, previews)
    helper_workspace = tmp_path / "helper-pod" / "work"
    session_root = tmp_path / "session-pod"
    local_repo = session_root / "wfb-dev-repo"
    helper_workspace.mkdir(parents=True)
    session_root.mkdir()
    tool_path = create_restricted_tool_path(tmp_path, origin)
    sync_capture = tmp_path / "sync-capture.txt"
    sync_status_dir = tmp_path / "sync-status"
    secret = "fixture-github-token-must-not-persist"
    env = {
        **os.environ,
        "PATH": str(tool_path),
        "GITHUB_TOKEN": secret,
        "SMOKE_ORIGIN": origin.resolve().as_uri(),
        "SYNC_CAPTURE": str(sync_capture),
        "SYNC_STATUS_DIR": str(sync_status_dir),
    }

    command = evaluated_clone_command(previews, revision)
    assert "jq" not in command
    command = command.replace("/sandbox/work", str(helper_workspace)).replace(
        "/tmp/wfb-dev-repo", str(local_repo)
    )
    cloned = run_process(
        ["/bin/sh", "-c", command],
        cwd=helper_workspace,
        env=env,
        timeout=90,
    )
    assert cloned.returncode == 0, f"{cloned.stdout}\n{cloned.stderr}"
    assert f"ARCHIVED {revision}" in cloned.stdout
    assert not (helper_workspace / "repo").exists()

    archive = helper_workspace / "repo.tar"
    digest_file = helper_workspace / "repo.tar.sha256"
    activator = helper_workspace / "activate-repo.sh"
    sync_script = helper_workspace / "sync.sh"
    assert stat.S_IMODE(archive.stat().st_mode) == 0o600
    assert stat.S_IMODE(digest_file.stat().st_mode) == 0o600
    assert stat.S_IMODE(activator.stat().st_mode) == 0o700
    assert stat.S_IMODE(sync_script.stat().st_mode) == 0o700
    archive_bytes = archive.read_bytes()
    assert secret.encode() not in archive_bytes
    digest = hashlib.sha256(archive_bytes).hexdigest()
    assert digest_file.read_text(encoding="utf-8") == f"{digest}  repo.tar\n"
    with tarfile.open(archive) as bundled:
        names = set(bundled.getnames())
    assert "./.git" in names
    assert "./scripts/dev-sync/sync.sh" in names

    ignored = set((helper_workspace / ".gitignore").read_text().splitlines())
    assert {
        "/repo",
        "/repo.tar",
        "/repo.tar.sha256",
        "/activate-repo.sh",
        "/sync.sh",
        "/.syncenv",
        "/.syncenv.d",
        "/.preview-services.json",
        "/.preview-services-summary",
        "/.sparse-paths",
        "/.sparse-cones",
        "/.sparse-cones.unsorted",
        "/.syncdeps.*",
        "/.repo-link.*",
        "/.repo.tar.tmp.*",
        "/.repo.tar.sha256.tmp.*",
        "/.activate-repo.tmp.*",
    } <= ignored
    assert (
        stat.S_IMODE((helper_workspace / ".preview-services.json").stat().st_mode)
        == 0o600
    )
    assert stat.S_IMODE((helper_workspace / ".syncenv.d").stat().st_mode) == 0o700

    ignore_probe = tmp_path / "ignore-probe"
    ignore_probe.mkdir()
    shutil.copy2(helper_workspace / ".gitignore", ignore_probe / ".gitignore")
    assert run_git(ignore_probe, "init", "-q").returncode == 0
    real_syncenv = ignore_probe / ".syncenv.d"
    real_syncenv.mkdir()
    (real_syncenv / "service").write_text("SYNC_TOKEN=secret\n", encoding="utf-8")
    real_ignored = run_git(ignore_probe, "check-ignore", "-q", ".syncenv.d/service")
    assert real_ignored.returncode == 0
    shutil.rmtree(real_syncenv)
    local_syncenv = session_root / "syncenv"
    local_syncenv.mkdir()
    real_syncenv.symlink_to(local_syncenv, target_is_directory=True)
    (ignore_probe / "repo").symlink_to(local_repo, target_is_directory=True)
    assert run_git(ignore_probe, "check-ignore", "-q", ".syncenv.d").returncode == 0
    assert run_git(ignore_probe, "check-ignore", "-q", "repo").returncode == 0

    activated = run_process([str(activator)], cwd=session_root, env=env)
    assert activated.returncode == 0, activated.stderr
    assert activated.stdout == f"ACTIVATED {revision}\n"
    repo_link = helper_workspace / "repo"
    assert repo_link.is_symlink()
    assert repo_link.resolve() == local_repo.resolve()
    head = run_git(local_repo, "rev-parse", "HEAD")
    assert head.stdout.strip() == revision
    clean = run_git(local_repo, "status", "--porcelain", "--untracked-files=all")
    assert clean.stdout == ""
    assert secret not in (local_repo / ".git" / "config").read_text(encoding="utf-8")

    hot_edit = local_repo / "src" / "hot-edit.txt"
    hot_edit.write_text("hot reload source\n", encoding="utf-8")
    sync_env = {
        **env,
        "DEV_SYNC_WORK": str(helper_workspace),
        "SYNC_CAPTURE": str(sync_capture),
        "DEV_SYNC_CONVERGENCE_TIMEOUT_SECONDS": "5",
        "DEV_SYNC_CONVERGENCE_SETTLE_SECONDS": "0",
        "DEV_SYNC_CONVERGENCE_POLL_INTERVAL_SECONDS": "0",
        "DEV_SYNC_CONVERGENCE_REQUEST_TIMEOUT_SECONDS": "1",
    }
    synced = run_process([str(sync_script)], cwd=session_root, env=sync_env, timeout=30)
    assert synced.returncode == 0, f"{synced.stdout}\n{synced.stderr}"
    assert "src/hot-edit.txt" in sync_capture.read_text(encoding="utf-8")

    repo_link.unlink()
    repo_link.symlink_to(session_root / "missing", target_is_directory=True)
    reused = run_process([str(activator)], cwd=session_root, env=env)
    assert reused.returncode == 0, reused.stderr
    assert reused.stdout == f"REUSED {revision}\n"
    assert repo_link.resolve() == local_repo.resolve()
    assert hot_edit.read_text(encoding="utf-8") == "hot reload source\n"

    assert run_git(helper_workspace, "init", "-q").returncode == 0
    (helper_workspace / ".syncdeps.fixture").write_text(
        "private state\n", encoding="utf-8"
    )
    assert run_git(helper_workspace, "add", "-A").returncode == 0
    tracked = set(run_git(helper_workspace, "ls-files").stdout.splitlines())
    assert tracked == {".gitignore"}

    shutil.rmtree(local_repo)
    repo_link.unlink()
    archive.write_bytes(archive_bytes + b"corrupt")
    archive.chmod(0o600)
    corrupt_archive = run_process([str(activator)], cwd=session_root, env=env)
    assert corrupt_archive.returncode == 6
    assert not local_repo.exists()
    archive.write_bytes(archive_bytes)
    archive.chmod(0o600)

    original_digest_record = digest_file.read_text(encoding="utf-8")
    digest_file.write_text(f"{'0' * 64}  repo.tar\n", encoding="utf-8")
    digest_file.chmod(0o600)
    corrupt_digest = run_process([str(activator)], cwd=session_root, env=env)
    assert corrupt_digest.returncode == 6
    assert not local_repo.exists()
    digest_file.write_text(original_digest_record, encoding="utf-8")
    digest_file.chmod(0o600)

    reactivated = run_process([str(activator)], cwd=session_root, env=env)
    assert reactivated.returncode == 0, reactivated.stderr
    assert reactivated.stdout == f"ACTIVATED {revision}\n"
    assert repo_link.resolve() == local_repo.resolve()
    assert run_git(local_repo, "status", "--porcelain").stdout == ""

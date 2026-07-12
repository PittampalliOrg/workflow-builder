from __future__ import annotations

import base64
import copy
import json
import os
import posixpath
import shlex
import stat
import subprocess
import sys
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
    sources = {entry["service"]: entry["source"] for entry in catalog["services"]}
    result = []
    for service in SERVICES:
        info = copy.deepcopy(sources[service])
        info.update(
            {
                "ready": True,
                "syncUrl": f"https://{service}.example.test/__sync",
                "syncCapability": f"capability {service}'s",
            }
        )
        result.append({"service": service, "ok": True, "info": info})
    return result


def evaluated_clone_command(previews: list[dict[str, object]]) -> str:
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
                "sourceRevision": "a" * 40,
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
    assert json.loads(
        (tmp_path / ".preview-services.json").read_text(encoding="utf-8")
    ) == previews

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

    summary = (tmp_path / ".preview-services-summary").read_text(
        encoding="utf-8"
    )
    assert summary == f"{','.join(SERVICES)}\n"
    assert "capability" not in summary
    for name in (".preview-services.json", ".sparse-paths", ".preview-services-summary"):
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
    assert unsafe_result.stderr == "failed to materialize trusted preview service metadata\n"
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

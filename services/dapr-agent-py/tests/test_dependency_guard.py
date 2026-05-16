from __future__ import annotations

import pathlib
import tomllib

import src.dependency_guard as dependency_guard
from src.dependency_guard import (
    EXPECTED_DAPR_AGENTS_VERSION,
    assert_dapr_agents_version,
)


ROOT = pathlib.Path(__file__).resolve().parents[1]


def test_runtime_version_guard_fails_closed(monkeypatch):
    monkeypatch.setattr(dependency_guard, "installed_dapr_agents_version", lambda: EXPECTED_DAPR_AGENTS_VERSION)
    assert assert_dapr_agents_version() == EXPECTED_DAPR_AGENTS_VERSION

    monkeypatch.setattr(dependency_guard, "installed_dapr_agents_version", lambda: "9.9.9")
    try:
        assert_dapr_agents_version()
    except RuntimeError as exc:
        assert "Unsupported dapr-agents version" in str(exc)
    else:
        raise AssertionError("version drift should fail fast")


def test_pyproject_and_lock_pin_dapr_agents_exactly():
    pyproject = tomllib.loads((ROOT / "pyproject.toml").read_text())
    deps = pyproject["project"]["dependencies"]
    assert f"dapr-agents=={EXPECTED_DAPR_AGENTS_VERSION}" in deps

    lock = tomllib.loads((ROOT / "uv.lock").read_text())
    package = next(pkg for pkg in lock["package"] if pkg["name"] == "dapr-agent-py")
    dapr_dep = next(
        dep for dep in package["metadata"]["requires-dist"] if dep["name"] == "dapr-agents"
    )
    assert dapr_dep["specifier"] == f"=={EXPECTED_DAPR_AGENTS_VERSION}"
    locked = next(pkg for pkg in lock["package"] if pkg["name"] == "dapr-agents")
    assert locked["version"] == EXPECTED_DAPR_AGENTS_VERSION


def test_dockerfiles_do_not_fallback_to_unfrozen_sync():
    dockerfiles = [
        ROOT / "Dockerfile",
        ROOT / "Dockerfile.testing",
        ROOT / "Dockerfile.sandbox",
        ROOT / "Dockerfile.sandbox-testing",
    ]
    for dockerfile in dockerfiles:
        text = dockerfile.read_text()
        assert "uv sync" in text
        assert "--frozen" in text
        assert "|| uv sync" not in text

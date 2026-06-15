"""Tests for workspace checkpoint-remote visibility (plan 1e).

Proves the startup code path that surfaces whether
WORKFLOW_CHECKPOINT_GIT_REMOTE_URL (+ creds) is active for dapr-agent-py, and
that the secret-free summary never leaks the token. Imports code_checkpoint via
the same openshell_runtime stub used by tests/test_code_checkpoint_cap.py (the
real module pulls in grpc).
"""
from __future__ import annotations

import importlib.util
import logging
import sys
import types
from pathlib import Path


def _load_code_checkpoint_module():
    src_dir = Path(__file__).resolve().parent.parent / "src"
    src_pkg = types.ModuleType("src")
    src_pkg.__path__ = [str(src_dir)]
    sys.modules["src"] = src_pkg

    stub = types.ModuleType("src.openshell_runtime")
    stub.DEFAULT_CWD = "/sandbox"

    class _RT:  # minimal placeholder
        pass

    stub.OpenShellRuntime = _RT
    sys.modules["src.openshell_runtime"] = stub

    spec = importlib.util.spec_from_file_location(
        "src.code_checkpoint", src_dir / "code_checkpoint.py"
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


cc = _load_code_checkpoint_module()


def test_summarize_active_remote_is_secret_free():
    summary = cc.summarize_checkpoint_remote(
        {
            "enabled": True,
            "reason": "",
            "apiUrl": "http://gitea/api",
            "owner": "giteaadmin",
            "repo": "workflow-checkpoints",
            "remoteUrl": "http://gitea/giteaadmin/workflow-checkpoints.git",
            "username": "giteaadmin",
            "token": "super-secret-token-value",
        }
    )
    assert summary["active"] is True
    assert summary["remoteConfigured"] is True
    assert summary["credentialsConfigured"] is True
    assert summary["owner"] == "giteaadmin"
    assert summary["repo"] == "workflow-checkpoints"
    assert summary["apiUrlConfigured"] is True
    # The token must NOT appear anywhere in the summary.
    assert "token" not in summary
    assert "super-secret-token-value" not in str(summary)


def test_summarize_inactive_when_remote_missing():
    summary = cc.summarize_checkpoint_remote(
        {"enabled": False, "reason": "remote url not configured", "remoteUrl": ""}
    )
    assert summary["active"] is False
    assert summary["remoteConfigured"] is False
    assert summary["credentialsConfigured"] is False
    assert summary["reason"] == "remote url not configured"


def test_summarize_inactive_when_credentials_missing():
    summary = cc.summarize_checkpoint_remote(
        {
            "enabled": False,
            "reason": "remote credentials not configured",
            "remoteUrl": "http://gitea/giteaadmin/workflow-checkpoints.git",
            "username": "giteaadmin",
            "token": "",
        }
    )
    assert summary["active"] is False
    assert summary["remoteConfigured"] is True
    assert summary["credentialsConfigured"] is False


def test_log_checkpoint_remote_status_active(monkeypatch, caplog):
    # env takes precedence over Dapr config/secrets, so this resolves enabled
    # WITHOUT any sidecar. (The Dapr lookups fail fast / return empty.)
    monkeypatch.setenv("WORKFLOW_CHECKPOINT_GIT_REMOTE_ENABLED", "true")
    monkeypatch.setenv(
        "WORKFLOW_CHECKPOINT_GIT_REMOTE_URL",
        "http://gitea/giteaadmin/workflow-checkpoints.git",
    )
    monkeypatch.setenv("WORKFLOW_CHECKPOINT_GIT_USERNAME", "giteaadmin")
    monkeypatch.setenv("WORKFLOW_CHECKPOINT_GIT_TOKEN", "tok-123")

    with caplog.at_level(logging.INFO, logger="src.code_checkpoint"):
        status = cc.log_checkpoint_remote_status()

    assert status["active"] is True
    assert status["remoteConfigured"] is True
    assert status["credentialsConfigured"] is True
    assert any(
        "workspace checkpoint remote ACTIVE" in rec.getMessage() for rec in caplog.records
    )
    # No token leaked into logs.
    assert all("tok-123" not in rec.getMessage() for rec in caplog.records)


def test_log_checkpoint_remote_status_inactive(monkeypatch, caplog):
    monkeypatch.setenv("WORKFLOW_CHECKPOINT_GIT_REMOTE_ENABLED", "false")
    with caplog.at_level(logging.WARNING, logger="src.code_checkpoint"):
        status = cc.log_checkpoint_remote_status()
    assert status["active"] is False
    assert any(
        "workspace checkpoint remote INACTIVE" in rec.getMessage() for rec in caplog.records
    )

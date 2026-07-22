"""Shared test isolation for workspace-backed agent adapters."""

from __future__ import annotations

import pytest


@pytest.fixture(autouse=True)
def _isolated_workspace_root(monkeypatch, tmp_path):
    import src.toolsets as toolsets_module
    import src.workflow as workflow_module

    root = str(tmp_path / "workspace")
    monkeypatch.setattr(toolsets_module, "WORKSPACE_ROOT", root)
    monkeypatch.setattr(workflow_module, "WORKSPACE_ROOT", root)

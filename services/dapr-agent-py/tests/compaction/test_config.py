"""Compaction config resolution — env + per-run overrides."""
from __future__ import annotations

import json

from src.compaction.config import CompactionConfig, resolve_config


def test_defaults_without_env(monkeypatch):
    for key in (
        "DAPR_AGENT_PY_COMPACT_ENABLED",
        "DAPR_AGENT_PY_AUTO_COMPACT_ENABLED",
        "DAPR_AGENT_PY_AUTO_COMPACT_WINDOW",
        "DAPR_AGENT_PY_COMPACT_PRESERVE_LAST_N",
    ):
        monkeypatch.delenv(key, raising=False)
    cfg = resolve_config({})
    assert cfg.enabled is True
    assert cfg.auto_compact_enabled is True
    assert cfg.preserve_last_n == 6


def test_env_override_disables(monkeypatch):
    monkeypatch.setenv("DAPR_AGENT_PY_COMPACT_ENABLED", "false")
    cfg = resolve_config({})
    assert cfg.enabled is False


def test_env_window_override(monkeypatch):
    monkeypatch.setenv("DAPR_AGENT_PY_AUTO_COMPACT_WINDOW", "50000")
    cfg = resolve_config({})
    assert cfg.auto_compact_window == 50_000


def test_per_run_override_camel_case():
    msg = {
        "agentConfig": {
            "compaction": {
                "autoCompact": False,
                "preserveLastN": 12,
                "customInstructions": "focus on failing tests",
            }
        }
    }
    cfg = resolve_config(msg)
    assert cfg.auto_compact_enabled is False
    assert cfg.preserve_last_n == 12
    assert cfg.custom_instructions == "focus on failing tests"


def test_per_run_override_stringified_agent_config():
    msg = {"agentConfig": json.dumps({"compaction": {"enabled": False}})}
    cfg = resolve_config(msg)
    assert cfg.enabled is False


def test_from_dict_roundtrip():
    cfg = CompactionConfig(preserve_last_n=10, custom_instructions="x")
    data = cfg.to_dict()
    rebuilt = CompactionConfig.from_dict(data)
    assert rebuilt.preserve_last_n == 10
    assert rebuilt.custom_instructions == "x"

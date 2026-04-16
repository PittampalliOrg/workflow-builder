"""Per-run hook overlay from agentConfig trigger-message fields."""
from __future__ import annotations

import json
from pathlib import Path

from src.hooks.events import HookEvent
from src.hooks.registry import HookRegistry
from src.hooks.schemas import HooksSettings
from src.plugins.loader import LoadedPlugin
from src.plugins.manifest import PluginManifest
from src.plugins.registry import build_registry
from src.plugins.runtime import apply_per_run, extract_inline_hooks, extract_plugin_ids


def _plugin(name):
    manifest = PluginManifest.model_validate({"name": name, "version": "1.0.0"})
    hooks = HooksSettings.from_raw(
        {
            "PreToolUse": [
                {"matcher": "Bash", "hooks": [{"type": "command", "command": f"{name}-cmd"}]}
            ]
        }
    )
    return LoadedPlugin(
        plugin_id=name,
        name=name,
        version="1.0.0",
        root=Path("/tmp") / name,
        manifest=manifest,
        hooks=hooks,
    )


def test_extract_inline_hooks_from_dict():
    message = {
        "agentConfig": {
            "hooks": {
                "PreToolUse": [
                    {"matcher": "Bash", "hooks": [{"type": "command", "command": "x"}]}
                ]
            }
        }
    }
    hooks = extract_inline_hooks(message)
    assert "PreToolUse" in hooks.root


def test_extract_inline_hooks_from_string():
    message = {"agentConfig": json.dumps({"hooks": {"PreToolUse": []}})}
    hooks = extract_inline_hooks(message)
    # Empty list => event dropped
    assert hooks.root == {}


def test_extract_plugin_ids():
    message = {"agentConfig": {"plugins": ["a", "b", ""]}}
    ids = extract_plugin_ids(message)
    assert ids == ["a", "b"]


def test_apply_per_run_adds_inline_hooks_only():
    base = HookRegistry().snapshot()
    message = {
        "agentConfig": {
            "hooks": {
                "PreToolUse": [
                    {"matcher": "Bash", "hooks": [{"type": "command", "command": "per-run"}]}
                ]
            }
        }
    }
    out = apply_per_run(base, message)
    assert len(out.get_matching_hooks(HookEvent.PreToolUse, "Bash")) == 1


def test_apply_per_run_adds_additional_plugin_hooks():
    # Plugin exists but is not in the base registry (not enabled yet).
    plugin_registry = build_registry([_plugin("extra")], explicit_enabled=set())
    base = HookRegistry().snapshot()
    message = {"agentConfig": {"plugins": ["extra"]}}
    out = apply_per_run(base, message, plugin_registry=plugin_registry)
    assert len(out.get_matching_hooks(HookEvent.PreToolUse, "Bash")) == 1

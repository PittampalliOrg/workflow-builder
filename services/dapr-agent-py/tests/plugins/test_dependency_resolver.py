"""Plugin dependency resolution."""
from __future__ import annotations

from pathlib import Path

from src.hooks.schemas import HooksSettings
from src.plugins.loader import LoadedPlugin
from src.plugins.manifest import PluginManifest
from src.plugins.registry import build_registry


def _plugin(name, deps=None):
    manifest_raw = {"name": name, "version": "1.0.0"}
    if deps:
        manifest_raw["dependencies"] = deps
    manifest = PluginManifest.model_validate(manifest_raw)
    return LoadedPlugin(
        plugin_id=name,
        name=name,
        version="1.0.0",
        root=Path("/tmp") / name,
        manifest=manifest,
        hooks=HooksSettings(),
    )


def test_no_deps_all_enabled():
    reg = build_registry([_plugin("a"), _plugin("b")])
    assert reg.enabled_ids == {"a", "b"}


def test_simple_chain():
    reg = build_registry([_plugin("a"), _plugin("b", deps=["a"])])
    assert reg.enabled_ids == {"a", "b"}


def test_unknown_dep_logs_but_enables():
    # Unknown dep => logged and ignored, plugin still enabled.
    reg = build_registry([_plugin("a", deps=["nonexistent"])])
    assert "a" in reg.enabled_ids


def test_cycle_blocks_both():
    reg = build_registry([_plugin("a", deps=["b"]), _plugin("b", deps=["a"])])
    assert reg.enabled_ids == set()


def test_explicit_allowlist():
    reg = build_registry(
        [_plugin("a"), _plugin("b")],
        explicit_enabled={"a"},
    )
    assert reg.enabled_ids == {"a"}

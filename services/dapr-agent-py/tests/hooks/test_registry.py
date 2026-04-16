"""Registry matcher + snapshot overlay semantics."""
from __future__ import annotations

from src.hooks.events import HookEvent
from src.hooks.registry import HookRegistry, HooksSnapshot
from src.hooks.schemas import HooksSettings


def _settings(event: str, matcher: str, command: str) -> HooksSettings:
    return HooksSettings.from_raw(
        {
            event: [
                {"matcher": matcher, "hooks": [{"type": "command", "command": command}]}
            ]
        }
    )


class TestMatcher:
    def test_empty_matcher_matches_all(self):
        reg = HookRegistry()
        reg.register_from_settings(_settings("PreToolUse", "", "echo"), source="user")
        snap = reg.snapshot()
        assert len(snap.get_matching_hooks(HookEvent.PreToolUse, "Bash")) == 1
        assert len(snap.get_matching_hooks(HookEvent.PreToolUse, "Read")) == 1

    def test_exact_matcher(self):
        reg = HookRegistry()
        reg.register_from_settings(_settings("PreToolUse", "Bash", "echo"), source="user")
        snap = reg.snapshot()
        assert len(snap.get_matching_hooks(HookEvent.PreToolUse, "Bash")) == 1
        assert len(snap.get_matching_hooks(HookEvent.PreToolUse, "Read")) == 0

    def test_glob_matcher(self):
        reg = HookRegistry()
        reg.register_from_settings(_settings("PreToolUse", "Read*", "echo"), source="user")
        snap = reg.snapshot()
        assert len(snap.get_matching_hooks(HookEvent.PreToolUse, "Read")) == 1
        assert len(snap.get_matching_hooks(HookEvent.PreToolUse, "ReadDir")) == 1
        assert len(snap.get_matching_hooks(HookEvent.PreToolUse, "Bash")) == 0

    def test_regex_matcher(self):
        reg = HookRegistry()
        reg.register_from_settings(
            _settings("PreToolUse", "/^(Bash|Read)$/", "echo"), source="user"
        )
        snap = reg.snapshot()
        assert len(snap.get_matching_hooks(HookEvent.PreToolUse, "Bash")) == 1
        assert len(snap.get_matching_hooks(HookEvent.PreToolUse, "Read")) == 1
        assert len(snap.get_matching_hooks(HookEvent.PreToolUse, "Write")) == 0


class TestSnapshotOverlay:
    def test_snapshot_immutable_to_later_registry_changes(self):
        reg = HookRegistry()
        reg.register_from_settings(_settings("PreToolUse", "", "v1"), source="user")
        snap = reg.snapshot()
        reg.register_from_settings(_settings("PreToolUse", "", "v2"), source="user")
        assert len(snap.get_matching_hooks(HookEvent.PreToolUse, "Bash")) == 1

    def test_overlay_adds_per_run_hooks(self):
        reg = HookRegistry()
        reg.register_from_settings(_settings("PreToolUse", "", "base"), source="user")
        base_snap = reg.snapshot()
        overlay = base_snap.overlay(_settings("PreToolUse", "", "run"))
        assert len(overlay.get_matching_hooks(HookEvent.PreToolUse, "Bash")) == 2
        assert len(base_snap.get_matching_hooks(HookEvent.PreToolUse, "Bash")) == 1

    def test_clear_plugin_hooks_preserves_others(self):
        reg = HookRegistry()
        reg.register_from_settings(_settings("PreToolUse", "", "user"), source="user")
        reg.register_from_plugin(
            plugin_id="p1",
            plugin_root="/tmp/p1",
            settings=_settings("PreToolUse", "", "plug"),
        )
        assert reg.count(HookEvent.PreToolUse) == 2
        reg.clear_plugin_hooks("p1")
        assert reg.count(HookEvent.PreToolUse) == 1

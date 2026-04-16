"""Settings cascade loader — mirrors TS settings merge order.

Priority (highest-precedence last on push, highest-priority first on lookup):
    managed ($DAPR_AGENT_PY_MANAGED_SETTINGS or /etc/dapr-agent-py/policy.json)
  > project  ($CLAUDE_PROJECT_DIR/.claude/settings.json)
  > local    ($CLAUDE_PROJECT_DIR/.claude/settings.local.json)
  > user     (~/.claude/settings.json)

The loader returns a list of (source_name, HooksSettings) pairs so the
caller can register in order and preserve TS telemetry semantics.

Policy fields `disableAllHooks` and `allowManagedHooksOnly` honored per
hooksConfigSnapshot.ts:18-89.
"""
from __future__ import annotations

import json
import logging
import os
from dataclasses import dataclass
from pathlib import Path
from typing import Optional

from .registry import HookSource
from .schemas import HooksSettings

logger = logging.getLogger(__name__)


@dataclass
class LoadedSettings:
    source: HookSource
    path: Optional[Path]
    hooks: HooksSettings
    disable_all_hooks: bool = False
    allow_managed_hooks_only: bool = False


def _read_json(path: Path) -> dict | None:
    try:
        with path.open("r", encoding="utf-8") as fh:
            parsed = json.load(fh)
    except FileNotFoundError:
        return None
    except (json.JSONDecodeError, OSError) as exc:
        logger.warning("[hooks] Failed to read settings at %s: %s", path, exc)
        return None
    return parsed if isinstance(parsed, dict) else None


def _extract(raw: dict | None, source: HookSource, path: Path | None) -> LoadedSettings:
    if not raw:
        return LoadedSettings(source=source, path=path, hooks=HooksSettings())
    hooks_raw = raw.get("hooks")
    hooks = HooksSettings.from_raw(hooks_raw) if hooks_raw is not None else HooksSettings()
    return LoadedSettings(
        source=source,
        path=path,
        hooks=hooks,
        disable_all_hooks=bool(raw.get("disableAllHooks")),
        allow_managed_hooks_only=bool(raw.get("allowManagedHooksOnly")),
    )


def _managed_path() -> Path | None:
    env = os.environ.get("DAPR_AGENT_PY_MANAGED_SETTINGS")
    if env:
        return Path(env).expanduser()
    default = Path("/etc/dapr-agent-py/policy.json")
    return default if default.exists() else None


def _project_dir() -> Path:
    env = os.environ.get("CLAUDE_PROJECT_DIR")
    return Path(env).expanduser() if env else Path.cwd()


def load_cascade() -> list[LoadedSettings]:
    """Load managed/project/local/user settings. Order is applied order
    (managed first, user last) so later overrides precede nothing —
    actually hooks are additive, not override, so order only matters for
    telemetry and the managed-only gate."""
    loaded: list[LoadedSettings] = []

    managed = _managed_path()
    if managed:
        loaded.append(_extract(_read_json(managed), "managed", managed))

    project_dir = _project_dir()
    project_settings = project_dir / ".claude" / "settings.json"
    loaded.append(_extract(_read_json(project_settings), "project", project_settings))

    local_settings = project_dir / ".claude" / "settings.local.json"
    loaded.append(_extract(_read_json(local_settings), "local", local_settings))

    user_settings = Path.home() / ".claude" / "settings.json"
    loaded.append(_extract(_read_json(user_settings), "user", user_settings))

    # Extra service-owned overlay paths
    extra = os.environ.get("DAPR_AGENT_PY_EXTRA_SETTINGS_PATHS", "")
    for entry in filter(None, (p.strip() for p in extra.split(":"))):
        path = Path(entry).expanduser()
        loaded.append(_extract(_read_json(path), "managed", path))

    return loaded


def policy_flags(loaded: list[LoadedSettings]) -> tuple[bool, bool]:
    """Return (disable_all, allow_managed_only) combining managed + user flags.

    TS semantics: `disableAllHooks` in managed => total kill-switch; in
    non-managed => managed-only (backward-compat). `allowManagedHooksOnly`
    only honored when set in managed.
    """
    disable_all = False
    allow_managed_only = False
    for ls in loaded:
        if ls.source == "managed":
            if ls.disable_all_hooks:
                disable_all = True
            if ls.allow_managed_hooks_only:
                allow_managed_only = True
        else:
            if ls.disable_all_hooks:
                # non-managed disable => managed-only, not full kill-switch
                allow_managed_only = True
    return disable_all, allow_managed_only


__all__ = ["LoadedSettings", "load_cascade", "policy_flags"]

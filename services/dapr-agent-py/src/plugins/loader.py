"""Plugin discovery + manifest parsing.

Service-owned discovery only (per plan): paths come from
`DAPR_AGENT_PY_PLUGIN_PATHS` (colon-separated) and a compile-time default
of `/etc/dapr-agent-py/plugins`. We do NOT read `~/.claude/plugins` —
that belongs to a TS Claude Code install.

For each plugin directory:
  1. Read plugin.json (required)
  2. Resolve manifest.hooks (string path | inline HooksSettings | array)
  3. Also read conventional hooks/hooks.json if it exists (merged)
  4. Resolve manifest.mcpServers (string path | inline dict | array)
"""
from __future__ import annotations

import json
import logging
import os
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Optional

from ..hooks.schemas import HooksSettings
from .manifest import PluginManifest, PluginMcpServerEntry

logger = logging.getLogger(__name__)


DEFAULT_PLUGIN_PATH = "/etc/dapr-agent-py/plugins"


@dataclass
class LoadedPlugin:
    plugin_id: str
    name: str
    version: str
    root: Path
    manifest: PluginManifest
    hooks: HooksSettings
    mcp_servers: list[dict[str, Any]] = field(default_factory=list)
    user_config_options: dict[str, Any] = field(default_factory=dict)
    load_errors: list[str] = field(default_factory=list)


def discovery_paths() -> list[Path]:
    raw = os.environ.get("DAPR_AGENT_PY_PLUGIN_PATHS", "")
    paths: list[Path] = []
    for entry in filter(None, (p.strip() for p in raw.split(":"))):
        paths.append(Path(entry).expanduser())
    default = Path(DEFAULT_PLUGIN_PATH)
    if default not in paths:
        paths.append(default)
    return paths


def _read_json(path: Path) -> Any:
    try:
        with path.open("r", encoding="utf-8") as fh:
            return json.load(fh)
    except FileNotFoundError:
        return None
    except (json.JSONDecodeError, OSError) as exc:
        logger.warning("[plugins] failed to read %s: %s", path, exc)
        return None


def _resolve_hooks_field(
    raw: Any,
    plugin_root: Path,
    errors: list[str],
) -> HooksSettings:
    """TS shape: string | HooksSettings | (string | HooksSettings)[]."""
    if raw is None:
        return HooksSettings()
    if isinstance(raw, list):
        merged = HooksSettings()
        for item in raw:
            piece = _resolve_hooks_field(item, plugin_root, errors)
            for event, matchers in piece.root.items():
                merged.root.setdefault(event, []).extend(matchers)
        return merged
    if isinstance(raw, str):
        if raw.startswith("/"):
            errors.append(f"hooks path must be relative to plugin root, got {raw!r}")
            return HooksSettings()
        target = (plugin_root / raw).resolve()
        if not str(target).startswith(str(plugin_root.resolve())):
            errors.append(f"hooks path escapes plugin root: {raw!r}")
            return HooksSettings()
        data = _read_json(target)
        if isinstance(data, dict) and "hooks" in data and isinstance(data["hooks"], dict):
            data = data["hooks"]
        return HooksSettings.from_raw(data)
    if isinstance(raw, dict):
        # hooks/hooks.json may wrap the event map under a "hooks" key alongside
        # metadata like "description". Unwrap if the outer dict isn't already an
        # event-keyed map.
        if "hooks" in raw and isinstance(raw["hooks"], dict) and not any(
            k in raw
            for k in (
                "PreToolUse", "PostToolUse", "PostToolUseFailure",
                "UserPromptSubmit", "SessionStart", "SessionEnd",
                "Stop", "Notification",
            )
        ):
            return HooksSettings.from_raw(raw["hooks"])
        return HooksSettings.from_raw(raw)
    errors.append(f"unsupported hooks field shape: {type(raw).__name__}")
    return HooksSettings()


def _resolve_mcp_field(raw: Any, plugin_root: Path, errors: list[str]) -> list[dict[str, Any]]:
    """Collect MCP server entries as plain dicts (agent handles the rest)."""
    if raw is None:
        return []
    if isinstance(raw, list):
        out: list[dict[str, Any]] = []
        for item in raw:
            out.extend(_resolve_mcp_field(item, plugin_root, errors))
        return out
    if isinstance(raw, str):
        if raw.startswith("/"):
            errors.append(f"mcpServers path must be relative: {raw!r}")
            return []
        target = (plugin_root / raw).resolve()
        if not str(target).startswith(str(plugin_root.resolve())):
            errors.append(f"mcpServers path escapes plugin root: {raw!r}")
            return []
        data = _read_json(target)
        if data is None:
            return []
        return _resolve_mcp_field(data, plugin_root, errors)
    if isinstance(raw, dict):
        # Could be a single server or a map of server_name -> config
        if any(isinstance(v, dict) for v in raw.values()):
            out = []
            for key, value in raw.items():
                if not isinstance(value, dict):
                    continue
                merged = dict(value)
                merged.setdefault("server_name", key)
                out.append(merged)
            return out
        return [raw]
    errors.append(f"unsupported mcpServers shape: {type(raw).__name__}")
    return []


def _extract_user_config_options(manifest: PluginManifest) -> dict[str, Any]:
    options: dict[str, Any] = {}
    if not manifest.user_config:
        return options
    for key, option in manifest.user_config.items():
        if option.default is not None:
            options[key] = option.default
    return options


def _load_one(plugin_dir: Path) -> Optional[LoadedPlugin]:
    manifest_path = plugin_dir / "plugin.json"
    raw = _read_json(manifest_path)
    if not isinstance(raw, dict):
        return None
    try:
        manifest = PluginManifest.model_validate(raw)
    except Exception as exc:
        logger.warning("[plugins] invalid manifest at %s: %s", manifest_path, exc)
        return None

    errors: list[str] = []
    hooks_settings = _resolve_hooks_field(manifest.hooks, plugin_dir, errors)
    # Conventional hooks/hooks.json — merged if present.
    # TS format wraps HooksSettings under a top-level "hooks" key alongside
    # "description" and other metadata. Unwrap if present.
    conv = plugin_dir / "hooks" / "hooks.json"
    if conv.exists():
        conv_raw = _read_json(conv)
        if isinstance(conv_raw, dict) and "hooks" in conv_raw and isinstance(conv_raw["hooks"], dict):
            conv_raw = conv_raw["hooks"]
        conv_hooks = HooksSettings.from_raw(conv_raw)
        for event, matchers in conv_hooks.root.items():
            hooks_settings.root.setdefault(event, []).extend(matchers)

    mcp_servers = _resolve_mcp_field(manifest.mcp_servers, plugin_dir, errors)
    user_options = _extract_user_config_options(manifest)

    return LoadedPlugin(
        plugin_id=manifest.name,
        name=manifest.name,
        version=manifest.version or "0.0.0",
        root=plugin_dir,
        manifest=manifest,
        hooks=hooks_settings,
        mcp_servers=mcp_servers,
        user_config_options=user_options,
        load_errors=errors,
    )


def load_plugins(paths: Optional[list[Path]] = None) -> list[LoadedPlugin]:
    """Scan discovery paths and return parsed plugins. Does no I/O beyond
    reading JSON files at startup."""
    scan = paths if paths is not None else discovery_paths()
    loaded: dict[str, LoadedPlugin] = {}
    for base in scan:
        if not base.exists() or not base.is_dir():
            continue
        for entry in sorted(base.iterdir()):
            if not entry.is_dir():
                continue
            plugin = _load_one(entry)
            if plugin is None:
                continue
            if plugin.plugin_id in loaded:
                logger.info(
                    "[plugins] skipping duplicate plugin id %s at %s (already loaded from %s)",
                    plugin.plugin_id,
                    entry,
                    loaded[plugin.plugin_id].root,
                )
                continue
            loaded[plugin.plugin_id] = plugin
            if plugin.load_errors:
                for err in plugin.load_errors:
                    logger.warning("[plugins] %s: %s", plugin.plugin_id, err)
            logger.info(
                "[plugins] loaded %s v%s from %s (%d hook events, %d mcp servers)",
                plugin.plugin_id,
                plugin.version,
                plugin.root,
                len(plugin.hooks.root),
                len(plugin.mcp_servers),
            )
    return list(loaded.values())


__all__ = ["LoadedPlugin", "discovery_paths", "load_plugins"]

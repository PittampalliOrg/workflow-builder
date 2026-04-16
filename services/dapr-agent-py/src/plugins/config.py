"""Plugin configuration persistence.

Ported from plugin settings management in claude-code-src.
"""

from __future__ import annotations

import json
import logging
from dataclasses import dataclass, field
from pathlib import Path

from .directories import get_plugins_directory

logger = logging.getLogger(__name__)


@dataclass
class PluginSettings:
    """Plugin enable/disable state."""

    enabled_plugins: dict[str, bool] = field(default_factory=dict)


_SETTINGS_FILE = "settings.json"


def _settings_path() -> Path:
    return get_plugins_directory() / _SETTINGS_FILE


def load_plugin_settings() -> PluginSettings:
    """Load plugin settings from disk."""
    path = _settings_path()
    if not path.is_file():
        return PluginSettings()
    try:
        with open(path) as f:
            data = json.load(f)
        enabled = data.get("enabledPlugins", {})
        if not isinstance(enabled, dict):
            enabled = {}
        return PluginSettings(
            enabled_plugins={str(k): bool(v) for k, v in enabled.items()}
        )
    except (json.JSONDecodeError, OSError) as exc:
        logger.warning("Failed to load plugin settings: %s", exc)
        return PluginSettings()


def save_plugin_settings(settings: PluginSettings) -> None:
    """Persist plugin settings to disk."""
    path = _settings_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    try:
        with open(path, "w") as f:
            json.dump({"enabledPlugins": settings.enabled_plugins}, f, indent=2)
    except OSError as exc:
        logger.warning("Failed to save plugin settings: %s", exc)


def is_plugin_enabled(plugin_id: str, default: bool = True) -> bool:
    """Check if a plugin is enabled in settings."""
    settings = load_plugin_settings()
    return settings.enabled_plugins.get(plugin_id, default)


def set_plugin_enabled(plugin_id: str, enabled: bool) -> None:
    """Set a plugin's enabled state in settings."""
    settings = load_plugin_settings()
    settings.enabled_plugins[plugin_id] = enabled
    save_plugin_settings(settings)

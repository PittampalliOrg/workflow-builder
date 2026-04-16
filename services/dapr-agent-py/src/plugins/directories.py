"""Plugin directory management.

Ported from claude-code-src/main/utils/plugins/pluginDirectories.ts.
"""

from __future__ import annotations

import os
from pathlib import Path


def get_plugins_directory() -> Path:
    """Root directory for plugin cache and data.

    Override with ``DAPR_AGENT_PLUGIN_CACHE_DIR`` environment variable.
    Default: ``~/.dapr-agent/plugins/``
    """
    override = os.environ.get("DAPR_AGENT_PLUGIN_CACHE_DIR")
    if override:
        return Path(override)
    return Path.home() / ".dapr-agent" / "plugins"


def get_plugin_cache_path() -> Path:
    """Where marketplace plugin clones are cached."""
    return get_plugins_directory() / "cache"


def get_plugin_data_dir(plugin_id: str) -> Path:
    """Persistent per-plugin data directory (survives updates).

    Exposed to hooks as ``${PLUGIN_DATA}``.
    """
    return get_plugins_directory() / "data" / plugin_id


def get_plugin_seed_dirs() -> list[Path]:
    """Read-only fallback directories from ``DAPR_AGENT_PLUGIN_SEED_DIR``."""
    raw = os.environ.get("DAPR_AGENT_PLUGIN_SEED_DIR", "")
    if not raw:
        return []
    return [Path(p) for p in raw.split(os.pathsep) if p]


def get_installed_plugins_file() -> Path:
    """Path to the installed_plugins.json tracking file."""
    return get_plugins_directory() / "installed_plugins.json"

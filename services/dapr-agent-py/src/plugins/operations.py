"""Plugin operations: install, uninstall, enable, disable, reload.

Ported from claude-code-src/main/services/plugins/pluginOperations.ts.
"""

from __future__ import annotations

import json
import logging
import shutil
from pathlib import Path

from .config import load_plugin_settings, save_plugin_settings, set_plugin_enabled
from .directories import get_installed_plugins_file, get_plugin_cache_path
from .identifier import build_plugin_id, parse_plugin_id
from .loader import create_plugin_from_path, load_all_plugins
from .models import LoadedPlugin, PluginError, PluginLoadResult
from .registry import get_plugin_registry

logger = logging.getLogger(__name__)


def install_plugin(
    plugin_path: str,
    name: str = "",
    marketplace: str = "local",
) -> LoadedPlugin:
    """Install a plugin from a local directory path.

    Copies the plugin to the cache directory and records it in
    installed_plugins.json.
    """
    src = Path(plugin_path).resolve()
    if not src.is_dir():
        raise FileNotFoundError(f"Plugin directory not found: {plugin_path}")

    if not name:
        name = src.name
    plugin_id = build_plugin_id(name, marketplace)

    # Copy to cache
    cache_dir = get_plugin_cache_path() / marketplace / name
    cache_dir.mkdir(parents=True, exist_ok=True)
    dest = cache_dir / "latest"
    if dest.exists():
        shutil.rmtree(dest)
    shutil.copytree(src, dest)

    # Record installation
    installed_file = get_installed_plugins_file()
    installed: dict = {}
    if installed_file.is_file():
        try:
            with open(installed_file) as f:
                installed = json.load(f)
        except (json.JSONDecodeError, OSError):
            installed = {}

    installed[plugin_id] = {"path": str(dest), "marketplace": marketplace}
    installed_file.parent.mkdir(parents=True, exist_ok=True)
    with open(installed_file, "w") as f:
        json.dump(installed, f, indent=2)

    # Load and return
    plugin, errors = create_plugin_from_path(
        dest,
        source=plugin_id,
        enabled=True,
        fallback_name=name,
    )
    for err in errors:
        logger.warning("[plugins] Install error for %s: %s", name, err.message)

    # Enable by default
    set_plugin_enabled(plugin_id, True)

    # Update registry
    get_plugin_registry().register(plugin)

    return plugin


def uninstall_plugin(plugin_id: str) -> None:
    """Remove a plugin from cache and settings."""
    # Remove from installed_plugins.json
    installed_file = get_installed_plugins_file()
    if installed_file.is_file():
        try:
            with open(installed_file) as f:
                installed = json.load(f)
            info = installed.pop(plugin_id, None)
            with open(installed_file, "w") as f:
                json.dump(installed, f, indent=2)
            # Remove cached files
            if info and isinstance(info, dict):
                path = info.get("path", "")
                if path and Path(path).exists():
                    shutil.rmtree(path)
        except (json.JSONDecodeError, OSError) as exc:
            logger.warning("Failed to update installed plugins: %s", exc)

    # Remove from settings
    settings = load_plugin_settings()
    settings.enabled_plugins.pop(plugin_id, None)
    save_plugin_settings(settings)

    # Update registry
    get_plugin_registry().unregister(plugin_id)


def enable_plugin(plugin_id: str) -> None:
    """Enable a plugin in settings and update the registry."""
    set_plugin_enabled(plugin_id, True)
    get_plugin_registry().set_enabled(plugin_id, True)


def disable_plugin(plugin_id: str) -> None:
    """Disable a plugin in settings and update the registry."""
    set_plugin_enabled(plugin_id, False)
    get_plugin_registry().set_enabled(plugin_id, False)


def reload_plugins(
    session_plugin_dirs: list[str] | None = None,
) -> PluginLoadResult:
    """Re-discover and reload all plugins.  Atomic swap in registry."""
    result = load_all_plugins(session_plugin_dirs=session_plugin_dirs)
    get_plugin_registry().set_load_result(result)

    # Re-register hooks
    from .hooks_integration import register_plugin_hooks

    from src.hooks.registry import get_hook_registry

    get_hook_registry().clear_registered_hooks()
    register_plugin_hooks(result.enabled)

    # Re-register skills
    from .skills_integration import register_plugin_skills
    from src.tools.skill_tool.tool import get_registry as get_skill_registry

    register_plugin_skills(get_skill_registry(), result.enabled)

    logger.info(
        "[plugins] Reloaded: %d enabled, %d disabled, %d errors",
        len(result.enabled),
        len(result.disabled),
        len(result.errors),
    )

    return result

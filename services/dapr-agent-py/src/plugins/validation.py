"""Plugin manifest validation.

Ported from plugin validation logic in
claude-code-src/main/utils/plugins/pluginLoader.ts.
"""

from __future__ import annotations

import logging
import os
from pathlib import Path
from typing import Any

from .models import PluginError, PluginManifest

logger = logging.getLogger(__name__)


def validate_path_within_base(path: str, base: str) -> bool:
    """Ensure *path* is within *base* (prevent path traversal)."""
    try:
        resolved = os.path.realpath(os.path.join(base, path))
        base_resolved = os.path.realpath(base)
        return resolved.startswith(base_resolved + os.sep) or resolved == base_resolved
    except (OSError, ValueError):
        return False


def validate_manifest(
    manifest: PluginManifest,
    plugin_path: str,
) -> list[PluginError]:
    """Validate a plugin manifest.  Returns a list of errors (empty = valid)."""
    errors: list[PluginError] = []

    if not manifest.name:
        errors.append(
            PluginError(
                type="manifest-validation-error",
                source=plugin_path,
                message="Plugin manifest missing 'name' field",
            )
        )

    # Validate component paths exist and are within plugin directory
    for field_name in ("commands", "agents", "skills"):
        paths = getattr(manifest, field_name, None)
        if paths is None:
            continue
        if isinstance(paths, str):
            paths = (paths,)
        for p in paths:
            if not validate_path_within_base(p, plugin_path):
                errors.append(
                    PluginError(
                        type="path-not-found",
                        source=plugin_path,
                        plugin=manifest.name,
                        message=f"Component path '{p}' is outside plugin directory",
                    )
                )

    return errors

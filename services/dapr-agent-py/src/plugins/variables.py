"""Substitution helpers for ${CLAUDE_PLUGIN_*} and ${user_config.X}."""
from __future__ import annotations

import re
from typing import Any

_USER_CONFIG_RE = re.compile(r"\$\{user_config\.([A-Za-z0-9_]+)\}")


def substitute(
    text: str,
    *,
    plugin_root: str = "",
    plugin_data: str = "",
    project_dir: str = "",
    user_config: dict[str, Any] | None = None,
) -> str:
    """Apply all plugin-related substitutions to a string, idempotent."""
    out = text
    out = out.replace("${CLAUDE_PLUGIN_ROOT}", plugin_root)
    out = out.replace("${CLAUDE_PLUGIN_DATA}", plugin_data)
    out = out.replace("${CLAUDE_PROJECT_DIR}", project_dir)
    if user_config:
        def _replace(match: re.Match) -> str:
            key = match.group(1)
            return str(user_config.get(key, match.group(0)))

        out = _USER_CONFIG_RE.sub(_replace, out)
    return out


def plugin_data_dir(plugin_id: str, base: str | None = None) -> str:
    """Canonical plugin data dir: $DAPR_AGENT_PY_PLUGIN_DATA/$plugin_id.

    Defaults to /var/lib/dapr-agent-py/plugins/$plugin_id.
    """
    import os
    import posixpath

    root = base or os.environ.get("DAPR_AGENT_PY_PLUGIN_DATA", "/var/lib/dapr-agent-py/plugins")
    return posixpath.join(root, plugin_id)


__all__ = ["substitute", "plugin_data_dir"]

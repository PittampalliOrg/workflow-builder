"""Plugin variable substitution.

Ported from claude-code-src/main/utils/plugins/mcpPluginIntegration.ts
(substitutePluginVariables).
"""

from __future__ import annotations

import re

from .directories import get_plugin_data_dir

_VAR_PATTERN = re.compile(
    r"\$\{(PLUGIN_ROOT|PLUGIN_DATA|PLUGIN_OPTIONS:(\w+))\}"
)


def substitute_plugin_variables(
    content: str,
    plugin_path: str,
    plugin_id: str,
    options: dict[str, str] | None = None,
) -> str:
    """Replace ``${PLUGIN_ROOT}``, ``${PLUGIN_DATA}``, ``${PLUGIN_OPTIONS:key}``.

    Matches the TS behavior but drops the ``CLAUDE_`` prefix since this is
    dapr-agent-py.
    """
    if "${" not in content:
        return content

    def _replace(m: re.Match) -> str:
        full = m.group(1)
        if full == "PLUGIN_ROOT":
            return plugin_path
        if full == "PLUGIN_DATA":
            return str(get_plugin_data_dir(plugin_id))
        # PLUGIN_OPTIONS:key
        key = m.group(2)
        if key and options:
            return options.get(key, "")
        return ""

    return _VAR_PATTERN.sub(_replace, content)

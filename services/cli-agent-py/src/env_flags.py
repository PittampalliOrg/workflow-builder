"""Leaf module for environment-derived feature flags.

Imports nothing from the package (only ``os``) so it can be imported from
anywhere — including ``cli_adapters`` and ``hooks_api`` — without an import
cycle. This is the single home for the ``CLI_TURN_FAILED_EDGE_ENABLED`` flag,
which the claude adapter (subscription side) and the hooks receiver (dispatch
side) must agree on but which previously duplicated the parse in both to dodge
the ``hooks_api → cli_adapters`` cycle.
"""

from __future__ import annotations

import os

_TRUE = frozenset({"1", "true", "yes", "on"})
_FALSE = frozenset({"0", "false", "no", "off"})


def env_bool(name: str, default: bool | None = None) -> bool | None:
    """Tri-state env bool: recognized truthy/falsy strings → True/False, anything
    else (including unset) → ``default``. Matches the tri-state ``_env_bool`` the
    antigravity adapter used."""
    raw = os.environ.get(name)
    if raw is None:
        return default
    value = raw.strip().lower()
    if value in _TRUE:
        return True
    if value in _FALSE:
        return False
    return default


# Turn-FAILURE edge master switch (default ON): when a claude StopFailure hook
# fires, the receiver raises ``turn.failed`` so a one-shot run fails
# deterministically instead of hanging until the pod's activeDeadline. Only an
# explicit falsy value disables it; unknown/unset → enabled.
CLI_TURN_FAILED_EDGE_ENABLED: bool = bool(env_bool("CLI_TURN_FAILED_EDGE_ENABLED", True))

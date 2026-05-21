"""Runtime dependency guardrails for the deployable Dapr agent service."""

from __future__ import annotations

import logging
from importlib import metadata

logger = logging.getLogger(__name__)

EXPECTED_DAPR_AGENTS_VERSION = "1.0.3"


def installed_dapr_agents_version() -> str:
    """Return the installed dapr-agents distribution version."""
    return metadata.version("dapr-agents")


def assert_dapr_agents_version(expected: str = EXPECTED_DAPR_AGENTS_VERSION) -> str:
    """Fail fast if runtime dependencies drift from the tested lock."""
    actual = installed_dapr_agents_version()
    if actual != expected:
        raise RuntimeError(
            "Unsupported dapr-agents version: "
            f"installed={actual!r} expected={expected!r}. "
            "Update pyproject.toml, uv.lock, replay/durability tests, and drain "
            "active Dapr workflows before changing this version."
        )
    logger.info("dapr-agents runtime version guard passed: %s", actual)
    return actual


__all__ = [
    "EXPECTED_DAPR_AGENTS_VERSION",
    "assert_dapr_agents_version",
    "installed_dapr_agents_version",
]

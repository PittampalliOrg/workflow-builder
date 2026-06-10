"""seed_session_activity — materialize per-session CLI seed artifacts.

Runs the adapter's ``seed`` (MCP config, system prompt, skills) on the pod's
filesystem before the TUI is launched. Deterministic + idempotent: re-running
overwrites the same files, so the workflow retries safely (RetryPolicy 3).
"""

from __future__ import annotations

import logging
from typing import Any, Mapping

from src.cli_adapters import get_adapter

logger = logging.getLogger(__name__)


def adapter_name_for(input_data: Mapping[str, Any]) -> str | None:
    agent_config = input_data.get("agentConfig")
    if isinstance(agent_config, Mapping):
        name = agent_config.get("cliAdapter")
        if isinstance(name, str) and name.strip():
            return name.strip()
    return None


def seed_session_activity(
    _ctx_or_input: Any, input_data: dict[str, Any] | None = None
) -> dict[str, Any]:
    payload = input_data if input_data is not None else _ctx_or_input
    data = payload if isinstance(payload, Mapping) else {}
    adapter = get_adapter(adapter_name_for(data))
    result = adapter.seed(data)
    logger.info(
        "[seed] adapter=%s paths=%s warnings=%d",
        adapter.name,
        result.paths,
        len(result.warnings),
    )
    return {"adapter": adapter.name, "paths": result.paths, "warnings": result.warnings}

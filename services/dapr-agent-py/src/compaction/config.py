"""Compaction configuration resolution.

Env vars are the baseline; per-run `agentConfig.compaction` overrides
specific fields. Resolution runs inside the orchestrator body (guarded
by `if not ctx.is_replaying`) and the resolved config is passed into
the activity via the payload — NOT read from env inside the activity —
so retries see deterministic values.
"""
from __future__ import annotations

import json
import logging
import os
from dataclasses import dataclass, field, asdict
from typing import Any, Optional

from .tokens import AUTOCOMPACT_BUFFER_TOKENS, MAX_OUTPUT_TOKENS_FOR_SUMMARY

logger = logging.getLogger(__name__)


def _env_bool(name: str, default: bool) -> bool:
    raw = os.environ.get(name)
    if raw is None:
        return default
    return raw.strip().lower() in ("1", "true", "yes", "on")


def _env_int(name: str, default: int | None) -> int | None:
    raw = os.environ.get(name)
    if raw is None or raw.strip() == "":
        return default
    try:
        return int(raw)
    except ValueError:
        logger.warning("[compaction] invalid int for %s=%r; using default", name, raw)
        return default


@dataclass(frozen=True)
class CompactionConfig:
    """Resolved compaction config, safe to serialize through Dapr activity payloads."""

    enabled: bool = True
    auto_compact_enabled: bool = True
    auto_compact_window: Optional[int] = None
    buffer_tokens: int = AUTOCOMPACT_BUFFER_TOKENS
    summary_reserve: int = MAX_OUTPUT_TOKENS_FOR_SUMMARY
    max_output_tokens: int = MAX_OUTPUT_TOKENS_FOR_SUMMARY
    preserve_last_n: int = 6
    custom_instructions: Optional[str] = None
    # continue_as_new policy — None means disabled
    continue_as_new_turn_threshold: Optional[int] = None
    continue_as_new_after_compactions: Optional[int] = None

    def to_dict(self) -> dict[str, Any]:
        """For embedding in Dapr payloads."""
        return asdict(self)

    @classmethod
    def from_dict(cls, data: dict[str, Any] | None) -> "CompactionConfig":
        if not isinstance(data, dict):
            return cls()
        fields = {f.name for f in cls.__dataclass_fields__.values()}  # type: ignore[attr-defined]
        clean = {k: v for k, v in data.items() if k in fields}
        return cls(**clean)


def _env_config() -> CompactionConfig:
    return CompactionConfig(
        enabled=_env_bool("DAPR_AGENT_PY_COMPACT_ENABLED", True),
        auto_compact_enabled=_env_bool("DAPR_AGENT_PY_AUTO_COMPACT_ENABLED", True),
        auto_compact_window=_env_int("DAPR_AGENT_PY_AUTO_COMPACT_WINDOW", None),
        buffer_tokens=_env_int(
            "DAPR_AGENT_PY_AUTO_COMPACT_BUFFER_TOKENS", AUTOCOMPACT_BUFFER_TOKENS
        )
        or AUTOCOMPACT_BUFFER_TOKENS,
        summary_reserve=_env_int(
            "DAPR_AGENT_PY_COMPACT_SUMMARY_RESERVE", MAX_OUTPUT_TOKENS_FOR_SUMMARY
        )
        or MAX_OUTPUT_TOKENS_FOR_SUMMARY,
        max_output_tokens=_env_int(
            "DAPR_AGENT_PY_COMPACT_MAX_OUTPUT_TOKENS", MAX_OUTPUT_TOKENS_FOR_SUMMARY
        )
        or MAX_OUTPUT_TOKENS_FOR_SUMMARY,
        preserve_last_n=_env_int("DAPR_AGENT_PY_COMPACT_PRESERVE_LAST_N", 6) or 6,
        custom_instructions=None,
        continue_as_new_turn_threshold=_env_int(
            "DAPR_AGENT_PY_CONTINUE_AS_NEW_TURN_THRESHOLD", None
        ),
        continue_as_new_after_compactions=_env_int(
            "DAPR_AGENT_PY_CONTINUE_AS_NEW_AFTER_COMPACTIONS", None
        ),
    )


def _extract_agent_config(message: dict[str, Any]) -> dict[str, Any] | None:
    raw = message.get("agentConfig")
    if isinstance(raw, dict):
        return raw
    if isinstance(raw, str) and raw.strip():
        try:
            parsed = json.loads(raw)
            return parsed if isinstance(parsed, dict) else None
        except json.JSONDecodeError:
            return None
    return None


def _per_run_override(message: dict[str, Any]) -> dict[str, Any]:
    agent_config = _extract_agent_config(message) or {}
    raw = agent_config.get("compaction")
    if not isinstance(raw, dict):
        return {}
    # Accept both snake_case (python idiomatic) and camelCase (TS-style payloads).
    alias_map = {
        "autoCompact": "auto_compact_enabled",
        "autoCompactEnabled": "auto_compact_enabled",
        "autoCompactWindow": "auto_compact_window",
        "bufferTokens": "buffer_tokens",
        "summaryReserve": "summary_reserve",
        "maxOutputTokens": "max_output_tokens",
        "preserveLastN": "preserve_last_n",
        "customInstructions": "custom_instructions",
        "continueAsNewTurnThreshold": "continue_as_new_turn_threshold",
        "continueAsNewAfterCompactions": "continue_as_new_after_compactions",
    }
    normalized: dict[str, Any] = {}
    for k, v in raw.items():
        key = alias_map.get(k, k)
        normalized[key] = v
    return normalized


def _context_strategy(message: dict[str, Any]) -> str:
    """Extract agentConfig.contextStrategy (Anthropic CMA pattern).

    When set to "event_log", compaction is force-disabled — the agent
    manages context by re-fetching events from the durable session log
    (see src/tools/read_session_events/). Any other value (including the
    default "compaction") keeps existing compaction behavior.
    """
    agent_config = _extract_agent_config(message) or {}
    raw = agent_config.get("contextStrategy") or agent_config.get(
        "context_strategy"
    )
    if isinstance(raw, str):
        normalized = raw.strip().lower()
        if normalized in {"event_log", "event-log", "eventlog"}:
            return "event_log"
    return "compaction"


def resolve_config(message: dict[str, Any] | None) -> CompactionConfig:
    """Resolve env + per-run overrides into a single CompactionConfig.

    Called from the orchestrator body during per-run setup. The resulting
    config must be passed through activity payloads so retries see the
    same values (env is still OK to read inside activities, but we prefer
    the deterministic path).

    If agentConfig.contextStrategy == "event_log", compaction is forced
    off regardless of env / per-run overrides. Compaction and event-log
    interrogation are alternatives per Anthropic's Managed Agents design
    — they shouldn't both run in the same turn.
    """
    base = _env_config()
    overrides = _per_run_override(message or {})
    if _context_strategy(message or {}) == "event_log":
        overrides["enabled"] = False
        if logger.isEnabledFor(logging.INFO):
            logger.info(
                "[compaction] disabled for this run: contextStrategy=event_log"
            )
    if not overrides:
        return base
    merged = {**asdict(base), **overrides}
    try:
        return CompactionConfig(**merged)
    except TypeError as exc:
        logger.warning("[compaction] invalid per-run override: %s", exc)
        return base


__all__ = ["CompactionConfig", "resolve_config"]

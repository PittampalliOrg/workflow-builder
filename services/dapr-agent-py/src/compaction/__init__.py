"""Context compaction subsystem.

Port of claude-code-src/main/services/compact — summarizes long
conversation history into a compact boundary + summary so agents can
continue past the context window. Integrated into the durable agent's
existing call_llm activity (no new workflow yield needed).

Public surface:
    CompactionConfig    — env + per-run config dataclass
    maybe_compact       — the entry point called inline from call_llm
    CompactionResult    — return shape
"""
from __future__ import annotations

from .config import CompactionConfig, resolve_config
from .engine import CompactionResult, maybe_compact
from .state_budget import (
    StateBudgetConfig,
    StateBudgetResult,
    enforce_state_budget,
    enforce_state_byte_budget,
    resolve_state_budget_config,
    serialized_state_bytes,
)

__all__ = [
    "CompactionConfig",
    "CompactionResult",
    "maybe_compact",
    "resolve_config",
    "StateBudgetConfig",
    "StateBudgetResult",
    "enforce_state_budget",
    "enforce_state_byte_budget",
    "resolve_state_budget_config",
    "serialized_state_bytes",
]

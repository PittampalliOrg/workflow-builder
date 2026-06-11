"""Adapter protocol for interactive-cli runtimes.

A CLI adapter translates the platform's session input (``agentConfig``,
``instructionBundle``, ...) into:
  - on-disk seed artifacts (MCP config, system prompt, skills),
  - the pane argv to launch the TUI,
  - the pane environment,
plus optional hook/transcript mapping overrides (the hooks receiver and
transcript tailer consult these before applying their defaults).
"""

from __future__ import annotations

import abc
from dataclasses import dataclass, field
from typing import Any, Mapping


@dataclass
class SeedResult:
    """Paths of materialized seed artifacts, keyed by well-known names
    (``mcpConfigPath``, ``systemPromptPath``, ``skillsDir``)."""

    paths: dict[str, str] = field(default_factory=dict)
    warnings: list[str] = field(default_factory=list)


class CliAdapter(abc.ABC):
    name: str = "base"

    # When True, the CLI requires an interactive login in the pane on first
    # launch (device-code OAuth) before it reaches its real prompt. The
    # lifecycle then SKIPS the readiness-gated kickoff injection: herdr may
    # report the auth-code prompt as `idle`, and typing the seed message there
    # would mis-submit it as the authorization code. The user authenticates and
    # types their first message in the terminal. (Antigravity device-login.)
    requires_interactive_login: bool = False

    @abc.abstractmethod
    def seed(self, session_input: Mapping[str, Any]) -> SeedResult:
        """Materialize per-session files (MCP config, system prompt, skills)."""

    @abc.abstractmethod
    def build_argv(
        self, agent_config: Mapping[str, Any], seed_paths: Mapping[str, str]
    ) -> list[str]:
        """Build the TUI launch argv from agentConfig + seeded paths."""

    @abc.abstractmethod
    def pane_env(
        self,
        base_env: Mapping[str, str],
        *,
        session_id: str | None = None,
    ) -> dict[str, str]:
        """Build the pane environment (allow-list based; never API keys)."""

    # -- optional mapping hooks ------------------------------------------------

    def map_hook_event(self, payload: Mapping[str, Any]) -> list[dict[str, Any]] | None:
        """Override CLI-hook → session-event mapping. Return None to use the
        default mapping in src.hooks_api."""
        return None

    def map_transcript_entry(
        self, entry: Mapping[str, Any]
    ) -> list[dict[str, Any]] | None:
        """Override transcript-entry → session-event mapping. Return None to use
        the default mapping in src.transcript_tailer."""
        return None


_REGISTRY: dict[str, CliAdapter] = {}
DEFAULT_ADAPTER_NAME = "claude-code"


def register_adapter(adapter: CliAdapter) -> None:
    _REGISTRY[adapter.name] = adapter


def get_adapter(name: str | None = None) -> CliAdapter:
    key = (name or "").strip() or DEFAULT_ADAPTER_NAME
    adapter = _REGISTRY.get(key)
    if adapter is None:
        adapter = _REGISTRY.get(DEFAULT_ADAPTER_NAME)
    if adapter is None:
        raise KeyError(f"No CLI adapter registered for '{key}'")
    return adapter

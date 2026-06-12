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
import logging
import os
import shutil
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Mapping

logger = logging.getLogger(__name__)


def link_transcript_subtree(cli_transcript_dir: Path, store_subdir: str) -> str | None:
    """Point a CLI's transcript dir at the durable per-session store.

    The interactive-cli sandbox optionally mounts a per-session Postgres-backed
    JuiceFS subtree at ``CLI_TRANSCRIPT_MOUNT`` (sandbox-execution-api
    ``transcriptStore*``). Symlinking the CLI's own transcript directory into it
    makes the conversation durable + native ``--resume``-able with zero CLI
    changes, while credentials/onboarding state stay on the ephemeral emptyDir
    (only the transcript bytes reach Postgres). No-op (returns ``None``) when the
    store is not mounted, so it is safe on every cluster/runtime.

    Idempotent across pod restarts and resumes: an existing symlink is left
    as-is; a pre-existing real transcript dir is migrated into the store then
    replaced by the symlink (never clobbered).
    """
    mount_raw = os.environ.get("CLI_TRANSCRIPT_MOUNT", "").strip()
    if not mount_raw:
        return None
    mount = Path(mount_raw)
    if not mount.is_dir():
        logger.warning("CLI_TRANSCRIPT_MOUNT=%s is not a directory; skipping", mount_raw)
        return None
    target = mount / store_subdir
    try:
        target.mkdir(parents=True, exist_ok=True)
        cli_transcript_dir.parent.mkdir(parents=True, exist_ok=True)
    except OSError as exc:
        logger.warning("transcript store mkdir failed (%s); skipping", exc)
        return None
    if cli_transcript_dir.is_symlink():
        return str(target)
    if cli_transcript_dir.exists():
        # A real dir already holds transcripts (CLI wrote before seed, or an
        # image-baked dir). Migrate into the durable store, then replace with
        # the symlink so future writes persist. Never lose data.
        try:
            for child in cli_transcript_dir.iterdir():
                dest = target / child.name
                if not dest.exists():
                    shutil.move(str(child), str(dest))
            cli_transcript_dir.rmdir()
        except OSError as exc:
            logger.warning(
                "transcript store: could not migrate %s (%s); leaving local dir",
                cli_transcript_dir,
                exc,
            )
            return None
    try:
        cli_transcript_dir.symlink_to(target, target_is_directory=True)
    except OSError as exc:
        logger.warning("transcript store symlink failed (%s); skipping", exc)
        return None
    return str(target)


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

    # When True, injected prompts (kickoff seed + raise-event continuations) are
    # prefixed with the zero-width INJECTION_MARKER so a Claude-style
    # UserPromptSubmit hook can dedup self-injected prompts (hooks_api.py). This
    # is ONLY meaningful for runtimes whose session events come from such hooks.
    # codex/agy mirror their events from native rollout files (no hook), and
    # codex's ratatui composer mangles a leading zero-width run — it swallows the
    # whole leading token up to the first space, dropping the first word of every
    # kickoff. Those adapters set this False so the marker is never sent.
    uses_injection_marker: bool = True

    # When set, the kickoff/injection readiness gate waits until this substring
    # appears in the pane's VISIBLE screen (the composer is actually rendered),
    # instead of trusting herdr's `agent_status`. Needed for TUIs herdr only
    # SCREEN-DETECTS (agy), where herdr reports `idle` during the pre-composer
    # boot screen — typing then strands the seed above the banner with an empty
    # composer. None → use the agent_status gate (claude/codex have native herdr
    # state). The substring should be a stable element of the idle prompt (e.g.
    # agy's "? for shortcuts" footer).
    prompt_ready_marker: str | None = None

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

    # -- optional lifecycle / mapping hooks ------------------------------------

    def on_session_started(self, session_id: str | None) -> None:
        """Called once after the pane launches + the supervisor registers the
        session. Override to start adapter-specific background work (e.g. agy's
        ~/.gemini login-bundle capture watcher). Default: no-op."""

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

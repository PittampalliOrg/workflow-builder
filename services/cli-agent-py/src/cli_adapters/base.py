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
import shlex
import shutil
import stat
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
        logger.warning(
            "CLI_TRANSCRIPT_MOUNT=%s is not a directory; skipping", mount_raw
        )
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

    # When True, the CLI's UserPromptSubmit hook is the authoritative submit
    # edge for injected prompts. The supervisor still verifies that Enter left
    # the composer, but it does not publish session.turn_started itself; the hook
    # records the turn once it confirms the CLI accepted the prompt. This is
    # needed for CLIs whose composers cannot safely receive INJECTION_MARKER but
    # whose hook payloads still report prompt submission (Codex).
    hook_reports_prompt_submit: bool = False

    # When set, the kickoff/injection readiness gate waits until this substring
    # appears in the pane's VISIBLE screen (the composer is actually rendered),
    # instead of trusting herdr's `agent_status`. Needed for TUIs herdr only
    # SCREEN-DETECTS (agy), where herdr reports `idle` during the pre-composer
    # boot screen — typing then strands the seed above the banner with an empty
    # composer. None → use the agent_status gate (claude/codex have native herdr
    # state). The substring should be a stable element of the idle prompt (e.g.
    # agy's "? for shortcuts" footer).
    prompt_ready_marker: str | None = None

    # Some CLIs can accept a submitted prompt, produce a short answer, and return
    # to their idle composer before the supervisor's post-Enter verification
    # sample. For those runtimes, an idle sample after a delayed successful Enter
    # is not proof that Enter was dropped.
    idle_after_submit_is_success: bool = False

    # Screen strings that mean the prompt is visible but unsafe to type into.
    # This is for CLIs herdr screen-detects as idle even while their internal
    # executor/input queue is still busy after a cancelled tool call.
    prompt_not_ready_markers: tuple[str, ...] = ()

    def format_seed_user_message(self, text: str) -> str:
        """Return the first prompt typed into the CLI TUI.

        Adapters can wrap the kickoff in CLI-native control commands while
        leaving later user continuations unchanged.
        """
        return text

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

    def is_turn_completion_hook(self, event_name: str) -> bool:
        """True when this hook event is the adapter's authoritative end-turn
        signal. The lifecycle workflow uses this as the completion edge for
        workflow-mode ``autoTerminateAfterEndTurn`` runs."""
        return event_name == "Stop"

    def stop_hook_completes_turn(self) -> bool:
        """Whether a generic Stop hook should synthesize ``turn.completed``.

        Some CLIs publish an authoritative native transcript completion before
        their Stop hook runs. For those adapters, letting Stop synthesize a
        second lifecycle event duplicates the platform turn.
        """
        return True

    def extract_completion_text(self, payload: Mapping[str, Any]) -> str | None:
        """Best-effort final assistant text from a completion-hook payload or
        CLI-owned transcript files. Claude gets this from its transcript tailer;
        other adapters can override when the hook payload or native state carries
        the completed turn's response."""
        return None

    def hook_response(
        self, event_name: str, payload: Mapping[str, Any], session: Mapping[str, Any]
    ) -> dict[str, Any] | None:
        """Optional synchronous command-hook response.

        Most hook events are telemetry-only and return no stdout. Some CLIs,
        notably Antigravity's Stop hook, support a JSON response that can alter
        loop control.
        """
        return None

    def discover_transcript_path(self) -> str | None:
        """Fallback transcript-file discovery for the tailer.

        The tailer normally registers from each hook payload's ``transcript_path``.
        Some CLIs (notably Antigravity) don't reliably carry that field in their
        command-hook payloads, so a transient early-hook miss can leave the tailer
        unregistered and no ``agent.message``/``agent.llm_usage`` mirrored. Adapters
        that know where their CLI writes the transcript override this so the hooks
        receiver can register the tailer from ANY hook. The tailer reads from
        offset 0, so a late registration backfills the whole file losslessly.
        Default: no fallback (payload ``transcript_path`` is authoritative)."""
        return None

    def map_transcript_entry(
        self, entry: Mapping[str, Any]
    ) -> list[dict[str, Any]] | None:
        """Override transcript-entry → session-event mapping. Return None to use
        the default mapping in src.transcript_tailer."""
        return None

    def transcript_turn_completion(self, entry: Mapping[str, Any]) -> dict[str, Any] | None:
        """Return a lifecycle ``turn.completed`` event when this transcript entry
        is the adapter's authoritative completed-turn record.

        The return value is raised onto the Dapr workflow instance, not persisted
        to ``session_events``. Adapters should only return an event for final
        assistant output, not interim thinking/tool-request transcript rows.
        """
        return None

    def detect_goal_completion(
        self, entry: Mapping[str, Any]
    ) -> dict[str, Any] | None:
        """Recognize the CLI's NATIVE goal-loop completion from a transcript row.

        The interactive CLIs run their own multi-turn ``/goal`` loop (their own
        evaluator decides done), so the per-turn Stop hook is NOT a reliable
        "goal done" signal. Adapters whose native completion is observable in the
        transcript (e.g. claude's evaluator "goal achieved" row) override this to
        return the ``session.goal_completed`` event ``data`` (without ``type``;
        the tailer stamps it and publishes ONCE per goal). Telemetry-only — the
        session intentionally stays idle (no auto-stop). Default: no detection.
        """
        return None


def write_hook_relay_script(path: Path) -> Path:
    """Materialize the command-hook relay used by Codex and Antigravity.

    Their documented hook systems execute command hooks and pass JSON on stdin;
    cli-agent-py wants one local HTTP surface. The relay copies stdin JSON,
    stamps the adapter/event when the CLI omitted them, posts to the in-pod
    receiver, prints a non-empty JSON hook response when the receiver returns
    one, and always exits zero so a transient telemetry failure does not block
    the user's CLI turn.
    """
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        """#!/usr/bin/env python3
import argparse
import json
import os
import sys
import urllib.request


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--adapter", required=True)
    parser.add_argument("--event", required=True)
    args = parser.parse_args()
    raw = sys.stdin.read()
    try:
        payload = json.loads(raw) if raw.strip() else {}
    except Exception:
        payload = {"raw": raw}
    if not isinstance(payload, dict):
        payload = {"value": payload}
    payload.setdefault("hook_event_name", args.event)
    payload.setdefault("eventName", args.event)
    payload.setdefault("hook_adapter", args.adapter)
    body = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        f"http://127.0.0.1:8002/internal/hooks/cli/{args.adapter}",
        data=body,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        timeout = int(os.environ.get("CLI_AGENT_HOOK_RELAY_TIMEOUT_SECONDS", "660"))
        raw_response = urllib.request.urlopen(req, timeout=max(1, timeout)).read()
        if raw_response:
            response = json.loads(raw_response.decode("utf-8"))
            if isinstance(response, dict) and response:
                sys.stdout.write(json.dumps(response))
                sys.stdout.write("\\n")
    except Exception:
        pass
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
""",
        encoding="utf-8",
    )
    try:
        path.chmod(
            stat.S_IRUSR
            | stat.S_IWUSR
            | stat.S_IXUSR
            | stat.S_IRGRP
            | stat.S_IXGRP
            | stat.S_IROTH
            | stat.S_IXOTH
        )
    except OSError:
        pass
    return path


def hook_relay_command(path: Path, *, adapter: str, event: str) -> str:
    return (
        f"python3 {shlex.quote(str(path))} "
        f"--adapter {shlex.quote(adapter)} --event {shlex.quote(event)}"
    )


_REGISTRY: dict[str, CliAdapter] = {}
DEFAULT_ADAPTER_NAME = "claude-code"
RUNTIME_ADAPTERS = {
    "claude-code-cli": "claude-code",
    "codex-cli": "codex",
    "agy-cli": "antigravity",
}


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


def adapter_name_for_session_input(input_data: Mapping[str, Any]) -> str | None:
    """Resolve the adapter from lifecycle workflow input.

    Legacy/direct callers that provide neither runtime nor cliAdapter retain the
    historical get_adapter(None) default. Once a runtime descriptor is stamped,
    the adapter must be present and must match that runtime; otherwise a Codex
    or Antigravity workflow would silently launch Claude Code.
    """

    agent_config = input_data.get("agentConfig")
    if not isinstance(agent_config, Mapping):
        return None
    raw_adapter = agent_config.get("cliAdapter")
    adapter = (
        raw_adapter.strip()
        if isinstance(raw_adapter, str) and raw_adapter.strip()
        else None
    )
    raw_runtime = agent_config.get("runtime")
    runtime = (
        raw_runtime.strip()
        if isinstance(raw_runtime, str) and raw_runtime.strip()
        else None
    )
    expected = RUNTIME_ADAPTERS.get(runtime or "")
    if not expected:
        return adapter
    if adapter != expected:
        got = adapter or "<missing>"
        raise ValueError(
            f'agentConfig.runtime "{runtime}" requires agentConfig.cliAdapter '
            f'"{expected}", got "{got}"'
        )
    return adapter

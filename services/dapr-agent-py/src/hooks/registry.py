"""In-memory registry of hooks keyed by event.

The registry is append-only from the perspective of a single caller —
settings and plugins register hooks at startup. A frozen `HooksSnapshot`
is captured at workflow start so hot reloads do not affect in-flight
instances (matches TS hooksConfigSnapshot semantics).
"""
from __future__ import annotations

import copy
import fnmatch
import re
from dataclasses import dataclass, field
from typing import Any, Literal, Optional

from .events import HookEvent
from .schemas import HookCommand, HookMatcher, HooksSettings


HookSource = Literal["managed", "project", "local", "user", "plugin", "per_run", "builtin"]


@dataclass(frozen=True)
class RegisteredHook:
    """A single hook with its matcher + source context."""

    event: str
    matcher: str  # "" means match-all
    hook: HookCommand
    source: HookSource
    plugin_id: Optional[str] = None
    plugin_root: Optional[str] = None


@dataclass
class MatchingHook:
    """Result of resolving the registry against a single event + query."""

    registered: RegisteredHook

    @property
    def hook(self) -> HookCommand:
        return self.registered.hook


def _matcher_matches(matcher: str, query: str) -> bool:
    """Evaluate a HookMatcher.matcher pattern against the event query.

    - empty or `*` -> always matches
    - starts and ends with `/` -> treat body as regex (TS parity)
    - contains `|` -> treat as pipe-separated alternation of patterns
      (TS convention for matcher values like "Edit|Write|MultiEdit")
    - else -> fnmatch glob (case-sensitive)
    """
    if not matcher or matcher == "*":
        return True
    if len(matcher) >= 2 and matcher.startswith("/") and matcher.endswith("/"):
        try:
            return re.search(matcher[1:-1], query) is not None
        except re.error:
            return False
    if "|" in matcher:
        for alt in matcher.split("|"):
            alt = alt.strip()
            if not alt:
                continue
            if alt == query or fnmatch.fnmatchcase(query, alt):
                return True
        return False
    return fnmatch.fnmatchcase(query, matcher)


class HookRegistry:
    """Mutable registry. Call `.snapshot()` to get an immutable view."""

    def __init__(self) -> None:
        self._by_event: dict[str, list[RegisteredHook]] = {}

    # ---- registration ------------------------------------------------------

    def register_from_settings(
        self,
        settings: HooksSettings,
        source: HookSource,
    ) -> None:
        for event_name, matchers in settings.root.items():
            for matcher in matchers:
                pattern = matcher.matcher or ""
                for hook in matcher.hooks:
                    self._append(
                        RegisteredHook(
                            event=event_name,
                            matcher=pattern,
                            hook=hook,
                            source=source,
                        )
                    )

    def register_from_plugin(
        self,
        plugin_id: str,
        plugin_root: str,
        settings: HooksSettings,
    ) -> None:
        for event_name, matchers in settings.root.items():
            for matcher in matchers:
                pattern = matcher.matcher or ""
                for hook in matcher.hooks:
                    self._append(
                        RegisteredHook(
                            event=event_name,
                            matcher=pattern,
                            hook=hook,
                            source="plugin",
                            plugin_id=plugin_id,
                            plugin_root=plugin_root,
                        )
                    )

    def register_builtin(self, event: HookEvent, hook: HookCommand, matcher: str = "") -> None:
        self._append(
            RegisteredHook(
                event=event.value,
                matcher=matcher,
                hook=hook,
                source="builtin",
            )
        )

    def _append(self, registered: RegisteredHook) -> None:
        self._by_event.setdefault(registered.event, []).append(registered)

    # ---- querying ----------------------------------------------------------

    def events(self) -> list[str]:
        return list(self._by_event.keys())

    def count(self, event: str | HookEvent) -> int:
        key = event.value if isinstance(event, HookEvent) else event
        return len(self._by_event.get(key, []))

    # ---- snapshotting ------------------------------------------------------

    def snapshot(self) -> "HooksSnapshot":
        # Deep-copy the hook models so the snapshot is immune to later mutation.
        frozen: dict[str, tuple[RegisteredHook, ...]] = {}
        for event, items in self._by_event.items():
            frozen[event] = tuple(
                RegisteredHook(
                    event=r.event,
                    matcher=r.matcher,
                    hook=r.hook.model_copy(deep=True),
                    source=r.source,
                    plugin_id=r.plugin_id,
                    plugin_root=r.plugin_root,
                )
                for r in items
            )
        return HooksSnapshot(by_event=frozen)

    # ---- mutation for hot reload / plugin swap -----------------------------

    def clear_plugin_hooks(self, plugin_id: str) -> None:
        for event, items in list(self._by_event.items()):
            filtered = [r for r in items if r.plugin_id != plugin_id]
            if filtered:
                self._by_event[event] = filtered
            else:
                self._by_event.pop(event, None)

    def clear(self) -> None:
        self._by_event.clear()


@dataclass(frozen=True)
class HooksSnapshot:
    """Immutable, deep-copied view of the registry at a point in time."""

    by_event: dict[str, tuple[RegisteredHook, ...]] = field(default_factory=dict)

    def get_matching_hooks(
        self,
        event: str | HookEvent,
        query: str = "",
    ) -> list[MatchingHook]:
        key = event.value if isinstance(event, HookEvent) else event
        out: list[MatchingHook] = []
        for r in self.by_event.get(key, ()):
            if _matcher_matches(r.matcher, query):
                out.append(MatchingHook(registered=r))
        return out

    def overlay(self, per_run_settings: HooksSettings) -> "HooksSnapshot":
        """Return a new snapshot with per-run hooks appended (mirrors plugin
        registration order: managed -> user -> project -> plugin -> per_run).
        """
        merged = {event: list(items) for event, items in self.by_event.items()}
        for event_name, matchers in per_run_settings.root.items():
            for matcher in matchers:
                pattern = matcher.matcher or ""
                for hook in matcher.hooks:
                    merged.setdefault(event_name, []).append(
                        RegisteredHook(
                            event=event_name,
                            matcher=pattern,
                            hook=hook.model_copy(deep=True),
                            source="per_run",
                        )
                    )
        return HooksSnapshot(by_event={event: tuple(items) for event, items in merged.items()})

    def count_by_event(self) -> dict[str, int]:
        return {event: len(items) for event, items in self.by_event.items()}


def empty_snapshot() -> HooksSnapshot:
    return HooksSnapshot(by_event={})


__all__ = [
    "HookRegistry",
    "HooksSnapshot",
    "RegisteredHook",
    "MatchingHook",
    "HookSource",
    "empty_snapshot",
]

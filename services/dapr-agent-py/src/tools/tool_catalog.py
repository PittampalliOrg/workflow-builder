from __future__ import annotations

import json
from collections import Counter
from functools import lru_cache
from pathlib import Path

from dapr_agents import tool

from .models import (
    ExecuteToolSchema,
    FindToolsSchema,
    RenderToolIndexSchema,
    RoutePromptSchema,
    ShowToolSchema,
    ToolEntry,
)

SNAPSHOT_PATH = Path(__file__).resolve().parent / "reference_data" / "tools_snapshot.json"
SRC_ROOT = Path(__file__).resolve().parent.parent


@lru_cache(maxsize=1)
def _load_snapshot() -> tuple[ToolEntry, ...]:
    raw_entries = json.loads(SNAPSHOT_PATH.read_text())
    return tuple(
        ToolEntry(
            name=entry["name"],
            source_hint=entry["source_hint"],
            responsibility=entry["responsibility"],
        )
        for entry in raw_entries
    )


def _get_tool_entry(name: str) -> ToolEntry | None:
    needle = name.lower()
    for entry in _load_snapshot():
        if entry.name.lower() == needle:
            return entry
    return None


@tool(args_model=FindToolsSchema)
def find_tools(query: str, limit: int = 20) -> str:
    """Search the tool catalog by keyword. Matches against tool names and source hints."""
    needle = query.lower()
    snapshot = _load_snapshot()
    matches = [
        entry
        for entry in snapshot
        if needle in entry.name.lower() or needle in entry.source_hint.lower()
    ][:limit]
    if not matches:
        return f"No tools found matching '{query}'."
    lines = [f"Found {len(matches)} tool(s) matching '{query}':", ""]
    lines.extend(f"- **{entry.name}** — {entry.source_hint}" for entry in matches)
    return "\n".join(lines)


@tool(args_model=ShowToolSchema)
def show_tool(name: str) -> str:
    """Get detailed information about a specific tool by exact name."""
    entry = _get_tool_entry(name)
    if entry is None:
        return f"Tool not found: {name}"
    return "\n".join([
        f"**{entry.name}**",
        f"Source: {entry.source_hint}",
        f"Responsibility: {entry.responsibility}",
    ])


@tool(args_model=ExecuteToolSchema)
def execute_tool(name: str, payload: str = "") -> str:
    """Execute a mirrored tool shim by name with an optional payload."""
    entry = _get_tool_entry(name)
    if entry is None:
        return f"Unknown mirrored tool: {name}"
    return f"Mirrored tool '{entry.name}' from {entry.source_hint} would handle payload {payload!r}."


@tool(args_model=RenderToolIndexSchema)
def render_tool_index(limit: int = 20, query: str | None = None) -> str:
    """List available tools from the catalog, optionally filtered by keyword."""
    snapshot = _load_snapshot()
    if query:
        needle = query.lower()
        modules = [
            e for e in snapshot if needle in e.name.lower() or needle in e.source_hint.lower()
        ][:limit]
    else:
        modules = list(snapshot[:limit])
    lines = [f"Tool entries: {len(snapshot)}", ""]
    if query:
        lines.append(f"Filtered by: {query}")
        lines.append("")
    lines.extend(f"- {entry.name} — {entry.source_hint}" for entry in modules)
    return "\n".join(lines)


@tool(args_model=RoutePromptSchema)
def route_prompt(prompt: str, limit: int = 5) -> str:
    """Route a natural-language prompt to matching tools by scoring token overlap."""
    tokens = {
        token.lower()
        for token in prompt.replace("/", " ").replace("-", " ").split()
        if token
    }
    if not tokens:
        return "No tokens found in prompt."

    snapshot = _load_snapshot()
    scored: list[tuple[int, ToolEntry]] = []
    for entry in snapshot:
        haystacks = [entry.name.lower(), entry.source_hint.lower(), entry.responsibility.lower()]
        score = sum(1 for token in tokens if any(token in h for h in haystacks))
        if score > 0:
            scored.append((score, entry))

    scored.sort(key=lambda item: (-item[0], item[1].name))
    top = scored[:limit]
    if not top:
        return f"No tool matches for prompt: {prompt}"
    lines = [f"Top {len(top)} tool match(es) for '{prompt}':", ""]
    lines.extend(
        f"- [{score}] **{entry.name}** — {entry.source_hint}" for score, entry in top
    )
    return "\n".join(lines)


@tool
def port_manifest() -> str:
    """Scan the project source directory and report its Python file structure."""
    files = [p for p in SRC_ROOT.rglob("*.py") if p.is_file() and "__pycache__" not in str(p)]
    counter = Counter(
        p.relative_to(SRC_ROOT).parts[0] if len(p.relative_to(SRC_ROOT).parts) > 1 else p.name
        for p in files
    )
    lines = [
        f"Port root: `{SRC_ROOT}`",
        f"Total Python files: **{len(files)}**",
        "",
        "Top-level Python modules:",
    ]
    for name, count in counter.most_common():
        lines.append(f"- `{name}` ({count} files)")
    return "\n".join(lines)

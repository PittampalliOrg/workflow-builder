"""Concurrency-safe tool batching (modeled on Claude Code's harness).

Claude Code declares an ``isConcurrencySafe()`` per tool: read-only tools (Read,
Grep, Glob, …) are true; Edit/Write default false; Bash is conditional on the
command being read-only. Its scheduler walks the turn's tool calls in order,
groups CONSECUTIVE concurrency-safe calls into one parallel batch, runs any
unsafe tool alone (serial), caps fan-out (default 10), and re-orders results to
the original call order.

We port that model: read-only tools batch via the Dapr workflow ``ctx.when_all``
fan-out; everything else stays on the strict one-at-a-time path. Bash is treated
UNSAFE here (we do not parse the command) — the dominant win is parallel file
reads, which is most of what makes a multi-read turn slow.

This module is intentionally dependency-free (no dapr/grpc imports) so the
partition logic is unit-testable in isolation and replay-deterministic.
"""

from __future__ import annotations

import os
from typing import Any, Callable

_CONCURRENCY_SAFE_TOOL_NAMES = frozenset(
    {
        "read",
        "grep",
        "glob",
        "ls",
        "notebookread",
        "webfetch",
        "websearch",
        "readmcpresource",
        "read_file",
        "list_directory",
        "list_dir",
        "search_files",
        "view",
        "cat",
    }
)
_CONCURRENCY_SAFE_MCP_PREFIXES = (
    "get_",
    "list_",
    "read_",
    "search_",
    "fetch_",
    "query_",
    "describe_",
)


def max_tool_concurrency() -> int:
    """Bounded fan-out for a parallel tool batch (Claude Code default = 10). We
    default lower (6) given dapr-agent-py's history of same-turn scheduling bursts
    under load; env-tunable via DAPR_AGENT_PY_MAX_TOOL_CONCURRENCY."""
    try:
        return max(1, int(os.environ.get("DAPR_AGENT_PY_MAX_TOOL_CONCURRENCY", "6")))
    except ValueError:
        return 6


def tool_name_concurrency_safe(name: str) -> bool:
    """Mirror Claude Code's isConcurrencySafe by tool name. Default UNSAFE."""
    n = (name or "").strip().lower()
    if not n:
        return False
    if n in _CONCURRENCY_SAFE_TOOL_NAMES:
        return True
    # MCP tools are namespaced (mcp__server__get_x); classify by the leaf verb.
    leaf = n.split("__")[-1]
    if leaf in _CONCURRENCY_SAFE_TOOL_NAMES:
        return True
    return any(leaf.startswith(p) for p in _CONCURRENCY_SAFE_MCP_PREFIXES)


def partition_tool_calls(
    tool_calls: list[dict[str, Any]],
    *,
    is_batchable: Callable[[dict[str, Any]], bool],
    max_concurrency: int,
) -> list[dict[str, Any]]:
    """Partition a turn's tool calls into ordered runs (Claude Code's
    partitionToolCalls). Consecutive batchable calls coalesce into one parallel
    partition (capped at ``max_concurrency``); any non-batchable call is its own
    serial partition. Returns a list of ``{"parallel": bool, "items": [(idx, tc)]}``
    preserving original order. Pure + deterministic (replay-safe).
    """
    partitions: list[dict[str, Any]] = []
    for idx, tc in enumerate(tool_calls):
        safe = bool(is_batchable(tc))
        if (
            safe
            and partitions
            and partitions[-1]["parallel"]
            and len(partitions[-1]["items"]) < max_concurrency
        ):
            partitions[-1]["items"].append((idx, tc))
        else:
            partitions.append({"parallel": safe, "items": [(idx, tc)]})
    # A "parallel" partition of one is just a serial call — normalize so callers
    # only fan out when there is genuinely >1 task.
    for p in partitions:
        if p["parallel"] and len(p["items"]) < 2:
            p["parallel"] = False
    return partitions

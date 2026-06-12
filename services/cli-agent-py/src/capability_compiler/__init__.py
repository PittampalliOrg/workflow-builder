"""Capability compiler — the SSOT for translating an agent's declared
capabilities (MCP servers, and later skills) onto each runtime's native
delivery shape.

Pillar 1 of the capability-standardization plan. Vendored byte-identical into
each Python service's build context by ``scripts/sync-runtime-registry.mjs``;
the canonical source lives at ``services/shared/capability_compiler/``.

Currently exposes the per-target MCP emitters that consolidate the four
duplicated translators:

  * ``emit_claude_code_cli_servers``   (cli-agent-py)
  * ``emit_claude_agent_sdk_servers``  (claude-agent-py)
  * ``emit_dapr_agent_py``             (dapr-agent-py)

See :mod:`capability_compiler.mcp` and :mod:`capability_compiler.normalize`.
"""

from __future__ import annotations

from .mcp import (
    emit_claude_agent_sdk_servers,
    emit_claude_code_cli_servers,
    emit_dapr_agent_py,
)

__all__ = [
    "emit_claude_agent_sdk_servers",
    "emit_claude_code_cli_servers",
    "emit_dapr_agent_py",
]

"""CLI adapter registry for the interactive-cli runtime family."""

from src.cli_adapters.antigravity import AntigravityAdapter
from src.cli_adapters.base import CliAdapter, SeedResult, get_adapter, register_adapter
from src.cli_adapters.claude_code import ClaudeCodeAdapter
from src.cli_adapters.codex import CodexAdapter

# Self-register all interactive-cli adapters at import time. The BFF stamps
# agentConfig.cliAdapter from the runtime descriptor (claude-code | codex |
# antigravity); one image hosts all three.
register_adapter(ClaudeCodeAdapter())
register_adapter(CodexAdapter())
register_adapter(AntigravityAdapter())

__all__ = [
    "CliAdapter",
    "SeedResult",
    "get_adapter",
    "register_adapter",
    "ClaudeCodeAdapter",
    "CodexAdapter",
    "AntigravityAdapter",
]

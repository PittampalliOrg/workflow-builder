"""CLI adapter registry for the interactive-cli runtime family."""

from src.cli_adapters.base import CliAdapter, SeedResult, get_adapter, register_adapter
from src.cli_adapters.claude_code import ClaudeCodeAdapter

# Self-register the default adapter at import time.
register_adapter(ClaudeCodeAdapter())

__all__ = [
    "CliAdapter",
    "SeedResult",
    "get_adapter",
    "register_adapter",
    "ClaudeCodeAdapter",
]

from __future__ import annotations

import importlib
import os
import sys

root = os.path.join(os.path.dirname(__file__), "..")
if root not in sys.path:
    sys.path.insert(0, root)

adapter = importlib.import_module("src.anthropic_adapter")


def test_anthropic_sdk_requires_api_key(monkeypatch) -> None:
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)

    try:
        adapter._call_anthropic_sdk(
            "llm-anthropic-sonnet",
            [{"role": "user", "content": "hello"}],
        )
    except RuntimeError as exc:
        assert str(exc) == "No Anthropic authentication configured. Set ANTHROPIC_API_KEY."
    else:
        raise AssertionError("Expected missing ANTHROPIC_API_KEY to raise RuntimeError")

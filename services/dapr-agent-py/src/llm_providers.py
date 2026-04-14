"""LLM provider resolution for dapr-agent-py.

The Dapr Conversation Anthropic component currently rejects the string
tool_choice shape produced by dapr-agents. Use provider SDK clients directly
until that component accepts the same request shape.
"""

from __future__ import annotations

import os

from dapr_agents.llm.chat import ChatClientBase
from dapr_agents.llm.openai import OpenAIChatClient


def _normalize_model(model_name: str) -> str:
    return model_name.lower().removeprefix("anthropic/").removeprefix("openai/")


def resolve_llm_client(model_name: str | None = None) -> ChatClientBase:
    model = _normalize_model(
        model_name
        or os.environ.get("DAPR_AGENT_PY_MODEL")
        or os.environ.get("DAPR_AGENT_MODEL")
        or "anthropic/claude-opus-4-6"
    )

    if model.startswith(("gpt", "o1", "o3", "o4")):
        return OpenAIChatClient(
            api_key=os.environ.get("OPENAI_API_KEY"),
            model=model,
            timeout=600,
        )

    return OpenAIChatClient(
        api_key=os.environ.get("ANTHROPIC_API_KEY"),
        base_url="https://api.anthropic.com/v1/",
        model=model,
        timeout=600,
    )

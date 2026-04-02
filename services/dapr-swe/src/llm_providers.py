"""LLM provider resolution — direct SDK clients for DurableAgent.

Uses OpenAIChatClient with provider-specific base_url since the Dapr
Conversation API's Anthropic component has a tool_choice format bug.
OpenAIChatClient is auto-instrumented by DaprAgentsInstrumentor's LLMWrapper.

When the Conversation API bug is fixed, switch back to DaprChatClient
for provider decoupling.
"""
from __future__ import annotations

import logging
import os

from dapr_agents.llm.chat import ChatClientBase
from dapr_agents.llm.openai import OpenAIChatClient

logger = logging.getLogger(__name__)

# Anthropic supports the OpenAI SDK via base_url
# See: https://docs.anthropic.com/en/api/openai-sdk
_ANTHROPIC_API_KEY = os.environ.get("ANTHROPIC_API_KEY", "")
_OPENAI_API_KEY = os.environ.get("OPENAI_API_KEY", "")
_OPENAI_FALLBACK_MODEL = os.environ.get("OPENAI_FALLBACK_MODEL", "gpt-5-mini")


def is_anthropic_model(model_name: str) -> bool:
    """Return True when the model spec targets Anthropic."""
    model_lower = model_name.lower()
    if model_lower.startswith("anthropic/"):
        return True
    model_lower = model_lower.removeprefix("openai/")
    return model_lower.startswith(("claude", "anthropic"))


def is_anthropic_usage_error(exc: Exception) -> bool:
    """Detect Anthropic balance and billing failures surfaced through the OpenAI SDK."""
    text = str(exc).lower()
    if "anthropic" not in text:
        return False
    return any(
        marker in text
        for marker in (
            "credit balance is too low",
            "plans & billing",
            "purchase credits",
            "invalid_request_error",
        )
    )


def get_openai_fallback_model() -> str | None:
    """Return the configured OpenAI fallback model when an API key is available."""
    if not _OPENAI_API_KEY:
        return None
    return _OPENAI_FALLBACK_MODEL


def resolve_llm_client(model_name: str) -> ChatClientBase:
    """Return an LLM client for the given model name.

    Uses OpenAIChatClient (auto-instrumented by DaprAgentsInstrumentor)
    with provider-specific base_url.
    """
    model_lower = model_name.lower().removeprefix("anthropic/").removeprefix("openai/")

    if model_lower.startswith(("claude", "anthropic")):
        return OpenAIChatClient(
            api_key=_ANTHROPIC_API_KEY,
            base_url="https://api.anthropic.com/v1/",
            model=model_lower,
            timeout=600,
        )
    elif model_lower.startswith(("gpt", "o1", "o3", "o4")):
        return OpenAIChatClient(
            api_key=_OPENAI_API_KEY,
            model=model_lower,
            timeout=600,
        )
    else:
        # Default to Anthropic
        return OpenAIChatClient(
            api_key=_ANTHROPIC_API_KEY,
            base_url="https://api.anthropic.com/v1/",
            model=model_lower or "claude-sonnet-4-6",
            timeout=600,
        )

"""Kimi K3 chat-model construction for browser-use.

browser-use's ``BaseChatModel`` is a runtime-checkable Protocol; its bundled
``ChatOpenAI`` speaks any OpenAI-compatible endpoint, which is exactly what
Kimi-for-Coding exposes at ``https://api.kimi.com/coding/v1``. This module
resolves the platform ``agentConfig.modelSpec`` (``kimi/kimi-k3`` /
``llm-kimi-k3`` / ``kimi-k3``) onto that client.

Kimi K3 calls explicitly use ``reasoning_effort="max"``. browser-use's
``ChatOpenAI`` annotation does not yet list that value, but the dataclass does
not enforce the annotation at runtime and forwards it for models named in
``reasoning_models``.
"""

from __future__ import annotations

import logging
import os
from typing import Any

from src.config import (
    KIMI_BASE_URL,
    KIMI_DEFAULT_MODEL,
    KIMI_MAX_COMPLETION_TOKENS,
    SCHEMA_IN_PROMPT,
)

logger = logging.getLogger(__name__)


def resolve_kimi_model(agent_config: dict[str, Any] | None) -> str:
    """Map ``agentConfig.modelSpec`` to a bare Kimi model name.

    Accepted spellings: ``kimi/kimi-k3`` (platform modelSpec),
    ``llm-kimi-k3`` (Dapr component name), ``kimi-k3`` (bare). A non-Kimi
    provider falls back to the default with a warning — P1 of this runtime is
    Kimi-only; the multi-provider shim arrives with the adapter-layer phase.
    """
    spec = str((agent_config or {}).get("modelSpec") or "").strip()
    if not spec:
        return KIMI_DEFAULT_MODEL
    if "/" in spec:
        provider, _, name = spec.partition("/")
        if provider.strip().lower() != "kimi":
            logger.warning(
                "[kimi-llm] modelSpec=%r requests a non-Kimi provider; "
                "browser-use-agent P1 is Kimi-only — using %s",
                spec,
                KIMI_DEFAULT_MODEL,
            )
            return KIMI_DEFAULT_MODEL
    else:
        name = spec
    name = name.strip()
    if name.startswith("llm-"):
        name = name[len("llm-") :]
    return name or KIMI_DEFAULT_MODEL


def build_chat_model(agent_config: dict[str, Any] | None):
    """Build the browser-use chat model for this run (Kimi K3 by default)."""
    from browser_use import ChatOpenAI

    api_key = os.environ.get("KIMI_API_KEY")
    if not api_key:
        raise RuntimeError(
            "No Kimi authentication configured. Set KIMI_API_KEY "
            "(browser-use-agent authenticates the default kimi-k3 model with it)."
        )

    model = resolve_kimi_model(agent_config)
    kwargs: dict[str, Any] = {
        "model": model,
        "api_key": api_key,
        "base_url": KIMI_BASE_URL,
        "max_completion_tokens": KIMI_MAX_COMPLETION_TOKENS,
        # kimi-k3 accepts only temperature=1 and frequency_penalty=0
        # (400 "invalid temperature/frequency_penalty: only … is allowed for
        # this model", verified live); browser-use's ChatOpenAI defaults are
        # 0.2 / 0.3.
        "temperature": 1,
        "frequency_penalty": 0,
        "reasoning_effort": "max",
        "reasoning_models": [model],
    }
    if SCHEMA_IN_PROMPT:
        kwargs["add_schema_to_system_prompt"] = True
        kwargs["dont_force_structured_output"] = True
    return ChatOpenAI(**kwargs)

"""Resolve the default Gemini model string for the LlmAgent.

The Diagrid `call_llm_activity` reads the model name from
`AgentWorkflowInput.agent_config.model` per turn, NOT from `self._agent.model`.
So the LlmAgent's `model=` attribute is only used at agent construction time
(metadata extraction). Per-turn overrides come from `agentConfig.modelSpec`
written by the BFF into the session_workflow input.

Default: `gemini-3-pro-preview` (configurable via `ADK_AGENT_PY_DEFAULT_MODEL`).
"""

from __future__ import annotations

from src.constants import DEFAULT_MODEL


def build_default_model() -> str:
    """Return the model string used at LlmAgent construction.

    This is a placeholder; actual model selection happens per-turn via
    `agent_config_builder.build_per_turn_agent_config()`.
    """
    return DEFAULT_MODEL

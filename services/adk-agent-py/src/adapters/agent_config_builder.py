"""Build per-turn Diagrid `AgentConfig` dicts from workflow-builder inputs.

Diagrid's `agent_workflow` reads `agent_config` from `AgentWorkflowInput`
each turn — NOT from `self._agent` — so we can freely vary the
`system_instruction`, model, and tool_definitions per call without
mutating the constructed LlmAgent.

`workflow_agent_config` is the `agentConfig` blob from the BFF
(`src/lib/types/agents.ts AgentConfig`). `rendered_system_prompt` is
`instructionBundle.rendered.system` (preset + persona + tail, BFF-computed
via `compilePromptStack`).
"""

from __future__ import annotations

import logging
from typing import Any

from src.constants import DEFAULT_MODEL

logger = logging.getLogger(__name__)


def build_per_turn_agent_config(
    workflow_agent_config: dict[str, Any] | None,
    *,
    rendered_system_prompt: str,
    model: str | None = None,
    declared_tools: list[Any] | None = None,
) -> dict[str, Any]:
    """Build a Diagrid `AgentConfig.to_dict()` for this turn.

    `declared_tools` is the list of `BaseTool` instances on the LlmAgent
    (FunctionTools + any MCP tools). The Diagrid worker reads
    `agent_config.tool_definitions` and pairs each name with the tool in
    its global `_tool_registry` populated at runner construction time.

    Provider is fixed to `gemini` for v1 — every model we ship is a Gemini
    model. To run a non-Gemini model under ADK, set `provider="litellm"` and
    pass `model="anthropic/claude-3-5-sonnet"` etc. (Diagrid's
    `_call_llm_via_litellm` covers OpenAI / Anthropic / Bedrock / etc.).
    """
    cfg = dict(workflow_agent_config or {})
    name = (cfg.get("slug") or cfg.get("name") or "adk_agent_py").strip() or "adk_agent_py"

    resolved_model = (
        (model or "").strip()
        or (cfg.get("modelSpec") or "").strip()
        or DEFAULT_MODEL
    )

    # ToolDefinition shape: {name, description, parameters}
    tool_definitions: list[dict[str, Any]] = []
    for tool in declared_tools or []:
        tool_name = getattr(tool, "name", None)
        if not tool_name:
            continue
        description = getattr(tool, "description", "") or ""
        parameters: dict[str, Any] | None = None
        get_decl = getattr(tool, "_get_declaration", None)
        if callable(get_decl):
            try:
                decl = get_decl()
                params = getattr(decl, "parameters", None) if decl else None
                if params is not None:
                    if hasattr(params, "model_dump"):
                        parameters = params.model_dump(exclude_none=True)
                    elif hasattr(params, "to_dict"):
                        parameters = params.to_dict()
            except Exception as exc:  # noqa: BLE001
                logger.debug("[agent-config] declaration fetch failed for %s: %s", tool_name, exc)

        tool_definitions.append(
            {
                "name": tool_name,
                "description": description,
                "parameters": parameters,
            }
        )

    return {
        "name": name,
        "model": resolved_model,
        "system_instruction": rendered_system_prompt or None,
        "tool_definitions": tool_definitions,
        "component_name": None,
        "provider": "gemini",
    }

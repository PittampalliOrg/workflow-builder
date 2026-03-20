from __future__ import annotations

import json
import os
from dataclasses import dataclass
from typing import Any

from tools import ToolRuntimeContext, pop_tool_context, push_tool_context, resolve_tool_group

try:
    from deepagents import create_deep_agent
except ImportError:  # pragma: no cover
    create_deep_agent = None

try:
    from langchain.chat_models import init_chat_model
except ImportError:  # pragma: no cover
    init_chat_model = None

try:
    from langchain_openai import ChatOpenAI
except ImportError:  # pragma: no cover
    ChatOpenAI = None


LANGGRAPH_ENGINE_NAME = "langgraph-deepagents"
LANGGRAPH_ENGINE_ENABLED = (
    os.environ.get("DAPR_AGENT_ENABLE_LANGGRAPH", "true").strip().lower() == "true"
)
LANGGRAPH_SUMMARIZE_PROMPT = (
    "Summarize the completed work in concise engineering language. "
    "Call out the files changed, verification run, and residual risks."
)


@dataclass(frozen=True)
class LangGraphRunResult:
    text: str
    structured_output: dict[str, Any] | None
    tool_summary: dict[str, Any]
    metadata: dict[str, Any]


def is_langgraph_available() -> bool:
    return bool(LANGGRAPH_ENGINE_ENABLED and create_deep_agent and (init_chat_model or ChatOpenAI))


def build_langgraph_capabilities() -> dict[str, Any]:
    return {
        "enabled": LANGGRAPH_ENGINE_ENABLED,
        "available": is_langgraph_available(),
        "engine": LANGGRAPH_ENGINE_NAME,
        "deepAgents": bool(create_deep_agent),
        "chatModelFactory": bool(init_chat_model or ChatOpenAI),
        "features": [
            "deep-agent",
            "write-todos",
            "subagents",
            "tool-wrapped-workspace",
        ],
    }


def _build_model(model: str, api_key: str | None) -> Any:
    normalized = str(model or "").strip() or "gpt-5.4"
    if init_chat_model is not None:
        return init_chat_model(f"openai:{normalized}", api_key=api_key or os.environ.get("OPENAI_API_KEY"))
    if ChatOpenAI is None:  # pragma: no cover
        raise RuntimeError("LangGraph engine is unavailable: no chat model factory installed")
    return ChatOpenAI(model=normalized, api_key=api_key or os.environ.get("OPENAI_API_KEY"))


def _bind_workspace_tools(tool_group: str, workspace_root: str) -> list[Any]:
    bound_tools: list[Any] = []
    for tool_fn in resolve_tool_group(tool_group):
        tool_callable = getattr(tool_fn, "func", None) or tool_fn
        tool_name = getattr(tool_fn, "name", None) or getattr(tool_fn, "__name__", "tool")
        tool_description = (
            getattr(tool_fn, "description", None)
            or getattr(tool_fn, "__doc__", None)
            or f"Run {tool_name}"
        )

        def _make_tool(fn: Any, *, name: str, description: str):
            def wrapped(*args: Any, **kwargs: Any) -> Any:
                return fn(*args, **kwargs)

            wrapped.__name__ = name
            wrapped.__doc__ = description
            return wrapped

        bound_tools.append(
            _make_tool(
                tool_callable,
                name=str(tool_name),
                description=str(tool_description),
            )
        )
    return bound_tools


def _build_subagents(workspace_root: str) -> list[dict[str, Any]]:
    return [
        {
            "name": "repo-scout",
            "description": "Explore repository structure and identify the files relevant to the task.",
            "system_prompt": (
                "Inspect the codebase, identify the most relevant files, and summarize "
                "what matters for the task without making edits."
            ),
            "tools": _bind_workspace_tools("read_only", workspace_root),
        },
        {
            "name": "verifier",
            "description": "Run verification commands and summarize code changes and residual risks.",
            "system_prompt": (
                "Verify the implementation, review changed files, and summarize what passed, "
                "what failed, and any remaining risks."
            ),
            "tools": _bind_workspace_tools("all", workspace_root),
        },
    ]


def _extract_message_text(messages: Any) -> str:
    if not isinstance(messages, list):
        return ""
    for message in reversed(messages):
        content = getattr(message, "content", None)
        if isinstance(content, str) and content.strip():
            return content.strip()
        if isinstance(message, dict):
            dict_content = message.get("content")
            if isinstance(dict_content, str) and dict_content.strip():
                return dict_content.strip()
            if isinstance(dict_content, list):
                parts = [
                    str(part.get("text") or "").strip()
                    for part in dict_content
                    if isinstance(part, dict) and str(part.get("text") or "").strip()
                ]
                if parts:
                    return "\n".join(parts).strip()
    return ""


def _coerce_structured_output(result: Any) -> dict[str, Any] | None:
    if isinstance(result, dict):
        structured = result.get("structured_response")
        if isinstance(structured, dict):
            return structured
        output = result.get("output")
        if isinstance(output, dict):
            return output
    return None


def _coerce_text(result: Any) -> str:
    if isinstance(result, dict):
        for key in ("output_text", "text", "output"):
            value = result.get(key)
            if isinstance(value, str) and value.strip():
                return value.strip()
        text = _extract_message_text(result.get("messages"))
        if text:
            return text
    if isinstance(result, str):
        return result.strip()
    return json.dumps(result, default=str)


def _build_system_prompt(phase: str, profile: str) -> str:
    if phase == "plan":
        return (
            "You are a durable planning agent for coding workflows. "
            "Inspect the repository in a read-only way, maintain a todo list, "
            "delegate discovery work to subagents when helpful, and return a JSON-compatible plan."
        )
    if phase == "verify":
        return LANGGRAPH_SUMMARIZE_PROMPT
    return (
        f"You are a durable coding agent running in profile '{profile}'. "
        "Use the todo list, delegate focused work to subagents when useful, "
        "make minimal code changes, and verify the result before finishing."
    )


def run_langgraph_task(
    *,
    prompt: str,
    workspace_root: str,
    tool_group: str,
    model: str,
    profile: str,
    phase: str,
    api_key: str | None = None,
) -> LangGraphRunResult:
    if not is_langgraph_available():
        raise RuntimeError("LangGraph Deep Agents engine is not installed")

    context = ToolRuntimeContext.from_workspace_root(workspace_root)
    token = push_tool_context(context)
    try:
        graph = create_deep_agent(
            model=_build_model(model, api_key),
            tools=_bind_workspace_tools(tool_group, workspace_root),
            system_prompt=_build_system_prompt(phase, profile),
            subagents=_build_subagents(workspace_root),
        )
        result = graph.invoke(
            {
                "messages": [
                    {
                        "role": "user",
                        "content": prompt,
                    }
                ]
            }
        )
    finally:
        pop_tool_context(token)

    return LangGraphRunResult(
        text=_coerce_text(result),
        structured_output=_coerce_structured_output(result),
        tool_summary=context.build_summary(),
        metadata={
            "engine": LANGGRAPH_ENGINE_NAME,
            "phase": phase,
            "profile": profile,
            "toolGroup": tool_group,
            "subagents": ["repo-scout", "verifier"],
        },
    )

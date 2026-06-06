from __future__ import annotations

import asyncio
import dataclasses
import logging
import os
from pathlib import Path
from typing import Any, Mapping
from uuid import NAMESPACE_URL, uuid5

from claude_agent_sdk import ClaudeAgentOptions, query

logger = logging.getLogger(__name__)

TOOLS_PRESET = {"type": "preset", "preset": "claude_code"}
SYSTEM_PROMPT_PRESET = {"type": "preset", "preset": "claude_code"}
DEFAULT_MODEL = os.environ.get("CLAUDE_AGENT_PY_DEFAULT_MODEL", "claude-sonnet-4-6")
DEFAULT_PERMISSION_MODE = os.environ.get(
    "CLAUDE_AGENT_PY_PERMISSION_MODE", "bypassPermissions"
)
DEFAULT_CWD = os.environ.get("AGENT_LOCAL_SANDBOX_ROOT", "/sandbox")
DEFAULT_CLI_PATH = os.environ.get("CLAUDE_AGENT_SDK_CLI_PATH") or None


def clean_string(value: Any) -> str | None:
    return value.strip() if isinstance(value, str) and value.strip() else None


def normalize_claude_model(model_spec: Any) -> str | None:
    raw = clean_string(model_spec)
    if not raw:
        raw = clean_string(DEFAULT_MODEL)
    if not raw:
        return None
    if raw.startswith("anthropic/"):
        return raw.split("/", 1)[1]
    if raw.startswith("claude-"):
        return raw
    fallback = clean_string(DEFAULT_MODEL)
    if fallback and fallback.startswith("anthropic/"):
        return fallback.split("/", 1)[1]
    return fallback


def normalize_permission_mode(value: Any) -> str:
    raw = clean_string(value) or DEFAULT_PERMISSION_MODE
    if raw == "bypass":
        return "bypassPermissions"
    if raw in {
        "default",
        "acceptEdits",
        "plan",
        "bypassPermissions",
        "dontAsk",
        "auto",
    }:
        return raw
    return "bypassPermissions"


def bounded_int(value: Any, *, default: int, minimum: int, maximum: int) -> int:
    if isinstance(value, bool):
        return default
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        return default
    return max(minimum, min(maximum, parsed))


def resolve_cwd(value: Any) -> Path:
    root = Path(DEFAULT_CWD)
    raw = clean_string(value)
    if raw:
        path = Path(raw)
        if not path.is_absolute():
            path = root / path
    else:
        path = root
    path.mkdir(parents=True, exist_ok=True)
    return path


def workflow_session_uuid(session_id: str | None, workflow_instance_id: str | None) -> str | None:
    seed = clean_string(session_id) or clean_string(workflow_instance_id)
    if not seed:
        return None
    return str(uuid5(NAMESPACE_URL, f"workflow-builder:{seed}"))


def system_prompt_config(rendered_system: Any) -> dict[str, str]:
    append = clean_string(rendered_system)
    if not append:
        return dict(SYSTEM_PROMPT_PRESET)
    return {
        "type": "preset",
        "preset": "claude_code",
        "append": append,
    }


def build_claude_options(input_data: Mapping[str, Any]) -> ClaudeAgentOptions:
    agent_config = input_data.get("agentConfig")
    if not isinstance(agent_config, Mapping):
        agent_config = {}
    cwd = resolve_cwd(input_data.get("cwd") or agent_config.get("cwd"))
    max_turns = bounded_int(
        input_data.get("maxTurns") or input_data.get("maxIterations") or agent_config.get("maxTurns"),
        default=80,
        minimum=1,
        maximum=400,
    )
    env: dict[str, str] = {
        "CLAUDE_AGENT_SDK_CLIENT_APP": os.environ.get(
            "CLAUDE_AGENT_SDK_CLIENT_APP", "workflow-builder-claude-agent-py/0.1.0"
        ),
    }
    if session_id := clean_string(input_data.get("sessionId")):
        env["WORKFLOW_BUILDER_SESSION_ID"] = session_id
    if workflow_id := clean_string(input_data.get("workflowExecutionId")):
        env["WORKFLOW_BUILDER_WORKFLOW_EXECUTION_ID"] = workflow_id

    return ClaudeAgentOptions(
        tools=dict(TOOLS_PRESET),
        system_prompt=system_prompt_config(input_data.get("renderedSystem")),
        permission_mode=normalize_permission_mode(
            input_data.get("permissionMode") or agent_config.get("permissionMode")
        ),
        max_turns=max_turns,
        model=normalize_claude_model(agent_config.get("modelSpec")),
        cwd=str(cwd),
        cli_path=DEFAULT_CLI_PATH,
        session_id=workflow_session_uuid(
            clean_string(input_data.get("sessionId")),
            clean_string(input_data.get("workflowInstanceId")),
        ),
        env=env,
    )


def _json_safe(value: Any) -> Any:
    if dataclasses.is_dataclass(value):
        return _json_safe(dataclasses.asdict(value))
    if isinstance(value, Mapping):
        return {str(k): _json_safe(v) for k, v in value.items()}
    if isinstance(value, list):
        return [_json_safe(item) for item in value]
    if isinstance(value, tuple):
        return [_json_safe(item) for item in value]
    if isinstance(value, (str, int, float, bool)) or value is None:
        return value
    return str(value)


def _message_events(message: Any) -> tuple[list[dict[str, Any]], list[str]]:
    events: list[dict[str, Any]] = []
    text_parts: list[str] = []
    if type(message).__name__ != "AssistantMessage":
        return events, text_parts
    for block in getattr(message, "content", []) or []:
        block_type = type(block).__name__
        if block_type == "TextBlock":
            text = clean_string(getattr(block, "text", None))
            if text:
                text_parts.append(text)
        elif block_type == "ToolUseBlock":
            tool_id = clean_string(getattr(block, "id", None))
            events.append(
                {
                    "type": "tool_call_start",
                    "data": {
                        "toolCallId": tool_id,
                        "toolName": getattr(block, "name", None),
                        "args": _json_safe(getattr(block, "input", {}) or {}),
                    },
                    "sourceEventId": f"tool-use:{tool_id}" if tool_id else None,
                }
            )
    return events, text_parts


async def run_claude_sdk_turn_async(input_data: Mapping[str, Any]) -> dict[str, Any]:
    prompt = clean_string(input_data.get("prompt"))
    if not prompt:
        return {
            "success": False,
            "error": "Claude SDK turn requires a non-empty prompt",
            "finalText": "",
            "messages": [],
            "events": [],
        }

    options = build_claude_options(input_data)
    sdk_messages: list[dict[str, Any]] = []
    assistant_text_parts: list[str] = []
    events: list[dict[str, Any]] = []
    result_message: dict[str, Any] | None = None
    sdk_session_id: str | None = None
    stderr_lines: list[str] = []

    def on_stderr(line: str) -> None:
        if line.strip():
            stderr_lines.append(line[-2000:])

    options.stderr = on_stderr

    try:
        async for message in query(prompt=prompt, options=options):
            sdk_messages.append(_json_safe(message))
            message_events, message_text = _message_events(message)
            events.extend(message_events)
            assistant_text_parts.extend(message_text)
            if type(message).__name__ == "ResultMessage":
                result_message = _json_safe(message)
                sdk_session_id = clean_string(getattr(message, "session_id", None))
    except Exception as exc:  # noqa: BLE001
        logger.exception("[claude-sdk] query failed")
        return {
            "success": False,
            "error": str(exc),
            "finalText": "",
            "messages": sdk_messages,
            "events": events,
            "stderr": stderr_lines[-20:],
        }

    result_text = ""
    if result_message and isinstance(result_message.get("result"), str):
        result_text = result_message["result"].strip()
    final_text = result_text or "\n\n".join(assistant_text_parts).strip()
    if final_text:
        events.append(
            {
                "type": "llm_complete",
                "data": {
                    "content": final_text,
                    "sdkSessionId": sdk_session_id,
                    "numTurns": result_message.get("num_turns") if result_message else None,
                    "totalCostUsd": result_message.get("total_cost_usd") if result_message else None,
                    "usage": result_message.get("usage") if result_message else None,
                },
                "sourceEventId": f"claude-result:{sdk_session_id}" if sdk_session_id else None,
            }
        )

    is_error = bool(result_message.get("is_error")) if result_message else False
    return {
        "success": not is_error,
        "error": "; ".join(result_message.get("errors") or []) if is_error and result_message else None,
        "finalText": final_text,
        "messages": sdk_messages,
        "events": events,
        "sdkSessionId": sdk_session_id,
        "result": result_message,
        "stderr": stderr_lines[-20:],
    }


def run_claude_sdk_turn_activity(
    _ctx_or_input: Any,
    input_data: dict[str, Any] | None = None,
) -> dict[str, Any]:
    payload = input_data if input_data is not None else _ctx_or_input
    return asyncio.run(run_claude_sdk_turn_async(payload))

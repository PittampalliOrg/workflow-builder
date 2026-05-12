"""Preserve Gemini thought signatures across Diagrid durable messages.

Gemini thinking models attach `Part.thought_signature` to function-call parts.
The signature must be replayed with the corresponding function call when the
next request includes a function response. Diagrid's current ADK bridge reduces
ADK messages to `{id, name, args}` tool calls, which drops the signature and
causes Gemini to reject the next turn after any tool call.
"""

from __future__ import annotations

import base64
import logging
from typing import Any

logger = logging.getLogger(__name__)


def _encode_signature(value: Any) -> str | None:
    if isinstance(value, bytes) and value:
        return base64.b64encode(value).decode("ascii")
    if isinstance(value, str) and value:
        return value
    return None


def _decode_signature(value: Any) -> bytes | None:
    if isinstance(value, bytes) and value:
        return value
    if not isinstance(value, str) or not value:
        return None
    try:
        return base64.b64decode(value.encode("ascii"), validate=True)
    except Exception:  # noqa: BLE001
        logger.debug("[gemini-thought-signature] invalid base64 signature ignored")
        return None


def install_gemini_thought_signature_patch() -> None:
    """Patch Diagrid's Gemini bridge until upstream carries signatures itself."""

    from diagrid.agent.adk import models as dg_models
    from diagrid.agent.adk import workflow as dg_workflow

    if getattr(dg_workflow, "_workflow_builder_thought_signature_patch", False):
        return

    original_to_dict = dg_models.Message.to_dict
    original_from_dict = dg_models.Message.from_dict

    def message_to_dict(self: Any) -> dict[str, Any]:
        data = original_to_dict(self)
        for index, tool_call in enumerate(getattr(self, "tool_calls", []) or []):
            signature = _encode_signature(getattr(tool_call, "thought_signature", None))
            if signature and index < len(data.get("tool_calls", [])):
                data["tool_calls"][index]["thought_signature"] = signature
        return data

    @classmethod
    def message_from_dict(cls: type[Any], data: dict[str, Any]) -> Any:
        message = original_from_dict(data)
        raw_tool_calls = data.get("tool_calls", [])
        for tool_call, raw in zip(getattr(message, "tool_calls", []) or [], raw_tool_calls):
            if not isinstance(raw, dict):
                continue
            signature = _decode_signature(raw.get("thought_signature"))
            if signature:
                setattr(tool_call, "thought_signature", signature)
        return message

    def call_llm_via_gemini(llm_input: Any) -> dict[str, Any]:
        try:
            from google.genai import Client
            from google.genai import types
        except ImportError as exc:
            logger.error("Failed to import Google genai: %s", exc)
            return dg_workflow.CallLlmOutput(
                message=dg_workflow.Message(role=dg_workflow.MessageRole.MODEL),
                is_final=True,
                error=f"Google genai not installed: {exc}",
            ).to_dict()

        contents = []
        for msg in llm_input.messages:
            parts = []

            if msg.content:
                parts.append(types.Part.from_text(text=msg.content))

            for tool_call in msg.tool_calls:
                part_kwargs: dict[str, Any] = {
                    "function_call": types.FunctionCall(
                        name=tool_call.name,
                        args=tool_call.args,
                        id=tool_call.id,
                    )
                }
                signature = getattr(tool_call, "thought_signature", None)
                if signature:
                    part_kwargs["thought_signature"] = signature
                parts.append(types.Part(**part_kwargs))

            for tool_result in msg.tool_results:
                parts.append(
                    types.Part(
                        function_response=types.FunctionResponse(
                            name=tool_result.tool_name,
                            id=tool_result.tool_call_id,
                            response={"result": tool_result.result}
                            if tool_result.error is None
                            else {"error": tool_result.error},
                        )
                    )
                )

            if parts:
                role = "user" if msg.role == dg_workflow.MessageRole.USER else "model"
                contents.append(types.Content(role=role, parts=parts))

        tools: list[Any] = []
        for tool_def in llm_input.agent_config.tool_definitions:
            tool = dg_workflow.get_registered_tool(tool_def.name)
            if tool and hasattr(tool, "_get_declaration"):
                try:
                    declaration = tool._get_declaration()
                    if declaration:
                        if not tools:
                            tools.append(types.Tool(function_declarations=[declaration]))
                        else:
                            if tools[0].function_declarations is None:
                                tools[0].function_declarations = []
                            tools[0].function_declarations.append(declaration)
                except Exception as exc:  # noqa: BLE001
                    logger.warning(
                        "Failed to get declaration for tool %s: %s",
                        tool_def.name,
                        exc,
                    )

        config = types.GenerateContentConfig(
            system_instruction=llm_input.agent_config.system_instruction,
            tools=tools if tools else None,
        )

        client = Client()
        response = client.models.generate_content(
            model=llm_input.agent_config.model,
            contents=contents,
            config=config,
        )

        if not response.candidates:
            return dg_workflow.CallLlmOutput(
                message=dg_workflow.Message(role=dg_workflow.MessageRole.MODEL),
                is_final=True,
                error="No candidates in LLM response",
            ).to_dict()

        content = response.candidates[0].content
        tool_calls: list[Any] = []
        text_parts: list[str] = []

        if content and content.parts:
            for part in content.parts:
                if part.function_call:
                    fc = part.function_call
                    tool_call = dg_workflow.ToolCall(
                        id=fc.id or f"call_{len(tool_calls)}",
                        name=fc.name or "",
                        args=dict(fc.args) if fc.args else {},
                    )
                    signature = getattr(part, "thought_signature", None)
                    if signature:
                        setattr(tool_call, "thought_signature", signature)
                    tool_calls.append(tool_call)
                elif part.text:
                    text_parts.append(part.text)

        response_message = dg_workflow.Message(
            role=dg_workflow.MessageRole.MODEL,
            content="\n".join(text_parts) if text_parts else None,
            tool_calls=tool_calls,
        )

        return dg_workflow.CallLlmOutput(
            message=response_message,
            is_final=len(tool_calls) == 0,
        ).to_dict()

    dg_models.Message.to_dict = message_to_dict
    dg_models.Message.from_dict = message_from_dict
    dg_workflow.Message.to_dict = message_to_dict
    dg_workflow.Message.from_dict = message_from_dict
    dg_workflow._call_llm_via_gemini = call_llm_via_gemini
    dg_workflow._workflow_builder_thought_signature_patch = True
    logger.info("[gemini-thought-signature] installed Diagrid Gemini bridge patch")

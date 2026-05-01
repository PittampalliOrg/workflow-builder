from __future__ import annotations

import os
import sys


root = os.path.join(os.path.dirname(__file__), "..")
if root not in sys.path:
    sys.path.insert(0, root)

from src.instruction_bundle import (  # noqa: E402
    CANONICAL_BUNDLE_TEMPLATE_NAME,
    assign_canonical_bundle_prompt_template,
    build_instruction_bundle,
    build_canonical_bundle_prompt_template,
    instruction_bundle_audit_payload,
)


def test_composer_renders_all_persona_fields() -> None:
    bundle = build_instruction_bundle(
        agent_config={
            "systemPrompt": "Sentinel system",
            "role": "Sentinel role",
            "goal": "Sentinel goal",
            "instructions": ["Sentinel instruction"],
            "styleGuidelines": ["Sentinel style"],
        },
        raw_message={"agentId": "a1", "agentVersion": 3},
        prompt="Do the task",
        prompt_source="workflow-node",
        cwd="/sandbox/repo",
        sandbox_name="ws-demo",
        platform_system_sections=["Platform section"],
        agent_config_hash="cfg",
        agent_slug="agent",
    )

    rendered = bundle["rendered"]["system"]
    assert "Platform section" in rendered
    assert "Sentinel system" in rendered
    assert "Sentinel role" in rendered
    assert "Sentinel goal" in rendered
    assert "Sentinel instruction" in rendered
    assert "Sentinel style" in rendered
    assert bundle["rendered"]["user"] == "Do the task"
    assert len(bundle["instructionHash"]) == 64
    assert bundle["templateName"] == CANONICAL_BUNDLE_TEMPLATE_NAME
    assert len(bundle["templateHash"]) == 64


def test_instruction_hash_is_stable_for_semantically_identical_inputs() -> None:
    first = build_instruction_bundle(
        agent_config={"role": " role ", "instructions": [" keep order ", ""]},
        raw_message={},
        prompt="Prompt",
        prompt_source="session",
        cwd="/sandbox",
        platform_system_sections=[],
    )
    second = build_instruction_bundle(
        agent_config={"instructions": ["keep order"], "role": "role"},
        raw_message={},
        prompt="Prompt",
        prompt_source="session",
        cwd="/sandbox",
        platform_system_sections=[],
    )

    assert first["instructionHash"] == second["instructionHash"]


def test_control_overrides_are_reflected_in_sources() -> None:
    bundle = build_instruction_bundle(
        agent_config={"role": "Updated role", "goal": "Base goal"},
        raw_message={},
        prompt="Prompt",
        prompt_source="session",
        cwd="/sandbox",
        platform_system_sections=[],
        control_override_fields={"role"},
    )

    role_source = next(s for s in bundle["sources"] if s["field"] == "persona.role")
    goal_source = next(s for s in bundle["sources"] if s["field"] == "persona.goal")
    assert role_source["sourceType"] == "user"
    assert role_source["overrideKind"] == "control"
    assert goal_source["sourceType"] == "agent-profile"


def test_instruction_audit_payload_uses_preview_when_oversized() -> None:
    bundle = build_instruction_bundle(
        agent_config={"systemPrompt": "x" * 200},
        raw_message={},
        prompt="Prompt",
        prompt_source="session",
        cwd="/sandbox",
        platform_system_sections=[],
    )
    payload = instruction_bundle_audit_payload(bundle, max_bytes=100, preview_chars=20)

    assert payload["oversized"] is True
    assert payload["instructionHash"] == bundle["instructionHash"]
    assert payload["templateName"] == CANONICAL_BUNDLE_TEMPLATE_NAME
    assert payload["templateHash"] == bundle["templateHash"]
    assert payload["renderedPreview"]["system"]
    assert "bundle" not in payload


def test_canonical_template_shape_is_system_then_chat_history() -> None:
    bundle = build_instruction_bundle(
        agent_config={"systemPrompt": "Canonical system"},
        raw_message={},
        prompt="Current user prompt",
        prompt_source="workflow-node",
        cwd="/sandbox",
        platform_system_sections=[],
    )

    template = build_canonical_bundle_prompt_template(bundle)

    assert template.template_format == "jinja2"
    assert len(template.messages) == 2
    assert template.messages[0] == ("system", bundle["rendered"]["system"])
    assert repr(template.messages[1]) == "MessagePlaceHolder(variable_name=chat_history)"


def test_canonical_template_formatting_preserves_history_order() -> None:
    bundle = build_instruction_bundle(
        agent_config={"systemPrompt": "System text"},
        raw_message={},
        prompt="Current user prompt",
        prompt_source="workflow-node",
        cwd="/sandbox",
        platform_system_sections=[],
    )
    template = build_canonical_bundle_prompt_template(bundle)
    history = [
        {"role": "assistant", "content": "I will use a tool."},
        {
            "role": "tool",
            "content": "tool output",
            "tool_call_id": "toolu_1",
        },
    ]

    messages = template.format_prompt(chat_history=history)

    assert [message["role"] for message in messages] == [
        "system",
        "assistant",
        "tool",
    ]
    assert messages[0]["content"] == bundle["rendered"]["system"]
    assert messages[1]["content"] == "I will use a tool."
    assert messages[2]["content"] == "tool output"
    assert messages[2]["tool_call_id"] == "toolu_1"


def test_assign_canonical_template_does_not_rebuild_prompt_spec() -> None:
    class Helper:
        prompt_template = None

        def rebuild_prompt_template(self) -> None:
            raise AssertionError("PromptSpec rebuild should not be called")

    class Llm:
        prompt_template = None

    class Agent:
        prompting_helper = Helper()
        llm = Llm()
        prompt_template = None

    bundle = build_instruction_bundle(
        agent_config={"systemPrompt": "Assigned system"},
        raw_message={},
        prompt="Prompt",
        prompt_source="workflow-node",
        cwd="/sandbox",
        platform_system_sections=[],
    )
    agent = Agent()

    template = assign_canonical_bundle_prompt_template(agent, bundle)

    assert agent.prompt_template is template
    assert agent.prompting_helper.prompt_template is template
    assert agent.llm.prompt_template is template

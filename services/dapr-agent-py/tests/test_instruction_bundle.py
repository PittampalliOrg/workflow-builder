from __future__ import annotations

import os
import sys


root = os.path.join(os.path.dirname(__file__), "..")
if root not in sys.path:
    sys.path.insert(0, root)

from src.instruction_bundle import (  # noqa: E402
    CANONICAL_BUNDLE_TEMPLATE_NAME,
    SYSTEM_PROMPT_DYNAMIC_BOUNDARY,
    assign_canonical_bundle_prompt_template,
    build_instruction_bundle,
    build_canonical_bundle_prompt_template,
    instruction_bundle_audit_payload,
)


def _bundle(**overrides):
    defaults = dict(
        agent_config={"systemPrompt": "Reviewer voice"},
        raw_message=None,
        prompt="Do the work",
        prompt_source="session",
        cwd="/sandbox/repo",
        sandbox_name="ws-demo",
        platform_system_sections=["Platform section"],
    )
    defaults.update(overrides)
    return build_instruction_bundle(**defaults)


def test_renders_systemPrompt_as_only_persona_block() -> None:
    bundle = build_instruction_bundle(
        agent_config={"systemPrompt": "Sentinel system"},
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
    assert bundle["rendered"]["user"] == "Do the task"
    assert len(bundle["instructionHash"]) == 64
    assert bundle["templateName"] == CANONICAL_BUNDLE_TEMPLATE_NAME
    assert len(bundle["templateHash"]) == 64


def test_instruction_hash_is_stable_for_semantically_identical_systemPrompt() -> None:
    first = build_instruction_bundle(
        agent_config={"systemPrompt": " sentinel "},
        raw_message={},
        prompt="Prompt",
        prompt_source="session",
        cwd="/sandbox",
        platform_system_sections=[],
    )
    second = build_instruction_bundle(
        agent_config={"systemPrompt": "sentinel"},
        raw_message={},
        prompt="Prompt",
        prompt_source="session",
        cwd="/sandbox",
        platform_system_sections=[],
    )

    assert first["instructionHash"] == second["instructionHash"]


def test_control_overrides_are_reflected_in_sources() -> None:
    bundle = build_instruction_bundle(
        agent_config={"systemPrompt": "Updated voice"},
        raw_message={},
        prompt="Prompt",
        prompt_source="session",
        cwd="/sandbox",
        platform_system_sections=[],
        control_override_fields={"systemPrompt"},
    )

    src = next(
        s for s in bundle["sources"] if s["field"] == "persona.systemPrompt"
    )
    assert src["sourceType"] == "user"
    assert src["overrideKind"] == "control"


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


def test_renders_with_boundary_when_dynamic_present() -> None:
    bundle = _bundle()
    rendered = bundle["rendered"]["system"]
    assert "Platform section" in rendered
    assert "Reviewer voice" in rendered
    assert "Working directory: /sandbox/repo" in rendered
    assert SYSTEM_PROMPT_DYNAMIC_BOUNDARY in rendered
    static_part, _, dynamic_part = rendered.partition(SYSTEM_PROMPT_DYNAMIC_BOUNDARY)
    assert "Reviewer voice" in static_part
    assert "Working directory" in dynamic_part


def test_retired_persona_fields_are_ignored() -> None:
    bundle = _bundle(
        agent_config={
            "systemPrompt": "Live voice",
            # All retired fields smuggled in — should be silently ignored
            "role": "should-not-appear",
            "goal": "should-not-appear",
            "instructions": ["should-not-appear"],
            "styleGuidelines": ["should-not-appear"],
            "customSystemPrompt": "should-not-appear",
            "appendSystemPrompt": "should-not-appear",
        }
    )
    rendered = bundle["rendered"]["system"]
    assert "Live voice" in rendered
    assert "should-not-appear" not in rendered


def test_renderer_no_dynamic_content_means_no_boundary() -> None:
    # The bundle builder always defaults cwd → "/sandbox" so the Runtime
    # Context section is always non-empty in practice; this guards the pure
    # renderer behavior when callers hand it a stripped-down dict directly.
    from src.instruction_bundle import render_instruction_system_text

    rendered = render_instruction_system_text(
        {
            "persona": {"systemPrompt": "Static prose only."},
            "runtime": {},
        }
    )
    assert "Static prose only." in rendered
    assert SYSTEM_PROMPT_DYNAMIC_BOUNDARY not in rendered


def test_current_date_renders_in_dynamic_tail() -> None:
    bundle = _bundle(current_date="2026-05-01")
    rendered = bundle["rendered"]["system"]
    _, _, dynamic_part = rendered.partition(SYSTEM_PROMPT_DYNAMIC_BOUNDARY)
    assert "## Current Date" in dynamic_part
    assert "2026-05-01" in dynamic_part


def test_mcp_instructions_render_as_section() -> None:
    bundle = _bundle(
        mcp_instructions=[
            "server-a: Use read-only tools.",
            "server-b: French only.",
        ]
    )
    rendered = bundle["rendered"]["system"]
    _, _, dynamic_part = rendered.partition(SYSTEM_PROMPT_DYNAMIC_BOUNDARY)
    assert "## MCP Server Instructions" in dynamic_part
    assert "server-a: Use read-only tools." in dynamic_part
    assert "server-b: French only." in dynamic_part


def test_static_presets_render_before_systemPrompt() -> None:
    bundle = _bundle(
        agent_config={
            "systemPrompt": "Agent voice",
            "compiledStaticPresetSections": [
                "## Reusable Style Guide\nKeep responses terse.",
                "## Escalation Policy\nNever escalate without TL approval.",
            ],
        }
    )
    static_part, _, _ = bundle["rendered"]["system"].partition(
        SYSTEM_PROMPT_DYNAMIC_BOUNDARY
    )
    style_idx = static_part.index("Reusable Style Guide")
    escalation_idx = static_part.index("Escalation Policy")
    voice_idx = static_part.index("Agent voice")
    assert style_idx < escalation_idx < voice_idx


def test_dynamic_presets_render_before_runtime_context() -> None:
    bundle = _bundle(
        agent_config={
            "systemPrompt": "Reviewer voice",
            "compiledDynamicPresetSections": [
                "## Per-turn Reminder\nMention follow-ups in summary.",
            ],
        }
    )
    _, _, dynamic_part = bundle["rendered"]["system"].partition(
        SYSTEM_PROMPT_DYNAMIC_BOUNDARY
    )
    reminder_idx = dynamic_part.index("Per-turn Reminder")
    runtime_idx = dynamic_part.index("Runtime Context")
    assert reminder_idx < runtime_idx


def test_hash_changes_when_systemPrompt_changes() -> None:
    base = _bundle(agent_config={"systemPrompt": "Voice 1"})
    updated = _bundle(agent_config={"systemPrompt": "Voice 2"})
    assert base["instructionHash"] != updated["instructionHash"]


def test_sources_record_compiled_preset_sections_when_set() -> None:
    bundle = _bundle(
        agent_config={
            "systemPrompt": "Voice",
            "compiledStaticPresetSections": ["## A\nx"],
            "compiledDynamicPresetSections": ["## B\ny"],
        }
    )
    fields = {s["field"] for s in bundle["sources"]}
    assert "runtime.compiledStaticPresetSections" in fields
    assert "runtime.compiledDynamicPresetSections" in fields

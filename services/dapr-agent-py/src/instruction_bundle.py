"""Deterministic instruction bundle composition for per-turn audit/runtime use."""

from __future__ import annotations

import json
from typing import Any, Mapping

from src.effective_agent_config import stable_hash


INSTRUCTION_BUNDLE_SCHEMA_VERSION = "workflow-builder.instruction-bundle.v1"
CANONICAL_BUNDLE_TEMPLATE_NAME = "workflow-builder canonical bundle"
CANONICAL_BUNDLE_TEMPLATE_FORMAT = "jinja2"

# Sentinel marking the split between the static (cacheable) prefix and the
# dynamic per-turn tail in `rendered.system`. The Anthropic adapter looks for
# this string and, when found above its size threshold, builds a sectioned
# `system: list[TextBlockParam]` with cache_control on the static block.
# Mirrors claude-code-src/main/constants/prompts.ts:114-115.
SYSTEM_PROMPT_DYNAMIC_BOUNDARY = "__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__"


def _record(value: Any) -> dict[str, Any]:
    return dict(value) if isinstance(value, Mapping) else {}


def _string(value: Any) -> str | None:
    if not isinstance(value, str):
        return None
    text = value.strip()
    return text or None


def _string_list(value: Any) -> list[str]:
    if not isinstance(value, list):
        return []
    return [str(item).strip() for item in value if str(item).strip()]


def _int(value: Any) -> int | None:
    if isinstance(value, bool) or value is None:
        return None
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        return None
    return parsed


def _skill_name(item: Any) -> str | None:
    if not isinstance(item, Mapping):
        return None
    for key in ("name", "skillName", "skill_name", "slug"):
        text = _string(item.get(key))
        if text:
            return text
    return None


def _source(
    field: str,
    source_type: str,
    source_id: str,
    override_kind: str,
) -> dict[str, str]:
    return {
        "field": field,
        "sourceType": source_type,
        "sourceId": source_id,
        "overrideKind": override_kind,
    }


def _push_section(parts: list[str], title: str, body: str | list[str]) -> None:
    lines = [body] if isinstance(body, str) else body
    clean = [str(line).strip() for line in lines if str(line).strip()]
    if clean:
        parts.append(f"## {title}\n" + "\n".join(clean))


def _render_static_sections(bundle_without_hash: Mapping[str, Any]) -> list[str]:
    """Cache-eligible prefix: platform sections + persona (or customSystemPrompt override)."""
    persona = _record(bundle_without_hash.get("persona"))
    runtime = _record(bundle_without_hash.get("runtime"))
    parts: list[str] = []

    for section in _string_list(runtime.get("platformSystemSections")):
        parts.append(section)

    custom = _string(persona.get("customSystemPrompt"))
    if custom:
        # customSystemPrompt fully replaces persona-derived sections
        # (mirrors Claude Code's customSystemPrompt branch in queryContext.ts).
        _push_section(parts, "Agent System Prompt", custom)
        return parts

    system_prompt = _string(persona.get("systemPrompt"))
    if system_prompt:
        _push_section(parts, "Agent System Prompt", system_prompt)
    role = _string(persona.get("role"))
    if role:
        _push_section(parts, "Role", role)
    goal = _string(persona.get("goal"))
    if goal:
        _push_section(parts, "Goal", goal)
    instructions = _string_list(persona.get("instructions"))
    if instructions:
        _push_section(parts, "Primary Instructions", [f"- {line}" for line in instructions])
    style = _string_list(persona.get("styleGuidelines"))
    if style:
        _push_section(parts, "Communication Style", [f"- {line}" for line in style])
    return parts


def _render_dynamic_sections(bundle_without_hash: Mapping[str, Any]) -> list[str]:
    """Per-turn tail: runtime context + hooks + currentDate + mcpInstructions + appendSystemPrompt."""
    persona = _record(bundle_without_hash.get("persona"))
    runtime = _record(bundle_without_hash.get("runtime"))
    parts: list[str] = []

    runtime_lines: list[str] = []
    cwd = _string(runtime.get("cwd"))
    sandbox_name = _string(runtime.get("sandboxName"))
    if cwd:
        runtime_lines.append(f"Working directory: {cwd}")
    if sandbox_name:
        runtime_lines.append(f"OpenShell sandbox: {sandbox_name}")
    skills = _string_list(runtime.get("skills"))
    if skills:
        runtime_lines.append("Configured skills: " + ", ".join(skills))
    _push_section(parts, "Runtime Context", runtime_lines)

    hook_context = _string(runtime.get("hookContext"))
    if hook_context:
        _push_section(parts, "Hook Context", hook_context)

    current_date = _string(runtime.get("currentDate"))
    if current_date:
        _push_section(parts, "Current Date", current_date)

    mcp_instructions = _string_list(runtime.get("mcpInstructions"))
    if mcp_instructions:
        _push_section(parts, "MCP Server Instructions", mcp_instructions)

    append = _string(persona.get("appendSystemPrompt"))
    if append:
        # No "## " header — appendSystemPrompt is verbatim user-supplied text.
        parts.append(append)
    return parts


def render_instruction_system_text(bundle_without_hash: Mapping[str, Any]) -> str:
    static_parts = _render_static_sections(bundle_without_hash)
    dynamic_parts = _render_dynamic_sections(bundle_without_hash)

    static_text = "\n\n".join(part for part in static_parts if part).strip()
    dynamic_text = "\n\n".join(part for part in dynamic_parts if part).strip()

    if static_text and dynamic_text:
        return f"{static_text}\n\n{SYSTEM_PROMPT_DYNAMIC_BOUNDARY}\n\n{dynamic_text}"
    return static_text or dynamic_text


def bundle_template_hash(system_text: str) -> str:
    """Hash the concrete canonical template used to render provider messages."""
    return stable_hash(
        {
            "templateName": CANONICAL_BUNDLE_TEMPLATE_NAME,
            "templateFormat": CANONICAL_BUNDLE_TEMPLATE_FORMAT,
            "messages": [
                {"role": "system", "content": system_text},
                {"placeholder": "chat_history"},
            ],
        }
    )


def build_canonical_bundle_prompt_template(bundle: Mapping[str, Any]):
    """Build the Dapr ChatPromptTemplate for a rendered instruction bundle.

    The template shape is intentionally fixed for phase 1:
    system(bundle.rendered.system), chat_history placeholder. Dapr's
    PromptingAgentBase.build_initial_messages() still appends the current user
    prompt after this template has been formatted.
    """
    rendered = _record(bundle.get("rendered"))
    system_text = _string(rendered.get("system"))
    if not system_text:
        raise ValueError("instruction bundle is missing rendered.system")

    from dapr_agents.prompt import ChatPromptTemplate
    from dapr_agents.types import MessagePlaceHolder

    return ChatPromptTemplate.from_messages(
        [
            ("system", system_text),
            MessagePlaceHolder(variable_name="chat_history"),
        ],
        template_format=CANONICAL_BUNDLE_TEMPLATE_FORMAT,
    )


def assign_canonical_bundle_prompt_template(
    agent_obj: Any,
    bundle: Mapping[str, Any],
):
    """Assign the canonical bundle template to helper, agent, and LLM."""
    template = build_canonical_bundle_prompt_template(bundle)
    helper = getattr(agent_obj, "prompting_helper", None)
    if helper is not None:
        helper.prompt_template = template
    agent_obj.prompt_template = template
    llm = getattr(agent_obj, "llm", None)
    if llm is not None:
        llm.prompt_template = template
    return template


def build_instruction_bundle(
    *,
    agent_config: Mapping[str, Any] | None,
    raw_message: Mapping[str, Any] | None,
    prompt: str,
    prompt_source: str,
    cwd: str,
    sandbox_name: str | None = None,
    platform_system_sections: list[str] | None = None,
    hook_context: str | None = None,
    current_date: str | None = None,
    mcp_instructions: list[str] | None = None,
    agent_id: str | None = None,
    agent_version: int | None = None,
    agent_config_hash: str | None = None,
    agent_slug: str | None = None,
    control_override_fields: set[str] | None = None,
) -> dict[str, Any]:
    config = dict(agent_config or {})
    message = dict(raw_message or {})
    effective_agent_id = (
        _string(agent_id)
        or _string(message.get("agentId"))
        or _string(message.get("agent_id"))
        or _string(config.get("id"))
    )
    effective_agent_slug = (
        _string(agent_slug)
        or _string(message.get("agentSlug"))
        or _string(message.get("agent_slug"))
        or _string(config.get("slug"))
    )
    effective_version = (
        agent_version
        if agent_version is not None
        else _int(message.get("agentVersion"))
        or _int(message.get("agent_version"))
        or _int(config.get("version"))
    )
    source_id = effective_agent_id or effective_agent_slug or "agent-profile"

    persona = {
        "role": _string(config.get("role")),
        "goal": _string(config.get("goal")),
        "instructions": _string_list(config.get("instructions")),
        "styleGuidelines": _string_list(config.get("styleGuidelines")),
        "systemPrompt": _string(config.get("systemPrompt")),
        "customSystemPrompt": _string(config.get("customSystemPrompt")),
        "appendSystemPrompt": _string(config.get("appendSystemPrompt")),
    }
    skills = [
        name
        for name in (_skill_name(item) for item in config.get("skills") or [])
        if name
    ] if isinstance(config.get("skills"), list) else []
    runtime = {
        "cwd": _string(cwd) or "/sandbox",
        "sandboxName": _string(sandbox_name),
        "skills": skills,
        "hookContext": _string(hook_context),
        "platformSystemSections": _string_list(platform_system_sections or []),
        "currentDate": _string(current_date),
        "mcpInstructions": _string_list(mcp_instructions or []),
    }

    control_fields = set(control_override_fields or set())
    sources: list[dict[str, str]] = []

    def persona_source(field: str, config_key: str) -> dict[str, str]:
        if config_key in control_fields:
            return _source(field, "user", "session.control", "control")
        return _source(field, "agent-profile", source_id, "base")

    if persona["systemPrompt"]:
        sources.append(persona_source("persona.systemPrompt", "systemPrompt"))
    if persona["customSystemPrompt"]:
        sources.append(persona_source("persona.customSystemPrompt", "customSystemPrompt"))
    if persona["appendSystemPrompt"]:
        sources.append(persona_source("persona.appendSystemPrompt", "appendSystemPrompt"))
    if persona["role"]:
        sources.append(persona_source("persona.role", "role"))
    if persona["goal"]:
        sources.append(persona_source("persona.goal", "goal"))
    if persona["instructions"]:
        sources.append(persona_source("persona.instructions", "instructions"))
    if persona["styleGuidelines"]:
        sources.append(persona_source("persona.styleGuidelines", "styleGuidelines"))
    if runtime["cwd"]:
        sources.append(_source("runtime.cwd", "runtime", "runtime", "runtime"))
    if runtime["sandboxName"]:
        sources.append(_source("runtime.sandboxName", "runtime", "runtime", "runtime"))
    if runtime["skills"]:
        sources.append(_source("runtime.skills", "runtime", "agentConfig.skills", "runtime"))
    if runtime["currentDate"]:
        sources.append(_source("runtime.currentDate", "runtime", "runtime", "runtime"))
    if runtime["mcpInstructions"]:
        sources.append(_source("runtime.mcpInstructions", "runtime", "mcp-clients", "runtime"))

    normalized_source = "workflow-node" if prompt_source == "workflow-node" else "session"
    sources.append(
        _source(
            "user.prompt",
            "user",
            normalized_source,
            "runtime" if normalized_source == "workflow-node" else "control",
        )
    )

    base = {
        "schemaVersion": INSTRUCTION_BUNDLE_SCHEMA_VERSION,
        "agent": {
            **({"id": effective_agent_id} if effective_agent_id else {}),
            **({"version": effective_version} if effective_version is not None else {}),
            **({"configHash": _string(agent_config_hash)} if _string(agent_config_hash) else {}),
            **({"slug": effective_agent_slug} if effective_agent_slug else {}),
        },
        "persona": persona,
        "runtime": runtime,
        "user": {
            "prompt": prompt,
            "source": normalized_source,
        },
        "sources": sources,
    }
    rendered = {
        "system": render_instruction_system_text(base),
        "user": prompt,
    }
    template_hash = bundle_template_hash(rendered["system"])
    base_with_template = {
        **base,
        "templateName": CANONICAL_BUNDLE_TEMPLATE_NAME,
        "templateHash": template_hash,
    }
    instruction_hash = stable_hash({**base_with_template, "rendered": rendered})
    return {
        **base_with_template,
        "instructionHash": instruction_hash,
        "rendered": rendered,
    }


def instruction_bundle_audit_payload(
    bundle: Mapping[str, Any],
    *,
    max_bytes: int,
    preview_chars: int = 2000,
) -> dict[str, Any]:
    """Return full bundle when under cap, otherwise a reconstructable preview."""
    try:
        encoded = json.dumps(bundle, ensure_ascii=False, default=str)
        size = len(encoded.encode("utf-8", "ignore"))
    except Exception:
        encoded = ""
        size = 0
    if size <= max_bytes:
        return {"bundle": dict(bundle), "oversized": False, "size_bytes": size}

    rendered = _record(bundle.get("rendered"))
    system_text = str(rendered.get("system") or "")
    user_text = str(rendered.get("user") or "")
    return {
        "schemaVersion": bundle.get("schemaVersion"),
        "instructionHash": bundle.get("instructionHash"),
        "templateName": bundle.get("templateName"),
        "templateHash": bundle.get("templateHash"),
        "agent": bundle.get("agent") if isinstance(bundle.get("agent"), Mapping) else {},
        "sources": bundle.get("sources") if isinstance(bundle.get("sources"), list) else [],
        "oversized": True,
        "size_bytes": size,
        "renderedLengths": {
            "system": len(system_text),
            "user": len(user_text),
        },
        "renderedPreview": {
            "system": system_text[:preview_chars],
            "user": user_text[:preview_chars],
        },
    }

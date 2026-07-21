from __future__ import annotations

from src.session_config import apply_agent_config_patch, normalize_agent_config_patch


def test_structured_output_patch_is_atomic():
    schema = {
        "type": "object",
        "properties": {"summary": {"type": "string"}},
    }

    assert normalize_agent_config_patch(
        {
            "structuredOutputMode": "tool",
            "responseJsonSchema": schema,
        }
    ) == {
        "structuredOutputMode": "tool",
        "responseJsonSchema": schema,
    }


def test_partial_or_invalid_structured_output_patch_is_dropped():
    assert normalize_agent_config_patch({"structuredOutputMode": "tool"}) == {}
    assert (
        normalize_agent_config_patch({"responseJsonSchema": {"type": "object"}}) == {}
    )
    assert (
        normalize_agent_config_patch(
            {"structuredOutputMode": "native", "responseJsonSchema": {"type": "object"}}
        )
        == {}
    )
    assert (
        normalize_agent_config_patch(
            {"structuredOutputMode": "tool", "responseJsonSchema": {}}
        )
        == {}
    )


def test_invalid_structured_output_fields_do_not_discard_other_patch_fields():
    assert normalize_agent_config_patch(
        {"modelSpec": "kimi/kimi-k3", "structuredOutputMode": "tool"}
    ) == {"modelSpec": "kimi/kimi-k3"}


def test_structured_output_clear_is_atomic():
    assert normalize_agent_config_patch(
        {"structuredOutputMode": None, "responseJsonSchema": None}
    ) == {"structuredOutputMode": None, "responseJsonSchema": None}
    assert (
        normalize_agent_config_patch(
            {"structuredOutputMode": None, "responseJsonSchema": {"type": "object"}}
        )
        == {}
    )


def test_atomic_clear_removes_both_structured_output_fields():
    original = {
        "modelSpec": "kimi/kimi-k3",
        "structuredOutputMode": "tool",
        "responseJsonSchema": {"type": "object"},
    }

    next_config, changed = apply_agent_config_patch(
        original,
        {"structuredOutputMode": None, "responseJsonSchema": None},
    )

    assert original["structuredOutputMode"] == "tool"
    assert next_config == {"modelSpec": "kimi/kimi-k3"}
    assert changed == ["structuredOutputMode", "responseJsonSchema"]


def test_tools_patch_replaces_stale_runtime_allowlist_including_empty():
    narrowed, changed = apply_agent_config_patch(
        {
            "builtinTools": ["read_file", "write_file"],
            "tools": ["read_file", "write_file"],
            "allowedTools": ["read_file", "write_file"],
        },
        {"tools": []},
    )

    assert narrowed["builtinTools"] == ["read_file", "write_file"]
    assert narrowed["tools"] == []
    assert narrowed["allowedTools"] == []
    assert changed == ["tools", "allowedTools"]

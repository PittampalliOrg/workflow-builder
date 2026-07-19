"""Static pins for the kimi-code v2 tool-surface alignment wiring.

Covers the cross-file integration that behavioral tool tests cannot see:
registration names/schemas in src/tools/__init__.py, the builtin-tool alias
map and the interactionMode=autonomous suppression path in src/main.py, and
alias serialization in src/kimi_adapter.py.
"""

from __future__ import annotations

from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
MAIN_SOURCE = ROOT / "src" / "main.py"
TOOLS_INIT = ROOT / "src" / "tools" / "__init__.py"
KIMI_ADAPTER = ROOT / "src" / "kimi_adapter.py"


def test_registration_uses_kimi_code_names_and_args_models() -> None:
    source = TOOLS_INIT.read_text()

    # Aligned renames registered with explicit args models.
    assert '_tool(todo_list, "TodoList", TodoListArgs)' in source
    assert '_tool(ask_user, "AskUserQuestion", AskUserQuestionArgs)' in source
    for registration in (
        '_tool(file_read, "Read", ReadArgs)',
        '_tool(file_write, "Write", WriteArgs)',
        '_tool(file_edit, "Edit", EditArgs)',
        '_tool(glob_search, "Glob", GlobArgs)',
        '_tool(grep_search, "Grep", GrepArgs)',
        '_tool(bash_run, "Bash", BashArgs)',
    ):
        assert registration in source

    # Old names and dead MCP-resource stubs are gone.
    assert '"TodoWrite"' not in source
    assert '"AskUser")' not in source
    assert "ListMcpResources" not in source
    assert "ReadMcpResource" not in source
    assert "mcp_resources" not in source


def test_builtin_tool_alias_map_targets_aligned_names() -> None:
    source = MAIN_SOURCE.read_text()

    # Config names (todo_write/ask_user) keep working, now pointing at the
    # aligned wire names.
    assert '_normalize_tool_lookup_name("todo_write"): ("TodoList",)' in source
    assert '_normalize_tool_lookup_name("ask_user"): ("AskUserQuestion",)' in source
    assert '("TodoWrite",)' not in source
    assert '("AskUser",)' not in source
    # Dead stubs have no alias entries either.
    assert '_normalize_tool_lookup_name("list_mcp_resources")' not in source
    assert '_normalize_tool_lookup_name("read_mcp_resource")' not in source


def test_autonomous_interaction_mode_suppresses_ask_user_question() -> None:
    source = MAIN_SOURCE.read_text()

    # agentConfig.interactionMode is extracted into the runtime context...
    assert 'agent_config.get("interactionMode")' in source
    assert 'context["interactionMode"]' in source
    # ...propagated into the per-instance agent context...
    assert '"interactionMode": clean.get("interactionMode")' in source
    # ...resolved via a dedicated helper...
    assert "def _interaction_mode_for_instance(self, instance_id: str) -> str:" in source
    # ...hidden from the model adapter-side (get_llm_tools)...
    assert "AskUserQuestion hidden" in source
    # ...and denied at the execution gate (_is_tool_allowed_for_instance).
    helper = source.index("def _interaction_mode_for_instance")
    gate = source.index("def _is_tool_allowed_for_instance")
    assert helper < gate
    gate_body = source[gate : gate + 1200]
    assert '== "autonomous"' in gate_body
    assert "return False" in gate_body


def test_kimi_adapter_serializes_schemas_with_aliases() -> None:
    source = KIMI_ADAPTER.read_text()
    # Grep's dash-named wire params ("-i"/"-A"/"-B"/"-C") are pydantic aliases;
    # the adapter must emit them, not the python field names.
    assert "model_json_schema(by_alias=True)" in source

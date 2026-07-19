from __future__ import annotations

import importlib
import sys
import types
from pathlib import Path

import pytest
from pydantic import ValidationError


ROOT = Path(__file__).resolve().parents[1]
SRC_DIR = ROOT / "src"


def _install_src_package() -> None:
    src_pkg = sys.modules.get("src") or types.ModuleType("src")
    src_pkg.__path__ = [str(SRC_DIR)]
    sys.modules["src"] = src_pkg

    tools_pkg = sys.modules.get("src.tools") or types.ModuleType("src.tools")
    tools_pkg.__path__ = [str(SRC_DIR / "tools")]
    sys.modules["src.tools"] = tools_pkg

    todo_pkg = sys.modules.get("src.tools.todo_write") or types.ModuleType(
        "src.tools.todo_write"
    )
    todo_pkg.__path__ = [str(SRC_DIR / "tools" / "todo_write")]
    sys.modules["src.tools.todo_write"] = todo_pkg


def _load_tool():
    # Snapshot + restore src* modules so the fake packages installed here do
    # not leak into other test files (see test_file_edit_tool.py).
    saved = {k: v for k, v in sys.modules.items() if k == "src" or k.startswith("src.")}
    try:
        _install_src_package()
        sys.modules.pop("src.tools.todo_write.tool", None)
        return importlib.import_module("src.tools.todo_write.tool")
    finally:
        for key in [k for k in sys.modules if k == "src" or k.startswith("src.")]:
            if key not in saved:
                del sys.modules[key]
        sys.modules.update(saved)


@pytest.fixture()
def mod():
    module = _load_tool()
    module._store.clear()
    yield module
    module._store.clear()


# ---------------------------------------------------------------------------
# Wire schema shape (kimi-code v2 TodoList alignment)
# ---------------------------------------------------------------------------


def test_args_model_wire_schema(mod):
    schema = mod.TodoListArgs.model_json_schema()

    # Top level: only `todos`, optional, closed object.
    assert schema["type"] == "object"
    assert schema["additionalProperties"] is False
    assert set(schema["properties"]) == {"todos"}
    assert schema.get("required", []) == []

    todos = schema["properties"]["todos"]
    assert todos.get("description")

    # `todos` is nullable-optional: anyOf [array of TodoItem, null].
    variants = todos["anyOf"]
    assert {v.get("type") for v in variants} == {"array", "null"}
    array_variant = next(v for v in variants if v.get("type") == "array")
    assert array_variant["items"] == {"$ref": "#/$defs/TodoItem"}

    # Item schema: closed object, both fields required, title non-empty,
    # status is the kimi-code enum (note: 'done', not 'completed').
    item = schema["$defs"]["TodoItem"]
    assert item["additionalProperties"] is False
    assert set(item["required"]) == {"title", "status"}
    assert item["properties"]["title"]["minLength"] == 1
    assert item["properties"]["title"].get("description")
    assert item["properties"]["status"]["enum"] == ["pending", "in_progress", "done"]
    assert item["properties"]["status"].get("description")


def test_args_model_validation(mod):
    # Omitted todos -> query mode (None).
    assert mod.TodoListArgs().todos is None
    assert mod.TodoListArgs(todos=None).todos is None
    assert mod.TodoListArgs(todos=[]).todos == []

    args = mod.TodoListArgs(todos=[{"title": "Fix bug", "status": "done"}])
    assert isinstance(args.todos[0], mod.TodoItem)
    assert args.todos[0].title == "Fix bug"
    assert args.todos[0].status == "done"

    # Closed objects: extra keys rejected at both levels.
    with pytest.raises(ValidationError):
        mod.TodoListArgs(todos=[], bogus=1)
    with pytest.raises(ValidationError):
        mod.TodoListArgs(todos=[{"title": "x", "status": "done", "extra": 1}])

    # Field constraints.
    with pytest.raises(ValidationError):
        mod.TodoListArgs(todos=[{"title": "", "status": "done"}])
    with pytest.raises(ValidationError):
        mod.TodoListArgs(todos=[{"title": "x", "status": "completed"}])
    with pytest.raises(ValidationError):
        mod.TodoListArgs(todos=[{"title": "x"}])
    with pytest.raises(ValidationError):
        mod.TodoListArgs(todos=[{"status": "done"}])


def test_validated_kwargs_flow(mod):
    """Mirror AgentTool._validate_and_prepare_args: model_dump(exclude_none=True)
    then call the function with the flat field-name kwargs."""
    # {} and explicit null both drop `todos` -> query mode.
    for raw in ({}, {"todos": None}):
        kwargs = mod.TodoListArgs(**raw).model_dump(exclude_none=True)
        assert kwargs == {}
        assert mod.todo_list(**kwargs) == "The todo list is empty."

    kwargs = mod.TodoListArgs(
        todos=[{"title": "Ship it", "status": "done"}]
    ).model_dump(exclude_none=True)
    assert kwargs == {"todos": [{"title": "Ship it", "status": "done"}]}
    out = mod.todo_list(**kwargs)
    assert "[x] Ship it" in out


# ---------------------------------------------------------------------------
# Set / query / clear semantics
# ---------------------------------------------------------------------------


def test_set_query_clear_semantics(mod):
    assert mod.todo_list() == "The todo list is empty."

    out = mod.todo_list(
        todos=[
            {"title": "Read code", "status": "done"},
            {"title": "Patch config", "status": "in_progress"},
            {"title": "Run tests", "status": "pending"},
        ]
    )
    assert "[x] Read code" in out
    assert "[~] Patch config" in out
    assert "[ ] Run tests" in out
    assert "Progress: 1/3 done" in out

    # Query returns the stored list without changing it.
    assert mod.todo_list() == out

    # Set replaces wholesale.
    replaced = mod.todo_list(todos=[{"title": "Only task", "status": "pending"}])
    assert "Only task" in replaced
    assert "Read code" not in replaced
    assert mod.todo_list() == replaced

    # [] clears.
    assert mod.todo_list(todos=[]) == "The todo list has been cleared."
    assert mod.todo_list() == "The todo list is empty."


def test_function_accepts_todo_item_instances(mod):
    out = mod.todo_list(todos=[mod.TodoItem(title="Direct", status="in_progress")])
    assert "[~] Direct" in out


def test_invalid_items_return_error_strings(mod):
    # House convention: model-visible failures are 'Error: ...' strings,
    # never raised exceptions.
    out = mod.todo_list(todos=[{"title": "x", "status": "completed"}])
    assert out.startswith("Error:")
    assert "completed" in out

    out = mod.todo_list(todos=[{"title": "ok", "status": "done"}, {"status": "done"}])
    assert out == "Error: Item 1 is missing a 'title' field."

    out = mod.todo_list(todos=["not-an-object"])
    assert out == "Error: Item 0 is not an object with 'title' and 'status' fields."

    out = mod.todo_list(todos="not-a-list")
    assert out.startswith("Error:")

    # A rejected set must not clobber the stored list.
    mod.todo_list(todos=[{"title": "Keep me", "status": "pending"}])
    mod.todo_list(todos=[{"title": "", "status": "done"}])
    assert "Keep me" in mod.todo_list()


def test_exactly_one_in_progress_not_enforced(mod):
    # The single-in_progress rule is prompt guidance only; kimi-code does not
    # hard-enforce it and neither do we.
    out = mod.todo_list(
        todos=[
            {"title": "a", "status": "in_progress"},
            {"title": "b", "status": "in_progress"},
        ]
    )
    assert not out.startswith("Error:")

    out = mod.todo_list(todos=[{"title": "a", "status": "pending"}])
    assert not out.startswith("Error:")


# ---------------------------------------------------------------------------
# Store keying
# ---------------------------------------------------------------------------


class _FakeCtx:
    def __init__(self, instance_id=None, session_id=None):
        self.parent_instance_id = instance_id
        self.parent_session_id = session_id


def test_store_isolated_per_instance(mod, monkeypatch):
    ctx = _FakeCtx(instance_id="inst-a")
    monkeypatch.setattr(mod, "get_callable_agents_context", lambda: ctx)
    mod.todo_list(todos=[{"title": "A's task", "status": "pending"}])

    ctx.parent_instance_id = "inst-b"
    assert mod.todo_list() == "The todo list is empty."
    mod.todo_list(todos=[{"title": "B's task", "status": "done"}])

    ctx.parent_instance_id = "inst-a"
    out = mod.todo_list()
    assert "A's task" in out
    assert "B's task" not in out


def test_store_fallback_bucket(mod, monkeypatch):
    # No context (e.g. thread-local unset) -> process-wide default bucket.
    monkeypatch.setattr(mod, "get_callable_agents_context", lambda: None)
    mod.todo_list(todos=[{"title": "Fallback task", "status": "pending"}])
    assert "Fallback task" in mod.todo_list()
    assert mod._store[mod._DEFAULT_BUCKET]


def test_docstring_is_kimi_description(mod):
    assert mod.todo_list.__doc__ == mod.get_todo_list_description()
    assert "in_progress" in mod.todo_list.__doc__
    # No internal python function names in model-facing text.
    assert "todo_list(" not in mod.todo_list.__doc__
    assert "todo_write" not in mod.todo_list.__doc__

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

    glob_pkg = sys.modules.get("src.tools.glob_tool") or types.ModuleType(
        "src.tools.glob_tool"
    )
    glob_pkg.__path__ = [str(SRC_DIR / "tools" / "glob_tool")]
    sys.modules["src.tools.glob_tool"] = glob_pkg


def _load_tool(monkeypatch):
    fake_openshell = types.ModuleType("openshell")
    fake_openshell.SandboxClient = object
    fake_openshell.SandboxSession = object
    monkeypatch.setitem(sys.modules, "openshell", fake_openshell)
    # Snapshot + restore src* modules: the fake packages installed below must
    # not leak into other test files (same pattern as test_file_edit_tool.py).
    saved = {k: v for k, v in sys.modules.items() if k == "src" or k.startswith("src.")}
    try:
        _install_src_package()
        sys.modules.pop("src.tools.glob_tool.tool", None)
        return importlib.import_module("src.tools.glob_tool.tool")
    finally:
        for key in [k for k in sys.modules if k == "src" or k.startswith("src.")]:
            if key not in saved:
                del sys.modules[key]
        sys.modules.update(saved)


class FakeRuntime:
    def __init__(self) -> None:
        self.cwd = "/sandbox"
        self.dirs = {"/sandbox", "/sandbox/workspace"}
        self.calls: list[tuple[str, str, int]] = []

    def resolve_path(self, path: str) -> str:
        if path.startswith("/"):
            return path
        return f"/sandbox/{path}"

    def stat_path(self, path: str) -> dict:
        is_dir = path in self.dirs
        return {"ok": True, "exists": is_dir, "is_dir": is_dir}

    def glob_files(self, pattern: str, search_dir: str, max_results: int) -> dict:
        self.calls.append((pattern, search_dir, max_results))
        return {
            "ok": True,
            "matches": ["/sandbox/b.py", "/sandbox/a.py"],
            "total": 2,
        }


def test_wire_schema_shape(monkeypatch):
    tool = _load_tool(monkeypatch)

    schema = tool.GlobArgs.model_json_schema(by_alias=True)

    assert schema["additionalProperties"] is False
    assert set(schema["properties"]) == {"pattern", "path"}
    assert schema["required"] == ["pattern"]
    for prop in schema["properties"].values():
        assert prop.get("description"), "every parameter needs a description"


def test_wire_schema_rejects_extra_properties(monkeypatch):
    tool = _load_tool(monkeypatch)

    with pytest.raises(ValidationError):
        tool.GlobArgs.model_validate({"pattern": "**/*.py", "include_ignored": True})

    args = tool.GlobArgs.model_validate({"pattern": "**/*.py"})
    assert args.pattern == "**/*.py"
    assert args.path is None


def test_glob_search_returns_matches(monkeypatch):
    tool = _load_tool(monkeypatch)
    runtime = FakeRuntime()
    monkeypatch.setattr(tool, "get_runtime", lambda: runtime)
    monkeypatch.setattr(tool, "expand_path", runtime.resolve_path)

    result = tool.glob_search(pattern="**/*.py", path="workspace")

    assert result == "/sandbox/b.py\n/sandbox/a.py"
    assert runtime.calls == [("**/*.py", "/sandbox/workspace", 100)]


def test_glob_search_missing_directory(monkeypatch):
    tool = _load_tool(monkeypatch)
    runtime = FakeRuntime()
    monkeypatch.setattr(tool, "get_runtime", lambda: runtime)
    monkeypatch.setattr(tool, "expand_path", runtime.resolve_path)

    result = tool.glob_search(pattern="**/*.py", path="/nope")

    assert result == "Error: Directory not found: /nope"
    assert runtime.calls == []


def test_description_uses_registered_tool_names(monkeypatch):
    tool = _load_tool(monkeypatch)

    doc = tool.glob_search.__doc__
    assert "agent_spawn" not in doc
    assert "Agent" in doc
    assert "sorted by modification time" in doc

from __future__ import annotations

import importlib
import inspect
import sys
import types
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SRC_DIR = ROOT / "src"


def _install_src_package() -> None:
    src_pkg = sys.modules.get("src") or types.ModuleType("src")
    src_pkg.__path__ = [str(SRC_DIR)]
    sys.modules["src"] = src_pkg

    tools_pkg = sys.modules.get("src.tools") or types.ModuleType("src.tools")
    tools_pkg.__path__ = [str(SRC_DIR / "tools")]
    sys.modules["src.tools"] = tools_pkg

    file_edit_pkg = sys.modules.get("src.tools.file_edit") or types.ModuleType(
        "src.tools.file_edit"
    )
    file_edit_pkg.__path__ = [str(SRC_DIR / "tools" / "file_edit")]
    sys.modules["src.tools.file_edit"] = file_edit_pkg


def _load_tool(monkeypatch):
    fake_openshell = types.ModuleType("openshell")
    fake_openshell.SandboxClient = object
    fake_openshell.SandboxSession = object
    monkeypatch.setitem(sys.modules, "openshell", fake_openshell)
    # Snapshot + restore src* modules: the fake packages installed below must
    # not leak into other test files (module-poisoning made suite results
    # depend on collection order). The returned module object stays usable
    # after its sys.modules entry is restored.
    saved = {k: v for k, v in sys.modules.items() if k == "src" or k.startswith("src.")}
    try:
        _install_src_package()
        sys.modules.pop("src.tools.file_edit.tool", None)
        return importlib.import_module("src.tools.file_edit.tool")
    finally:
        for key in [k for k in sys.modules if k == "src" or k.startswith("src.")]:
            if key not in saved:
                del sys.modules[key]
        sys.modules.update(saved)


class FakeRuntime:
    def __init__(self, files: dict[str, str] | None = None) -> None:
        self.files = files if files is not None else {"/sandbox/file.py": "value = 'old'\n"}

    def resolve_path(self, path: str) -> str:
        if path.startswith("/"):
            return path
        return f"/sandbox/{path}"

    def stat_path(self, path: str) -> dict:
        return {
            "ok": True,
            "exists": path in self.files,
            "is_dir": False,
        }

    def read_text(self, path: str) -> dict:
        return {"ok": True, "content": self.files[path]}

    def write_text(self, path: str, content: str) -> dict:
        self.files[path] = content
        return {"ok": True}


def _patch_runtime(monkeypatch, tool, runtime: FakeRuntime) -> None:
    monkeypatch.setattr(tool, "get_runtime", lambda: runtime)
    monkeypatch.setattr(tool, "expand_path", runtime.resolve_path)


def test_file_edit_replaces_unique_string(monkeypatch):
    tool = _load_tool(monkeypatch)
    runtime = FakeRuntime()
    _patch_runtime(monkeypatch, tool, runtime)

    result = tool.file_edit(
        path="file.py",
        old_string="value = 'old'",
        new_string="value = 'new'",
    )

    assert "Replaced 1 occurrence" in result
    assert runtime.files["/sandbox/file.py"] == "value = 'new'\n"


def test_file_edit_replace_all(monkeypatch):
    tool = _load_tool(monkeypatch)
    runtime = FakeRuntime({"/sandbox/file.py": "x = 1\ny = x\n"})
    _patch_runtime(monkeypatch, tool, runtime)

    result = tool.file_edit(path="file.py", old_string="x", new_string="z", replace_all=True)

    assert "Replaced 2 occurrence" in result
    assert runtime.files["/sandbox/file.py"] == "z = 1\ny = z\n"


def test_file_edit_non_unique_match_errors_without_replace_all(monkeypatch):
    tool = _load_tool(monkeypatch)
    runtime = FakeRuntime({"/sandbox/file.py": "x = 1\ny = x\n"})
    _patch_runtime(monkeypatch, tool, runtime)

    result = tool.file_edit(path="file.py", old_string="x", new_string="z")

    assert result.startswith("Error: Found 2 occurrences")
    assert runtime.files["/sandbox/file.py"] == "x = 1\ny = x\n"


def test_file_edit_normalizes_curly_quotes(monkeypatch):
    tool = _load_tool(monkeypatch)
    runtime = FakeRuntime({"/sandbox/file.py": 'msg = “hello”\n'})
    _patch_runtime(monkeypatch, tool, runtime)

    result = tool.file_edit(
        path="file.py",
        old_string='msg = "hello"',
        new_string='msg = "bye"',
    )

    assert "Replaced 1 occurrence" in result
    assert runtime.files["/sandbox/file.py"] == 'msg = "bye"\n'


def test_file_edit_signature_uses_wire_field_names(monkeypatch):
    tool = _load_tool(monkeypatch)

    assert list(inspect.signature(tool.file_edit).parameters) == [
        "path",
        "old_string",
        "new_string",
        "replace_all",
    ]


def test_edit_args_wire_schema(monkeypatch):
    tool = _load_tool(monkeypatch)

    schema = tool.EditArgs.model_json_schema()

    assert schema["additionalProperties"] is False
    assert set(schema["properties"]) == {"path", "old_string", "new_string", "replace_all"}
    assert schema["required"] == ["path", "old_string", "new_string"]
    assert schema["properties"]["old_string"]["minLength"] == 1
    assert schema["properties"]["replace_all"]["default"] is False
    for prop in schema["properties"].values():
        assert prop.get("description")


def test_edit_description_uses_registered_tool_names(monkeypatch):
    tool = _load_tool(monkeypatch)

    doc = tool.file_edit.__doc__ or ""

    for internal_name in ("bash_run", "file_read", "file_write", "file_edit"):
        assert internal_name not in doc
    assert "Read" in doc and "Edit" in doc and "Write" in doc

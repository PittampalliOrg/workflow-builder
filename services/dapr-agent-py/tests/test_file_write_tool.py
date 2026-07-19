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

    file_write_pkg = sys.modules.get("src.tools.file_write") or types.ModuleType(
        "src.tools.file_write"
    )
    file_write_pkg.__path__ = [str(SRC_DIR / "tools" / "file_write")]
    sys.modules["src.tools.file_write"] = file_write_pkg


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
        sys.modules.pop("src.tools.file_write.tool", None)
        return importlib.import_module("src.tools.file_write.tool")
    finally:
        for key in [k for k in sys.modules if k == "src" or k.startswith("src.")]:
            if key not in saved:
                del sys.modules[key]
        sys.modules.update(saved)


class FakeRuntime:
    def __init__(self, files: dict[str, str] | None = None) -> None:
        self.files = files if files is not None else {}

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
        existed = path in self.files
        self.files[path] = content
        return {"ok": True, "existed": existed}


def _patch_runtime(monkeypatch, tool, runtime: FakeRuntime) -> None:
    monkeypatch.setattr(tool, "get_runtime", lambda: runtime)
    monkeypatch.setattr(tool, "expand_path", runtime.resolve_path)


def test_write_creates_new_file(monkeypatch):
    tool = _load_tool(monkeypatch)
    runtime = FakeRuntime()
    _patch_runtime(monkeypatch, tool, runtime)

    result = tool.file_write(path="f.txt", content="hello\n")

    assert "created" in result
    assert runtime.files["/sandbox/f.txt"] == "hello\n"


def test_write_overwrites_existing_file_by_default(monkeypatch):
    tool = _load_tool(monkeypatch)
    runtime = FakeRuntime({"/sandbox/f.txt": "old content\n"})
    _patch_runtime(monkeypatch, tool, runtime)

    result = tool.file_write(path="f.txt", content="new content\n")

    assert "updated" in result
    assert runtime.files["/sandbox/f.txt"] == "new content\n"


def test_write_append_adds_content_at_eof(monkeypatch):
    tool = _load_tool(monkeypatch)
    runtime = FakeRuntime({"/sandbox/f.txt": "line1\n"})
    _patch_runtime(monkeypatch, tool, runtime)

    result = tool.file_write(path="f.txt", content="line2\n", mode="append")

    assert "updated" in result
    assert runtime.files["/sandbox/f.txt"] == "line1\nline2\n"


def test_write_append_adds_no_extra_newline(monkeypatch):
    tool = _load_tool(monkeypatch)
    runtime = FakeRuntime({"/sandbox/f.txt": "abc"})
    _patch_runtime(monkeypatch, tool, runtime)

    tool.file_write(path="f.txt", content="def", mode="append")

    assert runtime.files["/sandbox/f.txt"] == "abcdef"


def test_write_append_missing_file_creates_it(monkeypatch):
    tool = _load_tool(monkeypatch)
    runtime = FakeRuntime()
    _patch_runtime(monkeypatch, tool, runtime)

    result = tool.file_write(path="f.txt", content="hello\n", mode="append")

    assert "created" in result
    assert runtime.files["/sandbox/f.txt"] == "hello\n"


def test_write_rejects_unknown_mode(monkeypatch):
    tool = _load_tool(monkeypatch)
    _patch_runtime(monkeypatch, tool, FakeRuntime())

    result = tool.file_write(path="f.txt", content="x", mode="truncate")

    assert result.startswith("Error: mode must be")


def test_write_signature_uses_wire_field_names(monkeypatch):
    tool = _load_tool(monkeypatch)

    assert list(inspect.signature(tool.file_write).parameters) == [
        "path",
        "content",
        "mode",
    ]


def test_write_args_wire_schema(monkeypatch):
    tool = _load_tool(monkeypatch)

    schema = tool.WriteArgs.model_json_schema()

    assert schema["additionalProperties"] is False
    assert set(schema["properties"]) == {"path", "content", "mode"}
    assert schema["required"] == ["path", "content"]
    assert schema["properties"]["mode"]["enum"] == ["overwrite", "append"]
    assert schema["properties"]["mode"]["default"] == "overwrite"
    for prop in schema["properties"].values():
        assert prop.get("description")


def test_write_description_uses_registered_tool_names(monkeypatch):
    tool = _load_tool(monkeypatch)

    doc = tool.file_write.__doc__ or ""

    assert "file_edit" not in doc and "file_read" not in doc
    assert "Edit" in doc and "Read" in doc

from __future__ import annotations

import importlib
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
    _install_src_package()
    sys.modules.pop("src.tools.file_edit.tool", None)
    return importlib.import_module("src.tools.file_edit.tool")


class FakeRuntime:
    def __init__(self) -> None:
        self.files = {"/sandbox/file.py": "value = 'old'\n"}

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


def test_file_edit_accepts_short_string_aliases(monkeypatch):
    tool = _load_tool(monkeypatch)
    runtime = FakeRuntime()
    monkeypatch.setattr(tool, "get_runtime", lambda: runtime)
    monkeypatch.setattr(tool, "expand_path", runtime.resolve_path)

    result = tool.file_edit(
        file_path="file.py",
        old_str="value = 'old'",
        new_str="value = 'new'",
    )

    assert "Replaced 1 occurrence" in result
    assert runtime.files["/sandbox/file.py"] == "value = 'new'\n"


def test_file_edit_requires_replacement_strings(monkeypatch):
    tool = _load_tool(monkeypatch)

    assert tool.file_edit(file_path="file.py") == "Error: old_string and new_string are required."

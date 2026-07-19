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

    # Install empty package shells so the real __init__.py files (which import
    # their tool modules and heavy dependencies) are never executed.
    for name in ("bash_tool", "file_read", "file_write", "file_edit"):
        pkg_name = f"src.tools.{name}"
        pkg = sys.modules.get(pkg_name) or types.ModuleType(pkg_name)
        pkg.__path__ = [str(SRC_DIR / "tools" / name)]
        sys.modules[pkg_name] = pkg


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
        for name in (
            "src.tools.bash_tool.tool",
            "src.tools.bash_tool.prompt",
            "src.tools.file_read.prompt",
            "src.tools.file_write.prompt",
            "src.tools.file_edit.prompt",
        ):
            sys.modules.pop(name, None)
        return importlib.import_module("src.tools.bash_tool.tool")
    finally:
        for key in [k for k in sys.modules if k == "src" or k.startswith("src.")]:
            if key not in saved:
                del sys.modules[key]
        sys.modules.update(saved)


class FakeRuntime:
    def __init__(self) -> None:
        self.calls: list[dict] = []

    def execute(self, command: str, timeout_seconds: int | None = None) -> dict:
        self.calls.append({"command": command, "timeout_seconds": timeout_seconds})
        return {"stdout": "ok\n", "stderr": "", "exit_code": 0}


def test_bash_args_wire_schema_shape(monkeypatch):
    tool = _load_tool(monkeypatch)

    schema = tool.BashArgs.model_json_schema(by_alias=True)

    assert schema["additionalProperties"] is False
    assert set(schema["properties"]) == {"command", "timeout", "description"}
    assert schema["required"] == ["command"]
    for name in ("command", "timeout", "description"):
        assert schema["properties"][name].get("description"), name
    assert schema["properties"]["timeout"]["default"] == 60


def test_bash_timeout_is_passed_through_in_seconds(monkeypatch):
    tool = _load_tool(monkeypatch)
    runtime = FakeRuntime()
    monkeypatch.setattr(tool, "get_runtime", lambda: runtime)

    result = tool.bash_run(command="echo hi", timeout=5, description="Say hi")

    assert runtime.calls[-1]["timeout_seconds"] == 5
    assert "ok" in result


def test_bash_timeout_is_capped_at_max_seconds(monkeypatch):
    tool = _load_tool(monkeypatch)
    runtime = FakeRuntime()
    monkeypatch.setattr(tool, "get_runtime", lambda: runtime)

    tool.bash_run(command="sleep 1", timeout=99999)

    assert runtime.calls[-1]["timeout_seconds"] == 300


def test_bash_timeout_defaults_to_60_seconds(monkeypatch):
    tool = _load_tool(monkeypatch)
    runtime = FakeRuntime()
    monkeypatch.setattr(tool, "get_runtime", lambda: runtime)

    tool.bash_run(command="echo hi")

    assert runtime.calls[-1]["timeout_seconds"] == 60


def test_bash_destructive_warning_still_emitted(monkeypatch):
    tool = _load_tool(monkeypatch)
    runtime = FakeRuntime()
    monkeypatch.setattr(tool, "get_runtime", lambda: runtime)

    result = tool.bash_run(command="rm -rf /tmp/scratch")

    assert result.startswith("Warning:")


def test_bash_empty_command_returns_error(monkeypatch):
    tool = _load_tool(monkeypatch)

    assert tool.bash_run(command="") == "Error: No command provided."
    assert tool.bash_run(command="   ") == "Error: No command provided."

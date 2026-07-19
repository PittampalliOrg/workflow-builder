from __future__ import annotations

import importlib
import shlex
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

    grep_pkg = sys.modules.get("src.tools.grep_tool") or types.ModuleType(
        "src.tools.grep_tool"
    )
    grep_pkg.__path__ = [str(SRC_DIR / "tools" / "grep_tool")]
    sys.modules["src.tools.grep_tool"] = grep_pkg


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
        sys.modules.pop("src.tools.grep_tool.tool", None)
        return importlib.import_module("src.tools.grep_tool.tool")
    finally:
        for key in [k for k in sys.modules if k == "src" or k.startswith("src.")]:
            if key not in saved:
                del sys.modules[key]
        sys.modules.update(saved)


class FakeRuntime:
    def __init__(self, stdout: str = "hit.py:1:match\n", exit_code: int = 0) -> None:
        self.cwd = "/sandbox"
        self.stdout = stdout
        self.exit_code = exit_code
        self.commands: list[str] = []

    def resolve_path(self, path: str) -> str:
        if path.startswith("/"):
            return path
        return f"/sandbox/{path}"

    def stat_path(self, path: str) -> dict:
        return {"ok": True, "exists": True, "is_dir": True}

    def execute(self, command: str, timeout_seconds: int | None = None) -> dict:
        self.commands.append(command)
        return {"exit_code": self.exit_code, "stdout": self.stdout, "stderr": ""}


def _run(monkeypatch, runtime: FakeRuntime, **kwargs) -> tuple[str, list[str]]:
    tool = _load_tool(monkeypatch)
    monkeypatch.setattr(tool, "get_runtime", lambda: runtime)
    monkeypatch.setattr(tool, "expand_path", runtime.resolve_path)
    result = tool.grep_search(**kwargs)
    assert runtime.commands, "grep_search must shell out to rg via runtime.execute"
    return result, shlex.split(runtime.commands[0])


def test_wire_schema_shape(monkeypatch):
    tool = _load_tool(monkeypatch)

    schema = tool.GrepArgs.model_json_schema(by_alias=True)

    assert schema["additionalProperties"] is False
    assert set(schema["properties"]) == {
        "pattern",
        "path",
        "glob",
        "type",
        "output_mode",
        "-i",
        "-n",
        "-A",
        "-B",
        "-C",
        "head_limit",
        "offset",
        "multiline",
        "include_ignored",
    }
    assert schema["required"] == ["pattern"]
    for prop in schema["properties"].values():
        assert prop.get("description"), "every parameter needs a description"

    output_mode = schema["properties"]["output_mode"]
    assert output_mode["enum"] == ["content", "files_with_matches", "count_matches"]
    assert output_mode["default"] == "files_with_matches"
    assert schema["properties"]["-n"]["default"] is True
    assert schema["properties"]["-i"]["default"] is False
    assert schema["properties"]["head_limit"]["default"] == 250
    assert schema["properties"]["offset"]["default"] == 0
    assert schema["properties"]["multiline"]["default"] is False
    assert schema["properties"]["include_ignored"]["default"] is False


def test_wire_schema_aliases_and_validation(monkeypatch):
    tool = _load_tool(monkeypatch)

    args = tool.GrepArgs.model_validate(
        {"pattern": "foo", "-i": True, "-n": False, "-A": 1, "-B": 2, "-C": 3}
    )
    assert (args.i, args.n, args.A, args.B, args.C) == (True, False, 1, 2, 3)

    dumped = args.model_dump(by_alias=True)
    assert dumped["-i"] is True and dumped["-A"] == 1

    # populate_by_name: field names work too
    by_name = tool.GrepArgs(pattern="foo", i=True, C=5)
    assert by_name.i is True and by_name.C == 5

    with pytest.raises(ValidationError):
        tool.GrepArgs.model_validate({"pattern": "foo", "case_insensitive": True})

    with pytest.raises(ValidationError):
        tool.GrepArgs.model_validate({"pattern": "foo", "output_mode": "count"})


def test_default_invocation_is_files_with_matches(monkeypatch):
    _, args = _run(monkeypatch, FakeRuntime(), pattern="foo")

    assert args[0] == "rg"
    assert "--hidden" in args
    assert "-l" in args
    assert "-c" not in args
    assert "--no-ignore" not in args
    # VCS metadata directories are excluded by default
    assert "!.git" in args
    assert args[-1] == "/sandbox"


def test_count_matches_output_mode(monkeypatch):
    _, args = _run(monkeypatch, FakeRuntime(), pattern="foo", output_mode="count_matches")

    assert "-c" in args
    assert "-l" not in args


def test_content_mode_context_and_line_numbers(monkeypatch):
    _, args = _run(
        monkeypatch,
        FakeRuntime(),
        pattern="foo",
        output_mode="content",
        A=1,
        B=2,
        C=3,
    )
    # -C takes precedence over -A/-B; line numbers default on
    assert args[args.index("-C") + 1] == "3"
    assert "-A" not in args
    assert "-B" not in args
    assert "-n" in args
    assert "-l" not in args

    _, args = _run(
        monkeypatch,
        FakeRuntime(),
        pattern="foo",
        output_mode="content",
        A=1,
        B=2,
        n=False,
    )
    assert args[args.index("-A") + 1] == "1"
    assert args[args.index("-B") + 1] == "2"
    assert "-C" not in args
    assert "-n" not in args


def test_filters_and_flags(monkeypatch):
    _, args = _run(
        monkeypatch,
        FakeRuntime(),
        pattern="foo",
        i=True,
        type="py",
        glob="*.py",
        multiline=True,
        path="/workspace",
    )
    assert "-i" in args
    assert args[args.index("--type") + 1] == "py"
    # the include glob lands after the built-in VCS directory exclusions
    assert args[args.index("*.py") - 1] == "--glob"
    assert "-U" in args and "--multiline-dotall" in args
    assert args[-1] == "/workspace"


def test_include_ignored_drops_vcs_exclusions(monkeypatch):
    _, args = _run(monkeypatch, FakeRuntime(), pattern="foo", include_ignored=True)

    assert "--no-ignore" in args
    assert "!.git" not in args
    assert "--hidden" in args
    assert "-l" in args


def test_head_limit_truncation_and_unlimited(monkeypatch):
    many = "".join(f"file.py:{i}:match\n" for i in range(1, 301))

    result, _ = _run(monkeypatch, FakeRuntime(stdout=many), pattern="foo")
    assert "file.py:250:match" in result
    assert "file.py:251:match" not in result
    assert "truncated at 250" in result

    result, _ = _run(
        monkeypatch, FakeRuntime(stdout=many), pattern="foo", head_limit=0
    )
    assert "file.py:300:match" in result
    assert "truncated" not in result


def test_offset_pages_results(monkeypatch):
    many = "".join(f"file.py:{i}:match\n" for i in range(1, 21))

    result, _ = _run(
        monkeypatch,
        FakeRuntime(stdout=many),
        pattern="foo",
        output_mode="content",
        offset=10,
        head_limit=3,
    )
    lines = result.split("\n")
    assert lines[0] == "file.py:11:match"
    assert "file.py:13:match" in result
    assert "file.py:14:match" not in result


def test_missing_path_returns_error(monkeypatch):
    tool = _load_tool(monkeypatch)
    runtime = FakeRuntime()
    monkeypatch.setattr(tool, "get_runtime", lambda: runtime)
    monkeypatch.setattr(tool, "expand_path", runtime.resolve_path)
    monkeypatch.setattr(
        runtime, "stat_path", lambda path: {"ok": False, "exists": False, "is_dir": False}
    )

    result = tool.grep_search(pattern="foo", path="/nope")

    assert result == "Error: Path not found: /nope"
    assert runtime.commands == []


def test_description_uses_registered_tool_names(monkeypatch):
    tool = _load_tool(monkeypatch)

    doc = tool.grep_search.__doc__
    assert "grep_search" not in doc
    assert "ALWAYS use the Grep tool" in doc
    assert "count_matches" in doc
    assert "include_ignored" in doc

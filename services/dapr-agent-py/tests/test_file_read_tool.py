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

    file_read_pkg = sys.modules.get("src.tools.file_read") or types.ModuleType(
        "src.tools.file_read"
    )
    file_read_pkg.__path__ = [str(SRC_DIR / "tools" / "file_read")]
    sys.modules["src.tools.file_read"] = file_read_pkg


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
        sys.modules.pop("src.tools.file_read.tool", None)
        return importlib.import_module("src.tools.file_read.tool")
    finally:
        for key in [k for k in sys.modules if k == "src" or k.startswith("src.")]:
            if key not in saved:
                del sys.modules[key]
        sys.modules.update(saved)


class FakeRuntime:
    """Mirror of the sandbox backend's read_file_lines contract: `offset` is a
    0-based skip count, `limit` caps returned lines, totals always count the
    whole file."""

    def __init__(self, files: dict[str, str], dirs: set[str] | None = None) -> None:
        self.files = files
        self.dirs = dirs or set()

    def resolve_path(self, path: str) -> str:
        if path.startswith("/"):
            return path
        return f"/sandbox/{path}"

    def stat_path(self, path: str) -> dict:
        return {
            "ok": True,
            "exists": path in self.files or path in self.dirs,
            "is_dir": path in self.dirs,
            "size": len(self.files.get(path, "")),
        }

    def read_file_lines(self, path: str, offset: int, limit: int) -> dict:
        lines_out: list[str] = []
        total = 0
        start_line = 0
        end_line = 0
        for line_no, line_text in enumerate(self.files[path].splitlines(), start=1):
            total = line_no
            if line_no <= offset:
                continue
            if len(lines_out) >= limit:
                continue
            if not lines_out:
                start_line = line_no
            end_line = line_no
            lines_out.append(line_text)
        return {
            "ok": True,
            "lines": lines_out,
            "total_lines": total,
            "start_line": start_line,
            "end_line": end_line,
        }


FIVE_LINES = "alpha\nbravo\ncharlie\ndelta\necho\n"


def _patch_runtime(monkeypatch, tool, runtime: FakeRuntime) -> None:
    monkeypatch.setattr(tool, "get_runtime", lambda: runtime)
    monkeypatch.setattr(tool, "expand_path", runtime.resolve_path)


def _read_lines(result: str) -> list[str]:
    """Strip the trailing meta line; return the numbered content lines."""
    return result.splitlines()[:-1]


def test_read_default_reads_from_line_one(monkeypatch):
    tool = _load_tool(monkeypatch)
    _patch_runtime(monkeypatch, tool, FakeRuntime({"/sandbox/f.txt": FIVE_LINES}))

    result = tool.file_read(path="f.txt")

    assert _read_lines(result) == [
        "     1\talpha",
        "     2\tbravo",
        "     3\tcharlie",
        "     4\tdelta",
        "     5\techo",
    ]
    assert result.endswith("(Read 5 lines, lines 1-5 of 5 total)")


def test_read_line_offset_is_one_based(monkeypatch):
    tool = _load_tool(monkeypatch)
    _patch_runtime(monkeypatch, tool, FakeRuntime({"/sandbox/f.txt": FIVE_LINES}))

    result = tool.file_read(path="f.txt", line_offset=3, n_lines=2)

    assert _read_lines(result) == ["     3\tcharlie", "     4\tdelta"]
    assert result.endswith("(Read 2 lines, lines 3-4 of 5 total)")


def test_read_negative_line_offset_reads_tail(monkeypatch):
    tool = _load_tool(monkeypatch)
    _patch_runtime(monkeypatch, tool, FakeRuntime({"/sandbox/f.txt": FIVE_LINES}))

    result = tool.file_read(path="f.txt", line_offset=-2)

    assert _read_lines(result) == ["     4\tdelta", "     5\techo"]
    assert result.endswith("(Read 2 lines, lines 4-5 of 5 total)")


def test_read_negative_tail_larger_than_file_reads_everything(monkeypatch):
    tool = _load_tool(monkeypatch)
    _patch_runtime(monkeypatch, tool, FakeRuntime({"/sandbox/f.txt": FIVE_LINES}))

    result = tool.file_read(path="f.txt", line_offset=-100)

    assert _read_lines(result) == [
        "     1\talpha",
        "     2\tbravo",
        "     3\tcharlie",
        "     4\tdelta",
        "     5\techo",
    ]
    assert result.endswith("(Read 5 lines, lines 1-5 of 5 total)")


def test_read_n_lines_caps_output(monkeypatch):
    tool = _load_tool(monkeypatch)
    _patch_runtime(monkeypatch, tool, FakeRuntime({"/sandbox/f.txt": FIVE_LINES}))

    result = tool.file_read(path="f.txt", n_lines=2)

    assert _read_lines(result) == ["     1\talpha", "     2\tbravo"]
    assert result.endswith("(Read 2 lines, lines 1-2 of 5 total)")


def test_read_beyond_eof_reports_no_lines(monkeypatch):
    tool = _load_tool(monkeypatch)
    _patch_runtime(monkeypatch, tool, FakeRuntime({"/sandbox/f.txt": FIVE_LINES}))

    result = tool.file_read(path="f.txt", line_offset=10)

    assert "No lines in range" in result
    assert "line_offset=10" in result


def test_read_directory_error_mentions_registered_tool_names(monkeypatch):
    tool = _load_tool(monkeypatch)
    _patch_runtime(monkeypatch, tool, FakeRuntime({}, dirs={"/sandbox/dir"}))

    result = tool.file_read(path="dir")

    assert "is a directory" in result
    assert "Bash" in result and "Glob" in result
    assert "bash_run" not in result and "glob_search" not in result


def test_read_signature_uses_wire_field_names(monkeypatch):
    tool = _load_tool(monkeypatch)

    assert list(inspect.signature(tool.file_read).parameters) == [
        "path",
        "line_offset",
        "n_lines",
    ]


def test_read_args_wire_schema(monkeypatch):
    tool = _load_tool(monkeypatch)

    schema = tool.ReadArgs.model_json_schema()

    assert schema["additionalProperties"] is False
    assert set(schema["properties"]) == {"path", "line_offset", "n_lines"}
    assert schema["required"] == ["path"]
    assert schema["properties"]["line_offset"]["default"] == 1
    assert schema["properties"]["n_lines"]["default"] == 1000
    for prop in schema["properties"].values():
        assert prop.get("description")


def test_read_description_uses_registered_tool_names(monkeypatch):
    tool = _load_tool(monkeypatch)

    doc = tool.file_read.__doc__ or ""

    for internal_name in ("bash_run", "glob_search", "grep_search", "file_read"):
        assert internal_name not in doc
    assert "Bash" in doc and "Glob" in doc and "Grep" in doc

from __future__ import annotations

import difflib
import json
import os
import shutil
import subprocess
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

try:
    from dapr_agents.tool import tool
except ImportError:  # pragma: no cover
    def tool(*_args, **_kwargs):
        def decorator(fn):
            return fn

        return decorator


DEFAULT_WORKSPACE_ROOT = os.environ.get("WORKSPACE_ROOT", "/workspace")
MAX_FILE_SIZE_BYTES = int(os.environ.get("DAPR_AGENT_MAX_FILE_SIZE_BYTES", "262144"))
MAX_GREP_RESULTS = int(os.environ.get("DAPR_AGENT_MAX_GREP_RESULTS", "200"))
MAX_LIST_FILES = int(os.environ.get("DAPR_AGENT_MAX_LIST_FILES", "500"))


def _as_relative(path: Path, root: Path) -> str:
    return str(path.relative_to(root))


def _ensure_text_size(path: Path) -> None:
    if path.stat().st_size > MAX_FILE_SIZE_BYTES:
        raise ValueError(
            f"File {path.name} exceeds the read limit of {MAX_FILE_SIZE_BYTES} bytes"
        )


@dataclass
class ToolRuntimeContext:
    workspace_root: Path
    files_read: set[str] = field(default_factory=set)
    files_listed: set[str] = field(default_factory=set)
    files_matched: set[str] = field(default_factory=set)
    files_modified: set[str] = field(default_factory=set)
    _original_files: dict[str, str | None] = field(default_factory=dict)

    @classmethod
    def from_workspace_root(
        cls, workspace_root: str | os.PathLike[str]
    ) -> "ToolRuntimeContext":
        root = Path(workspace_root).expanduser().resolve()
        root.mkdir(parents=True, exist_ok=True)
        return cls(workspace_root=root)

    def resolve_path(self, raw_path: str | None) -> Path:
        candidate = (self.workspace_root / (raw_path or ".")).resolve()
        if candidate != self.workspace_root and self.workspace_root not in candidate.parents:
            raise ValueError(f"Path escapes workspace root: {raw_path}")
        return candidate

    def record_read(self, path: Path) -> None:
        self.files_read.add(_as_relative(path, self.workspace_root))

    def record_listed(self, path: Path) -> None:
        self.files_listed.add(_as_relative(path, self.workspace_root))

    def record_match(self, path: Path) -> None:
        self.files_matched.add(_as_relative(path, self.workspace_root))

    def record_modified(self, path: Path) -> None:
        relative = _as_relative(path, self.workspace_root)
        if relative not in self._original_files:
            if path.exists():
                _ensure_text_size(path)
                self._original_files[relative] = path.read_text(encoding="utf-8")
            else:
                self._original_files[relative] = None
        self.files_modified.add(relative)

    def build_summary(self) -> dict[str, Any]:
        files_analyzed = sorted(self.files_read | self.files_matched | self.files_listed)
        fixes_applied = sorted(self.files_modified)
        patch_chunks: list[str] = []
        for relative in fixes_applied:
            current_path = self.resolve_path(relative)
            before = self._original_files.get(relative)
            after = current_path.read_text(encoding="utf-8") if current_path.exists() else ""
            before_lines = [] if before is None else before.splitlines(keepends=True)
            after_lines = after.splitlines(keepends=True)
            diff = "".join(
                difflib.unified_diff(
                    before_lines,
                    after_lines,
                    fromfile=f"a/{relative}",
                    tofile=f"b/{relative}",
                )
            ).strip()
            if diff:
                patch_chunks.append(diff)
        return {
            "filesAnalyzed": files_analyzed,
            "fileChanges": fixes_applied,
            "patch": "\n".join(patch_chunks).strip(),
        }


def _extract_context(kwargs: dict[str, Any]) -> ToolRuntimeContext:
    context = kwargs.get("tool_context")
    if isinstance(context, ToolRuntimeContext):
        return context
    workspace_root = kwargs.get("workspace_root") or DEFAULT_WORKSPACE_ROOT
    return ToolRuntimeContext.from_workspace_root(str(workspace_root))


@tool
def read_file(path: str, **kwargs) -> str:
    """Read a UTF-8 text file from the workspace."""
    context = _extract_context(kwargs)
    resolved = context.resolve_path(path)
    if not resolved.is_file():
        raise FileNotFoundError(f"File not found: {path}")
    _ensure_text_size(resolved)
    context.record_read(resolved)
    return resolved.read_text(encoding="utf-8")


@tool
def list_files(path: str = ".", pattern: str = "**/*", **kwargs) -> list[str]:
    """List files in a workspace directory using a glob pattern."""
    context = _extract_context(kwargs)
    resolved = context.resolve_path(path)
    if not resolved.exists():
        raise FileNotFoundError(f"Path not found: {path}")
    matches: list[str] = []
    for candidate in resolved.glob(pattern):
        if len(matches) >= MAX_LIST_FILES:
            break
        if not candidate.is_file():
            continue
        relative = _as_relative(candidate, context.workspace_root)
        context.record_listed(candidate)
        matches.append(relative)
    return matches


@tool
def grep_search(pattern: str, path: str = ".", **kwargs) -> list[dict[str, Any]]:
    """Search UTF-8 text files in the workspace for a substring."""
    context = _extract_context(kwargs)
    resolved = context.resolve_path(path)
    if not resolved.exists():
        raise FileNotFoundError(f"Path not found: {path}")
    search_roots = [resolved] if resolved.is_file() else [p for p in resolved.rglob("*") if p.is_file()]
    matches: list[dict[str, Any]] = []
    for candidate in search_roots:
        if len(matches) >= MAX_GREP_RESULTS:
            break
        try:
            _ensure_text_size(candidate)
            lines = candidate.read_text(encoding="utf-8").splitlines()
        except (UnicodeDecodeError, OSError, ValueError):
            continue
        for index, line in enumerate(lines, start=1):
            if pattern in line:
                context.record_match(candidate)
                matches.append(
                    {
                        "path": _as_relative(candidate, context.workspace_root),
                        "lineNumber": index,
                        "line": line,
                    }
                )
                if len(matches) >= MAX_GREP_RESULTS:
                    break
    return matches


@tool
def write_file(path: str, content: str, **kwargs) -> dict[str, Any]:
    """Write a UTF-8 text file in the workspace."""
    context = _extract_context(kwargs)
    resolved = context.resolve_path(path)
    context.record_modified(resolved)
    resolved.parent.mkdir(parents=True, exist_ok=True)
    resolved.write_text(content, encoding="utf-8")
    return {"path": _as_relative(resolved, context.workspace_root)}


@tool
def edit_file(path: str, old_string: str, new_string: str, **kwargs) -> dict[str, Any]:
    """Replace text in a UTF-8 text file in the workspace."""
    context = _extract_context(kwargs)
    resolved = context.resolve_path(path)
    if not resolved.is_file():
        raise FileNotFoundError(f"File not found: {path}")
    _ensure_text_size(resolved)
    original = resolved.read_text(encoding="utf-8")
    if old_string not in original:
        raise ValueError(f"Target string not found in {path}")
    context.record_modified(resolved)
    updated = original.replace(old_string, new_string, 1)
    resolved.write_text(updated, encoding="utf-8")
    return {"path": _as_relative(resolved, context.workspace_root), "replacements": 1}


@tool
def delete_path(path: str, **kwargs) -> dict[str, Any]:
    """Delete a file or directory in the workspace."""
    context = _extract_context(kwargs)
    resolved = context.resolve_path(path)
    if not resolved.exists():
        raise FileNotFoundError(f"Path not found: {path}")
    context.record_modified(resolved)
    if resolved.is_dir():
        shutil.rmtree(resolved)
    else:
        resolved.unlink()
    return {"path": path}


@tool
def mkdir(path: str, **kwargs) -> dict[str, Any]:
    """Create a directory in the workspace."""
    context = _extract_context(kwargs)
    resolved = context.resolve_path(path)
    resolved.mkdir(parents=True, exist_ok=True)
    return {"path": _as_relative(resolved, context.workspace_root)}


@tool
def file_stat(path: str, **kwargs) -> dict[str, Any]:
    """Return metadata for a workspace file or directory."""
    context = _extract_context(kwargs)
    resolved = context.resolve_path(path)
    if not resolved.exists():
        raise FileNotFoundError(f"Path not found: {path}")
    context.record_read(resolved)
    return {
        "path": _as_relative(resolved, context.workspace_root),
        "exists": True,
        "isFile": resolved.is_file(),
        "isDirectory": resolved.is_dir(),
        "size": resolved.stat().st_size,
    }


def _run_git(args: list[str], *, cwd: Path) -> str:
    completed = subprocess.run(
        ["git", *args],
        cwd=cwd,
        text=True,
        capture_output=True,
        timeout=120,
        check=False,
    )
    if completed.returncode != 0:
        raise RuntimeError((completed.stderr or completed.stdout).strip() or "git command failed")
    return completed.stdout.strip()


@tool
def git_status(path: str = ".", **kwargs) -> dict[str, Any]:
    """Get git status in the workspace."""
    context = _extract_context(kwargs)
    cwd = context.resolve_path(path)
    stdout = _run_git(["status", "--short", "--branch"], cwd=cwd)
    return {"path": path, "status": stdout}


@tool
def git_diff(path: str = ".", **kwargs) -> dict[str, Any]:
    """Get git diff in the workspace."""
    context = _extract_context(kwargs)
    cwd = context.resolve_path(path)
    stdout = _run_git(["diff", "--no-ext-diff"], cwd=cwd)
    return {"path": path, "diff": stdout}


@tool
def git_apply(patch: str, path: str = ".", **kwargs) -> dict[str, Any]:
    """Apply a unified diff patch in the workspace."""
    context = _extract_context(kwargs)
    cwd = context.resolve_path(path)
    completed = subprocess.run(
        ["git", "apply", "--whitespace=nowarn", "-"],
        cwd=cwd,
        input=patch,
        text=True,
        capture_output=True,
        timeout=120,
        check=False,
    )
    if completed.returncode != 0:
        raise RuntimeError((completed.stderr or completed.stdout).strip() or "git apply failed")
    return {"path": path, "applied": True}


@tool
def execute_command(command: str, cwd: str = ".", **kwargs) -> dict[str, Any]:
    """Run a shell command inside the workspace."""
    context = _extract_context(kwargs)
    working_directory = context.resolve_path(cwd)
    completed = subprocess.run(
        command,
        cwd=working_directory,
        shell=True,
        text=True,
        capture_output=True,
        timeout=120,
        check=False,
    )
    return {
        "cwd": _as_relative(working_directory, context.workspace_root)
        if working_directory != context.workspace_root
        else ".",
        "exitCode": completed.returncode,
        "stdout": completed.stdout[-12000:],
        "stderr": completed.stderr[-12000:],
    }


TOOL_GROUPS = {
    "read_only": [read_file, list_files, grep_search, file_stat, git_status, git_diff],
    "read_write": [
        read_file,
        list_files,
        grep_search,
        file_stat,
        write_file,
        edit_file,
        delete_path,
        mkdir,
        git_status,
        git_diff,
        git_apply,
    ],
    "all": [
        read_file,
        list_files,
        grep_search,
        file_stat,
        write_file,
        edit_file,
        delete_path,
        mkdir,
        git_status,
        git_diff,
        git_apply,
        execute_command,
    ],
}


WORKSPACE_ENABLED_TOOLS = [
    {"label": "Read", "value": "read"},
    {"label": "Write", "value": "write"},
    {"label": "Edit", "value": "edit"},
    {"label": "List", "value": "list"},
    {"label": "Delete", "value": "delete"},
    {"label": "Git", "value": "git"},
    {"label": "Bash", "value": "bash"},
]


def resolve_tool_group(name: str | None) -> list[Any]:
    if not name:
        return []
    return TOOL_GROUPS.get(str(name).strip().lower(), [])


def bind_tool_group(
    name: str | None,
    workspace_root: str | os.PathLike[str],
) -> list[Any]:
    root = str(Path(workspace_root).expanduser().resolve())
    bound_tools: list[Any] = []
    for tool_fn in resolve_tool_group(name):
        tool_name = getattr(tool_fn, "__name__", "tool")
        tool_description = getattr(tool_fn, "__doc__", None) or f"Run {tool_name}"

        def bound_tool(*args: Any, _tool_fn=tool_fn, **kwargs: Any) -> Any:
            return _tool_fn(*args, workspace_root=root, **kwargs)

        bound_tool.__name__ = tool_name
        bound_tool.__doc__ = tool_description
        bound_tools.append(tool(bound_tool))
    return bound_tools


def summarize_command_changes(workspace_root: str | os.PathLike[str]) -> dict[str, Any]:
    root = Path(workspace_root).expanduser().resolve()
    if not root.exists():
        return {"changeSummary": {"files": [], "stats": {"files": 0, "additions": 0, "deletions": 0}, "changed": False}}
    try:
        diff = _run_git(["diff", "--numstat"], cwd=root)
    except Exception:
        diff = ""
    files: list[dict[str, Any]] = []
    additions = 0
    deletions = 0
    for line in diff.splitlines():
        parts = line.split("\t")
        if len(parts) != 3:
            continue
        add_raw, del_raw, path = parts
        try:
            add_count = int(add_raw)
        except ValueError:
            add_count = 0
        try:
            del_count = int(del_raw)
        except ValueError:
            del_count = 0
        additions += add_count
        deletions += del_count
        files.append({"path": path, "additions": add_count, "deletions": del_count})
    return {
        "changeSummary": {
            "files": files,
            "stats": {"files": len(files), "additions": additions, "deletions": deletions},
            "changed": bool(files),
        }
    }


def dumps_json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=True)

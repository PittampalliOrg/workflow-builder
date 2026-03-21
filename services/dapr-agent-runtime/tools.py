from __future__ import annotations

import difflib
import json
import os
import shutil
import subprocess
from contextvars import ContextVar, Token
from dataclasses import dataclass, field
from pathlib import Path, PurePosixPath
from typing import Any

try:
    from dapr_agents.tool import tool
    from dapr_agents.tool.base import AgentTool
except ImportError:  # pragma: no cover
    class AgentTool:  # type: ignore[no-redef]
        def __init__(self, **kwargs) -> None:
            self.name = kwargs.get("name")
            self.description = kwargs.get("description")
            self.func = kwargs.get("func")
            self.args_model = kwargs.get("args_model")

    def tool(fn=None, *_args, **_kwargs):
        if callable(fn):
            return fn

        def decorator(fn):
            return fn

        return decorator


DEFAULT_WORKSPACE_ROOT = os.environ.get("WORKSPACE_ROOT", "/workspace")
MAX_FILE_SIZE_BYTES = int(os.environ.get("DAPR_AGENT_MAX_FILE_SIZE_BYTES", "262144"))
MAX_GREP_RESULTS = int(os.environ.get("DAPR_AGENT_MAX_GREP_RESULTS", "200"))
MAX_LIST_FILES = int(os.environ.get("DAPR_AGENT_MAX_LIST_FILES", "500"))
ACTIVE_TOOL_CONTEXT: ContextVar["ToolRuntimeContext | None"] = ContextVar(
    "active_tool_context",
    default=None,
)


def _as_relative(path: Path, root: Path) -> str:
    return str(path.relative_to(root))


def _ensure_text_size(path: Path) -> None:
    if path.stat().st_size > MAX_FILE_SIZE_BYTES:
        raise ValueError(
            f"File {path.name} exceeds the read limit of {MAX_FILE_SIZE_BYTES} bytes"
        )


def _normalize_workspace_path(raw_path: str | None) -> str:
    value = str(raw_path or ".").strip()
    if not value or value == "/":
        return "."
    if value.startswith("/"):
        normalized = value.lstrip("/")
        return normalized or "."
    return value


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
        raw_value = str(raw_path or ".").strip()
        if not raw_value or raw_value == "/":
            candidate = self.workspace_root
        else:
            supplied_path = Path(raw_value).expanduser()
            if supplied_path.is_absolute():
                candidate = supplied_path.resolve()
            else:
                candidate = (
                    self.workspace_root / _normalize_workspace_path(raw_value)
                ).resolve()
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
        summary_files: list[dict[str, Any]] = []
        additions = 0
        deletions = 0
        for relative in fixes_applied:
            current_path = self.resolve_path(relative)
            before = self._original_files.get(relative)
            after = current_path.read_text(encoding="utf-8") if current_path.exists() else ""
            before_lines = [] if before is None else before.splitlines(keepends=True)
            after_lines = after.splitlines(keepends=True)
            status = "deleted" if not current_path.exists() else "untracked" if before is None else "modified"
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
            add_count = 0
            del_count = 0
            for line in diff.splitlines():
                if line.startswith("+++") or line.startswith("---"):
                    continue
                if line.startswith("+"):
                    add_count += 1
                elif line.startswith("-"):
                    del_count += 1
            additions += add_count
            deletions += del_count
            summary_files.append(
                {
                    "path": relative,
                    "additions": add_count,
                    "deletions": del_count,
                    "status": status,
                }
            )
        return {
            "filesAnalyzed": files_analyzed,
            "fileChanges": fixes_applied,
            "changeSummary": {
                "files": summary_files,
                "stats": {
                    "files": len(summary_files),
                    "additions": additions,
                    "deletions": deletions,
                },
                "changed": bool(summary_files),
            },
            "patch": "\n".join(patch_chunks).strip(),
        }


def push_tool_context(context: ToolRuntimeContext) -> Token[ToolRuntimeContext | None]:
    return ACTIVE_TOOL_CONTEXT.set(context)


def pop_tool_context(token: Token[ToolRuntimeContext | None]) -> None:
    ACTIVE_TOOL_CONTEXT.reset(token)


def _extract_context() -> ToolRuntimeContext:
    context = ACTIVE_TOOL_CONTEXT.get()
    if isinstance(context, ToolRuntimeContext):
        return context
    return ToolRuntimeContext.from_workspace_root(str(DEFAULT_WORKSPACE_ROOT))


def _resolve_tool_invocation(
    args_payload: Any | None,
    kwargs: dict[str, Any],
) -> dict[str, Any]:
    if isinstance(args_payload, dict):
        return {**args_payload, **kwargs}
    return dict(kwargs)


@tool
def read_file(path: str, args: dict[str, Any] | None = None, **kwargs: Any) -> str:
    """Read a UTF-8 text file from the workspace."""
    resolved_kwargs = _resolve_tool_invocation(args, kwargs)
    path = str(resolved_kwargs.get("path", path))
    context = _extract_context()
    resolved = context.resolve_path(path)
    if not resolved.is_file():
        raise FileNotFoundError(f"File not found: {path}")
    _ensure_text_size(resolved)
    context.record_read(resolved)
    return resolved.read_text(encoding="utf-8")


@tool
def list_files(
    path: str = ".",
    pattern: str = "**/*",
    args: dict[str, Any] | None = None,
    **kwargs: Any,
) -> list[str]:
    """List files in a workspace directory using a glob pattern."""
    resolved_kwargs = _resolve_tool_invocation(args, kwargs)
    path = str(resolved_kwargs.get("path", path))
    pattern = str(resolved_kwargs.get("pattern", pattern))
    context = _extract_context()
    resolved = context.resolve_path(path)
    if not resolved.exists():
        return []
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
def grep_search(
    pattern: str,
    path: str = ".",
    args: dict[str, Any] | None = None,
    **kwargs: Any,
) -> list[dict[str, Any]]:
    """Search UTF-8 text files in the workspace for a substring."""
    resolved_kwargs = _resolve_tool_invocation(args, kwargs)
    pattern = str(resolved_kwargs.get("pattern", pattern))
    path = str(resolved_kwargs.get("path", path))
    context = _extract_context()
    resolved = context.resolve_path(path)
    if not resolved.exists():
        return []
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
def write_file(
    path: str,
    content: str,
    args: dict[str, Any] | None = None,
    **kwargs: Any,
) -> dict[str, Any]:
    """Write a UTF-8 text file in the workspace."""
    resolved_kwargs = _resolve_tool_invocation(args, kwargs)
    path = str(resolved_kwargs.get("path", path))
    content = str(resolved_kwargs.get("content", content))
    context = _extract_context()
    resolved = context.resolve_path(path)
    context.record_modified(resolved)
    resolved.parent.mkdir(parents=True, exist_ok=True)
    resolved.write_text(content, encoding="utf-8")
    return {"path": _as_relative(resolved, context.workspace_root)}


@tool
def edit_file(
    path: str,
    old_string: str,
    new_string: str,
    args: dict[str, Any] | None = None,
    **kwargs: Any,
) -> dict[str, Any]:
    """Replace text in a UTF-8 text file in the workspace."""
    resolved_kwargs = _resolve_tool_invocation(args, kwargs)
    path = str(resolved_kwargs.get("path", path))
    old_string = str(resolved_kwargs.get("old_string", old_string))
    new_string = str(resolved_kwargs.get("new_string", new_string))
    context = _extract_context()
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
def delete_path(
    path: str,
    args: dict[str, Any] | None = None,
    **kwargs: Any,
) -> dict[str, Any]:
    """Delete a file or directory in the workspace."""
    resolved_kwargs = _resolve_tool_invocation(args, kwargs)
    path = str(resolved_kwargs.get("path", path))
    context = _extract_context()
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
def mkdir(
    path: str,
    args: dict[str, Any] | None = None,
    **kwargs: Any,
) -> dict[str, Any]:
    """Create a directory in the workspace."""
    resolved_kwargs = _resolve_tool_invocation(args, kwargs)
    path = str(resolved_kwargs.get("path", path))
    context = _extract_context()
    resolved = context.resolve_path(path)
    resolved.mkdir(parents=True, exist_ok=True)
    return {"path": _as_relative(resolved, context.workspace_root)}


@tool
def file_stat(
    path: str,
    args: dict[str, Any] | None = None,
    **kwargs: Any,
) -> dict[str, Any]:
    """Return metadata for a workspace file or directory."""
    resolved_kwargs = _resolve_tool_invocation(args, kwargs)
    path = str(resolved_kwargs.get("path", path))
    context = _extract_context()
    resolved = context.resolve_path(path)
    if not resolved.exists():
        return {
            "path": path,
            "exists": False,
            "isFile": False,
            "isDirectory": False,
            "size": 0,
        }
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


def _run_git_completed(args: list[str], *, cwd: Path) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ["git", *args],
        cwd=cwd,
        text=True,
        capture_output=True,
        timeout=120,
        check=False,
    )


def _should_include_untracked_path(relative_path: str) -> bool:
    path = PurePosixPath(relative_path)
    excluded_suffixes = {".pyc", ".pyo"}
    excluded_parts = {"__pycache__", ".pytest_cache", ".mypy_cache", ".ruff_cache"}
    if any(part in excluded_parts for part in path.parts):
        return False
    if path.suffix.lower() in excluded_suffixes:
        return False
    return True


def _untracked_files(cwd: Path) -> list[str]:
    completed = _run_git_completed(
        ["status", "--porcelain", "--untracked-files=all"],
        cwd=cwd,
    )
    if completed.returncode != 0:
        return []
    files: list[str] = []
    for line in completed.stdout.splitlines():
        if line.startswith("?? "):
            path = line[3:].strip()
            if path and _should_include_untracked_path(path):
                files.append(path)
    return files


def _untracked_file_numstat(cwd: Path, relative_path: str) -> dict[str, int] | None:
    path = (cwd / relative_path).resolve()
    if not path.exists() or not path.is_file():
        return None
    try:
        content = path.read_text(encoding="utf-8")
    except UnicodeDecodeError:
        return None
    additions = len(content.splitlines())
    return {"additions": additions, "deletions": 0}


def _untracked_file_patch(cwd: Path, relative_path: str) -> str:
    completed = subprocess.run(
        ["git", "diff", "--no-index", "--", "/dev/null", relative_path],
        cwd=cwd,
        text=True,
        capture_output=True,
        timeout=120,
        check=False,
    )
    if completed.returncode not in (0, 1):
        return ""
    return completed.stdout.strip()


def build_workspace_patch(workspace_root: str | os.PathLike[str]) -> str:
    root = Path(workspace_root).expanduser().resolve()
    if not root.exists():
        return ""
    patch_chunks: list[str] = []
    try:
        tracked_patch = _run_git(["diff", "--no-ext-diff"], cwd=root)
    except Exception:
        tracked_patch = ""
    if tracked_patch:
        patch_chunks.append(tracked_patch)
    for relative_path in _untracked_files(root):
        patch = _untracked_file_patch(root, relative_path)
        if patch:
            patch_chunks.append(patch)
    return "\n".join(chunk for chunk in patch_chunks if chunk).strip()


@tool
def git_status(
    path: str = ".",
    args: dict[str, Any] | None = None,
    **kwargs: Any,
) -> dict[str, Any]:
    """Get git status in the workspace."""
    resolved_kwargs = _resolve_tool_invocation(args, kwargs)
    path = str(resolved_kwargs.get("path", path))
    context = _extract_context()
    cwd = context.resolve_path(path)
    stdout = _run_git(["status", "--short", "--branch"], cwd=cwd)
    return {"path": path, "status": stdout}


@tool
def git_diff(
    path: str = ".",
    args: dict[str, Any] | None = None,
    **kwargs: Any,
) -> dict[str, Any]:
    """Get git diff in the workspace."""
    resolved_kwargs = _resolve_tool_invocation(args, kwargs)
    path = str(resolved_kwargs.get("path", path))
    context = _extract_context()
    cwd = context.resolve_path(path)
    stdout = build_workspace_patch(cwd)
    return {"path": path, "diff": stdout}


@tool
def git_apply(
    patch: str,
    path: str = ".",
    args: dict[str, Any] | None = None,
    **kwargs: Any,
) -> dict[str, Any]:
    """Apply a unified diff patch in the workspace."""
    resolved_kwargs = _resolve_tool_invocation(args, kwargs)
    patch = str(resolved_kwargs.get("patch", patch))
    path = str(resolved_kwargs.get("path", path))
    context = _extract_context()
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
def execute_command(
    command: str,
    cwd: str = ".",
    args: dict[str, Any] | None = None,
    **kwargs: Any,
) -> dict[str, Any]:
    """Run a shell command inside the workspace."""
    resolved_kwargs = _resolve_tool_invocation(args, kwargs)
    command = str(resolved_kwargs.get("command", command))
    cwd = str(resolved_kwargs.get("cwd", cwd))
    context = _extract_context()
    working_directory = context.resolve_path(cwd)
    shell_command = command
    if "pnpm" in command and shutil.which("pnpm") is None:
        pnpm_fallback = None
        if shutil.which("corepack"):
            pnpm_fallback = 'pnpm() { corepack pnpm "$@"; }'
        elif shutil.which("npx"):
            pnpm_fallback = 'pnpm() { npx pnpm "$@"; }'
        if pnpm_fallback:
            shell_command = "\n".join([pnpm_fallback, command])
    try:
        completed = subprocess.run(
            shell_command,
            cwd=working_directory,
            shell=True,
            text=True,
            capture_output=True,
            timeout=COMMAND_TIMEOUT_SECONDS,
            check=False,
        )
    except subprocess.TimeoutExpired as exc:
        return {
            "cwd": _as_relative(working_directory, context.workspace_root)
            if working_directory != context.workspace_root
            else ".",
            "exitCode": 124,
            "stdout": str(exc.stdout or "")[-12000:],
            "stderr": (
                (str(exc.stderr or "") + f"\nCommand timed out after {COMMAND_TIMEOUT_SECONDS} seconds")
            )[-12000:],
            "timedOut": True,
        }
    return {
        "cwd": _as_relative(working_directory, context.workspace_root)
        if working_directory != context.workspace_root
        else ".",
        "exitCode": completed.returncode,
        "stdout": completed.stdout[-12000:],
        "stderr": completed.stderr[-12000:],
        "timedOut": False,
    }


TOOL_GROUPS = {
    "read_only": [read_file, list_files, grep_search, file_stat, git_status, git_diff],
    "planning": [
        read_file,
        list_files,
        grep_search,
        file_stat,
        git_status,
        git_diff,
        execute_command,
    ],
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
    root = Path(workspace_root).expanduser().resolve()
    bound_tools: list[Any] = []

    def make_bound_tool(tool_fn: Any) -> Any:
        tool_name = getattr(tool_fn, "name", None) or getattr(tool_fn, "__name__", "tool")
        tool_description = getattr(tool_fn, "description", None) or getattr(tool_fn, "__doc__", None) or f"Run {tool_name}"
        tool_args_model = getattr(tool_fn, "args_model", None)
        tool_callable = getattr(tool_fn, "func", None) or tool_fn

        def bound_tool(*args: Any, **kwargs: Any) -> Any:
            context = ToolRuntimeContext.from_workspace_root(root)
            token = push_tool_context(context)
            try:
                return tool_callable(*args, **kwargs)
            finally:
                pop_tool_context(token)

        bound_tool.__name__ = tool_name
        bound_tool.__doc__ = tool_description
        return AgentTool(
            name=tool_name,
            description=tool_description,
            func=bound_tool,
            args_model=tool_args_model,
        )

    for tool_fn in resolve_tool_group(name):
        bound_tools.append(make_bound_tool(tool_fn))
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
    seen_paths = {str(file_entry.get("path") or "").strip() for file_entry in files}
    for relative_path in _untracked_files(root):
        if relative_path in seen_paths:
            continue
        stats = _untracked_file_numstat(root, relative_path)
        if stats is None:
            continue
        additions += stats["additions"]
        deletions += stats["deletions"]
        files.append(
            {
                "path": relative_path,
                "additions": stats["additions"],
                "deletions": stats["deletions"],
                "status": "untracked",
            }
        )
    return {
        "changeSummary": {
            "files": files,
            "stats": {"files": len(files), "additions": additions, "deletions": deletions},
            "changed": bool(files),
        }
    }


def dumps_json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=True)
COMMAND_TIMEOUT_SECONDS = max(
    30,
    int(os.environ.get("DAPR_AGENT_COMMAND_TIMEOUT_SECONDS", "300")),
)

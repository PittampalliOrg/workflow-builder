from __future__ import annotations

import difflib
import os
import shutil
import subprocess
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import httpx

try:
    from agent_framework import tool
except ImportError:  # pragma: no cover - fallback for test environments
    def tool(*_args, **_kwargs):
        def decorator(fn):
            return fn

        return decorator


DEFAULT_WORKSPACE_ROOT = os.environ.get("WORKSPACE_ROOT", "/workspace")
MAX_FILE_SIZE_BYTES = int(os.environ.get("MS_AGENT_MAX_FILE_SIZE_BYTES", "262144"))
MAX_GREP_RESULTS = int(os.environ.get("MS_AGENT_MAX_GREP_RESULTS", "200"))
MAX_LIST_FILES = int(os.environ.get("MS_AGENT_MAX_LIST_FILES", "500"))
DAPR_HOST = os.environ.get("DAPR_HOST", "127.0.0.1")
DAPR_HTTP_PORT = os.environ.get("DAPR_HTTP_PORT", "3500")
WORKSPACE_APP_ID = os.environ.get("DAPR_AGENT_APP_ID", "dapr-agent-runtime")
WORKSPACE_TIMEOUT_SECONDS = float(os.environ.get("MS_AGENT_WORKSPACE_TIMEOUT_SECONDS", "30"))


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
    workspace_ref: str | None = None
    execution_id: str | None = None
    files_read: set[str] = field(default_factory=set)
    files_listed: set[str] = field(default_factory=set)
    files_matched: set[str] = field(default_factory=set)
    files_modified: set[str] = field(default_factory=set)
    _original_files: dict[str, str | None] = field(default_factory=dict)
    _remote_patch_chunks: list[str] = field(default_factory=list)

    @classmethod
    def from_workspace_root(cls, workspace_root: str | os.PathLike[str]) -> "ToolRuntimeContext":
        root = Path(workspace_root).expanduser().resolve()
        root.mkdir(parents=True, exist_ok=True)
        return cls(workspace_root=root)

    @classmethod
    def from_remote_workspace(
        cls,
        *,
        workspace_root: str | os.PathLike[str],
        workspace_ref: str,
        execution_id: str | None = None,
    ) -> "ToolRuntimeContext":
        root = Path(workspace_root).expanduser().resolve()
        return cls(
            workspace_root=root,
            workspace_ref=workspace_ref.strip(),
            execution_id=str(execution_id or workspace_ref).strip() or workspace_ref.strip(),
        )

    @property
    def uses_remote_workspace(self) -> bool:
        return bool(self.workspace_ref)

    def resolve_path(self, raw_path: str | None) -> Path:
        candidate = (self.workspace_root / _normalize_workspace_path(raw_path)).resolve()
        if candidate != self.workspace_root and self.workspace_root not in candidate.parents:
            raise ValueError(f"Path escapes workspace root: {raw_path}")
        return candidate

    def record_read(self, path: Path) -> None:
        self.files_read.add(_as_relative(path, self.workspace_root))

    def record_read_relative(self, path: str) -> None:
        self.files_read.add(str(path))

    def record_listed(self, path: Path) -> None:
        self.files_listed.add(_as_relative(path, self.workspace_root))

    def record_listed_relative(self, path: str) -> None:
        self.files_listed.add(str(path))

    def record_match(self, path: Path) -> None:
        self.files_matched.add(_as_relative(path, self.workspace_root))

    def record_match_relative(self, path: str) -> None:
        self.files_matched.add(str(path))

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
        files_analyzed = sorted(self.files_read | self.files_matched)
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
        patch_chunks.extend(chunk for chunk in self._remote_patch_chunks if chunk)
        return {
            "filesAnalyzed": files_analyzed,
            "fixesApplied": fixes_applied,
            "patch": "\n".join(patch_chunks).strip(),
        }

    def ingest_remote_summary(self, payload: dict[str, Any] | None) -> None:
        if not isinstance(payload, dict):
            return
        for path in payload.get("filesAnalyzed") or []:
            if isinstance(path, str) and path.strip():
                self.files_read.add(path.strip())
        for path in payload.get("fixesApplied") or []:
            if isinstance(path, str) and path.strip():
                self.files_modified.add(path.strip())
        patch = payload.get("patch")
        if isinstance(patch, str) and patch.strip():
            self._remote_patch_chunks.append(patch.strip())


def _workspace_invoke(
    context: ToolRuntimeContext,
    *,
    method: str,
    payload: dict[str, Any],
) -> dict[str, Any]:
    if not context.workspace_ref:
        raise RuntimeError("workspaceRef is required for remote workspace access")
    url = (
        f"http://{DAPR_HOST}:{DAPR_HTTP_PORT}/v1.0/invoke/"
        f"{WORKSPACE_APP_ID}/method/{method}"
    )
    request_payload = {
        "executionId": context.execution_id or context.workspace_ref,
        "workspaceRef": context.workspace_ref,
        **payload,
    }
    with httpx.Client(timeout=WORKSPACE_TIMEOUT_SECONDS) as client:
        response = client.post(url, json=request_payload)
    if response.status_code >= 400:
        body = (response.text or "").strip()
        raise RuntimeError(
            body or f"Remote workspace call failed with HTTP {response.status_code}"
        )
    data = response.json()
    if not isinstance(data, dict):
        raise RuntimeError("Remote workspace call returned invalid payload")
    return data


def _extract_context(kwargs: dict[str, Any]) -> ToolRuntimeContext:
    context = kwargs.get("tool_context")
    if isinstance(context, ToolRuntimeContext):
        return context
    workspace_root = kwargs.get("workspace_root") or DEFAULT_WORKSPACE_ROOT
    return ToolRuntimeContext.from_workspace_root(str(workspace_root))


@tool(name="read_file", description="Read a UTF-8 text file from the workspace")
def read_file(path: str, **kwargs) -> str:
    context = _extract_context(kwargs)
    if context.uses_remote_workspace:
        payload = _workspace_invoke(
            context,
            method="api/workspaces/file",
            payload={"operation": "read", "path": path},
        )
        context.record_read_relative(path)
        return str(payload.get("content") or "")
    resolved = context.resolve_path(path)
    if not resolved.is_file():
        raise FileNotFoundError(f"File not found: {path}")
    _ensure_text_size(resolved)
    context.record_read(resolved)
    return resolved.read_text(encoding="utf-8")


@tool(name="list_files", description="List files in a workspace directory using a glob pattern")
def list_files(path: str = ".", pattern: str = "**/*", **kwargs) -> list[str]:
    context = _extract_context(kwargs)
    if context.uses_remote_workspace:
        payload = _workspace_invoke(
            context,
            method="api/workspaces/file",
            payload={"operation": "list", "path": path, "pattern": pattern},
        )
        files = [str(item) for item in payload.get("files") or [] if str(item).strip()]
        for candidate in files:
            context.record_listed_relative(candidate)
        return files[:MAX_LIST_FILES]
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


@tool(name="grep_search", description="Search UTF-8 text files in the workspace for a substring")
def grep_search(pattern: str, path: str = ".", **kwargs) -> list[dict[str, Any]]:
    context = _extract_context(kwargs)
    if context.uses_remote_workspace:
        payload = _workspace_invoke(
            context,
            method="api/workspaces/file",
            payload={"operation": "grep", "path": path, "pattern": pattern},
        )
        matches = payload.get("matches") or []
        normalized: list[dict[str, Any]] = []
        for match in matches[:MAX_GREP_RESULTS]:
            if not isinstance(match, dict):
                continue
            normalized_match = {
                "path": str(match.get("path") or ""),
                "lineNumber": int(match.get("lineNumber") or 0),
                "line": str(match.get("line") or ""),
            }
            if normalized_match["path"]:
                context.record_match_relative(normalized_match["path"])
                normalized.append(normalized_match)
        return normalized
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


@tool(name="write_file", description="Write a UTF-8 text file in the workspace")
def write_file(path: str, content: str, **kwargs) -> dict[str, Any]:
    context = _extract_context(kwargs)
    if context.uses_remote_workspace:
        payload = _workspace_invoke(
            context,
            method="api/workspaces/file",
            payload={"operation": "write", "path": path, "content": content},
        )
        context.ingest_remote_summary(payload)
        return {
            "path": str(payload.get("path") or path),
            "bytesWritten": len(content.encode("utf-8")),
        }
    resolved = context.resolve_path(path)
    context.record_modified(resolved)
    resolved.parent.mkdir(parents=True, exist_ok=True)
    resolved.write_text(content, encoding="utf-8")
    return {"path": _as_relative(resolved, context.workspace_root), "bytesWritten": len(content.encode("utf-8"))}


@tool(name="edit_file", description="Replace text in a UTF-8 text file in the workspace")
def edit_file(path: str, old_string: str, new_string: str, **kwargs) -> dict[str, Any]:
    context = _extract_context(kwargs)
    if context.uses_remote_workspace:
        payload = _workspace_invoke(
            context,
            method="api/workspaces/file",
            payload={
                "operation": "edit",
                "path": path,
                "old_string": old_string,
                "new_string": new_string,
            },
        )
        context.ingest_remote_summary(payload)
        return {
            "path": str(payload.get("path") or path),
            "replacements": int(payload.get("replacements") or 1),
        }
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


@tool(name="execute_command", description="Run a shell command inside the workspace")
def execute_command(command: str, cwd: str = ".", **kwargs) -> dict[str, Any]:
    context = _extract_context(kwargs)
    if context.uses_remote_workspace:
        payload = _workspace_invoke(
            context,
            method="api/workspaces/command",
            payload={"command": command, "cwd": cwd},
        )
        context.ingest_remote_summary(payload)
        return {
            "cwd": str(payload.get("cwd") or cwd or "."),
            "exitCode": int(payload.get("exitCode") or 0),
            "stdout": str(payload.get("stdout") or "")[-12000:],
            "stderr": str(payload.get("stderr") or "")[-12000:],
        }
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


@tool(name="delete_path", description="Delete a file or directory in the workspace")
def delete_path(path: str, **kwargs) -> dict[str, Any]:
    context = _extract_context(kwargs)
    if context.uses_remote_workspace:
        payload = _workspace_invoke(
            context,
            method="api/workspaces/file",
            payload={"operation": "delete", "path": path},
        )
        context.ingest_remote_summary(payload)
        return {"path": str(payload.get("path") or path)}
    resolved = context.resolve_path(path)
    if not resolved.exists():
        raise FileNotFoundError(f"Path not found: {path}")
    context.record_modified(resolved)
    if resolved.is_dir():
        shutil.rmtree(resolved)
    else:
        resolved.unlink()
    return {"path": path}


@tool(name="mkdir", description="Create a directory in the workspace")
def mkdir(path: str, **kwargs) -> dict[str, Any]:
    context = _extract_context(kwargs)
    if context.uses_remote_workspace:
        payload = _workspace_invoke(
            context,
            method="api/workspaces/file",
            payload={"operation": "mkdir", "path": path},
        )
        return {"path": str(payload.get("path") or path)}
    resolved = context.resolve_path(path)
    resolved.mkdir(parents=True, exist_ok=True)
    return {"path": _as_relative(resolved, context.workspace_root)}


@tool(name="file_stat", description="Return metadata for a workspace file or directory")
def file_stat(path: str, **kwargs) -> dict[str, Any]:
    context = _extract_context(kwargs)
    if context.uses_remote_workspace:
        payload = _workspace_invoke(
            context,
            method="api/workspaces/file",
            payload={"operation": "stat", "path": path},
        )
        stat_path = str(payload.get("path") or path)
        context.record_read_relative(stat_path)
        return {
            "path": stat_path,
            "exists": bool(payload.get("exists", True)),
            "isFile": bool(payload.get("isFile", False)),
            "isDirectory": bool(payload.get("isDirectory", False)),
            "size": int(payload.get("size") or 0),
        }
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


@tool(name="git_status", description="Get git status in the workspace")
def git_status(path: str = ".", **kwargs) -> dict[str, Any]:
    context = _extract_context(kwargs)
    if context.uses_remote_workspace:
        payload = _workspace_invoke(
            context,
            method="api/workspaces/file",
            payload={"operation": "git_status", "path": path},
        )
        return {"path": path, "status": str(payload.get("status") or "")}
    cwd = context.resolve_path(path)
    stdout = _run_git(["status", "--short", "--branch"], cwd=cwd)
    return {"path": path, "status": stdout}


@tool(name="git_diff", description="Get git diff in the workspace")
def git_diff(path: str = ".", **kwargs) -> dict[str, Any]:
    context = _extract_context(kwargs)
    if context.uses_remote_workspace:
        payload = _workspace_invoke(
            context,
            method="api/workspaces/file",
            payload={"operation": "git_diff", "path": path},
        )
        return {"path": path, "diff": str(payload.get("diff") or "")}
    cwd = context.resolve_path(path)
    stdout = _run_git(["diff", "--no-ext-diff"], cwd=cwd)
    return {"path": path, "diff": stdout}


@tool(name="git_apply", description="Apply a unified diff patch in the workspace")
def git_apply(patch: str, path: str = ".", **kwargs) -> dict[str, Any]:
    context = _extract_context(kwargs)
    if context.uses_remote_workspace:
        payload = _workspace_invoke(
            context,
            method="api/workspaces/file",
            payload={"operation": "git_apply", "path": path, "content": patch},
        )
        context.ingest_remote_summary(payload)
        return {"path": path, "applied": bool(payload.get("applied", True))}
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


def resolve_tool_group(name: str | None) -> list[Any]:
    if not name:
        return []
    return TOOL_GROUPS.get(str(name).strip().lower(), [])

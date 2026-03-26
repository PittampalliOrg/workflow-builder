from __future__ import annotations

import json
import os
import re
from dataclasses import dataclass
from dataclasses import field
from functools import wraps
import shlex
from typing import Any, Callable, Sequence, TypedDict
import urllib.error
import urllib.parse
import urllib.request
import uuid

import msgpack

# OpenShell appends ~30 chars of suffix to sandbox names; keep ours short.
_MAX_SANDBOX_NAME_LEN = 30


def _sanitize_sandbox_name(name: str, *, max_len: int = _MAX_SANDBOX_NAME_LEN) -> str:
    """Lowercase, replace non-alnum with '-', truncate, strip trailing '-'."""
    name = re.sub(r"[^a-z0-9-]", "-", name.lower())
    name = name[:max_len].rstrip("-")
    return name or "sandbox"

from tools import (
    ToolRuntimeContext,
    _resolve_tool_invocation,
    pop_tool_context,
    push_tool_context,
    resolve_tool_group,
)

try:
    from dapr.ext.langgraph import DaprCheckpointer
except ImportError:  # pragma: no cover
    DaprCheckpointer = None

try:
    from deepagents import create_deep_agent
except ImportError:  # pragma: no cover
    create_deep_agent = None

try:
    from langchain.chat_models import init_chat_model
except ImportError:  # pragma: no cover
    init_chat_model = None

try:
    from langchain_openai import ChatOpenAI
except ImportError:  # pragma: no cover
    ChatOpenAI = None

try:
    from dapr_agents.tool.utils.serialization import serialize_tool_result
except ImportError:  # pragma: no cover
    def serialize_tool_result(result: Any) -> Any:  # type: ignore[no-redef]
        return result

try:
    from langgraph.graph import END, START, StateGraph
    from langgraph.types import Command, interrupt
except ImportError:  # pragma: no cover
    END = None
    START = None
    StateGraph = None
    Command = None
    interrupt = None


LANGGRAPH_ENGINE_NAME = "langgraph-deepagents"
LANGGRAPH_ENGINE_ENABLED = (
    os.environ.get("DAPR_AGENT_ENABLE_LANGGRAPH", "true").strip().lower() == "true"
)
LANGGRAPH_CHECKPOINT_STORE_NAME = (
    os.environ.get("DAPR_AGENT_LANGGRAPH_CHECKPOINT_STORE_NAME")
    or os.environ.get("DAPR_AGENT_STATE_STORE_NAME")
    or "workflowstatestore"
).strip() or "workflowstatestore"
LANGGRAPH_CHECKPOINT_KEY_PREFIX = (
    os.environ.get("DAPR_AGENT_LANGGRAPH_CHECKPOINT_KEY_PREFIX", "langgraph:checkpoint:").strip()
    or "langgraph:checkpoint:"
)
LANGGRAPH_SUMMARIZE_PROMPT = (
    "Summarize the completed work in concise engineering language. "
    "Call out the files changed, verification run, and residual risks."
)
OPENSHELL_AGENT_RUNTIME_API_BASE_URL = (
    os.environ.get("OPENSHELL_AGENT_RUNTIME_API_BASE_URL")
    or "http://openshell-agent-runtime.openshell.svc.cluster.local:8083"
).strip().rstrip("/")


if DaprCheckpointer is not None:
    class SafeDaprCheckpointer(DaprCheckpointer):
        """Work around dapr-ext-langgraph 1.17.1 corrupting checkpoint blobs via put_writes."""

        def put_writes(
            self,
            config: Any,
            writes: Sequence[tuple[str, Any]],
            task_id: str,
            task_path: str = "",
        ) -> None:
            return None

        def get_tuple(self, config: Any) -> Any | None:
            try:
                return super().get_tuple(config)
            except KeyError:
                return self._decode_checkpoint_tuple_without_messages(config)

        def _decode_checkpoint_tuple_without_messages(self, config: Any) -> Any | None:
            thread_id = config["configurable"]["thread_id"]
            checkpoint_ns = config["configurable"].get("checkpoint_ns", "")
            storage_safe_thread_id = self._safe_id(thread_id)
            storage_safe_checkpoint_ns = self._safe_ns(checkpoint_ns)
            latest_pointer_key = ":".join(
                [
                    "checkpoint_latest",
                    storage_safe_thread_id,
                    storage_safe_checkpoint_ns,
                ]
            )
            checkpoint_pointer = self.client.get_state(
                store_name=self.store_name,
                key=latest_pointer_key,
            )
            if not checkpoint_pointer.data:
                return None
            checkpoint_key = (
                checkpoint_pointer.data.decode()
                if isinstance(checkpoint_pointer.data, bytes)
                else checkpoint_pointer.data
            )
            checkpoint_data = self.client.get_state(
                store_name=self.store_name,
                key=checkpoint_key,
            )
            if not checkpoint_data.data:
                return None
            if isinstance(checkpoint_data.data, bytes):
                unpacked = msgpack.unpackb(checkpoint_data.data)
                checkpoint_values = unpacked.get(b"checkpoint") or unpacked.get("checkpoint")
                if not isinstance(checkpoint_values, dict):
                    return None
                metadata_blob = unpacked.get(b"metadata") or unpacked.get("metadata") or {}
                if isinstance(metadata_blob, bytes):
                    metadata_blob = self._load_metadata(msgpack.unpackb(metadata_blob))
                metadata = self._decode_bytes(metadata_blob) if isinstance(metadata_blob, dict) else {}
                checkpoint = self._decode_bytes(checkpoint_values)
            elif isinstance(checkpoint_data.data, str):
                unpacked = json.loads(checkpoint_data.data)
                checkpoint = unpacked.get("checkpoint")
                metadata = unpacked.get("metadata") or {}
                if not checkpoint:
                    return None
            else:
                return None
            from langgraph.checkpoint.base import CheckpointTuple

            return CheckpointTuple(
                config=config,
                checkpoint=checkpoint,
                metadata=metadata,
                parent_config=None,
                pending_writes=[],
            )
else:  # pragma: no cover
    SafeDaprCheckpointer = None


@dataclass(frozen=True)
class LangGraphRunResult:
    text: str
    structured_output: dict[str, Any] | None
    tool_summary: dict[str, Any]
    metadata: dict[str, Any]


ProgressCallback = Callable[[dict[str, Any]], None]


def _compact_progress_payload(
    value: Any,
    *,
    max_string_length: int = 4000,
    max_items: int = 50,
) -> Any:
    if value is None or isinstance(value, (bool, int, float)):
        return value
    if isinstance(value, str):
        return value[:max_string_length]
    if isinstance(value, dict):
        return {
            str(key): _compact_progress_payload(
                item,
                max_string_length=max_string_length,
                max_items=max_items,
            )
            for key, item in list(value.items())[:max_items]
        }
    if isinstance(value, (list, tuple)):
        return [
            _compact_progress_payload(
                item,
                max_string_length=max_string_length,
                max_items=max_items,
            )
            for item in list(value)[:max_items]
        ]
    return str(value)[:max_string_length]


@dataclass
class OpenShellToolContext:
    sandbox_name: str
    repo_path: str
    provider: str | None = None
    repo_url: str | None = None
    repo_branch: str | None = None
    repo_token: str | None = None
    api_base_url: str = OPENSHELL_AGENT_RUNTIME_API_BASE_URL
    keep: bool = True
    change_summary: dict[str, Any] = field(
        default_factory=lambda: {
            "files": [],
            "stats": {"files": 0, "additions": 0, "deletions": 0},
            "changed": False,
        }
    )
    patch: str = ""
    snapshot_refs: list[str] = field(default_factory=list)

    def _normalize_legacy_workspace_path(self, raw_path: str | None) -> str:
        candidate = str(raw_path or "").strip()
        if not candidate:
            return self.repo_path
        legacy_aliases = {"/workspace", "/workspace/", "/repo", "/repo/"}
        if candidate in legacy_aliases:
            return self.repo_path
        if candidate.startswith("/workspace/"):
            suffix = candidate[len("/workspace/") :].strip("/")
            return self.repo_path if not suffix else f"{self.repo_path.rstrip('/')}/{suffix}"
        if candidate.startswith("/repo/"):
            suffix = candidate[len("/repo/") :].strip("/")
            return self.repo_path if not suffix else f"{self.repo_path.rstrip('/')}/{suffix}"
        return candidate

    def _rewrite_legacy_workspace_aliases(self, command: str) -> str:
        normalized_command = str(command or "")
        return (
            normalized_command
            .replace("cd /workspace &&", f"cd {self.repo_path} &&")
            .replace("cd /workspace;", f"cd {self.repo_path};")
            .replace("cd /workspace\n", f"cd {self.repo_path}\n")
            .replace("cd /repo &&", f"cd {self.repo_path} &&")
            .replace("cd /repo;", f"cd {self.repo_path};")
            .replace("cd /repo\n", f"cd {self.repo_path}\n")
        )

    def _ensure_pnpm_available(self, command: str) -> str:
        normalized_command = str(command or "")
        if "pnpm" not in normalized_command:
            return normalized_command
        bootstrap = (
            "if ! command -v pnpm >/dev/null 2>&1; then "
            "pnpm() { "
            "if command -v corepack >/dev/null 2>&1; then corepack pnpm \"$@\"; "
            "elif command -v npx >/dev/null 2>&1; then npx -y pnpm \"$@\"; "
            "else echo 'pnpm not available' >&2; return 127; fi; "
            "}; "
            "fi; "
            "if [ -f package.json ] && [ ! -d node_modules ]; then "
            "pnpm install --frozen-lockfile || pnpm install; "
            "fi; "
        )
        return f"{bootstrap}{normalized_command}"

    @classmethod
    def from_config(cls, config: dict[str, Any]) -> "OpenShellToolContext":
        sandbox_name = str(config.get("sandboxName") or "").strip() or f"openshell-lg-{uuid.uuid4().hex[:12]}"
        repo_path = str(config.get("repoPath") or "").strip() or "/sandbox/repo"
        return cls(
            sandbox_name=_sanitize_sandbox_name(sandbox_name),
            repo_path=repo_path,
            provider=str(config.get("provider") or "").strip() or None,
            repo_url=str(config.get("repoUrl") or "").strip() or None,
            repo_branch=str(config.get("repoBranch") or "").strip() or None,
            repo_token=str(config.get("repoToken") or "").strip() or None,
        )

    def _compose_command(self, command: str, cwd: str | None = None) -> str:
        normalized_cwd = self._normalize_legacy_workspace_path(cwd or ".")
        if not normalized_cwd or normalized_cwd == ".":
            target_dir = self.repo_path
        elif normalized_cwd.startswith("/"):
            target_dir = normalized_cwd
        else:
            target_dir = f"{self.repo_path.rstrip('/')}/{normalized_cwd.lstrip('./')}"
        normalized_command = self._ensure_pnpm_available(
            self._rewrite_legacy_workspace_aliases(command)
        )
        return f"set -eu; cd {shlex.quote(target_dir)}; {normalized_command}"

    def _request(
        self,
        *,
        method: str,
        path: str,
        payload: dict[str, Any] | None = None,
        timeout_seconds: int = 300,
    ) -> dict[str, Any]:
        body = json.dumps(payload or {}, ensure_ascii=True).encode("utf-8") if payload is not None else None
        request = urllib.request.Request(
            f"{self.api_base_url}{path}",
            data=body,
            headers={"Content-Type": "application/json"},
            method=method,
        )
        try:
            with urllib.request.urlopen(request, timeout=max(timeout_seconds, 30)) as response:
                content = response.read().decode("utf-8")
        except urllib.error.HTTPError as exc:
            content = exc.read().decode("utf-8")
            try:
                parsed = json.loads(content)
            except json.JSONDecodeError as json_exc:  # pragma: no cover
                raise RuntimeError(content or str(exc)) from json_exc
            raise RuntimeError(str(parsed.get("error") or parsed.get("message") or content))
        parsed = json.loads(content)
        if not isinstance(parsed, dict):
            raise RuntimeError("OpenShell runtime returned an invalid response payload")
        return parsed

    @staticmethod
    def _parse_error_payload(error: Exception) -> dict[str, Any] | None:
        try:
            parsed = json.loads(str(error))
        except (TypeError, json.JSONDecodeError):
            return None
        return parsed if isinstance(parsed, dict) else None

    def run_command(
        self,
        command: str,
        *,
        cwd: str | None = None,
        timeout_seconds: int = 300,
    ) -> dict[str, Any]:
        payload = {
            "runId": f"{self.sandbox_name}-{uuid.uuid4().hex[:8]}",
            "sandboxName": self.sandbox_name,
            "provider": self.provider,
            "keep": self.keep,
            "timeoutSeconds": timeout_seconds,
            "sandboxRepoPath": self.repo_path,
            "command": self._compose_command(command, cwd),
        }
        if self.repo_url:
            payload["repoUrl"] = self.repo_url
        if self.repo_branch:
            payload["repoBranch"] = self.repo_branch
        if self.repo_token:
            payload["repoToken"] = self.repo_token
        try:
            response = self._request(
                method="POST",
                path="/api/v1/agent-runs",
                payload=payload,
                timeout_seconds=timeout_seconds + 30,
            )
        except RuntimeError as exc:
            parsed_error = self._parse_error_payload(exc)
            if not isinstance(parsed_error.get("result"), dict):
                raise
            response = parsed_error
        result = response.get("result") if isinstance(response.get("result"), dict) else {}
        change_summary = response.get("changeSummary")
        if not isinstance(change_summary, dict):
            change_summary = result.get("changeSummary") if isinstance(result.get("changeSummary"), dict) else None
        if isinstance(change_summary, dict):
            self.change_summary = change_summary
        patch = response.get("patch")
        if not isinstance(patch, str):
            patch = result.get("patch") if isinstance(result.get("patch"), str) else ""
        if patch:
            self.patch = patch
        snapshot_refs = response.get("snapshotRefs")
        if not isinstance(snapshot_refs, list):
            snapshot_refs = result.get("snapshotRefs") if isinstance(result.get("snapshotRefs"), list) else []
        self.snapshot_refs = [str(item) for item in snapshot_refs if str(item).strip()]
        exit_code = int(result.get("returncode") or 0)
        return {
            "cwd": cwd or ".",
            "exitCode": exit_code,
            "stdout": str(result.get("stdout") or "")[-12000:],
            "stderr": str(result.get("stderr") or "")[-12000:],
            "timedOut": False,
            "sandboxName": str(response.get("sandboxName") or self.sandbox_name),
        }

    def collect_repo_context(self) -> str:
        inventory = self.run_command(
            (
                "pwd; "
                "echo '--- git status --short --branch ---'; "
                "git status --short --branch || true; "
                "echo; "
                "echo '--- repo files (depth 3) ---'; "
                "find . -maxdepth 3 -type f | sort | head -200"
            ),
            timeout_seconds=120,
        )
        return "\n".join(
            segment for segment in [inventory.get("stdout", ""), inventory.get("stderr", "")]
            if isinstance(segment, str) and segment.strip()
        ).strip()

    def cleanup(self) -> None:
        if self.keep or not self.sandbox_name:
            return
        try:
            self._request(
                method="DELETE",
                path=f"/api/v1/sandboxes/{urllib.parse.quote(self.sandbox_name, safe='')}",
                payload=None,
                timeout_seconds=60,
            )
        except Exception:
            return

    def build_summary(self) -> dict[str, Any]:
        files = self.change_summary.get("files") if isinstance(self.change_summary, dict) else []
        changed_paths = [
            str(entry.get("path") or "").strip()
            for entry in files
            if isinstance(entry, dict) and str(entry.get("path") or "").strip()
        ]
        return {
            "filesAnalyzed": [],
            "fileChanges": changed_paths,
            "changeSummary": self.change_summary,
            "patch": self.patch,
            "snapshotRefs": self.snapshot_refs,
        }


class PlannerState(TypedDict, total=False):
    prompt: str
    profile: str
    requiresReview: bool
    revision: int
    reviewFeedback: str
    reviewAction: str
    reviewDecision: dict[str, Any]
    planJson: dict[str, Any]
    planMarkdown: str
    plannerStatus: str
    approved: bool
    rejected: bool


def is_langgraph_available() -> bool:
    return bool(
        LANGGRAPH_ENGINE_ENABLED
        and create_deep_agent
        and (init_chat_model or ChatOpenAI)
        and StateGraph
        and interrupt
    )


def build_langgraph_capabilities() -> dict[str, Any]:
    return {
        "enabled": LANGGRAPH_ENGINE_ENABLED,
        "available": is_langgraph_available(),
        "engine": LANGGRAPH_ENGINE_NAME,
        "deepAgents": bool(create_deep_agent),
        "checkpointer": bool(DaprCheckpointer),
        "chatModelFactory": bool(init_chat_model or ChatOpenAI),
        "sessionPersistence": "dapr-checkpointer" if DaprCheckpointer else None,
        "checkpointStoreName": LANGGRAPH_CHECKPOINT_STORE_NAME,
        "checkpointKeyPrefix": LANGGRAPH_CHECKPOINT_KEY_PREFIX,
        "features": [
            "deep-agent",
            "durable-planner",
            "planner-interrupts",
            "write-todos",
            "subagents",
            "tool-wrapped-workspace",
        ],
    }


def _build_model(model: str, api_key: str | None) -> Any:
    normalized = str(model or "").strip() or "gpt-5.4"
    if normalized.startswith("openai/"):
        normalized = normalized.split("/", 1)[1].strip() or "gpt-5.4"
    if init_chat_model is not None:
        return init_chat_model(f"openai:{normalized}", api_key=api_key or os.environ.get("OPENAI_API_KEY"))
    if ChatOpenAI is None:  # pragma: no cover
        raise RuntimeError("LangGraph engine is unavailable: no chat model factory installed")
    return ChatOpenAI(model=normalized, api_key=api_key or os.environ.get("OPENAI_API_KEY"))


def _build_checkpointer() -> Any | None:
    if SafeDaprCheckpointer is None:
        return None
    return SafeDaprCheckpointer(
        store_name=LANGGRAPH_CHECKPOINT_STORE_NAME,
        key_prefix=LANGGRAPH_CHECKPOINT_KEY_PREFIX,
    )


def _invoke_tool(fn: Any, *args: Any, **kwargs: Any) -> Any:
    nested_args = kwargs.pop("args", None)
    if not args and isinstance(nested_args, dict):
        kwargs = {**nested_args, **kwargs}
    elif nested_args is not None:
        kwargs["args"] = nested_args
    return fn(*args, **kwargs)


def _coerce_recoverable_tool_error(tool_name: str, exc: Exception) -> dict[str, Any] | None:
    if isinstance(exc, FileNotFoundError):
        return {
            "tool": tool_name,
            "error": str(exc),
            "recoverable": True,
            "hint": "If this path should be created, inspect the parent directory and use write_file instead of read_file.",
        }
    if isinstance(exc, ValueError):
        return {
            "tool": tool_name,
            "error": str(exc),
            "recoverable": True,
        }
    return None


def _bind_workspace_tools(
    tool_group: str,
    workspace_root: str,
    *,
    progress_callback: ProgressCallback | None = None,
) -> list[Any]:
    bound_tools: list[Any] = []
    for tool_fn in resolve_tool_group(tool_group):
        tool_callable = getattr(tool_fn, "func", None) or tool_fn
        tool_name = getattr(tool_fn, "name", None) or getattr(tool_fn, "__name__", "tool")
        tool_description = (
            getattr(tool_fn, "description", None)
            or getattr(tool_fn, "__doc__", None)
            or f"Run {tool_name}"
        )

        def _make_tool(
            fn: Any,
            *,
            name: str,
            description: str,
            progress_callback: ProgressCallback | None,
        ):
            @wraps(fn)
            def wrapped(*args: Any, **kwargs: Any) -> Any:
                tool_args = _compact_progress_payload(
                    kwargs if kwargs else {"args": list(args)} if args else None
                )
                if progress_callback is not None:
                    progress_callback(
                        {
                            "event": "tool_start",
                            "toolName": name,
                            "toolArgs": tool_args,
                        }
                    )
                try:
                    result = _invoke_tool(fn, *args, **kwargs)
                except Exception as exc:
                    recoverable = _coerce_recoverable_tool_error(name, exc)
                    if recoverable is not None:
                        if progress_callback is not None:
                            progress_callback(
                                {
                                    "event": "tool_complete",
                                    "toolName": name,
                                    "status": "recoverable_error",
                                    "toolArgs": tool_args,
                                    "toolResult": _compact_progress_payload(recoverable),
                                }
                            )
                        return recoverable
                    if progress_callback is not None:
                        progress_callback(
                            {
                                "event": "tool_error",
                                "toolName": name,
                                "error": str(exc),
                                "toolArgs": tool_args,
                            }
                        )
                    raise
                if progress_callback is not None:
                    progress_callback(
                        {
                            "event": "tool_complete",
                            "toolName": name,
                            "status": "completed",
                            "toolArgs": tool_args,
                            "toolResult": _compact_progress_payload(serialize_tool_result(result)),
                        }
                    )
                return result

            wrapped.__name__ = name
            wrapped.__doc__ = description
            return wrapped

        bound_tools.append(
            _make_tool(
                tool_callable,
                name=str(tool_name),
                description=str(tool_description),
                progress_callback=progress_callback,
            )
        )
    return bound_tools


def _attach_progress_hooks(
    model: Any,
    *,
    phase: str,
    progress_callback: ProgressCallback | None,
) -> Any:
    if progress_callback is None or getattr(model, "_workflow_builder_progress_wrapped", False):
        return model

    original_invoke = getattr(model, "invoke", None)
    if callable(original_invoke):
        @wraps(original_invoke)
        def invoke(*args: Any, **kwargs: Any) -> Any:
            progress_callback({"event": "model_start", "phase": phase})
            result = original_invoke(*args, **kwargs)
            progress_callback({"event": "model_complete", "phase": phase})
            return result

        object.__setattr__(model, "invoke", invoke)

    original_ainvoke = getattr(model, "ainvoke", None)
    if callable(original_ainvoke):
        @wraps(original_ainvoke)
        async def ainvoke(*args: Any, **kwargs: Any) -> Any:
            progress_callback({"event": "model_start", "phase": phase})
            result = await original_ainvoke(*args, **kwargs)
            progress_callback({"event": "model_complete", "phase": phase})
            return result

        object.__setattr__(model, "ainvoke", ainvoke)

    original_bind_tools = getattr(model, "bind_tools", None)
    if callable(original_bind_tools):
        @wraps(original_bind_tools)
        def bind_tools(*args: Any, **kwargs: Any) -> Any:
            bound_model = original_bind_tools(*args, **kwargs)
            return _attach_progress_hooks(
                bound_model,
                phase=phase,
                progress_callback=progress_callback,
            )

        object.__setattr__(model, "bind_tools", bind_tools)

    object.__setattr__(model, "_workflow_builder_progress_wrapped", True)
    return model


def _build_subagents(workspace_root: str) -> list[dict[str, Any]]:
    return [
        {
            "name": "repo-scout",
            "description": "Explore repository structure and identify the files relevant to the task.",
            "system_prompt": (
                "Inspect the codebase, identify the most relevant files, and summarize "
                "what matters for the task without making edits."
            ),
            "tools": _bind_workspace_tools("read_only", workspace_root),
        },
        {
            "name": "verifier",
            "description": "Run verification commands and summarize code changes and residual risks.",
            "system_prompt": (
                "Verify the implementation, review changed files, and summarize what passed, "
                "what failed, and any remaining risks."
            ),
            "tools": _bind_workspace_tools("all", workspace_root),
        },
    ]


def _effective_tool_group(phase: str, requested_tool_group: str) -> str:
    if phase == "plan":
        return "read_only"
    return requested_tool_group


def _effective_subagents(phase: str, workspace_root: str) -> list[dict[str, Any]]:
    if phase == "plan":
        return []
    return _build_subagents(workspace_root)


def _bind_openshell_tools(
    context: OpenShellToolContext,
    *,
    progress_callback: ProgressCallback | None = None,
) -> list[Any]:
    def execute_openshell_command(
        command: str,
        cwd: str = ".",
        timeout_seconds: int = 300,
        args: dict[str, Any] | None = None,
        **kwargs: Any,
    ) -> dict[str, Any]:
        resolved_kwargs = _resolve_tool_invocation(args, kwargs)
        command_text = str(resolved_kwargs.get("command", command))
        command_cwd = str(resolved_kwargs.get("cwd", cwd))
        timeout_value = int(resolved_kwargs.get("timeout_seconds", timeout_seconds) or timeout_seconds)
        tool_args = _compact_progress_payload(
            {
                "command": command_text,
                "cwd": command_cwd,
                "timeout_seconds": timeout_value,
            }
        )
        if progress_callback is not None:
            progress_callback(
                {
                    "event": "tool_start",
                    "toolName": "execute_openshell_command",
                    "toolArgs": tool_args,
                }
            )
        result = context.run_command(
            command_text,
            cwd=command_cwd,
            timeout_seconds=max(timeout_value, 30),
        )
        if progress_callback is not None:
            progress_callback(
                {
                    "event": "tool_complete",
                    "toolName": "execute_openshell_command",
                    "status": (
                        "completed"
                        if int(result.get("exitCode") or 0) == 0
                        else "nonzero_exit"
                    ),
                    "toolArgs": tool_args,
                    "toolResult": _compact_progress_payload(result),
                }
            )
            # Emit sandbox output event for UI terminal display
            progress_callback(
                {
                    "event": "sandbox_output",
                    "command": command_text,
                    "output": str(result.get("stdout") or result.get("output") or "")[:4000],
                    "exitCode": int(result.get("exitCode") or 0),
                }
            )
        return result

    execute_openshell_command.__name__ = "execute_openshell_command"
    execute_openshell_command.__doc__ = (
        "Execute a shell command inside the persistent OpenShell sandbox checkout. "
        "Use it for repository inspection, file edits, and verification commands."
    )
    return [execute_openshell_command]


def _extract_message_text(messages: Any) -> str:
    if not isinstance(messages, list):
        return ""
    for message in reversed(messages):
        content = getattr(message, "content", None)
        if isinstance(content, str) and content.strip():
            return content.strip()
        if isinstance(message, dict):
            dict_content = message.get("content")
            if isinstance(dict_content, str) and dict_content.strip():
                return dict_content.strip()
            if isinstance(dict_content, list):
                parts = [
                    str(part.get("text") or "").strip()
                    for part in dict_content
                    if isinstance(part, dict) and str(part.get("text") or "").strip()
                ]
                if parts:
                    return "\n".join(parts).strip()
    return ""


def _coerce_structured_output(result: Any) -> dict[str, Any] | None:
    if isinstance(result, dict):
        structured = result.get("structured_response")
        if isinstance(structured, dict):
            return structured
        output = result.get("output")
        if isinstance(output, dict):
            return output
    return None


def _coerce_text(result: Any) -> str:
    direct_content = getattr(result, "content", None)
    if isinstance(direct_content, str) and direct_content.strip():
        return direct_content.strip()
    if isinstance(direct_content, list):
        text = _extract_message_text([{"content": direct_content}])
        if text:
            return text
    if isinstance(result, dict):
        for key in ("output_text", "text", "output"):
            value = result.get(key)
            if isinstance(value, str) and value.strip():
                return value.strip()
        text = _extract_message_text(result.get("messages"))
        if text:
            return text
    if isinstance(result, str):
        return result.strip()
    return json.dumps(result, default=str)


def _extract_json_block(text: str) -> dict[str, Any] | None:
    stripped = text.strip()
    candidates = [stripped]
    fenced = re.findall(r"```json\s*(\{.*?\})\s*```", stripped, flags=re.DOTALL)
    candidates.extend(fenced)
    for candidate in candidates:
        if not candidate:
            continue
        try:
            parsed = json.loads(candidate)
        except json.JSONDecodeError:
            continue
        if isinstance(parsed, dict):
            return parsed
    return None


def _fallback_plan_json(prompt: str, markdown: str) -> dict[str, Any]:
    summary = markdown.strip() or prompt.strip()
    return {
        "artifactType": "claude_task_graph_v1",
        "goal": prompt,
        "summary": summary[:500] if summary else prompt,
        "tasks": [
            {
                "id": "task-1",
                "title": "Implement approved feature",
                "description": summary or prompt,
                "tool": "coding-agent",
            }
        ],
        "acceptanceCriteria": [],
        "verificationCommands": [],
        "files": [],
    }


def _normalize_planner_resume(value: dict[str, Any] | None) -> dict[str, Any] | None:
    if not isinstance(value, dict):
        return None
    action = str(value.get("action") or "").strip().lower()
    if not action:
        approved = value.get("approved")
        if approved is True:
            action = "approve"
        elif approved is False:
            action = "reject"
    if action not in {"approve", "reject", "edit"}:
        return None
    payload = dict(value)
    payload["action"] = action
    return payload


def _planner_review_payload(state: PlannerState) -> dict[str, Any]:
    return {
        "type": "plan_review",
        "plannerStatus": "awaiting_review",
        "revision": int(state.get("revision") or 1),
        "plan": state.get("planJson") or {},
        "planMarkdown": str(state.get("planMarkdown") or "").strip(),
    }


def _planner_system_prompt(profile: str, review_feedback: str | None) -> str:
    feedback = str(review_feedback or "").strip()
    base_prompt = (
        f"You are a durable planning agent for coding workflows running in profile '{profile}'. "
        "Produce a compact JSON plan with keys: artifactType, summary, tasks, files, "
        "acceptanceCriteria, and verificationCommands. "
        "Stay read-only, do not propose speculative edits, and keep the plan implementation-oriented."
    )
    if not feedback:
        return base_prompt
    return (
        f"{base_prompt}\n\n"
        "Incorporate this reviewer feedback into the next plan revision:\n"
        f"{feedback}"
    )


def _call_planner_model(
    *,
    model: Any,
    prompt: str,
    profile: str,
    review_feedback: str | None,
) -> tuple[str, dict[str, Any]]:
    result = model.invoke(
        [
            {
                "role": "system",
                "content": _planner_system_prompt(profile, review_feedback),
            },
            {"role": "user", "content": prompt},
        ]
    )
    text = _coerce_text(result)
    return text, _extract_json_block(text) or _fallback_plan_json(prompt, text)


def _build_planner_graph(*, model: Any, checkpointer: Any | None) -> Any:
    if StateGraph is None or START is None or END is None or interrupt is None:
        raise RuntimeError("LangGraph planner graph APIs are unavailable")

    def draft_plan(state: PlannerState) -> dict[str, Any]:
        plan_markdown, plan_json = _call_planner_model(
            model=model,
            prompt=str(state.get("prompt") or "").strip(),
            profile=str(state.get("profile") or "feature-delivery"),
            review_feedback=str(state.get("reviewFeedback") or "").strip() or None,
        )
        return {
            "planJson": plan_json,
            "planMarkdown": plan_markdown,
            "plannerStatus": "drafted",
            "revision": int(state.get("revision") or 0) + 1,
            "reviewAction": "",
            "reviewDecision": None,
            "approved": False,
            "rejected": False,
        }

    def review_plan(state: PlannerState) -> dict[str, Any] | Command:
        if not state.get("requiresReview"):
            return {
                "plannerStatus": "approved",
                "approved": True,
                "reviewAction": "approve",
                "reviewDecision": {"action": "approve", "approved": True},
            }

        decision = _normalize_planner_resume(interrupt(_planner_review_payload(state)))
        if decision is None:
            return {
                "plannerStatus": "awaiting_review",
                "reviewAction": "",
            }

        action = str(decision.get("action") or "").strip().lower()
        if action == "edit":
            feedback = (
                str(decision.get("feedback") or decision.get("reason") or "").strip()
                or "Revise the plan based on reviewer feedback."
            )
            if Command is not None:
                return Command(
                    goto="draft_plan",
                    update={
                        "plannerStatus": "revising",
                        "reviewAction": "edit",
                        "reviewFeedback": feedback,
                        "reviewDecision": decision,
                    },
                )
            return {
                "plannerStatus": "revising",
                "reviewAction": "edit",
                "reviewFeedback": feedback,
                "reviewDecision": decision,
            }

        approved = action == "approve"
        return {
            "plannerStatus": "approved" if approved else "rejected",
            "reviewAction": action,
            "reviewDecision": decision,
            "approved": approved,
            "rejected": not approved,
        }

    def finalize_plan(state: PlannerState) -> dict[str, Any]:
        return {
            "plannerStatus": "approved",
            "approved": True,
        }

    def route_after_draft(state: PlannerState) -> str:
        return "review_plan" if bool(state.get("requiresReview")) else "finalize_plan"

    def route_after_review(state: PlannerState) -> str:
        action = str(state.get("reviewAction") or "").strip().lower()
        if action == "edit":
            return "draft_plan"
        if bool(state.get("approved")):
            return "finalize_plan"
        return END

    builder = StateGraph(PlannerState)
    builder.add_node("draft_plan", draft_plan)
    builder.add_node("review_plan", review_plan)
    builder.add_node("finalize_plan", finalize_plan)
    builder.add_edge(START, "draft_plan")
    builder.add_conditional_edges("draft_plan", route_after_draft)
    builder.add_conditional_edges("review_plan", route_after_review)
    builder.add_edge("finalize_plan", END)
    return builder.compile(checkpointer=checkpointer)


def _coerce_planner_checkpoint_id(graph: Any, config: dict[str, Any] | None) -> str | None:
    if config is None:
        return None
    try:
        state = graph.get_state(config)
    except Exception:
        return None
    if not state:
        return None
    configurable = getattr(state, "config", {}).get("configurable", {})
    checkpoint_id = str(configurable.get("checkpoint_id") or "").strip()
    return checkpoint_id or None


def _run_planning_pass(
    *,
    prompt: str,
    model: Any,
    profile: str,
    thread_id: str | None,
    planner_resume: dict[str, Any] | None = None,
    require_review: bool = False,
) -> LangGraphRunResult:
    checkpointer = _build_checkpointer()
    graph = _build_planner_graph(model=model, checkpointer=checkpointer)
    invoke_config = (
        {"configurable": {"thread_id": thread_id}}
        if thread_id
        else None
    )
    invoke_input: dict[str, Any] | Command = {
        "prompt": prompt,
        "profile": profile,
        "requiresReview": require_review,
        "plannerStatus": "drafting",
        "revision": 0,
    }
    normalized_resume = _normalize_planner_resume(planner_resume)
    if normalized_resume is not None and Command is not None:
        invoke_input = Command(resume=normalized_resume)
    result = graph.invoke(
        invoke_input,
        config=invoke_config,
        durability="sync",
    )
    planner_state = result if isinstance(result, dict) else {}
    interrupts = planner_state.get("__interrupt__") if isinstance(planner_state, dict) else None
    checkpoint_id = _coerce_planner_checkpoint_id(graph, invoke_config)
    planner_status = "awaiting_review" if interrupts else str(planner_state.get("plannerStatus") or "approved")
    review_decision = (
        planner_state.get("reviewDecision")
        if isinstance(planner_state.get("reviewDecision"), dict)
        else None
    )
    return LangGraphRunResult(
        text=str(planner_state.get("planMarkdown") or "").strip(),
        structured_output=(
            planner_state.get("planJson")
            if isinstance(planner_state.get("planJson"), dict)
            else None
        ),
        tool_summary={},
        metadata={
            "engine": LANGGRAPH_ENGINE_NAME,
            "phase": "plan",
            "profile": profile,
            "toolGroup": "read_only",
            "subagents": [],
            "planner": "checkpointed-graph",
            "threadId": thread_id,
            "planningThreadId": thread_id,
            "sessionPersistence": "dapr-checkpointer" if checkpointer is not None else None,
            "checkpointStoreName": LANGGRAPH_CHECKPOINT_STORE_NAME if checkpointer is not None else None,
            "checkpointKeyPrefix": LANGGRAPH_CHECKPOINT_KEY_PREFIX if checkpointer is not None else None,
            "plannerStatus": planner_status,
            "plannerCheckpointId": checkpoint_id,
            "requiresReview": require_review,
            "reviewDecision": review_decision,
            "approvalPayload": _planner_review_payload(planner_state) if interrupts else None,
            "resumable": bool(interrupts),
        },
    )


def _build_system_prompt(phase: str, profile: str) -> str:
    if phase == "plan":
        return (
            "You are a durable coding planner. "
            "Use the todo list, produce structured plans, and make planning state explicit."
        )
    if phase == "verify":
        return LANGGRAPH_SUMMARIZE_PROMPT
    return (
        f"You are a durable coding agent running in profile '{profile}'. "
        "Use the todo list, delegate focused work to subagents when useful, "
        "make minimal code changes, and verify the result before finishing."
    )


def run_langgraph_task(
    *,
    prompt: str,
    workspace_root: str,
    tool_group: str,
    model: str,
    profile: str,
    phase: str,
    thread_id: str | None = None,
    planner_resume: dict[str, Any] | None = None,
    require_review: bool = False,
    api_key: str | None = None,
    progress_callback: ProgressCallback | None = None,
    openshell_config: dict[str, Any] | None = None,
    sandbox_name_hint: str | None = None,
) -> LangGraphRunResult:
    if not is_langgraph_available():
        raise RuntimeError("LangGraph Deep Agents engine is not installed")

    lang_model = _build_model(model, api_key)
    lang_model = _attach_progress_hooks(
        lang_model,
        phase=phase,
        progress_callback=progress_callback,
    )
    openshell_context = (
        OpenShellToolContext.from_config(openshell_config)
        if isinstance(openshell_config, dict)
        else None
    )

    if phase == "plan":
        planning_prompt = prompt
        if openshell_context is not None:
            repo_context = openshell_context.collect_repo_context()
            if repo_context:
                planning_prompt = (
                    f"{prompt}\n\nRepository context captured from the OpenShell sandbox:\n"
                    f"```text\n{repo_context[:12000]}\n```"
                )
        try:
            return _run_planning_pass(
                prompt=planning_prompt,
                model=lang_model,
                profile=profile,
                thread_id=thread_id,
                planner_resume=planner_resume,
                require_review=require_review,
            )
        finally:
            if openshell_context is not None:
                openshell_context.cleanup()

    effective_tool_group = _effective_tool_group(phase, tool_group)
    effective_subagents = (
        []
        if openshell_context is not None
        else _effective_subagents(phase, workspace_root)
    )
    checkpointer = _build_checkpointer()
    token = None
    context: ToolRuntimeContext | None = None
    try:
        if openshell_context is None:
            context = ToolRuntimeContext.from_workspace_root(workspace_root)
            token = push_tool_context(context)
            tools = _bind_workspace_tools(
                effective_tool_group,
                workspace_root,
                progress_callback=progress_callback,
            )
        else:
            tools = _bind_openshell_tools(
                openshell_context,
                progress_callback=progress_callback,
            )
        graph = create_deep_agent(
            model=lang_model,
            tools=tools,
            system_prompt=(
                _build_system_prompt(phase, profile)
                + (
                    " You are operating inside an OpenShell sandbox. Use the shell tool for all repository inspection, edits, and verification."
                    if openshell_context is not None
                    else ""
                )
            ),
            subagents=effective_subagents,
            checkpointer=checkpointer,
        )
        invoke_payload = {
            "messages": [
                {
                    "role": "user",
                    "content": prompt,
                }
            ]
        }
        invoke_config = (
            {"configurable": {"thread_id": thread_id}}
            if thread_id
            else None
        )
        if invoke_config is None:
            result = graph.invoke(invoke_payload)
        else:
            result = graph.invoke(invoke_payload, config=invoke_config)
    finally:
        if token is not None:
            pop_tool_context(token)
        if openshell_context is not None:
            openshell_context.cleanup()

    return LangGraphRunResult(
        text=_coerce_text(result),
        structured_output=_coerce_structured_output(result),
        tool_summary=(
            openshell_context.build_summary()
            if openshell_context is not None
            else context.build_summary() if context is not None else {}
        ),
        metadata={
            "engine": LANGGRAPH_ENGINE_NAME,
            "phase": phase,
            "profile": profile,
            "toolGroup": effective_tool_group,
            "subagents": [agent.get("name") for agent in effective_subagents],
            "threadId": thread_id,
            "executionThreadId": thread_id,
            "toolBackend": "openshell" if openshell_context is not None else "local",
            "sandboxName": (
                openshell_context.sandbox_name if openshell_context is not None
                else sandbox_name_hint
            ),
            "provider": openshell_context.provider if openshell_context is not None else None,
            "sessionPersistence": "dapr-checkpointer" if checkpointer is not None else None,
            "checkpointStoreName": LANGGRAPH_CHECKPOINT_STORE_NAME if checkpointer is not None else None,
            "checkpointKeyPrefix": LANGGRAPH_CHECKPOINT_KEY_PREFIX if checkpointer is not None else None,
        },
    )

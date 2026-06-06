from __future__ import annotations

import asyncio
import base64
import dataclasses
import json
import logging
import os
import shutil
import subprocess
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any, Mapping
from uuid import NAMESPACE_URL, uuid5

from claude_agent_sdk import ClaudeAgentOptions, query

logger = logging.getLogger(__name__)

TOOLS_PRESET = {"type": "preset", "preset": "claude_code"}
SYSTEM_PROMPT_PRESET = {"type": "preset", "preset": "claude_code"}
DEFAULT_MODEL = os.environ.get("CLAUDE_AGENT_PY_DEFAULT_MODEL", "claude-opus-4-8")
DEFAULT_PERMISSION_MODE = os.environ.get(
    "CLAUDE_AGENT_PY_PERMISSION_MODE", "bypassPermissions"
)
DEFAULT_CWD = os.environ.get("AGENT_LOCAL_SANDBOX_ROOT", "/sandbox")
DEFAULT_CLI_PATH = os.environ.get("CLAUDE_AGENT_SDK_CLI_PATH") or None
OPENSHELL_AGENT_RUNTIME_URL = os.environ.get(
    "OPENSHELL_AGENT_RUNTIME_URL",
    "http://openshell-agent-runtime.openshell.svc.cluster.local:8083",
)
OUTPUT_SYNC_MAX_FILES = int(os.environ.get("CLAUDE_AGENT_OUTPUT_SYNC_MAX_FILES", "250"))
OUTPUT_SYNC_MAX_FILE_BYTES = int(
    os.environ.get("CLAUDE_AGENT_OUTPUT_SYNC_MAX_FILE_BYTES", str(1024 * 1024))
)
OUTPUT_SYNC_MAX_TOTAL_BYTES = int(
    os.environ.get("CLAUDE_AGENT_OUTPUT_SYNC_MAX_TOTAL_BYTES", str(10 * 1024 * 1024))
)
SWEBENCH_PATCH_EXCLUDE_PATHS = [
    ":(exclude)**/tests/**",
    ":(exclude)tests/**",
    ":(exclude)test/**",
    ":(exclude)testing/**",
    ":(exclude)**/test_*.py",
    ":(exclude)**/*_test.py",
    ":(exclude)**/conftest.py",
    ":(exclude)**/fixtures/**",
]


def clean_string(value: Any) -> str | None:
    return value.strip() if isinstance(value, str) and value.strip() else None


def _record(value: Any) -> dict[str, Any]:
    return dict(value) if isinstance(value, Mapping) else {}


def normalize_claude_model(model_spec: Any) -> str | None:
    raw = clean_string(model_spec)
    if not raw:
        raw = clean_string(DEFAULT_MODEL)
    if not raw:
        return None
    if raw.startswith("anthropic/"):
        return raw.split("/", 1)[1]
    if raw.startswith("claude-"):
        return raw
    fallback = clean_string(DEFAULT_MODEL)
    if fallback and fallback.startswith("anthropic/"):
        return fallback.split("/", 1)[1]
    return fallback


def normalize_permission_mode(value: Any) -> str:
    raw = clean_string(value) or DEFAULT_PERMISSION_MODE
    if raw == "bypass":
        return "bypassPermissions"
    if raw in {
        "default",
        "acceptEdits",
        "plan",
        "bypassPermissions",
        "dontAsk",
        "auto",
    }:
        return raw
    return "bypassPermissions"


def bounded_int(value: Any, *, default: int, minimum: int, maximum: int) -> int:
    if isinstance(value, bool):
        return default
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        return default
    return max(minimum, min(maximum, parsed))


def resolve_cwd(value: Any) -> Path:
    root = Path(DEFAULT_CWD)
    raw = clean_string(value)
    if raw:
        path = Path(raw)
        if not path.is_absolute():
            path = root / path
    else:
        path = root
    path.mkdir(parents=True, exist_ok=True)
    return path


def _is_within(path: Path, root: Path) -> bool:
    try:
        path.resolve().relative_to(root.resolve())
    except ValueError:
        return False
    return True


def _safe_sync_source(source: Any, cwd: Path) -> Path | None:
    raw = clean_string(source)
    if not raw:
        return None
    candidate = Path(raw)
    if not candidate.is_absolute():
        candidate = cwd / candidate
    candidate = candidate.resolve()
    root = Path(DEFAULT_CWD).resolve()
    if not _is_within(candidate, root):
        raise ValueError(f"outputSync source is outside sandbox root: {candidate}")
    return candidate


def _safe_sync_target(target: Any, source: Path, cwd: Path) -> Path:
    raw = clean_string(target)
    if raw:
        candidate = Path(raw)
        if not candidate.is_absolute():
            candidate = cwd / candidate
    else:
        candidate = source
    if not candidate.is_absolute():
        candidate = cwd / candidate
    candidate = candidate.resolve()
    root = Path(DEFAULT_CWD).resolve()
    if not _is_within(candidate, root):
        raise ValueError(f"outputSync target is outside sandbox root: {candidate}")
    return candidate


def _iter_sync_files(source: Path) -> list[Path]:
    if source.is_file():
        return [source]
    if not source.exists():
        return []
    return sorted(path for path in source.rglob("*") if path.is_file())


def collect_output_sync_files(
    input_data: Mapping[str, Any],
    cwd: Path,
) -> tuple[list[dict[str, Any]], list[str]]:
    output_sync = _record(input_data.get("outputSync"))
    raw_paths = output_sync.get("paths")
    if not isinstance(raw_paths, list) or not raw_paths:
        return [], []

    files: list[dict[str, Any]] = []
    warnings: list[str] = []
    total_bytes = 0
    for item in raw_paths:
        if not isinstance(item, Mapping):
            continue
        source = _safe_sync_source(item.get("source") or item.get("path"), cwd)
        if source is None:
            continue
        target_root = _safe_sync_target(item.get("target"), source, cwd)
        source_files = _iter_sync_files(source)
        if not source_files:
            warnings.append(f"outputSync source did not match files: {source}")
            continue
        for file_path in source_files:
            if len(files) >= OUTPUT_SYNC_MAX_FILES:
                warnings.append(f"outputSync file limit reached: {OUTPUT_SYNC_MAX_FILES}")
                return files, warnings
            size = file_path.stat().st_size
            if size > OUTPUT_SYNC_MAX_FILE_BYTES:
                warnings.append(f"outputSync skipped oversized file: {file_path}")
                continue
            if total_bytes + size > OUTPUT_SYNC_MAX_TOTAL_BYTES:
                warnings.append(f"outputSync total byte limit reached: {OUTPUT_SYNC_MAX_TOTAL_BYTES}")
                return files, warnings
            relative = file_path.relative_to(source) if source.is_dir() else Path(file_path.name)
            target_path = target_root / relative if source.is_dir() else target_root
            files.append(
                {
                    "path": str(target_path),
                    "contentB64": base64.b64encode(file_path.read_bytes()).decode("ascii"),
                    "mode": file_path.stat().st_mode & 0o777,
                }
            )
            total_bytes += size
    return files, warnings


def sync_outputs_to_workspace(input_data: Mapping[str, Any], cwd: Path) -> dict[str, Any] | None:
    output_sync = _record(input_data.get("outputSync"))
    if not output_sync:
        return None
    workspace_ref = clean_string(output_sync.get("workspaceRef")) or clean_string(
        input_data.get("workspaceRef")
    )
    if not workspace_ref:
        return {"success": False, "error": "outputSync requires workspaceRef"}

    files, warnings = collect_output_sync_files(input_data, cwd)
    if not files:
        return {"success": True, "files": [], "warnings": warnings}

    payload = {
        "workspaceRef": workspace_ref,
        "files": files,
        "timeoutMs": output_sync.get("timeoutMs") or 120000,
    }
    request = urllib.request.Request(
        f"{OPENSHELL_AGENT_RUNTIME_URL.rstrip('/')}/api/workspaces/materialize-files",
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=180) as response:
            body = response.read().decode("utf-8", errors="replace")
            status = int(getattr(response, "status", 200) or 200)
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")
        return {
            "success": False,
            "error": f"openshell materialize failed ({exc.code}): {detail[:500]}",
            "warnings": warnings,
        }
    except Exception as exc:  # noqa: BLE001
        return {"success": False, "error": str(exc), "warnings": warnings}

    try:
        parsed = json.loads(body) if body.strip() else {}
    except json.JSONDecodeError:
        parsed = {"raw": body[:500]}
    success = 200 <= status < 300 and parsed.get("success") is not False
    return {
        "success": success,
        "files": [entry["path"] for entry in files],
        "fileCount": len(files),
        "warnings": warnings,
        "response": parsed,
    }


def swebench_environment(input_data: Mapping[str, Any]) -> dict[str, Any] | None:
    environment_config = _record(input_data.get("environmentConfig"))
    environment = _record(environment_config.get("swebenchInferenceEnvironment"))
    repo = clean_string(environment.get("repo"))
    base_commit = clean_string(environment.get("baseCommit"))
    if not repo or "/" not in repo or not base_commit:
        return None
    return environment


def _run_git(
    args: list[str],
    *,
    cwd: Path | None = None,
    timeout: int = 300,
) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ["git", *args],
        cwd=str(cwd) if cwd else None,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        timeout=timeout,
        check=True,
    )


def _is_safe_swebench_cwd(path: Path) -> bool:
    root = Path(DEFAULT_CWD).resolve()
    resolved = path.resolve()
    return resolved != root and resolved.is_relative_to(root)


def bootstrap_swebench_repository(
    input_data: Mapping[str, Any],
    cwd: Path,
) -> dict[str, Any] | None:
    environment = swebench_environment(input_data)
    if not environment:
        return None

    repo = clean_string(environment.get("repo")) or ""
    base_commit = clean_string(environment.get("baseCommit")) or ""
    if not _is_safe_swebench_cwd(cwd):
        raise ValueError(
            f"Refusing to bootstrap SWE-bench repository outside sandbox root: {cwd}"
        )

    try:
        current_head = _run_git(
            ["rev-parse", "HEAD"],
            cwd=cwd,
            timeout=30,
        ).stdout.strip()
    except (subprocess.CalledProcessError, FileNotFoundError, subprocess.TimeoutExpired):
        current_head = ""

    if current_head == base_commit:
        _run_git(["clean", "-fdx"], cwd=cwd, timeout=120)
        return {"repo": repo, "baseCommit": base_commit, "bootstrapped": False}

    if cwd.exists():
        shutil.rmtree(cwd)
    cwd.mkdir(parents=True, exist_ok=True)

    repo_url = f"https://github.com/{repo}.git"
    _run_git(["init", "-q"], cwd=cwd, timeout=30)
    _run_git(["remote", "add", "origin", repo_url], cwd=cwd, timeout=30)
    try:
        _run_git(
            ["-c", "protocol.version=2", "fetch", "--depth=1", "origin", base_commit],
            cwd=cwd,
        )
    except subprocess.CalledProcessError:
        _run_git(["fetch", "origin", base_commit], cwd=cwd, timeout=900)
    _run_git(["checkout", "--force", "FETCH_HEAD"], cwd=cwd, timeout=120)
    _run_git(["clean", "-fdx"], cwd=cwd, timeout=120)
    return {"repo": repo, "baseCommit": base_commit, "bootstrapped": True}


def capture_git_model_patch(cwd: Path, base_ref: str | None = None) -> str:
    if not (cwd / ".git").exists():
        return ""
    refs = [base_ref, "HEAD"] if base_ref else ["HEAD"]
    for ref in refs:
        cleaned_ref = clean_string(ref)
        if not cleaned_ref:
            continue
        try:
            diff = _run_git(
                ["diff", "--binary", cleaned_ref, "--", ".", *SWEBENCH_PATCH_EXCLUDE_PATHS],
                cwd=cwd,
                timeout=120,
            ).stdout
        except (subprocess.CalledProcessError, FileNotFoundError, subprocess.TimeoutExpired):
            continue
        if "diff --git" in diff:
            return diff
    return ""


def workflow_session_uuid(session_id: str | None, workflow_instance_id: str | None) -> str | None:
    seed = clean_string(session_id) or clean_string(workflow_instance_id)
    if not seed:
        return None
    return str(uuid5(NAMESPACE_URL, f"workflow-builder:{seed}"))


def system_prompt_config(rendered_system: Any) -> dict[str, str]:
    append = clean_string(rendered_system)
    if not append:
        return dict(SYSTEM_PROMPT_PRESET)
    return {
        "type": "preset",
        "preset": "claude_code",
        "append": append,
    }


def build_claude_options(input_data: Mapping[str, Any]) -> ClaudeAgentOptions:
    agent_config = input_data.get("agentConfig")
    if not isinstance(agent_config, Mapping):
        agent_config = {}
    cwd = resolve_cwd(input_data.get("cwd") or agent_config.get("cwd"))
    max_turns = bounded_int(
        input_data.get("maxTurns") or input_data.get("maxIterations") or agent_config.get("maxTurns"),
        default=80,
        minimum=1,
        maximum=400,
    )
    env: dict[str, str] = {
        "CLAUDE_AGENT_SDK_CLIENT_APP": os.environ.get(
            "CLAUDE_AGENT_SDK_CLIENT_APP", "workflow-builder-claude-agent-py/0.1.0"
        ),
    }
    if session_id := clean_string(input_data.get("sessionId")):
        env["WORKFLOW_BUILDER_SESSION_ID"] = session_id
    if workflow_id := clean_string(input_data.get("workflowExecutionId")):
        env["WORKFLOW_BUILDER_WORKFLOW_EXECUTION_ID"] = workflow_id

    return ClaudeAgentOptions(
        tools=dict(TOOLS_PRESET),
        system_prompt=system_prompt_config(input_data.get("renderedSystem")),
        permission_mode=normalize_permission_mode(
            input_data.get("permissionMode") or agent_config.get("permissionMode")
        ),
        max_turns=max_turns,
        model=normalize_claude_model(agent_config.get("modelSpec")),
        cwd=str(cwd),
        cli_path=DEFAULT_CLI_PATH,
        session_id=workflow_session_uuid(
            clean_string(input_data.get("sessionId")),
            clean_string(input_data.get("workflowInstanceId")),
        ),
        env=env,
    )


def _json_safe(value: Any) -> Any:
    if dataclasses.is_dataclass(value):
        return _json_safe(dataclasses.asdict(value))
    if isinstance(value, Mapping):
        return {str(k): _json_safe(v) for k, v in value.items()}
    if isinstance(value, list):
        return [_json_safe(item) for item in value]
    if isinstance(value, tuple):
        return [_json_safe(item) for item in value]
    if isinstance(value, (str, int, float, bool)) or value is None:
        return value
    return str(value)


def _message_events(message: Any) -> tuple[list[dict[str, Any]], list[str]]:
    events: list[dict[str, Any]] = []
    text_parts: list[str] = []
    if type(message).__name__ != "AssistantMessage":
        return events, text_parts
    for block in getattr(message, "content", []) or []:
        block_type = type(block).__name__
        if block_type == "TextBlock":
            text = clean_string(getattr(block, "text", None))
            if text:
                text_parts.append(text)
        elif block_type == "ToolUseBlock":
            tool_id = clean_string(getattr(block, "id", None))
            events.append(
                {
                    "type": "tool_call_start",
                    "data": {
                        "toolCallId": tool_id,
                        "toolName": getattr(block, "name", None),
                        "args": _json_safe(getattr(block, "input", {}) or {}),
                    },
                    "sourceEventId": f"tool-use:{tool_id}" if tool_id else None,
                }
            )
    return events, text_parts


async def run_claude_sdk_turn_async(input_data: Mapping[str, Any]) -> dict[str, Any]:
    prompt = clean_string(input_data.get("prompt"))
    if not prompt:
        return {
            "success": False,
            "error": "Claude SDK turn requires a non-empty prompt",
            "finalText": "",
            "messages": [],
            "events": [],
        }

    options = build_claude_options(input_data)
    cwd_path = Path(options.cwd)
    swebench_bootstrap: dict[str, Any] | None = None
    try:
        swebench_bootstrap = bootstrap_swebench_repository(input_data, cwd_path)
    except Exception as exc:  # noqa: BLE001
        logger.exception("[claude-sdk] SWE-bench repository bootstrap failed")
        return {
            "success": False,
            "error": f"SWE-bench repository bootstrap failed: {exc}",
            "finalText": "",
            "messages": [],
            "events": [],
            "cwd": str(cwd_path),
        }
    sdk_messages: list[dict[str, Any]] = []
    assistant_text_parts: list[str] = []
    events: list[dict[str, Any]] = []
    result_message: dict[str, Any] | None = None
    sdk_session_id: str | None = None
    stderr_lines: list[str] = []

    def on_stderr(line: str) -> None:
        if line.strip():
            stderr_lines.append(line[-2000:])

    options.stderr = on_stderr

    try:
        async for message in query(prompt=prompt, options=options):
            sdk_messages.append(_json_safe(message))
            message_events, message_text = _message_events(message)
            events.extend(message_events)
            assistant_text_parts.extend(message_text)
            if type(message).__name__ == "ResultMessage":
                result_message = _json_safe(message)
                sdk_session_id = clean_string(getattr(message, "session_id", None))
    except Exception as exc:  # noqa: BLE001
        logger.exception("[claude-sdk] query failed")
        return {
            "success": False,
            "error": str(exc),
            "finalText": "",
            "messages": sdk_messages,
            "events": events,
            "stderr": stderr_lines[-20:],
        }

    result_text = ""
    if result_message and isinstance(result_message.get("result"), str):
        result_text = result_message["result"].strip()
    final_text = result_text or "\n\n".join(assistant_text_parts).strip()
    if final_text:
        events.append(
            {
                "type": "llm_complete",
                "data": {
                    "content": final_text,
                    "sdkSessionId": sdk_session_id,
                    "numTurns": result_message.get("num_turns") if result_message else None,
                    "totalCostUsd": result_message.get("total_cost_usd") if result_message else None,
                    "usage": result_message.get("usage") if result_message else None,
                },
                "sourceEventId": f"claude-result:{sdk_session_id}" if sdk_session_id else None,
            }
        )

    is_error = bool(result_message.get("is_error")) if result_message else False
    model_patch = capture_git_model_patch(
        cwd_path,
        clean_string(swebench_bootstrap.get("baseCommit")) if swebench_bootstrap else None,
    )
    output_sync = None
    if not is_error:
        output_sync = sync_outputs_to_workspace(input_data, cwd_path)
        if output_sync and not output_sync.get("success", False):
            return {
                "success": False,
                "error": f"outputSync failed: {output_sync.get('error') or 'unknown error'}",
                "finalText": final_text,
                "modelPatch": model_patch,
                "messages": sdk_messages,
                "events": events,
                "sdkSessionId": sdk_session_id,
                "result": result_message,
                "stderr": stderr_lines[-20:],
                "cwd": str(cwd_path),
                "workspaceRef": input_data.get("workspaceRef"),
                "sandboxName": input_data.get("sandboxName"),
                "runtimeSandboxName": input_data.get("runtimeSandboxName"),
                "swebench": swebench_bootstrap,
                "outputSync": output_sync,
            }
    return {
        "success": not is_error,
        "error": "; ".join(result_message.get("errors") or []) if is_error and result_message else None,
        "finalText": final_text,
        "modelPatch": model_patch,
        "messages": sdk_messages,
        "events": events,
        "sdkSessionId": sdk_session_id,
        "result": result_message,
        "stderr": stderr_lines[-20:],
        "cwd": str(cwd_path),
        "workspaceRef": input_data.get("workspaceRef"),
        "sandboxName": input_data.get("sandboxName"),
        "runtimeSandboxName": input_data.get("runtimeSandboxName"),
        "swebench": swebench_bootstrap,
        "outputSync": output_sync,
    }


def run_claude_sdk_turn_activity(
    _ctx_or_input: Any,
    input_data: dict[str, Any] | None = None,
) -> dict[str, Any]:
    payload = input_data if input_data is not None else _ctx_or_input
    return asyncio.run(run_claude_sdk_turn_async(payload))

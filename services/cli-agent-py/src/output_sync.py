"""Copy selected CLI runtime outputs into a retained OpenShell workspace."""

from __future__ import annotations

import base64
import json
import os
import posixpath
import shlex
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any, Mapping

DEFAULT_TIMEOUT_SECONDS = 120
DEFAULT_MAX_BYTES = 64 * 1024 * 1024
DEFAULT_CWD = "/sandbox"
DEFAULT_OPENSHELL_RUNTIME_URL = (
    "http://openshell-agent-runtime.openshell.svc.cluster.local:8083"
)
INLINE_CONTENT_B64_LIMIT = 12_000


def _record(value: Any) -> dict[str, Any]:
    return dict(value) if isinstance(value, Mapping) else {}


def _clean_string(value: Any) -> str | None:
    return value.strip() if isinstance(value, str) and value.strip() else None


def _local_root() -> Path:
    return Path(os.environ.get("AGENT_LOCAL_SANDBOX_ROOT", "/sandbox")).resolve()


def _resolved_local_path(raw: str) -> Path:
    candidate = Path(raw)
    if not candidate.is_absolute():
        candidate = _local_root() / candidate
    resolved = candidate.resolve()
    root = _local_root()
    try:
        resolved.relative_to(root)
    except ValueError as exc:
        raise ValueError(f"outputSync source must be under {root}: {raw}") from exc
    return resolved


def _normalized_target(raw: str) -> str:
    value = raw.strip() or "/sandbox"
    if not value.startswith("/"):
        value = posixpath.join("/sandbox", value)
    normalized = posixpath.normpath(value)
    if normalized in {"", "/"} or not normalized.startswith("/sandbox"):
        raise ValueError(f"outputSync target must be under /sandbox: {raw}")
    return normalized


def _tree_size(path: Path) -> int:
    if path.is_file():
        return path.stat().st_size
    total = 0
    for item in path.rglob("*"):
        if item.is_file():
            total += item.stat().st_size
    return total


def _timeout_seconds(config: Mapping[str, Any]) -> int:
    if config.get("timeoutSeconds") is not None:
        raw = config.get("timeoutSeconds")
        unit = "seconds"
    elif config.get("timeoutMs") is not None:
        raw = config.get("timeoutMs")
        unit = "milliseconds"
    else:
        return DEFAULT_TIMEOUT_SECONDS
    value = float(raw)
    if value <= 0:
        raise ValueError("outputSync timeout must be positive")
    if unit == "milliseconds":
        return max(1, int((value + 999) // 1000))
    return max(1, int(value))


def _post_workspace_command(
    *,
    workspace_ref: str,
    command: str,
    timeout_seconds: int,
) -> dict[str, Any]:
    timeout_ms = max(1, int(timeout_seconds * 1000))
    runtime_url = os.environ.get(
        "OPENSHELL_AGENT_RUNTIME_URL", DEFAULT_OPENSHELL_RUNTIME_URL
    ).rstrip("/")
    request = urllib.request.Request(
        f"{runtime_url}/api/workspaces/command",
        data=json.dumps(
            {
                "workspaceRef": workspace_ref,
                "command": command,
                "cwd": DEFAULT_CWD,
                "timeoutMs": timeout_ms,
            }
        ).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(
            request, timeout=max(30, timeout_seconds + 30)
        ) as response:
            body = response.read().decode("utf-8", errors="replace")
            status = int(getattr(response, "status", 200) or 200)
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")
        return {
            "ok": False,
            "status": exc.code,
            "error": f"workspace command failed ({exc.code}): {detail[:500]}",
        }
    except Exception as exc:  # noqa: BLE001
        return {"ok": False, "error": str(exc)}

    try:
        parsed = json.loads(body) if body.strip() else {}
    except json.JSONDecodeError:
        parsed = {"raw": body[:500]}
    response_ok = parsed.get("success", parsed.get("ok", True)) is not False
    exit_code = parsed.get("exitCode", parsed.get("exit_code"))
    return {
        "ok": 200 <= status < 300 and response_ok and exit_code in (None, 0),
        "status": status,
        "exitCode": exit_code,
        "response": parsed,
    }


def _workspace_write_command(*, target: str, content_b64: str, mode: int) -> str:
    return "\n".join(
        [
            "set -eu",
            f"target={shlex.quote(target)}",
            'parent="$(dirname "$target")"',
            '[ ! -e "$parent" ] || [ -d "$parent" ] || rm -f "$parent"',
            'mkdir -p "$parent"',
            '[ ! -d "$target" ] || rm -rf "$target"',
            'tmp="$(mktemp "${target}.tmp.XXXXXX")"',
            'trap \'rm -f "$tmp"\' EXIT',
            'base64 -d > "$tmp" <<\'__WFB_OUTPUT_SYNC_B64__\'',
            content_b64,
            "__WFB_OUTPUT_SYNC_B64__",
            f"chmod {mode & 0o777:03o} \"$tmp\"",
            'mv "$tmp" "$target"',
            "trap - EXIT",
        ]
    )


def _workspace_chunked_write_commands(
    *, target: str, content_b64: str, mode: int
) -> list[str]:
    target_q = shlex.quote(target)
    init = "\n".join(
        [
            "set -eu",
            f"target={target_q}",
            'parent="$(dirname "$target")"',
            '[ ! -e "$parent" ] || [ -d "$parent" ] || rm -f "$parent"',
            'mkdir -p "$parent"',
            '[ ! -d "$target" ] || rm -rf "$target"',
            'rm -f -- "${target}.b64.wfbtmp" "${target}.tmp.wfb-output-sync"',
            ': > "${target}.b64.wfbtmp"',
        ]
    )
    commands = [init]
    for idx in range(0, len(content_b64), INLINE_CONTENT_B64_LIMIT):
        chunk = content_b64[idx : idx + INLINE_CONTENT_B64_LIMIT]
        commands.append(
            "\n".join(
                [
                    "set -eu",
                    f"target={target_q}",
                    'cat >> "${target}.b64.wfbtmp" <<\'__WFB_OUTPUT_SYNC_B64_CHUNK__\'',
                    chunk,
                    "__WFB_OUTPUT_SYNC_B64_CHUNK__",
                ]
            )
        )
    commands.append(
        "\n".join(
            [
                "set -eu",
                f"target={target_q}",
                'base64 -d "${target}.b64.wfbtmp" > "${target}.tmp.wfb-output-sync"',
                'rm -f -- "${target}.b64.wfbtmp"',
                f"chmod {mode & 0o777:03o} \"${{target}}.tmp.wfb-output-sync\"",
                'mv "${target}.tmp.wfb-output-sync" "$target"',
            ]
        )
    )
    return commands


def _workspace_write_commands(*, target: str, content_b64: str, mode: int) -> list[str]:
    if len(content_b64) <= INLINE_CONTENT_B64_LIMIT:
        return [
            _workspace_write_command(
                target=target,
                content_b64=content_b64,
                mode=mode,
            )
        ]
    return _workspace_chunked_write_commands(
        target=target,
        content_b64=content_b64,
        mode=mode,
    )


def _workspace_prepare_command(*, target: str, source_is_dir: bool) -> str:
    target_parent = posixpath.dirname(target.rstrip("/")) or "/sandbox"
    commands = [
        "set -eu",
        f"target={shlex.quote(target)}",
        f"parent={shlex.quote(target_parent)}",
        'mkdir -p "$parent"',
        'rm -rf -- "$target"',
    ]
    if source_is_dir:
        commands.append('mkdir -p "$target"')
    return "\n".join(commands)


def _collect_files(source: Path, target: str, max_bytes: int) -> list[dict[str, Any]]:
    if not source.exists():
        raise FileNotFoundError(f"outputSync source does not exist: {source}")
    size = _tree_size(source)
    if size > max_bytes:
        raise ValueError(
            f"outputSync source {source} is {size} bytes; max is {max_bytes} bytes"
        )

    files: list[dict[str, Any]] = []
    if source.is_file():
        targets = [(source, target)]
    else:
        targets = [
            (
                file_path,
                posixpath.join(
                    target,
                    file_path.relative_to(source).as_posix(),
                ),
            )
            for file_path in sorted(source.rglob("*"))
            if file_path.is_file()
        ]
    for file_path, target_path in targets:
        file_size = file_path.stat().st_size
        files.append(
            {
                "source": str(file_path),
                "target": target_path,
                "contentB64": base64.b64encode(file_path.read_bytes()).decode("ascii"),
                "mode": file_path.stat().st_mode & 0o777,
                "bytes": file_size,
            }
        )
    return files


def _copy_path(
    *,
    workspace_ref: str,
    source: Path,
    target: str,
    timeout_seconds: int,
    max_bytes: int,
) -> dict[str, Any]:
    prepare = _post_workspace_command(
        workspace_ref=workspace_ref,
        command=_workspace_prepare_command(target=target, source_is_dir=source.is_dir()),
        timeout_seconds=timeout_seconds,
    )
    if not prepare.get("ok"):
        return {
            "ok": False,
            "source": str(source),
            "target": target,
            "error": prepare.get("error") or prepare.get("response"),
            "prepare": prepare,
        }

    copied: list[dict[str, Any]] = []
    for file_entry in _collect_files(source, target, max_bytes):
        result: dict[str, Any] = {"ok": True, "exitCode": 0}
        for command in _workspace_write_commands(
            target=str(file_entry["target"]),
            content_b64=str(file_entry["contentB64"]),
            mode=int(file_entry["mode"]),
        ):
            result = _post_workspace_command(
                workspace_ref=workspace_ref,
                command=command,
                timeout_seconds=timeout_seconds,
            )
            if not result.get("ok"):
                break
        copied.append(
            {
                "source": file_entry["source"],
                "target": file_entry["target"],
                "bytes": file_entry["bytes"],
                "ok": result.get("ok"),
                "exitCode": result.get("exitCode"),
                "error": result.get("error"),
            }
        )
        if not result.get("ok"):
            return {
                "ok": False,
                "source": str(source),
                "target": target,
                "copied": copied,
                "error": result.get("error") or result.get("response"),
            }
    return {
        "ok": True,
        "source": str(source),
        "target": target,
        "files": copied,
        "fileCount": len(copied),
    }


def sync_output_activity(
    _ctx_or_input: Any, input_data: dict[str, Any] | None = None
) -> dict[str, Any]:
    payload = input_data if input_data is not None else _ctx_or_input
    data = _record(payload)
    config = _record(data.get("outputSync"))
    paths = config.get("paths")
    if not isinstance(paths, list) or not paths:
        return {"ok": True, "skipped": True, "reason": "no_paths"}

    workspace_ref = (
        _clean_string(config.get("workspaceRef"))
        or _clean_string(data.get("workspaceRef"))
    )
    if not workspace_ref:
        return {"ok": False, "error": "outputSync target workspaceRef is required"}
    sandbox_name = (
        _clean_string(config.get("sandboxName"))
        or _clean_string(data.get("workspaceSandboxName"))
        or _clean_string(data.get("sandboxName"))
    )

    timeout_seconds = _timeout_seconds(config)
    max_bytes = int(config.get("maxBytes") or DEFAULT_MAX_BYTES)

    copied: list[dict[str, Any]] = []
    for item in paths:
        path_config = _record(item)
        source_raw = _clean_string(path_config.get("source"))
        target_raw = _clean_string(path_config.get("target")) or source_raw
        if not source_raw or not target_raw:
            return {"ok": False, "error": "outputSync paths require source and target"}
        copied_item = _copy_path(
            workspace_ref=workspace_ref,
            source=_resolved_local_path(source_raw),
            target=_normalized_target(target_raw),
            timeout_seconds=timeout_seconds,
            max_bytes=max_bytes,
        )
        copied.append(copied_item)
        if not copied_item.get("ok"):
            return {
                "ok": False,
                "workspaceRef": workspace_ref,
                "sandboxName": sandbox_name,
                "copied": copied,
                "error": copied_item.get("error") or "outputSync copy failed",
            }

    return {
        "ok": True,
        "workspaceRef": workspace_ref,
        "sandboxName": sandbox_name,
        "copied": copied,
    }

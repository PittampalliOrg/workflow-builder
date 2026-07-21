"""Request/response content capture for workflow-orchestrator spans.

Emits OpenInference ``input.value`` / ``output.value`` span attributes — the
same convention ``services/dapr-agent-py/src/telemetry/state_tracing.py`` uses
and the Service Graph drill-down drawer (``drilldown-io.svelte`` /
``parseIoValue``) renders. This lets workflow *action* hops carry their actual
request/response payloads, not just size/status metadata.

Gating: **on by default** for these backend hops (the payloads are bounded
JSON, capped at 60 KB and secret-redacted — unlike the agent's image-overflow
concern, span attributes only flow to ClickHouse, never back into an LLM
context). Set ``ENABLE_REQUEST_CONTENT_TRACING=false`` (or ``0``/``no``/``off``)
to opt a service out. ``ENABLE_BETA_TRACING_DETAILED`` truthy also forces it on.

Redaction is conservative: any dict key whose name matches a secret-ish pattern
has its value replaced with ``"[REDACTED]"`` before serialization. The
orchestrator never holds plaintext credentials (function-router owns
decryption), but redaction is applied here too so the helper is reusable and
safe if a payload ever carries a token.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
from typing import Any

# Match dapr-agent-py state_tracing: 60 KB per value.
DEFAULT_MAX_BYTES = 60_000

_TRUTHY = {"1", "true", "yes", "on"}
_FALSY = {"0", "false", "no", "off"}

# Key names whose values must never be serialized into spans.
_REDACT_KEY_RE = re.compile(
    r"(token|secret|password|passwd|api[_-]?key|authorization|auth|credential|"
    r"bearer|private[_-]?key|client[_-]?secret|refresh[_-]?token|access[_-]?token|"
    r"session[_-]?token|cookie|x-api-key)",
    re.IGNORECASE,
)

_REDACTED = "[REDACTED]"
_MAX_REDACT_DEPTH = 12
_MATERIALIZE_ACTIONS = {
    "workspace/materialize-files",
    "workspace/write_file",
}


def _materialized_file_metadata(value: Any) -> dict[str, Any]:
    if not isinstance(value, dict):
        return {"validShape": False}
    metadata: dict[str, Any] = {
        "path": value.get("path") if isinstance(value.get("path"), str) else None,
        "mode": value.get("mode") if isinstance(value.get("mode"), int) else None,
    }
    content = value.get("content")
    content_b64 = value.get("contentB64")
    if isinstance(content, str):
        metadata["contentEncoding"] = "utf8"
        metadata["contentCharacters"] = len(content)
        if len(content) <= 1024 * 1024:
            encoded = content.encode("utf-8")
            metadata["contentBytes"] = len(encoded)
            metadata["contentSha256"] = hashlib.sha256(encoded).hexdigest()
        else:
            metadata["digestOmitted"] = "oversized"
    elif isinstance(content_b64, str):
        metadata["contentEncoding"] = "base64"
        metadata["encodedCharacters"] = len(content_b64)
        if content_b64.isascii() and len(content_b64) <= 6 * 1024 * 1024:
            metadata["encodedBytes"] = len(content_b64)
            metadata["encodedSha256"] = hashlib.sha256(
                content_b64.encode("ascii")
            ).hexdigest()
        else:
            metadata["digestOmitted"] = "oversized-or-non-ascii"
    else:
        metadata["contentEncoding"] = "missing"
    return metadata


def materialize_action_input_for_trace(action_type: str, action_input: Any) -> Any:
    """Replace materialized file bodies with path, size, and digest metadata."""
    if action_type not in _MATERIALIZE_ACTIONS:
        return action_input
    if not isinstance(action_input, dict):
        return {"payload": "[invalid materialize arguments]"}

    tool_id = str(action_input.get("toolId") or action_type.split("/", 1)[1])
    args: Any = action_input
    args_json = action_input.get("argsJson")
    if isinstance(args_json, str):
        try:
            args = json.loads(args_json)
        except (TypeError, ValueError):
            return {
                "toolId": tool_id,
                "payload": "[unparseable materialize arguments]",
            }
    if not isinstance(args, dict):
        return {"toolId": tool_id, "payload": "[invalid materialize arguments]"}

    raw_files = (
        [
            {
                "path": args.get("path"),
                "content": args.get("content"),
                "contentB64": args.get("contentB64"),
                "mode": args.get("mode"),
            }
        ]
        if tool_id == "write_file"
        else args.get("files")
    )
    files = raw_files if isinstance(raw_files, list) else []
    return {
        "toolId": tool_id,
        "workspaceRef": args.get("workspaceRef"),
        "timeoutMs": args.get("timeoutMs"),
        "fileCount": len(files),
        "files": [_materialized_file_metadata(item) for item in files],
    }


def activity_input_for_trace(activity_name: str, data: Any) -> Any:
    """Return an activity input with materialization bodies summarized."""
    if activity_name != "execute_action" or not isinstance(data, dict):
        return data
    node = data.get("node")
    if not isinstance(node, dict):
        return data

    node_data = node.get("data") if isinstance(node.get("data"), dict) else None
    config = node.get("config")
    nested_config = node_data.get("config") if node_data else None
    active_config = config if isinstance(config, dict) and config else nested_config
    if not isinstance(active_config, dict):
        return data
    action_type = str(active_config.get("actionType") or "")
    if action_type not in _MATERIALIZE_ACTIONS:
        return data

    safe = dict(data)
    safe_node = dict(node)
    safe_config = dict(active_config)
    safe_config["input"] = materialize_action_input_for_trace(
        action_type,
        active_config.get("input"),
    )
    if isinstance(config, dict) and config:
        safe_node["config"] = safe_config
    else:
        safe_node_data = dict(node_data or {})
        safe_node_data["config"] = safe_config
        safe_node["data"] = safe_node_data
    safe["node"] = safe_node
    return safe


def activity_output_for_trace(activity_name: str, result: Any) -> Any:
    """Return an activity output with evaluator task file bodies summarized."""
    if activity_name != "evaluate_script" or not isinstance(result, dict):
        return result
    tasks = result.get("tasks")
    if not isinstance(tasks, list):
        return result

    safe_tasks: list[Any] = []
    changed = False
    for task in tasks:
        if not isinstance(task, dict):
            safe_tasks.append(task)
            continue
        action_type = str(task.get("actionSlug") or "")
        if action_type not in _MATERIALIZE_ACTIONS:
            safe_tasks.append(task)
            continue
        safe_task = dict(task)
        safe_task["args"] = materialize_action_input_for_trace(
            action_type,
            task.get("args"),
        )
        safe_tasks.append(safe_task)
        changed = True
    if not changed:
        return result
    safe = dict(result)
    safe["tasks"] = safe_tasks
    return safe


def function_router_request_for_trace(payload: Any) -> Any:
    """Summarize materialized file bodies in a function-router request."""
    if not isinstance(payload, dict):
        return payload
    action_type = str(payload.get("function_slug") or "")
    if action_type not in _MATERIALIZE_ACTIONS:
        return payload
    safe = dict(payload)
    safe["input"] = materialize_action_input_for_trace(
        action_type,
        payload.get("input"),
    )
    return safe


def _is_truthy(value: str | None) -> bool:
    return (value or "").strip().lower() in _TRUTHY


def content_tracing_enabled() -> bool:
    """True when request/response content should be stamped onto spans.

    On by default; only an explicit ``ENABLE_REQUEST_CONTENT_TRACING`` falsy
    value disables it (beta tracing always forces it on).
    """
    if _is_truthy(os.environ.get("ENABLE_BETA_TRACING_DETAILED")):
        return True
    return (os.environ.get("ENABLE_REQUEST_CONTENT_TRACING") or "").strip().lower() not in _FALSY


def redact(obj: Any, _depth: int = 0) -> Any:
    """Deep-copy ``obj`` replacing secret-ish dict values with ``[REDACTED]``."""
    if _depth > _MAX_REDACT_DEPTH:
        return "[redaction-depth-exceeded]"
    if isinstance(obj, dict):
        out: dict[Any, Any] = {}
        for k, v in obj.items():
            if isinstance(k, str) and _REDACT_KEY_RE.search(k):
                out[k] = _REDACTED
            else:
                out[k] = redact(v, _depth + 1)
        return out
    if isinstance(obj, (list, tuple)):
        return [redact(v, _depth + 1) for v in obj]
    return obj


def _serialize(obj: Any) -> str:
    if isinstance(obj, str):
        return obj
    try:
        return json.dumps(obj, default=str, ensure_ascii=False)
    except Exception:
        return str(obj)


def io_attributes(
    prefix: str,
    obj: Any,
    *,
    max_bytes: int = DEFAULT_MAX_BYTES,
) -> dict[str, Any]:
    """Build OpenInference ``<prefix>.value`` attributes for ``obj``.

    ``prefix`` is ``"input"`` or ``"output"``. Returns an empty dict when
    content tracing is disabled or ``obj`` is None, so callers can splat the
    result into ``set_current_span_attrs`` unconditionally.
    """
    if obj is None or not content_tracing_enabled():
        return {}
    serialized = _serialize(redact(obj))
    if not serialized:
        return {}
    encoded = serialized.encode("utf-8")
    truncated = len(encoded) > max_bytes
    value = encoded[:max_bytes].decode("utf-8", errors="ignore") if truncated else serialized
    attrs: dict[str, Any] = {
        f"{prefix}.value": value,
        f"{prefix}.mime_type": "application/json",
    }
    if truncated:
        attrs[f"{prefix}.value_truncated"] = True
        attrs[f"{prefix}.value_original_length"] = len(encoded)
    return attrs

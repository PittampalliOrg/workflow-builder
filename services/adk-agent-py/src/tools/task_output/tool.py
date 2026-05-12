"""TaskOutput tool -- get background task/workflow instance output via Dapr."""

from __future__ import annotations

import json
import os
import urllib.parse
import urllib.request


def task_output(task_id: str, timeout: int = 30000) -> str:
    """Get the output of a background task or workflow instance by its ID."""
    if not task_id or not task_id.strip():
        return "Error: No task_id provided."

    task_id = task_id.strip()

    # Query Dapr state store for workflow state
    store_name = os.environ.get("DAPR_STATE_STORE", "dapr-agent-py-statestore")
    sidecar = (
        f"http://{os.environ.get('DAPR_HOST', '127.0.0.1')}:"
        f"{os.environ.get('DAPR_HTTP_PORT', '3500')}"
    )

    state_key = f"dapr-agent-py:_workflow_{task_id}".lower()
    encoded_key = urllib.parse.quote(state_key, safe="")
    url = (
        f"{sidecar}/v1.0/state/{urllib.parse.quote(store_name, safe='')}/{encoded_key}"
        f"?metadata.partitionKey={encoded_key}"
    )

    try:
        with urllib.request.urlopen(url, timeout=min(timeout / 1000, 30)) as resp:
            raw = resp.read().decode("utf-8")
    except urllib.error.HTTPError as exc:
        if exc.code == 404:
            return f"Error: No workflow state found for task_id '{task_id}'."
        return f"Error: HTTP {exc.code} querying workflow state."
    except Exception as exc:
        return f"Error querying workflow state: {exc}"

    if not raw or raw.strip() in ("", "null"):
        return f"Error: No workflow state found for task_id '{task_id}'."

    try:
        state = json.loads(raw) if isinstance(raw, str) else raw
    except json.JSONDecodeError:
        return f"Raw state: {raw[:500]}"

    if not isinstance(state, dict):
        return f"State: {str(state)[:500]}"

    # Extract useful information
    messages = state.get("messages", [])
    error = state.get("error")
    tool_history = state.get("tool_history", [])

    parts: list[str] = [f"Task ID: {task_id}"]

    if error:
        parts.append(f"Error: {error}")

    # Get the last assistant message as the output
    last_assistant = None
    for msg in reversed(messages):
        role = msg.get("role", "")
        if role == "assistant":
            content = msg.get("content", "")
            if isinstance(content, list):
                text_parts = [
                    b.get("text", "") for b in content if b.get("type") == "text"
                ]
                content = "\n".join(text_parts)
            last_assistant = content
            break

    if last_assistant:
        parts.append(f"\nOutput:\n{last_assistant}")

    parts.append(f"\nMessages: {len(messages)}")
    parts.append(f"Tool calls: {len(tool_history)}")

    return "\n".join(parts)

from .prompt import get_task_output_description
task_output.__doc__ = get_task_output_description()

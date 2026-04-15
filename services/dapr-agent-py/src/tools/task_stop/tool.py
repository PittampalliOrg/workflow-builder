"""TaskStop tool -- stop running tasks/workflow instances via Dapr."""

from __future__ import annotations

import json
import os
import urllib.request


def task_stop(task_id: str) -> str:
    """Stop a running background task or workflow instance."""
    if not task_id or not task_id.strip():
        return "Error: No task_id provided."

    task_id = task_id.strip()

    sidecar = (
        f"http://{os.environ.get('DAPR_HOST', '127.0.0.1')}:"
        f"{os.environ.get('DAPR_HTTP_PORT', '3500')}"
    )

    # Terminate workflow via Dapr Workflow API
    url = f"{sidecar}/v1.0-beta1/workflows/dapr/instances/{task_id}/terminate"

    try:
        req = urllib.request.Request(url, method="POST")
        with urllib.request.urlopen(req, timeout=10) as resp:
            resp.read()
    except urllib.error.HTTPError as exc:
        if exc.code == 404:
            return f"Error: No running workflow found for task_id '{task_id}'."
        if exc.code == 400:
            return f"Error: Workflow '{task_id}' may have already completed or been terminated."
        body = exc.read().decode("utf-8", errors="replace")
        return f"Error: HTTP {exc.code} terminating workflow: {body[:200]}"
    except Exception as exc:
        return f"Error terminating workflow: {exc}"

    return f"Task '{task_id}' has been stopped."

from .prompt import get_task_stop_description
task_stop.__doc__ = get_task_stop_description()

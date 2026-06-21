"""Capture a durable per-run workspace diff at session end and push it to the BFF.

Mirrors browser_video_sync.py: a best-effort, in-pod, session-end activity that
POSTs to a BFF internal ingest with INTERNAL_API_TOKEN. Here we compute a single
unified `git diff <baseline>..<working-tree>` over the CLI workspace (the JuiceFS
`/sandbox/work` mount) and POST it to the run-diff endpoint, which persists the
patch text durably (inline ≤256 KB else gzip→files) so the diff survives sandbox
reap — no live pod, no Gitea.

Baseline resolution:
  - `refs/tags/wfb-baseline` (stamped at clone time by repositories.ts) → shows
    ONLY what the agent changed on a cloned repo.
  - else git's empty-tree SHA → greenfield runs show all created files as adds.

The diff is `.gitignore`-scoped (plus a baked noise exclude) so node_modules/.git
are never walked or diffed — fast on FUSE and meaningful. A temp index keeps the
agent's real index untouched. Never raises.
"""

from __future__ import annotations

import json
import os
import subprocess
import urllib.error
import urllib.request
from typing import Any, Mapping

_WORKFLOW_BUILDER_URL = os.environ.get(
    "WORKFLOW_BUILDER_URL", "http://workflow-builder.nextjs.svc.cluster.local:3000"
).rstrip("/")
_INTERNAL_API_TOKEN = os.environ.get("INTERNAL_API_TOKEN", "")

DEFAULT_REPO_DIR = os.environ.get("CLI_WORKSPACE_DIR", "/sandbox/work")
_GIT_TIMEOUT_SECONDS = int(os.environ.get("CLI_WORKSPACE_DIFF_GIT_TIMEOUT_SECONDS", "120"))
_POST_TIMEOUT_SECONDS = int(os.environ.get("CLI_WORKSPACE_DIFF_POST_TIMEOUT_SECONDS", "120"))
# Hard cap on patch bytes sent over the wire; the BFF also caps + truncates.
_MAX_PATCH_BYTES = int(os.environ.get("CLI_WORKSPACE_DIFF_MAX_BYTES", str(8 * 1024 * 1024)))

_EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904"

# Baked noise exclude for greenfield workspaces that ship no .gitignore. Keeps
# the diff (and `git add`) off dependency/vcs dirs — fast + meaningful.
_NOISE_EXCLUDE = "node_modules/\n.git/\n.venv/\n__pycache__/\ndist/\nbuild/\n.cache/\n.next/\nvendor/\n.pytest_cache/\n"

_BASE_SCRIPT = """
set -e
cd "$REPO" 2>/dev/null || { echo "__WFB_NO_REPO__"; exit 0; }
git rev-parse --is-inside-work-tree >/dev/null 2>&1 || git init -q >/dev/null 2>&1
mkdir -p .git/info
if ! grep -q '^node_modules/$' .git/info/exclude 2>/dev/null; then
  printf '%s' "$NOISE" >> .git/info/exclude
fi
git rev-parse -q --verify refs/tags/wfb-baseline 2>/dev/null || echo "$EMPTY"
"""

_DIFF_SCRIPT = """
set -e
cd "$REPO"
export GIT_INDEX_FILE=/tmp/wfb-diff-index
rm -f "$GIT_INDEX_FILE"
git add -A 2>/dev/null || true
git diff --cached --find-renames --stat --patch --binary "$BASE" -- 2>/dev/null || true
"""


def _record(value: Any) -> dict[str, Any]:
    return dict(value) if isinstance(value, Mapping) else {}


def _clean_string(value: Any) -> str | None:
    return value.strip() if isinstance(value, str) and value.strip() else None


def _run(script: str, env_extra: dict[str, str]) -> str:
    proc = subprocess.run(
        ["bash", "-c", script],
        capture_output=True,
        text=True,
        timeout=_GIT_TIMEOUT_SECONDS,
        env={**os.environ, **env_extra},
        check=False,
    )
    return proc.stdout


def _post_run_diff(execution_id: str, payload: dict[str, Any]) -> tuple[bool, str]:
    body = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        f"{_WORKFLOW_BUILDER_URL}/api/internal/workflows/executions/{execution_id}/run-diff",
        data=body,
        method="POST",
        headers={
            "Content-Type": "application/json",
            "x-internal-token": _INTERNAL_API_TOKEN,
            "Authorization": f"Bearer {_INTERNAL_API_TOKEN}",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=_POST_TIMEOUT_SECONDS) as resp:
            ok = 200 <= int(getattr(resp, "status", 200) or 200) < 300
            return ok, "ok" if ok else f"http {getattr(resp, 'status', '?')}"
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")[:300]
        return False, f"http {exc.code}: {detail}"
    except Exception as exc:  # noqa: BLE001 — best-effort
        return False, str(exc)


def sync_workspace_diff_activity(
    _ctx_or_input: Any, input_data: dict[str, Any] | None = None
) -> dict[str, Any]:
    """Compute the per-run workspace diff and POST it as a durable `diff`
    artifact. Never raises."""
    data = _record(input_data if input_data is not None else _ctx_or_input)

    if not _INTERNAL_API_TOKEN:
        return {"ok": True, "skipped": "no_token"}

    execution_id = _clean_string(data.get("workflowExecutionId"))
    node_id = _clean_string(data.get("nodeId"))
    if not execution_id:
        # No workflow run to attach to (e.g. a direct, non-workflow session).
        return {"ok": True, "skipped": "no_run_context"}

    repo_dir = _clean_string(data.get("repoPath")) or DEFAULT_REPO_DIR
    env_extra = {"REPO": repo_dir, "EMPTY": _EMPTY_TREE, "NOISE": _NOISE_EXCLUDE}

    try:
        base_out = _run(_BASE_SCRIPT, env_extra).strip()
    except Exception as exc:  # noqa: BLE001
        return {"ok": True, "skipped": f"base_failed: {exc}"}
    if base_out == "__WFB_NO_REPO__" or not base_out:
        return {"ok": True, "skipped": "no_workspace"}
    base = base_out.splitlines()[-1].strip() or _EMPTY_TREE

    try:
        patch = _run(_DIFF_SCRIPT, {**env_extra, "BASE": base})
    except Exception as exc:  # noqa: BLE001
        return {"ok": True, "skipped": f"diff_failed: {exc}"}

    if not patch.strip():
        return {"ok": True, "empty": True, "base": base}

    if len(patch.encode("utf-8")) > _MAX_PATCH_BYTES:
        patch = patch.encode("utf-8")[:_MAX_PATCH_BYTES].decode("utf-8", errors="ignore")

    ok, detail = _post_run_diff(
        execution_id,
        {
            "patch": patch,
            "baseRef": ("empty-tree" if base == _EMPTY_TREE else base[:12]),
            "headRef": "working",
            "nodeId": node_id,
            "title": "Workspace changes",
        },
    )
    return {"ok": True, "posted": ok, "detail": detail, "base": base}

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
# the diff (and `git add`) off dependency/vcs dirs — fast + meaningful. Includes
# the JuiceFS mount-root magic control files (.accesslog/.config/.stats/.trash),
# which are root-owned + unreadable by the agent user and otherwise make
# `git add -A` abort ("Permission denied").
_NOISE_EXCLUDE = "node_modules/\n.git/\n.venv/\n__pycache__/\ndist/\nbuild/\n.cache/\n.next/\nvendor/\n.pytest_cache/\n.accesslog\n.config\n.stats\n.trash/\n"

# `git config --add safe.directory '*'`: the workspace dir is often root-owned
# (JuiceFS mount) while git runs as the agent user → git aborts with "detected
# dubious ownership". Trust all repos for these throwaway in-pod captures.
_SAFE_DIR = "git config --global --add safe.directory '*' 2>/dev/null || true"

# Single-pass capture: discover the working repo, resolve the baseline, diff.
#   Repo discovery: $REPO if it is a git repo (greenfield git-init at root, or a
#   session-resource clone); else a child dir holding .git (agent-self-clone into
#   a subdir, e.g. /sandbox/work/repo); else git-init $REPO (greenfield, files
#   written directly at root). Avoids diffing an embedded repo as a gitlink.
#   Baseline: refs/tags/wfb-baseline (session-resource clone) → origin/HEAD /
#   @{upstream} (agent-self-clone → agent-only diff vs the clone point) →
#   empty-tree (greenfield → all files as additions).
# Output: "WFB_BASE=<sha>" line, sentinel, then the unified patch.
_CAPTURE_SCRIPT = """
set -e
SAFE_DIR_CMD
[ -d "$REPO" ] || { echo "__WFB_NO_REPO__"; exit 0; }
IDX=/tmp/wfb-diff-index; rm -f "$IDX"
BASEREFS='git rev-parse -q --verify refs/tags/wfb-baseline 2>/dev/null || git rev-parse -q --verify origin/HEAD 2>/dev/null || git rev-parse -q --verify @{upstream} 2>/dev/null || echo "$EMPTY"'
# 1) Agent-cloned subdir repo (its own real .git) wins — even if $REPO root has a
#    stale .git from a prior run. Diff INSIDE it vs its clone point (agent-only).
SUB=$(find "$REPO" -mindepth 2 -maxdepth 2 -name .git 2>/dev/null | head -1)
if [ -n "$SUB" ]; then
  cd "$(dirname "$SUB")"
  mkdir -p .git/info; printf '%s' "$NOISE" > .git/info/exclude
  BASE=$(eval "$BASEREFS")
  GIT_INDEX_FILE="$IDX" git add -A 2>/dev/null || true
  PATCH=$(GIT_INDEX_FILE="$IDX" git diff --cached --find-renames --stat --patch --binary "$BASE" -- 2>/dev/null || true)
elif ( cd "$REPO" && git rev-parse --is-inside-work-tree >/dev/null 2>&1 ); then
  # 2) $REPO itself is a real repo (session-resource clone at root).
  cd "$REPO"
  mkdir -p .git/info; printf '%s' "$NOISE" > .git/info/exclude
  BASE=$(eval "$BASEREFS")
  GIT_INDEX_FILE="$IDX" git add -A 2>/dev/null || true
  PATCH=$(GIT_INDEX_FILE="$IDX" git diff --cached --find-renames --stat --patch --binary "$BASE" -- 2>/dev/null || true)
else
  # 3) Greenfield: external GIT_DIR over the work-tree — NEVER writes .git into the
  #    workspace (avoids polluting shared multi-node /sandbox/work). Diff vs empty.
  GD=/tmp/wfb-gitdir; rm -rf "$GD"
  GIT_DIR="$GD" GIT_WORK_TREE="$REPO" git init -q >/dev/null 2>&1 || true
  mkdir -p "$GD/info"; printf '%s' "$NOISE" > "$GD/info/exclude"
  BASE="$EMPTY"
  GIT_DIR="$GD" GIT_WORK_TREE="$REPO" GIT_INDEX_FILE="$IDX" git add -A 2>/dev/null || true
  PATCH=$(GIT_DIR="$GD" GIT_WORK_TREE="$REPO" GIT_INDEX_FILE="$IDX" git diff --cached --find-renames --stat --patch --binary "$BASE" -- 2>/dev/null || true)
  rm -rf "$GD" 2>/dev/null || true
fi
echo "WFB_BASE=$BASE"
echo "===WFB_PATCH==="
printf '%s' "$PATCH"
""".replace("SAFE_DIR_CMD", _SAFE_DIR)


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
        out = _run(_CAPTURE_SCRIPT, env_extra)
    except Exception as exc:  # noqa: BLE001
        return {"ok": True, "skipped": f"capture_failed: {exc}"}
    if out.strip() == "__WFB_NO_REPO__":
        return {"ok": True, "skipped": "no_workspace"}

    # Parse "WFB_BASE=<sha>\n===WFB_PATCH===\n<patch>".
    base = _EMPTY_TREE
    patch = ""
    if "===WFB_PATCH===" in out:
        header, _, patch = out.partition("===WFB_PATCH===\n")
        for line in header.splitlines():
            if line.startswith("WFB_BASE="):
                base = line[len("WFB_BASE="):].strip() or _EMPTY_TREE

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

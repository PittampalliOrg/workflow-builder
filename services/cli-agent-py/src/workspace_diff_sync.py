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

import base64
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
_NOISE_EXCLUDE = "node_modules/\n.git/\n.wfb-diff-git/\n.venv/\n__pycache__/\ndist/\nbuild/\n.cache/\n.next/\nvendor/\n.pytest_cache/\n.accesslog\n.config\n.stats\n.trash/\n"

# `git config --add safe.directory '*'`: the workspace dir is often root-owned
# (JuiceFS mount) while git runs as the agent user → git aborts with "detected
# dubious ownership". Trust all repos for these throwaway in-pod captures.
_SAFE_DIR = "git config --global --add safe.directory '*' 2>/dev/null || true"

# Per-node DUAL capture for true incremental deltas across mixed workspaces
# (root scratch files + an embedded cloned repo, e.g. gan-harness: SPEC.md +
# proposal.md at root AND a built `repo/` subdir). One combined patch per node:
#
#   ROOT scratch tree (only when $REPO is NOT itself a git repo): a dedicated
#     $REPO/.wfb-diff-git (persisted across per-node pods via JuiceFS) tracks the
#     root files, EXCLUDING nested repo dirs. Baseline = refs/wfb/baseline (prev
#     node) else empty-tree. Catches proposal.md / progress.json deltas per node.
#
#   EACH git repo (the root clone if $REPO is a repo, + every nested repo like
#     repo/): diff in the repo's OWN git vs refs/wfb/baseline (prev node) else
#     origin/HEAD's tree (clone point → agent-only) else empty-tree; paths are
#     prefixed with the repo's subdir. Catches the app edits per node.
#
# Baselines advance via `git write-tree` into a refs/wfb/baseline ref — NEVER
# commits to the agent's branch, NEVER moves/renames .git (safe). The temp index
# (GIT_INDEX_FILE) keeps the agent's real index untouched and includes untracked
# files. Output: "WFB_BASE=per-node", sentinel, then the combined patch.
_CAPTURE_SCRIPT = """
set -e
SAFE_DIR_CMD
[ -d "$REPO" ] || { echo "__WFB_NO_REPO__"; exit 0; }
EMPTY="4b825dc642cb6eb9a060e54bf8d69288fbee4904"
T=/tmp/wfb-diff-index
OUT=""
# Nested git repos (their parent dirs), excluding our own snapshot dir.
NESTED=$(find "$REPO" -mindepth 2 -maxdepth 3 -name .git 2>/dev/null | sed 's:/[.]git$::' | grep -v '/[.]wfb-' || true)

# --- ROOT scratch tree (only when $REPO itself is not a git repo) ---
if [ ! -e "$REPO/.git" ]; then
  GD="$REPO/.wfb-diff-git"
  [ -d "$GD" ] || GIT_DIR="$GD" GIT_WORK_TREE="$REPO" git init -q >/dev/null 2>&1 || true
  GIT_DIR="$GD" git config user.email wfb@local >/dev/null 2>&1 || true
  GIT_DIR="$GD" git config user.name wfb >/dev/null 2>&1 || true
  mkdir -p "$GD/info"
  { printf '%s\n' "$NOISE"; for d in $NESTED; do echo "/${d#$REPO/}"; done; } > "$GD/info/exclude"
  rm -f "$T"
  PREV=$(GIT_DIR="$GD" git rev-parse -q --verify refs/wfb/baseline 2>/dev/null || echo "$EMPTY")
  GIT_DIR="$GD" GIT_WORK_TREE="$REPO" GIT_INDEX_FILE="$T" git add -A --ignore-errors 2>/dev/null || true
  P=$(GIT_DIR="$GD" GIT_WORK_TREE="$REPO" GIT_INDEX_FILE="$T" git diff --cached --find-renames --stat --patch --binary "$PREV" -- 2>/dev/null || true)
  NEW=$(GIT_DIR="$GD" GIT_WORK_TREE="$REPO" GIT_INDEX_FILE="$T" git write-tree 2>/dev/null || true)
  [ -n "$NEW" ] && GIT_DIR="$GD" git update-ref refs/wfb/baseline "$NEW" 2>/dev/null || true
  OUT="$OUT$P"
fi

# --- Each git repo: the root clone (if any) + every nested repo ---
REPOS=""
[ -e "$REPO/.git" ] && REPOS="$REPO"
REPOS="$REPOS $NESTED"
for R in $REPOS; do
  [ -d "$R" ] || continue
  REL=""
  [ "$R" != "$REPO" ] && REL="${R#$REPO/}/"
  cd "$R"
  rm -f "$T"
  PREV=$(git rev-parse -q --verify refs/wfb/baseline 2>/dev/null || git rev-parse -q --verify origin/HEAD^{tree} 2>/dev/null || echo "$EMPTY")
  GIT_INDEX_FILE="$T" git add -A --ignore-errors 2>/dev/null || true
  P=$(GIT_INDEX_FILE="$T" git diff --cached --find-renames --stat --patch --binary --src-prefix="a/$REL" --dst-prefix="b/$REL" "$PREV" -- 2>/dev/null || true)
  NEW=$(GIT_INDEX_FILE="$T" git write-tree 2>/dev/null || true)
  [ -n "$NEW" ] && git update-ref refs/wfb/baseline "$NEW" 2>/dev/null || true
  cd "$REPO"
  OUT="$OUT$P"
done

echo "WFB_BASE=per-node"
echo "===WFB_PATCH==="
printf '%s' "$OUT"
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
    env_extra = {"REPO": repo_dir, "EMPTY": _EMPTY_TREE, "NOISE": _NOISE_EXCLUDE, "NODE": node_id or "?"}

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


# --- Source bundle (durable, applyable code version) — mirrors dapr-agent-py ----
# Bundle the produced SOURCE (self-contained full git bundle, tiered fallback) and
# POST it as a `source-bundle` artifact so the version survives sandbox reap and can
# be downloaded / Promoted → PR. CLI runs pod-local: subprocess + direct file read.
_BUNDLE_OUT_FILE = "/tmp/wfb-src.bundle"
_MAX_BUNDLE_BYTES = int(os.environ.get("CLI_SOURCE_BUNDLE_MAX_BYTES", str(20 * 1024 * 1024)))

_BUNDLE_SCRIPT = r"""
set -e
git config --global --add safe.directory '*' 2>/dev/null || true
OUTB=/tmp/wfb-src.bundle
rm -f "$OUTB"
CLONE=""
if [ -e "$ROOT/.git" ] && git -C "$ROOT" rev-parse -q --verify HEAD >/dev/null 2>&1; then CLONE="$ROOT"; fi
if [ -z "$CLONE" ]; then
  for D in $(find "$ROOT" -mindepth 2 -maxdepth 3 -name .git 2>/dev/null | sed 's:/[.]git$::' | grep -v '/[.]wfb-' || true); do
    if git -C "$D" rev-parse -q --verify HEAD >/dev/null 2>&1; then CLONE="$D"; break; fi
  done
fi
[ -n "$CLONE" ] && [ -d "$CLONE" ] || { echo "__WFB_NO_CLONE__"; exit 0; }
cd "$CLONE"
git config user.email wfb@local 2>/dev/null || true
git config user.name wfb 2>/dev/null || true
git add -A 2>/dev/null || true
git rm -r --cached --quiet --ignore-unmatch node_modules .svelte-kit build dist .next .cache .wfb-diff-git >/dev/null 2>&1 || true
FILECOUNT=$(git diff --cached --name-only 2>/dev/null | wc -l | tr -d ' ')
git commit -q -m "wfb version snapshot" --no-verify 2>/dev/null || true
HEAD=$(git rev-parse -q --verify HEAD 2>/dev/null || echo "")
BASE=$(git rev-parse -q --verify origin/HEAD 2>/dev/null || git rev-parse -q --verify origin/main 2>/dev/null || git rev-parse -q --verify origin/master 2>/dev/null || echo "")
TIER=""
if [ -n "$HEAD" ]; then
  if git bundle create "$OUTB" HEAD >/dev/null 2>&1 && [ -s "$OUTB" ]; then TIER=full; else rm -f "$OUTB"; fi
fi
if [ -s "$OUTB" ] && [ -n "$MAXB" ] && [ "$(wc -c < "$OUTB" 2>/dev/null || echo 0)" -gt "$MAXB" ] && [ -n "$BASE" ] && [ "$BASE" != "$HEAD" ]; then
  if git bundle create "$OUTB.thin" "$BASE..HEAD" >/dev/null 2>&1 && [ -s "$OUTB.thin" ]; then mv -f "$OUTB.thin" "$OUTB"; TIER=thin; else rm -f "$OUTB.thin"; fi
fi
if { [ ! -s "$OUTB" ] || { [ -n "$MAXB" ] && [ "$(wc -c < "$OUTB" 2>/dev/null || echo 0)" -gt "$MAXB" ]; }; } && [ -n "$HEAD" ]; then
  TREE=$(git rev-parse "HEAD^{tree}" 2>/dev/null || echo "")
  if [ -n "$TREE" ]; then SQ=$(git commit-tree "$TREE" -m "wfb snapshot" 2>/dev/null || echo ""); [ -n "$SQ" ] && git bundle create "$OUTB" "$SQ" >/dev/null 2>&1 && TIER=squashed && BASE="" && HEAD="$SQ" || true; fi
fi
echo "WFB_CLONE=$CLONE"
echo "WFB_TIER=$TIER"
echo "WFB_BASE=$BASE"
echo "WFB_HEAD=$HEAD"
echo "WFB_FILECOUNT=$FILECOUNT"
echo "WFB_BUNDLE_BYTES=$(wc -c < "$OUTB" 2>/dev/null || echo 0)"
"""


def _post_source_bundle(execution_id: str, payload: dict[str, Any]) -> tuple[bool, str]:
    body = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        f"{_WORKFLOW_BUILDER_URL}/api/internal/workflows/executions/{execution_id}/source-bundle",
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
    except Exception as exc:  # noqa: BLE001
        return False, str(exc)


def sync_source_bundle_activity(
    _ctx_or_input: Any, input_data: dict[str, Any] | None = None
) -> dict[str, Any]:
    """Bundle the produced source + POST it as a `source-bundle` artifact. CLI
    runs pod-local (subprocess + file read). Never raises."""
    data = _record(input_data if input_data is not None else _ctx_or_input)
    if not _INTERNAL_API_TOKEN:
        return {"ok": True, "skipped": "no_token"}
    execution_id = _clean_string(data.get("workflowExecutionId"))
    node_id = _clean_string(data.get("nodeId"))
    if not execution_id:
        return {"ok": True, "skipped": "no_run_context"}

    root = _clean_string(data.get("repoPath")) or DEFAULT_REPO_DIR
    try:
        out = _run(_BUNDLE_SCRIPT, {"ROOT": root, "MAXB": str(_MAX_BUNDLE_BYTES)})
    except Exception as exc:  # noqa: BLE001
        return {"ok": True, "skipped": f"bundle_failed: {exc}"}
    if "__WFB_NO_CLONE__" in out:
        return {"ok": True, "skipped": "no_clone"}
    meta: dict[str, str] = {}
    for line in out.splitlines():
        for key in ("WFB_CLONE", "WFB_TIER", "WFB_BASE", "WFB_HEAD", "WFB_FILECOUNT", "WFB_BUNDLE_BYTES"):
            if line.startswith(key + "="):
                meta[key] = line[len(key) + 1:].strip()
    try:
        file_count = int(meta.get("WFB_FILECOUNT") or "0")
    except ValueError:
        file_count = 0
    try:
        nbytes = int(meta.get("WFB_BUNDLE_BYTES") or "0")
    except ValueError:
        nbytes = 0
    if file_count <= 0:
        return {"ok": True, "empty": True}
    if nbytes <= 0 or nbytes > _MAX_BUNDLE_BYTES:
        return {"ok": True, "skipped": f"bad_size: {nbytes}"}

    try:
        with open(_BUNDLE_OUT_FILE, "rb") as fh:
            bundle_b64 = base64.b64encode(fh.read()).decode("ascii")
    except Exception as exc:  # noqa: BLE001
        return {"ok": True, "skipped": f"read_failed: {exc}"}
    if not bundle_b64:
        return {"ok": True, "skipped": "empty_read"}

    ok, detail = _post_source_bundle(
        execution_id,
        {
            "bundleBase64": bundle_b64,
            "nodeId": node_id,
            "fileName": "source.bundle",
            "base": meta.get("WFB_BASE") or "",
            "head": meta.get("WFB_HEAD") or "",
            "tier": meta.get("WFB_TIER") or "",
            "clonePath": meta.get("WFB_CLONE") or "",
            "fileCount": file_count,
            "sizeBytes": nbytes,
        },
    )
    return {"ok": True, "posted": ok, "detail": detail, "tier": meta.get("WFB_TIER"), "bytes": nbytes}

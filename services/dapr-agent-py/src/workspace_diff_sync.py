"""Capture a durable per-run workspace diff for dapr-agent-py at session end.

Unlike the CLI runtimes (which write to a pod-local JuiceFS `/sandbox/work` and
capture the diff in-pod), dapr-agent-py executes its file tools in a REMOTE
OpenShell sandbox — the dapr pod's own filesystem is empty. So the diff MUST be
computed where the files actually live: we run the same dual-capture git script
*inside the OpenShell sandbox* via `OpenShellRuntime.execute`, then pull the patch
back over the chunked file-read API (OpenShell stdout truncates large payloads, so
the script writes the patch to a sandbox file and we read it as base64). The patch
is then POSTed to the BFF run-diff ingest — identical artifact pipeline to the CLI.

Mirrors `services/cli-agent-py/src/workspace_diff_sync.py` (the dual-capture logic
is intentionally kept in sync): one combined patch per node covering BOTH root
scratch files (a dedicated `.wfb-diff-git` excluding nested repos) AND each git
repo (subdir-prefixed, vs refs/wfb/baseline → origin/HEAD → empty-tree). Best
effort: never raises.
"""

from __future__ import annotations

import base64
import json
import os
import urllib.error
import urllib.request
from typing import Any

_WORKFLOW_BUILDER_URL = os.environ.get(
    "WORKFLOW_BUILDER_URL", "http://workflow-builder.nextjs.svc.cluster.local:3000"
).rstrip("/")
_INTERNAL_API_TOKEN = os.environ.get("INTERNAL_API_TOKEN", "")

_GIT_TIMEOUT_SECONDS = int(os.environ.get("DAPR_WORKSPACE_DIFF_GIT_TIMEOUT_SECONDS", "120"))
_POST_TIMEOUT_SECONDS = int(os.environ.get("DAPR_WORKSPACE_DIFF_POST_TIMEOUT_SECONDS", "120"))
_MAX_PATCH_BYTES = int(os.environ.get("DAPR_WORKSPACE_DIFF_MAX_BYTES", str(8 * 1024 * 1024)))

_EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904"
_OUT_FILE = "/tmp/wfb-run-diff.patch"

# Base64 the noise list so it can be embedded in the bash command string WITHOUT
# its newlines being mangled. (Passing it via `export NOISE=<json>` turned every
# real newline into a literal `\n`, producing a one-line garbage exclude file and
# disabling ALL excludes — the seed dotfiles + .wfb-diff-git internals then leaked
# into the diff. OpenShell `execute` runs a command string, not env vars, so unlike
# the CLI's subprocess env_extra we must encode binary-safe.)
# Baked noise exclude (mirrors the CLI). Keeps the diff/`git add` off dependency
# and vcs dirs so it is fast and meaningful on a greenfield sandbox with no
# .gitignore. (The JuiceFS magic files are CLI-mount-specific but harmless here.)
_NOISE_EXCLUDE = "node_modules/\n.git/\n.wfb-diff-git/\n.venv/\n__pycache__/\ndist/\nbuild/\n.cache/\n.next/\nvendor/\n.pytest_cache/\n.accesslog\n.config\n.stats\n.trash/\n"

_NOISE_B64 = base64.b64encode(_NOISE_EXCLUDE.encode("utf-8")).decode("ascii")

# Dual capture (kept in sync with cli-agent-py/src/workspace_diff_sync.py): the
# combined patch is written to $OUTF (NOT stdout — OpenShell truncates large
# stdout); only WFB_BASE/WFB_BYTES are printed for the caller to parse.
_CAPTURE_SCRIPT = r"""
set -e
git config --global --add safe.directory '*' 2>/dev/null || true
[ -d "$REPO" ] || { echo "__WFB_NO_REPO__"; exit 0; }
EMPTY="4b825dc642cb6eb9a060e54bf8d69288fbee4904"
T=/tmp/wfb-diff-index
OUT=""
# Noise/seed paths removed from the index AFTER `git add -A` — environment-
# independent (does NOT rely on info/exclude being honored, which it is NOT in the
# OpenShell sandbox's git). Covers dependency/vcs dirs + the openshell seed home
# dotfiles (dapr's cwd is the seeded /sandbox HOME) + our own snapshot git dir.
NOISE_PATHS=".wfb-diff-git node_modules .venv __pycache__ dist build .cache .next vendor .pytest_cache .accesslog .config .stats .trash .bashrc .profile .bash_history .bash_logout .gitconfig .claude.json .claude .codex .agents .workspace-initialized .ssh .npm .local .cargo .rustup"
NESTED=$(find "$REPO" -mindepth 2 -maxdepth 3 -name .git 2>/dev/null | sed 's:/[.]git$::' | grep -v '/[.]wfb-' || true)

# --- ROOT scratch tree (only when $REPO itself is not a git repo) ---
if [ ! -e "$REPO/.git" ]; then
  GD="$REPO/.wfb-diff-git"
  [ -d "$GD" ] || GIT_DIR="$GD" GIT_WORK_TREE="$REPO" git init -q >/dev/null 2>&1 || true
  GIT_DIR="$GD" git config user.email wfb@local >/dev/null 2>&1 || true
  GIT_DIR="$GD" git config user.name wfb >/dev/null 2>&1 || true
  rm -f "$T"
  PREV=$(GIT_DIR="$GD" git rev-parse -q --verify refs/wfb/baseline 2>/dev/null || echo "$EMPTY")
  GIT_DIR="$GD" GIT_WORK_TREE="$REPO" GIT_INDEX_FILE="$T" git add -A --ignore-errors 2>/dev/null || true
  GIT_DIR="$GD" GIT_WORK_TREE="$REPO" GIT_INDEX_FILE="$T" git rm -r --cached --quiet --ignore-unmatch $NOISE_PATHS >/dev/null 2>&1 || true
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
  GIT_INDEX_FILE="$T" git rm -r --cached --quiet --ignore-unmatch $NOISE_PATHS >/dev/null 2>&1 || true
  P=$(GIT_INDEX_FILE="$T" git diff --cached --find-renames --stat --patch --binary --src-prefix="a/$REL" --dst-prefix="b/$REL" "$PREV" -- 2>/dev/null || true)
  NEW=$(GIT_INDEX_FILE="$T" git write-tree 2>/dev/null || true)
  [ -n "$NEW" ] && git update-ref refs/wfb/baseline "$NEW" 2>/dev/null || true
  cd "$REPO"
  OUT="$OUT$P"
done

printf '%s' "$OUT" > "$OUTF"
echo "WFB_BASE=per-node"
echo "WFB_BYTES=$(wc -c < "$OUTF" 2>/dev/null || echo 0)"
"""


# Baseline PRIME (run once at session START, before the agent acts): snapshot the
# pre-existing sandbox state into refs/wfb/baseline so the session-end diff shows
# ONLY the agent's writes — not the seeded home/config dotfiles (.bashrc, .claude.json,
# .codex/, .gitconfig, …) that live in dapr's cwd (/sandbox is the seeded home dir,
# unlike the CLI's clean /sandbox/work). Only sets a baseline that doesn't already
# exist, so a workflow retry (agent already wrote files) never baselines them out.
_PRIME_SCRIPT = r"""
set -e
git config --global --add safe.directory '*' 2>/dev/null || true
[ -d "$REPO" ] || { echo "__WFB_NO_REPO__"; exit 0; }
NOISE_PATHS=".wfb-diff-git node_modules .venv __pycache__ dist build .cache .next vendor .pytest_cache .accesslog .config .stats .trash .bashrc .profile .bash_history .bash_logout .gitconfig .claude.json .claude .codex .agents .workspace-initialized .ssh .npm .local .cargo .rustup"
NESTED=$(find "$REPO" -mindepth 2 -maxdepth 3 -name .git 2>/dev/null | sed 's:/[.]git$::' | grep -v '/[.]wfb-' || true)
T=/tmp/wfb-prime-index
PRIMED=0

if [ ! -e "$REPO/.git" ]; then
  GD="$REPO/.wfb-diff-git"
  if ! GIT_DIR="$GD" git rev-parse -q --verify refs/wfb/baseline >/dev/null 2>&1; then
    [ -d "$GD" ] || GIT_DIR="$GD" GIT_WORK_TREE="$REPO" git init -q >/dev/null 2>&1 || true
    GIT_DIR="$GD" git config user.email wfb@local >/dev/null 2>&1 || true
    GIT_DIR="$GD" git config user.name wfb >/dev/null 2>&1 || true
    rm -f "$T"
    GIT_DIR="$GD" GIT_WORK_TREE="$REPO" GIT_INDEX_FILE="$T" git add -A --ignore-errors 2>/dev/null || true
    GIT_DIR="$GD" GIT_WORK_TREE="$REPO" GIT_INDEX_FILE="$T" git rm -r --cached --quiet --ignore-unmatch $NOISE_PATHS >/dev/null 2>&1 || true
    NEW=$(GIT_DIR="$GD" GIT_WORK_TREE="$REPO" GIT_INDEX_FILE="$T" git write-tree 2>/dev/null || true)
    [ -n "$NEW" ] && GIT_DIR="$GD" git update-ref refs/wfb/baseline "$NEW" 2>/dev/null && PRIMED=$((PRIMED+1)) || true
  fi
fi

REPOS=""
[ -e "$REPO/.git" ] && REPOS="$REPO"
REPOS="$REPOS $NESTED"
for R in $REPOS; do
  [ -d "$R" ] || continue
  cd "$R"
  if ! git rev-parse -q --verify refs/wfb/baseline >/dev/null 2>&1; then
    rm -f "$T"
    GIT_INDEX_FILE="$T" git add -A --ignore-errors 2>/dev/null || true
    GIT_INDEX_FILE="$T" git rm -r --cached --quiet --ignore-unmatch $NOISE_PATHS >/dev/null 2>&1 || true
    NEW=$(GIT_INDEX_FILE="$T" git write-tree 2>/dev/null || true)
    [ -n "$NEW" ] && git update-ref refs/wfb/baseline "$NEW" 2>/dev/null && PRIMED=$((PRIMED+1)) || true
  fi
  cd "$REPO"
done
echo "WFB_PRIMED=$PRIMED"
"""


def prime_workspace_baseline_openshell(runtime: Any) -> dict[str, Any]:
    """Snapshot the pre-agent sandbox state as the diff baseline (once). Best
    effort; never raises. Call at session START before the agent writes files."""
    repo_dir = (getattr(runtime, "cwd", None) or "/sandbox") or "/sandbox"
    exports = f"export REPO={json.dumps(repo_dir)}; "
    try:
        res = runtime.execute(exports + _PRIME_SCRIPT, timeout_seconds=_GIT_TIMEOUT_SECONDS)
        out = str(res.get("stdout") or res.get("output") or "")
        return {"ok": True, "out": out.strip()[-120:]}
    except Exception as exc:  # noqa: BLE001
        return {"ok": True, "skipped": f"prime_failed: {exc}"}


def _clean(value: Any) -> str | None:
    return value.strip() if isinstance(value, str) and value.strip() else None


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


def sync_workspace_diff_openshell(
    runtime: Any, *, execution_id: str | None, node_id: str | None
) -> dict[str, Any]:
    """Compute the per-run workspace diff INSIDE the OpenShell sandbox and POST it
    as a durable `diff` artifact. Never raises."""
    execution_id = _clean(execution_id)
    if not execution_id:
        return {"ok": True, "skipped": "no_run_context"}
    if not _INTERNAL_API_TOKEN:
        return {"ok": True, "skipped": "no_token"}

    repo_dir = (getattr(runtime, "cwd", None) or "/sandbox") or "/sandbox"

    # Run the dual-capture script remotely. execute() cd's into runtime.cwd, so we
    # pass REPO explicitly to anchor the capture on the workspace root.
    exports = f"export REPO={json.dumps(repo_dir)} OUTF={json.dumps(_OUT_FILE)}; "
    try:
        res = runtime.execute(exports + _CAPTURE_SCRIPT, timeout_seconds=_GIT_TIMEOUT_SECONDS)
    except Exception as exc:  # noqa: BLE001
        return {"ok": True, "skipped": f"capture_failed: {exc}"}

    out = str(res.get("stdout") or res.get("output") or "")
    if "__WFB_NO_REPO__" in out:
        return {"ok": True, "skipped": "no_workspace"}
    base = "per-node"
    nbytes = 0
    for line in out.splitlines():
        if line.startswith("WFB_BASE="):
            base = line[len("WFB_BASE="):].strip() or "per-node"
        elif line.startswith("WFB_BYTES="):
            try:
                nbytes = int(line[len("WFB_BYTES="):].strip() or "0")
            except ValueError:
                nbytes = 0
    if nbytes <= 0:
        return {"ok": True, "empty": True, "base": base}

    # Pull the patch back via the chunked base64 reader (large-payload safe).
    try:
        read = runtime.read_bytes_base64(_OUT_FILE, max_bytes=_MAX_PATCH_BYTES)
    except Exception as exc:  # noqa: BLE001
        return {"ok": True, "skipped": f"read_failed: {exc}"}
    if not read.get("ok"):
        return {"ok": True, "skipped": f"read_failed: {read.get('error')}"}
    try:
        patch = base64.b64decode(read.get("base64") or read.get("content") or "").decode(
            "utf-8", errors="replace"
        )
    except Exception as exc:  # noqa: BLE001
        return {"ok": True, "skipped": f"decode_failed: {exc}"}
    if not patch.strip():
        return {"ok": True, "empty": True, "base": base}
    if len(patch.encode("utf-8")) > _MAX_PATCH_BYTES:
        patch = patch.encode("utf-8")[:_MAX_PATCH_BYTES].decode("utf-8", errors="ignore")

    ok, detail = _post_run_diff(
        execution_id,
        {
            "patch": patch,
            "baseRef": "per-node" if base == "per-node" else base[:12],
            "headRef": "working",
            "nodeId": node_id,
            "title": "Workspace changes",
        },
    )
    return {"ok": True, "posted": ok, "detail": detail, "base": base}

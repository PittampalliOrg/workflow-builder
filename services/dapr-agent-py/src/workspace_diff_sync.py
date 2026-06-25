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
# Nested-repo paths RELATIVE to $REPO — excluded from the root scratch tree so a
# nested clone (e.g. repo/) is captured once (by its own repo pass), not duplicated.
NESTED_REL=""
for N in $NESTED; do NESTED_REL="$NESTED_REL ${N#$REPO/}"; done
# Is $REPO itself a REAL clone (CLI shape: /sandbox/work IS the cloned repo) vs a
# workspace root that merely happens to contain a (possibly stray) .git (GAN/juicefs
# shape: /sandbox/work holds proposal.md/SPEC.md + a repo/ subdir)? A real clone has
# origin/HEAD; a stray `git init` does not. Only a real clone is captured as a repo;
# otherwise the workspace root is captured via the scratch tree so root artifacts
# (proposal.md, SPEC.md, contract.json, …) are NOT lost just because a .git appeared.
ROOT_IS_CLONE=0
if [ -e "$REPO/.git" ] && git -C "$REPO" rev-parse -q --verify origin/HEAD >/dev/null 2>&1; then ROOT_IS_CLONE=1; fi

# --- ROOT scratch tree (workspace shape: root is NOT a real clone) ---
if [ "$ROOT_IS_CLONE" = "0" ]; then
  GD="$REPO/.wfb-diff-git"
  [ -d "$GD" ] || GIT_DIR="$GD" GIT_WORK_TREE="$REPO" git init -q >/dev/null 2>&1 || true
  GIT_DIR="$GD" git config user.email wfb@local >/dev/null 2>&1 || true
  GIT_DIR="$GD" git config user.name wfb >/dev/null 2>&1 || true
  rm -f "$T"
  PREV=$(GIT_DIR="$GD" git rev-parse -q --verify refs/wfb/baseline 2>/dev/null || echo "$EMPTY")
  GIT_DIR="$GD" GIT_WORK_TREE="$REPO" GIT_INDEX_FILE="$T" git add -A --ignore-errors 2>/dev/null || true
  GIT_DIR="$GD" GIT_WORK_TREE="$REPO" GIT_INDEX_FILE="$T" git rm -r --cached --quiet --ignore-unmatch $NOISE_PATHS .git $NESTED_REL >/dev/null 2>&1 || true
  P=$(GIT_DIR="$GD" GIT_WORK_TREE="$REPO" GIT_INDEX_FILE="$T" git diff --cached --find-renames --stat --patch --binary "$PREV" -- 2>/dev/null || true)
  NEW=$(GIT_DIR="$GD" GIT_WORK_TREE="$REPO" GIT_INDEX_FILE="$T" git write-tree 2>/dev/null || true)
  [ -n "$NEW" ] && GIT_DIR="$GD" git update-ref refs/wfb/baseline "$NEW" 2>/dev/null || true
  OUT="$OUT$P"
fi

# --- Each git repo: the root clone (only if a REAL clone) + every nested repo ---
REPOS=""
[ "$ROOT_IS_CLONE" = "1" ] && REPOS="$REPO"
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
NESTED_REL=""
for N in $NESTED; do NESTED_REL="$NESTED_REL ${N#$REPO/}"; done
ROOT_IS_CLONE=0
if [ -e "$REPO/.git" ] && git -C "$REPO" rev-parse -q --verify origin/HEAD >/dev/null 2>&1; then ROOT_IS_CLONE=1; fi
T=/tmp/wfb-prime-index
PRIMED=0

if [ "$ROOT_IS_CLONE" = "0" ]; then
  GD="$REPO/.wfb-diff-git"
  if ! GIT_DIR="$GD" git rev-parse -q --verify refs/wfb/baseline >/dev/null 2>&1; then
    [ -d "$GD" ] || GIT_DIR="$GD" GIT_WORK_TREE="$REPO" git init -q >/dev/null 2>&1 || true
    GIT_DIR="$GD" git config user.email wfb@local >/dev/null 2>&1 || true
    GIT_DIR="$GD" git config user.name wfb >/dev/null 2>&1 || true
    rm -f "$T"
    GIT_DIR="$GD" GIT_WORK_TREE="$REPO" GIT_INDEX_FILE="$T" git add -A --ignore-errors 2>/dev/null || true
    GIT_DIR="$GD" GIT_WORK_TREE="$REPO" GIT_INDEX_FILE="$T" git rm -r --cached --quiet --ignore-unmatch $NOISE_PATHS .git $NESTED_REL >/dev/null 2>&1 || true
    NEW=$(GIT_DIR="$GD" GIT_WORK_TREE="$REPO" GIT_INDEX_FILE="$T" git write-tree 2>/dev/null || true)
    [ -n "$NEW" ] && GIT_DIR="$GD" git update-ref refs/wfb/baseline "$NEW" 2>/dev/null && PRIMED=$((PRIMED+1)) || true
  fi
fi

REPOS=""
[ "$ROOT_IS_CLONE" = "1" ] && REPOS="$REPO"
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


# --- Source bundle (durable, applyable version of the produced code) -----------
# Persist the produced SOURCE as a git bundle in the Files API so a version can be
# previewed + applied (Promote -> PR) long after the per-run sandbox is reaped.
# Mirrors Claude Code's teleport bundle (utils/teleport/gitBundle.ts): commit the
# working tree, create a THIN bundle origin/<base>..HEAD, tier down to HEAD then a
# squashed-root commit if needed. One bundle per node (each node = one agent
# session): nodes that don't touch the repo clone (plan/design/negotiate write
# /sandbox/work/* OUTSIDE the repo) produce 0 changed files -> skipped.
_BUNDLE_OUT_FILE = "/tmp/wfb-src.bundle"
_MAX_BUNDLE_BYTES = int(os.environ.get("DAPR_SOURCE_BUNDLE_MAX_BYTES", str(20 * 1024 * 1024)))

_BUNDLE_SCRIPT = r"""
set -e
git config --global --add safe.directory '*' 2>/dev/null || true
OUTB=/tmp/wfb-src.bundle
rm -f "$OUTB"
# Find the real clone under $ROOT (a dir with a git HEAD), preferring $ROOT itself,
# else the first nested clone (the GAN/juicefs shape: /sandbox/work/repo).
CLONE=""
if [ -e "$ROOT/.git" ] && git -C "$ROOT" rev-parse -q --verify HEAD >/dev/null 2>&1; then CLONE="$ROOT"; fi
if [ -z "$CLONE" ]; then
  for D in $(find "$ROOT" -mindepth 2 -maxdepth 3 -name .git 2>/dev/null | sed 's:/[.]git$::' | grep -v '/[.]wfb-' || true); do
    if git -C "$D" rev-parse -q --verify HEAD >/dev/null 2>&1; then CLONE="$D"; break; fi
  done
fi
[ -n "$CLONE" ] && [ -d "$CLONE" ] || { echo "__WFB_NO_CLONE__"; exit 0; }
cd "$CLONE"
BASE=$(git rev-parse -q --verify origin/HEAD 2>/dev/null || git rev-parse -q --verify origin/main 2>/dev/null || git rev-parse -q --verify origin/master 2>/dev/null || git rev-parse -q --verify HEAD 2>/dev/null || echo "")
# Build the snapshot from a SEPARATE index + a DETACHED commit-tree — NEVER run
# `git add -A`/`git commit` on the real repo. Doing so would add a stray "wfb
# snapshot" commit to HEAD and stage the harness's own .wfb-diff-git dir, poisoning
# the diff the gate/critic inspect (breaking the "only the in-scope files changed"
# criteria). commit-tree creates an object that moves NO ref; HEAD/index/worktree
# are left exactly as the agent left them.
IDX=/tmp/wfb-bundle-index; rm -f "$IDX"
GIT_INDEX_FILE="$IDX" git add -A 2>/dev/null || true
GIT_INDEX_FILE="$IDX" git rm -r --cached --quiet --ignore-unmatch node_modules .svelte-kit build dist .next .cache .git .wfb-diff-git >/dev/null 2>&1 || true
FILECOUNT=$(GIT_INDEX_FILE="$IDX" git diff --cached --name-only ${BASE:+"$BASE"} 2>/dev/null | grep -vE '^(\.wfb-diff-git|node_modules)/' | wc -l | tr -d ' ')
TREE=$(GIT_INDEX_FILE="$IDX" git write-tree 2>/dev/null || echo "")
rm -f "$IDX"
[ -n "$TREE" ] || { echo "__WFB_NO_TREE__"; exit 0; }
WID="wfb"; WEM="wfb@local"
if [ -n "$BASE" ]; then
  COMMIT=$(GIT_AUTHOR_NAME="$WID" GIT_AUTHOR_EMAIL="$WEM" GIT_COMMITTER_NAME="$WID" GIT_COMMITTER_EMAIL="$WEM" git commit-tree "$TREE" -p "$BASE" -m "wfb snapshot" 2>/dev/null || echo "")
else
  COMMIT=$(GIT_AUTHOR_NAME="$WID" GIT_AUTHOR_EMAIL="$WEM" GIT_COMMITTER_NAME="$WID" GIT_COMMITTER_EMAIL="$WEM" git commit-tree "$TREE" -m "wfb snapshot" 2>/dev/null || echo "")
fi
[ -n "$COMMIT" ] || { echo "__WFB_NO_COMMIT__"; exit 0; }
HEAD="$COMMIT"
TIER=""
# Bundle a detached COMMIT so `git clone <bundle>` checks it out: a bundle is only
# cloneable if it carries a HEAD entry, which `git bundle create <file> <bare-sha>`
# does NOT write. So point a UNIQUE temp branch at the commit, briefly repoint the
# symbolic HEAD to it just long enough to write `HEAD <branch>` into the bundle, then
# restore HEAD and delete the branch. This touches ONLY refs — never the index or
# working tree — and is fully reverted, so the gate/critic working-tree diff is
# unaffected. Captures run sequentially at session-end, so there is no concurrent
# git reader during the brief symref swap. Extra rev-limit args ($3+) pass through
# (e.g. "^$BASE" for a thin bundle). Returns non-zero on empty/failed bundle.
_BR="wfb-snapshot-$$"
wfb_bundle_commit() {
  _out="$1"; _commit="$2"; shift 2
  _sym=$(git symbolic-ref -q HEAD 2>/dev/null || echo "")
  git branch -f "$_BR" "$_commit" >/dev/null 2>&1 || return 1
  if [ -n "$_sym" ]; then git symbolic-ref HEAD "refs/heads/$_BR" >/dev/null 2>&1; fi
  git bundle create "$_out" HEAD "$_BR" "$@" >/dev/null 2>&1; _rc=$?
  if [ -n "$_sym" ]; then git symbolic-ref HEAD "$_sym" >/dev/null 2>&1; fi
  git branch -D "$_BR" >/dev/null 2>&1 || true
  [ "$_rc" = "0" ] && [ -s "$_out" ]
}
# Tier 1: SELF-CONTAINED full bundle (COMMIT + ancestors incl. BASE via -p). Cloneable
# anywhere (recovery) AND shares origin history (clean existing-repo PR).
if wfb_bundle_commit "$OUTB" "$COMMIT"; then TIER=full; else rm -f "$OUTB"; fi
# Tier 2: over the size cap → THIN (excludes BASE ancestors via ^BASE). NOT
# self-contained: apply must `git fetch` it INTO a clone of the target. tier=thin.
if [ -s "$OUTB" ] && [ -n "$MAXB" ] && [ "$(wc -c < "$OUTB" 2>/dev/null || echo 0)" -gt "$MAXB" ] && [ -n "$BASE" ] && [ "$BASE" != "$COMMIT" ]; then
  if wfb_bundle_commit "$OUTB.thin" "$COMMIT" "^$BASE"; then mv -f "$OUTB.thin" "$OUTB"; TIER=thin; else rm -f "$OUTB.thin"; fi
fi
# Tier 3: still over cap (or no bundle) → squashed-root (tree only, no shared history).
if { [ ! -s "$OUTB" ] || { [ -n "$MAXB" ] && [ "$(wc -c < "$OUTB" 2>/dev/null || echo 0)" -gt "$MAXB" ]; }; }; then
  SQ=$(GIT_AUTHOR_NAME="$WID" GIT_AUTHOR_EMAIL="$WEM" GIT_COMMITTER_NAME="$WID" GIT_COMMITTER_EMAIL="$WEM" git commit-tree "$TREE" -m "wfb snapshot" 2>/dev/null || echo ""); if [ -n "$SQ" ] && wfb_bundle_commit "$OUTB" "$SQ"; then TIER=squashed; BASE=""; HEAD="$SQ"; fi
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
    except Exception as exc:  # noqa: BLE001 — best-effort
        return False, str(exc)


def sync_source_bundle_openshell(
    runtime: Any,
    *,
    execution_id: str | None,
    node_id: str | None,
    repo_root: str | None = None,
) -> dict[str, Any]:
    """Bundle the produced SOURCE (git bundle, thin/tiered) and POST it as a durable
    `source-bundle` artifact (fileId -> Files API). One per node; skipped when the
    repo clone has no changed files. Never raises."""
    execution_id = _clean(execution_id)
    if not execution_id:
        return {"ok": True, "skipped": "no_run_context"}
    if not _INTERNAL_API_TOKEN:
        return {"ok": True, "skipped": "no_token"}

    root = _clean(repo_root) or (getattr(runtime, "cwd", None) or "/sandbox") or "/sandbox"
    exports = f"export ROOT={json.dumps(root)} MAXB={_MAX_BUNDLE_BYTES}; "
    try:
        res = runtime.execute(exports + _BUNDLE_SCRIPT, timeout_seconds=_GIT_TIMEOUT_SECONDS)
    except Exception as exc:  # noqa: BLE001
        return {"ok": True, "skipped": f"bundle_failed: {exc}"}

    out = str(res.get("stdout") or res.get("output") or "")
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
        return {"ok": True, "empty": True}  # node didn't change the repo
    if nbytes <= 0:
        return {"ok": True, "skipped": "no_bundle"}
    if nbytes > _MAX_BUNDLE_BYTES:
        return {"ok": True, "skipped": f"too_large: {nbytes}"}

    try:
        read = runtime.read_bytes_base64(_BUNDLE_OUT_FILE, max_bytes=_MAX_BUNDLE_BYTES)
    except Exception as exc:  # noqa: BLE001
        return {"ok": True, "skipped": f"read_failed: {exc}"}
    if not read.get("ok"):
        return {"ok": True, "skipped": f"read_failed: {read.get('error')}"}
    bundle_b64 = read.get("base64") or read.get("content") or ""
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

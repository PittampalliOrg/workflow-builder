"""Capture + restore of the Gemini/agy login state (``~/.gemini``).

The external runtime id is still ``agy-cli``, but the adapter now launches
legacy Gemini CLI. Gemini stores OAuth files at the top of ``~/.gemini`` while
Antigravity stored them under ``antigravity-cli/``. Capture both curated shapes
so existing bundles can still restore harmless state and new Gemini logins are
reused by future pods.

Capture is mtime-triggered (login writes the token file, a refresh rewrites it)
by a daemon watcher; the bundle is a base64'd tar.gz POSTed to the BFF, which
stores it per-user. The adapter's ``seed()`` restores it via ``restore_bundle``.
"""

from __future__ import annotations

import base64
import io
import json
import logging
import os
import tarfile
import threading
import time
import urllib.request
from pathlib import Path

logger = logging.getLogger(__name__)

# Curated subtree (relative to ~/.gemini) that boots the CLI signed-in. Excludes
# logs, conversations, and history content (regenerable, or conversation data we
# must not capture).
CAPTURE_INCLUDES = (
    # Legacy Gemini CLI auth/state.
    "oauth_creds.json",
    "google_accounts.json",
    "installation_id",
    "projects.json",
    "settings.json",
    "trusted_hooks.json",
    # Antigravity auth/state retained for backward-compatible restore.
    "antigravity-cli/antigravity-oauth-token",
    "antigravity-cli/installation_id",
    "antigravity-cli/settings.json",
    "antigravity-cli/cache/onboarding.json",
    "antigravity-cli/cache/projects.json",
    "antigravity-cli/builtin",
    "antigravity-cli/implicit",
    "config",
)

# Only OAuth-bearing files should trigger capture. ``google_accounts.json`` is
# account metadata; capturing it without ``oauth_creds.json`` overwrites a valid
# Gemini login bundle with a non-login bundle.
TOKEN_RELS = ("oauth_creds.json",)
AGY_PROVIDER = "google"

_WORKFLOW_BUILDER_URL = os.environ.get(
    "WORKFLOW_BUILDER_URL", "http://workflow-builder.nextjs.svc.cluster.local:3000"
)
_INTERNAL_API_TOKEN = os.environ.get("INTERNAL_API_TOKEN", "")


def make_bundle(gemini_dir: Path) -> str | None:
    """tar.gz the curated ``~/.gemini`` subtree → base64. Returns None when no
    (non-empty) token file is present (nothing worth capturing yet)."""
    has_token = False
    for rel in TOKEN_RELS:
        token = gemini_dir / rel
        try:
            if token.is_file() and token.stat().st_size > 0:
                has_token = True
                break
        except OSError:
            continue
    if not has_token:
        return None
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w:gz") as tar:
        for rel in CAPTURE_INCLUDES:
            path = gemini_dir / rel
            if path.exists():
                tar.add(path, arcname=rel)
    return base64.b64encode(buf.getvalue()).decode("ascii")


def restore_bundle(gemini_dir: Path, bundle_b64: str) -> int:
    """Extract a base64 tar.gz bundle into ``~/.gemini``. Returns the count of
    files written. NEVER clobbers a file that already exists (agy's own freshly
    refreshed token always wins for the live session)."""
    raw = base64.b64decode(bundle_b64)
    written = 0
    with tarfile.open(fileobj=io.BytesIO(raw), mode="r:gz") as tar:
        for member in tar.getmembers():
            if not member.isfile():
                continue
            rel = os.path.normpath(member.name)
            if rel.startswith("..") or os.path.isabs(rel):
                continue  # path-traversal guard
            dest = gemini_dir / rel
            if dest.exists():
                continue
            src = tar.extractfile(member)
            if src is None:
                continue
            dest.parent.mkdir(parents=True, exist_ok=True)
            dest.write_bytes(src.read())
            try:
                dest.chmod(0o600)
            except OSError:
                pass
            written += 1
    return written


def _post_bundle(session_id: str, bundle_b64: str) -> bool:
    url = f"{_WORKFLOW_BUILDER_URL}/api/internal/sessions/{session_id}/cli-credentials/capture"
    body = json.dumps({"provider": AGY_PROVIDER, "bundle": bundle_b64}).encode()
    req = urllib.request.Request(
        url,
        data=body,
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {_INTERNAL_API_TOKEN}",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            logger.info(
                "[agy-capture] %s -> HTTP %d (%d b64 bytes)",
                session_id,
                resp.status,
                len(bundle_b64),
            )
            return 200 <= resp.status < 300
    except Exception as exc:  # noqa: BLE001
        logger.warning("[agy-capture] POST failed %s: %s", session_id, exc)
        return False


def start_capture_watcher(
    session_id: str, gemini_dir: Path, *, interval: float = 15.0
) -> None:
    """Start a daemon thread that POSTs the curated bundle to the BFF whenever
    the agy token file changes (login writes it; a refresh rewrites it). No-op
    without a session id or INTERNAL_API_TOKEN. One watcher per session."""
    if not session_id or not _INTERNAL_API_TOKEN:
        logger.info("[agy-capture] watcher disabled (no session id / token)")
        return

    def _run() -> None:
        last_sig: tuple[tuple[str, int, int], ...] | None = None
        logger.info("[agy-capture] watcher started session=%s dir=%s", session_id, gemini_dir)
        while True:
            try:
                sig_parts: list[tuple[str, int, int]] = []
                for rel in TOKEN_RELS:
                    token = gemini_dir / rel
                    try:
                        if token.is_file() and token.stat().st_size > 0:
                            st = token.stat()
                            sig_parts.append((rel, st.st_mtime_ns, st.st_size))
                    except OSError:
                        continue
                if sig_parts:
                    sig = tuple(sig_parts)
                    if sig != last_sig:
                        time.sleep(1.0)  # let a mid-write settle
                        bundle = make_bundle(gemini_dir)
                        if bundle and _post_bundle(session_id, bundle):
                            last_sig = sig
            except Exception as exc:  # noqa: BLE001
                logger.debug("[agy-capture] tick failed: %s", exc)
            time.sleep(interval)

    threading.Thread(
        target=_run, name=f"agy-capture-{session_id}", daemon=True
    ).start()

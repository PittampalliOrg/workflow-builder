"""Capture of the codex (ChatGPT) login state (``$CODEX_HOME/auth.json``).

codex authenticates from a ChatGPT ``auth.json`` blob delivered as the
``CODEX_AUTH_JSON`` secret env var; ``CodexAdapter._materialize_auth`` writes it
to ``$CODEX_HOME/auth.json``. codex's access token is short-lived and its
**refresh token is single-use** (rotated on every refresh): codex refreshes on
boot and REWRITES ``auth.json`` with the new tokens + ``last_refresh``.

In the generator/critic loop a workflow run dispatches THREE separate codex pods
(plan → generate → critic) sequentially, each seeded with the SAME stored
``CODEX_AUTH_JSON``. Without capture, the first pod to refresh rotates the token
server-side, and the next pod — still holding the now-spent refresh token — gets
"refresh token already used" and auth-fails. This watcher POSTs the refreshed
``auth.json`` back to the BFF (mirroring ``agy_capture``), so the stored
credential stays current and the next sequential pod boots with a live token.
"""

from __future__ import annotations

import json
import logging
import os
import threading
import time
import urllib.request
from pathlib import Path

logger = logging.getLogger(__name__)

CODEX_PROVIDER = "openai"

_WORKFLOW_BUILDER_URL = os.environ.get(
    "WORKFLOW_BUILDER_URL", "http://workflow-builder.nextjs.svc.cluster.local:3000"
)
_INTERNAL_API_TOKEN = os.environ.get("INTERNAL_API_TOKEN", "")


def _valid_auth_blob(text: str) -> bool:
    """True when the blob parses as a codex auth.json with a tokens object —
    matches the BFF ``file`` credential format guard, so we never POST garbage."""
    try:
        obj = json.loads(text)
    except ValueError:
        return False
    return isinstance(obj, dict) and isinstance(obj.get("tokens"), dict)


def _post_blob(session_id: str, blob: str) -> bool:
    url = f"{_WORKFLOW_BUILDER_URL}/api/internal/sessions/{session_id}/cli-credentials/capture"
    body = json.dumps({"provider": CODEX_PROVIDER, "bundle": blob}).encode()
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
                "[codex-capture] %s -> HTTP %d (%d bytes)",
                session_id,
                resp.status,
                len(blob),
            )
            return 200 <= resp.status < 300
    except Exception as exc:  # noqa: BLE001
        logger.warning("[codex-capture] POST failed %s: %s", session_id, exc)
        return False


def start_capture_watcher(
    session_id: str, auth_path: Path, *, interval: float = 5.0
) -> None:
    """Daemon thread that POSTs ``auth.json`` to the BFF whenever codex rewrites
    it (boot refresh rotates the single-use token). Short interval so the capture
    lands before the next sequential loop pod is dispatched. No-op without a
    session id or INTERNAL_API_TOKEN. One watcher per session."""
    if not session_id or not _INTERNAL_API_TOKEN:
        logger.info("[codex-capture] watcher disabled (no session id / token)")
        return

    def _run() -> None:
        last_sig: tuple[int, int] | None = None
        logger.info(
            "[codex-capture] watcher started session=%s path=%s", session_id, auth_path
        )
        while True:
            try:
                if auth_path.is_file() and auth_path.stat().st_size > 0:
                    st = auth_path.stat()
                    sig = (st.st_mtime_ns, st.st_size)
                    if sig != last_sig:
                        time.sleep(1.0)  # let codex's mid-write settle
                        blob = auth_path.read_text(encoding="utf-8").strip()
                        if _valid_auth_blob(blob) and _post_blob(session_id, blob):
                            last_sig = sig
            except Exception as exc:  # noqa: BLE001
                logger.debug("[codex-capture] tick failed: %s", exc)
            time.sleep(interval)

    threading.Thread(
        target=_run, name=f"codex-capture-{session_id}", daemon=True
    ).start()

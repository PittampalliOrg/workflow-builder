"""Scan a sandbox's /mnt/session/outputs/* and POST each file to the BFF
Files API with purpose=output, scopeId=<session_id>.

Called from session_workflow at terminate time. Text + small-to-medium
binaries land in the Files page; files over 5 MB are skipped (logged).
Runs synchronously on the activity thread — uploads are best-effort and
failures are logged without aborting the workflow.
"""

from __future__ import annotations

import json
import logging
import mimetypes
import os
import urllib.request
from typing import Any

logger = logging.getLogger(__name__)

OUTPUTS_DIR = "/mnt/session/outputs"
MAX_PER_FILE_BYTES = 5 * 1024 * 1024
MAX_FILES_PER_SESSION = 50


def _internal_token() -> str:
    return os.environ.get("INTERNAL_API_TOKEN", "")


def _workflow_builder_url() -> str:
    return os.environ.get(
        "WORKFLOW_BUILDER_URL",
        "http://workflow-builder.nextjs.svc.cluster.local:3000",
    )


def _post_ingest(session_id: str, files_payload: list[dict[str, Any]]) -> None:
    token = _internal_token()
    if not token:
        logger.info(
            "[session-outputs] skipping upload for %s — INTERNAL_API_TOKEN unset",
            session_id,
        )
        return
    url = f"{_workflow_builder_url()}/api/internal/sessions/{session_id}/outputs/ingest"
    body = json.dumps({"files": files_payload}).encode()
    req = urllib.request.Request(
        url,
        data=body,
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {token}",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            payload = json.loads((resp.read() or b"{}").decode())
        created = payload.get("created") or []
        errors = payload.get("errors") or []
        logger.info(
            "[session-outputs] %s uploaded=%d errors=%d",
            session_id,
            len(created),
            len(errors),
        )
        for err in errors:
            logger.warning(
                "[session-outputs] %s per-file error %s: %s",
                session_id,
                err.get("name"),
                err.get("error"),
            )
    except Exception as exc:  # noqa: BLE001
        logger.warning("[session-outputs] POST failed for %s: %s", session_id, exc)


def scan_and_upload(session_id: str, runtime: Any) -> dict[str, Any]:
    """List every file under /mnt/session/outputs, base64-encode small-enough
    ones, and ship them to the BFF. Returns a summary dict suitable for
    logging. Never raises — upstream workflow shouldn't care if this fails.
    """
    if not session_id:
        return {"status": "skipped", "reason": "no session id"}

    glob_res = runtime.glob_files("**/*", OUTPUTS_DIR, MAX_FILES_PER_SESSION)
    if not glob_res.get("ok"):
        # `directory_not_found` is the common case when the agent wrote
        # nothing — treat as a no-op rather than an error.
        reason = glob_res.get("error") or "unknown"
        if reason == "directory_not_found":
            return {"status": "empty", "reason": "no outputs directory"}
        logger.warning(
            "[session-outputs] glob failed for %s: %s", session_id, reason
        )
        return {"status": "error", "reason": reason}

    matches = glob_res.get("matches") or []
    if not matches:
        return {"status": "empty", "reason": "no files"}

    files_payload: list[dict[str, Any]] = []
    skipped: list[dict[str, str]] = []
    for path in matches:
        read_res = runtime.read_bytes_base64(path, MAX_PER_FILE_BYTES)
        if not read_res.get("ok"):
            skipped.append({"path": path, "reason": str(read_res.get("error") or "")})
            continue
        rel = path
        for prefix in (f"{OUTPUTS_DIR}/", OUTPUTS_DIR):
            if rel.startswith(prefix):
                rel = rel[len(prefix) :].lstrip("/")
                break
        if not rel:
            rel = path.rsplit("/", 1)[-1]
        content_type, _ = mimetypes.guess_type(rel)
        files_payload.append(
            {
                "name": rel,
                "contentType": content_type,
                "base64": read_res["base64"],
            }
        )

    if not files_payload:
        if skipped:
            logger.info(
                "[session-outputs] %s found %d files, all skipped: %s",
                session_id,
                len(skipped),
                skipped,
            )
        return {"status": "empty", "reason": "all files skipped"}

    _post_ingest(session_id, files_payload)
    return {
        "status": "ok",
        "uploaded": len(files_payload),
        "skipped": len(skipped),
    }

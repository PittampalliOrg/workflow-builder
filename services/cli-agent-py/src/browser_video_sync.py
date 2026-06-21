"""Push Playwright-native browser session videos (.webm) to the BFF as
browser artifacts (R1 persisted recording).

The Playwright-MCP design critic runs ``@playwright/mcp`` over stdio IN-POD in
launch mode with ``--save-video`` (see scripts/seed-workflows.ts
PLAYWRIGHT_CRITIC_MCP). Playwright writes one .webm per browser context to the
MCP ``--output-dir`` (``/sandbox/work``, the shared JuiceFS mount) when each
context closes. Because the MCP server is a child of THIS pod's CLI process, the
.webm lands on our own filesystem — so at session end we just glob + base64 +
POST to the BFF's existing internal browser-artifacts ingest, which persists it
as a ``video`` asset (kind already modelled in workflow_browser_artifacts) and
serves it back for inline ``<video>`` playback on the run page.

Pod→BFF push (vs the BFF exec'ing into the pod) avoids the 4 KB chunked-stdout
limit that plagues binary reads over the workspace command channel. Best-effort:
a failure here never fails the session.
"""

from __future__ import annotations

import base64
import json
import os
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any, Mapping

# Mirror event_publisher / agy_capture env conventions.
_WORKFLOW_BUILDER_URL = os.environ.get(
    "WORKFLOW_BUILDER_URL", "http://workflow-builder.nextjs.svc.cluster.local:3000"
).rstrip("/")
_INTERNAL_API_TOKEN = os.environ.get("INTERNAL_API_TOKEN", "")

DEFAULT_OUTPUT_DIR = os.environ.get("CLI_BROWSER_VIDEO_DIR", "/sandbox/work")
# Per-file ceiling; a short headless critic session at 1280x720 is typically a
# few MB. Oversized files are skipped (logged) rather than ballooning the POST.
MAX_VIDEO_BYTES = int(os.environ.get("CLI_BROWSER_VIDEO_MAX_BYTES", str(64 * 1024 * 1024)))
MAX_VIDEO_FILES = int(os.environ.get("CLI_BROWSER_VIDEO_MAX_FILES", "10"))
_POST_TIMEOUT_SECONDS = int(os.environ.get("CLI_BROWSER_VIDEO_TIMEOUT_SECONDS", "120"))


def _record(value: Any) -> dict[str, Any]:
    return dict(value) if isinstance(value, Mapping) else {}


def _clean_string(value: Any) -> str | None:
    return value.strip() if isinstance(value, str) and value.strip() else None


def _discover_webm(output_dir: str) -> list[Path]:
    root = Path(output_dir)
    if not root.is_dir():
        return []
    files = [p for p in root.rglob("*.webm") if p.is_file()]
    # Newest first so the most relevant recordings win the per-session cap.
    files.sort(key=lambda p: p.stat().st_mtime, reverse=True)
    return files[:MAX_VIDEO_FILES]


def _post_artifact(payload: dict[str, Any]) -> tuple[bool, str]:
    body = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        f"{_WORKFLOW_BUILDER_URL}/api/internal/browser-artifacts",
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


def sync_browser_video_activity(
    _ctx_or_input: Any, input_data: dict[str, Any] | None = None
) -> dict[str, Any]:
    """Glob the MCP output dir for .webm recordings and push each to the BFF
    browser-artifacts ingest as a ``video`` asset. Never raises."""
    data = _record(input_data if input_data is not None else _ctx_or_input)

    if not _INTERNAL_API_TOKEN:
        return {"ok": True, "skipped": "no_token"}

    workflow_execution_id = _clean_string(data.get("workflowExecutionId"))
    workflow_id = _clean_string(data.get("workflowId"))
    node_id = _clean_string(data.get("nodeId"))
    if not workflow_execution_id or not workflow_id or not node_id:
        # No run context (e.g. a direct, non-workflow session) — nothing to attach to.
        return {"ok": True, "skipped": "no_run_context"}

    output_dir = _clean_string(data.get("outputDir")) or DEFAULT_OUTPUT_DIR
    workspace_ref = _clean_string(data.get("workspaceRef"))
    session_id = _clean_string(data.get("sessionId"))

    # Finalize the screencast first: browser_stop_video flushes the .webm to the
    # output dir (the recording was started by start_cli_activity). Without this
    # the file stays unwritten — process exit does NOT flush. Best-effort; if the
    # MCP server is gone or recording wasn't started, fall through to the glob.
    try:
        from src.playwright_mcp_client import browser_stop_video

        saved = browser_stop_video()
        if saved:
            print(f"[browser-video-sync] browser_stop_video saved {saved}", flush=True)
    except Exception as exc:  # noqa: BLE001
        print(f"[browser-video-sync] browser_stop_video skipped: {exc}", flush=True)

    files = _discover_webm(output_dir)
    if not files:
        return {"ok": True, "uploaded": [], "scanned": output_dir, "found": 0}

    uploaded: list[dict[str, Any]] = []
    for index, path in enumerate(files):
        try:
            size = path.stat().st_size
        except OSError as exc:
            uploaded.append({"file": str(path), "ok": False, "error": str(exc)})
            continue
        if size <= 0 or size > MAX_VIDEO_BYTES:
            uploaded.append(
                {"file": str(path), "ok": False, "skipped": "size", "sizeBytes": size}
            )
            continue
        try:
            payload_b64 = base64.b64encode(path.read_bytes()).decode("ascii")
        except OSError as exc:
            uploaded.append({"file": str(path), "ok": False, "error": str(exc)})
            continue

        ok, detail = _post_artifact(
            {
                "workflowExecutionId": workflow_execution_id,
                "workflowId": workflow_id,
                "nodeId": node_id,
                "workspaceRef": workspace_ref,
                "baseUrl": "",
                "status": "completed",
                "metadata": {
                    "source": "playwright-mcp-recordVideo",
                    "sessionId": session_id,
                    "fileName": path.name,
                    "sizeBytes": size,
                },
                "steps": [],
                "assets": [
                    {
                        "kind": "video",
                        "label": (
                            "Browser session recording"
                            if len(files) == 1
                            else f"Browser session recording {index + 1}"
                        ),
                        "payloadBase64": payload_b64,
                        "contentType": "video/webm",
                        "fileName": path.name,
                    }
                ],
            }
        )
        uploaded.append({"file": str(path), "ok": ok, "sizeBytes": size, "detail": detail})

    return {"ok": True, "uploaded": uploaded, "scanned": output_dir, "found": len(files)}

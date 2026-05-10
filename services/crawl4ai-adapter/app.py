"""crawl4ai-adapter — minimal v1.

Async-job HTTP API matching the orchestrator's `_run_durable_crawl4ai_job`
contract (services/workflow-orchestrator/activities/crawl4ai.py +
workflows/sw_workflow.py:_run_durable_crawl4ai_job):

    POST /crawl/jobs   { url, ... }            → 200 { jobId }
    GET  /crawl/jobs/{id}                      → 200 { complete, success,
                                                       data, error }

The orchestrator polls /crawl/jobs/{id} until `complete: true`, then unwraps
`data` into the workflow output. `success: true` means the crawl succeeded;
`error` carries the failure reason on `success: false`.

v1 strategy: HTTP fetch (httpx) + HTML→Markdown (markdownify). No JS rendering,
no Chromium. Right tool for ~90% of research targets (server-rendered docs,
marketing sites). Upgrade to crawl4ai library when JS-only sites enter scope.

Single-replica deployment: jobs are stored in-process. Knative scale-to-zero
would lose state mid-poll, so the stacks manifest pins replicas: 1.
"""

from __future__ import annotations

import asyncio
import logging
import os
import time
import uuid
from typing import Any

import httpx
from fastapi import FastAPI, HTTPException
from markdownify import markdownify
from pydantic import BaseModel, Field

logger = logging.getLogger("crawl4ai-adapter")
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")

USER_AGENT = "workflow-builder-crawl4ai-adapter/1.0 (+https://github.com/PittampalliOrg/workflow-builder)"
MAX_BODY_BYTES = int(os.environ.get("CRAWL4AI_MAX_BODY_BYTES", str(2 * 1024 * 1024)))
DEFAULT_TIMEOUT_S = float(os.environ.get("CRAWL4AI_FETCH_TIMEOUT_S", "30"))
JOB_RETENTION_S = int(os.environ.get("CRAWL4AI_JOB_RETENTION_S", "900"))


class CrawlRequest(BaseModel):
    url: str
    timeoutMs: int | None = Field(default=None, ge=1_000, le=120_000)
    maxBodyBytes: int | None = Field(default=None, ge=1024)
    headers: dict[str, str] | None = None


class JobAck(BaseModel):
    jobId: str


class JobStatus(BaseModel):
    complete: bool
    success: bool | None = None
    data: dict[str, Any] | None = None
    error: str | None = None


JOBS: dict[str, dict[str, Any]] = {}
JOBS_LOCK = asyncio.Lock()


async def _fetch_and_convert(req: CrawlRequest) -> dict[str, Any]:
    timeout_s = (req.timeoutMs / 1000.0) if req.timeoutMs else DEFAULT_TIMEOUT_S
    max_bytes = req.maxBodyBytes or MAX_BODY_BYTES
    headers = {"User-Agent": USER_AGENT}
    if req.headers:
        headers.update({k: v for k, v in req.headers.items() if v is not None})

    started = time.monotonic()
    async with httpx.AsyncClient(
        timeout=timeout_s,
        follow_redirects=True,
        headers=headers,
        limits=httpx.Limits(max_connections=4),
    ) as client:
        async with client.stream("GET", req.url) as response:
            response.raise_for_status()
            content_type = response.headers.get("content-type", "")
            chunks: list[bytes] = []
            received = 0
            async for chunk in response.aiter_bytes():
                received += len(chunk)
                if received > max_bytes:
                    raise ValueError(
                        f"response exceeded maxBodyBytes={max_bytes} (got >{received})"
                    )
                chunks.append(chunk)
            body = b"".join(chunks)
            final_url = str(response.url)
            status_code = response.status_code

    encoding = "utf-8"
    try:
        html = body.decode(encoding, errors="replace")
    except Exception:
        html = body.decode("latin-1", errors="replace")

    if "html" in content_type.lower():
        markdown = markdownify(html, heading_style="ATX", strip=["script", "style", "noscript"])
    else:
        markdown = html

    elapsed_ms = int((time.monotonic() - started) * 1000)
    return {
        "url": req.url,
        "finalUrl": final_url,
        "status": status_code,
        "contentType": content_type,
        "byteLength": len(body),
        "markdown": markdown,
        "elapsedMs": elapsed_ms,
    }


async def _run_job(job_id: str, req: CrawlRequest) -> None:
    try:
        result = await _fetch_and_convert(req)
        async with JOBS_LOCK:
            JOBS[job_id].update({"complete": True, "success": True, "data": result})
        logger.info(
            "crawl ok job=%s url=%s status=%s bytes=%s",
            job_id,
            req.url,
            result.get("status"),
            result.get("byteLength"),
        )
    except Exception as exc:
        message = f"{type(exc).__name__}: {exc}"
        async with JOBS_LOCK:
            JOBS[job_id].update({"complete": True, "success": False, "error": message})
        logger.warning("crawl failed job=%s url=%s err=%s", job_id, req.url, message)


async def _gc_old_jobs() -> None:
    cutoff = time.time() - JOB_RETENTION_S
    async with JOBS_LOCK:
        for jid in [k for k, v in JOBS.items() if v.get("complete") and v["createdAt"] < cutoff]:
            JOBS.pop(jid, None)


app = FastAPI(title="crawl4ai-adapter", version="1.0.0")


@app.get("/healthz")
async def healthz() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/readyz")
async def readyz() -> dict[str, str]:
    return {"status": "ready"}


@app.post("/crawl/jobs", response_model=JobAck)
async def post_job(req: CrawlRequest) -> JobAck:
    if not req.url:
        raise HTTPException(status_code=400, detail="url is required")
    job_id = uuid.uuid4().hex
    async with JOBS_LOCK:
        JOBS[job_id] = {"complete": False, "createdAt": time.time()}
    asyncio.create_task(_run_job(job_id, req))
    asyncio.create_task(_gc_old_jobs())
    return JobAck(jobId=job_id)


@app.get("/crawl/jobs/{job_id}", response_model=JobStatus)
async def get_job(job_id: str) -> JobStatus:
    async with JOBS_LOCK:
        rec = JOBS.get(job_id)
    if rec is None:
        raise HTTPException(status_code=404, detail=f"unknown jobId: {job_id}")
    return JobStatus(
        complete=bool(rec.get("complete")),
        success=rec.get("success"),
        data=rec.get("data"),
        error=rec.get("error"),
    )

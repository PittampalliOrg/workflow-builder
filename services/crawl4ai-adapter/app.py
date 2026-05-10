"""crawl4ai-adapter v2.

Async-job HTTP API matching the orchestrator's `_run_durable_crawl4ai_job`
contract (services/workflow-orchestrator/activities/crawl4ai.py +
workflows/sw_workflow.py:_run_durable_crawl4ai_job):

    POST /crawl/jobs   { url, ... }            → 200 { jobId }
    GET  /crawl/jobs/{id}                      → 200 { complete, success,
                                                       data, error }

The orchestrator polls /crawl/jobs/{id} until `complete: true`, then unwraps
`data` into the workflow output. `success: true` means the crawl succeeded;
`error` carries the failure reason on `success: false`.

## Dapr workflow durability

Three durability mechanisms layer on the orchestrator's per-activity
checkpointing:

1. **Job state in PostgreSQL** (table `crawl4ai_jobs`). Restart-safe — an
   adapter pod replacement does not lose in-flight job state, so the
   orchestrator's polling activity continues to find the job by its
   deterministic jobId after restart.

2. **Idempotent jobIds.** POST accepts an optional `jobId`; if a row with
   that id already exists in any state, the adapter returns the existing
   record. Activity retries (Dapr `WorkflowRetryPolicy`) become true no-ops
   for completed work and pure resume for in-flight work. Failed jobs reset
   to PENDING and re-kick on retry.

3. **Cache** (table `crawl4ai_cache`, key=sha256(url|tier-chain|schemaHash)).
   On retry after a network success but DB-write failure, the cache hit
   returns the same result without re-fetching.

## Tier escalation

A single POST can specify `tiers: [...]`; the adapter walks them in order,
escalating on block-detection (empty content, HTTP 403/429,
Cloudflare/Akamai interstitial markers). Tier choices:

- `http`     — httpx GET + markdownify (fast, no JS)
- `playwright` — Playwright Chromium headless + markdownify
- `stealth`  — Playwright with stealth tweaks (navigator.webdriver=false,
               plausible UA, viewport randomization)

## Schema-driven extraction

If `extractionSchema` (JSON Schema) is provided, the adapter passes the
markdown to Anthropic's tool-use API with the schema as the tool's
`input_schema`. The structured `extracted` field is returned alongside
the raw markdown. Otherwise just markdown is returned.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import os
import re
import time
import uuid
from contextlib import asynccontextmanager
from typing import Any

import asyncpg
import httpx
from fastapi import FastAPI, HTTPException
from markdownify import markdownify
from pydantic import BaseModel, Field

logger = logging.getLogger("crawl4ai-adapter")
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")

# --- Config ---------------------------------------------------------------

USER_AGENT = "workflow-builder-crawl4ai-adapter/2.0"
DEFAULT_TIMEOUT_S = float(os.environ.get("CRAWL4AI_FETCH_TIMEOUT_S", "30"))
MAX_BODY_BYTES = int(os.environ.get("CRAWL4AI_MAX_BODY_BYTES", str(2 * 1024 * 1024)))
DEFAULT_CACHE_TTL_S = int(os.environ.get("CRAWL4AI_CACHE_TTL_S", "3600"))
DATABASE_URL = os.environ["CRAWL4AI_DATABASE_URL"]
ANTHROPIC_API_KEY = os.environ.get("ANTHROPIC_API_KEY", "")
ANTHROPIC_MODEL = os.environ.get("CRAWL4AI_EXTRACTION_MODEL", "claude-haiku-4-5-20251001")

# Block-detection markers (case-insensitive substring match against the body).
BLOCK_MARKERS = (
    "checking your browser before",
    "cf-browser-verification",
    "ray id:",
    "akamai bot",
    "perimeterx",
    "verifying you are human",
    "captcha",
    "access denied",
    "incapsula",
)
EMPTY_BODY_THRESHOLD_BYTES = 512

# --- DB schema (idempotent on startup) ------------------------------------

DDL = """
CREATE TABLE IF NOT EXISTS crawl4ai_jobs (
    id          text PRIMARY KEY,
    state       text NOT NULL,
    request     jsonb NOT NULL,
    result      jsonb,
    error       text,
    cache_key   text,
    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS crawl4ai_jobs_state_idx
    ON crawl4ai_jobs (state, updated_at);

CREATE TABLE IF NOT EXISTS crawl4ai_cache (
    cache_key   text PRIMARY KEY,
    payload     jsonb NOT NULL,
    expires_at  timestamptz NOT NULL,
    created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS crawl4ai_cache_expires_idx
    ON crawl4ai_cache (expires_at);
"""

# --- Pydantic IO ----------------------------------------------------------

class CrawlRequest(BaseModel):
    url: str
    jobId: str | None = None
    tiers: list[str] | None = Field(
        default=None,
        description="Ordered tier list. Defaults to ['http']. Valid: http, playwright, stealth.",
    )
    timeoutMs: int | None = Field(default=None, ge=1_000, le=120_000)
    maxBodyBytes: int | None = Field(default=None, ge=1024)
    headers: dict[str, str] | None = None
    extractionSchema: dict[str, Any] | None = Field(
        default=None,
        description="JSON Schema. If present, the adapter runs an Anthropic structured extraction over the fetched markdown.",
    )
    extractionInstruction: str | None = Field(
        default=None,
        description="Free-text guidance to the LLM extractor (paired with extractionSchema).",
    )
    cacheTtlSeconds: int | None = Field(default=None, ge=0, le=86400)


class JobAck(BaseModel):
    jobId: str
    state: str
    existing: bool = False
    cacheHit: bool = False


class JobStatus(BaseModel):
    complete: bool
    success: bool | None = None
    data: dict[str, Any] | None = None
    error: str | None = None


# --- Lifespan -------------------------------------------------------------

POOL: asyncpg.Pool | None = None


@asynccontextmanager
async def lifespan(_: FastAPI):
    global POOL
    POOL = await asyncpg.create_pool(DATABASE_URL, min_size=1, max_size=4)
    async with POOL.acquire() as con:
        await con.execute(DDL)
    logger.info("crawl4ai-adapter ready (DB schema ensured)")
    yield
    if POOL is not None:
        await POOL.close()


app = FastAPI(title="crawl4ai-adapter", version="2.0.0", lifespan=lifespan)


# --- Helpers --------------------------------------------------------------

def _normalize_tiers(tiers: list[str] | None) -> list[str]:
    if not tiers:
        return ["http"]
    valid = {"http", "playwright", "stealth"}
    out = [t for t in tiers if t in valid]
    return out or ["http"]


def _cache_key(req: CrawlRequest) -> str:
    schema_blob = json.dumps(req.extractionSchema or {}, sort_keys=True)
    schema_hash = hashlib.sha256(schema_blob.encode()).hexdigest()[:16]
    tiers_str = "|".join(_normalize_tiers(req.tiers))
    return hashlib.sha256(f"{req.url}|{tiers_str}|{schema_hash}".encode()).hexdigest()


def _is_blocked(status: int, body_bytes: int, body_text: str | None) -> str | None:
    if status in (403, 429):
        return f"http_{status}"
    if body_bytes < EMPTY_BODY_THRESHOLD_BYTES:
        return "empty_body"
    if body_text:
        lower = body_text[:8192].lower()
        for marker in BLOCK_MARKERS:
            if marker in lower:
                return f"marker:{marker}"
    return None


# --- Tier implementations -------------------------------------------------

async def _fetch_http(req: CrawlRequest) -> dict[str, Any]:
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

    html = body.decode("utf-8", errors="replace")
    if "html" in content_type.lower():
        markdown = markdownify(html, heading_style="ATX", strip=["script", "style", "noscript"])
    else:
        markdown = html

    return {
        "tier": "http",
        "url": req.url,
        "finalUrl": final_url,
        "status": status_code,
        "contentType": content_type,
        "byteLength": len(body),
        "markdown": markdown,
        "elapsedMs": int((time.monotonic() - started) * 1000),
        "_blockReason": _is_blocked(status_code, len(body), html),
    }


async def _fetch_playwright(req: CrawlRequest, stealth: bool) -> dict[str, Any]:
    # Lazy-import so the http-only path doesn't pay the import cost.
    from playwright.async_api import async_playwright

    timeout_s = (req.timeoutMs / 1000.0) if req.timeoutMs else DEFAULT_TIMEOUT_S
    started = time.monotonic()

    async with async_playwright() as p:
        launch_args: list[str] = []
        if stealth:
            launch_args = ["--disable-blink-features=AutomationControlled"]
        browser = await p.chromium.launch(headless=True, args=launch_args)
        try:
            context_kwargs: dict[str, Any] = {
                "user_agent": (
                    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
                    "(KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36"
                    if stealth
                    else USER_AGENT
                ),
                "viewport": {"width": 1280, "height": 800},
            }
            if req.headers:
                context_kwargs["extra_http_headers"] = {
                    k: v for k, v in req.headers.items() if v is not None
                }
            context = await browser.new_context(**context_kwargs)
            if stealth:
                # Remove the most obvious automation tells.
                await context.add_init_script(
                    """
                    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
                    Object.defineProperty(navigator, 'languages', { get: () => ['en-US','en'] });
                    Object.defineProperty(navigator, 'plugins', { get: () => [1,2,3,4,5] });
                    """
                )
            page = await context.new_page()
            response = await page.goto(req.url, wait_until="domcontentloaded", timeout=timeout_s * 1000)
            # Brief settle so JS-driven content has a chance to render.
            try:
                await page.wait_for_load_state("networkidle", timeout=5_000)
            except Exception:
                pass

            final_url = page.url
            status_code = response.status if response else 0
            content_type = (response.headers.get("content-type", "") if response else "")
            html = await page.content()
            body_bytes = len(html.encode("utf-8", errors="replace"))
            markdown = markdownify(html, heading_style="ATX", strip=["script", "style", "noscript"])

            await context.close()

            return {
                "tier": "stealth" if stealth else "playwright",
                "url": req.url,
                "finalUrl": final_url,
                "status": status_code,
                "contentType": content_type,
                "byteLength": body_bytes,
                "markdown": markdown,
                "elapsedMs": int((time.monotonic() - started) * 1000),
                "_blockReason": _is_blocked(status_code, body_bytes, html),
            }
        finally:
            await browser.close()


async def _run_tier(tier: str, req: CrawlRequest) -> dict[str, Any]:
    if tier == "http":
        return await _fetch_http(req)
    if tier == "playwright":
        return await _fetch_playwright(req, stealth=False)
    if tier == "stealth":
        return await _fetch_playwright(req, stealth=True)
    raise ValueError(f"unknown tier: {tier}")


# --- Schema-driven extraction (Anthropic tool_use) ------------------------

async def _extract_with_schema(
    markdown: str,
    schema: dict[str, Any],
    instruction: str | None,
) -> dict[str, Any] | None:
    if not ANTHROPIC_API_KEY:
        logger.warning("schema extraction requested but ANTHROPIC_API_KEY missing — skipping")
        return None

    # Trim to a reasonable upper bound; schema extraction usually needs ≤30k tokens of context.
    body = markdown
    if len(body) > 200_000:
        body = body[:200_000]

    tool = {
        "name": "structured_extract",
        "description": "Emit the requested structured findings as a single JSON object matching the schema.",
        "input_schema": schema,
    }
    sys_prompt = (
        "You are a meticulous extraction model. Read the provided markdown content and call the "
        "`structured_extract` tool exactly once with values that satisfy the input_schema. "
        "Use only information present in the markdown; do not invent or infer beyond what the page states. "
        "If a required field is genuinely absent, set it to a sentinel (empty string / empty list / null where allowed)."
    )
    user_text = ""
    if instruction:
        user_text += f"Extraction instruction:\n{instruction.strip()}\n\n"
    user_text += "Markdown content:\n```\n" + body + "\n```"

    async with httpx.AsyncClient(timeout=120) as client:
        r = await client.post(
            "https://api.anthropic.com/v1/messages",
            headers={
                "x-api-key": ANTHROPIC_API_KEY,
                "anthropic-version": "2023-06-01",
                "content-type": "application/json",
            },
            json={
                "model": ANTHROPIC_MODEL,
                "max_tokens": 4096,
                "system": sys_prompt,
                "tools": [tool],
                "tool_choice": {"type": "tool", "name": "structured_extract"},
                "messages": [{"role": "user", "content": user_text}],
            },
        )
        r.raise_for_status()
        data = r.json()
    for block in data.get("content", []):
        if block.get("type") == "tool_use" and block.get("name") == "structured_extract":
            return block.get("input") or {}
    return None


# --- Job lifecycle (durable via PostgreSQL) -------------------------------

async def _kick_job(job_id: str, req: CrawlRequest) -> None:
    """Run the actual crawl; persist progress + result. Idempotency at the
    cache_key layer means a retry after partial completion still benefits
    from any successful fetch."""
    assert POOL is not None
    cache_key = _cache_key(req)

    # Cache short-circuit. Any prior run with the same (url, tier_chain,
    # schema_hash) returns immediately — the orchestrator's activity retry
    # becomes a no-op.
    async with POOL.acquire() as con:
        cached = await con.fetchrow(
            "SELECT payload FROM crawl4ai_cache WHERE cache_key=$1 AND expires_at > now()",
            cache_key,
        )
    if cached is not None:
        result = dict(cached["payload"]) if not isinstance(cached["payload"], dict) else cached["payload"]
        if isinstance(result, str):
            # asyncpg returns jsonb as string with some setups; normalise.
            result = json.loads(result)
        result["cacheHit"] = True
        async with POOL.acquire() as con:
            await con.execute(
                "UPDATE crawl4ai_jobs SET state='COMPLETE', result=$2, updated_at=now() WHERE id=$1",
                job_id,
                json.dumps(result),
            )
        logger.info("cache hit job=%s key=%s", job_id, cache_key[:12])
        return

    # Mark RUNNING.
    async with POOL.acquire() as con:
        await con.execute(
            "UPDATE crawl4ai_jobs SET state='RUNNING', updated_at=now() WHERE id=$1",
            job_id,
        )

    tiers = _normalize_tiers(req.tiers)
    last: dict[str, Any] | None = None
    last_error: str | None = None
    block_reasons: list[str] = []

    for tier in tiers:
        try:
            result = await _run_tier(tier, req)
        except Exception as exc:
            last_error = f"{type(exc).__name__}: {exc}"
            logger.warning("tier=%s job=%s url=%s err=%s", tier, job_id, req.url, last_error)
            continue
        last = result
        block = result.pop("_blockReason", None)
        if block:
            block_reasons.append(f"{tier}:{block}")
            # Escalate to next tier.
            continue
        # Success — try schema extraction if requested.
        if req.extractionSchema:
            try:
                extracted = await _extract_with_schema(
                    result.get("markdown") or "",
                    req.extractionSchema,
                    req.extractionInstruction,
                )
                result["extracted"] = extracted
            except Exception as exc:
                logger.warning("extract failed job=%s err=%s", job_id, exc)
                result["extractError"] = f"{type(exc).__name__}: {exc}"
        result["tiersAttempted"] = tiers[: tiers.index(tier) + 1]
        result["blocksObserved"] = block_reasons
        # Persist + cache.
        ttl = req.cacheTtlSeconds if req.cacheTtlSeconds is not None else DEFAULT_CACHE_TTL_S
        async with POOL.acquire() as con:
            async with con.transaction():
                await con.execute(
                    "UPDATE crawl4ai_jobs SET state='COMPLETE', result=$2, error=NULL, "
                    "cache_key=$3, updated_at=now() WHERE id=$1",
                    job_id,
                    json.dumps(result),
                    cache_key,
                )
                if ttl > 0:
                    await con.execute(
                        "INSERT INTO crawl4ai_cache (cache_key, payload, expires_at) "
                        "VALUES ($1, $2, now() + ($3 || ' seconds')::interval) "
                        "ON CONFLICT (cache_key) DO UPDATE SET payload=EXCLUDED.payload, "
                        "expires_at=EXCLUDED.expires_at",
                        cache_key,
                        json.dumps(result),
                        str(ttl),
                    )
        logger.info(
            "ok job=%s url=%s tier=%s status=%s bytes=%s",
            job_id,
            req.url,
            result["tier"],
            result.get("status"),
            result.get("byteLength"),
        )
        return

    # All tiers exhausted without an unblocked response.
    err_msg = last_error or "all_tiers_blocked: " + ",".join(block_reasons)
    async with POOL.acquire() as con:
        await con.execute(
            "UPDATE crawl4ai_jobs SET state='FAILED', error=$2, result=$3, updated_at=now() WHERE id=$1",
            job_id,
            err_msg,
            json.dumps(last) if last else None,
        )
    logger.warning("failed job=%s url=%s reasons=%s", job_id, req.url, err_msg)


# --- HTTP routes ----------------------------------------------------------

@app.get("/healthz")
async def healthz() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/readyz")
async def readyz() -> dict[str, Any]:
    if POOL is None:
        raise HTTPException(503, detail="db pool not ready")
    async with POOL.acquire() as con:
        await con.execute("SELECT 1")
    return {"status": "ready"}


@app.post("/crawl/jobs", response_model=JobAck)
async def post_job(req: CrawlRequest) -> JobAck:
    if not req.url:
        raise HTTPException(400, detail="url is required")
    if not re.match(r"^https?://", req.url):
        raise HTTPException(400, detail="url must be http(s)")
    assert POOL is not None

    job_id = req.jobId or uuid.uuid4().hex

    async with POOL.acquire() as con:
        row = await con.fetchrow(
            "SELECT state FROM crawl4ai_jobs WHERE id=$1",
            job_id,
        )
        if row is not None:
            state = row["state"]
            if state in ("PENDING", "RUNNING", "COMPLETE"):
                # Idempotent: orchestrator activity retry returns existing job.
                return JobAck(jobId=job_id, state=state, existing=True)
            # FAILED — reset and re-kick. This is the Dapr-retry path.
            await con.execute(
                "UPDATE crawl4ai_jobs SET state='PENDING', error=NULL, request=$2, "
                "updated_at=now() WHERE id=$1",
                job_id,
                json.dumps(req.model_dump()),
            )
            asyncio.create_task(_kick_job(job_id, req))
            return JobAck(jobId=job_id, state="PENDING", existing=True)

        # Brand new job.
        await con.execute(
            "INSERT INTO crawl4ai_jobs (id, state, request) VALUES ($1, 'PENDING', $2)",
            job_id,
            json.dumps(req.model_dump()),
        )

    asyncio.create_task(_kick_job(job_id, req))
    return JobAck(jobId=job_id, state="PENDING")


@app.get("/crawl/jobs/{job_id}", response_model=JobStatus)
async def get_job(job_id: str) -> JobStatus:
    assert POOL is not None
    async with POOL.acquire() as con:
        row = await con.fetchrow(
            "SELECT state, result, error FROM crawl4ai_jobs WHERE id=$1",
            job_id,
        )
    if row is None:
        raise HTTPException(404, detail=f"unknown jobId: {job_id}")
    state = row["state"]
    result = row["result"]
    if isinstance(result, str):
        result = json.loads(result)
    if state == "COMPLETE":
        return JobStatus(complete=True, success=True, data=result)
    if state == "FAILED":
        return JobStatus(complete=True, success=False, data=result, error=row["error"])
    return JobStatus(complete=False)

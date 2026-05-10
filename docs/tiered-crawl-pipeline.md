# Tiered Crawl Pipeline (`crawl4ai-adapter` v2 + `browserresearchfanout01` v3)

The canonical pattern for any multi-URL **fetch + extract + synthesize** workflow on this platform. Designed to be fully durable under Dapr workflow methodology — orchestrator pod restart, adapter pod restart, and per-URL retry all recover without intervention.

This pipeline replaces the v2 browser-use-agent path for **research/extraction** workflows. Browser-use-agent stays the right tool for **interactive** browser tasks (form fills, login flows, click-through dashboards, vision-based extraction).

## Shape

```
trigger {topic, urls, extractionPrompt}
  │
  ▼
┌─────────────────────────────────────────────────┐
│  for { url in .trigger.urls }   (sequential)   │
│                                                 │
│    web/crawl.async                              │
│      ├─ start_job activity (deterministic id)  │
│      └─ poll loop: get_job + durable timer     │
│         (all activity calls are Dapr-durable)  │
└─────────────────────────────────────────────────┘
  │
  ▼
┌─────────────────────────────────────────────────┐
│  durable/run text-research-synthesizer          │
│    workspaceRef: "local"  (no per-run sandbox) │
│    Pure text agent — no MCP, no browser,       │
│    no tools. Reads pre-extracted corpus.       │
└─────────────────────────────────────────────────┘
  │
  ▼
workflow_executions.output (structured JSON + synthesis)
```

## Five-layer durability stack

The orchestrator's per-activity Dapr checkpointing is the foundation; the adapter adds four more layers on top so a crash anywhere recovers without manual intervention.

| Layer | Mechanism | Protects against |
|---|---|---|
| 1 | **Per-activity Dapr checkpoint** — orchestrator's `for { url }` runs each `web/crawl.async` as a separate `start_job + polling get_job + durable timer` sequence | workflow-orchestrator pod restart mid-fan-out |
| 2 | **Postgres-backed adapter state** — tables `crawl4ai_jobs` + `crawl4ai_cache`, DDL auto-applied on lifespan | adapter pod restart loses no in-flight work |
| 3 | **Idempotent jobIds** — `j_<sha256(workflowId\|nodeId\|url)>[:32]` deterministic; existing rows returned as-is, FAILED rows reset+re-kick | activity retries via Dapr retry policy become true no-ops |
| 4 | **Cache hit short-circuit** — `sha256(url\|tier_chain\|schemaHash)` keyed; activity retry after partial network success returns cached result | re-fetch on retry of completed work |
| 5 | **Lazy orphan-resume in `get_job`** — polling activity with stale `updated_at` triggers re-kick from the row's stored `request` | adapter pod restart with in-flight RUNNING jobs that the startup watchdog missed |

## crawl4ai-adapter v2

Source: `services/crawl4ai-adapter/`. Image: `ghcr.io/pittampalliorg/crawl4ai-adapter:git-<sha>`. Single-replica `Deployment` in `workflow-builder` namespace.

### HTTP API

```
POST /crawl/jobs
{
  url: string,
  jobId?: string,                  // orchestrator passes deterministic id
  tiers?: ["http","playwright","stealth"],
  cacheTtlSeconds?: number,        // default 3600
  extractionSchema?: JSONSchema,   // optional Anthropic tool_use schema
  extractionInstruction?: string,
  timeoutMs?: number,              // 1000-120000
  maxBodyBytes?: number,
  headers?: { ... }
}
→ 200 { jobId, state: "PENDING"|"RUNNING"|"COMPLETE"|"FAILED", existing?: bool }

GET /crawl/jobs/{id}
→ 200 { complete, success?, data?, error? }
```

The polling endpoint is the orchestrator's contact point. It's also where lazy orphan-resume runs.

### Job state lifecycle

```
                ┌─────────┐
       POST →   │ PENDING │ ←─ FAILED row reset on retry POST
                └────┬────┘ ←─ stale RUNNING auto-resumed via lazy GET
                     │ asyncio.create_task(_kick_job)
                     ▼
                ┌─────────┐
                │ RUNNING │ (cache check → tier walk → schema extract)
                └────┬────┘
                     │
        ┌────────────┴────────────┐
        ▼                         ▼
   ┌──────────┐              ┌────────┐
   │ COMPLETE │              │ FAILED │
   └──────────┘              └────────┘
```

### Tier escalation

A single POST can specify `tiers: [...]`; the adapter walks them in order, escalating on block detection (empty body, HTTP 403/429, Cloudflare/Akamai/PerimeterX/Captcha markers in body).

| Tier | Implementation | When |
|---|---|---|
| `http` | httpx GET + markdownify | Server-rendered docs, marketing pages — sub-second, no JS |
| `playwright` | Chromium headless + markdownify | JS-rendered SPAs that don't anti-bot |
| `stealth` | Playwright + `navigator.webdriver=false` + plausible UA + JS plugin shimming | Sites that detect headless Chrome (kubernetes.io, etc.) |

### Schema-driven extraction

When `extractionSchema` (JSON Schema) is passed, the adapter calls Anthropic's `tool_use` API with the schema as the tool's `input_schema`. The structured `extracted` field is returned alongside raw markdown. `tool_choice: {type: "tool", name: "structured_extract"}` forces a single tool call — no freeform JSON parsing needed downstream.

If `ANTHROPIC_API_KEY` is unset, the adapter logs a warning and skips extraction; raw markdown is still returned.

### Database tables

```sql
CREATE TABLE crawl4ai_jobs (
    id          text PRIMARY KEY,         -- deterministic from orchestrator
    state       text NOT NULL,            -- PENDING|RUNNING|COMPLETE|FAILED
    request     jsonb NOT NULL,           -- full POST body (for resume)
    result      jsonb,
    error       text,
    cache_key   text,
    created_at  timestamptz DEFAULT now(),
    updated_at  timestamptz DEFAULT now()
);
CREATE INDEX crawl4ai_jobs_state_idx ON crawl4ai_jobs (state, updated_at);

CREATE TABLE crawl4ai_cache (
    cache_key   text PRIMARY KEY,         -- sha256(url|tiers|schemaHash)
    payload     jsonb NOT NULL,
    expires_at  timestamptz NOT NULL,
    created_at  timestamptz DEFAULT now()
);
```

DDL is applied on adapter lifespan startup (idempotent).

## browserresearchfanout01 v3 spec

Workflow ID: `browserresearchfanout01`. The full spec is in the dev DB; the canonical seed script is `scripts/seed-research-fanout-v3.js` (gitignored, run from inside the BFF pod).

Trigger inputs:
- `topic` (string)
- `urls` (string array)
- `extractionPrompt` (string)

Spec excerpt (the parts that matter for adaptation):

```yaml
do:
  - fetch_each:
      for: { each: url, in: ${ .trigger.urls }, at: idx }
      do:
        - crawl:
            call: web/crawl.async
            with:
              url: ${ .url }
              tiers: ["http", "playwright", "stealth"]
              cacheTtlSeconds: 1800
              extractionSchema: <PER_URL_SCHEMA>
              extractionInstruction: ${ ... }
              timeoutMs: 60000

  - synthesize:
      call: durable/run
      with:
        workspaceRef: local
        body:
          prompt: ${ <jq expression that walks for-task outputs> }
          agentRef: { slug: text-research-synthesizer }
          overrides: { maxTurns: 4, timeoutMinutes: 5 }
```

### Synthesizer prompt — accessing for-task outputs

Per-URL outputs are stored at `<for_name>/<sub_name>[<idx>]`. The orchestrator's `_unwrap_standardized_output` strips ONE `{success, data}` envelope, so the value at that key is the activity envelope:

```json
{
  "complete": true,
  "success": true,
  "data": {
    "tier": "http",
    "url": "https://...",
    "status": 200,
    "markdown": "...",
    "extracted": { ... },
    "blocksObserved": []
  },
  "error": null
}
```

To walk this in jq from a downstream task, **read `.data.tier` / `.data.extracted` — NOT `.tier` / `.extracted`** (the v3-iter1 bug; agent saw null corpus and called WebSearch to compensate).

The full synthesizer-prompt jq:

```jq
${
  . as $r |
  "topic: " + $r.trigger.topic +
  "\n\nextractionPrompt: " + $r.trigger.extractionPrompt +
  "\n\ncorpus (per-URL):\n" +
  ([
    range(0; $r.trigger.urls | length) | . as $i |
    ($r["fetch_each/crawl[" + ($i | tostring) + "]"] // {}) as $row |
    {
      url: $r.trigger.urls[$i],
      tier: $row.data.tier,
      status: $row.data.status,
      blocksObserved: $row.data.blocksObserved,
      extracted: $row.data.extracted,
      extractError: $row.data.extractError
    }
  ] | tojson)
}
```

The `($r[...] // {})` fallback guards against missing keys during workflow replay.

## text-research-synthesizer agent

Slug: `text-research-synthesizer`. Runtime: `dapr-agent-py`. Runs on the shared `agent-runtime-pool-coding` pool (no per-agent SandboxWarmPool needed).

Config highlights:

```js
{
  role: "Research synthesizer",
  modelSpec: "claude-haiku-4-5-20251001",
  maxTurns: 4,
  timeoutMinutes: 5,
  builtinTools: [],
  mcpServers: [],
  skills: [],
  runtime: "dapr-agent-py",
  // No browser tools, no MCP — text-only.
  instructions: [
    "You receive `topic`, `extractionPrompt`, and `entries` ...",
    "For each entry where markdown is present and status==200: extract per the extractionPrompt.",
    "For entries marked blocked or with no markdown: include them but set notes:'blocked'; do NOT invent findings.",
    "Then synthesize across all successful entries (3-5 short bullets).",
    ...
  ],
}
```

Pure text agent design choice: the per-URL extractions are already structured by Anthropic-validated schema in the adapter. The synthesizer's job is just to read the pre-extracted corpus and produce a cross-URL synthesis. Keeping it text-only avoids the browser-use step-budget cliff edges and the WebSearch tool-call temptation.

## When NOT to use this pipeline

- **Interactive browser flows**: form fills, login + 2FA, click-through dashboards, dynamic content that requires sustained per-session reasoning. Keep `runtime: browser-use-agent` + SandboxWarmPool path.
- **Vision-based tasks**: anything where the LLM needs to look at screenshots and reason about visual layout. Browser-use's per-step screenshot loop is what this pipeline gives up.
- **Stateful multi-turn navigation**: clicking through paginated content where state must persist across steps. Each `web/crawl.async` is stateless.

## When you SHOULD use this pipeline

- **Multi-URL research / extraction**: hand it a topic + URL list and a JSON schema; get structured findings back. The cross-URL synthesis covers cases like "compare across N pages."
- **Documentation harvesting**: server-rendered docs sites where the cheapest tier (HTTP fetch) gets you the full content.
- **Anti-bot resilience required**: the tier escalation + stealth Playwright option handle Cloudflare interstitials and basic headless detection.
- **Workflows that need per-URL Dapr checkpoints**: a crash mid-batch resumes per-URL, not from scratch.

## Verified durability test (2026-05-10)

End-to-end smoke proving Dapr methodology hold-up under failure:

1. Triggered 4-URL workflow.
2. Mid-flight `kubectl delete pod -l app.kubernetes.io/name=crawl4ai-adapter --grace-period=0 --force` while one URL was in `RUNNING` state and three were `COMPLETE`.
3. New adapter pod started ~10s later. Startup watchdog scanned but missed the orphan (only 5s old at scan time — 30s threshold too generous; later tightened to 10s).
4. Orchestrator's polling activity hit the new pod via `GET /crawl/jobs/{id}`. Lazy orphan-resume detected `state=RUNNING AND age_s > 10` and re-kicked.
5. The re-kicked task picked up the row's stored `request`, fetched the URL, marked `COMPLETE`.
6. Orchestrator's next poll returned `complete: true` → activity returned → workflow proceeded.
7. Synthesizer ran on the (now complete) corpus. Workflow finished `success` in 31.9s. **No manual intervention.**

## Migration from v2

v2 was browser-use-agent driven (`durable/run` against a SandboxWarmPool agent that allocated a remote Chrome from browserstation per URL). Issues that drove the rewrite:

- Browser-use's internal step budget (15) caps per-session work — a 4-URL run with retries exhausted it before extraction completed.
- Browser-use leaked browserstation Chrome actors (no `DELETE /browsers/{id}` on session end) — pool exhaustion blocked subsequent runs.
- Anti-bot sites (kubernetes.io) served stub pages to headless Chrome but the agent's empty extraction was hard to detect cleanly inside the agent loop.
- A monolithic `durable/run` for both fetch + extract + synthesis put everything inside one child workflow's checkpoint — adapter restarts orphaned the entire run.

The v3 pipeline addresses each: deterministic per-URL activity checkpoints (Dapr durability), tiered fetch with anti-bot escalation (no agent step budget involved), schema-validated extraction at the adapter layer (no agent reasoning needed), and a text-only synthesizer that works from a pre-validated corpus (no tool-call temptation).

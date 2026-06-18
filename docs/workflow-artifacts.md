# Standardized Workflow Artifacts

A single generic table + producer + UI pattern for surfacing **typed, named** workflow outputs. Replaces the per-workflow ad-hoc storage problem (synthesis output buried in `output.outputs.<node>.data.content`, etc.) with one mechanism that generalizes across workflow types and output types.

## Why

Before this lands, every meaningful workflow output had its own bespoke pipeline:
- `workflow_browser_artifacts` + dedicated Browser tab — only `browser/validate` writes here
- `workflow_plan_artifacts` + dedicated Plan tab — only the planner writes here
- `files` + `/files` page — agent session outputs only, surfaced separately from the run-detail UI
- `workflow_executions.output` JSONB — every other output buried six levels deep, rendered through a single `<JsonViewer data={output} />` dump

Concretely: the v3 research workflow's synthesis output (a 2 KB markdown response) was completely invisible to anyone clicking through the run-detail UI — the JSON tree had to be expanded six levels to find a string.

The standardized artifacts surface lets any node in any workflow declare its outputs once and have them render coherently. No new tab per workflow; no JSON spelunking.

## Producer side: declarative `artifacts:` block

Any SW 1.0 task can carry an `artifacts: [...]` list alongside its `with:` block:

```yaml
synthesize:
  call: durable/run
  with:
    workspaceRef: local
    body: ...
  artifacts:
    - kind: markdown
      slot: primary                          # primary | secondary | aux
      title: "Research synthesis"
      description: "${ .trigger.topic }"     # optional, jq-evaluated
      from: "${ .data.content }"             # jq → wrapped per-kind
      contentType: "text/markdown"           # optional
      metadata: "${ { topic: .trigger.topic, urlCount: (.trigger.urls | length) } }"
      if: "${ .data.content != null }"       # optional gate
```

**Resolution timing**: after the task's result is finalized (`_store_task_output` ran). Each entry's jq fields evaluate against a per-task expression context that exposes the just-completed task's payload uniformly, regardless of how nested the producer's envelope is.

**Expression context shape** (`_persist_task_artifacts` in `services/workflow-orchestrator/workflows/sw_workflow.py`):

The hook strips two wrappers — `{label, actionType, data}` from `_store_task_output`, then a `{success, data, error}` envelope if present — to reach the *payload* the task produced. Then:

- If the payload already has a `.data` field (e.g. `web/crawl.async`'s `{complete, success, data: {tier, markdown, …}, error}`), the context root is the payload itself. So `${ .data.markdown }`, `${ .complete }`, `${ .success }` all resolve.
- If the payload is flat (e.g. an agent run returning `{success, content, turn, …}`), the context wraps it as `{data: payload}`. So `${ .data.content }` still works — same idiom on both shapes.

This means a single canonical access pattern (`${ .data.X }`) works across crawl tasks, agent runs, system/* calls, and `for`-loop iterations. The hook also exposes `.input` (trigger), `.state.X`, and every previously-completed task by name (e.g. `${ .fetch_each.data.tier }`).

**Auto-wrapping by kind**: `from:` produces the inner value; the orchestrator wraps it for the renderer:

| `kind` | `from: "${ X }"` becomes inline_payload |
|---|---|
| `markdown` | `{ markdown: <X> }` |
| `text` | `{ text: <X> }` |
| `json` | `{ value: <X> }` |
| `link` | `{ url: <X> }` |
| `table` | `<X>` (must already be `{ columns, rows }`) |
| anything else | `<X>` (UI falls back to JSON dump) |

**Idempotency**: artifact id is `sha256(workflowId|executionId|nodeId|kind|title)[:24]`. Activity retries via Dapr's per-activity retry policy collapse to UPSERTs on the same row.

**Best-effort by design**: the persist activity logs but never propagates network / 4xx / 5xx errors. Observability writes never break the workflow they describe.

**For-loop pattern**: artifacts on iteration sub-tasks are written per iteration — the `node_id` column distinguishes them (`fetch_each/crawl[0]`, `fetch_each/crawl[1]`, ...). Title jq can interpolate iteration data:

```yaml
fetch_each:
  for: { each: url, in: ${ .trigger.urls }, at: idx }
  do:
    - crawl:
        call: web/crawl.async
        with: { url: ${ .url }, ... }
        artifacts:
          - kind: json
            slot: aux
            title: "${ \"Extraction · \" + .url }"
            from: "${ .data.extracted }"
          - kind: markdown
            slot: aux
            title: "${ \"Markdown · \" + .url }"
            from: "${ .data.markdown }"
```

## Consumer side: discriminated-union renderer

Schema:

```typescript
{
  id: string,
  workflowExecutionId: string,        // FK CASCADE
  nodeId: string | null,
  slot: 'primary' | 'secondary' | 'aux' | null,
  kind: string,                       // discriminator
  title: string,
  description: string | null,
  inlinePayload: unknown,             // for kinds whose payload fits ≤256 KB
  fileId: string | null,              // for blob-backed artifacts (FK files SET NULL)
  contentType: string | null,
  sizeBytes: number | null,
  metadata: Record<string, unknown> | null,
  createdAt: string
}
```

Standard kinds + renderers (`src/lib/components/workflow/execution/artifact-renderer.svelte`):

| `kind` | inline_payload shape | UI |
|---|---|---|
| `markdown` | `{ markdown: string }` | `Response` (Streamdown + Shiki) |
| `json` | `{ value: any }` | `JsonViewer` |
| `text` | `{ text: string }` | `<pre>` |
| `table` | `{ columns: string[], rows: any[][] }` | inline table |
| `image` | `{ alt: string }` (blob via `fileId`) | `<img>` |
| `link` | `{ url: string }` | anchor |
| `card` | `{ body: string, footer?: string }` | shadcn `<Card>` |
| `goal_spec` | `{ objective, acceptanceCriteria[], evidence:{commands[]}, maxIterations?, tokenBudget?, rationale, lint:{warnings[]} }` | authored sprint-contract card (objective + criteria checklist + evidence chips + rationale + lint warnings); emitted by the workflow `goal/plan` PLAN node, see `docs/goal-authoring-and-claude-alignment.md` |
| anything else | passthrough | JSON dump |

**`<ArtifactList>`** (`src/lib/components/workflow/execution/artifact-list.svelte`) groups by slot. `mode="primary"` renders only the primary-slot subset (used on the Overview tab); `mode="all"` renders the full grouped list (used on the Outputs tab).

**Run-detail UI integration**:
- **Overview tab** — `<ArtifactList mode="primary" />` features primary-slot artifacts above the raw `output` JSON (which collapses to a debug pane when artifacts are present, or stays expanded when not — backward compat).
- **Outputs tab** (new, between Overview and Steps) — `<ArtifactList mode="all" />` shows everything grouped: primary expanded, secondary expanded, aux + other collapsed-by-default.

## Storage internals

Single table `workflow_artifacts` (drizzle migration `0067`). Hybrid storage:
- **Inline path** (the cheap path): structured payloads ≤256 KB live in `inline_payload jsonb`. Queryable directly. No extra round-trip in the GET API — `inlinePayload` is included in the list response.
- **Blob path** (forward-looking): for image/video/large-markdown, set `file_id` to reference the existing `files` + `filePayloads` infrastructure (proven 25 MB cap, SHA-1 dedup, soft-delete, existing internal-token write API). The `image` renderer already uses `/api/v1/files/[id]/content` to fetch.

Cascade delete tied to `workflow_executions` matches the user's mental model — when an execution is deleted, its artifacts go with it. `file_id` is `ON DELETE SET NULL` so artifact metadata survives if the underlying blob is GC'd.

## APIs

```
GET  /api/workflows/executions/[id]/artifacts          # user-auth, workspace-scoped
POST /api/internal/workflows/executions/[id]/artifacts # internal-token, UPSERT by id
```

The GET response is what the run-detail page's snapshot loader fetches via `listWorkflowArtifactsByExecutionId` (`src/lib/server/workflow-artifacts.ts`); ordered by slot priority then created_at.

## Backward compatibility

- `workflow_browser_artifacts` and `workflow_plan_artifacts` are unchanged — they have working type-specific renderers (Browser tab, Plan tab) and stay alongside the new generic surface.
- Workflows without `artifacts:` blocks behave exactly as before. The Outputs tab is empty; the Overview tab falls back to its original `<JsonViewer data={output} />` rendering.

## Out of scope (deferred)

- **Migrating existing browser/plan artifact tables into `workflow_artifacts`**. Their renderers are working; cross-table merge is a follow-up if/when we want unified Output-tab listing.
- **Object storage backend** (S3/MinIO) for very-large artifacts. Inline ≤256 KB + `files`-backed (≤25 MB) covers everything we ship today.
- **Versioning**. Today's UPSERT-by-deterministic-id semantics mean re-runs overwrite. If we ever need history-of-artifacts, add a `version` column.
- **Inter-workflow artifact reuse** ("use this artifact as input to another workflow"). Belongs in a separate junction table.

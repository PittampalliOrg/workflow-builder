# Workflow Builder

Visual workflow builder with Dapr workflow orchestration, durable AI agents, and MCP server integration. SvelteKit serves as UI + BFF proxy; all workflow execution lives in Dapr on Kubernetes.

> **Supplementary docs** (`docs/`): `agent-runtime-comparison.md` (dapr-agent-py vs claude-agent-py + swap-blockers), `durable-session-runtime-contract.md` (swappable runtime contract + registry), `activepieces-auth.md`, `mcp-agent-workflows.md`, `hooks-and-plugins.md`, `CLICKHOUSE_OBSERVABILITY.md`, `openshell-capabilities.md`, `cma-parity.md`, `callable-agents.md` (`CallAgent` peer-delegation), `tiered-crawl-pipeline.md` (crawl4ai v2 + browserresearchfanout01 v3), `workflow-artifacts.md`, `workflow-lifecycle-termination.md` (**lifecycle SSOT**).

> **Skills**: `skaffold-dev-loop` (inner/outer dev loop), `gitops` (stacks/ArgoCD/promotion), `workflow-builder` (SW 1.0 authoring/debug), `evaluations` (SWE-bench/benchmarks), `dapr-agents-workflow` (Dapr Agents framework). Prefer these for deep operational detail.

## Architecture

All workflow execution lives in `workflow-builder` namespace:

- **SvelteKit BFF** (port 3000, Dapr sidecar) — UI + proxy. Calls workflow-orchestrator over Dapr.
- **workflow-orchestrator** (Python/Dapr) — SW 1.0 interpreter. `durable/run` → `ctx.call_child_workflow`; all other slugs → Dapr svc invoke → function-router. Resolves the target agent runtime via the runtime registry SSOT (`core/runtime_registry.py`).
- **Runtime registry (SSOT)** — `services/shared/runtime-registry.json` is the single source of truth for the 4 agent runtimes (`dapr-agent-py`, `claude-agent-py`, `adk-agent-py`, `browser-use-agent`): per-runtime identity (app-id/image/container) + capability descriptor (durability granularity, MCP/hooks/permission support, providers). `scripts/sync-runtime-registry.mjs` generates the orchestrator + BFF build-context copies (drift-guarded).
- **Per-session Sandbox pods** — non-browser runtimes are dispatched as per-session ephemeral `agent-sandbox` (kubernetes-sigs/agent-sandbox) pods differing only by container image, Kueue-admitted and self-reaped on session end. `browser-use-agent` uses a `SandboxWarmPool` carve-out. Each runs `session_workflow` + `daprd` sidecar + `seed-openshell-config` init container + optional `chromium` + `playwright-mcp` sidecars. A legacy static `Deployment-dapr-agent-py` survives only for the `openshell-durable-agent` enum + the benchmark coding pool.
- **function-router** — slug routing + credential broker. Routes to fn-system / fn-activepieces / openshell-agent-runtime / code-runtime / crawl4ai-adapter.
- **Infra** — Redis, PostgreSQL, OTEL Collector. MCP services (workflow-mcp-server, piece-mcp-server, mcp-gateway) retained on-demand.

Per-session sandbox pods (chromium + OpenShell workspace containers) live in `openshell` namespace, addressed over mTLS. Agent sandbox pods MUST colocate with the orchestrator — Dapr workflow sub-orchestration doesn't cross namespaces.

**Key dispatch invariants**
- **Runtime resolution is registry-driven**: the orchestrator's `sw_workflow.py::_resolve_native_agent_runtime` is a thin shim over `runtime_registry.resolve()`, which reads the generated `core/runtime_registry.json`. The descriptor supplies dispatch app-id, instance prefix, container image, and capabilities — no scattered string enumerations.
- **Two-name dispatch**: `durable/run` dispatches the Dapr workflow literal `session_workflow` (`descriptor.dispatch_workflow_name`); the workflow-session bridge-eligibility sentinel is `agent_workflow` (`descriptor.bridge_gate_token`). Distinct strings/roles.
- **Per-session Sandbox, no wake/idle**: NO per-agent `AgentRuntime` CR, NO Kopf wake/idle annotation, NO `agent-runtime-controller`. Each session dispatches an ephemeral `agent-sandbox` pod (Kueue-admitted, self-reaped); `browser-use-agent` uses a `SandboxWarmPool`. (Details: Agent Runtime Model.)
- `durable/run` is a **Dapr child workflow**, not HTTP. `spawn_session_for_workflow` activity POSTs to `/api/internal/sessions/ensure-for-workflow` (finds-or-creates the session row, rewrites Playwright stdio MCP to per-pod sidecar URL, ensures the sandbox is admitted). Parent yields `ctx.call_child_workflow("session_workflow", app_id=<descriptor app-id>, instance_id=<deterministic session_id>, autoTerminateAfterEndTurn=true)`. Retry resilience lives on the **agent callee** — `dapr-agent-py` decorates `session_workflow` with `WorkflowRetryPolicy(max_attempts=8)` wrapping `call_llm`; the orchestrator's own activities/`CreateInstance` carry **no** `retry_policy`.
- **Swap-safety gate** (`src/lib/server/agents/swap-safety.ts`): derives an agent's required capabilities from `agentConfig` vs the target runtime's DECLARED capabilities → `{decision: allow|warn|reject, drops[]}`. MCP-loss + provider-mismatch are REJECT-class; hooks/plugins/permission/durability downgrades WARN-class. WARN-first unless `AGENT_RUNTIME_REJECT_LOSSY_SWAP=true`. Wired into `src/lib/server/sessions/spawn.ts`.
- **Direct (UI-initiated) sessions** go through `src/lib/server/sessions/spawn.ts`, which resolves the runtime via the BFF registry (`runtime-registry.ts`) and calls Dapr `StartInstance` via service invoke (bare app-id). Both spawn paths call `rewriteMcpForBrowserSidecar` (`mcp-sidecar.ts`) — Playwright entries become `{ transport: "streamable_http", url: "http://localhost:3100/mcp" }`.
- **Dapr Component visibility**: `workflowstatestore` is the only `actorStateStore=true` Component visible to agents; `dapr-agent-py-statestore` + legacy `agent-workflow` are non-actor stores. New agents must NOT be added to Component scopes.
- Every non-agent action: `orchestrator → Dapr service invoke → function-router → {fn-system | fn-activepieces | openshell-agent-runtime | code-runtime | crawl4ai-adapter}` (via `activities/dapr_invoke.py`, no raw HTTP). `openshell-agent-runtime` consolidates `workspace/* + browser/* + openshell/*`.
- The **BFF** owns credential decryption — `src/lib/server/security/encryption.ts` does `createDecipheriv('aes-256-cbc')`. function-router is the **credential broker**: at execution it HTTP-GETs the BFF `/api/internal/connections/<id>/decrypt` and writes the `credential_access_logs` audit — it does NOT decrypt itself. Orchestrator never holds plaintext secrets.

## Tech Stack

- **Frontend**: SvelteKit 5, Svelte 5, Svelte Flow (@xyflow/svelte), shadcn-svelte
- **Backend**: SvelteKit API routes (BFF proxy)
- **Database**: PostgreSQL via Drizzle ORM
- **Auth**: GitHub/Google OAuth2, JWT API keys (RS256)
- **Workflow Engine**: Dapr Workflow SDK (Python, `dapr-ext-workflow==1.17.1`) via workflow-orchestrator; Dapr control plane 1.17.9
- **Durable AI Agents**: 4 runtimes via the runtime registry SSOT, each registering Dapr workflow `session_workflow` + sharing one CMA session-event HTTP ingest contract. `dapr-agent-py` (per-ACTIVITY loop, multi-provider/9 adapters) is built ON the GA dapr-agents framework (subclasses `DurableAgent`; pinned `dapr-agents==1.0.3`); its adapters monkeypatch `DaprChatClient.generate` for DIRECT provider calls. `claude-agent-py` (Claude Agent SDK, whole loop in ONE activity, Anthropic-only, supports MCP), `adk-agent-py` (Google ADK), `browser-use-agent` (browser/vision, warm-pool). Dispatched as per-session ephemeral `agent-sandbox` pods. Durable-state/payload ceiling = 16 MiB gRPC `max-body-size` (Postgres store). See `docs/agent-runtime-comparison.md`.
- **Function Execution**: function-router (Dapr invoke) → fn-system / fn-activepieces / openshell-agent-runtime / code-runtime
- **Activepieces**: 42 AP piece packages, OAuth2 PKCE, encrypted app connections
- **Observability**: OpenTelemetry → OTEL Collector → Jaeger / MLflow
- **Deployment**: Docker, Kind cluster, ingress-nginx

## Key Commands

```bash
pnpm dev              # Start SvelteKit dev server (local, no cluster)
pnpm build            # Production build
pnpm check            # Svelte type checking
pnpm db:generate      # Generate Drizzle migrations
pnpm db:push          # Push schema to DB
pnpm db:migrate       # Run migrations
pnpm db:studio        # Drizzle Studio
pnpm test:e2e         # Playwright E2E tests
```

## Dev Loop (Skaffold, ryzen cluster)

Skaffold is the in-cluster dev loop (`devspace.yaml` retired). **For full detail use the `skaffold-dev-loop` and `gitops` skills.**

```bash
# Inner loop (HMR file-sync into a Skaffold-owned dev pod):
pnpm dev:skaffold                              # workflow-builder (default)
pnpm dev:skaffold:orchestrator                 # workflow-orchestrator
bash scripts/skaffold-dev.sh function-router   # any single module by name

# Outer loop (build prod image → push → commit kustomize pin → Argo deploys):
pnpm deploy:skaffold                                # workflow-builder
bash scripts/skaffold-deploy.sh fn-activepieces     # any single service

pnpm skaffold:doctor                                # read-only preflight
```

Module set (Local→Container port): workflow-builder 3002→3000, workflow-orchestrator 3013→8080, function-router 3014→8080, mcp-gateway 3018→8080, swebench-coordinator 3019→8080, fn-activepieces 3016→8080 (inactive by default). **`fn-system` is excluded** (Knative scale-to-0). **`fn-activepieces` is inactive** unless `SKAFFOLD_ALLOW_INACTIVE=1`.

Key facts (full detail in the `skaffold-dev-loop` skill):
- `SKAFFOLD_DEFAULT_REPO=ghcr.io/pittampalliorg` (host needs `docker login ghcr.io`). The wrapper traps SIGINT/SIGTERM/EXIT to resume ArgoCD; recover a `kill -9` with `ARGO_APPS=workflow-builder bash skaffold/hooks/argo-resume.sh`.
- **commit-pin** is the single image-pin writer on GitHub `main` for Skaffold-owned services (`SKAFFOLD_OWNED_DEFAULT`), via a dedicated clone at `~/.cache/skaffold/stacks-ryzen`. Most services: textual `newTag` edit of `workloads/<svc>/manifests/kustomization.yaml`. **`workflow-builder` + `workflow-mcp-server` are the exception** — commit-pin UPSERTS the flat pins file `…/release-pins/workflow-builder-images-ryzen.yaml`, renders the ryzen-image Component locally, and `refresh=hard`es the ryzen spoke-local app.
- **No `kubectl set image`** — the live cluster is mutated only by ArgoCD. **Ryzen single-pin**: the render-generated Component is the SOLE ryzen image authority; Application-object `spec.source.kustomize.images` overrides are forbidden (CI guard `validate-ryzen-no-app-image-overrides`).
- **commit-pin's HTTPS push can 403 on this NixOS host**; image+pin commit are still made — push with `git -C ~/.cache/skaffold/stacks-ryzen push "https://x-access-token:$(gh auth token)@github.com/PittampalliOrg/stacks.git" HEAD:main`, then hard-refresh `ryzen-<svc>`.
- **Dev auto-promote covers ALL Skaffold-owned services**: hub Tekton `github-outer-loop` per-service triggers (merge to `main` touching `services/<svc>/**`, or `[build all]`) → `outer-loop-build` → GHCR → `update-stacks` → source-hydrator → GitOps Promoter → `dev-<svc>`. Don't `deploy:skaffold` a commit the GitHub outer-loop also builds (digest mismatch) — commit-pin the existing GHCR tag instead. Bring a stale service current via a `outer-loop-build` PipelineRun with `git_sha=<main HEAD>`.

### GitOps activity stream (`/admin/gitops/system`)

Observable live via **Argo Events** (hub) → BFF ingest `POST /api/internal/gitops/events/ingest` (`gitops/activity-events.ts` → `gitops_activity_events`) → SSE `GET /api/v1/gitops/events/stream?since=<seq>`. The "Kargo lens" pipeline (`pipeline-model.ts`, `activity-overlay.ts`) renders event-first; the overlay never mutates authoritative inventory health/sync. Build feedback + the Commit→Build→Pin→Promote→Deploy timeline are INVENTORY-sourced, not event-sourced (the stream is ~100% ArgoCD). **App-wide deployment notifications** (toast + sidebar bell, `deployment-notifications.svelte.ts`) fire on inventory-diff (new live image tag-SET while `Synced`), admin-gated.

## Services Overview

| Service | Port | Role |
|---------|------|------|
| **workflow-orchestrator** | 8080 | Python Dapr workflow engine, SW 1.0 interpreter |
| **agent-sandbox pod** (per-session) | n/a | Ephemeral runtime pod (`dapr-agent-py`/`claude-agent-py`/`adk-agent-py`) differing only by image; Kueue-admitted, self-reaped. `browser-use-agent` via `SandboxWarmPool`. (AgentRuntime CRD + Kopf controller RETIRED.) |
| **dapr-agent-py** (legacy Deployment) | n/a | Static replicas:4; survives only for `openshell-durable-agent` enum + benchmark coding pool |
| **function-router** | 8080 | Sync credential broker + Knative proxy. `function-registry` CM authoritative over built-in fallback. |
| **fn-system** | 8080 | system/* (http-request, database-query, condition) |
| **fn-activepieces** | 8080 | AP piece executor |
| **mcp-gateway** | 8080 | Hosted MCP endpoint for external clients |
| **workflow-mcp-server** | 3200 | Retained MCP server |
| **piece-mcp-server** | dynamic | On-demand piece MCP |
| **openshell-sandbox** | — | Custom sandbox image (Chromium/Playwright); per-session pods in `openshell` ns |

## Project Structure

- `src/routes/` — API routes (`api/workflows`, `api/orchestrator`, `api/app-connections`, `api/internal/{connections,mcp,agent}`, `api/events/ingest`, `api/v1/auth`, `api/pieces`) + pages
- `src/lib/components/workflow/` — Svelte Flow canvas, side-panel, toolbar, base-sw-node, animated-edge
- `src/lib/server/` — `db/schema.ts` (Drizzle), `dapr-client.ts`, `auth.ts`, `security/encryption.ts`, `app-connections/oauth2.ts`, `internal-auth.ts`, `workflows/external-event-registry.ts`, `otel/clickhouse.ts`
- `services/` — `workflow-orchestrator/`, `dapr-agent-py/`, `claude-agent-py/`, `adk-agent-py/`, `function-router/`, `fn-activepieces/`, `fn-system/`, `workflow-mcp-server/`, `piece-mcp-server/`, `mcp-gateway/`, `openshell-sandbox/`, `crawl4ai-adapter/`, plus `shared/runtime-registry.json` (runtime SSOT)
- `drizzle/` — migration SQL. `scripts/` — dev/seed/test. `docs/` — supplementary docs.

## Action Routing

Routed by `actionType` slug prefix. Orchestrator → function-router uses Dapr service invoke; `durable/run` bypasses function-router via `ctx.call_child_workflow`.

| Prefix | Service | Notes |
|--------|---------|-------|
| `durable/run` | per-session agent-sandbox pod | Native Dapr child workflow `session_workflow`. Target runtime + app-id resolved via `runtime_registry.resolve()` from the agent's `runtime`; falls back to registry default only when neither `agentAppId` nor `agentSlug` is stamped. |
| `system/*` | fn-system | http-request, database-query, condition |
| `workspace/*` | openshell-agent-runtime | Plus `persist_workspace_session` activity after `workspace/profile` with `keepAfterRun=true` |
| `browser/*` | openshell-agent-runtime | Browser profile, clone, command, capture-flow, validate |
| `openshell/*` | openshell-agent-runtime | OpenShell helper routes |
| `code/*` | code-runtime | Saved TS/Python code execution |
| `*` (default) | fn-activepieces | All AP piece actions |

Rejected slugs (orchestrator raises): `claude/run`, `openshell/run`, `openshell/session-start`, `openshell-langgraph/run`, `openshell-langgraph-observable/run`, `dapr-agent-py/run`, `dapr-swe/run`, `durable/plan`, any `mastra/*` or `agent/*`.

## Agent Runtime Model

The runtime registry (`services/shared/runtime-registry.json`) is the dispatch SSOT — `scripts/sync-runtime-registry.mjs` generates the orchestrator copy (`core/runtime_registry.json`, read by `core/runtime_registry.py`) and the BFF copy (`src/lib/server/agents/runtime-registry.data.json`, read by `runtime-registry.ts`); a `--check` mode + tests guard drift. Each descriptor carries identity (`appIdConfigKey`, `instancePrefix`, `mainContainerName`, `imageEnvKey`, `agentMetadataFramework`, `benchmarkEligible`) + capabilities (`durabilityGranularity`, `supportsMcp`, `supportsHooks`, `supportsPermissionGating`, `incrementalEvents`, `ownsSandbox`, `requiresWarmPool`, `requiresBrowserSidecars`, `multiProvider`, `supportedProviders`).

On publish, `src/lib/server/agents/registry-sync.ts` mirrors agent metadata into the Dapr agent registry (its `runtime` selects a descriptor). There is **no per-agent `AgentRuntime` CR and no Kopf controller** — deployment is upstream kubernetes-sigs/agent-sandbox + Kueue: each session dispatches an ephemeral `agent-sandbox` pod, Kueue-admitted and self-reaped. `browser-use-agent` uses a `SandboxWarmPool` carve-out.

**Pod shape**:
- `seed-openshell-config` init container — writes `${XDG_CONFIG_HOME}/openshell/active_gateway` + mTLS certs. Without it, OpenShell tools fail ENOENT on `active_gateway`.
- runtime main container (`dapr-agent-py` / `claude-agent-py` / `adk-agent-py`, per `descriptor.mainContainerName`) — registers `session_workflow` + plugins/hooks. `claude-agent-py` wires `agentConfig.mcpServers` into the Claude Agent SDK.
- `daprd` sidecar — injected by `openshell-sandbox-dapr-webhook` (matches `openshell` + `workflow-builder`). Requires `openshell-sandbox-dapr` Configuration in the pod's namespace.
- *(Optional)* `chromium` + `playwright-mcp` browser sidecars when `requiresBrowserSidecars`/Playwright MCP preset applies (`mcp:3100`).

**Lifecycle**: per-session Sandbox pods created on dispatch, self-reaped on session end — no scale-to-0 Deployment, no wake/idle annotations. Legacy static `Deployment-dapr-agent-py` (replicas:4) survives only for the `openshell-durable-agent` enum + `agent-runtime-pool-coding` benchmark pool.

**Dapr Component visibility** in `workflow-builder` ns: `workflowstatestore` (`actorStateStore=true`, Dapr workflow/actor history); `dapr-agent-py-statestore` (false, agent/session state); `agent-workflow` (false, legacy, no active consumers). A Dapr sidecar refuses to start if it sees >1 `actorStateStore=true` Component. New agents: register in the runtime/Dapr agent registry; do NOT patch Component scopes.

## Workflow → Session Bridge

Every `durable/run` step goes through a session bridge so workflow-driven runs appear in the same `/sessions/[id]` UI as direct sessions. (Old `WORKFLOW_USE_SESSIONS` flag removed.)

**Flow** (`workflows/sw_workflow.py` + `activities/spawn_session.py`):
1. Orchestrator yields `spawn_session_for_workflow` with `bridge_payload` (agentAppId, agentSlug, workspaceRef, sandboxName, agentConfig, durable/run body).
2. Activity POSTs to BFF `/api/internal/sessions/ensure-for-workflow`. Handler rewrites `agentConfig.mcpServers` for browser sidecar, finds/creates session row (keyed by `child_instance_id = <exec>__<kind>__<node>__run__<index>`), creates ephemeral `agents` row if inline, ensures sandbox admitted (non-blocking), returns `{sessionId, agentId, agentVersion, childInput, reused}`.
3. Orchestrator yields `ctx.call_child_workflow("session_workflow", input=childInput, instance_id=child_instance_id, app_id=target["app_id"])`. Child runs with `autoTerminateAfterEndTurn: true` — one turn, emits `session.status_idle{end_turn}` + `session.status_terminated`. Parent resumes; final output persists to `workflow_executions.output`.

### Safety nets on the agent side

Defensive layers prevent `durable/run` hangs:
- **Empty-response circuit breaker** (`dapr-agent-py` `call_llm`): after `DAPR_AGENT_PY_EMPTY_RESPONSE_THRESHOLD` (default 3) consecutive empty/no-tool responses, raises `AgentError`. Catches Anthropic SDK #1204 (empty `end_turn`).
- **Host-monitor thread** (`_run_session_host_monitor`, logic in `session_host_monitor.py`): out-of-band background thread polling for start/idle stalls. The old in-workflow session-turn timer (`when_any([child, timer])`) was REMOVED (commit `72154581`). Default action is `"warn"` (`DAPR_AGENT_SESSION_HOST_NONTERMINAL_TIMEOUT_ACTION`); only `terminate` kills. This is hang-detection, NOT the stop watchdog — explicit stops route through the Lifecycle Controller; stuck DB↔Dapr divergence is reconciled by the `lifecycle-terminal-reaper` CronJob.
- **Image tool_result compaction** (`anthropic_adapter.py`): keeps last `DAPR_AGENT_PY_MAX_IMAGE_TOOL_RESULTS` (default 3) image tool_result blocks; prevents 1M-token overflow.

### Workspace session persistence

- **`persist_workspace_session` activity**: after `workspace/profile` with `keepAfterRun=true`, UPSERTs `workflow_workspace_sessions` (status=`active`, keyed on `workspace_ref`). Read by `getExecutionSandboxPreviewInfo` for live-preview proxy.
- **Cleanup gate**: `_should_cleanup_workspaces` walks the SW 1.0 spec for `workspace/*` steps with `with.keepAfterRun: true`.

## Lifecycle: Stop / Terminate / Purge (Lifecycle Controller)

A single vetted server-side **Lifecycle Controller** in the BFF (`src/lib/server/lifecycle/{cascade,resolvers,index,reaper,ownership}.ts`) is the SSOT for stopping/terminating/purging Dapr Workflows + durable agent runs. Every user-facing "stop" routes through it. **Full detail: `docs/workflow-lifecycle-termination.md`** (IMPLEMENTED PR1–PR4, hardened wfb #69–#79).

**Entry point**: `stopDurableRun(target, { mode })`. `target.kind ∈ workflowExecution | session | evalRun`. Modes:
- **`interrupt`** — cooperative only (raise `session.terminate` / `user.interrupt`, bounded wait). "Pause, keep the run."
- **`terminate`** — graceful raise → Dapr terminate parent + every child app-id → poll to terminal. "Stop."
- **`purge`** — terminate → confirm terminal → Dapr purge (recursive; **purge-force** when worker gone) → reap Sandbox CRs → flip DB rows terminal. "Stop & clean."
- **`reset`** (dev) — purge + delete deterministic-ID occupants so the next run starts byte-clean.

**Request/confirm** (#69/#71): stop persists a `stop_requested_at` intent (migration `0071`), returns **HTTP 202 "stopping"** while the durable tree converges, and only flips DB / reaps once Dapr is confirmed terminal — finalized by `GET …/stop/status` → `confirmDurableStop` and/or the reaper. 200 confirmed · 202 stopping · 409 only on genuine non-request failure. Cascade timing env-tunable (`LIFECYCLE_CASCADE_WAIT_SECONDS` default 90; cooperative-first `LIFECYCLE_TERMINATE_GRACE_SECONDS` default 5).

**Single stop authority** (#70/#79): a benchmark/eval **instance** is NOT stoppable via the generic per-execution **or** per-session Stop — both 409 `coordinator_owned` (`ownsBenchmarkOrEvalRun(ForSession)`); cancel the owning **run** (`/api/{benchmarks,evaluations}/runs/[id]/cancel`). Standalone runs / direct sessions keep their Stop.

**Cross-app fan-out (no implicit cascade)**: `session_workflow` children run under per-session sandbox app-ids = separate task hubs, so Dapr's native recursive cascade does NOT reach them. The BFF controller does explicit per-session app-id fan-out (terminate + purge each). The orchestrator's `terminate_durable_runs_by_parent_execution` activity was RETIRED.

**Cross-app `durable/run` Stop WEDGE** (kept `call_child_workflow`; BFF-only fix, #77, hardened #78/#79): the cross-app sub-orchestration is on a separate task hub, so a task-hub-bounded terminate can't reach it → the SW-interpreter parent hangs `RUNNING`. `confirmDurableStop` **force-finalizes** the wedged parent after a grace on **positive evidence** — the parent's live `currentNodeId` is a `durable/run` node whose child session is DB-terminated (`shouldForceFinalizeCrossAppWedge`; `LIFECYCLE_WEDGE_FINALIZE_GRACE_SECONDS` default 180s; state-row purge boundary-anchored via `daprStateKeyMatchPattern`). **Rejected:** fire-and-forget + status-poll dispatch (#74/#75) reverted (#76) — per-session Kueue sandboxes aren't Dapr-service-invokable (`call_child_workflow` routes via PLACEMENT, not DNS). Don't re-attempt fire-and-poll.

**Orchestrator-side**: `_workflow_http_post` forwards query params; `purge_workflow` is recursive-by-default + forwards `force`. `_idempotent_schedule`'s purge-before-reuse is GUARDED to only the DB-terminal-but-Dapr-non-terminal divergence.

**Runtime/sandbox-side**: sandbox-execution-api stamps an owner-run-id annotation, adopting only the SAME run else delete+recreate. dapr-agent-py's cancel-key write/read AGREE for `durable/run` (check strips `__turn__N` / `:turn-N`). claude-agent-py has management parity (`POST /api/v2/agent-runs/{id}/{terminate,pause,resume}` + `DELETE` purge).

**GitOps safety nets (stacks, PR4)**: `workflow-builder-sandbox-gc` CronJob (age-GC orphaned Sandbox CRs); unified Dapr `stateRetentionPolicy = 168h` across parent + per-session child Configs; `lifecycle-terminal-reaper` CronJob → `POST /api/internal/lifecycle/reap-terminal` (reconciles DB stuck non-terminal vs terminal/gone Dapr, even during benchmark activity, priority stop-requested pass); `runbooks/phase0-lifecycle-clean-slate.{sh,md}` (guarded, NOT auto-run).

## Node Types

| Node Type | Purpose |
|-----------|---------|
| `trigger` | Workflow start node |
| `action` | Function execution (plugins + AP pieces + agents) |
| `activity` | Dapr call_activity() primitives |
| `approval-gate` | Wait for external event with timeout |
| `timer` | Dapr create_timer() delay |
| `loop-until` | Repeat until condition |
| `if-else` | Conditional branching |
| `set-state` | Set workflow variable |
| `transform` | JSON template output |
| `publish-event` | Dapr pub/sub publish |
| `note` | Non-executing annotation |

## Database Schema (Key Tables)

- **workflows**: `id`, `name`, `nodes` (JSONB), `edges` (JSONB), `engine_type`, MCP trigger config
- **workflow_executions**: `id`, `workflow_id`, `dapr_instance_id`, `status`, `output` (JSONB)
- **functions**: `id`, `slug`, `name`, `plugin_id`, `execution_type`, `is_builtin`
- **app_connections**: encrypted credentials (`OAUTH2`/`SECRET_TEXT`/etc) in `value` JSONB
- **piece_metadata**, **mcp_connection**, **mcp_server**, **mcp_run**, **workflow_connection_ref**
- **api_keys**: JWT keys (`wfb_` prefix, SHA-256 hashed at rest); rotation keeps `id` stable
- **CMA parity**: workspace-scoped via `project_id` — `sessions`, `vaults`, `agents`, `environments`, `agent_skill_registry` (nullable for curated-global). Scope from `locals.session.projectId` resolved by `hooks.server.ts`.
- **project_members**: `(project_id, user_id, role)` with `ADMIN | EDITOR | OPERATOR | VIEWER`. Last-admin demote/remove blocked.
- **sessions**: `workflow_execution_id` links workflow-driven sessions back to parent `durable/run` node
- **session_events**: append-only CMA event log (`sevt_` id prefix). SSE at `/api/v1/sessions/[id]/events/stream`
- **files**: standalone files API; SHA-1 dedup, 25 MB cap. Session-output auto-upload from `/mnt/session/outputs` + `/sandbox/outputs`
- **Browser artifacts**: `workflow_browser_artifacts` (manifest), `workflow_browser_artifact_blob_payloads` (base64 PNG)
- **workflow_artifacts**: standardized typed outputs (see Workflow Artifacts section)
- **Observability**: `workflow_execution_logs`, `credential_access_logs`, `workflow_external_events`

## MCP Integration

Three paths:
1. **Activepieces piece MCP services**: per-piece in-cluster endpoints, backed by `mcp_connection.connection_external_id` + encrypted `app_connection` credential.
2. **dapr-agent-py MCP client**: reads `durable/run.with.agentConfig.mcpServers`, connects at runtime, exposes alongside built-in OpenShell tools.
3. **mcp-gateway / workflow-mcp-server / piece-mcp-server**: hosted MCP surfaces for external-client/on-demand flows.

**Playwright sidecar rewrite** (`src/lib/server/agents/mcp-sidecar.ts`): any `agentConfig.mcpServers` entry matching Playwright (by name, URL containing `playwright-mcp`, or args containing `@playwright/mcp`) is rewritten to `{ transport: "streamable_http", url: "http://localhost:3100/mcp" }`. Called from BOTH spawn paths. Controller adds `chromium` + `playwright-mcp` sidecars when matched.

For UI-runnable agent workflows: SW 1.0 `durable/run` with `agentConfig.mcpServers` and `x-workflow-builder.input` prompt metadata. See `docs/mcp-agent-workflows.md`. MCP Apps use `@modelcontextprotocol/ext-apps` (`tool-widget.tsx`).

## Hooks + Plugins (dapr-agent-py)

Port of Claude Code's hooks + plugins surface. Feature-flagged via `DAPR_AGENT_PY_HOOKS_ENABLED=true` + `DAPR_AGENT_PY_PLUGINS_ENABLED=true`; plugins ship via `fetch-claude-plugins` init container cloning `anthropics/claude-plugins-official` to `/etc/dapr-agent-py/plugins`.

- **Events v1**: PreToolUse, PostToolUse, PostToolUseFailure, UserPromptSubmit, SessionStart, SessionEnd, Stop, Notification
- **Hook types v1**: `command` (subprocess JSON stdin/stdout, exit-code 2 = blocking) + `callback` (in-process Python)
- **Per-run overlay**: `durable/run.with.agentConfig.hooks` + `agentConfig.plugins` layered on startup registry
- **Durability**: PreToolUse/PostToolUse/PostToolUseFailure fire inside durable `run_tool` activity; session-level events gated by `not ctx.is_replaying`

> See `docs/hooks-and-plugins.md`.

## Activepieces Integration

- Credentials: AES-256-CBC encrypted in `app_connections`. Auth types: `OAUTH2`, `SECRET_TEXT`, `BASIC_AUTH`, `CUSTOM_AUTH`.
- Flow: User creates → encrypted in DB → at execution function-router fetches plaintext from the BFF `/decrypt` endpoint (BFF does the AES-256-CBC decryption; function-router brokers + audits).
- Adding piece: (1) `installed-pieces.ts`, (2) npm dep to fn-activepieces, (3) `piece-registry.ts`, (4) rebuild.

> See `docs/activepieces-auth.md`.

## CMA Parity (Managed Agents Console)

Mirrors platform.claude.com/dashboard surface-for-surface. Workspace scoping is the unifying invariant: every user-facing resource carries `project_id`; `hooks.server.ts` resolves scope from `X-Workspace` header or URL slug into `locals.session.projectId`.

- **Workspaces** (`/workspaces`, `/workspaces/[slug]/*`; non-member 404s at layout guard) · **Members** (`/settings/members`, CRUD via `/api/v1/projects/[projectId]/members`; last-admin demote/remove blocked).
- **Sessions**: CMA-shape event stream (`agent.message/thinking/tool_use/tool_result`, `session.status_*`). **Fork**: `POST /api/v1/sessions/[id]/fork` with `fromSequence`.
- **Custom skills**: `sourceType="custom"` in `agent_skill_registry`, scoped via `project_id` (`POST /api/agent-skills` + `PATCH …/[id]`, prompt edit bumps version). Curated/global rows visible to all.
- **Usage + cost** (`/api/v1/usage`, `/api/v1/cost`, workspace-scoped, fall back to `userId`) · **Limits** (`/settings/limits`, 15s refresh via `/api/v1/limits/live`, computed from `sessions.usage`+`status`).
- **Observability deep-link**: session detail → Phoenix + ClickHouse (`session.id` span filter). **Workflow → session cross-link** via `/api/workflows/executions/[executionId]/sessions`.

Full map: `docs/cma-parity.md`.

## Browser Validation (In-Sandbox Screenshots)

`browser/validate` captures screenshots inside the coding agent's OpenShell sandbox (no second sandbox).
- **Custom sandbox image**: `services/openshell-sandbox/Dockerfile` — Ubuntu 24.04 + Chromium via Playwright at `/opt/pw-browsers`
- **Composite endpoint**: `POST /api/browser/validate` in openshell-agent-runtime
- **Screenshot transfer**: PNGs base64-encoded in sandbox, read in 4KB chunks via `dd` (OpenShell stdout truncates >4KB)
- **Storage**: `workflow_browser_artifacts` + `workflow_browser_artifact_blob_payloads`. **UI**: Artifacts tab in run detail.
- **Constraints**: chunked reads for >4KB; base64-encoded scripts (no heredoc through OpenShell API); browsers at `/opt/pw-browsers`; `imagePullPolicy: Always` for sandbox images.

## Standardized Workflow Artifacts

Any SW 1.0 task can declare typed outputs via an `artifacts:` block alongside `with:` — a list of entries `{ kind, slot (primary|secondary|aux), title, from (jq), contentType?, if? (jq guard) }`. `_persist_task_artifacts` walks `task_data["artifacts"]`, evaluates jq, yields `persist_workflow_artifact` per entry. Activity ID is deterministic (`sha256(workflowId|executionId|nodeId|kind|title)[:24]`) so retries UPSERT. **Storage**: `workflow_artifacts` table (drizzle 0067), inline payload (jsonb ≤256 KB) or `file_id` for blobs.

**Standard kinds**: `markdown` (`{markdown}` → `Response`), `json` (`{value}` → `JsonViewer`), `text` (`{text}` → `<pre>`), `table` (`{columns,rows}`), `image` (`{alt}`, blob via fileId), `link` (`{url}`), `card` (`{body,footer?}`). Unknown kinds fall back to JSON dump.

**Consumer**: `<ArtifactList artifacts={...} mode="primary|all" />` (`src/lib/components/workflow/execution/artifact-list.svelte`). APIs: `GET /api/workflows/executions/[id]/artifacts` (workspace-scoped read); `POST /api/internal/workflows/executions/[id]/artifacts` (internal-token write). Activity is best-effort.

> See `docs/workflow-artifacts.md`.

## Tiered Crawl Pipeline (research workflows)

`browserresearchfanout01` v3 is the canonical pattern for multi-URL "fetch + extract + synthesize" (`trigger {topic,urls,extractionPrompt}` → `for url` → `web/crawl.async` durable activity → `durable/run text-research-synthesizer`, a pure text agent). Replaces v2 browser-use-agent for research/extraction; browser-use stays for *interactive* (vision/click) tasks. **Full detail: `docs/tiered-crawl-pipeline.md`.**

**crawl4ai-adapter v2** (`services/crawl4ai-adapter/`): `POST /crawl/jobs { url, jobId?, tiers?, extractionSchema?, cacheTtlSeconds? }`; `GET /crawl/jobs/{id}` → `{ complete, success, data, error }`. PG-backed (`crawl4ai_jobs` + `crawl4ai_cache`), idempotent jobIds `j_<sha256(workflowId|nodeId|url)>[:32]`, cache keyed on `sha256(url|tier_chain|schemaHash)` (1h), tier escalation (default `[http]`) on block-detect, optional `extractionSchema` → Anthropic `tool_use` in `result.extracted`, startup watchdog + lazy resume re-kick stale jobs.

**For-task jq output**: per-URL outputs at `<for_name>/<sub_name>[<idx>]`; envelope has ONE unwrap applied — read `.data.tier`, `.data.extracted` (NOT `.tier` / `.extracted`). **Don't use for** interactive browser control — use browser-use-agent.

## Troubleshooting

- **Missing credentials** → Add API keys to Azure Key Vault or create app connections
- **Agent timeout** → Check the per-session agent-sandbox pod logs + workflow-orchestrator logs
- **Agent stops early** → Check `maxTurns` (default 50, per-node configurable)
- **OAuth2 token expired** → Auto-refresh; check `AP_ENCRYPTION_KEY`. **AP decrypt fails** → verify `INTERNAL_API_TOKEN` matches across services
- **Tool fails ENOENT on `active_gateway`** → `seed-openshell-config` init container didn't run; verify the sandbox pod template includes it AND `openshell-sandbox-dapr-webhook` covers `workflow-builder`
- **daprd `no X509 SVID / failed to get configuration`** → `openshell-sandbox-dapr` Configuration missing in pod's namespace
- **daprd `detected duplicate actor state store`** → a Component with `actorStateStore=true` became visible; partition scopes (see Agent Runtime Model)
- **`ctx.call_child_workflow` times out `app may not be available`** → target pod isn't placement-registered (sandbox not admitted/started, or cross-namespace — sub-orchestration is intra-namespace only)
- **`Ignoring unexpected taskCompleted event with ID = N`** → NOT stuck; normal `call_child_workflow` replay chatter. Real stuck: sandbox pod never `Running`, or pattern persists >5 min with daprd placement flaps
- **Per-session agent-sandbox never starts** → check Kueue admission (`kubectl get workloads -n workflow-builder`) + the agent-sandbox controller (no wake annotation — controller RETIRED)
- **BFF `/execute` `ECONNREFUSED`** → orchestrator CrashLoopBackOff; common cause is image predating `activities/crawl4ai.py`
- **Workflow-driven sessions show raw agent IDs** → ephemeral agents filtered from `/api/agents` by design
- **Agent loops with empty responses** → Anthropic SDK #1204. Circuit breaker in `call_llm` trips after 3; look for `[call-llm] circuit-breaker tripped`
- **Child session hangs with no LLM traffic** → in-workflow session-turn timer was REMOVED (commit `72154581`); `_run_session_host_monitor` defaults to `"warn"` (set `DAPR_AGENT_SESSION_HOST_NONTERMINAL_TIMEOUT_ACTION=terminate` to kill). To stop, use the Lifecycle Controller; orphans reconciled by `lifecycle-terminal-reaper`
- **Want to stop a running session / workflow run** → Lifecycle Controller: `POST /api/v1/sessions/[id]/stop` or `/api/workflows/executions/[id]/stop` with `{mode}`. A stop that can't confirm in-request returns **202 "stopping"** (not a hard 409). A **benchmark/eval instance** 409s `coordinator_owned` — cancel the owning run (see Lifecycle). DB rows stuck `running` after a pod died are reconciled by `lifecycle-terminal-reaper`; orphan Sandbox CRs age-GC'd by `workflow-builder-sandbox-gc`
- **Mid-turn `user.interrupt` / `session.terminate` did nothing on durable/run** → was the dapr-agent-py cancel-key write/read mismatch; FIXED (check strips `__turn__N` / `:turn-N`)
- **`Could not purge … instance is not in a terminal state`** → purge requires terminal; the Controller terminates first (purge-force when worker gone). Don't reuse a deterministic ID over a stuck non-terminal instance
- **Re-run inherits stale pod filesystem/state** → was sandbox-execution-api 409-adopt; FIXED (owner-run-id annotation, else delete+recreate)
- **Anthropic 400 `prompt is too long`** → too many image tool_results; `_compact_image_tool_results` keeps last `DAPR_AGENT_PY_MAX_IMAGE_TOOL_RESULTS` (default 3). **`Streaming is required`** → all calls route through `_stream_final_message`; lower `DAPR_AGENT_PY_MAX_TOKENS` (default 16384)
- **dapr-agent-py code changes need TWO image builds**: `dapr-agent-py:git-<sha>` (legacy Deployment) + `dapr-agent-py-sandbox:latest` (per-session pods, `imagePullPolicy: Always`)
- **Node service prod build fails `ERR_PNPM_IGNORED_BUILDS`** → unpinned `npm install -g pnpm` pulled v10; pin **`pnpm@9`** (don't use `--ignore-scripts`). Recover with the "bring a stale service current" PipelineRun
- **Live-preview 404 "Retained sandbox not found"** → `workflow_workspace_sessions` row missing/`cleaned`. Verify `persist_workspace_session` fired + spec `with.keepAfterRun: true`. Revive: `UPDATE workflow_workspace_sessions SET status='active' WHERE workflow_execution_id=<id>`
- **`${ .trigger.X }` reaches agent as literal string** → SW 1.0 jq-template eval only fires for ENTIRE-value `${...}`. Wrap whole value in one jq expression
- **`web/crawl.async` times out** → adapter restarted + lazy-resume too slow. Reset: `UPDATE crawl4ai_jobs SET state='FAILED' WHERE state IN ('PENDING','RUNNING') AND updated_at < now() - interval '2 minutes'`
- **Synthesizer calls WebSearch / hangs** → per-URL corpus has nulls from missing envelope unwrap. Use `.data.tier` / `.data.extracted`
- **`artifacts:` block declared but no rows** → activity is best-effort. Check orchestrator logs for `persist_workflow_artifact` warnings (BFF 503, missing `INTERNAL_API_TOKEN`, jq `null` + `if:` true)
- **MLflow Traces UI shows `IN_PROGRESS` after success** → FIXED via `finalize_mlflow_trace_root` activity (raw OTLP `ResourceSpans` POST to `${OTEL_EXPORTER_OTLP_ENDPOINT}/v1/traces`, parent_span_id empty). Must use raw HTTP, not SDK tracer. Disable via `WORKFLOW_ORCHESTRATOR_MLFLOW_FINALIZE_ROOT_SPAN=false`
- **SvelteKit type errors** → `pnpm check`

> See Dapr component YAMLs in stacks repo for service scoping.

---

**Last Updated**: 2026-06-08

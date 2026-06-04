# Workflow Builder

Visual workflow builder with Dapr workflow orchestration, durable AI agents, and MCP server integration. SvelteKit serves as UI + BFF proxy; all workflow execution lives in Dapr on Kubernetes.

> **Supplementary docs** (`docs/`):
> - `per-agent-runtime.md` — AgentRuntime CRD + controller, pod shape, Dapr Component scoping, wake/idle TTL, dispatch
> - `activepieces-auth.md` / `activepieces-integration-implementation.md` — AP auth + integration
> - `mcp-agent-workflows.md` — MCP-enabled `dapr-agent-py` workflow method
> - `hooks-and-plugins.md` — `dapr-agent-py` hooks + plugins (Claude Code port)
> - `CLICKHOUSE_OBSERVABILITY.md` — ClickHouse observability stack
> - `openshell-capabilities.md` — OpenShell sandbox capabilities
> - `cma-parity.md` — CMA console parity: workspaces, members, sessions, custom skills, limits
> - `callable-agents.md` — `CallAgent` peer-delegation tool (native `WorkflowContextInjectedTool`)
> - `tiered-crawl-pipeline.md` — `crawl4ai-adapter` v2 + `browserresearchfanout01` v3 (canonical multi-URL research pattern)
> - `workflow-artifacts.md` — Standardized `workflow_artifacts` surface

## Architecture

All workflow execution lives in `workflow-builder` namespace:

- **SvelteKit BFF** (port 3000, Dapr sidecar) — UI + proxy. Calls workflow-orchestrator over Dapr.
- **workflow-orchestrator** (Python/Dapr) — SW 1.0 interpreter. `durable/run` → `ctx.call_child_workflow`; all other slugs → Dapr svc invoke → function-router.
- **AgentRuntime CRD + agent-runtime-controller** (Kopf operator) — reconciles 1 `Deployment/agent-runtime-<slug>` per published agent.
- **agent-runtime-<slug> Pod** — `dapr-agent-py` (session_workflow + agent_workflow) + `daprd` sidecar + `seed-openshell-config` init container + optional `chromium` + `playwright-mcp` sidecars.
- **function-router** — slug routing + credential broker. Routes to fn-system / fn-activepieces / openshell-agent-runtime / code-runtime / crawl4ai-adapter.
- **Infra** — Redis, PostgreSQL, OTEL Collector. MCP services (workflow-mcp-server, piece-mcp-server, mcp-gateway) retained on-demand.

Per-session sandbox pods (chromium + OpenShell workspace containers) live in `openshell` namespace, addressed over mTLS. Agent runtime pods MUST colocate with the orchestrator — Dapr workflow sub-orchestration doesn't cross namespaces.

**Key dispatch invariants**
- **Per-agent runtime pods** (`agent-runtime-<slug>`) live in `workflow-builder` ns. One Deployment per published agent, materialized by the controller from `AgentRuntime` CRs. Scale to 0 on idle (default `idleTtlSeconds=1800`); woken via `agents.x-k8s.io/wake` annotation.
- `durable/run` is a **Dapr child workflow**, not HTTP. `spawn_session_for_workflow` activity POSTs to `/api/internal/sessions/ensure-for-workflow` which finds-or-creates the session row, rewrites Playwright stdio MCP presets to per-pod sidecar URL, wakes the target pod (waits up to 20s for `phase=Active`). Parent then yields `ctx.call_child_workflow("session_workflow", app_id="agent-runtime-<slug>", instance_id=<deterministic session_id>, autoTerminateAfterEndTurn=true)`. Retry resilience via `WorkflowRetryPolicy(max_attempts=8)`.
- **Direct (UI-initiated) sessions** go through `src/lib/server/sessions/spawn.ts`, which wakes the pod and calls Dapr `StartInstance` via service invoke (bare app-id, no `.namespace` suffix).
- **MCP sidecar rewrite**: both paths call `rewriteMcpForBrowserSidecar` (`src/lib/server/agents/mcp-sidecar.ts`) — Playwright entries become `{ transport: "streamable_http", url: "http://localhost:3100/mcp" }`.
- **Dapr Component visibility**: `workflowstatestore` is the only `actorStateStore=true` Component visible to agents; `dapr-agent-py-statestore` and legacy `agent-workflow` are non-actor stores. New agents must NOT be added to Component scopes.
- Every non-agent action: `orchestrator → Dapr service invoke → function-router → {fn-system | fn-activepieces | openshell-agent-runtime | code-runtime | crawl4ai-adapter}`. Orchestrator uses `activities/dapr_invoke.py` (no raw HTTP). `openshell-agent-runtime` consolidates `workspace/* + browser/* + openshell/*` (legacy `workspace-runtime` removed 2026-04-21).
- function-router owns credential decryption (AES-256-CBC from `app_connection`) + `credential_access_logs` audit. Orchestrator never holds plaintext secrets.

## Tech Stack

- **Frontend**: SvelteKit 5, Svelte 5, Svelte Flow (@xyflow/svelte), shadcn-svelte
- **Backend**: SvelteKit API routes (BFF proxy)
- **Database**: PostgreSQL via Drizzle ORM
- **Auth**: GitHub/Google OAuth2, JWT API keys (RS256)
- **Workflow Engine**: Dapr Workflow SDK (Python) via workflow-orchestrator
- **Durable AI Agent**: per-agent `agent-runtime-<slug>` pod running `dapr-agent-py`. Scales 0↔1 on demand.
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

Skaffold is the in-cluster dev loop. `devspace.yaml` + `scripts/devspace-dev-ryzen.sh` were retired in Phase 1; `bash scripts/skaffold-dev.sh` is the canonical entry point.

```bash
# Inner loop (HMR file-sync into a Skaffold-owned dev pod):
pnpm dev:skaffold                              # workflow-builder (default)
pnpm dev:skaffold:orchestrator                 # workflow-orchestrator
pnpm dev:skaffold:all                          # active modules
bash scripts/skaffold-dev.sh function-router   # any single module by name
bash scripts/skaffold-dev.sh workflow-builder workflow-orchestrator  # subset

# Outer loop (build prod image → push → commit kustomize pin → Argo deploys):
pnpm deploy:skaffold                                # workflow-builder
pnpm deploy:skaffold:orchestrator                   # workflow-orchestrator
bash scripts/skaffold-deploy.sh fn-activepieces     # any single service
bash scripts/skaffold-deploy.sh workflow-builder workflow-orchestrator  # batch
skaffold build -m workflow-builder                  # build+push only (no pin commit)

# Read-only preflight:
pnpm skaffold:doctor                                # Skaffold + GitHub-main pin readiness
pnpm --silent skaffold:doctor -- --json             # machine-readable agent output
```

The outer-loop uses `scripts/skaffold-deploy.sh` rather than `skaffold run` because:
- `skaffold run -m <svc>` also redeploys the dev kustomize overlay (which Argo immediately reverts but causes pod restarts).
- Skaffold artifact `hooks.after` doesn't fire on cache hits, so `skaffold run` would silently miss commit-pin when re-pushing the same SHA.

The wrapper invokes `skaffold build --file-output`, parses the resolved tag, and unconditionally runs `commit-pin.sh` with it. Commit-pin maintains a dedicated clone at `~/.cache/skaffold/stacks-ryzen` (tracking GitHub `main` — the same origin as the developer's stacks/main worktree; the `stacks-ryzen` dir name is legacy). It is the single image-pin writer on GitHub `main` for the Skaffold-owned services (`SKAFFOLD_OWNED_DEFAULT` in `scripts/_modules.sh`); every other ryzen workload is pinned by the hub outer-loop `update-stacks-image` Tekton task.

Module set:

| Module | Type | Local→Container port |
|---|---|---|
| workflow-builder | SvelteKit BFF (Node 22) | 3002→3000 |
| workflow-orchestrator | Python/FastAPI Dapr workflow | 3013→8080 |
| function-router | Node BFF→backend router | 3014→8080 |
| mcp-gateway | Node hosted MCP endpoint | 3018→8080 |
| swebench-coordinator | Python SWE-bench coordinator | 3019→8080 |
| fn-activepieces | Node Activepieces piece executor | 3016→8080, inactive by default |

**`fn-system` is excluded** — it's a Knative Service (scale-to-0; not a regular Deployment). Inner-loop file-sync into a transient Knative pod is impractical. Use the cluster's existing fn-system (Argo-managed) as a dependency; `scripts/sandbox-dev.sh` is the experimental sandbox-based alternative for Knative-style workloads.

**`fn-activepieces` is inactive by default** — Skaffold config remains in-tree, but the current ryzen cluster does not expose it as a regular Argo Application/Deployment. Default `ALL` sessions skip it; use `SKAFFOLD_ALLOW_INACTIVE=1 bash scripts/skaffold-dev.sh fn-activepieces` only when deliberately restoring/testing that path.

Inner-loop notes:
- The wrapper `scripts/skaffold-dev.sh` exports `SKAFFOLD_DEFAULT_REPO=ghcr.io/pittampalliorg` so the dev image gets pushed to GHCR (ryzen pulls it via the authenticated `ghcr.io/hosts.toml` containerd mirror + Spegel P2P). The host running `skaffold dev` needs GHCR push creds (`docker login ghcr.io`). Override via `SKAFFOLD_DEFAULT_REPO=…` for other clusters.
- The wrapper traps SIGINT/SIGTERM/EXIT to resume ArgoCD reliably. If skaffold is `kill -9`'d, recover with `ARGO_APPS=workflow-builder bash skaffold/hooks/argo-resume.sh`.
- File sync rules in `skaffold/workflow-builder.skaffold.yaml` define which paths trigger HMR vs a full image rebuild. Edits to `src/`, `lib/`, `static/`, `drizzle/`, `vite.config.ts`, etc. trigger HMR without rebuild. Edits to `package.json`/`pnpm-lock.yaml` force a full image rebuild + redeploy.
- The dev kustomize overlay at `skaffold/dev/workflow-builder/` extends **only** `Deployment-workflow-builder.yaml` from `stacks/main/.../workloads/workflow-builder/manifests` (via `LoadRestrictionsNone`) and strategic-merge-patches it; all other resources (Dapr Components, ExternalSecrets, Services) stay as Argo deployed them. Because the base prod `images:` rewrite is bypassed, the patch must pin **both** the main container AND the `db-migrate` init container to the `workflow-builder-dev` artifact — leaving db-migrate unpatched fails the deploy with `ErrImagePull` on `workflow-builder:latest` (fixed in PR #28; the dev image bakes in `scripts/db-migrate-runtime.mjs` + `drizzle/`, so it runs migrations fine). No postgres rewrite is needed — `docker.io/library/postgres` pulls via the containerd `docker.io/hosts.toml` mirror.
- `pnpm skaffold:doctor` checks command availability, kubectl context, the GHCR default-repo, the stacks worktree + GitHub-main pin cache, per-module Argo/Deployment state + pin drift, and Argo skip-reconcile leaks.

Outer-loop notes:
- Build hook `skaffold/hooks/commit-pin.sh` writes the new tag via textual edit to GitHub `main` under `packages/components/workloads/<service>/manifests/kustomization.yaml` and `git push`es. A writer-precedence guard refuses to push for any non-Skaffold-owned service (override the owned set via `SKAFFOLD_OWNED_SERVICES`; the remote via `STACKS_REMOTE_URL`). ryzen's local autonomous ArgoCD reconciles `packages/overlays/ryzen@main` within ~30s; an `argocd.argoproj.io/refresh=hard` annotation accelerates the poll.
- No `kubectl set image` — the live cluster is mutated only by ArgoCD.
- Workloads image pins use bare `name: <svc>` match-keys for **all** services (`workflow-orchestrator`/`function-router`/`mcp-gateway` were flipped from the retired `gitea-ryzen.tail286401.ts.net/giteaadmin/<svc>` long-form in stacks PR #2435; image-neutral). commit-pin matches `name == <svc>` OR `name endswith /<svc>`.
- **commit-pin's HTTPS push can 403 on this NixOS host** (read-only git config → denied OAuth fallback). The image + pin commit are still made; push the cached pin with `git -C ~/.cache/skaffold/stacks-ryzen push "https://x-access-token:$(gh auth token)@github.com/PittampalliOrg/stacks.git" HEAD:main`, then hard-refresh `ryzen-<svc>`. **Don't `deploy:skaffold` a commit the GitHub outer-loop also builds** (right after merging a wfb PR to `main`) — both build the same `git-<sha>` tag with different digests, so the GitHub build's release-pins digest then mismatches GHCR; to deliver a just-merged commit to ryzen, commit-pin the existing GHCR tag instead of rebuilding.
- ryzen reconciles `packages/overlays/ryzen@main` directly via its local autonomous ArgoCD (no inner-loop branch, no source-hydrator, no Promoter for ryzen); commit-pin is the single image-pin writer for Skaffold-owned services. Use `clu`/cluster-update for stacks manifest edits, Skaffold for live source hot reload, and release-pins/GitOps Promoter for **dev** (staging is dormant — no staging cluster; promotion is ryzen + dev, stacks PR #2436/#2437).

## Services Overview

| Service | Port | Role |
|---------|------|------|
| **workflow-orchestrator** | 8080 | Python Dapr workflow engine, SW 1.0 interpreter |
| **agent-runtime-controller** | n/a | Kopf operator; reconciles `AgentRuntime` CRs → 1 Deployment per agent |
| **agent-runtime-&lt;slug&gt;** | n/a | Per-agent pod; `dapr-agent-py` + daprd + optional browser sidecars. Scales 0↔1. |
| **dapr-agent-py** (legacy) | n/a | Legacy shared pod for `openshell-durable-agent` enum path |
| **function-router** | 8080 | Sync credential broker + Knative proxy. `function-registry` ConfigMap is authoritative over built-in fallback. |
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
- `services/` — `workflow-orchestrator/`, `dapr-agent-py/`, `agent-runtime-controller/`, `function-router/`, `fn-activepieces/`, `fn-system/`, `workflow-mcp-server/`, `piece-mcp-server/`, `mcp-gateway/`, `openshell-sandbox/`, `crawl4ai-adapter/`
- `drizzle/` — migration SQL. `scripts/` — dev/seed/test. `docs/` — supplementary docs.

## Action Routing

Routed by `actionType` slug prefix. Orchestrator → function-router uses Dapr service invoke; `durable/run` bypasses function-router via `ctx.call_child_workflow`.

| Prefix | Service | Notes |
|--------|---------|-------|
| `durable/run` | `agent-runtime-<slug>` | Native Dapr child workflow. Target app-id from `agentRef` → `agents.runtime_app_id`; falls back to legacy `dapr-agent-py` only when neither `agentAppId` nor `agentSlug` is stamped. |
| `system/*` | fn-system | http-request, database-query, condition |
| `workspace/*` | openshell-agent-runtime | Plus `persist_workspace_session` activity after `workspace/profile` with `keepAfterRun=true` (UPSERTs `workflow_workspace_sessions` for live-preview proxy) |
| `browser/*` | openshell-agent-runtime | Browser profile, clone, command, capture-flow, validate |
| `openshell/*` | openshell-agent-runtime | OpenShell helper routes |
| `code/*` | code-runtime | Saved TS/Python code execution |
| `*` (default) | fn-activepieces | All AP piece actions |

Rejected slugs (orchestrator raises): `claude/run`, `openshell/run`, `openshell/session-start`, `openshell-langgraph/run`, `openshell-langgraph-observable/run`, `dapr-agent-py/run`, `dapr-swe/run`, `durable/plan`, any `mastra/*` or `agent/*`.

## Per-Agent Runtime Model

Every published agent gets its own pod. On publish, `src/lib/server/agents/registry-sync.ts` upserts an `AgentRuntime` CR (`agents.x-k8s.io/v1alpha1`); the Kopf operator at `services/agent-runtime-controller/src/main.py` reconciles one `Deployment/agent-runtime-<slug>` per CR.

**Pod shape** (built by `_build_deployment`):
- `seed-openshell-config` init container — writes `${XDG_CONFIG_HOME}/openshell/active_gateway` + mTLS certs from `openshell-client-tls` + `openshell-server-client-ca` Secrets. Without it, OpenShell tools fail with ENOENT on `active_gateway`.
- `dapr-agent-py` main container — `session_workflow` + `agent_workflow` + plugins/hooks. Reads `DAPR_AGENT_PY_BOOTSTRAP_MCP_SERVERS_JSON` from CR spec.
- `daprd` sidecar — injected by `openshell-sandbox-dapr-webhook` (matches `openshell` and `workflow-builder`). Requires `openshell-sandbox-dapr` Configuration in the pod's namespace.
- *(Optional)* `chromium` + `playwright-mcp` browser sidecars when agent has Playwright MCP preset. Controller stamps `browserSidecar.enabled=true` + attaches per-agent `ClusterIP Service` (`agent-runtime-<slug>-mcp:3100`).

**Scaling**: replicas default to 0; sessions wake via `agents.x-k8s.io/wake` annotation. `idleTtlSeconds` (default 1800; per-agent overridable via `agentRuntimeIdleTtlSeconds`) drives the `idle_reaper` timer. Scales back to 0 after TTL since `lastActiveAt` (BFF stamps each dispatch).

**Dapr Component visibility** in `workflow-builder` ns:

| Component | `actorStateStore` | Used by |
|---|---|---|
| `workflowstatestore` | true | Dapr workflow/actor history |
| `dapr-agent-py-statestore` | false | Agent/session state |
| `agent-workflow` | false | Legacy openshell-durable-agent (no active consumers) |

A Dapr sidecar refuses to start if it sees more than one `actorStateStore=true` Component. New agents: create/update `AgentRuntime` CR; do NOT patch Component scopes.

## Workflow → Session Bridge

Every `durable/run` step goes through a session bridge so workflow-driven runs appear in the same `/sessions/[id]` UI as direct sessions. Structural invariant — old `WORKFLOW_USE_SESSIONS` flag removed.

**Flow** (`services/workflow-orchestrator/workflows/sw_workflow.py` + `activities/spawn_session.py`):

1. Orchestrator yields `spawn_session_for_workflow` with `bridge_payload` (agentAppId, agentSlug, workspaceRef, sandboxName, agentConfig, durable/run body).
2. Activity HTTP-POSTs to BFF's `/api/internal/sessions/ensure-for-workflow`. Handler rewrites `agentConfig.mcpServers` for browser sidecar, finds/creates session row (keyed by `child_instance_id = <exec>__<kind>__<node>__run__<index>`), creates ephemeral `agents` row if inline, wakes pod via `wakeAgentRuntime(slug, 20_000)` (non-blocking — Dapr retries if pod takes longer), returns `{sessionId, agentId, agentVersion, childInput, reused}`.
3. Orchestrator yields `ctx.call_child_workflow("session_workflow", input=childInput, instance_id=child_instance_id, app_id=target["app_id"])`.
4. Child runs on `agent-runtime-<slug>` with `autoTerminateAfterEndTurn: true` — one turn, emits `session.status_idle{end_turn}` + `session.status_terminated`.
5. Parent resumes; final output persists to `workflow_executions.output`.

### Safety nets on the agent side (2026-04-21)

Three defensive layers prevent `durable/run` hangs:

- **Empty-response circuit breaker** (`services/dapr-agent-py/src/main.py` `call_llm`): tracks consecutive empty-content + no-tool-calls responses (or exceptions counted as empty). After `DAPR_AGENT_PY_EMPTY_RESPONSE_THRESHOLD` (default 3), raises `AgentError`. Catches Anthropic SDK [#1204](https://github.com/anthropics/anthropic-sdk-python/issues/1204) (Opus 4.7 + thinking + tools emits empty `end_turn`).
- **Session-turn timer** (`session_workflow` wraps child in `when_any([child, timer])`): if child takes >`DAPR_AGENT_PY_SESSION_TURN_TIMEOUT_SECONDS` (default 600), raises timeout `AgentError`.
- **Image tool_result compaction** (`anthropic_adapter.py` `_compact_image_tool_results`): keeps only last `DAPR_AGENT_PY_MAX_IMAGE_TOOL_RESULTS` (default 3) intact image tool_result blocks; older ones replaced with placeholder text. Prevents 1M-token overflow from screenshot accumulation.

### Workspace session persistence

Orchestrator owns the DB write for `workflow_workspace_sessions` post `workspace/*` cutover:
- **`persist_workspace_session` activity**: after `workspace/profile` with `keepAfterRun=true`, UPSERTs the row (status=`active`, sandbox_state JSONB) keyed on `workspace_ref`. Read by `getExecutionSandboxPreviewInfo` for the live-preview proxy.
- **Cleanup gate**: `_should_cleanup_workspaces` walks the SW 1.0 spec for `workspace/*` steps with `with.keepAfterRun: true` (openshell-agent-runtime's response doesn't echo the flag back).

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

**Playwright sidecar rewrite** (`src/lib/server/agents/mcp-sidecar.ts`): any `agentConfig.mcpServers` entry matching Playwright (by name, URL containing `playwright-mcp`, or args containing `@playwright/mcp`) is rewritten to `{ transport: "streamable_http", url: "http://localhost:3100/mcp" }`. Called from BOTH spawn paths (`src/lib/server/sessions/spawn.ts` and `src/routes/api/internal/sessions/ensure-for-workflow/+server.ts`). Controller adds `chromium` + `playwright-mcp` sidecars when matched.

For UI-runnable agent workflows: SW 1.0 `durable/run` with `agentConfig.mcpServers` and `x-workflow-builder.input` prompt metadata. See `docs/mcp-agent-workflows.md`. MCP Apps use `@modelcontextprotocol/ext-apps` (`tool-widget.tsx`).

## Hooks + Plugins (dapr-agent-py)

Port of Claude Code's hooks + plugins surface. Feature-flagged via `DAPR_AGENT_PY_HOOKS_ENABLED=true` + `DAPR_AGENT_PY_PLUGINS_ENABLED=true`; plugins ship via `fetch-claude-plugins` init container cloning `anthropics/claude-plugins-official` to `/etc/dapr-agent-py/plugins`.

- **Events v1**: PreToolUse, PostToolUse, PostToolUseFailure, UserPromptSubmit, SessionStart, SessionEnd, Stop, Notification
- **Hook types v1**: `command` (subprocess JSON stdin/stdout, exit-code 2 = blocking) + `callback` (in-process Python)
- **Per-run overlay**: `durable/run.with.agentConfig.hooks` + `agentConfig.plugins` layered on startup registry (mirrors `mcpServers`)
- **Durability**: PreToolUse/PostToolUse/PostToolUseFailure fire inside durable `run_tool` activity; session-level events gated by `not ctx.is_replaying`

> See `docs/hooks-and-plugins.md`.

## Activepieces Integration

- Credentials: AES-256-CBC encrypted in `app_connections`
- Auth types: `OAUTH2`, `SECRET_TEXT`, `BASIC_AUTH`, `CUSTOM_AUTH`
- Flow: User creates → encrypted in DB → function-router decrypts at execution
- Adding piece: (1) `installed-pieces.ts`, (2) npm dep to fn-activepieces, (3) `piece-registry.ts`, (4) rebuild

> See `docs/activepieces-auth.md`.

## CMA Parity (Managed Agents Console)

Mirrors platform.claude.com/dashboard surface-for-surface. Workspace scoping is the unifying invariant: every user-facing resource carries `project_id`; `hooks.server.ts` resolves scope from `X-Workspace` header or URL slug into `locals.session.projectId`.

- **Workspaces**: `/workspaces` membership; `/workspaces/[slug]/*` canonical path. Non-member 404s at layout guard.
- **Members**: `/settings/members` — CRUD via `/api/v1/projects/[projectId]/members`. Last-admin demote/remove blocked.
- **Sessions**: CMA-shape event stream (`agent.message`, `agent.thinking`, `agent.tool_use`, `agent.tool_result`, `session.status_*`). **Fork**: `POST /api/v1/sessions/[id]/fork` with `fromSequence`.
- **Custom skills**: `sourceType = "custom"` in `agent_skill_registry`, scoped via `project_id`. `POST /api/agent-skills` + `PATCH /api/agent-skills/[id]` (prompt edit bumps version). Curated/global rows visible to all workspaces.
- **Usage + cost**: `/api/v1/usage` and `/api/v1/cost` workspace-scoped; fall back to `userId` if no project. Joins `agents.name`.
- **Limits dashboard**: `/settings/limits` auto-refreshes every 15s via `/api/v1/limits/live`. Computed on-demand from `sessions.usage` + `sessions.status`.
- **Observability deep-link**: session detail → Phoenix + ClickHouse trace explorer (`session.id` span attribute filter).
- **Workflow → session cross-link**: workflow run Overview lists sessions via `/api/workflows/executions/[executionId]/sessions`.

Full map: `docs/cma-parity.md`.

## Browser Validation (In-Sandbox Screenshots)

`browser/validate` action captures screenshots inside the coding agent's OpenShell sandbox (no second sandbox needed).

- **Custom sandbox image**: `services/openshell-sandbox/Dockerfile` — Ubuntu 24.04 + Chromium via Playwright at `/opt/pw-browsers`
- **Composite endpoint**: `POST /api/browser/validate` in openshell-agent-runtime
- **Screenshot transfer**: PNGs base64-encoded in sandbox, read in 4KB chunks via `dd` (OpenShell stdout truncates >4KB outputs)
- **Storage**: `workflow_browser_artifacts` + `workflow_browser_artifact_blob_payloads`
- **UI**: Artifacts tab in run detail, auto-expands first completed

**Constraints**: chunked file reads for >4KB outputs; base64-encoded scripts (no heredoc through OpenShell API); browsers at `/opt/pw-browsers`; `imagePullPolicy: Always` for sandbox images.

## Standardized Workflow Artifacts

Any SW 1.0 task can declare typed outputs via `artifacts:` block alongside `with:`. Generic table + discriminated-union renderer.

```yaml
synthesize:
  call: durable/run
  with: ...
  artifacts:
    - kind: markdown
      slot: primary             # primary | secondary | aux
      title: "Research synthesis"
      from: "${ .data.content }"  # jq, evaluated against expression context
      contentType: "text/markdown"
      if: "${ .data.content != null }"
```

`_persist_task_artifacts` walks `task_data.get("artifacts", [])`, evaluates jq, yields `persist_workflow_artifact` per entry. Activity ID is deterministic (`sha256(workflowId|executionId|nodeId|kind|title)[:24]`) so retries collapse to UPSERT.

**Storage**: `workflow_artifacts` table (drizzle 0067). Inline payload (jsonb ≤256 KB) or `file_id` for blobs.

**Standard kinds**:

| `kind` | `inline_payload` | UI renderer |
|---|---|---|
| `markdown` | `{ markdown: string }` | `Response` (Streamdown + Shiki) |
| `json` | `{ value: any }` | `JsonViewer` |
| `text` | `{ text: string }` | `<pre>` |
| `table` | `{ columns, rows }` | inline table |
| `image` | `{ alt }` (blob via fileId) | `<img>` |
| `link` | `{ url }` | anchor |
| `card` | `{ body, footer? }` | shadcn `<Card>` |

Unknown kinds fall back to JSON dump. `from:` jq value auto-wrapped per kind.

**Consumer**: `<ArtifactList artifacts={...} mode="primary|all" />` (`src/lib/components/workflow/execution/artifact-list.svelte`). APIs: `GET /api/workflows/executions/[id]/artifacts` (workspace-scoped read); `POST /api/internal/workflows/executions/[id]/artifacts` (internal-token write). Activity is best-effort — failures logged, not propagated.

> See `docs/workflow-artifacts.md`.

## Tiered Crawl Pipeline (research workflows)

`browserresearchfanout01` v3 is the canonical pattern for multi-URL "fetch + extract + synthesize". Replaces v2 browser-use-agent for research/extraction; browser-use stays for *interactive* (vision/click) tasks.

```
trigger {topic, urls, extractionPrompt}
  → for { url in .trigger.urls }            ← orchestrator-side sequential
       web/crawl.async                       ← single durable activity sequence
         (start_job + poll loop with timer)
         (deterministic per-URL jobId, Postgres-backed, retry-safe)
         (tier escalation http→pw→stealth)
         (Anthropic schema-validated `extracted` field)
  → durable/run text-research-synthesizer    ← pure text agent (no browser)
       (workspaceRef: "local", no MCP, no tools)
```

**crawl4ai-adapter v2** (`services/crawl4ai-adapter/`):
- API: `POST /crawl/jobs { url, jobId?, tiers?, extractionSchema?, cacheTtlSeconds? }`; `GET /crawl/jobs/{id}` → `{ complete, success, data, error }`
- **State**: PG tables `crawl4ai_jobs` + `crawl4ai_cache`. DDL auto-applied. Single-replica but state externalised.
- **Idempotent jobIds**: `j_<sha256(workflowId|nodeId|url)>[:32]`. Adapter returns existing for terminal/in-flight; FAILED resets to PENDING + re-kicks.
- **Cache** keyed on `sha256(url|tier_chain|schemaHash)`. Default 1h TTL.
- **Tier escalation**: `tiers: [http, playwright, stealth]` (default `[http]`). Escalates on block-detect (empty body, 403/429, Cloudflare/Akamai/PerimeterX/Captcha markers).
- **Schema-driven extraction**: optional `extractionSchema` → Anthropic `tool_use` validated output in `result.extracted`. Skipped if `ANTHROPIC_API_KEY` unset.
- **Orphan recovery**: startup watchdog scans stale PENDING/RUNNING; lazy resume in `GET /crawl/jobs/{id}` re-kicks from stored request.

**For-task jq output**: per-URL outputs at `<for_name>/<sub_name>[<idx>]`; envelope `{complete, success, data: {tier, url, extracted, ...}, error}` has ONE unwrap applied — read `.data.tier`, `.data.extracted` (NOT `.tier` / `.extracted` — that was the v3-iter1 bug).

**text-research-synthesizer agent** (`runtime: dapr-agent-py`): pure text, no MCP, no browser, no sandbox. Receives corpus + topic + extractionPrompt, emits structured JSON + cross-URL synthesis.

**Don't use this for**: interactive browser control (form fills, login, clicks, vision-based extraction) — use browser-use-agent path instead.

## Troubleshooting

- **Missing credentials** → Add API keys to Azure Key Vault or create app connections
- **Agent timeout** → Check `kubectl logs -n workflow-builder deploy/agent-runtime-<slug>` + workflow-orchestrator logs
- **Agent stops early** → Check `maxTurns` (default 50, per-node configurable)
- **OAuth2 token expired** → Auto-refresh; check `AP_ENCRYPTION_KEY`
- **AP credential decrypt fails** → Verify `INTERNAL_API_TOKEN` matches across services
- **Tool fails ENOENT on `active_gateway`** → `seed-openshell-config` init didn't run; verify CR was created AFTER `openshell-sandbox-dapr-webhook` namespaceSelector covered `workflow-builder` AND controller image includes the init container; re-publish agent if older
- **daprd `no X509 SVID / failed to get configuration`** → `dapr.io/config` Configuration missing in pod's namespace. `openshell-sandbox-dapr` must exist in `workflow-builder` (declared at `packages/components/workloads/workflow-builder/manifests/Configuration-openshell-sandbox-dapr.yaml`)
- **daprd `detected duplicate actor state store`** → Component with `actorStateStore=true` and no restrictive scopes became visible. Partition scopes (see Per-Agent Runtime Model)
- **`ctx.call_child_workflow` times out `app may not be available`** → target pod isn't placement-registered. Either scaled to 0 (missing wake annotation) OR different namespace from parent (sub-orchestration is intra-namespace only)
- **`Ignoring unexpected taskCompleted event with ID = N`** → NOT stuck; normal `call_child_workflow` replay chatter. Real stuck signals: CR `phase=Sleeping` after wake set, or pattern persists >5 min with daprd placement flaps
- **BFF `wake <slug> failed ... phase=Sleeping` + CR stays Sleeping** → Kopf controller dropped annotation watchers. Fix: `kubectl -n workflow-builder rollout restart deploy/agent-runtime-controller`
- **BFF `/execute` `ECONNREFUSED` to orchestrator** → orchestrator CrashLoopBackOff; common cause is image predating `activities/crawl4ai.py`
- **Session rows with `project_id=NULL`** → can't happen post migration 0040. If seen, something inserts outside BFF + bridge paths
- **Workflow-driven sessions show raw agent IDs** → ephemeral agents filtered from `/api/agents` by design. `listSessions` LEFT JOINs `agents` returns `agentName/agentSlug/agentAvatar/agentEphemeral`
- **Agent loops with empty responses** → Anthropic SDK [#1204](https://github.com/anthropics/anthropic-sdk-python/issues/1204). Circuit breaker in `call_llm` trips after 3 (`DAPR_AGENT_PY_EMPTY_RESPONSE_THRESHOLD`); look for `[call-llm] circuit-breaker tripped`
- **Child session hangs with no LLM traffic** → session-turn timer (default 600s, `DAPR_AGENT_PY_SESSION_TURN_TIMEOUT_SECONDS`) fires via `when_any([child, timer])`. Search logs for `Session turn N exceeded`
- **Anthropic 400 `prompt is too long: N > 1000000`** → too many image tool_results. `_compact_image_tool_results` keeps last `DAPR_AGENT_PY_MAX_IMAGE_TOOL_RESULTS` (default 3); lower if still overflowing
- **Anthropic 400 `Streaming is required ...`** → non-streaming call estimated >10 min. Fixed 2026-04-21 by routing all calls through `_stream_final_message`. Lower `DAPR_AGENT_PY_MAX_TOKENS` (default 16384) if reappears
- **dapr-agent-py code changes need TWO image builds**: `dapr-agent-py:git-<sha>` (legacy pods, GitOps tag bump) + `dapr-agent-py-sandbox:latest` (per-agent runtime pods, `imagePullPolicy: Always`)
- **Live-preview 404 "Retained sandbox not found"** → `workflow_workspace_sessions` row missing or `status='cleaned'`. Verify `persist_workspace_session` fired, spec has `with.keepAfterRun: true`, `_should_cleanup_workspaces` honoured it. Revive: `UPDATE workflow_workspace_sessions SET status='active' WHERE workflow_execution_id=<id>`
- **`${ .trigger.X }` reaches agent as literal string** → SW 1.0 jq-template eval only fires for ENTIRE-value `${...}` (`core/sw_expressions.py::is_expression_string`). Embedded `${...}` passes through. Wrap whole value in one jq expression
- **`web/crawl.async` times out at per-URL `timeoutMs`** → adapter pod restarted while RUNNING + lazy-resume didn't fire fast enough. Reset stuck rows: `UPDATE crawl4ai_jobs SET state='FAILED' WHERE state IN ('PENDING','RUNNING') AND updated_at < now() - interval '2 minutes'`. Tighten `CRAWL4AI_ORPHAN_AFTER_SECONDS` if recurrent
- **Synthesizer calls WebSearch / hangs / hits step budget** → per-URL corpus has nulls (agent compensates). Cause: jq path missing envelope unwrap. Use `.data.tier` / `.data.extracted` (NOT `.tier` / `.extracted`)
- **`artifacts:` block declared but no rows** → activity is best-effort. Check orchestrator logs for `persist_workflow_artifact` warnings. Common causes: BFF route 503 (DB pool), missing `INTERNAL_API_TOKEN`, jq returned `null` AND `if:` guard true. Verify: `SELECT id, kind, title FROM workflow_artifacts WHERE workflow_execution_id=?`
- **MLflow Traces UI shows `IN_PROGRESS` after success** -> FIXED 2026-05-12 via `finalize_mlflow_trace_root` activity. Orchestrator POSTs synthetic OTLP `ResourceSpans` proto directly to `${OTEL_EXPORTER_OTLP_ENDPOINT}/v1/traces` over raw HTTP (parent_span_id empty). MLflow's OTLP receiver flips state IN_PROGRESS -> OK. **Must use raw HTTP, not SDK tracer** (BatchSpanProcessor would attach as child of active context). Disable via `WORKFLOW_ORCHESTRATOR_MLFLOW_FINALIZE_ROOT_SPAN=false`. Optional workflow node spans are frozen into new workflow inputs from `WORKFLOW_ORCHESTRATOR_MLFLOW_NODE_SPANS=false` (default off).
- **SvelteKit type errors** → `pnpm check`

> See Dapr component YAMLs in stacks repo for service scoping.

---

**Last Updated**: 2026-06-04

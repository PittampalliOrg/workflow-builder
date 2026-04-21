# Workflow Builder

Visual workflow builder with Dapr workflow orchestration, durable AI agents, and MCP server integration. The SvelteKit app serves as a UI + BFF proxy layer; all workflow execution lives in Dapr on Kubernetes.

> **Supplementary docs**: See `docs/` for detailed references:
> - `docs/per-agent-runtime.md` — AgentRuntime CRD + controller, per-agent pod shape, Dapr Component scoping, wake/idle TTL, dispatch paths, troubleshooting cheatsheet
> - `docs/activepieces-auth.md` — AP auth/connection system details
> - `docs/activepieces-integration-implementation.md` — AP integration implementation
> - `docs/mcp-agent-workflows.md` - MCP-enabled `dapr-agent-py` workflow method
> - `docs/hooks-and-plugins.md` — `dapr-agent-py` hooks + plugins subsystem (Claude Code port)
> - `docs/CLICKHOUSE_OBSERVABILITY.md` — ClickHouse observability stack
> - `docs/openshell-capabilities.md` — OpenShell sandbox capabilities
> - `docs/cma-parity.md` — CMA (Claude Managed Agents) console parity: workspaces, members, sessions, custom skills, limits, observability
> - `docs/callable-agents.md` — `CallAgent` peer-delegation tool (Approach B: native `WorkflowContextInjectedTool` on `dapr-agents>=1.0.1`; peer answer returns as `tool_result` in the same LLM turn)

## Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                    Kubernetes cluster — `workflow-builder` ns                │
│                                                                              │
│  ┌─────────────────┐    ┌────────────────────────────────────────────────┐  │
│  │  SvelteKit BFF  │    │  workflow-orchestrator (Python/Dapr)           │  │
│  │  (Dapr sidecar) │───▶│  SW 1.0 interpreter · durable/run → child wf   │  │
│  │  Port 3000      │    │  other slugs → Dapr invoke → function-router   │  │
│  └────────┬────────┘    └──────┬──────────────────────────┬──────────────┘  │
│           │ wake + ensure      │ ctx.call_child_workflow  │ Dapr svc invoke │
│           ▼                    ▼                          ▼                 │
│  ┌─────────────────────────────────────────────┐  ┌─────────────────────┐  │
│  │  AgentRuntime CRD (agents.x-k8s.io/v1alpha1) │  │  function-router    │  │
│  │  + Kopf controller (agent-runtime-controller)│  │  slug → svc route   │  │
│  │     reconciles 1 Deployment per CR           │  │  credential broker  │  │
│  └──────────────────┬──────────────────────────┘  │  Knative proxy      │  │
│                     │ one Pod per published agent  └──────┬──────────────┘  │
│                     ▼                                     │                 │
│  ┌────────────────────────────────────────────────┐       │ ┌─────────┐ ┌─┐ │
│  │  agent-runtime-<slug>  (per-agent Pod)         │       ├▶│fn-sys   │ │ │ │
│  │    dapr-agent-py  (@workflow_entry             │       │ └─────────┘ │ │ │
│  │      agent_workflow + session_workflow)        │       │ ┌─────────┐ │ │ │
│  │    daprd  (Dapr sidecar, placement-registered) │       ├▶│fn-active│ │…│ │
│  │    seed-openshell-config  (init → gateway cfg) │       │ │pieces   │ │ │ │
│  │    [optional] chromium + playwright-mcp sidecar│       │ └─────────┘ │ │ │
│  └────────────────────────────────────────────────┘       │ ┌─────────┐ │ │ │
│                                                            └▶│workspace│ │ │ │
│                                                              │-runtime │ └─┘ │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐       └─────────┘     │
│  │ workflow-mcp │  │ piece-mcp-   │  │ mcp-gateway  │                        │
│  │ -server      │  │ server       │  │ (hosted MCP) │                        │
│  └──────────────┘  └──────────────┘  └──────────────┘                        │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐                        │
│  │    Redis     │  │  PostgreSQL  │  │ OTEL Collector│                       │
│  └──────────────┘  └──────────────┘  └──────────────┘                        │
└─────────────────────────────────────────────────────────────────────────────┘

Per-session sandbox pods (chromium + OpenShell workspace containers) live in
the `openshell` namespace and are addressed over mTLS. Agent runtime pods are
same-namespace with the orchestrator so Dapr workflow sub-orchestration works
— cross-namespace child-workflow routing is not supported at the workflow-SDK
actor-lookup layer.
```

**Key dispatch invariants**
- **Per-agent runtime pods** (`agent-runtime-<slug>`) live in the **same namespace as the orchestrator** (`workflow-builder`). One Deployment per published agent, materialized by the `agent-runtime-controller` Kopf operator from `AgentRuntime` CRs. Pods scale to 0 on idle (idleTtlSeconds default 1800) and are woken on demand via a `agents.x-k8s.io/wake` annotation → controller's `on_wake` handler scales to 1.
- `durable/run` is a **Dapr child workflow**, not an HTTP call. The orchestrator calls `ctx.call_child_workflow("session_workflow", app_id="agent-runtime-<slug>", ...)` — **session bridge is now a structural invariant**, not a feature flag. The `spawn_session_for_workflow` activity POSTs to `/api/internal/sessions/ensure-for-workflow` which (a) finds-or-creates the session row keyed by `{workflowId, nodeId}`, (b) rewrites Playwright stdio MCP presets to the per-pod sidecar URL, (c) **wakes the target per-agent runtime pod** and waits up to 20s for `phase=Active` before responding. After the activity returns, the parent yields `call_child_workflow` with `instance_id=<deterministic session_id>` and `autoTerminateAfterEndTurn: true` — one turn, emit `status_idle{end_turn}` + `status_terminated`. Full Dapr durability preserved; workflow-driven runs appear in `/sessions/[id]` with live event history. Retry resilience via `WorkflowRetryPolicy(max_attempts=8)` on the callee side.
- **Direct (UI-initiated) sessions** go through `src/lib/server/sessions/spawn.ts`, which wakes `agent-runtime-<slug>` and then calls Dapr workflow `StartInstance` on the target app via service invoke. Bare app-id (no `.namespace` suffix) now that BFF + target are same-ns.
- **MCP sidecar rewrite**: both paths (direct session + workflow bridge) call `rewriteMcpForBrowserSidecar` (`src/lib/server/agents/mcp-sidecar.ts`) before dispatch. Any `mcpServers` entry matching Playwright (by name, URL, or `@playwright/mcp` args) becomes `{ transport: "streamable_http", url: "http://localhost:3100/mcp" }` — the in-pod playwright-mcp container's CDP-over-chromium endpoint.
- **Dapr Component scoping** within `workflow-builder` ns is partitioned so every pod sees exactly one `actorStateStore=true` Component (Dapr rejects pods with more than one): `workflowstatestore` is scoped to `workflow-orchestrator` only; `dapr-agent-py-statestore` is scoped to legacy `dapr-agent-py` + BFF + the enumerated `agent-runtime-<slug>` app-ids; `agent-workflow` is scoped to legacy names only. New agent slugs must be added to `dapr-agent-py-statestore.scopes` in `packages/components/active-development/manifests/dapr-agent-py/Component-dapr-agent-py-statestore.yaml` — follow-up work is to have the controller patch this automatically on CR create.
- Every non-agent action goes `orchestrator → Dapr service invoke → function-router → {fn-system | fn-activepieces | openshell-agent-runtime | code-runtime | crawl4ai-adapter}`. The orchestrator uses `activities/dapr_invoke.py` (no raw HTTP). `openshell-agent-runtime` consolidates `workspace/*`, `browser/*`, and `openshell/*` handlers (function-router cutover 2026-04-19; legacy `workspace-runtime` TS service's GitOps + live resources fully removed 2026-04-21).
- function-router owns credential decryption (AES-256-CBC from `app_connection`) + `credential_access_logs` audit. Orchestrator never holds plaintext secrets.

## Tech Stack

- **Frontend**: SvelteKit 5, Svelte 5, Svelte Flow (@xyflow/svelte), shadcn-svelte
- **Backend**: SvelteKit API routes (BFF proxy to Dapr orchestrator)
- **Database**: PostgreSQL via Drizzle ORM
- **Auth**: GitHub/Google OAuth2, JWT API keys (RS256)
- **Workflow Engine**: Dapr Workflow SDK (Python) via workflow-orchestrator
- **Durable AI Agent**: per-agent `agent-runtime-<slug>` pod running `dapr-agent-py` (native Python Dapr runtime). Materialized from `AgentRuntime` CRs (`agents.x-k8s.io/v1alpha1`) by the `agent-runtime-controller` Kopf operator. Scales 0↔1 on demand; wake triggered by `agents.x-k8s.io/wake` annotation.
- **Function Execution**: function-router (Dapr invoke) → fn-system, fn-activepieces, openshell-agent-runtime (owns `workspace/* + browser/* + openshell/*`), code-runtime
- **Durable Agent Dispatch**: orchestrator → `ctx.call_child_workflow("session_workflow", app_id="agent-runtime-<slug>")`. Parent + child share the `workflow-builder` namespace (Dapr workflow actor routing resolves placement intra-namespace only).
- **MCP**: workflow-mcp-server, piece-mcp-server, mcp-gateway
- **Activepieces**: 42 AP piece packages, OAuth2 PKCE, encrypted app connections
- **Observability**: OpenTelemetry → OTEL Collector → Jaeger
- **Deployment**: Docker, Kind cluster, ingress-nginx

## Key Commands

```bash
pnpm dev              # Start SvelteKit dev server
pnpm build            # Production build
pnpm check            # Svelte type checking
pnpm db:generate      # Generate Drizzle migrations
pnpm db:push          # Push schema to DB
pnpm db:migrate       # Run migrations
pnpm db:studio        # Drizzle Studio (DB browser)
pnpm test:e2e         # Run Playwright E2E tests
```

## Services Overview

| Service | Port | Role |
|---------|------|------|
| **workflow-orchestrator** | 8080 | Python Dapr workflow engine, topological node execution |
| **agent-runtime-controller** | n/a | Kopf operator in `workflow-builder` ns; reconciles `AgentRuntime` CRs → one Deployment per agent (`agent-runtime-<slug>`) with dapr-agent-py + daprd + optional browser sidecar + seed-openshell-config init container |
| **agent-runtime-&lt;slug&gt;** | n/a (app-id Dapr-routed) | Dynamic per-agent pod materialized by the controller. Runs `dapr-agent-py` with `@workflow_entry session_workflow` + `agent_workflow`. Scales to 0 on idle TTL; woken on demand via the `agents.x-k8s.io/wake` annotation. |
| **dapr-agent-py** (legacy) | n/a | Legacy shared pod kept for backwards compat + for the one `openshell-durable-agent` enum path. New workflows all dispatch to `agent-runtime-<slug>` via `agentRef`. |
| **function-router** | 8080 | Sync credential broker + Knative proxy. Receives Dapr invoke from orchestrator, decrypts credentials, routes to fn-system / fn-activepieces / openshell-agent-runtime (`workspace/* + browser/* + openshell/*`) / code-runtime / crawl4ai-adapter. Does **not** route `durable/run` or any `dapr-agent-py/*` slug. The `function-registry` ConfigMap is authoritative over the built-in fallback registry (see `services/function-router/src/core/registry.ts` loadRegistry merge order, corrected 2026-04-20). |
| **fn-system** | 8080 | System actions: http-request, database-query, condition |
| **mcp-gateway** | 8080 | Hosted MCP endpoint for external AI clients |
| **fn-activepieces** | 8080 | AP executor for default-routed piece actions in the current cluster runtime |
| **workflow-mcp-server** | 3200 | Retained MCP server, not part of the current core local runtime |
| **piece-mcp-server** | dynamic | Retained MCP server, provisioned on demand |
| **openshell-sandbox** | — | Custom OpenShell sandbox image with Chromium/Playwright for browser validation. Runs in `openshell` ns as per-session workspace containers. |

> See service Dockerfiles in `services/` for build details.

## Project Structure

```
src/
  routes/
    api/
      workflows/[workflowId]/execute/  # Session-auth execution
      orchestrator/workflows/           # Proxy to workflow-orchestrator
      app-connections/                   # CRUD + OAuth2 PKCE
      internal/connections/              # Service-to-service decrypt
      internal/mcp/                     # MCP gateway internal endpoints
      internal/agent/                   # Agent execution + events
      events/ingest/                    # External event ingestion
      v1/auth/                          # JWT auth + social OAuth
      pieces/                           # AP piece metadata
    workflows/[workflowId]/+page.svelte # Workflow editor
    connections/+page.svelte             # Connections management
    settings/+page.svelte                # Settings (API keys, OAuth, MCP)
    auth/sign-in/+page.svelte           # Auth sign-in
  lib/
    components/
      workflow/
        workflow-canvas.svelte          # Svelte Flow canvas
        side-panel.svelte               # Properties/Code/Runs tabs
        workflow-toolbar.svelte         # Toolbar with name, badges, actions
        nodes/base-sw-node.svelte       # SW 1.0 node component
        edges/animated-edge.svelte      # Animated edge with glow
      ui/                               # shadcn-svelte components (50+)
      sidebar.svelte                    # App sidebar with avatar/nav
    server/
      db/schema.ts                      # Drizzle ORM schema
      db/mcp/index.ts                   # MCP server DB helpers
      dapr-client.ts                    # Dapr orchestrator API client
      auth.ts                           # Session auth + JWT API keys
      security/encryption.ts            # AES-256-CBC encryption
      app-connections/oauth2.ts         # OAuth2 PKCE flow
      internal-auth.ts                  # Internal API token validation
      workflows/external-event-registry.ts # GitHub/Gitea event triggers
      otel/clickhouse.ts               # ClickHouse trace queries
    utils/
      layout/elk-layout.ts             # ELK layout engine
      layout/index.ts                   # Unified layout API

services/
  workflow-orchestrator/               # Python Dapr workflow orchestrator
  durable-agent/                       # Legacy TypeScript durable agent service
  dapr-swe/                            # Dapr SWE coding agent
  function-router/                     # Function execution router
  fn-activepieces/                     # AP piece executor
  fn-system/                           # System functions
  workflow-mcp-server/                 # Optional workflow MCP tools
  piece-mcp-server/                    # Optional AP piece MCP tools
  mcp-gateway/                         # Hosted MCP gateway
  openshell-sandbox/                   # Custom sandbox image (Chromium + Playwright)

drizzle/                               # Database migration SQL files
scripts/                               # Dev/seed/test scripts
docs/                                  # Documentation
```

## Action Routing

Actions are routed by `actionType` slug prefix. Orchestrator → function-router uses Dapr service invoke (`activities/dapr_invoke.py`); `durable/run` bypasses function-router entirely via `ctx.call_child_workflow`.

| Prefix | Service | Dispatch | Examples |
|--------|---------|----------|----------|
| `durable/run` | `agent-runtime-<slug>` (per-agent pod) | Native Dapr child workflow (`session_workflow` → `agent_workflow`). Target app-id comes from `agentRef` → `agents.runtime_app_id` → `agent-runtime-<slug>`. Falls back to legacy `dapr-agent-py` only when neither `agentAppId` nor `agentSlug` is stamped. | Every agent turn |
| `system/*` | fn-system | Dapr invoke → function-router | `system/http-request`, `system/database-query`, `system/condition` |
| `workspace/*` | openshell-agent-runtime | Dapr invoke → function-router | Workspace profile, clone, command, file, cleanup. Orchestrator also yields `persist_workspace_session` activity after `workspace/profile` with `keepAfterRun=true` to UPSERT the row into `workflow_workspace_sessions` (which powers the live-preview proxy). |
| `browser/*` | openshell-agent-runtime | Dapr invoke → function-router | Browser profile, clone, command, capture-flow, validate |
| `openshell/*` | openshell-agent-runtime | Dapr invoke → function-router | OpenShell runtime helper routes |
| `code/*` | code-runtime | Dapr invoke → function-router | Saved TS/Python code function execution |
| `*` (default) | fn-activepieces | Dapr invoke → function-router | All AP piece actions (credential decrypt + audit via credential-service) |

Rejected slugs (raise `Removed SW 1.0 agent action` at the orchestrator): `claude/run`, `openshell/run`, `openshell/session-start`, `openshell-langgraph/run`, `openshell-langgraph-observable/run`, `dapr-agent-py/run`, `dapr-swe/run`, `durable/plan`, and any `mastra/*` or `agent/*` legacy slug.

## Per-Agent Runtime Model

Every published agent gets its own pod. On publish, `src/lib/server/agents/registry-sync.ts` upserts an `AgentRuntime` CR (`agents.x-k8s.io/v1alpha1`) in the `workflow-builder` namespace; the Kopf operator at `services/agent-runtime-controller/src/main.py` reconciles one `Deployment/agent-runtime-<slug>` per CR.

**Pod shape** (built by `_build_deployment` in the controller):
- `seed-openshell-config` **init container** — writes `${XDG_CONFIG_HOME}/openshell/active_gateway` + gateway metadata + mTLS certs from the `openshell-client-tls` + `openshell-server-client-ca` Secrets so any OpenShell-backed tool the agent runs can reach its sandbox. Without this, tools like `write_file`, `bash_run`, `execute_command` fail with ENOENT on `active_gateway`.
- `dapr-agent-py` main container — runs the SDK's `session_workflow` + `agent_workflow` + optional plugins/hooks. Reads `DAPR_AGENT_PY_BOOTSTRAP_MCP_SERVERS_JSON` from the CR spec. Shares the `openshell-config` emptyDir with the init container.
- `daprd` sidecar — injected by the `openshell-sandbox-dapr-webhook` (the webhook's `namespaceSelector` matches both `openshell` and `workflow-builder`). Gets its X.509 SVID from Dapr sentry; requires the `openshell-sandbox-dapr` Configuration to exist in the pod's namespace.
- *(Optional)* `chromium` + `playwright-mcp` **browser sidecars** when the agent has a Playwright MCP preset. Controller stamps `browserSidecar.enabled=true` on the CR + attaches a per-agent `ClusterIP Service` (`agent-runtime-<slug>-mcp:3100`) so other pods can reach the browser state endpoint.

**Dispatch targets**
- Parent orchestrator → child via `ctx.call_child_workflow("session_workflow", app_id="agent-runtime-<slug>", ...)`.
- Direct UI-initiated sessions → BFF's `src/lib/server/sessions/spawn.ts` wakes the pod then invokes `/internal/sessions/spawn` via Dapr service invoke on the bare app-id.
- Both paths share the same `rewriteMcpForBrowserSidecar` helper (`src/lib/server/agents/mcp-sidecar.ts`) to rewrite Playwright stdio presets → `http://localhost:3100/mcp`.

**Scaling**
- Pod replicas default to 0. Sessions are woken on demand by writing the `agents.x-k8s.io/wake` annotation on the CR — controller scales the Deployment to 1.
- `idleTtlSeconds` (default 1800 in `_DEFAULT_IDLE_TTL`; overridable per agent via environment config's `agentRuntimeIdleTtlSeconds`) drives the `idle_reaper` timer. Scales back to 0 after the TTL elapses since `lastActiveAt`, which the BFF stamps each session dispatch.

**Dapr Component scoping inside `workflow-builder` namespace**

A Dapr sidecar refuses to start if it sees more than one Component with `actorStateStore=true`. We have three actor-capable stores in the namespace (`workflowstatestore`, `agent-workflow`, `dapr-agent-py-statestore`); scopes are partitioned so each pod sees exactly one:

| Component | `actorStateStore` | Scopes | Used by |
|---|---|---|---|
| `workflowstatestore` | true | workflow-orchestrator | Parent orchestrator history (`wfstate_*` tables) |
| `dapr-agent-py-statestore` | true | dapr-agent-py, dapr-agent-py-testing, workflow-builder, `agent-runtime-<slug>` × N | Per-agent pod actor state + BFF workflow state |
| `agent-workflow` | true | legacy openshell-durable-agent / vanilla-durable-agent (no active consumers) | n/a |

**When adding a new agent**, its slug must be appended to `dapr-agent-py-statestore.scopes` in `packages/components/active-development/manifests/dapr-agent-py/Component-dapr-agent-py-statestore.yaml`. TODO: have the controller patch this on CR create so the list stays in sync with the CR catalog automatically.

## Workflow → Session Bridge

Every `durable/run` step in SW 1.0 goes through a session bridge so workflow-driven agent runs appear in the same `/sessions/[id]` UI as direct (UI-initiated) sessions. This is a structural invariant — the old `WORKFLOW_USE_SESSIONS` feature flag was removed once the bridge stabilized.

**Flow** (`services/workflow-orchestrator/workflows/sw_workflow.py` + `services/workflow-orchestrator/activities/spawn_session.py`):

1. Orchestrator yields `spawn_session_for_workflow` activity with `bridge_payload` including `agentAppId`, `agentSlug`, `workspaceRef`, `sandboxName`, `agentConfig`, the `durable/run` body.
2. Activity HTTP-POSTs to the BFF's `/api/internal/sessions/ensure-for-workflow`. The handler:
   - Rewrites `agentConfig.mcpServers` through `rewriteMcpForBrowserSidecar` so Playwright presets target the per-pod sidecar.
   - Finds or creates the `sessions` row (keyed by deterministic `child_instance_id = <exec>__<kind>__<node>__run__<index>`).
   - Creates the ephemeral `agents` row if the workflow uses inline `agentConfig`.
   - Wakes the per-agent runtime pod via `wakeAgentRuntime(slug, 20_000)`. Non-blocking: if the pod takes longer than 20 s, the response returns anyway and Dapr retries the child-workflow schedule until placement catches up.
   - Returns `{sessionId, agentId, agentVersion, childInput, reused}`.
3. Activity returns `childInput` to the orchestrator. Orchestrator yields `ctx.call_child_workflow("session_workflow", input=childInput, instance_id=child_instance_id, app_id=target["app_id"])`.
4. `session_workflow` runs on `agent-runtime-<slug>` with `autoTerminateAfterEndTurn: true` — one turn of `agent_workflow`, emits `session.status_idle{end_turn}` + `session.status_terminated`, returns.
5. Parent resumes, final execution output persists to `workflow_executions.output`.

### Safety nets on the agent side (landed 2026-04-21)

Three defensive layers prevent a `durable/run` child from hanging indefinitely:

- **Empty-response circuit breaker** (`services/dapr-agent-py/src/main.py` `call_llm`): tracks consecutive empty-content + no-tool-calls LLM responses (or raised exceptions counted as empty) per workflow instance. After `DAPR_AGENT_PY_EMPTY_RESPONSE_THRESHOLD` (default 3), raises `AgentError` to break `agent_workflow`'s `for turn in range(max_iterations)` loop. Catches Anthropic SDK [issue #1204](https://github.com/anthropics/anthropic-sdk-python/issues/1204) (Claude Opus 4.7 + adaptive thinking + tools sometimes emits `stop_reason=end_turn` with only a thinking block + empty text + no tool_use). Resets on any response with content or tool_calls.
- **Session-turn timer** (`session_workflow` wraps `ctx.call_child_workflow` in `when_any([child, timer])`): if the child agent_workflow takes longer than `DAPR_AGENT_PY_SESSION_TURN_TIMEOUT_SECONDS` (default 600), raises a timeout `AgentError` so `session.error` + `session.status_terminated` publish. Safety net for any stuck state the circuit breaker doesn't catch (MCP hang, tool loop, deadlock).
- **Image tool_result compaction** (`services/dapr-agent-py/src/anthropic_adapter.py` `_compact_image_tool_results`): before every `generate()` call, walks the merged message list, finds user-role `tool_result` blocks that embed `type: image` content, and keeps only the last `DAPR_AGENT_PY_MAX_IMAGE_TOOL_RESULTS` (default 3) intact. Older image blocks are replaced with a short text placeholder while preserving the `tool_use_id` link. Prevents the 1M-token prompt overflow observed when a validator accumulates >3 Playwright screenshots (each ~100–500KB base64 ≈ 50k tokens).

### Workspace session persistence

Post function-router cutover (`workspace/*` routed to `openshell-agent-runtime` which is stateless w.r.t. this table; legacy `workspace-runtime` TS service's GitOps + live resources fully removed 2026-04-21), the orchestrator owns the DB write for `workflow_workspace_sessions`:

- **`persist_workspace_session` activity** (`services/workflow-orchestrator/activities/persist_workspace_session.py`): after every `workspace/profile` action completes successfully with `keepAfterRun=true`, `_handle_call_task` yields this activity to UPSERT the row (status=`active`, sandbox_state JSONB) keyed on `workspace_ref`. This is what `getExecutionSandboxPreviewInfo` reads so the live-preview proxy `/api/workflows/executions/<execId>/sandbox-preview/<previewId>/` can resolve a run's retained sandbox.
- **Cleanup gate respects spec**: `_should_cleanup_workspaces` in `sw_workflow.py` walks the SW 1.0 spec's `do[]` list for any `workspace/*` step with `with.keepAfterRun: true` (in addition to looking for `keepAfterRun` on task outputs). openshell-agent-runtime's `workspace/profile` response doesn't echo the flag back — checking only outputs missed the user's explicit intent and flipped `workflow_workspace_sessions.status` → `cleaned`, breaking the preview proxy. Fixed 2026-04-21.

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
- **workflow_executions**: `id`, `workflow_id`, `dapr_instance_id`, `status`, `output` (JSONB) — output written via status polling + `persist_results_to_db` activity
- **functions**: `id`, `slug`, `name`, `plugin_id`, `execution_type`, `is_builtin`
- **app_connections**: `id`, `externalId`, `pieceName`, `type` (OAUTH2/SECRET_TEXT/etc), `value` (encrypted JSONB)
- **piece_metadata**: `name`, `displayName`, `version`, `auth` (JSONB), `actions` (JSONB)
- **mcp_connection**: project-level MCP bindings to app connections and MCP server URLs
- **mcp_server**, **mcp_run**: hosted MCP server config and execution tracking where used
- **workflow_connection_ref**: workflow-node connection usage index
- **api_keys**: JWT API keys for programmatic access (`wfb_` prefix, SHA-256 hashed at rest; rotation keeps `id` stable). Webhook auth at `/api/workflows/[workflowId]/webhook`.
- **CMA parity resources**: all workspace-scoped via `project_id` column — `sessions`, `vaults`, `agents`, `environments`, `agent_skill_registry` (nullable for curated-global rows). Scope comes from `locals.session.projectId` which `hooks.server.ts` resolves from the `X-Workspace` header or URL slug.
- **project_members**: `(project_id, user_id, role)` with role in `ADMIN | EDITOR | OPERATOR | VIEWER`. Last-admin demote/remove is blocked in the API handler.
- **sessions**: CMA session rows. `workflow_execution_id` links workflow-driven sessions back to their parent `durable/run` node; UI sessions leave it null.
- **session_events**: append-only CMA event log. `sevt_` id prefix matches the wire format. SSE stream at `/api/v1/sessions/[id]/events/stream`.
- **files**: standalone files API (distinct from `session_resources`); SHA-1 dedup, 25 MB cap per upload. Session-output auto-upload (`/mnt/session/outputs` + `/sandbox/outputs`) scanned in `services/dapr-agent-py/src/session_outputs.py`.
- **Browser artifacts**: `workflow_browser_artifacts` (manifest JSONB), `workflow_browser_artifact_blob_payloads` (base64 PNG screenshots)
- **Observability**: `workflow_execution_logs`, `credential_access_logs`, `workflow_external_events`

## MCP Integration

Current MCP paths:

1. **Activepieces piece MCP services**: per-piece in-cluster MCP endpoints, backed by `mcp_connection.connection_external_id` and the encrypted `app_connection` credential.
2. **dapr-agent-py MCP client**: reads `durable/run.with.agentConfig.mcpServers`, connects at runtime, and exposes MCP tools beside built-in OpenShell workspace tools.
3. **mcp-gateway / workflow-mcp-server / piece-mcp-server**: retained hosted MCP surfaces and source packages for external-client or on-demand server flows.

**Playwright sidecar rewrite**: any `agentConfig.mcpServers` entry that matches Playwright (by name, URL containing `playwright-mcp`, or args containing `@playwright/mcp`) is rewritten to `{ transport: "streamable_http", url: "http://localhost:3100/mcp" }` before dispatch. The helper lives at `src/lib/server/agents/mcp-sidecar.ts` and is called from **both** session-spawn paths:
- Direct sessions: `src/lib/server/sessions/spawn.ts` rewrites `agentConfig` just before the Dapr service invoke to the target app.
- Workflow-driven sessions: `src/routes/api/internal/sessions/ensure-for-workflow/+server.ts` rewrites the inbound `agentConfig` from the orchestrator's `spawn_session_for_workflow` payload before returning `childInput`.

When a rewrite matches, the controller adds `chromium` + `playwright-mcp` sidecar containers to the pod so the rewritten URL resolves in-pod (CDP over chromium on `localhost:9222`). Without this rewrite, the stdio preset `npx @playwright/mcp@latest` would run inside the dapr-agent-py container where no Chromium binary exists.

For UI-runnable agent workflows, use SW 1.0 `durable/run` with `agentConfig.mcpServers` and `x-workflow-builder.input` prompt metadata. See `docs/mcp-agent-workflows.md`.

MCP Apps use `@modelcontextprotocol/ext-apps` for interactive UI (ToolWidget in `components/mcp-chat/tool-widget.tsx`).

## Hooks + Plugins (dapr-agent-py)

Port of Claude Code's hooks + plugins extension surface into the Python Dapr agent. Feature-flagged on both deployments via `DAPR_AGENT_PY_HOOKS_ENABLED=true` + `DAPR_AGENT_PY_PLUGINS_ENABLED=true`; plugin files ship via a `fetch-claude-plugins` init container that clones `anthropics/claude-plugins-official` into `/etc/dapr-agent-py/plugins`.

- **Events fired v1**: PreToolUse, PostToolUse, PostToolUseFailure, UserPromptSubmit, SessionStart, SessionEnd, Stop, Notification (other 18 TS events declared for manifest round-trip but not emitted)
- **Hook types v1**: `command` (subprocess JSON stdin/stdout, exit-code 2 = blocking) + `callback` (in-process Python); http/prompt/agent parsed but not executed
- **Per-run overlay**: workflow `durable/run.with.agentConfig.hooks` (inline HooksSettings) + `agentConfig.plugins` (plugin IDs) layered on the startup registry — mirrors how `mcpServers` already works
- **Durability**: PreToolUse/PostToolUse/PostToolUseFailure fire inside the durable `run_tool` activity. Session-level events fire in the workflow function gated by `not ctx.is_replaying` (same pattern as existing PLAN.md injection)

> See `docs/hooks-and-plugins.md` for events, matcher syntax, settings cascade, plugin manifest shape, and Dapr durability trade-offs.

## Activepieces Integration

- Credentials: AES-256-CBC encrypted at rest in `app_connections` table
- Auth types: `OAUTH2`, `SECRET_TEXT`, `BASIC_AUTH`, `CUSTOM_AUTH`
- Connection flow: User creates → encrypted in DB → function-router decrypts at execution time
- Adding a new piece: (1) add to `installed-pieces.ts`, (2) add npm dep to fn-activepieces, (3) add to `piece-registry.ts`, (4) rebuild

> See `docs/activepieces-auth.md` for the full auth flow.

## CMA Parity (Managed Agents Console)

The SvelteKit app mirrors platform.claude.com/dashboard surface-for-surface where it makes sense, while keeping our divergences (visual workflow editor, sandboxes, observability) alongside. Workspace scoping is the unifying invariant: every user-facing resource carries `project_id`, and `hooks.server.ts` resolves scope from the `X-Workspace` header or URL slug into `locals.session.projectId`.

- **Workspaces**: `/workspaces` manages membership; `/workspaces/[slug]/*` is the canonical path for each console surface. Non-member access 404s at the layout guard.
- **Members**: `/settings/members` — real CRUD via `/api/v1/projects/[projectId]/members`. Roles: ADMIN / EDITOR / OPERATOR / VIEWER. Last-admin demote/remove blocked.
- **Sessions**: CMA-shape event stream (`agent.message`, `agent.thinking`, `agent.tool_use`, `agent.tool_result`, `session.status_*`). Detail view shows Agent / Environment / Vaults / Workflow run / Sandbox / Observability cards. **Fork**: `POST /api/v1/sessions/[id]/fork` with `fromSequence` re-seeds a new session with replayed events up to N.
- **Custom skills**: authored by workspace members (`sourceType = "custom"` in `agent_skill_registry`, scoped via `project_id`). `POST /api/agent-skills` + `PATCH /api/agent-skills/[id]` (prompt edit bumps the numeric version). Curated/global rows remain visible to every workspace.
- **Usage + cost**: `/api/v1/usage` and `/api/v1/cost` are workspace-scoped — prefer `locals.session.projectId`, fall back to `userId` when no active project. Usage joins `agents.name` so rows show labels, not raw IDs.
- **Limits dashboard**: `/settings/limits` auto-refreshes every 15s via `/api/v1/limits/live` — active session count + per-model rolling-window throughput (sessions/hour, tokens/min/hour). No new tables; computed on-demand from `sessions.usage` + `sessions.status`.
- **Observability deep-link**: session detail → Phoenix (`/api/observability/phoenix/sessions/[id]`) + ClickHouse trace explorer (`/observability?sessionId=X`). The traces API filters by the `session.id` span attribute emitted by `src/telemetry/`.
- **Workflow → session cross-link**: workflow run Overview tab lists sessions its `durable/run` nodes spawned via `/api/workflows/executions/[executionId]/sessions`. Refreshes every 5s while agent runs are running.

Full resource map + gap rationale: `docs/cma-parity.md`.

## Browser Validation (In-Sandbox Screenshots)

The `browser/validate` action captures screenshots of a deployed feature inside the coding agent's OpenShell sandbox, eliminating the need for a second browser sandbox.

**Architecture**: coding sandbox (OpenShell) → install deps → start dev server → Playwright screenshot → persist to DB

- **Custom sandbox image**: `services/openshell-sandbox/Dockerfile` — Ubuntu 24.04 base + Chromium via Playwright at `/opt/pw-browsers`
- **Composite endpoint**: `POST /api/browser/validate` in openshell-agent-runtime — orchestrates install, dev server, readiness poll, and capture
- **Screenshot transfer**: PNGs converted to base64 files in sandbox, read in 4KB chunks via `dd` (OpenShell stdout truncates large outputs)
- **Artifact storage**: `workflow_browser_artifacts` + `workflow_browser_artifact_blob_payloads` tables
- **UI display**: Artifacts tab in run detail page, auto-expands first completed browser artifact

**Key constraints**:
- OpenShell `run_command()` stdout drops leading bytes on outputs >4KB — use chunked file reads
- Heredoc syntax doesn't work through OpenShell command API — use base64-encoded script upload
- Playwright browsers must be at `/opt/pw-browsers` (not `/root/.cache`) for sandbox user access
- `imagePullPolicy: Always` for sandbox images — Gitea registry is authoritative

## Troubleshooting

- Missing credentials → Add API keys to Azure Key Vault or create app connections
- Agent timeout → Check `kubectl logs -n workflow-builder deploy/agent-runtime-<slug>` + workflow-orchestrator logs
- Agent stops before completing plan → Check `maxTurns` setting (default: 50, configurable per-node)
- OAuth2 token expired → Auto-refresh should handle; check `AP_ENCRYPTION_KEY`
- AP credential decrypt fails → Verify `INTERNAL_API_TOKEN` matches across services
- Tool fails with `[Errno 2] No such file or directory: '/root/.config/openshell/active_gateway'` → the pod's `seed-openshell-config` init container didn't run. Verify the CR was created AFTER the `openshell-sandbox-dapr-webhook` expanded its `namespaceSelector` to include `workflow-builder` AND the controller is on an image that includes the init container; if older, re-publish the agent to rebuild its Deployment.
- daprd boot crashes `no X509 SVID available / failed to get configuration` → the `dapr.io/config`-referenced Configuration is missing in the pod's namespace. `openshell-sandbox-dapr` must exist in `workflow-builder` as well (declared at `packages/components/active-development/manifests/workflow-builder/Configuration-openshell-sandbox-dapr.yaml`).
- daprd boot crashes `detected duplicate actor state store` → a Component with `actorStateStore=true` and no restrictive scopes became visible to the pod. Partition scopes so each pod sees exactly one (see the Per-Agent Runtime Model section).
- `ctx.call_child_workflow` times out `the app may not be available` → the target pod isn't Dapr-placement-registered. Either the pod is scaled to 0 (wake annotation missing) OR it's in a different namespace than the parent (Dapr workflow sub-orchestration doesn't cross namespaces — per-agent pods MUST colocate with the orchestrator).
- Workflow logging `Ignoring unexpected taskCompleted event with ID = N` → **this is NOT a stuck signal on its own**. durabletask-worker emits this during every `call_child_workflow` replay cycle while the child runs; it's normal chatter. The real stuck-state signals are (a) `AgentRuntime` CR `phase=Sleeping` after the BFF wake annotation has been set, or (b) orchestrator emitting the same pattern for >5 min with `Orchestrator yielded with 1 task(s) and 0 event(s) outstanding` + the target app's daprd logs showing placement flaps. Misdiagnosed once on 2026-04-21 — a 10-min workflow looked "stuck" from the orchestrator's replay logs but was actually running fine.
- BFF logs `wake <slug> failed, continuing anyway: wakeAgentRuntime <slug>: timeout after 20000ms; phase=Sleeping` + `AgentRuntime` CR stays Sleeping indefinitely → the Kopf agent-runtime-controller dropped its annotation watchers (only `Timer 'idle_reaper' succeeded` lines appear; no `on_wake` handler fires on annotation change). Happens after dapr-placement-server flaps force kube-apiserver watch reconnects. Fix: `kubectl -n workflow-builder rollout restart deploy/agent-runtime-controller` — fresh Kopf init re-registers all handlers and the pending wake annotation is picked up on boot. (Seen 2026-04-21.)
- BFF `/api/workflows/[id]/execute` fails with `TypeError: fetch failed` + `ECONNREFUSED <orchestrator-svc-IP>:8080` → the orchestrator pod is CrashLoopBackOff. Check `kubectl -n workflow-builder logs deploy/workflow-orchestrator -c workflow-orchestrator --previous`. Most common cause: deployed orchestrator image predates `services/workflow-orchestrator/activities/crawl4ai.py` (commit `9935a410 fix(orchestrator): track crawl4ai activities module`) so `from activities.crawl4ai import ...` in `sw_workflow.py:50` raises `ModuleNotFoundError`. Rebuild the orchestrator image from a commit that includes the file.
- `workspace/*` or `durable/run` session lands with `project_id=NULL` → this can't happen anymore. Migration 0040 (2026-04-21) backfilled every workflow to its owner's default project and set `workflows.project_id NOT NULL`. The BFF's `POST /api/workflows` requires `locals.session.projectId` and the workflow→session bridge resolves project from the workflow. If you ever see a NULL project_id again, something's inserted outside these paths.
- Workflow-driven session rows appear in `/workspaces/[slug]/sessions` but "Agent" column shows raw IDs for some → those sessions point at workflow-ephemeral agents (tagged `workflow-ephemeral`). `/api/agents` filters ephemerals out by design (they represent sessions, not user-owned agents). As of 2026-04-21, `listSessions` LEFT JOINs `agents` and returns `agentName/agentSlug/agentAvatar/agentEphemeral` on each session so the row renders a real label (⚡ avatar + "eph" tag) without needing the agent catalog.
- Agent keeps looping with empty assistant responses / never terminates → likely Anthropic SDK [issue #1204](https://github.com/anthropics/anthropic-sdk-python/issues/1204) (Opus 4.7 + adaptive thinking + tools emits empty `end_turn`). The empty-response circuit breaker in `call_llm` should trip after 3 consecutive empties; check pod logs for `[call-llm] circuit-breaker tripped`. Tunable via `DAPR_AGENT_PY_EMPTY_RESPONSE_THRESHOLD`.
- Child session hangs forever even though no LLM traffic → session-turn timer (default 600s, env `DAPR_AGENT_PY_SESSION_TURN_TIMEOUT_SECONDS`) should fire via `when_any([child, timer])` in `session_workflow`. If it doesn't, verify the timer yield landed by searching pod logs for `Session turn N exceeded`.
- Anthropic API returns `HTTP 400 "prompt is too long: N tokens > 1000000 maximum"` → the agent accumulated too many image tool_results (each Playwright screenshot ≈ 50k tokens). Image compaction in `anthropic_adapter._compact_image_tool_results` keeps the last `DAPR_AGENT_PY_MAX_IMAGE_TOOL_RESULTS` (default 3) intact; older image blocks get replaced by a text placeholder. If you're still overflowing, lower the env var or tighten the validator prompt so fewer screenshots get taken.
- Anthropic API returns `HTTP 400 "Streaming is required for operations that may take longer than 10 minutes"` → non-streaming `messages.create()` call on a request the server estimates will exceed 10 min (typical trigger: Opus 4.7 + many tools, e.g. 41 tools + `max_tokens=16384`). Fixed 2026-04-21: `src/anthropic_adapter.py` now routes every call through `_stream_final_message(client, **kwargs)` which uses `client.messages.stream(...)` and returns the aggregated final Message (same shape as `create()`). Circuit breaker does NOT catch this pattern — the exception path in the direct-call site doesn't feed the empty-response counter, so the workflow sits in a tight non-progressing retry loop until cancelled. If you see this error in the future, check first whether a newer model variant increased the server's time estimate; second, consider lowering `DAPR_AGENT_PY_MAX_TOKENS` (default 16384) for agents that don't need long outputs.
- `dapr-agent-py` code changes need BOTH the main image AND the sandbox image rebuilt → `dapr-agent-py:git-<sha>` runs on the legacy `dapr-agent-py` + `dapr-agent-py-testing` Deployments and gets pinned by GitOps tag bump. `dapr-agent-py-sandbox:latest` is the image the per-agent runtime pods (`agent-runtime-<slug>`) use, as stamped into the AgentRuntime CR's `environment.imageTag`. Both are built from the same monorepo source, so any change under `services/dapr-agent-py/src/**` needs two PipelineRuns (`dapr-agent-py-image-build` + `dapr-agent-py-sandbox-image-build`). Sandbox uses `:latest` with `imagePullPolicy: Always`, so scaling a per-agent pod to 0 and back to 1 picks up the new digest without a GitOps tag bump.
- Live-preview URL returns 404 "Retained sandbox not found for this execution" → `workflow_workspace_sessions` row is missing or `status='cleaned'`. Check (a) the `persist_workspace_session` activity fired (search orchestrator logs), (b) the SW 1.0 spec's workspace step has `with.keepAfterRun: true`, and (c) `_should_cleanup_workspaces` honoured it (see Workspace session persistence section above). Manually reviving a row: `UPDATE workflow_workspace_sessions SET status='active' WHERE workflow_execution_id=<id>`.
- Trigger value like `${ .trigger.animationDescription }` reaches the agent as a literal string → SW 1.0 jq-template evaluation only fires when the ENTIRE value is a single `${...}` expression (see `core/sw_expressions.py::is_expression_string`). Embedded `${...}` mid-string passes through as literal text. Fix by wrapping the whole value in one jq expression that concatenates the dynamic piece: `"${ .trigger.animationDescription + \" — rest of prompt...\" }"`.
- SvelteKit type errors → Run `pnpm check` (svelte-check)

> See Dapr component YAMLs in the stacks repo for service scoping and env var configuration.

---

**Last Updated**: 2026-04-21
**Status**: Production-ready SvelteKit app with CMA (Claude Managed Agents) console parity — workspace-scoped sessions / agents / environments / vaults / skills / files, real members management, live limits dashboard, session fork + observability deep-links, OpenTelemetry observability (OTEL Collector + ClickHouse + Phoenix), OpenShell sandbox execution, per-agent runtime pods (`agent-runtime-<slug>` in `workflow-builder` ns, reconciled from `AgentRuntime` CRs by the Kopf controller) running `dapr-agent-py` (dapr-agents 1.0.1) durable agent runs (native Dapr child workflow dispatch + `WorkflowRetryPolicy` callee-side retry) with Claude Code-compatible hooks + plugins subsystem, workflow↔session bridge as a structural invariant (`session_workflow` wraps every `durable/run`), MCP sidecar rewrite for Playwright presets (both direct + workflow session paths), OpenShell gateway mTLS bootstrap seeded via init container on every per-agent pod, optional per-agent browser sidecars (chromium + playwright-mcp over CDP + per-agent ClusterIP Service), `CallAgent` peer delegation via SDK-native `WorkflowContextInjectedTool` (peer answer returns as `tool_result` in the same LLM turn, full Dapr durability), function-router narrowed to sync credential broker + Knative proxy (`workspace/* + browser/* + openshell/*` consolidated on openshell-agent-runtime; ConfigMap authoritative over built-in fallback registry), orchestrator-side `persist_workspace_session` activity + `with.keepAfterRun` cleanup gate powering the live-preview proxy, and three defensive layers on the agent (empty-response circuit breaker after N consecutive empties, 600s session-turn timer via `when_any([child, timer])`, image tool_result compaction keeping the last 3 screenshots in-context), Anthropic LLM calls routed through `client.messages.stream()` to clear the server's 10-minute non-streaming threshold (`_stream_final_message` helper in `anthropic_adapter.py`).

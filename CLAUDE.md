# Workflow Builder

Visual workflow builder with Dapr workflow orchestration, durable AI agents, and MCP server integration. The SvelteKit app serves as a UI + BFF proxy layer; all workflow execution lives in Dapr on Kubernetes.

> **Supplementary docs**: See `docs/` for detailed references:
> - `docs/activepieces-auth.md` — AP auth/connection system details
> - `docs/activepieces-integration-implementation.md` — AP integration implementation
> - `docs/mcp-agent-workflows.md` - MCP-enabled `dapr-agent-py` workflow method
> - `docs/hooks-and-plugins.md` — `dapr-agent-py` hooks + plugins subsystem (Claude Code port)
> - `docs/CLICKHOUSE_OBSERVABILITY.md` — ClickHouse observability stack
> - `docs/openshell-capabilities.md` — OpenShell sandbox capabilities

## Architecture

```
┌───────────────────────────────────────────────────────────────────────────┐
│                          Kubernetes Cluster                                │
│                                                                            │
│  ┌─────────────────┐    ┌──────────────────────────────────────────────┐  │
│  │  SvelteKit App  │    │  workflow-orchestrator (Python/Dapr)         │  │
│  │  (Dapr sidecar) │───▶│  - SW 1.0 interpreter, topological execution │  │
│  │  Port 3000      │    │  - durable/run → ctx.call_child_workflow     │  │
│  └─────────────────┘    │  - other slugs → Dapr invoke → function-router│ │
│                         └──────┬────────────────────────┬───────────────┘  │
│                                │ Dapr child workflow    │ Dapr svc invoke  │
│                                ▼                        ▼                  │
│                    ┌─────────────────────┐  ┌──────────────────────────┐  │
│                    │  dapr-agent-py      │  │  function-router         │  │
│                    │  (@workflow_entry   │  │  - slug → service route  │  │
│                    │   agent_workflow +  │  │  - credential broker     │  │
│                    │   WorkflowRetryPolicy)│  │  - Knative response norm │  │
│                    └─────────────────────┘  └──────────┬───────────────┘  │
│                                             ┌──────────┼───────────────┐  │
│                                             ▼          ▼               ▼  │
│                                ┌──────────────┐ ┌────────────┐ ┌────────┐ │
│                                │ openshell-   │ │ fn-active- │ │fn-sys  │ │
│                                │ agent-runtime│ │ pieces     │ │tem     │ │
│                                │ workspace-   │ │ code-      │ │        │ │
│                                │ runtime      │ │ runtime    │ │        │ │
│                                └──────────────┘ └────────────┘ └────────┘ │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐                     │
│  │ workflow-mcp │  │ piece-mcp-   │  │ mcp-gateway  │                     │
│  │ -server      │  │ server       │  │ (hosted MCP) │                     │
│  └──────────────┘  └──────────────┘  └──────────────┘                     │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐                     │
│  │    Redis     │  │  PostgreSQL  │  │ OTEL Collector│                    │
│  └──────────────┘  └──────────────┘  └──────────────┘                     │
└───────────────────────────────────────────────────────────────────────────┘
```

**Key dispatch invariants**
- `durable/run` is a **Dapr child workflow**, not an HTTP call. The orchestrator calls `ctx.call_child_workflow("agent_workflow", app_id="dapr-agent-py", ...)`; retry resilience comes from `WorkflowRetryPolicy(max_attempts=8)` on the callee side.
- Every other action goes `orchestrator → Dapr service invoke → function-router → {fn-system | fn-activepieces | workspace-runtime | openshell-agent-runtime | code-runtime}`. The orchestrator uses `activities/dapr_invoke.py` (no raw HTTP).
- function-router owns credential decryption (AES-256-CBC from `app_connection`) + `credential_access_logs` audit. Orchestrator never holds plaintext secrets.

## Tech Stack

- **Frontend**: SvelteKit 5, Svelte 5, Svelte Flow (@xyflow/svelte), shadcn-svelte
- **Backend**: SvelteKit API routes (BFF proxy to Dapr orchestrator)
- **Database**: PostgreSQL via Drizzle ORM
- **Auth**: GitHub/Google OAuth2, JWT API keys (RS256)
- **Workflow Engine**: Dapr Workflow SDK (Python) via workflow-orchestrator
- **Durable AI Agent**: dapr-agent-py - native Python Dapr runtime for `durable/run`
- **Function Execution**: function-router (Dapr invoke) → fn-system, fn-activepieces, workspace-runtime, openshell-agent-runtime, code-runtime
- **Durable Agent Dispatch**: orchestrator → `ctx.call_child_workflow` → dapr-agent-py (native; bypasses function-router)
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
| **dapr-agent-py** | n/a | Primary `durable/run` agent runtime with MCP client support |
| **function-router** | 8080 | Sync credential broker + Knative proxy. Receives Dapr invoke from orchestrator, decrypts credentials, routes to fn-system / fn-activepieces / workspace-runtime / openshell-agent-runtime / code-runtime. Does **not** route `durable/run` or any `dapr-agent-py/*` slug. |
| **fn-system** | 8080 | System actions: http-request, database-query, condition |
| **mcp-gateway** | 8080 | Hosted MCP endpoint for external AI clients |
| **fn-activepieces** | 8080 | AP executor for default-routed piece actions in the current cluster runtime |
| **workflow-mcp-server** | 3200 | Retained MCP server, not part of the current core local runtime |
| **piece-mcp-server** | dynamic | Retained MCP server, provisioned on demand |
| **openshell-sandbox** | — | Custom OpenShell sandbox image with Chromium/Playwright for browser validation |

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
| `durable/run` | dapr-agent-py | Native Dapr child workflow | Embedded agent execution (OpenShell-backed) |
| `system/*` | fn-system | Dapr invoke → function-router | `system/http-request`, `system/database-query`, `system/condition` |
| `workspace/*` | workspace-runtime | Dapr invoke → function-router | Workspace profile, clone, command, file, cleanup |
| `browser/*` | openshell-agent-runtime | Dapr invoke → function-router | Browser profile, clone, command, capture-flow, validate |
| `openshell/*` | openshell-agent-runtime | Dapr invoke → function-router | OpenShell runtime helper routes |
| `code/*` | code-runtime | Dapr invoke → function-router | Saved TS/Python code function execution |
| `*` (default) | fn-activepieces | Dapr invoke → function-router | All AP piece actions (credential decrypt + audit via credential-service) |

Rejected slugs (raise `Removed SW 1.0 agent action` at the orchestrator): `claude/run`, `openshell/run`, `openshell/session-start`, `openshell-langgraph/run`, `openshell-langgraph-observable/run`, `dapr-agent-py/run`, `dapr-swe/run`, `durable/plan`, and any `mastra/*` or `agent/*` legacy slug.

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
- **api_keys**: JWT API keys for programmatic access
- **Browser artifacts**: `workflow_browser_artifacts` (manifest JSONB), `workflow_browser_artifact_blob_payloads` (base64 PNG screenshots)
- **Observability**: `workflow_execution_logs`, `credential_access_logs`, `workflow_external_events`

## MCP Integration

Current MCP paths:

1. **Activepieces piece MCP services**: per-piece in-cluster MCP endpoints, backed by `mcp_connection.connection_external_id` and the encrypted `app_connection` credential.
2. **dapr-agent-py MCP client**: reads `durable/run.with.agentConfig.mcpServers`, connects at runtime, and exposes MCP tools beside built-in OpenShell workspace tools.
3. **mcp-gateway / workflow-mcp-server / piece-mcp-server**: retained hosted MCP surfaces and source packages for external-client or on-demand server flows.

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
- Agent timeout -> Check `dapr-agent-py` and `workflow-orchestrator` logs
- Agent stops before completing plan → Check `maxTurns` setting (default: 50, configurable per-node)
- OAuth2 token expired → Auto-refresh should handle; check `AP_ENCRYPTION_KEY`
- AP credential decrypt fails → Verify `INTERNAL_API_TOKEN` matches across services
- Dapr pub/sub scoping -> agent runtimes and orchestrator may use different scoped components; verify the live Dapr component YAML in `stacks/main`
- SvelteKit type errors → Run `pnpm check` (svelte-check)

> See Dapr component YAMLs in the stacks repo for service scoping and env var configuration.

---

**Last Updated**: 2026-04-16
**Status**: Production-ready SvelteKit app with OpenTelemetry observability, OpenShell sandbox execution, `dapr-agent-py` durable agent runs (native Dapr child workflow dispatch + `WorkflowRetryPolicy` callee-side retry) with Claude Code-compatible hooks + plugins subsystem, MCP-enabled agent workflows, and function-router narrowed to sync credential broker + Knative proxy.

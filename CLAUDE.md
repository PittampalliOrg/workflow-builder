# Workflow Builder

Visual workflow builder with Dapr workflow orchestration, durable AI agents, and MCP server integration. The SvelteKit app serves as a UI + BFF proxy layer; all workflow execution lives in Dapr on Kubernetes.

> **Supplementary docs**: See `docs/` for detailed references:
> - `docs/activepieces-auth.md` — AP auth/connection system details
> - `docs/activepieces-integration-implementation.md` — AP integration implementation
> - `docs/CLICKHOUSE_OBSERVABILITY.md` — ClickHouse observability stack
> - `docs/openshell-capabilities.md` — OpenShell sandbox capabilities

## Architecture

```
┌──────────────────────────────────────────────────────────────────────────┐
│                          Kubernetes Cluster                               │
│                                                                           │
│  ┌─────────────────┐    ┌──────────────────────────────────────────────┐ │
│  │  SvelteKit App  │    │  workflow-orchestrator (Python/Dapr)         │ │
│  │  (Dapr sidecar) │───▶│  - Dynamic workflow interpreter              │ │
│  │  Port 3000      │    │  - Topological node execution                │ │
│  └─────────────────┘    │  - Routes to agents & function services     │ │
│         │               └──────────┬──────────────┬───────────────────┘ │
│         │                          │              │                      │
│  OAuth2 PKCE +          Dapr svc invoke    Dapr svc invoke              │
│  App Connections                   │              │                      │
│         │               ┌─────────▼──┐    ┌──────▼──────────────┐      │
│         │               │ function-  │    │  durable-agent       │      │
│         │               │ router     │    │  (Dapr Workflow       │      │
│         │               │ (registry) │    │   ReAct loop)        │      │
│         │               └─────┬──────┘    └─────────────────────┘      │
│         │          ┌──────────┼────────────────┐                       │
│         │          ▼          ▼                ▼                        │
│  ┌──────────────┐  ┌────────────┐  ┌──────────────┐                   │
│  │ openshell-   │  │ fn-active  │  │  fn-system    │                   │
│  │ agent-runtime│  │ -pieces    │  │  (http-req,   │                   │
│  │ (sandbox I/O)│  │ (42 AP     │  │   db-query,   │                   │
│  └──────────────┘  │  pieces)   │  │   condition)  │                   │
│                    └────────────┘  └──────────────┘                   │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐                  │
│  │ workflow-mcp │  │ piece-mcp-   │  │ mcp-gateway  │                  │
│  │ -server      │  │ server       │  │ (hosted MCP) │                  │
│  └──────────────┘  └──────────────┘  └──────────────┘                  │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐                  │
│  │    Redis     │  │  PostgreSQL  │  │ OTEL Collector│                  │
│  └──────────────┘  └──────────────┘  └──────────────┘                  │
└──────────────────────────────────────────────────────────────────────────┘
```

## Tech Stack

- **Frontend**: SvelteKit 5, Svelte 5, Svelte Flow (@xyflow/svelte), shadcn-svelte
- **Backend**: SvelteKit API routes (BFF proxy to Dapr orchestrator)
- **Database**: PostgreSQL via Drizzle ORM
- **Auth**: GitHub/Google OAuth2, JWT API keys (RS256)
- **Workflow Engine**: Dapr Workflow SDK (Python) via workflow-orchestrator
- **Durable AI Agent**: durable-agent (Dapr Workflow ReAct loop, AI SDK 6, @ai-sdk/openai) — primary agent service
- **Function Execution**: function-router → fn-system, fn-activepieces, openshell-agent-runtime, durable-agent
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
| **durable-agent** | 8001 | Primary AI agent — Dapr Workflow ReAct loop, AI SDK 6 |
| **function-router** | 8080 | Routes actions to fn-system/fn-activepieces/durable-agent |
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
  durable-agent/                       # Durable AI agent (PRIMARY)
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

Actions are routed by `actionType` slug prefix:

| Prefix | Service | Sync/Async | Examples |
|--------|---------|------------|----------|
| `system/*` | fn-system (via function-router) | Sync | `system/http-request`, `system/database-query`, `system/condition` |
| `mastra/clone` | durable-agent (via function-router) | Sync | Clone a git repo |
| `mastra/plan` | durable-agent (via function-router) | Sync | Generate execution plan |
| `mastra/execute` | durable-agent (direct) | Async | Execute a plan (fire-and-forget) |
| `agent/*` | durable-agent (direct) | Async | Agent run with prompt |
| `durable/*` | durable-agent (direct) | Async | Durable agent run with prompt |
| `workspace/*` | openshell-agent-runtime (via function-router) | Sync | Workspace profile, clone, command, file, cleanup |
| `browser/*` | openshell-agent-runtime (via function-router) | Sync | Browser profile, clone, command, capture-flow, validate |
| `durable/run` | durable-agent (native child workflow) | Async | Standard OpenShell-backed durable coding run |
| `openshell/session-start` | openshell-agent-runtime (via function-router) | Async | Start a retained Claude session in an OpenShell sandbox |
| `openshell-langgraph-observable/run` | openshell-langgraph-observable (Dapr child workflow) | Async | OpenShell LangGraph plan/execute with sandbox |
| `*` (default) | fn-activepieces (via function-router) | Sync | All AP piece actions |

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
- **mcp_servers**, **mcp_runs**: MCP server config and execution tracking
- **api_keys**: JWT API keys for programmatic access
- **Browser artifacts**: `workflow_browser_artifacts` (manifest JSONB), `workflow_browser_artifact_blob_payloads` (base64 PNG screenshots)
- **Observability**: `workflow_execution_logs`, `credential_access_logs`, `workflow_external_events`

## MCP Integration

Three MCP server types:
1. **mcp-gateway**: Hosted MCP endpoint for external AI clients
2. **workflow-mcp-server**: Optional workflow MCP tool server retained in source
3. **piece-mcp-server**: Optional AP piece MCP server retained in source

MCP Apps use `@modelcontextprotocol/ext-apps` for interactive UI (ToolWidget in `components/mcp-chat/tool-widget.tsx`).

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
- Agent timeout → Check durable-agent logs (`kubectl logs -l app=durable-agent`)
- Agent stops before completing plan → Check `maxTurns` setting (default: 50, configurable per-node)
- OAuth2 token expired → Auto-refresh should handle; check `AP_ENCRYPTION_KEY`
- AP credential decrypt fails → Verify `INTERNAL_API_TOKEN` matches across services
- Dapr pub/sub scoping → durable-agent uses `durable-pubsub` (NATS); orchestrator uses `pubsub` (Redis) — isolated
- SvelteKit type errors → Run `pnpm check` (svelte-check)

> See Dapr component YAMLs in the stacks repo for service scoping and env var configuration.

---

**Last Updated**: 2026-04-03
**Status**: Production-ready SvelteKit app with OpenTelemetry observability, sandbox execution, and hosted MCP servers

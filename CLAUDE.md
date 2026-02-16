# Workflow Builder

Visual workflow builder with Dapr workflow orchestration, durable AI agents, and MCP server integration. The Next.js app serves as a UI + BFF proxy layer; all workflow execution lives in Dapr on Kubernetes.

> **Supplementary docs**: See `docs/` for detailed references:
> - `docs/services.md` — Full service descriptions, endpoints, and build commands
> - `docs/deployment.md` — Kind cluster, Docker builds, Dapr integration, env vars, DevSpace
> - `docs/migration-history.md` — Completed migration notes
> - `docs/architecture.md` — Extended architecture overview
> - `docs/activepieces-auth.md` — AP auth/connection system details
> - `docs/activepieces-integration-implementation.md` — AP integration implementation
> - `docs/quick-start.md` — Getting started guide

## Architecture

```
┌──────────────────────────────────────────────────────────────────────────┐
│                          Kubernetes Cluster                               │
│                                                                           │
│  ┌─────────────────┐    ┌──────────────────────────────────────────────┐ │
│  │  Next.js App    │    │  workflow-orchestrator (Python/Dapr)         │ │
│  │  (no sidecar)   │───▶│  - Dynamic workflow interpreter              │ │
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
│  │ mastra-agent │  │ fn-active  │  │  fn-system    │                   │
│  │ -tanstack    │  │ -pieces    │  │  (http-req,   │                   │
│  │ (secondary)  │  │ (42 AP     │  │   db-query,   │                   │
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

- **Frontend**: Next.js 16, React 19, React Flow (@xyflow/react), Jotai, shadcn/ui
- **Backend**: Next.js API routes (BFF proxy to Dapr orchestrator)
- **Database**: PostgreSQL via Drizzle ORM
- **Auth**: Better Auth (email/password, social login, JWT API keys)
- **Workflow Engine**: Dapr Workflow SDK (Python) via workflow-orchestrator
- **Durable AI Agent**: durable-agent (Dapr Workflow ReAct loop, AI SDK 6, @ai-sdk/openai) — primary agent service
- **Mastra Agent** (legacy/secondary): mastra-agent-tanstack — still deployed for MCP/monitoring
- **Function Execution**: function-router → fn-system, fn-activepieces, durable-agent
- **MCP**: workflow-mcp-server, piece-mcp-server, mcp-gateway
- **Activepieces**: 42 AP piece packages, OAuth2 PKCE, encrypted app connections
- **Observability**: OpenTelemetry → OTEL Collector → Jaeger
- **Deployment**: Docker, Kind cluster, ingress-nginx

## Key Commands

```bash
pnpm dev              # Start dev server
pnpm build            # Production build (runs discover-plugins first)
pnpm db:generate      # Generate Drizzle migrations
pnpm db:push          # Push schema to DB
pnpm db:migrate       # Run migrations (safe wrapper)
pnpm discover-plugins # Generate plugin manifest
pnpm seed-functions   # Seed builtin functions to DB
pnpm sync:activepieces-pieces  # Fetch AP piece metadata from cloud API → DB
pnpm sync-oauth-apps  # Sync OAuth app configs
pnpm test:e2e         # Run Playwright E2E tests
```

## Services Overview

| Service | Port | Role |
|---------|------|------|
| **workflow-orchestrator** | 8080 | Python Dapr workflow engine, topological node execution |
| **durable-agent** | 8001 | Primary AI agent — Dapr Workflow ReAct loop, AI SDK 6 |
| **mastra-agent-tanstack** | 3000 | Secondary agent — Mastra SDK, MCP endpoint, monitoring UI |
| **mastra-agent-mcp** | 3300 | Mastra agent as pure MCP server |
| **function-router** | 8080 | Routes actions to fn-system/fn-activepieces/durable-agent |
| **fn-system** | 8080 | System actions: http-request, database-query, condition |
| **fn-activepieces** | 8080 | Executes AP piece actions (default fallback) |
| **workflow-mcp-server** | 3200 | Workflow CRUD MCP tools + React Flow UI |
| **piece-mcp-server** | dynamic | AP piece MCP tools + MCP Apps UI |
| **mcp-gateway** | 8080 | Hosted MCP endpoint for external AI clients |
| **node-sandbox** | 8888 | HTTP runtime sandbox |

> See `docs/services.md` for full endpoint details and build commands.

## Project Structure

```
app/
  api/
    workflow/[workflowId]/execute/   # Session-auth execution
    orchestrator/workflows/          # Proxy to workflow-orchestrator
    dapr/workflows/[id]/             # Status polling + SSE events
    app-connections/                  # CRUD + OAuth2 PKCE
    internal/connections/             # Service-to-service decrypt
    internal/mcp/                    # MCP gateway internal endpoints
    v1/auth/                         # JWT auth API
    mcp-chat/                        # MCP Chat API
    pieces/                          # AP piece metadata + actions + options
    ai/generate/                     # AI generation endpoint
  workflows/[workflowId]/page.tsx    # Workflow editor
  connections/page.tsx               # Connections management
  mcp-chat/page.tsx                  # MCP Chat
  mcp-apps/page.tsx                  # MCP Apps

lib/
  api-client.ts                      # Client-side API client
  workflow-store.ts                  # Jotai atoms, node/edge types
  workflow-definition.ts             # Workflow serialization
  dapr-activity-registry.ts         # Dapr workflow primitives
  dapr-client.ts                    # Dapr orchestrator API client
  auth-service.ts                   # Better Auth + JWT API keys
  workflow-spec/                    # WorkflowSpec v1 JSON import/export/lint
    system-actions.ts               # System action definitions
  ai/                               # AI workflow generation
  db/schema.ts                      # Drizzle ORM schema
  db/app-connections.ts             # App connection encrypt/decrypt
  security/encryption.ts            # AES-256-CBC encryption
  app-connections/oauth2.ts         # OAuth2 PKCE flow
  activepieces/installed-pieces.ts  # Installed AP pieces (single source of truth)
  activepieces/action-adapter.ts    # AP props → WB field converter
  actions/builtin-pieces.ts         # Builtin piece definitions (agent, mastra, durable, mcp)
  actions/pieces-store.ts           # Client-side pieces catalog (Jotai)

services/
  workflow-orchestrator/             # Python Dapr workflow orchestrator
  durable-agent/                     # Durable AI agent (PRIMARY)
  mastra-agent-tanstack/             # Mastra AI agent (SECONDARY)
  mastra-agent-mcp/                  # Mastra agent MCP server
  function-router/                   # Function execution router
  fn-activepieces/                   # AP piece executor
  fn-system/                         # System functions
  workflow-mcp-server/               # Workflow MCP tools
  piece-mcp-server/                  # AP piece MCP tools
  mcp-gateway/                       # Hosted MCP gateway

components/workflow/
  workflow-canvas.tsx                # React Flow canvas
  node-config-panel.tsx             # Properties/Code/Runs tabs
  config/action-config.tsx          # Action node configuration
  config/action-grid.tsx            # Action palette (plugins + AP pieces)
  config/action-config-renderer.tsx # Dynamic config field renderer

plugins/                             # Plugin registry (auto-discovered)
  registry.ts                        # Registration and discovery
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

## Plugin Registry

```bash
pnpm discover-plugins  # Generates plugins/index.ts
pnpm seed-functions    # Seeds functions table from plugins
```

**Current plugins**: `mastra-agent`, `durable-agent`, `mcp`, `slack`, `github`, `resend`, `linear`, `firecrawl`, `perplexity`, `stripe`, `fal`, `blob`, `v0`, `clerk`, `webflow`, `superagent`

## Database Schema (Key Tables)

- **workflows**: `id`, `name`, `nodes` (JSONB), `edges` (JSONB), `engine_type`, MCP trigger config
- **workflow_executions**: `id`, `workflow_id`, `dapr_instance_id`, `status`, `output` (JSONB) — output written via status polling + `persist_results_to_db` activity
- **functions**: `id`, `slug`, `name`, `plugin_id`, `execution_type`, `is_builtin`
- **app_connections**: `id`, `externalId`, `pieceName`, `type` (OAUTH2/SECRET_TEXT/etc), `value` (encrypted JSONB)
- **piece_metadata**: `name`, `displayName`, `version`, `auth` (JSONB), `actions` (JSONB)
- **mcp_servers**, **mcp_runs**: MCP server config and execution tracking
- **api_keys**: JWT API keys for programmatic access
- **Observability**: `workflow_execution_logs`, `credential_access_logs`, `workflow_external_events`

## MCP Integration

Three MCP server types:
1. **workflow-mcp-server** (Port 3200): Workflow CRUD + node manipulation tools
2. **piece-mcp-server**: AP piece actions as MCP tools
3. **mcp-gateway**: Hosted MCP endpoint for external AI clients

MCP Apps use `@modelcontextprotocol/ext-apps` for interactive UI (ToolWidget in `components/mcp-chat/tool-widget.tsx`).

## Activepieces Integration

- Credentials: AES-256-CBC encrypted at rest in `app_connections` table
- Auth types: `OAUTH2`, `SECRET_TEXT`, `BASIC_AUTH`, `CUSTOM_AUTH`
- Connection flow: User creates → encrypted in DB → function-router decrypts at execution time
- Adding a new piece: (1) add to `installed-pieces.ts`, (2) add npm dep to fn-activepieces, (3) add to `piece-registry.ts`, (4) rebuild

> See `docs/activepieces-auth.md` for full auth flow details.

## Troubleshooting

- Missing `actionType` in node config → UI bug, recreate node
- Function not found → Check `functions` table, run `pnpm seed-functions`
- Missing credentials → Add API keys to Azure Key Vault or create app connections
- Agent timeout → Check durable-agent logs (`kubectl logs -l app=durable-agent`)
- Agent stops before completing plan → Check `maxTurns` setting (default: 50, configurable per-node)
- AP piece not showing → Check `lib/activepieces/installed-pieces.ts`, re-sync piece metadata
- OAuth2 token expired → Auto-refresh should handle; check `AP_ENCRYPTION_KEY`
- AP credential decrypt fails → Verify `INTERNAL_API_TOKEN` matches across services
- Dapr pub/sub scoping → durable-agent uses `durable-pubsub` (NATS); orchestrator uses `pubsub` (Redis) — isolated. Completion events use direct service invocation.
- Workflow output lost on navigation → Verify both persistence paths: status polling + `persist_results_to_db`

> See `docs/deployment.md` for service logs, env vars, Docker builds, and Dapr component scoping.

---

**Last Updated**: 2026-02-16
**Status**: Production-ready with OpenTelemetry observability, sandbox execution, MCP Apps, and hosted MCP servers

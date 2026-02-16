# Workflow Builder

Visual workflow builder with Dapr workflow orchestration, durable AI agents, and MCP server integration. The Next.js app serves as a UI + BFF proxy layer; all workflow execution lives in Dapr on Kubernetes.

## Architecture

```
┌──────────────────────────────────────────────────────────────────────────┐
│                          Kubernetes Cluster                               │
│                                                                           │
│  ┌─────────────────┐    ┌──────────────────────────────────────────────┐ │
│  │  Next.js App    │    │  workflow-orchestrator (Python/Dapr)         │ │
│  │  (no sidecar)   │───▶│  - Dynamic workflow interpreter              │ │
│  │                 │    │  - Topological node execution                │ │
│  │  Port 3000      │    │  - Approval gates, timers, pub/sub          │ │
│  └─────────────────┘    │  - Routes to agents & function services     │ │
│         │               │  - AP flow walker (linked-list execution)    │ │
│         │               └──────────┬──────────────┬───────────────────┘ │
│         │                          │              │                      │
│  OAuth2 PKCE +          Dapr svc invoke    Dapr svc invoke              │
│  App Connections                   │              │                      │
│         │               ┌─────────▼──┐    ┌──────▼──────────────┐      │
│         │               │ function-  │    │  durable-agent       │      │
│         │               │ router     │    │  (Dapr Workflow      │      │
│         │               │ (registry) │    │   ReAct loop, AI     │      │
│         │               └─────┬──────┘    │   SDK 6, sandbox)    │      │
│         │                     │           └─────────────────────┘      │
│         │          ┌──────────┼────────────────┐                       │
│         │          │          │                │                        │
│         │          ▼          ▼                ▼                        │
│  ┌──────────────┐  ┌────────────┐  ┌──────────────┐                   │
│  │ mastra-agent │  │ fn-active  │  │  fn-system    │                   │
│  │ -tanstack    │  │ -pieces    │  │  (http-req,   │                   │
│  │ (Mastra AI)  │  │ (42 AP    │  │   db-query,   │                   │
│  │              │  │  pieces)   │  │   condition)  │                   │
│  └──────────────┘  └────────────┘  └──────────────┘                   │
│                                                                         │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐                  │
│  │ workflow-mcp │  │ piece-mcp-   │  │ mcp-gateway  │                  │
│  │ -server      │  │ server       │  │ (hosted MCP) │                  │
│  │ (13 tools)   │  │ (AP pieces)  │  │              │                  │
│  └──────────────┘  └──────────────┘  └──────────────┘                  │
│                                                                         │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐                  │
│  │    Redis     │  │  PostgreSQL  │  │ OTEL Collector│                  │
│  │  (Dapr state)│  │  (workflows, │  │  (Jaeger,     │                  │
│  │              │  │   functions,  │  │   traces)     │                  │
│  │              │  │   app_conns)  │  │              │                  │
│  └──────────────┘  └──────────────┘  └──────────────┘                  │
└──────────────────────────────────────────────────────────────────────────┘
```

The Next.js app makes direct HTTP calls to the orchestrator service. No Dapr sidecar is needed on the Next.js side.

## Tech Stack

- **Frontend**: Next.js 16, React 19, React Flow (@xyflow/react), Jotai state management, shadcn/ui
- **Backend**: Next.js API routes (BFF proxy to Dapr orchestrator)
- **Database**: PostgreSQL via Drizzle ORM
- **Auth**: Better Auth (email/password, social login via GitHub/Google, JWT API keys)
- **Workflow Engine**: Dapr Workflow SDK (Python) via workflow-orchestrator
- **Durable AI Agent**: durable-agent (Dapr Workflow-backed ReAct loop, AI SDK 6, @ai-sdk/openai) — primary agent service for all agent/*, durable/*, and mastra/execute actions
- **Mastra Agent** (legacy): mastra-agent-tanstack (Mastra SDK, TanStack Start) — still deployed for MCP/monitoring, no longer primary for agent routing
- **Function Execution**: function-router → fn-system, fn-activepieces, durable-agent (registry-based)
- **MCP Integration**: workflow-mcp-server (workflow tools), piece-mcp-server (AP piece tools), mcp-gateway (hosted MCP)
- **Activepieces Integration**: 42 AP piece packages via piece-mcp-server + fn-activepieces, OAuth2 PKCE, encrypted app connections
- **Observability**: OpenTelemetry across all services → OTEL Collector → Jaeger
- **Deployment**: Docker (multi-stage), Kind cluster, ingress-nginx

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

## Project Structure

```
app/
  api/
    workflow/[workflowId]/
      execute/route.ts             # Session-auth execution
    orchestrator/workflows/        # Proxy to workflow-orchestrator
      route.ts                     # Start workflow
      [id]/status/route.ts         # Get workflow status
      [id]/events/route.ts         # Raise external event
    dapr/workflows/                # Dapr workflow status + events
      [id]/status/route.ts         # Poll orchestrator status (writes output to DB on terminal)
      [id]/events/route.ts         # SSE event stream
    app-connections/               # App connection CRUD + OAuth2
      route.ts                     # List/create connections
      [connectionId]/route.ts      # Get/update/delete connection
      oauth2/start/route.ts        # Start OAuth2 PKCE flow
      oauth2/callback/route.ts     # OAuth2 callback handler
    internal/
      connections/[externalId]/
        decrypt/route.ts           # Internal credential decrypt (service-to-service)
      mcp/                         # Internal MCP gateway endpoints
        projects/[projectId]/
          server/route.ts          # Get MCP server config
          tools/[workflowId]/execute/route.ts  # Execute MCP tool
        runs/[runId]/route.ts      # Get MCP run status
        runs/[runId]/respond/route.ts  # Respond to MCP run
    v1/
      auth/                        # JWT auth API (sign-in, sign-up, social, refresh)
      projects/[projectId]/
        mcp-server/route.ts        # Hosted MCP server management
    mcp-chat/                      # MCP Chat API
      route.ts                     # Chat endpoint
      servers/discover/route.ts    # Discover MCP servers
      servers/provision/route.ts   # Provision MCP server
      tools/call/route.ts          # Proxy tool calls to MCP servers
    mcp-apps/route.ts              # MCP Apps endpoint
    pieces/                        # Activepieces piece metadata
      route.ts                     # List all pieces
      [pieceName]/route.ts         # Get piece details
      actions/route.ts             # List actions from installed pieces
      options/route.ts             # Dynamic dropdown option resolution
    api-keys/route.ts              # API key management
    oauth-apps/route.ts            # OAuth app configuration
    monitor/route.ts               # Workflow execution monitoring
    ai/generate/route.ts           # AI generation endpoint
  workflows/[workflowId]/page.tsx  # Workflow editor page
  connections/page.tsx             # Connections management page
  mcp-chat/page.tsx                # MCP Chat page
  mcp-apps/page.tsx                # MCP Apps page
  functions/page.tsx               # Functions management page
  monitor/page.tsx                 # Execution monitor page
  settings/page.tsx                # Settings page

lib/
  api-client.ts                    # Client-side API client (api.workflow.*, api.piece.*, etc.)
  workflow-store.ts                # Jotai atoms, node/edge types
  workflow-definition.ts           # Workflow serialization (serializeNode, serializeWorkflow)
  dapr-activity-registry.ts        # Dapr workflow primitives (approval gates, timers)
  dapr-client.ts                   # Dapr orchestrator API client (generic)
  auth-service.ts                  # Auth service (Better Auth + JWT API keys)
  auth-client.ts                   # Client-side auth helpers
  connections-store.ts             # Jotai atoms for app connections
  code-generation.ts               # Workflow code generation
  codegen-registry.ts              # Code generation templates
  config-service.ts                # Dapr Configuration building block client
  platform-service.ts              # Platform/project management
  workflow-spec/                   # WorkflowSpec v1 JSON import/export and lint
    types.ts                       # WorkflowSpec type definitions
    lint.ts                        # Workflow spec linter
    decompile.ts                   # Decompile workflow to spec
    action-config-zod.ts           # Action config Zod schemas
    system-actions.ts              # System action definitions
    catalog-server.ts              # Catalog server for spec tools
  ai/
    workflow-generation.ts         # AI workflow generation
    workflow-spec-generation.ts    # AI spec generation
    action-list-prompt.ts          # Action list prompt builder
    validated-operation-stream.ts  # Validated operation streaming
  db/
    schema.ts                      # Drizzle ORM schema (PostgreSQL)
    migrate.ts                     # Migration runner
    app-connections.ts             # App connection data layer (encrypt/decrypt)
    piece-metadata.ts              # Piece metadata data layer
  security/encryption.ts           # AES-256-CBC encryption (AP-compatible)
  app-connections/
    oauth2.ts                      # OAuth2 PKCE flow (authorization + token exchange)
    oauth2-refresh.ts              # OAuth2 token refresh with 15-min buffer
  activepieces/
    installed-pieces.ts            # Single source of truth for installed AP pieces
    action-adapter.ts              # AP props → WB ActionConfigField converter
  actions/
    builtin-pieces.ts              # Builtin piece definitions (agent, mastra, durable, mcp)
    connection-utils.ts            # Action-to-connection mapping utilities
  mcp-chat/tools.ts                # MCP Chat tool definitions
  types/
    app-connection.ts              # AppConnection types, enums
    piece-auth.ts                  # Piece auth types

services/
  workflow-orchestrator/           # Python Dapr workflow orchestrator (ACTIVE)
  durable-agent/                   # Durable AI agent — Dapr Workflow ReAct loop (ACTIVE, PRIMARY)
  mastra-agent-tanstack/           # Mastra AI agent with TanStack Start (ACTIVE, SECONDARY)
  mastra-agent-mcp/                # Mastra agent MCP server variant (ACTIVE)
  function-router/                 # Function execution router (ACTIVE)
  fn-activepieces/                 # AP piece action executor (ACTIVE)
  fn-system/                       # System functions - http-request, db-query, condition (ACTIVE)
  workflow-mcp-server/             # Workflow MCP tools + React UI (ACTIVE)
  piece-mcp-server/                # AP piece MCP server + MCP Apps UI (ACTIVE)
  mcp-gateway/                     # Hosted MCP server gateway (ACTIVE)
  node-sandbox/                    # Node.js runtime sandbox (drop-in replacement)
  shared/                          # Shared utilities (logger)

components/
  workflow/
    workflow-canvas.tsx            # React Flow canvas with node types
    node-config-panel.tsx          # Properties/Code/Runs tabs
    workflow-runs.tsx              # Runs tab — execution history and output
    ai-chat-panel.tsx              # AI chat panel for workflow generation
    approval-banner.tsx            # Approval gate banner
    nodes/                         # Node components (trigger, action, etc.)
    config/
      action-config.tsx            # Action node configuration (builtin + AP)
      action-grid.tsx              # Action palette (plugins + AP pieces)
      activity-config.tsx          # Activity node configuration (Dapr primitives)
      fields/
        dynamic-select-field.tsx   # AP dynamic dropdown (fetches options at runtime)
  connections/
    auth-form-renderer.tsx         # Dynamic auth forms from piece metadata
  mcp-chat/
    tool-widget.tsx                # MCP Apps protocol handler (ToolWidget)
  overlays/
    add-connection-overlay.tsx     # Create connection (OAuth2 PKCE + secret text)

plugins/                           # Plugin registry
  registry.ts                      # Plugin registration and discovery
  mastra-agent/                    # Mastra Agent plugin (mastra-run action)
  durable-agent/                   # Durable Agent plugin (durable/run action)
  openai/                          # OpenAI plugin (text/image generation)
  mcp/                             # MCP plugin
  slack/                           # Slack plugin
  github/                          # GitHub plugin
  resend/                          # Resend plugin
  linear/                          # Linear plugin
  firecrawl/                       # Firecrawl plugin
  perplexity/                      # Perplexity plugin
  stripe/                          # Stripe plugin
  fal/                             # Fal plugin
  blob/                            # Blob storage plugin
  v0/                              # v0 plugin
  clerk/                           # Clerk plugin
  webflow/                         # Webflow plugin
  superagent/                      # Superagent plugin

scripts/
  sync-activepieces-pieces.ts      # Fetch AP piece metadata from cloud API → DB
  discover-plugins.ts              # Generate plugin manifest (plugins/index.ts)
  seed-functions.ts                # Seed builtin functions to DB
  sync-oauth-apps.ts               # Sync OAuth app configurations
  db-migrate-safe.ts               # Safe migration runner
  db-baseline-drizzle.ts           # Baseline Drizzle migrations
  migrate-system-http-request-input.ts  # Data migration for http-request input schema
  workflow-spec-lint.ts            # CLI for linting workflow specs
  test-llm-create-and-execute.ts   # E2E test: LLM-generated workflow + execution
```

## Services

### workflow-orchestrator (Python)

The generic workflow engine. Interprets workflow definitions from the visual builder,
executing nodes in topological order via Dapr activities. Routes agent actions to
durable-agent. Also runs Activepieces flows via a linked-list step walker.

- **Port**: 8080
- **Dapr app-id**: `workflow-orchestrator`
- **Calls**: function-router (for sync action nodes including mastra/clone, mastra/plan), durable-agent (for async agent/*, durable/*, and mastra/execute actions), fn-activepieces (for AP piece actions)
- **Key endpoints**:
  - `POST /api/v2/workflows` - Start a WB workflow instance (expects pre-serialized nodes)
  - `POST /api/v2/workflows/execute-by-id` - Start workflow by DB ID (fetches + serializes nodes automatically)
  - `POST /api/v2/ap-workflows` - Start an AP flow instance
  - `GET /api/v2/workflows/{id}/status` - Get workflow status
  - `POST /api/v2/workflows/{id}/events` - Raise external event (approvals)
  - `POST /api/v2/workflows/{id}/terminate` - Terminate workflow
- **Routing split** (`workflows/dynamic_workflow.py:304`): `agent/*`, `durable/*`, and `mastra/execute` go through the async `process_agent_child_workflow` handler (fire-and-forget + external event completion). All other `mastra/*` actions (clone, plan) go through `execute_action` → function-router synchronously.
- **Agent routing** (`activities/call_agent_service.py`):
  - `agent/*`, `durable/*` → `call_durable_agent_run()` → durable-agent `/api/run`
  - `mastra/execute` → `call_durable_execute_plan()` → durable-agent `/api/execute-plan`
- **Output persistence** (`activities/persist_results_to_db.py`): At workflow completion (success or error), persists final output to `workflow_executions.output` in PostgreSQL. Belt-and-suspenders with the status polling endpoint.
- **Config** (`core/config.py`): `DURABLE_AGENT_APP_ID=durable-agent`, `MASTRA_AGENT_APP_ID=mastra-agent-tanstack`, `FUNCTION_ROUTER_APP_ID=function-router`
- **AP workflow** (`workflows/ap_workflow.py`): Walks AP's linked-list flow format natively with step handlers for PIECE, CODE, ROUTER (condition branching), and LOOP_ON_ITEMS.

### durable-agent (TypeScript/Express)

Primary AI agent service using a Dapr Workflow-backed ReAct loop. Survives pod restarts,
has built-in retries, and uses deterministic replay for durability.

- **Port**: 8001
- **Dapr app-id**: `durable-agent`
- **Framework**: Express + @dapr/dapr ^3.4.0 + AI SDK 6 (@ai-sdk/openai)
- **Key endpoints**:
  - `POST /api/run` - Fire-and-forget agent run (schedules Dapr workflow)
  - `POST /api/plan` - Synchronous planning (generates structured plan)
  - `POST /api/execute-plan` - Fire-and-forget plan execution (schedules Dapr workflow)
  - `GET /api/tools` - List available workspace tools
  - `POST /api/tools/:toolId` - Execute a workspace tool directly
  - `GET /api/health` - Health check with agent status
  - `GET /api/dapr/subscribe` - Dapr subscription discovery
- **Workspace tools**: `read_file`, `write_file`, `edit_file`, `list_files`, `delete`, `mkdir`, `file_stat`, `execute_command`
- **ReAct loop** (`workflow/agent-workflow.ts`): Dapr workflow generator — LLM call → tool execution → LLM call → ... → final text answer. Accumulates all tool calls across turns in `AgentWorkflowResult.all_tool_calls`.
- **Per-request maxTurns**: Accepts `maxTurns` in request body, passed as `maxIterations` in workflow trigger. Default: 50 (configurable via `MAX_ITERATIONS` env var).
- **Sandbox**: K8s (KubernetesSandbox) with bubblewrap fallback for local dev
- **Completion**: Waits for Dapr workflow completion in background, extracts tool calls + file changes + git diff, publishes completion event via direct service invocation to orchestrator `/api/v2/workflows/{id}/events`
- **Dapr components**: `durable-statestore` (Redis, actorStateStore), `durable-pubsub` (NATS JetStream) — separate from orchestrator's components due to ArgoCD scoping
- **Build**: `docker build -f services/durable-agent/Dockerfile services/durable-agent/` (context is service dir, NOT project root)

### mastra-agent-tanstack (TypeScript/TanStack Start)

Secondary AI agent service using Mastra SDK. Still deployed for MCP endpoint access and
monitoring UI, but no longer primary for agent routing (durable-agent handles that).

- **Port**: 3000 (TanStack Start)
- **Dapr app-id**: `mastra-agent-tanstack`
- **Framework**: TanStack Start 1.x (React Router + Nitro SSR)
- **Agent SDK**: @mastra/core ^1.4.0 with @ai-sdk/openai
- **Key endpoints**:
  - `POST /api/run` - Run agent with prompt (fire-and-forget, publishes completion via Dapr)
  - `POST /api/plan` - Generate structured execution plan (synchronous)
  - `POST /api/execute-plan` - Execute a pre-generated plan (fire-and-forget)
  - `GET /api/tools` - List available workspace tools
  - `POST /api/tools/{toolId}` - Execute a workspace tool directly
  - `POST /api/mcp` - MCP endpoint (Streamable HTTP)
  - `GET /api/health` - Health check with agent status
  - `GET /api/dapr/subscribe` - Dapr subscription discovery
- **Workspace tools**: `read_file`, `write_file`, `edit_file`, `list_files`, `delete`, `mkdir`, `file_stat`, `execute_command` (auto-injected by Mastra Workspace)
- **Sandbox**: Auto-detects K8s (KubernetesSandbox) or local (LocalSandbox with bwrap/seatbelt). Network disabled by default.
- **Planning**: Separate planner agent generates structured plans (goal + steps), execution agent follows them step-by-step
- **Events**: Publishes `agent_started`, `agent_completed`, `tool_call`, `tool_result`, `planning_started`, `planning_completed`, `llm_end` via Dapr pub/sub
- **Build**: `pnpm run build` (UI via vite → dist-ui/, app via vite → .output/)
- **UI**: React 19 + TanStack Router (single-file bundle for MCP Apps iframe)

### mastra-agent-mcp (TypeScript)

Secondary Mastra agent exposed as a pure MCP server with monitoring UI.
Uses older @mastra/core ^0.10.0.

- **Port**: 3300
- **Dapr app-id**: `mastra-agent-mcp`
- **Key endpoints**:
  - `POST /mcp` - MCP Streamable HTTP endpoint (POST/GET/DELETE)
  - `POST /run` - Agent execution (Dapr service invocation)
  - `GET /health` - Health check
  - `GET /dapr/subscribe` - Dapr subscription discovery
- **Sessions**: Stateful per-session MCP transport with 30s TTL auto-cleanup
- **UI**: Preloaded HTML for agent monitoring (embedded in MCP Apps)
- **Build**: `pnpm run build:all` (UI via vite → dist/ui/, server via esbuild → dist/index.js)

### function-router (TypeScript)

Routes function execution to the appropriate service based on a registry.

- **Port**: 8080
- **Dapr app-id**: `function-router`
- **Key endpoint**: `POST /execute`
- **Registry** (`core/registry.ts`): Loaded from ConfigMap file, env var, or hardcoded defaults:
  - `system/*` → `fn-system` (http-request, database-query, condition)
  - `mastra/*` → `durable-agent`
  - `durable/*` → `durable-agent`
  - `_default` → `fn-activepieces` (all other slugs)
- **Routing**: Exact match → wildcard match → builtin fallback → `_default`
- **Credentials**: Pre-fetches from Dapr secret store (Azure Key Vault) or decrypts AP app connections via internal API
- **External events**: `POST /external-event` route for raising Dapr workflow events

### fn-system (TypeScript)

Built-in system actions executed as a Knative service.

- **Port**: 8080
- **Steps**: `http-request`, `database-query`, `condition`
- **Key endpoint**: `POST /execute`

### fn-activepieces (TypeScript)

Executes Activepieces piece actions. Ships with AP piece npm packages pre-installed.

- **Port**: 8080
- **Key endpoints**:
  - `POST /execute` - Execute a piece action
  - `POST /options` - Resolve dynamic dropdown options
  - `GET /health` - Health check
- **Context**: Stubbed AP execution context (no-op store/files, real auth)

### workflow-mcp-server (TypeScript)

MCP server exposing workflow CRUD, node/edge manipulation, execution, and approval tools.
Includes embedded React Flow UI for MCP Apps integration.

- **Port**: 3200
- **MCP endpoint**: `/mcp` (Streamable HTTP)
- **13+ tools**: `list_workflows`, `get_workflow`, `create_workflow`, `update_workflow`, `delete_workflow`, `duplicate_workflow`, `add_node`, `update_node`, `delete_node`, `connect_nodes`, `disconnect_nodes`, `list_available_actions`, `execute_workflow`
- **Execution**: `execute_workflow` calls orchestrator's `POST /api/v2/workflows/execute-by-id` which properly serializes React Flow nodes (flattening `data.config` to top-level `config`)
- **DB**: Raw `pg.Pool` (NOT Drizzle) — direct SQL against `workflows`, `functions`, `piece_metadata` tables
- **UI**: React 19 + @xyflow/react bundled as single-file HTML via `vite-plugin-singlefile`
- **Build**: `pnpm run build:all` (UI via vite → dist/ui/, server via esbuild → dist/index.js)

### piece-mcp-server (TypeScript)

MCP server that exposes Activepieces piece actions as MCP tools with interactive UI.
Ships with 42 AP piece npm packages for broader coverage than fn-activepieces.

- **Port**: Dynamic
- **MCP endpoint**: `/mcp`
- **Features**: Per-piece tool registration, MCP Apps UI support, auth resolution from DB
- **DB**: Raw `pg.Pool` for credential lookup and piece metadata
- **Build**: `pnpm run build:all`

### mcp-gateway (TypeScript)

Public Streamable HTTP MCP endpoint for hosted MCP servers. Authenticates with Bearer tokens
and delegates execution to the workflow-builder Next.js app via internal endpoints.

- **Port**: 8080
- **Key endpoint**: `POST /api/v1/projects/:projectId/mcp-server/http`
- **Auth**: Bearer token validated against per-project MCP server config
- **Flow**: Fetch MCP server config → register enabled workflow tools → execute workflow on tool call → poll for response
- **Internal calls**: Uses `X-Internal-Token` to call workflow-builder `/api/internal/mcp/*` endpoints

### node-sandbox (Node.js)

Simple HTTP runtime sandbox. Drop-in replacement for python-runtime-sandbox.

- **Port**: 8888
- **Endpoints**: `GET /` (readiness), `GET /health`, `POST /execute` (shell command), `POST /upload` (file upload)
- **Runtime**: Node.js 22-slim, git/curl installed, runs as non-root

## Node Types

The workflow builder supports these node types:

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

### Action Routing

Actions are routed by `actionType` slug prefix. Sync actions go through function-router; async actions use `process_agent_child_workflow` (fire-and-forget + Dapr external event completion).

| Prefix | Service | Sync/Async | Examples |
|--------|---------|------------|----------|
| `system/*` | fn-system (via function-router) | Sync | `system/http-request`, `system/database-query`, `system/condition` |
| `mastra/clone` | durable-agent (via function-router) | Sync | Clone a git repo |
| `mastra/plan` | durable-agent (via function-router) | Sync | Generate execution plan |
| `mastra/execute` | durable-agent (direct) | Async | Execute a plan (fire-and-forget) |
| `agent/*` | durable-agent (direct) | Async | Agent run with prompt |
| `durable/*` | durable-agent (direct) | Async | Durable agent run with prompt |
| `*` (default) | fn-activepieces (via function-router) | Sync | All AP piece actions |

### Builtin Action Pieces

Defined in `lib/actions/builtin-pieces.ts` and exported via `getBuiltinPieces()`:

| Piece | Type | Actions |
|-------|------|---------|
| **Agent** | `agent` | `agent/run` — durable LLM agent with configurable model, maxTurns, stopCondition, allowedActions |
| **Mastra Agent** | `mastra` | `mastra/clone`, `mastra/plan`, `mastra/execute`, `mastra/run`, `mastra/read-file`, `mastra/write-file`, `mastra/edit-file`, `mastra/list-files`, `mastra/execute-command`, `mastra/delete`, `mastra/mkdir` |
| **Durable Agent** | `durable` | `durable/run` — durable agent with prompt, maxTurns, timeout |
| **MCP** | `mcp` | `mcp/reply-to-client` — return response to MCP client |

## Plugin Registry

Functions are defined in `plugins/*/index.ts` files and seeded to the `functions` table:

```bash
pnpm discover-plugins  # Generates plugins/index.ts
pnpm seed-functions    # Seeds functions table from plugins
```

**Current plugins**: `openai`, `mastra-agent`, `durable-agent`, `mcp`, `slack`, `github`, `resend`, `linear`, `firecrawl`, `perplexity`, `stripe`, `fal`, `blob`, `v0`, `clerk`, `webflow`, `superagent`

## MCP Integration

### Three MCP Server Types

1. **workflow-mcp-server** (Port 3200): Workflow CRUD + node manipulation tools with React Flow UI
2. **piece-mcp-server**: Per-piece AP action tools with MCP Apps UI
3. **mcp-gateway**: Hosted MCP endpoint — exposes workflows as MCP tools for external AI clients

### MCP Chat

The `/mcp-chat` page provides an AI chat interface that can discover and call MCP server tools:
- Server discovery via `/api/mcp-chat/servers/discover`
- Tool calls proxied via `/api/mcp-chat/tools/call`
- Interactive MCP Apps rendered in ToolWidget iframe

### MCP Apps Protocol

MCP Apps use `@modelcontextprotocol/ext-apps` for interactive UI in chat:
- ToolWidget (`components/mcp-chat/tool-widget.tsx`) handles host-side protocol
- Protocol flow: `ui/initialize` → host response → `ui/notifications/initialized` → `tool-input`/`tool-result` → interactive `tools/call`
- Sandbox: `sandbox="allow-scripts allow-same-origin"` required

## Database Schema

### Key Tables

**platforms**, **users**, **user_identities**, **projects**, **project_members** — Multi-tenant platform with roles

**workflows**:
- `id`, `name`, `nodes` (JSONB), `edges` (JSONB), `engine_type`
- `user_id`, `project_id` — ownership
- `mcp_trigger_tool_name`, `mcp_trigger_tool_description`, `mcp_trigger_input_schema`, `mcp_trigger_returns_response` — MCP trigger config

**workflow_executions**: `id`, `workflow_id`, `dapr_instance_id`, `status`, `phase`, `trigger_data`, `output` (JSONB), `error`, `started_at`, `completed_at`, `duration`
- `output` is written via two complementary paths: (1) status polling endpoint on terminal status, (2) `persist_results_to_db` orchestrator activity at workflow completion

**functions**: `id`, `slug`, `name`, `plugin_id`, `execution_type` (builtin/oci/http), `is_builtin`, `is_enabled`

**app_connections**: `id`, `externalId`, `displayName`, `pieceName`, `type` (OAUTH2/SECRET_TEXT/BASIC_AUTH/CUSTOM_AUTH), `status`, `value` (encrypted JSONB), `owner_id`, `scope`, `platformId`

**piece_metadata**: `id`, `name`, `displayName`, `version`, `auth` (JSONB), `actions` (JSONB), `triggers` (JSONB), `logoUrl`, `categories`

**mcp_servers**: Per-project MCP server configuration with token auth

**mcp_runs**: MCP tool execution tracking (status, input, response)

**api_keys**: JWT API keys for programmatic access

**platform_oauth_apps**: OAuth app configurations (client IDs, secrets)

**signing_keys**: RSA key pairs for JWT signing

### Observability Tables

**workflow_execution_logs**: Timing breakdown (`credential_fetch_ms`, `routing_ms`, `execution_ms`, `routed_to`, `was_cold_start`)

**credential_access_logs**: Compliance audit (`source`: dapr_secret, request_body, not_found)

**workflow_external_events**: Approval audit trail

## Activepieces Integration

### App Connections (Credentials)

Credentials are AES-256-CBC encrypted at rest. Supported auth types: `OAUTH2`, `SECRET_TEXT`, `BASIC_AUTH`, `CUSTOM_AUTH`.

**Connection flow**: User creates connection → (OAuth2 PKCE or manual entry) → encrypted in `app_connections` table → function-router calls internal decrypt API at execution time

**Key files**: `lib/security/encryption.ts`, `lib/app-connections/oauth2.ts`, `lib/db/app-connections.ts`

### Adding a New Piece

1. Add normalized name to `lib/activepieces/installed-pieces.ts`
2. Add npm dependency to `services/fn-activepieces/package.json` (and/or `services/piece-mcp-server/package.json`)
3. Add import + PIECES entry to respective `piece-registry.ts`
4. Rebuild and deploy

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `DATABASE_URL` | PostgreSQL connection string | (required) |
| `BETTER_AUTH_SECRET` | Auth encryption secret | (required) |
| `NEXT_PUBLIC_APP_URL` | Public app URL | `http://localhost:3000` |
| `WORKFLOW_ORCHESTRATOR_URL` | Orchestrator service URL | `http://workflow-orchestrator:8080` |
| `FUNCTION_RUNNER_APP_ID` | Function router Dapr app-id | `function-router` |
| `DURABLE_AGENT_APP_ID` | Durable agent Dapr app-id | `durable-agent` |
| `DAPR_HOST` | Dapr sidecar host | `localhost` |
| `DAPR_HTTP_PORT` | Dapr HTTP port | `3500` |
| `DAPR_SECRETS_STORE` | Dapr secret store name | `azure-keyvault` |
| `AP_ENCRYPTION_KEY` | AES-256 key for app connection encryption (32-char hex) | (required for AP) |
| `INTERNAL_API_TOKEN` | Token for internal decrypt API + mcp-gateway (service-to-service) | (required) |
| `NEXT_PUBLIC_AUTH_PROVIDERS` | Comma-separated auth providers | `email` |
| `NEXT_PUBLIC_GITHUB_CLIENT_ID` | GitHub OAuth client ID | |
| `NEXT_PUBLIC_GOOGLE_CLIENT_ID` | Google OAuth client ID | |
| `MAX_ITERATIONS` | Durable agent default max ReAct turns | `50` |
| `AI_MODEL` | Durable agent LLM model | `gpt-4o` |

## Deployment (Kind Cluster)

The app runs in the `workflow-builder` namespace with:
- `workflow-builder` Deployment (1 replica, port 3000)
- `workflow-orchestrator` Deployment (1 replica, port 8080) with Dapr sidecar
- `durable-agent` Deployment (port 8001) with Dapr sidecar
- `mastra-agent-tanstack` Deployment (port 3000) with Dapr sidecar
- `mastra-agent-mcp` Deployment (port 3300) with Dapr sidecar
- `function-router` Deployment (1 replica, port 8080) with Dapr sidecar
- `fn-activepieces` Deployment (1 replica, port 8080)
- `fn-system` Deployment (1 replica, port 8080)
- `workflow-mcp-server` Deployment (port 3200)
- `piece-mcp-server` Deployment
- `mcp-gateway` Deployment (port 8080)
- `postgresql` StatefulSet (1 replica, port 5432)
- `redis` for Dapr workflow state store
- Ingress via `ingress-nginx` at `workflow-builder.cnoe.localtest.me:8443`

Images are pushed to the Gitea registry at `gitea.cnoe.localtest.me:8443/giteaadmin/`.

### Build Images

```bash
# Build images (Next.js app uses project root; Python/standalone services use their own directory as context)
docker build -t gitea.cnoe.localtest.me:8443/giteaadmin/workflow-builder:latest .
docker build -t gitea.cnoe.localtest.me:8443/giteaadmin/workflow-orchestrator:latest -f services/workflow-orchestrator/Dockerfile services/workflow-orchestrator/
docker build -t gitea.cnoe.localtest.me:8443/giteaadmin/durable-agent:latest -f services/durable-agent/Dockerfile services/durable-agent/
docker build -t gitea.cnoe.localtest.me:8443/giteaadmin/mastra-agent-tanstack:latest -f services/mastra-agent-tanstack/Dockerfile .
docker build -t gitea.cnoe.localtest.me:8443/giteaadmin/mastra-agent-mcp:latest -f services/mastra-agent-mcp/Dockerfile .
docker build -t gitea.cnoe.localtest.me:8443/giteaadmin/function-router:latest -f services/function-router/Dockerfile .
docker build -t gitea.cnoe.localtest.me:8443/giteaadmin/fn-activepieces:latest -f services/fn-activepieces/Dockerfile .
docker build -t gitea.cnoe.localtest.me:8443/giteaadmin/fn-system:latest -f services/fn-system/Dockerfile .
docker build -t gitea.cnoe.localtest.me:8443/giteaadmin/workflow-mcp-server:latest -f services/workflow-mcp-server/Dockerfile services/workflow-mcp-server/
docker build -t gitea.cnoe.localtest.me:8443/giteaadmin/piece-mcp-server:latest -f services/piece-mcp-server/Dockerfile .
docker build -t gitea.cnoe.localtest.me:8443/giteaadmin/mcp-gateway:latest -f services/mcp-gateway/Dockerfile .
```

## Dapr Integration

### Service App IDs

| Service | Dapr App ID |
|---------|-------------|
| workflow-orchestrator | `workflow-orchestrator` |
| durable-agent | `durable-agent` |
| mastra-agent-tanstack | `mastra-agent-tanstack` |
| mastra-agent-mcp | `mastra-agent-mcp` |
| function-router | `function-router` |

### Component Scoping

| Component | Scoped To |
|-----------|-----------|
| `workflowstatestore` (Redis) | workflow-orchestrator |
| `pubsub` (Redis) | workflow-orchestrator, mastra-agent-tanstack, mastra-agent-mcp |
| `durable-statestore` (Redis, actorStateStore) | durable-agent |
| `durable-pubsub` (NATS JetStream) | durable-agent |
| `azure-keyvault` (Secrets) | workflow-orchestrator, function-router |
| `kubernetes-secrets` (Secrets) | workflow-orchestrator (for DATABASE_URL in persist_results_to_db) |

### Credential Resolution Priority

1. **Dapr Secret Store** (Azure Key Vault) - automatic based on plugin type
2. **App Connections** (encrypted in DB) - AP piece credentials via internal decrypt API
3. **Request body** - credentials passed directly in execution request (legacy fallback)

## Event Streaming Pipeline

Agent services stream real-time events for the UI:

```
durable-agent / mastra-agent-tanstack
  → Dapr pub/sub (pubsub / durable-pubsub)
  → workflow-orchestrator subscriptions (or direct service invocation)
  → Next.js app SSE / webhooks
  → Activity Tab UI
```

**Completion event delivery**: durable-agent uses direct Dapr service invocation to orchestrator `/api/v2/workflows/{id}/events` (NOT pub/sub — component scoping mismatch between durable-pubsub and orchestrator's pubsub).

**Event types**: `tool_call`, `tool_result`, `phase_started`, `phase_completed`, `phase_failed`, `llm_start`, `llm_end`, `agent_started`, `agent_completed`, `planning_started`, `planning_completed`, `execution_started`, `execution_completed`

## Development Workflow

### Local Development (DevSpace)

```bash
devspace dev  # Starts dev mode with file sync
```

**What's synced**: `app/`, `components/`, `lib/`, `plugins/` — Hot reload enabled
**Excluded**: `services/` (separate deployments)

**For service changes**:
```bash
# Rebuild and restart a service
docker build -t gitea.cnoe.localtest.me:8443/giteaadmin/<service>:latest -f services/<service>/Dockerfile .
docker push gitea.cnoe.localtest.me:8443/giteaadmin/<service>:latest
kubectl rollout restart deployment/<service> -n workflow-builder

# Special case: durable-agent uses service dir as context (not project root)
docker build -t gitea.cnoe.localtest.me:8443/giteaadmin/durable-agent:latest -f services/durable-agent/Dockerfile services/durable-agent/
```

## Troubleshooting

### Common Issues

- Missing `actionType` in node config → UI bug, recreate node
- Function not found → Check `functions` table, run `pnpm seed-functions`
- Missing credentials → Add API keys to Azure Key Vault or create app connections
- Agent timeout → Check durable-agent logs (`kubectl logs -l app=durable-agent`)
- Agent stops before completing plan → Check `maxTurns` setting (default: 50, configurable per-node in UI)
- AP piece not showing → Check `lib/activepieces/installed-pieces.ts`, re-sync piece metadata
- OAuth2 token expired → Auto-refresh should handle; check `AP_ENCRYPTION_KEY`
- AP credential decrypt fails → Verify `INTERNAL_API_TOKEN` matches across services
- Tool call extraction → durable-agent returns `all_tool_calls` accumulated across all ReAct turns
- MCP session stale → Sessions auto-cleanup after 30s TTL; check `/health` endpoint
- Dapr pub/sub scoping → durable-agent uses `durable-pubsub` (NATS); orchestrator uses `pubsub` (Redis) — they're isolated. Completion events use direct service invocation instead.
- ArgoCD reverts patches → `automated.prune + ServerSideApply` reverts manual `kubectl patch` on managed resources — create separate resources instead
- Workflow output lost on navigation → Verify both persistence paths: status polling endpoint writes `output` on terminal status, and `persist_results_to_db` activity writes at completion

### Service Logs

```bash
kubectl logs -n workflow-builder -l app=workflow-orchestrator -c workflow-orchestrator --tail=50
kubectl logs -n workflow-builder -l app=durable-agent -c durable-agent --tail=50
kubectl logs -n workflow-builder -l app=mastra-agent-tanstack --tail=50
kubectl logs -n workflow-builder -l app=function-router -c function-router --tail=50
kubectl logs -n workflow-builder -l app=fn-activepieces --tail=50
kubectl logs -n workflow-builder -l app=fn-system --tail=50
```

## Migration Notes

### Mastra Agent → Durable Agent (Complete)

Agent routing has been migrated from mastra-agent-tanstack to durable-agent:
- `agent/*` actions → durable-agent `/api/run` (was mastra-agent-tanstack)
- `mastra/execute` → durable-agent `/api/execute-plan` (was mastra-agent-tanstack)
- `durable/*` → new action type family, routes to durable-agent
- function-router registry: `mastra/*` now routes to durable-agent (was mastra-agent-tanstack)
- mastra-agent-tanstack remains deployed for MCP endpoint and monitoring UI but is no longer the primary agent

### Standalone fn-* Services → Consolidated (Complete)

8 legacy standalone Knative services (fn-openai, fn-slack, fn-github, fn-resend, fn-stripe, fn-linear, fn-firecrawl, fn-perplexity) were removed. All function execution now routes through:
- `fn-system` for system/* actions (http-request, database-query, condition)
- `fn-activepieces` for all AP piece actions (default fallback)
- `durable-agent` for agent/mastra/durable actions

### Planner → Mastra Agent → Durable Agent (Complete)

`planner-dapr-agent` (OpenAI Agents SDK, Python) was replaced by `mastra-agent-tanstack` (Mastra SDK), which was then superseded by `durable-agent` (Dapr Workflow + AI SDK 6) as the primary agent service. The planner service, its API routes, and all `planner/*` action types have been removed.

### Workflow Orchestrator TS → Python (Complete)

TypeScript orchestrator was archived and has been deleted. Python version is the active implementation.

### Legacy Service Cleanup (Complete)

Removed `activity-executor/` (empty legacy service with no source code) and `workflow-orchestrator-ts-archived/` (replaced by Python orchestrator).

---

**Last Updated**: 2026-02-16
**Architecture**: Dapr workflow orchestration + durable AI agents + MCP server integration + Activepieces connectors
**Status**: Production-ready with OpenTelemetry observability, sandbox execution, MCP Apps, and hosted MCP servers

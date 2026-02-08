# Workflow Builder

Visual workflow builder with Dapr workflow orchestration and AI planner agents. The Next.js app serves as a UI + BFF proxy layer; all workflow execution lives in Dapr on Kubernetes.

## Architecture

```
┌──────────────────────────────────────────────────────────────────────┐
│                        Kubernetes Cluster                            │
│                                                                      │
│  ┌─────────────────┐    ┌──────────────────────────────────────────┐│
│  │  Next.js App    │    │  workflow-orchestrator (Python/Dapr)     ││
│  │  (no sidecar)   │───▶│  - Dynamic workflow interpreter          ││
│  │                 │    │  - Topological node execution             ││
│  │  Port 3000      │    │  - Approval gates, timers, pub/sub       ││
│  └─────────────────┘    │  - Calls planner-dapr-agent for AI tasks ││
│         │               │  - AP flow walker (linked-list execution) ││
│         │               └──────────┬───────────────┬───────────────┘│
│         │                          │               │                 │
│  OAuth2 PKCE +          Dapr svc invoke           │ Dapr svc invoke │
│  App Connections                   ▼               ▼                 │
│         │               ┌─────────────────────────────┐             │
│         │               │  function-router             │             │
│         │               │  - Registry-based routing    │             │
│         │               │  - Credential pre-fetch      │             │
│         │               │  - AP credential decrypt     │             │
│         │               └──────────┬──────────────────┘             │
│         │                          │                                 │
│         │               ┌──────────┼──────────────────────┐         │
│         │               │          │                      │         │
│         │               ▼          ▼                      ▼         │
│  ┌──────────────┐  ┌──────────┐  ┌──────────────┐  ┌───────────┐  │
│  │ planner-     │  │ fn-      │  │ OpenFunctions │  │ fn-openai │  │
│  │ dapr-agent   │  │ active-  │  │ fn-slack, ... │  │ fn-github │  │
│  │ (AI planner) │  │ pieces   │  │ (8 Knative)  │  │ etc.      │  │
│  └──────────────┘  │ (26 AP   │  └──────────────┘  └───────────┘  │
│                     │  pieces) │                                     │
│                     └──────────┘                                     │
│                                                                      │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐               │
│  │    Redis     │  │  PostgreSQL  │  │   Jaeger     │               │
│  │  (Dapr state)│  │  (workflows, │  │  (tracing)   │               │
│  │              │  │   functions,  │  │              │               │
│  │              │  │   app_conns)  │  │              │               │
│  └──────────────┘  └──────────────┘  └──────────────┘               │
└──────────────────────────────────────────────────────────────────────┘
```

The Next.js app makes direct HTTP calls to the orchestrator service. No Dapr sidecar is needed on the Next.js side.

## Tech Stack

- **Frontend**: Next.js 16, React 19, React Flow (@xyflow/react), Jotai state management, shadcn/ui
- **Backend**: Next.js API routes (BFF proxy to Dapr orchestrator)
- **Database**: PostgreSQL via Drizzle ORM
- **Auth**: Better Auth (email/password, anonymous users)
- **Workflow Engine**: Dapr Workflow SDK (Python) via workflow-orchestrator
- **AI Planner**: OpenAI Agents SDK (Python) via planner-dapr-agent
- **Function Execution**: function-router service → OpenFunctions (Knative serverless)
- **Activepieces Integration**: 26 installed AP pieces via fn-activepieces, OAuth2 PKCE, encrypted app connections
- **Deployment**: Docker (multi-stage), Kind cluster, ingress-nginx

## Key Commands

```bash
pnpm dev              # Start dev server
pnpm build            # Production build (runs discover-plugins first)
pnpm db:generate      # Generate Drizzle migrations
pnpm db:push          # Push schema to DB
pnpm db:migrate       # Run migrations
pnpm discover-plugins # Generate plugin manifest
pnpm seed-functions   # Seed builtin functions to DB
```

## Project Structure

```
app/
  api/
    workflows/[workflowId]/
      execute/route.ts           # Session-auth execution
      webhook/route.ts           # API-key-auth webhook execution
    dapr/workflows/              # Proxy to planner-dapr-agent
      route.ts                   # Start planner workflow
      [id]/approve/route.ts      # Approve/reject plan
      [id]/tasks/route.ts        # Get planner tasks
    app-connections/             # App connection CRUD + OAuth2
      route.ts                   # List/create connections
      [connectionId]/route.ts    # Get/update/delete connection
      [connectionId]/test/route.ts  # Test connection
      oauth2/start/route.ts      # Start OAuth2 PKCE flow
      oauth2/callback/route.ts   # OAuth2 callback handler
    internal/
      connections/[externalId]/
        decrypt/route.ts         # Internal credential decrypt (service-to-service)
    pieces/                      # Activepieces piece metadata
      route.ts                   # List all pieces
      [pieceName]/route.ts       # Get piece details
      actions/route.ts           # List actions from installed pieces
      options/route.ts           # Dynamic dropdown option resolution
  workflows/[workflowId]/page.tsx  # Workflow editor page
  (auth)/                        # Sign-in/sign-up pages

lib/
  workflow-definition.ts         # Shared types for workflow definitions
  workflow-store.ts              # Jotai atoms, node/edge types
  dapr-activity-registry.ts      # Dapr workflow primitives (approval gates, timers)
  dapr-client.ts                 # Dapr orchestrator API clients (planner + generic)
  workflow-executor.ts           # Direct execution path via activity-executor
  connections-store.ts           # Jotai atoms for app connections
  db/schema.ts                   # Drizzle ORM schema (PostgreSQL)
  db/migrate.ts                  # Migration runner (bundled with esbuild for Docker)
  db/app-connections.ts          # App connection data layer (encrypt/decrypt)
  db/piece-metadata.ts           # Piece metadata data layer
  security/encryption.ts         # AES-256-CBC encryption (AP-compatible)
  app-connections/
    oauth2.ts                    # OAuth2 PKCE flow (authorization + token exchange)
    oauth2-refresh.ts            # OAuth2 token refresh with 15-min buffer
  activepieces/
    installed-pieces.ts          # Single source of truth for 26 installed AP pieces
    action-adapter.ts            # AP props → WB ActionConfigField converter
  types/
    app-connection.ts            # AppConnection types, enums (OAuth2, SecretText, etc.)
    piece-auth.ts                # Piece auth types (mirrors AP PieceAuth framework)

services/
  workflow-orchestrator/         # Python Dapr workflow orchestrator
    app.py                       # FastAPI + Dapr workflow runtime
    core/config.py               # Configuration (env vars, service URLs)
    core/ap_variable_resolver.py # AP {{steps.x.output.y}} template resolution
    core/ap_condition_evaluator.py # AP branch condition evaluation
    workflows/
      dynamic_workflow.py        # WB node-graph interpreter workflow
      ap_workflow.py             # AP linked-list flow walker workflow
    activities/
      execute_action.py          # Calls function-router via Dapr
      call_planner_service.py    # Calls planner-dapr-agent via Dapr
      send_ap_callback.py        # AP flow-run callback + step progress
      persist_state.py           # Dapr state store operations
      publish_event.py           # Dapr pub/sub event publishing
      log_node_execution.py      # Execution log persistence
      log_external_event.py      # External event audit trail
  planner-dapr-agent/            # AI planner agent service
    app.py                       # FastAPI endpoints + workflow orchestration
    agent.py                     # OpenAI Agents SDK agent definition
    dapr_multi_step_workflow.py  # Multi-step: clone→plan→approve→execute
    dapr_openai_runner.py        # Streamed agent execution with event publishing
    durable_runner.py            # Interceptor-based durability
    planning_agents.py           # Planning/execution sub-agents
    sandbox_executor.py          # Isolated sandbox execution
    workflow_context.py          # Activity tracking and state management
  function-router/               # Routes function execution to OpenFunctions
    src/
      index.ts                   # Fastify server
      routes/execute.ts          # POST /execute endpoint
      core/registry.ts           # Function slug → OpenFunction mapping
      core/credential-service.ts # Dapr secrets + DB credential + AP decrypt
      core/openfunction-resolver.ts  # Knative + standalone service URL resolution
  fn-activepieces/               # AP piece action executor (Knative service)
    src/
      index.ts                   # Fastify server (POST /execute, POST /options)
      executor.ts                # Piece action execution engine
      context-factory.ts         # AP execution context builder (stubbed store/files)
      piece-registry.ts          # Static imports of 26 AP piece packages
      options-executor.ts        # Dynamic dropdown option resolution
    package.json                 # 26 AP piece npm dependencies (pinned versions)

components/
  workflow/
    workflow-canvas.tsx          # React Flow canvas with node types
    node-config-panel.tsx        # Properties/Code/Runs tabs
    nodes/                       # Node components (trigger, action, etc.)
    config/
      action-config.tsx          # Action node configuration (builtin + AP)
      action-grid.tsx            # Action palette (plugins + AP pieces)
      activity-config.tsx        # Activity node configuration (Dapr primitives)
      fields/
        dynamic-select-field.tsx # AP dynamic dropdown (fetches options at runtime)
  connections/
    auth-form-renderer.tsx       # Dynamic auth forms from piece metadata
  overlays/
    add-connection-overlay.tsx   # Create connection (OAuth2 PKCE + secret text)

plugins/                         # Plugin registry (OpenAI, Slack, GitHub, etc.)
  registry.ts                    # Plugin registration and discovery
  planner/                       # AI Planner plugin (clone, plan, execute, multi-step)
  openai/                        # OpenAI plugin (text/image generation)
  slack/                         # Slack plugin (send messages)
  github/                        # GitHub plugin (create issues, etc.)
  resend/                        # Resend plugin (send emails)
  ...

scripts/
  sync-activepieces-pieces.ts    # Fetch AP piece metadata from cloud API → DB
  discover-plugins.ts            # Generate plugin manifest (plugins/index.ts)
```

## Services

### workflow-orchestrator (Python)

The generic workflow engine. Interprets workflow definitions from the visual builder,
executing nodes in topological order via Dapr activities. Also runs Activepieces flows
via a linked-list step walker.

- **Port**: 8080
- **Dapr app-id**: `workflow-orchestrator`
- **Calls**: function-router (for action nodes), planner-dapr-agent (for planner/* actions), fn-activepieces (for AP piece actions)
- **Key endpoints**:
  - `POST /api/v2/workflows` - Start a WB workflow instance
  - `POST /api/v2/ap-workflows` - Start an AP flow instance
  - `GET /api/v2/workflows/{id}/status` - Get workflow status
  - `POST /api/v2/workflows/{id}/events` - Raise external event (approvals)
  - `POST /api/v2/workflows/{id}/terminate` - Terminate workflow
- **AP workflow** (`ap_workflow.py`): Walks AP's linked-list flow format natively with step handlers for PIECE, CODE, ROUTER (condition branching), and LOOP_ON_ITEMS. Uses `{{steps.x.output.y}}` variable resolution and `{{connections['externalId']}}` credential extraction.

### planner-dapr-agent (Python)

AI planner agent using OpenAI Agents SDK. Handles feature planning, code execution,
and testing in sandboxed environments. Streams activity events via Dapr pub/sub.

- **Port**: 8000
- **Dapr app-id**: `planner-dapr-agent`
- **Key endpoints**:
  - `POST /run` - Start planning (returns tasks)
  - `POST /workflow/dapr` - Multi-step workflow (clone→plan→approve→execute)
  - `POST /workflow/{id}/approve` - Approve/reject a plan
  - `GET /status/{id}` - Get workflow status
  - `GET /workflows/{id}` - Get detailed workflow state
- **Event streaming**: Publishes `tool_call`, `tool_result`, `phase_started`, `phase_completed`,
  `llm_start`, `llm_end`, `agent_started`, `agent_completed` events to Dapr pub/sub.
  These flow through the ai-chatbot webhook → Redis event store → SSE → Activity Tab UI.

### function-router (TypeScript)

Routes function execution to the appropriate OpenFunction (Knative service).

- **Port**: 8080
- **Dapr app-id**: `function-router`
- **Key endpoint**: `POST /execute`
- **Routing**: Registry-based lookup (exact match → wildcard → default → fn-activepieces fallback)
- **Credentials**: Pre-fetches from Dapr secret store (Azure Key Vault) or decrypts AP app connections via internal API
- **AP credential flow**: For AP piece slugs, calls `/api/internal/connections/{externalId}/decrypt` to get decrypted credentials, passes as `credentials_raw` to fn-activepieces

### fn-activepieces (TypeScript)

Executes Activepieces piece actions. Ships with 26 AP piece npm packages pre-installed.

- **Port**: 8080
- **Key endpoints**:
  - `POST /execute` - Execute a piece action
  - `POST /options` - Resolve dynamic dropdown options
  - `GET /health` - Health check
- **Pieces**: 26 installed (Google Suite, Microsoft Office, Slack, Notion, etc.)
- **Context**: Stubbed AP execution context (no-op store/files, real auth)
- **Adding a new piece**: See `lib/activepieces/installed-pieces.ts` for the 4-step process

## Node Types

The workflow builder supports two node types:

### Action Nodes (Function Execution)

**Purpose**: Execute serverless functions from the plugin registry

**Configuration**:
```typescript
{
  type: "action",
  config: {
    actionType: "openai/generate-text",  // Function slug (canonical)
    prompt: "Write a haiku",
    // ... function-specific config
  }
}
```

**Execution Flow**:
1. Orchestrator calls `executeAction` activity
2. Activity invokes function-router via Dapr
3. Function-router looks up OpenFunction by `actionType` slug
4. Routes to Knative service (e.g., fn-openai, fn-slack)
5. Returns result to orchestrator

**Examples**:
- `openai/generate-text` - AI text generation
- `openai/generate-image` - AI image generation
- `slack/send-message` - Send Slack message
- `github/create-issue` - Create GitHub issue
- `resend/send-email` - Send email
- `system/http-request` - HTTP client

**Planner actions** (routed to planner-dapr-agent, not function-router):
- `planner/clone` - Clone a Git repository into workspace
- `planner/plan` - Planning phase only (create tasks)
- `planner/execute` - Execution phase only (implement tasks)
- `planner/run-workflow` - Full planning → approval → execution
- `planner/multi-step` - Clone → plan → approve → execute in sandbox

### Activity Nodes (Workflow Primitives)

**Purpose**: Dapr workflow control flow primitives

**Types**:
- `approval-gate` - Wait for external event with timeout
- `timer` - Delay execution for specified duration
- `publish-event` - Publish to Dapr pub/sub

**Configuration**:
```typescript
{
  type: "approval-gate",
  config: {
    eventName: "plan-approval",
    timeoutSeconds: 86400,  // 24 hours
  }
}
```

**Note**: Activity nodes are for workflow control flow only, NOT for function execution. All function execution uses action nodes.

## Function System

### Plugin Registry

Functions are defined in `plugins/*/index.ts` files:

```typescript
export const openai: IntegrationDefinition = {
  id: "openai",
  label: "OpenAI",
  category: "AI",
  actions: [
    {
      id: "openai/generate-text",  // Function slug (canonical ID)
      label: "Generate Text",
      description: "Generate text using OpenAI models",
      configFields: [
        {
          key: "prompt",
          label: "Prompt",
          type: "template-textarea",
          required: true,
        },
      ],
      outputFields: [
        { field: "text", description: "Generated text" },
      ],
    },
  ],
};
```

### Function Execution

**Database-driven**: Functions are seeded from plugins to PostgreSQL:
```sql
SELECT * FROM functions WHERE slug = 'openai/generate-text';
```

**Execution types** (from `execution_type` column):
- `builtin` - TypeScript handlers in `plugins/*/steps/`
- `oci` - Container images executed as Kubernetes Jobs (future)
- `http` - External HTTP webhooks (future)

**Builtin handler location**:
```
plugins/openai/steps/generate-text.ts
```

### Function Discovery

**On build**:
```bash
pnpm discover-plugins  # Generates plugins/index.ts
```

**On cluster deploy**:
```bash
pnpm seed-functions    # Seeds functions table from plugins
```

**Auto-seeding**: The `Job-seed-functions` Kubernetes job runs automatically on cluster deploy (ArgoCD sync wave 25).

## Workflow Execution Flow

### 1. User Creates Workflow

**UI** → Visual workflow builder with React Flow:
- Drag action nodes from palette
- Configure with `actionType` field
- Connect nodes with edges
- Auto-save to PostgreSQL

### 2. User Runs Workflow

**UI** → `POST /api/workflows/{workflowId}/execute`:
```typescript
{
  triggerData: { /* user input */ },
  integrations: { /* API keys */ }
}
```

### 3. Orchestrator Executes

**Orchestrator** → Dynamic workflow interpreter:
```python
for node_id in definition["executionOrder"]:
    node = nodes_by_id[node_id]

    if node["type"] == "action":
        # Execute function (or planner action)
        yield ctx.call_activity(execute_action, input={
            "node": node,
            "node_outputs": node_outputs,
            "integrations": integrations,
        })

    if node["type"] == "approval-gate":
        # Wait for external event
        event = ctx.wait_for_external_event(event_name)
        timeout = ctx.create_timer(timeout_seconds)
        yield when_any([event, timeout])
```

### 4. Function Execution

**For standard actions** (openai/*, slack/*, etc.):
Orchestrator → function-router (Dapr invoke) → OpenFunction (Knative)

**For planner actions** (planner/*):
Orchestrator → planner-dapr-agent (Dapr invoke) → OpenAI Agents SDK → tool execution

### 5. Result Returned

**OpenFunction** → **function-router** → **orchestrator** → **database** → **UI**

## Event Streaming Pipeline

The planner-dapr-agent streams real-time activity events for the agent UI:

```
planner-dapr-agent
  → Dapr pub/sub (workflowpubsub)
  → ai-chatbot webhook (/api/webhooks/dapr/workflow-stream)
  → Redis event store
  → SSE stream (/api/workflows/{id}/stream)
  → Agent Activity Tab UI
```

**Event types**: `tool_call`, `tool_result`, `phase_started`, `phase_completed`,
`phase_failed`, `llm_start`, `llm_end`, `agent_started`, `agent_completed`,
`execution_started`, `execution_completed`, `activity_started`, `activity_completed`

Tool events include `callId` for correlating `tool_call` ↔ `tool_result` pairs.

## Activepieces Integration

### Overview

The workflow builder integrates with [Activepieces](https://www.activepieces.com/) to provide 26 pre-installed connector pieces (Google Sheets, Microsoft To Do, Slack, etc.) alongside the native plugin registry. AP pieces use OAuth2 PKCE and encrypted app connections instead of the legacy integrations system.

### App Connections (Credentials)

Replaces the legacy `integrations` table. Credentials are AES-256-CBC encrypted at rest.

**Supported auth types**:
- `OAUTH2` - OAuth2 PKCE flow with auto token refresh (15-min buffer)
- `SECRET_TEXT` - API keys
- `BASIC_AUTH` - Username/password
- `CUSTOM_AUTH` - Piece-specific multi-field auth

**Connection flow**:
1. User clicks "Add Connection" in UI
2. For OAuth2: redirects to provider via PKCE, callback stores encrypted tokens
3. For SECRET_TEXT: user enters API key, encrypted and stored
4. Stored in `app_connections` table with `{ iv, data }` JSONB encryption format
5. At execution time: function-router calls internal decrypt API → passes raw credentials to fn-activepieces

**Key files**:
- `lib/security/encryption.ts` - AES-256-CBC encrypt/decrypt (requires `AP_ENCRYPTION_KEY`)
- `lib/app-connections/oauth2.ts` - PKCE flow (verifier, challenge, token exchange)
- `lib/db/app-connections.ts` - CRUD with automatic encrypt/decrypt

### Installed Pieces (26)

Defined in `lib/activepieces/installed-pieces.ts` (single source of truth):

| Category | Pieces |
|----------|--------|
| Google Suite | Sheets, Calendar, Docs, Gmail, Drive |
| Productivity | Notion, Airtable, Todoist, Monday |
| Communication | Discord, Microsoft Teams, Telegram Bot |
| Microsoft Office | Outlook, Excel 365, To Do |
| Project Management | Jira Cloud, Asana, Trello, ClickUp |
| CRM & Marketing | HubSpot, Salesforce, Mailchimp |
| E-commerce & Support | Shopify, Zendesk |
| Email | SendGrid |
| Storage | Dropbox |

**Adding a new piece**:
1. Add normalized name to `lib/activepieces/installed-pieces.ts`
2. Add npm dependency to `services/fn-activepieces/package.json`
3. Add import + PIECES entry to `services/fn-activepieces/src/piece-registry.ts`
4. Rebuild and deploy fn-activepieces

### Piece Metadata Sync

```bash
npx tsx scripts/sync-activepieces-pieces.ts   # Fetch from AP cloud API → piece_metadata table
```

Fetches piece definitions (actions, triggers, auth config) from the Activepieces cloud API and stores them in the `piece_metadata` table. The UI reads from this table to render action palettes and auth forms.

### AP Workflow Execution

When `AP_EXECUTION_ENGINE=dapr`, Activepieces flows are executed via the workflow-orchestrator instead of AP's BullMQ queue:

```
AP Flow → POST /api/v2/ap-workflows → ap_workflow.py (Dapr workflow)
  → Walk linked-list action chain
  → For each step: resolve variables → fetch credentials → call fn-activepieces
  → Handle ROUTER (conditions), LOOP_ON_ITEMS, DELAY (timers), WEBHOOK (external events)
  → Send step updates + final callback to AP
```

**Step types supported**: PIECE, CODE, ROUTER, LOOP_ON_ITEMS, DELAY (via Dapr timers), WEBHOOK (via external events with 24h timeout)

## Database Schema

### Key Tables

**workflows**:
- `id` - Workflow ID
- `name` - Workflow name
- `nodes` - JSONB array of workflow nodes
- `edges` - JSONB array of workflow edges
- `engine_type` - Always "dapr"

**workflow_executions**:
- `id` - Execution ID
- `workflow_id` - FK to workflows
- `dapr_instance_id` - Dapr workflow instance ID
- `status` - running, completed, failed
- `phase` - Custom phase from Dapr workflow
- `trigger_data` - JSONB input data
- `result` - JSONB output data

**functions**:
- `id` - Function ID
- `slug` - Canonical slug (e.g., "openai/generate-text")
- `name` - Display name
- `plugin_id` - Plugin ID (e.g., "openai")
- `execution_type` - builtin, oci, http
- `is_builtin` - true for plugin functions
- `is_enabled` - true if function is active

**app_connections** (replaces legacy `integrations`):
- `id` - Connection ID
- `externalId` - AP-compatible external identifier
- `displayName` - User-facing name
- `pieceName` - AP piece name (e.g., "@activepieces/piece-google-sheets")
- `type` - OAUTH2, SECRET_TEXT, BASIC_AUTH, CUSTOM_AUTH
- `status` - ACTIVE, MISSING, ERROR
- `value` - JSONB encrypted credentials (`{ iv, data }` AES-256-CBC)
- `owner_id` - FK to users (ON DELETE set null)
- `scope` - PROJECT or PLATFORM
- `platformId` - Platform identifier

**piece_metadata** (cached from AP cloud API):
- `id` - Metadata ID
- `name` - Package name (e.g., "@activepieces/piece-google-sheets")
- `displayName` - Human-readable name
- `version` - Piece version
- `auth` - JSONB auth configuration (OAuth2 scopes, fields, etc.)
- `actions` - JSONB action definitions
- `triggers` - JSONB trigger definitions
- `logoUrl` - Piece icon URL
- `categories` - Text array of categories
- Composite index on `(name, version, platformId)`

**workflow_connection_refs** (workflow → connection mapping):
- `workflow_id` - FK to workflows (ON DELETE cascade)
- `node_id` - Node that uses the connection
- `connection_external_id` - Reference to app_connection.externalId
- `piece_name` - AP piece name for this connection

### Node Format in Database

**Action node** (stored in `workflows.nodes` JSONB):
```json
{
  "id": "node-1",
  "type": "action",
  "data": {
    "type": "action",
    "label": "Generate Text",
    "config": {
      "actionType": "openai/generate-text",
      "prompt": "Write a haiku about serverless"
    }
  },
  "position": { "x": 100, "y": 100 }
}
```

**Key field**: `config.actionType` - This is the canonical function slug used by the orchestrator and function-router to identify functions.

### Observability Tables

**workflow_execution_logs** (extended with timing breakdown):
- `id` - Log entry ID
- `execution_id` - FK to workflow_executions
- `node_id`, `node_name`, `node_type` - Node identification
- `activity_name` - Function slug (actionType)
- `status` - pending, running, success, error
- `input`, `output`, `error` - JSONB data
- `credential_fetch_ms` - Time to resolve credentials
- `routing_ms` - Time to resolve OpenFunction URL
- `execution_ms` - Actual function execution time
- `routed_to` - Service that handled execution (e.g., "fn-openai")
- `was_cold_start` - Boolean flag for cold start detection

**credential_access_logs** (compliance/debugging):
- `id` - Log entry ID
- `execution_id` - FK to workflow_executions
- `node_id` - Node that requested credentials
- `integration_type` - e.g., "openai", "slack"
- `credential_keys` - JSONB array of resolved keys
- `source` - `dapr_secret`, `request_body`, or `not_found`
- `fallback_attempted` - Boolean
- `fallback_reason` - Why fallback was needed

**workflow_external_events** (approval audit trail):
- `id` - Event ID
- `execution_id` - FK to workflow_executions
- `node_id` - Approval gate node ID
- `event_name` - e.g., "plan-approval"
- `event_type` - `approval_request`, `approval_response`, `timeout`
- `timeout_seconds`, `expires_at` - Timeout configuration
- `approved`, `reason`, `responded_by` - Response details
- `payload` - JSONB event payload

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `DATABASE_URL` | PostgreSQL connection string | (required) |
| `BETTER_AUTH_SECRET` | Auth encryption secret | (required) |
| `NEXT_PUBLIC_APP_URL` | Public app URL | `http://localhost:3000` |
| `WORKFLOW_ORCHESTRATOR_URL` | Orchestrator service URL | `http://workflow-orchestrator:8080` |
| `DAPR_ORCHESTRATOR_URL` | Planner-dapr-agent proxy URL | `http://planner-dapr-agent:8000` |
| `FUNCTION_RUNNER_APP_ID` | Function router Dapr app-id | `function-router` |
| `DAPR_HOST` | Dapr sidecar host | `localhost` |
| `DAPR_HTTP_PORT` | Dapr HTTP port | `3500` |
| `DAPR_SECRETS_STORE` | Dapr secret store name | `azure-keyvault` |
| `AP_ENCRYPTION_KEY` | AES-256 key for app connection encryption (32-char hex) | (required for AP) |
| `INTERNAL_API_TOKEN` | Token for internal decrypt API (service-to-service) | (required for AP) |

## Deployment (Kind Cluster)

The app runs in the `workflow-builder` namespace with:
- `workflow-builder` Deployment (1 replica, port 3000)
- `workflow-orchestrator` Deployment (1 replica, port 8080) with Dapr sidecar
- `planner-dapr-agent` Deployment (1 replica, port 8000) with Dapr sidecar
- `function-router` Deployment (1 replica, port 8080) with Dapr sidecar
- `fn-activepieces` Deployment (1 replica, port 8080) - AP piece executor with 26 packages
- 8 OpenFunctions (fn-openai, fn-slack, fn-github, fn-resend, fn-stripe, fn-linear, fn-firecrawl, fn-perplexity) as Knative Services
- `postgresql` StatefulSet (1 replica, port 5432)
- `redis` for Dapr workflow state store
- Ingress via `ingress-nginx` at `workflow-builder.cnoe.localtest.me:8443`

Images are pushed to the Gitea registry at `gitea.cnoe.localtest.me:8443/giteaadmin/`.

### Build Images

```bash
# Build core images (all use project root as context)
docker build -t gitea.cnoe.localtest.me:8443/giteaadmin/workflow-builder:latest .
docker build -t gitea.cnoe.localtest.me:8443/giteaadmin/workflow-orchestrator:latest -f services/workflow-orchestrator/Dockerfile .
docker build -t gitea.cnoe.localtest.me:8443/giteaadmin/planner-dapr-agent:latest -f services/planner-dapr-agent/Dockerfile .
docker build -t gitea.cnoe.localtest.me:8443/giteaadmin/function-router:latest -f services/function-router/Dockerfile .
docker build -t gitea.cnoe.localtest.me:8443/giteaadmin/fn-activepieces:latest -f services/fn-activepieces/Dockerfile .

# Build OpenFunction images (8 total)
docker build -t gitea.cnoe.localtest.me:8443/giteaadmin/fn-openai:latest -f services/fn-openai/Dockerfile services/fn-openai
docker build -t gitea.cnoe.localtest.me:8443/giteaadmin/fn-slack:latest -f services/fn-slack/Dockerfile services/fn-slack
# ... (remaining 6 OpenFunctions)

# Push images
docker push gitea.cnoe.localtest.me:8443/giteaadmin/workflow-builder:latest
docker push gitea.cnoe.localtest.me:8443/giteaadmin/workflow-orchestrator:latest
docker push gitea.cnoe.localtest.me:8443/giteaadmin/planner-dapr-agent:latest
docker push gitea.cnoe.localtest.me:8443/giteaadmin/function-router:latest
docker push gitea.cnoe.localtest.me:8443/giteaadmin/fn-activepieces:latest
```

### Automatic Setup on Cluster Deploy

The following happens automatically during `cluster-recreate`:

1. **PostgreSQL deployed** (ArgoCD sync wave 10)
2. **Admin user seeded** (wave 20): `admin@example.com` / `developer`
3. **Functions seeded** (wave 25): 37 builtin functions from plugin registry
4. **Services deployed** (wave 30+): orchestrator, planner-dapr-agent, function-router, workflow-builder
5. **OpenFunction infrastructure deployed** (wave 40-45): gateway, shared infra
6. **OpenFunctions deployed** (wave 50): 8 Knative serverless functions

See `serverless-functions-auto-setup.md` for details.

## Dapr Secrets Integration

Function-router supports auto-injection of API keys from Azure Key Vault via Dapr secrets.

### Secret Mappings

| Secret Name | Environment Variable | Used By |
|-------------|---------------------|---------|
| `openai-api-key` | `OPENAI_API_KEY` | openai/* functions |
| `anthropic-api-key` | `ANTHROPIC_API_KEY` | anthropic/* functions, planner-dapr-agent |
| `slack-bot-token` | `SLACK_BOT_TOKEN` | slack/* functions |
| `github-token` | `GITHUB_TOKEN` | github/* functions, planner-dapr-agent |
| `resend-api-key` | `RESEND_API_KEY` | resend/* functions |

### Credential Resolution Priority

1. **Dapr Secret Store** (Azure Key Vault) - automatic based on plugin type
2. **App Connections** (encrypted in DB) - AP piece credentials via internal decrypt API
3. **Request body** - credentials passed directly in execution request (legacy fallback)

## Dapr Component Scoping

Dapr components are scoped to specific app-ids:

| Component | Scoped To |
|-----------|-----------|
| `workflowstatestore` (Redis) | workflow-orchestrator, planner-dapr-agent |
| `workflowpubsub` (Redis) | workflow-orchestrator, planner-dapr-agent |
| `azure-keyvault` (Secrets) | workflow-orchestrator, function-router, planner-dapr-agent |

## Development Workflow

### Local Development (DevSpace)

```bash
devspace dev  # Starts dev mode with file sync
```

**What's synced**:
- `app/`, `components/`, `lib/`, `plugins/` - Hot reload enabled
- `services/` - Excluded (separate deployments)

**For backend changes**:
```bash
# Rebuild and restart services (use project root as context)
docker build -t gitea.cnoe.localtest.me:8443/giteaadmin/workflow-orchestrator:latest -f services/workflow-orchestrator/Dockerfile .
docker push gitea.cnoe.localtest.me:8443/giteaadmin/workflow-orchestrator:latest
kubectl rollout restart deployment/workflow-orchestrator -n workflow-builder

docker build -t gitea.cnoe.localtest.me:8443/giteaadmin/planner-dapr-agent:latest -f services/planner-dapr-agent/Dockerfile .
docker push gitea.cnoe.localtest.me:8443/giteaadmin/planner-dapr-agent:latest
kubectl rollout restart deployment/planner-dapr-agent -n workflow-builder

docker build -t gitea.cnoe.localtest.me:8443/giteaadmin/function-router:latest -f services/function-router/Dockerfile .
docker push gitea.cnoe.localtest.me:8443/giteaadmin/function-router:latest
kubectl rollout restart deployment/function-router -n workflow-builder
```

### Testing Workflows

**Via UI**:
1. Open https://workflow-builder.cnoe.localtest.me:8443
2. Create workflow with action nodes
3. Click "Run"

**Via API**:
```bash
curl -X POST https://workflow-builder.cnoe.localtest.me:8443/api/workflows/{workflowId}/execute \
  -H "Content-Type: application/json" \
  -d '{"triggerData": {}}'
```

## Troubleshooting

### Workflow Execution Fails

**Check orchestrator logs**:
```bash
kubectl logs -n workflow-builder -l app=workflow-orchestrator -c workflow-orchestrator --tail=50
```

**Check planner-dapr-agent logs**:
```bash
kubectl logs -n workflow-builder -l app=planner-dapr-agent -c planner-dapr-agent --tail=50
```

**Check function-router logs**:
```bash
kubectl logs -n workflow-builder -l app=function-router -c function-router --tail=50
```

**Check fn-activepieces logs**:
```bash
kubectl logs -n workflow-builder -l app=fn-activepieces --tail=50
```

**Common issues**:
- Missing `actionType` in node config → UI bug, recreate node
- Function not found → Check `functions` table, run `pnpm seed-functions`
- Missing credentials → Add API keys to Azure Key Vault or create app connections
- Planner timeout → Check planner-dapr-agent logs, increase timeout in node config
- CallId mismatch in activity tab → ToolCallItem uses Pydantic `.call_id`, ToolCallOutputItem uses dict `['call_id']`
- AP piece not showing in palette → Check `lib/activepieces/installed-pieces.ts` and re-sync piece metadata
- OAuth2 token expired → Auto-refresh should handle; check `AP_ENCRYPTION_KEY` is set correctly
- AP credential decrypt fails → Verify `INTERNAL_API_TOKEN` matches between Next.js app and function-router
- AP dynamic dropdown empty → Check fn-activepieces `/options` endpoint logs, verify connection is active

### Database Issues

**Check function seeding**:
```bash
kubectl exec -n workflow-builder postgresql-0 -- \
  psql -U postgres -d workflow_builder -c "SELECT COUNT(*) FROM functions;"
```

**Re-seed functions**:
```bash
kubectl delete job seed-functions -n workflow-builder
kubectl apply -f packages/components/active-development/manifests/workflow-builder/Job-seed-functions.yaml
```

## Migration Notes

### Vercel → Dapr Migration (Complete)

The codebase was fully migrated from Vercel Workflow DevKit to Dapr:
- Removed: `"use workflow"`, `"use step"` directives, `withWorkflow()` wrapper
- Added: Dapr workflow orchestrator, function-router, dynamic workflow interpreter

### Legacy Field Migration (Complete)

All workflows use `actionType` only:
- Removed: `functionSlug`, `activityName` fields
- Canonical: `actionType` field (current)

### Planner Service Consolidation (Complete)

All planner functionality consolidated into `planner-dapr-agent`:
- Removed: `planner-orchestrator` (legacy Python orchestrator)
- Removed: `planner-sdk-agent` (Claude Code SDK wrapper)
- Active: `planner-dapr-agent` (OpenAI Agents SDK with Dapr durability)

### Integrations → App Connections Migration (Complete)

Legacy `integrations` table replaced with Activepieces-aligned `app_connections`:
- Removed: `integrations` table, `lib/db/integrations.ts`, `lib/credential-fetcher.ts`, `/api/integrations/*` routes
- Added: `app_connections` table with AES-256-CBC encryption, `piece_metadata` table, `workflow_connection_refs` table
- Added: OAuth2 PKCE flow, auto token refresh, internal decrypt API
- Added: `fn-activepieces` service with 26 pre-installed AP piece packages
- Added: AP workflow walker in orchestrator (`ap_workflow.py`) for Dapr-native AP flow execution
- UI: Action palette shows both builtin plugins and installed AP pieces

### Duplicate Activities Removed (Complete)

Legacy Dapr activity registrations removed from `dapr-activity-registry.ts`:
- Removed: `generate_text`, `generate_image`, `send_email`, `send_slack_message`, `http_request`
- All function execution now uses plugin registry + action nodes

**Remaining Dapr activities** are for workflow control flow only:
- Planner: `call_planner_clone`, `call_planner_plan`, `call_planner_execute`, `call_planner_multi_step`
- Events: `publish_event`, `publish_phase_changed`, `publish_workflow_started`, `publish_workflow_completed`
- Control flow: `approval-gate`, `timer`
- Observability: `log_external_event`, `log_approval_request`, `log_approval_response`, `log_approval_timeout`

---

**Last Updated**: 2026-02-08
**Architecture**: Dapr workflow orchestration + OpenAI Agents SDK planner + Knative serverless functions + Activepieces integration
**Status**: Production-ready with event streaming, credential audit, sandbox execution, and 26 AP piece connectors

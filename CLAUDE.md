# Workflow Builder

Visual workflow builder with Dapr workflow orchestration. The Next.js app serves as a UI + BFF proxy layer; all workflow execution lives in Dapr on Kubernetes.

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                     Kubernetes Cluster                          │
│                                                                 │
│  ┌─────────────────┐    ┌─────────────────────────────────────┐│
│  │  Next.js App    │    │  workflow-orchestrator              ││
│  │  (no sidecar)   │───▶│  TypeScript Dapr Workflow Runtime   ││
│  │                 │    │  - Dynamic workflow interpreter      ││
│  │  Port 3000      │    │  - Generic orchestration            ││
│  └─────────────────┘    │  - External event handling          ││
│                         └──────────────┬──────────────────────┘│
│                                        │                        │
│                                        │ Dapr Service Invocation│
│                                        ▼                        │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │         function-router (K8s Deployment)                  │  │
│  │  Routes function execution to OpenFunctions               │  │
│  │  - Credential pre-fetching from Dapr secrets             │  │
│  │  - Dynamic Knative URL resolution                        │  │
│  │  - Registry-based routing (wildcard support)             │  │
│  └──────────────┬───────────────────────────────────────────┘  │
│                 │                                               │
│                 │ Direct HTTP to Knative Services              │
│                 ▼                                               │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │  OpenFunctions (Knative Scale-to-Zero)                    │  │
│  │  - fn-openai (text & image generation)                   │  │
│  │  - fn-slack (messaging)                                   │  │
│  │  - fn-github (repository operations)                      │  │
│  │  - fn-resend (email delivery)                            │  │
│  │  - fn-stripe (payments)                                   │  │
│  │  - fn-linear (issue tracking)                            │  │
│  │  - fn-firecrawl (web scraping)                           │  │
│  │  - fn-perplexity (AI search)                             │  │
│  └──────────────────────────────────────────────────────────┘  │
│                                                                 │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐          │
│  │    Redis     │  │  PostgreSQL  │  │   Jaeger     │          │
│  │  (Dapr state)│  │  (workflows, │  │  (tracing)   │          │
│  │              │  │   functions)  │  │              │          │
│  └──────────────┘  └──────────────┘  └──────────────┘          │
└─────────────────────────────────────────────────────────────────┘
```

The Next.js app makes direct HTTP calls to the orchestrator service. No Dapr sidecar is needed on the Next.js side.

## Tech Stack

- **Frontend**: Next.js 16, React 19, React Flow (@xyflow/react), Jotai state management, shadcn/ui
- **Backend**: Next.js API routes (BFF proxy to Dapr orchestrator)
- **Database**: PostgreSQL via Drizzle ORM
- **Auth**: Better Auth (email/password, anonymous users)
- **Workflow Engine**: Dapr Workflow SDK (TypeScript) via workflow-orchestrator
- **Function Execution**: function-router service → OpenFunctions (Knative serverless)
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
  workflows/[workflowId]/page.tsx  # Workflow editor page
  (auth)/                        # Sign-in/sign-up pages

lib/
  workflow-definition.ts         # Shared types for workflow definitions
  workflow-store.ts              # Jotai atoms, node/edge types
  dapr-activity-registry.ts      # Dapr workflow primitives (approval gates, timers)
  db/schema.ts                   # Drizzle ORM schema (PostgreSQL)
  db/migrate.ts                  # Migration runner (bundled with esbuild for Docker)

services/
  workflow-orchestrator/         # TypeScript Dapr orchestrator
    src/
      index.ts                   # Fastify + Dapr workflow runtime
      core/types.ts              # Shared type definitions
      core/template-resolver.ts  # {{node.field}} variable resolution
      workflows/dynamic-workflow.ts  # Single interpreter workflow
      activities/execute-action.ts   # Calls function-runner for execution
      routes/workflows.ts        # /api/v2/workflows/* endpoints
  function-runner/               # Executes serverless functions
    src/
      index.ts                   # Fastify server
      routes/execute.ts          # POST /execute endpoint
      core/function-loader.ts    # Loads functions from database
      core/credential-service.ts # Dapr secrets + DB credential lookup
      handlers/
        builtin.ts               # Builtin function handlers
        oci.ts                   # OCI container execution (future)
        http.ts                  # HTTP webhook execution (future)

components/workflow/
  workflow-canvas.tsx            # React Flow canvas with node types
  node-config-panel.tsx          # Properties/Code/Runs tabs
  nodes/                         # Node components (trigger, action, etc.)
  config/
    action-config.tsx            # Action node configuration
    activity-config.tsx          # Activity node configuration (Dapr primitives)

plugins/                         # Plugin registry (OpenAI, Slack, GitHub, etc.)
  registry.ts                    # Plugin registration and discovery
  openai/                        # OpenAI plugin (text/image generation)
  slack/                         # Slack plugin (send messages)
  github/                        # GitHub plugin (create issues, etc.)
  resend/                        # Resend plugin (send emails)
  ...
```

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
2. Activity invokes function-runner via Dapr
3. Function-runner loads function by `actionType` slug
4. Executes builtin handler from plugin
5. Returns result to orchestrator

**Examples**:
- `openai/generate-text` - AI text generation
- `openai/generate-image` - AI image generation
- `slack/send-message` - Send Slack message
- `github/create-issue` - Create GitHub issue
- `resend/send-email` - Send email
- `system/http-request` - HTTP client

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
```typescript
for (const nodeId of definition.executionOrder) {
  const node = definition.nodes.find(n => n.id === nodeId);

  if (node.type === "action") {
    // Execute function
    yield ctx.callActivity(executeAction, {
      node,
      nodeOutputs,
      integrations,
    });
  }

  if (node.type === "approval-gate") {
    // Wait for external event
    const event = ctx.waitForExternalEvent(eventName);
    const timeout = ctx.createTimer(timeoutSeconds);
    yield whenAny([event, timeout]);
  }
}
```

### 4. Function Execution

**executeAction activity** → `services/workflow-orchestrator/src/activities/execute-action.ts`:
```typescript
const actionType = config.actionType;  // "openai/generate-text"

// Invoke function-router via Dapr
const response = await client.invoker.invoke(
  "function-router",
  "execute",
  HttpMethod.POST,
  {
    function_slug: actionType,
    execution_id: executionId,
    workflow_id: workflowId,
    node_id: node.id,
    node_name: nodeName,
    input: resolvedConfig,
    integrations: integrations,
  }
);
```

**function-router** → Routes based on registry:
1. Lookup `actionType` in registry (exact match → wildcard → default)
2. For OpenFunction: Pre-fetch credentials from Dapr secret store
3. Resolve Knative service URL via Kubernetes API
4. Direct HTTP POST to OpenFunction

**OpenFunction (fn-openai)** → `services/fn-openai/src/index.ts`:
```typescript
app.post("/execute", async (request, reply) => {
  const { step, input, credentials } = request.body;

  // Route to handler
  if (step === "generate-text") {
    return await generateTextStep(input, credentials);
  }
});
```

### 5. Result Returned

**OpenFunction** → **function-router** → **orchestrator** → **database** → **UI**

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

**Key field**: `config.actionType` - This is the canonical function slug used by the orchestrator and function-runner to identify functions.

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `DATABASE_URL` | PostgreSQL connection string | (required) |
| `BETTER_AUTH_SECRET` | Auth encryption secret | (required) |
| `NEXT_PUBLIC_APP_URL` | Public app URL | `http://localhost:3000` |
| `WORKFLOW_ORCHESTRATOR_URL` | Orchestrator service URL | `http://workflow-orchestrator:8080` |
| `FUNCTION_RUNNER_APP_ID` | Function router Dapr app-id (ConfigMap uses this name) | `function-router` |
| `DAPR_HOST` | Dapr sidecar host | `localhost` |
| `DAPR_HTTP_PORT` | Dapr HTTP port | `3500` |
| `DAPR_SECRETS_STORE` | Dapr secret store name | `azure-keyvault` |

## Deployment (Kind Cluster)

The app runs in the `workflow-builder` namespace with:
- `workflow-builder` Deployment (1 replica, port 3000)
- `workflow-orchestrator` Deployment (1 replica, port 8080) with Dapr sidecar
- `function-router` Deployment (1 replica, port 8080) with Dapr sidecar
- 8 OpenFunctions (fn-openai, fn-slack, fn-github, fn-resend, fn-stripe, fn-linear, fn-firecrawl, fn-perplexity) as Knative Services
- `postgresql` StatefulSet (1 replica, port 5432)
- `redis` for Dapr workflow state store
- Ingress via `ingress-nginx` at `workflow-builder.cnoe.localtest.me:8443`

Images are pushed to the Gitea registry at `gitea.cnoe.localtest.me:8443/giteaadmin/`.

### Build Images

```bash
# Build core images
docker build -t gitea.cnoe.localtest.me:8443/giteaadmin/workflow-builder:latest .
docker build -t gitea.cnoe.localtest.me:8443/giteaadmin/workflow-orchestrator:latest -f services/workflow-orchestrator/Dockerfile services/workflow-orchestrator
docker build -t gitea.cnoe.localtest.me:8443/giteaadmin/function-router:latest -f services/function-router/Dockerfile services/function-router

# Build OpenFunction images (8 total)
docker build -t gitea.cnoe.localtest.me:8443/giteaadmin/fn-openai:latest -f services/fn-openai/Dockerfile services/fn-openai
docker build -t gitea.cnoe.localtest.me:8443/giteaadmin/fn-slack:latest -f services/fn-slack/Dockerfile services/fn-slack
# ... (remaining 6 OpenFunctions)

# Push images
docker push gitea.cnoe.localtest.me:8443/giteaadmin/workflow-builder:latest
docker push gitea.cnoe.localtest.me:8443/giteaadmin/workflow-orchestrator:latest
docker push gitea.cnoe.localtest.me:8443/giteaadmin/function-router:latest
```

### Automatic Setup on Cluster Deploy

The following happens automatically during `cluster-recreate`:

1. **PostgreSQL deployed** (ArgoCD sync wave 10)
2. **Admin user seeded** (wave 20): `admin@example.com` / `developer`
3. **Functions seeded** (wave 25): 37 builtin functions from plugin registry
4. **OpenFunction infrastructure deployed** (wave 40-45): gateway, shared infra
5. **OpenFunctions deployed** (wave 50): 8 Knative serverless functions
6. **Services deployed** (wave 30+): orchestrator, function-router, workflow-builder

See `serverless-functions-auto-setup.md` for details.

## Dapr Secrets Integration

Function-runner supports auto-injection of API keys from Azure Key Vault via Dapr secrets.

### Secret Mappings

| Secret Name | Environment Variable | Used By |
|-------------|---------------------|---------|
| `openai-api-key` | `OPENAI_API_KEY` | openai/* functions |
| `anthropic-api-key` | `ANTHROPIC_API_KEY` | anthropic/* functions |
| `slack-bot-token` | `SLACK_BOT_TOKEN` | slack/* functions |
| `github-token` | `GITHUB_TOKEN` | github/* functions |
| `resend-api-key` | `RESEND_API_KEY` | resend/* functions |

### Credential Resolution Priority

1. **Dapr Secret Store** (Azure Key Vault) - automatic based on plugin type
2. **Database** - user-configured integrations as fallback

## Development Workflow

### Local Development (DevSpace)

```bash
devspace dev  # Starts dev mode with file sync
```

**What's synced**:
- ✅ `app/`, `components/`, `lib/`, `plugins/` - Hot reload enabled
- ❌ `services/` - Excluded (separate deployments)

**For backend changes**:
```bash
# Rebuild and restart services
docker build -t gitea.cnoe.localtest.me:8443/giteaadmin/workflow-orchestrator:latest -f services/workflow-orchestrator/Dockerfile services/workflow-orchestrator
docker push gitea.cnoe.localtest.me:8443/giteaadmin/workflow-orchestrator:latest
kubectl rollout restart deployment/workflow-orchestrator -n workflow-builder
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

**Check function-runner logs**:
```bash
kubectl logs -n workflow-builder -l app=function-runner -c function-runner --tail=50
```

**Common issues**:
- Missing `actionType` in node config → UI bug, recreate node
- Function not found → Check `functions` table, run `pnpm seed-functions`
- Missing credentials → Add API keys to Azure Key Vault or integrations

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
- ❌ Removed: `"use workflow"`, `"use step"` directives
- ❌ Removed: `withWorkflow()` wrapper
- ✅ Added: Dapr workflow orchestrator
- ✅ Added: Function-runner service
- ✅ Added: Dynamic workflow interpreter

### Legacy Field Migration (Complete)

All workflows have been migrated to use `actionType` only:
- ❌ Removed: `functionSlug` field (legacy)
- ❌ Removed: `activityName` field (legacy)
- ✅ Canonical: `actionType` field (current)

**No backwards compatibility** - all code uses `actionType` exclusively.

### Duplicate Activities Removed (Complete)

Legacy Dapr activity registrations removed from `dapr-activity-registry.ts`:
- ❌ Removed: `generate_text`, `generate_image`, `send_email`, `send_slack_message`, `http_request`
- ✅ Use plugins: All function execution now uses plugin registry + action nodes

**Remaining Dapr activities** are for workflow control flow only:
- Planner-agent: `run_planning`, `persist_tasks`, `run_execution`, `publish_event`
- Control flow: `approval-gate`, `timer`

## Related Documentation

- **serverless-functions-auto-setup.md** - Automatic setup during cluster-recreate
- **function-test-results.md** - Test results and verification
- **devspace.yaml** - Development environment configuration
- **scripts/migrate-workflow-nodes.ts** - Migration script for legacy workflows

---

**Last Updated**: 2026-02-05
**Architecture**: Clean actionType-only system
**Status**: Production-ready

# Workflow Builder

Visual workflow builder adapted from Vercel Workflow DevKit to Dapr workflow orchestration. The Next.js app serves as a UI + BFF proxy layer; all workflow execution lives in Dapr on Kubernetes.

## Architecture

```
Browser --> Next.js API (proxy) --> Dapr Orchestrator (K8s) --> Activities --> Services
```

The Next.js app makes direct HTTP calls to the orchestrator service. No Dapr sidecar is needed on the Next.js side.

## Tech Stack

- **Frontend**: Next.js 16, React 19, React Flow (@xyflow/react), Jotai state management, shadcn/ui
- **Backend**: Next.js API routes (BFF proxy to Dapr orchestrator)
- **Database**: PostgreSQL via Drizzle ORM
- **Auth**: Better Auth (email/password, anonymous users)
- **Workflow Engine**: Dapr Workflow SDK (Python) via planner-orchestrator
- **Deployment**: Docker (multi-stage), Kind cluster, ingress-nginx

## Key Commands

```bash
pnpm dev              # Start dev server
pnpm build            # Production build (runs discover-plugins first)
pnpm db:generate      # Generate Drizzle migrations
pnpm db:push          # Push schema to DB
pnpm db:migrate       # Run migrations
pnpm discover-plugins # Generate plugin manifest
```

## Project Structure

```
app/
  api/
    dapr/workflows/              # Dapr proxy API routes
      route.ts                   #   POST - start workflow
      [id]/status/route.ts       #   GET  - poll status
      [id]/tasks/route.ts        #   GET  - fetch tasks from statestore
      [id]/approve/route.ts      #   POST - approve/reject plan
      [id]/events/route.ts       #   GET  - SSE event stream
    workflow/[workflowId]/
      execute/route.ts           # Session-auth execution (Dapr or legacy)
    workflows/[workflowId]/
      webhook/route.ts           # API-key-auth webhook execution
  workflows/[workflowId]/page.tsx  # Workflow editor page
  (auth)/                        # Sign-in/sign-up pages

lib/
  dapr-client.ts                 # HTTP client for Dapr orchestrator API
  dapr-activity-registry.ts      # Activity definitions (planner-agent activities)
  dapr-codegen.ts                # Python/YAML code generation for Dapr nodes
  workflow-store.ts              # Jotai atoms, node/edge types
  db/schema.ts                   # Drizzle ORM schema (PostgreSQL)
  db/migrate.ts                  # Migration runner (bundled with esbuild for Docker)

components/workflow/
  workflow-canvas.tsx            # React Flow canvas with node types
  node-config-panel.tsx          # Properties/Code/Runs tabs
  nodes/                         # Node components (trigger, action, activity, etc.)

plugins/                         # Plugin registry (System, AI Gateway, Blob, etc.)
```

## Vercel-to-Dapr Migration

### What was removed

- `withWorkflow()` wrapper from `next.config.ts`
- `"workflow"` dependency from `package.json` (Vercel Workflow DevKit)
- `lib/workflow-executor.workflow.ts` (Vercel executor)
- All `"use workflow"` / `"use step"` directive references
- Legacy Vercel execution path now returns an error message directing migration to Dapr

### What was added

#### Database schema extensions (`lib/db/schema.ts`)

**`workflows` table:**
- `engineType` (text, default `"dapr"`) -- discriminates workflow engine
- `daprWorkflowName` (text, nullable) -- registered Dapr workflow name
- `daprOrchestratorUrl` (text, nullable) -- URL of the Dapr orchestrator service

**`workflowExecutions` table:**
- `daprInstanceId` (text, nullable) -- Dapr workflow instance ID for correlation
- `phase` (text, nullable) -- current phase from Dapr custom status
- `progress` (integer, nullable) -- 0-100 progress percentage

**`workflowExecutionLogs` table:**
- `activityName` (text, nullable) -- Dapr activity function name

#### Dapr API client (`lib/dapr-client.ts`)

Proxy client aligned with the planner-orchestrator's FastAPI endpoints (Pydantic models):

| Method | Orchestrator Endpoint | Request | Response |
|--------|----------------------|---------|----------|
| `startWorkflow` | `POST /api/workflows` | `{feature_request, cwd}` | `{workflow_id, status}` |
| `getWorkflowStatus` | `GET /api/workflows/{id}/status` | -- | `{workflow_id, runtime_status, phase, progress, message, output}` |
| `getWorkflowTasks` | `GET /api/workflows/{id}/tasks` | -- | `{workflow_id, tasks, count}` |
| `approveWorkflow` | `POST /api/workflows/{id}/approve` | `{approved, reason}` | `{status, workflow_id}` |

The `orchestratorUrl` is stored per-workflow in the DB or defaults to `DAPR_ORCHESTRATOR_URL` env var (default: `http://planner-orchestrator:8080`).

#### New node types (`lib/workflow-store.ts`)

Extended `WorkflowNodeType` with Dapr-specific types:

| Node Type | Dapr Concept | Planner Example |
|-----------|-------------|-----------------|
| `activity` | `ctx.call_activity(fn, input)` | `run_planning`, `persist_tasks`, `run_execution` |
| `approval-gate` | `ctx.wait_for_external_event()` + `when_any()` | Plan approval with 24h timeout |
| `timer` | `ctx.create_timer(timedelta)` | 24-hour timeout |
| `publish-event` | Pub/sub publish activity | Phase transition events |

#### Activity registry (`lib/dapr-activity-registry.ts`)

Four planner-agent activities registered, aligned with `planner-orchestrator/activities/*.py`:

| Activity | Service | Timeout | Description |
|----------|---------|---------|-------------|
| `run_planning` | `planner-agent-plan` | 600s | Invokes planning agent to generate tasks |
| `persist_tasks` | (statestore) | 30s | Saves tasks to Redis under `tasks:{workflow_id}` |
| `run_execution` | `planner-agent-exec` | 1800s | Executes approved plan tasks |
| `publish_event` | (pub/sub) | 10s | Publishes to `workflow.stream` topic |

#### Code generation (`lib/dapr-codegen.ts`)

Generates Python Dapr workflow code from the visual node graph:
- **Workflow-level**: Full `workflow/{name}.py` with `DaprWorkflowContext`, `call_activity()`, `wait_for_external_event()`, `create_timer()`
- **Node-level**: Individual activity function files with input/output specs
- **Infrastructure**: Dapr component YAML files (statestore.yaml, pubsub.yaml)

The Code tab in the UI shows `workflow/{name}.py` when no node is selected, and the node-specific code when an activity/timer/approval node is selected.

#### Proxy API routes (`app/api/dapr/workflows/`)

All routes authenticate via Better Auth session and proxy to the Dapr orchestrator:

- `POST /api/dapr/workflows` -- Creates execution record, calls `daprClient.startWorkflow()`, stores `workflow_id`
- `GET /api/dapr/workflows/[id]/status` -- Polls orchestrator, maps `runtime_status` to local status, updates DB
- `GET /api/dapr/workflows/[id]/tasks` -- Fetches from statestore, unwraps `{tasks, count}` wrapper
- `POST /api/dapr/workflows/[id]/approve` -- Raises external event in Dapr workflow
- `GET /api/dapr/workflows/[id]/events` -- SSE stream polling orchestrator every 2s

#### Execution routes

Two execution entry points, both support Dapr:

- `POST /api/workflow/[workflowId]/execute` -- Session-authenticated, used by the Run button
- `POST /api/workflows/[workflowId]/webhook` -- API-key-authenticated, used by external triggers

Both extract `feature_request` and `cwd` from the input body and call `daprClient.startWorkflow()`. Legacy (non-Dapr) workflows return an error directing users to migrate.

### What was reused (~75%)

- React Flow canvas, all node rendering components
- Node config panel with Properties/Code/Runs tabs
- Jotai state management (extended, not replaced)
- Database infrastructure (Drizzle ORM, PostgreSQL)
- Authentication (Better Auth)
- All UI components (shadcn, layout, dialogs)
- Plugin registry (System, AI Gateway, Blob, Clerk, fal.ai, GitHub, Linear, etc.)
- Undo/redo, autosave, template variable system
- API client pattern, API key management

## Orchestrator API Contract

The Dapr client types are aligned with the planner-orchestrator's Pydantic models. Key fields:

- **Status field**: `runtime_status` (not `status`) -- values: `RUNNING`, `COMPLETED`, `FAILED`, `TERMINATED`, `PENDING`
- **ID field**: `workflow_id` (not `instance_id`)
- **Status structure**: Flat (not nested under `custom_status`)
- **Phases**: `planning`, `persisting`, `awaiting_approval`, `executing`, `completed`, `failed`, `rejected`, `timed_out`
- **Start request**: `{feature_request: string, cwd: string}` (not `{workflow_name, input}`)
- **Tasks response**: Wrapped in `{workflow_id, tasks, count}` (not a flat array)

## Docker Build

Multi-stage Dockerfile (3 stages: deps, builder, runner):

1. **deps**: Install pnpm + frozen lockfile dependencies
2. **builder**: Plugin discovery, esbuild-bundle migration script, Next.js build
3. **runner**: Non-root user, standalone output, runs migrations then starts server

```bash
docker build -t workflow-builder .
# CMD: node lib/db/migrate.bundle.js && node server.js
```

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `DATABASE_URL` | PostgreSQL connection string | (required) |
| `BETTER_AUTH_SECRET` | Auth encryption secret | (required) |
| `NEXT_PUBLIC_APP_URL` | Public app URL | `http://localhost:3000` |
| `DAPR_ORCHESTRATOR_URL` | Default orchestrator URL | `http://planner-orchestrator:8080` |

## Deployment (Kind Cluster)

The app runs in the `workflow-builder` namespace with:
- `workflow-builder` Deployment (1 replica, port 3000)
- `postgresql` StatefulSet (1 replica, port 5432)
- Ingress via `ingress-nginx` at `workflow-builder.cnoe.localtest.me:8443`

Images are pushed to the Gitea registry at `gitea.cnoe.localtest.me:8443/giteaadmin/workflow-builder:latest`.

# Workflow Builder Architecture

A visual workflow builder with Dapr-based serverless execution on Kubernetes.

## Table of Contents

- [Overview](#overview)
- [Architecture](#architecture)
- [Components](#components)
- [Data Flow](#data-flow)
- [API Reference](#api-reference)
- [Workflow Definition Schema](#workflow-definition-schema)
- [Function Registry](#function-registry)
- [Deployment](#deployment)
- [Configuration](#configuration)
- [Monitoring & Observability](#monitoring--observability)

---

## Overview

The Workflow Builder is a visual workflow automation platform that enables users to design, execute, and monitor workflows through a drag-and-drop interface. The system uses:

- **Next.js** for the visual builder UI and BFF (Backend for Frontend)
- **Dapr Workflows** for durable, stateful workflow orchestration
- **Knative/KEDA** for serverless function execution with scale-to-zero
- **PostgreSQL** for workflow definitions and function registry
- **Redis** for Dapr workflow state and pub/sub messaging

### Key Features

- Visual drag-and-drop workflow designer
- 44+ built-in functions across 14 integrations
- Support for custom OCI container functions
- External HTTP webhook functions
- Approval gates with timeout handling
- Template variable substitution between nodes
- Real-time execution monitoring

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              Kubernetes Cluster                              │
│                                                                              │
│  ┌────────────────────┐                                                     │
│  │     Ingress        │                                                     │
│  │  (ingress-nginx)   │                                                     │
│  └─────────┬──────────┘                                                     │
│            │                                                                 │
│            ▼                                                                 │
│  ┌────────────────────┐     HTTP        ┌────────────────────────────────┐  │
│  │    Next.js App     │────────────────▶│    workflow-orchestrator       │  │
│  │                    │                 │                                │  │
│  │  • Visual Builder  │                 │  • Dapr Workflow Runtime       │  │
│  │  • BFF API Routes  │                 │  • Dynamic Workflow Interpreter│  │
│  │  • Auth (Better)   │                 │  • Activity Scheduling         │  │
│  │                    │                 │                                │  │
│  │  Port: 3000        │                 │  Port: 8080 + Dapr Sidecar     │  │
│  └────────────────────┘                 └──────────────┬─────────────────┘  │
│            │                                           │                     │
│            │                                           │ Dapr Service        │
│            ▼                                           │ Invocation          │
│  ┌────────────────────┐                               ▼                     │
│  │    PostgreSQL      │     ┌────────────────────────────────────────────┐  │
│  │                    │     │           function-runner                   │  │
│  │  • workflows       │     │                                            │  │
│  │  • functions       │◀───▶│  • Builtin Handlers (44 functions)         │  │
│  │  • executions      │     │  • OCI Container Execution (K8s Jobs)      │  │
│  │  • integrations    │     │  • HTTP Webhook Calls                      │  │
│  │                    │     │                                            │  │
│  │  Port: 5432        │     │  Port: 8080 + Dapr Sidecar                 │  │
│  └────────────────────┘     └──────────────┬─────────────────────────────┘  │
│                                            │                                 │
│                          ┌─────────────────┼─────────────────┐              │
│                          │                 │                 │              │
│                          ▼                 ▼                 ▼              │
│              ┌───────────────┐  ┌───────────────┐  ┌───────────────┐       │
│              │    Builtin    │  │  OCI Function │  │ HTTP Function │       │
│              │   Handlers    │  │   (K8s Job)   │  │   (Webhook)   │       │
│              │               │  │               │  │               │       │
│              │ • OpenAI      │  │ • Custom      │  │ • External    │       │
│              │ • Slack       │  │   containers  │  │   APIs        │       │
│              │ • GitHub      │  │ • Any language│  │ • Webhooks    │       │
│              │ • 14 plugins  │  │               │  │               │       │
│              └───────────────┘  └───────────────┘  └───────────────┘       │
│                                                                              │
│  ┌────────────────────────────────────────────────────────────────────────┐ │
│  │                        Dapr Infrastructure                              │ │
│  │                                                                         │ │
│  │  ┌─────────────────┐  ┌─────────────────┐  ┌─────────────────────────┐ │ │
│  │  │     Redis       │  │  Azure Key      │  │   Azure App Config     │ │ │
│  │  │  State Store    │  │    Vault        │  │   (Dynamic Config)     │ │ │
│  │  │  + Pub/Sub      │  │  (Secrets)      │  │                        │ │ │
│  │  └─────────────────┘  └─────────────────┘  └─────────────────────────┘ │ │
│  └────────────────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## Components

### 1. Next.js Application

The frontend and BFF layer providing:

| Feature | Description |
|---------|-------------|
| Visual Builder | React Flow-based drag-and-drop workflow designer |
| Node Configuration | Properties panel for configuring each workflow node |
| Execution Monitor | Real-time workflow execution status and logs |
| Integration Management | Configure API keys and OAuth connections |
| Authentication | Better Auth with email/password and anonymous users |

**Key Files:**
- `app/workflows/[workflowId]/page.tsx` - Workflow editor
- `app/api/orchestrator/workflows/` - API routes proxying to orchestrator
- `components/workflow/` - React Flow canvas and node components

### 2. Workflow Orchestrator

The Dapr workflow runtime service that:

| Feature | Description |
|---------|-------------|
| Dynamic Interpreter | Executes any workflow definition without code generation |
| Activity Scheduling | Calls function-runner for each action node |
| State Management | Persists workflow state in Redis via Dapr |
| Event Handling | Supports approval gates with external events |
| Timer Support | Creates durable timers for delays and timeouts |

**Technology Stack:**
- TypeScript + Fastify
- Dapr Workflow SDK
- Dapr Sidecar for service invocation

**Key Files:**
- `services/workflow-orchestrator/src/workflows/dynamic-workflow.ts`
- `services/workflow-orchestrator/src/activities/execute-action.ts`
- `services/workflow-orchestrator/src/routes/workflows.ts`

### 3. Function Runner

The serverless function execution service supporting three execution types:

| Type | Description | Use Case |
|------|-------------|----------|
| **builtin** | Statically compiled TypeScript handlers | Standard integrations (OpenAI, Slack, etc.) |
| **oci** | Container images run as K8s Jobs | Custom functions in any language |
| **http** | External HTTP webhook calls | Third-party integrations |

**Key Files:**
- `services/function-runner/src/handlers/builtin.ts`
- `services/function-runner/src/handlers/oci.ts`
- `services/function-runner/src/handlers/http.ts`
- `services/function-runner/src/core/function-loader.ts`

### 4. Dapr Components

| Component | Type | Purpose |
|-----------|------|---------|
| `workflowstatestore` | state.redis | Persist workflow execution state |
| `workflowpubsub` | pubsub.redis | Workflow event messaging |
| `azure-keyvault` | secretstores.azure.keyvault | API key storage |
| `azureappconfig` | configuration.azure.appconfig | Dynamic configuration |

---

## Data Flow

### Workflow Execution Flow

```
1. User triggers workflow via UI or API
                    │
                    ▼
2. Next.js BFF validates and forwards to orchestrator
                    │
                    ▼
3. Orchestrator receives WorkflowDefinition + TriggerData
                    │
                    ▼
4. Dapr schedules dynamicWorkflow with unique instanceId
                    │
                    ▼
5. For each node in executionOrder:
   │
   ├──▶ [action/activity] → Call function-runner via Dapr
   │         │
   │         ├──▶ builtin: Execute TypeScript handler
   │         ├──▶ oci: Create K8s Job, wait for completion
   │         └──▶ http: Call external webhook
   │
   ├──▶ [approval-gate] → Wait for external event or timeout
   │
   ├──▶ [timer] → Create Dapr timer
   │
   └──▶ [condition] → Evaluate and branch
                    │
                    ▼
6. Workflow completes, outputs stored in state
                    │
                    ▼
7. Status available via GET /api/v2/workflows/{id}/status
```

### Template Variable Resolution

Node outputs can be referenced in subsequent nodes using template syntax:

```
{{nodeName.field}}           → Access output field
{{nodeName.nested.field}}    → Access nested field
{{trigger.inputField}}       → Access trigger data
```

**Example:**
```json
{
  "config": {
    "message": "UUID generated: {{GetUUID.data.uuid}}"
  }
}
```

---

## API Reference

### Start Workflow

```http
POST /api/v2/workflows
Content-Type: application/json

{
  "definition": {
    "id": "my-workflow",
    "name": "My Workflow",
    "version": "1.0.0",
    "nodes": [...],
    "edges": [...],
    "executionOrder": ["node-1", "node-2"]
  },
  "triggerData": {
    "input": "value"
  },
  "integrations": {
    "openai": {"apiKey": "sk-..."}
  }
}
```

**Response:**
```json
{
  "instanceId": "my-workflow-1234567890-abc123",
  "workflowId": "my-workflow",
  "status": "started"
}
```

### Get Workflow Status

```http
GET /api/v2/workflows/{instanceId}/status
```

**Response:**
```json
{
  "instanceId": "my-workflow-1234567890-abc123",
  "workflowId": "my-workflow",
  "runtimeStatus": "COMPLETED",
  "phase": "completed",
  "progress": 100,
  "outputs": {
    "trigger": {...},
    "node-1": {"success": true, "data": {...}},
    "node-2": {"success": true, "data": {...}}
  },
  "startedAt": "2026-02-04T18:00:00Z",
  "completedAt": "2026-02-04T18:00:05Z"
}
```

### Raise Event (for Approval Gates)

```http
POST /api/v2/workflows/{instanceId}/events
Content-Type: application/json

{
  "eventName": "approval_node-1",
  "eventData": {
    "approved": true,
    "reason": "Looks good"
  }
}
```

### Additional Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/v2/workflows/{id}/terminate` | Terminate running workflow |
| POST | `/api/v2/workflows/{id}/pause` | Suspend workflow |
| POST | `/api/v2/workflows/{id}/resume` | Resume suspended workflow |
| DELETE | `/api/v2/workflows/{id}` | Purge completed workflow |

### Function Runner API

```http
POST /execute
Content-Type: application/json

{
  "function_slug": "openai/generate-text",
  "execution_id": "exec-123",
  "workflow_id": "wf-456",
  "node_id": "node-1",
  "node_name": "Generate Response",
  "input": {
    "aiPrompt": "Write a haiku about clouds",
    "aiModel": "gpt-4o"
  },
  "node_outputs": {}
}
```

---

## Workflow Definition Schema

### Complete Schema

```typescript
interface WorkflowDefinition {
  id: string;                    // Unique workflow identifier
  name: string;                  // Display name
  version: string;               // Semantic version
  nodes: SerializedNode[];       // Array of workflow nodes
  edges: SerializedEdge[];       // Connections between nodes
  executionOrder: string[];      // Topologically sorted node IDs
  metadata?: {
    description?: string;
    author?: string;
    tags?: string[];
  };
}

interface SerializedNode {
  id: string;                    // Unique node identifier
  type: WorkflowNodeType;        // Node type
  label: string;                 // Display name
  description?: string;          // Optional description
  enabled: boolean;              // Whether node is active
  position: { x: number; y: number };
  config: Record<string, unknown>;
}

type WorkflowNodeType =
  | "trigger"        // Entry point
  | "action"         // Execute function
  | "activity"       // Alias for action
  | "condition"      // Branch logic
  | "approval-gate"  // Wait for approval
  | "timer"          // Delay execution
  | "publish-event"; // Emit event
```

### Node Configuration Examples

#### Action Node (HTTP Request)
```json
{
  "id": "action-1",
  "type": "action",
  "label": "Fetch Data",
  "enabled": true,
  "position": {"x": 200, "y": 100},
  "config": {
    "actionId": "system/http-request",
    "url": "https://api.example.com/data",
    "method": "GET",
    "headers": "{\"Authorization\": \"Bearer {{trigger.token}}\"}"
  }
}
```

#### Action Node (OpenAI)
```json
{
  "id": "action-2",
  "type": "action",
  "label": "Generate Text",
  "enabled": true,
  "position": {"x": 400, "y": 100},
  "config": {
    "actionId": "openai/generate-text",
    "aiModel": "gpt-4o",
    "aiPrompt": "Summarize: {{FetchData.data.content}}",
    "aiFormat": "text"
  }
}
```

#### Approval Gate
```json
{
  "id": "approval-1",
  "type": "approval-gate",
  "label": "Manager Approval",
  "enabled": true,
  "position": {"x": 600, "y": 100},
  "config": {
    "eventName": "manager_approval",
    "timeoutHours": 24,
    "message": "Please review the generated content"
  }
}
```

#### Timer Node
```json
{
  "id": "timer-1",
  "type": "timer",
  "label": "Wait 5 Minutes",
  "enabled": true,
  "position": {"x": 800, "y": 100},
  "config": {
    "durationMinutes": 5
  }
}
```

---

## Function Registry

### Built-in Functions (44 total)

| Plugin | Functions | Description |
|--------|-----------|-------------|
| **openai** | `generate-text`, `generate-image` | AI text and image generation |
| **slack** | `send-message` | Send Slack messages |
| **github** | `create-issue`, `list-issues`, `get-issue`, `update-issue` | GitHub issue management |
| **linear** | `create-ticket`, `find-issues` | Linear project management |
| **stripe** | `create-customer`, `get-customer`, `create-invoice` | Payment processing |
| **resend** | `send-email` | Email delivery |
| **blob** | `put`, `list` | Vercel Blob storage |
| **clerk** | `get-user`, `create-user`, `update-user`, `delete-user` | User management |
| **fal** | `generate-image`, `generate-video`, `upscale-image`, `remove-background`, `image-to-image` | AI media generation |
| **firecrawl** | `scrape`, `search` | Web scraping |
| **perplexity** | `search`, `ask`, `research` | AI search |
| **superagent** | `guard`, `redact` | Content moderation |
| **v0** | `create-chat`, `send-message` | Vercel v0 integration |
| **webflow** | `list-sites`, `get-site`, `publish-site` | Webflow CMS |
| **system** | `http-request` | Generic HTTP calls |

### Database Schema

```sql
CREATE TABLE functions (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  slug TEXT UNIQUE NOT NULL,        -- e.g., "openai/generate-text"
  description TEXT,
  plugin_id TEXT NOT NULL,          -- e.g., "openai"
  version TEXT DEFAULT '1.0.0',
  execution_type TEXT DEFAULT 'builtin',  -- builtin | oci | http

  -- OCI function config
  image_ref TEXT,                   -- Container image reference
  command TEXT,                     -- Override entrypoint
  working_dir TEXT,
  container_env JSONB,

  -- HTTP function config
  webhook_url TEXT,
  webhook_method TEXT DEFAULT 'POST',
  webhook_headers JSONB,
  webhook_timeout_seconds INTEGER DEFAULT 30,

  -- Schema definitions
  input_schema JSONB,               -- JSON Schema for input
  output_schema JSONB,              -- JSON Schema for output

  -- Execution config
  timeout_seconds INTEGER DEFAULT 300,
  retry_policy JSONB,
  max_concurrency INTEGER DEFAULT 0,

  -- Metadata
  integration_type TEXT,            -- For credential lookup
  is_builtin BOOLEAN DEFAULT false,
  is_enabled BOOLEAN DEFAULT true,
  is_deprecated BOOLEAN DEFAULT false,
  created_at TIMESTAMP DEFAULT now(),
  updated_at TIMESTAMP DEFAULT now()
);
```

### Adding Custom Functions

#### OCI Container Function

1. Create a container that reads `INPUT` env var and outputs JSON to stdout:

```typescript
// index.ts
const input = JSON.parse(process.env.INPUT || '{}');
const result = { processed: input.value * 2 };
console.log(JSON.stringify(result));
```

2. Build and push to registry:
```bash
docker build -t gitea.cnoe.localtest.me:8443/functions/my-func:v1 .
docker push gitea.cnoe.localtest.me:8443/functions/my-func:v1
```

3. Register in database:
```sql
INSERT INTO functions (name, slug, plugin_id, execution_type, image_ref)
VALUES ('My Custom Function', 'custom/my-func', 'custom', 'oci',
        'gitea.cnoe.localtest.me:8443/functions/my-func:v1');
```

#### HTTP Webhook Function

```sql
INSERT INTO functions (name, slug, plugin_id, execution_type, webhook_url, webhook_method)
VALUES ('External API', 'external/api-call', 'external', 'http',
        'https://api.example.com/webhook', 'POST');
```

---

## Deployment

### Prerequisites

- Kubernetes cluster (Kind, EKS, GKE, AKS)
- Dapr installed with workflow support
- Redis for state store
- PostgreSQL for persistence
- (Optional) Knative Serving for scale-to-zero
- (Optional) KEDA for event-driven autoscaling

### Deploy with Kustomize

```bash
# Apply all manifests
kubectl apply -k k8s/knative/

# Verify deployment
kubectl get pods -n workflow-builder
kubectl get components.dapr.io -n workflow-builder
```

### Manual Deployment Steps

1. **Create namespace:**
```bash
kubectl create namespace workflow-builder
```

2. **Deploy PostgreSQL:**
```bash
kubectl apply -f k8s/postgresql.yaml
```

3. **Create secrets:**
```bash
kubectl create secret generic workflow-builder-secrets \
  --from-literal=DATABASE_URL=postgresql://postgres:password@postgresql:5432/workflow_builder \
  --from-literal=BETTER_AUTH_SECRET=your-secret-key \
  -n workflow-builder
```

4. **Run database migrations:**
```bash
pnpm db:migrate
pnpm seed-functions
```

5. **Deploy services:**
```bash
kubectl apply -f k8s/knative/workflow-orchestrator.yaml
kubectl apply -f k8s/knative/function-runner.yaml
```

### Docker Images

| Image | Registry Path |
|-------|---------------|
| workflow-builder | `gitea.cnoe.localtest.me:8443/giteaadmin/workflow-builder:latest` |
| workflow-orchestrator | `gitea.cnoe.localtest.me:8443/giteaadmin/workflow-orchestrator:latest` |
| function-runner | `gitea.cnoe.localtest.me:8443/giteaadmin/function-runner:latest` |
| activity-executor | `gitea.cnoe.localtest.me:8443/giteaadmin/activity-executor:latest` |

### Build Images

```bash
# Build all images
docker build -t workflow-builder .
docker build -t workflow-orchestrator -f services/workflow-orchestrator/Dockerfile services/workflow-orchestrator/
docker build -t function-runner -f services/function-runner/Dockerfile .
docker build -t activity-executor -f services/activity-executor/Dockerfile .
```

---

## Configuration

### Environment Variables

#### Next.js Application

| Variable | Description | Default |
|----------|-------------|---------|
| `DATABASE_URL` | PostgreSQL connection string | (required) |
| `BETTER_AUTH_SECRET` | Auth encryption secret | (required) |
| `NEXT_PUBLIC_APP_URL` | Public app URL | `http://localhost:3000` |
| `WORKFLOW_ORCHESTRATOR_URL` | Orchestrator service URL | `http://workflow-orchestrator:8080` |

#### Workflow Orchestrator

| Variable | Description | Default |
|----------|-------------|---------|
| `PORT` | HTTP server port | `8080` |
| `DAPR_HOST` | Dapr sidecar host | `localhost` |
| `DAPR_HTTP_PORT` | Dapr HTTP port | `3500` |
| `DAPR_GRPC_PORT` | Dapr gRPC port | `50001` |
| `FUNCTION_RUNNER_APP_ID` | Function runner Dapr app ID | `function-runner` |
| `USE_FUNCTION_RUNNER` | Use function-runner vs activity-executor | `true` |

#### Function Runner

| Variable | Description | Default |
|----------|-------------|---------|
| `PORT` | HTTP server port | `8080` |
| `DATABASE_URL` | PostgreSQL connection string | (required) |
| `K8S_NAMESPACE` | Kubernetes namespace for jobs | `workflow-builder` |
| `DAPR_SECRETS_STORE` | Dapr secret store component | `azure-keyvault` |
| `SECRETS_FALLBACK_DB` | Fall back to DB for secrets | `true` |

### Dapr Configuration

#### Workflow State Store (Redis)
```yaml
apiVersion: dapr.io/v1alpha1
kind: Component
metadata:
  name: workflowstatestore
spec:
  type: state.redis
  version: v1
  metadata:
    - name: redisHost
      value: "redis-service.dapr-agents.svc.cluster.local:6379"
    - name: actorStateStore
      value: "true"
```

#### Secret Store (Azure Key Vault)
```yaml
apiVersion: dapr.io/v1alpha1
kind: Component
metadata:
  name: azure-keyvault
spec:
  type: secretstores.azure.keyvault
  version: v1
  metadata:
    - name: vaultName
      value: "your-keyvault-name"
    - name: azureClientId
      value: ""  # Uses workload identity
```

---

## Monitoring & Observability

### Health Endpoints

| Service | Endpoint | Description |
|---------|----------|-------------|
| workflow-orchestrator | `/healthz` | Liveness probe |
| workflow-orchestrator | `/readyz` | Readiness probe |
| function-runner | `/healthz` | Liveness probe |
| function-runner | `/readyz` | Readiness probe (checks DB) |
| function-runner | `/status` | Detailed status with function count |

### Distributed Tracing

Tracing is configured via Dapr to Jaeger:

```yaml
spec:
  tracing:
    samplingRate: "1"
    zipkin:
      endpointAddress: "http://jaeger-collector.observability:9411/api/v2/spans"
```

### Logs

```bash
# Orchestrator logs
kubectl logs -l app.kubernetes.io/name=workflow-orchestrator -c workflow-orchestrator

# Function runner logs
kubectl logs -l app.kubernetes.io/name=function-runner -c function-runner

# Dapr sidecar logs
kubectl logs -l app.kubernetes.io/name=workflow-orchestrator -c daprd
```

### Metrics

Dapr exposes Prometheus metrics on port 9090:

```bash
# Get metrics
curl http://localhost:9090/metrics
```

Key metrics:
- `dapr_runtime_workflow_*` - Workflow execution metrics
- `dapr_runtime_service_invocation_*` - Service invocation latency
- `dapr_runtime_component_*` - Component health

---

## Troubleshooting

### Common Issues

#### Workflow stuck in PENDING
```bash
# Check orchestrator logs
kubectl logs deployment/workflow-orchestrator -c workflow-orchestrator

# Verify Dapr sidecar is ready
kubectl logs deployment/workflow-orchestrator -c daprd
```

#### Function execution fails
```bash
# Check function-runner logs
kubectl logs deployment/function-runner -c function-runner

# Test function directly
kubectl run test --rm -it --image=curlimages/curl -- \
  curl -X POST http://function-runner:8080/execute \
  -H "Content-Type: application/json" \
  -d '{"function_slug":"system/http-request",...}'
```

#### Database connection issues
```bash
# Verify PostgreSQL is accessible
kubectl exec deployment/function-runner -c function-runner -- \
  nc -zv postgresql 5432

# Check secret configuration
kubectl get secret workflow-builder-secrets -o yaml
```

### Debug Commands

```bash
# List all workflow-related pods
kubectl get pods -n workflow-builder

# Check Dapr components
kubectl get components.dapr.io -n workflow-builder

# View Dapr configuration
kubectl get configurations.dapr.io -n workflow-builder

# Test inter-service communication
kubectl run test --rm -it --image=curlimages/curl -- \
  curl http://workflow-orchestrator:8080/healthz
```

---

## Version History

| Version | Date | Changes |
|---------|------|---------|
| 1.0.0 | 2026-02-04 | Initial release with Dapr workflow support |

---

## References

- [Dapr Workflows Documentation](https://docs.dapr.io/developing-applications/building-blocks/workflow/)
- [Dapr Service Invocation](https://docs.dapr.io/developing-applications/building-blocks/service-invocation/)
- [Knative Serving](https://knative.dev/docs/serving/)
- [KEDA Autoscaling](https://keda.sh/)

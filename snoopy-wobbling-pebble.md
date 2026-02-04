# Dapr Workflows & Serverless Functions Architecture Research

## Executive Summary

This document provides research and architecture recommendations for persisting and calling functions within Dapr workflows on self-hosted Kubernetes. Based on CNCF graduated projects and production best practices.

---

## Current Architecture Analysis

Your existing setup:
- **Workflow Orchestrator**: TypeScript Dapr SDK with dynamic workflow interpreter
- **Activity Executor**: Fastify service with 35+ statically registered step functions
- **State**: Redis (Dapr) + PostgreSQL (workflow definitions)
- **Deployment**: Knative Service (scale-to-zero) or standard K8s Deployment
- **Secrets**: Azure Key Vault via Dapr secrets component

### Current Limitation
Functions are **statically compiled** into `step-registry.ts`. Adding new functions requires:
1. Writing TypeScript code
2. Importing into step-registry
3. Rebuilding and redeploying the activity-executor image

---

## Research: CNCF Graduated Projects for Serverless Functions

| Project | CNCF Status | Purpose | Best For |
|---------|-------------|---------|----------|
| **Dapr** | Graduated (Nov 2024) | Distributed runtime with workflows | You're already using this ✓ |
| **Knative** | Graduated (Oct 2025) | Serverless platform (Serving + Eventing) | Scale-to-zero HTTP workloads |
| **KEDA** | Graduated (Aug 2023) | Event-driven autoscaling | Scaling based on queue depth |

### Serverless Frameworks Comparison

| Framework | Maintenance | Scale-to-Zero | Kubernetes Native | Complexity |
|-----------|-------------|---------------|-------------------|------------|
| **Knative** | Excellent (CNCF) | Yes | Yes | High |
| **OpenFaaS** | Good | Yes | Yes | Medium |
| **Fission** | Moderate | Yes (pre-warmed pods) | Yes | Low |

**Recommendation**: **Knative** - Already in your stack, CNCF graduated, best maintained.

---

## Research: Dapr Sidecar vs Dapr Shared

### Sidecar Model (Recommended)
```
┌─────────────────────────────────┐
│           Pod                   │
│  ┌─────────────┐ ┌───────────┐ │
│  │    App      │ │   daprd   │ │
│  │  Container  │ │  sidecar  │ │
│  └─────────────┘ └───────────┘ │
└─────────────────────────────────┘
```

**Pros:**
- Strong isolation between apps
- Independent lifecycle management
- mTLS per-app security boundary
- **Production recommended by Dapr team**

**Cons:**
- More memory per pod (~250Mi per sidecar)
- Slower cold starts (sidecar must initialize)

### Dapr Shared (DaemonSet/Deployment)
```
┌─────────────────────────────────┐
│           Node                  │
│  ┌─────────┐ ┌─────────┐       │
│  │  App 1  │ │  App 2  │ ...   │
│  └────┬────┘ └────┬────┘       │
│       └─────┬─────┘            │
│        ┌────▼────┐             │
│        │  daprd  │ (DaemonSet) │
│        │ shared  │             │
│        └─────────┘             │
└─────────────────────────────────┘
```

**Pros:**
- Faster startup (pre-initialized)
- Lower memory overhead
- Good for FaaS/serverless workloads

**Cons:**
- **Experimental** - not production-ready
- Shared failure domain (1 crash affects all apps on node)
- Security: all apps share same Dapr instance
- No mTLS isolation between co-located apps

### Recommendation: **Sidecar Model**

For workflow orchestration with stateful activities, the sidecar model provides:
- Better reliability (isolated failure domains)
- Stronger security (mTLS per app)
- Proven production stability

Use Dapr Shared only for truly stateless, short-lived functions where fast startup matters more than isolation.

---

## Architecture Options for Function Persistence

### Option A: Enhanced Static Registry (Current + Improvements)
Keep current static compilation but improve the developer experience.

```
┌─────────────────┐     ┌──────────────────────────────┐
│  Next.js UI     │────▶│  activity-executor           │
│  (define steps) │     │  ┌──────────────────────────┐│
└─────────────────┘     │  │ step-registry.ts          ││
                        │  │ - 35+ bundled functions   ││
                        │  └──────────────────────────┘│
                        └──────────────────────────────┘
```

**Implementation:**
- Keep TypeScript step functions in plugins/
- Auto-discover via `pnpm discover-plugins`
- GitOps deployment on code changes

**Pros:** Simple, type-safe, fast execution
**Cons:** Requires rebuild for new functions

---

### Option B: Multi-Service Activity Executors (Recommended)
Decompose into separate Knative Services per plugin/domain.

```
┌─────────────────┐     ┌───────────────────────────────┐
│  Orchestrator   │     │     Knative Services          │
│  ┌───────────┐  │     │ ┌─────────────────────────┐   │
│  │ dynamic   │  │────▶│ │ openai-executor         │   │
│  │ workflow  │  │     │ │ (scale 0-10)            │   │
│  └───────────┘  │     │ └─────────────────────────┘   │
│                 │     │ ┌─────────────────────────┐   │
│                 │────▶│ │ slack-executor          │   │
│                 │     │ │ (scale 0-5)             │   │
│                 │     │ └─────────────────────────┘   │
│                 │     │ ┌─────────────────────────┐   │
│                 │────▶│ │ github-executor         │   │
│                 │     │ │ (scale 0-5)             │   │
│                 │     │ └─────────────────────────┘   │
└─────────────────┘     └───────────────────────────────┘
```

**Implementation:**
- Each plugin becomes its own Knative Service
- Orchestrator routes to app-id based on activity prefix
- Service registry in Dapr (service invocation)

**Pros:**
- Independent scaling per plugin
- Independent deployment (update Slack without rebuilding OpenAI)
- Better resource isolation
- Can use different languages per service

**Cons:** More K8s manifests, service discovery complexity

---

### Option C: OCI-Based Function Registry (Most Flexible)
Store function code in OCI registry, dynamically load at runtime.

```
┌────────────────┐     ┌───────────────────────────────┐
│  Next.js UI    │────▶│  PostgreSQL                   │
│  (define func) │     │  - function metadata          │
└───────┬────────┘     │  - input/output schema        │
        │              │  - OCI image reference        │
        │              └───────────────────────────────┘
        │
        ▼              ┌───────────────────────────────┐
┌────────────────┐     │  OCI Registry (Gitea)         │
│  Build func    │────▶│  - function container images  │
│  container     │     │  - versioned artifacts        │
└────────────────┘     └───────────────────────────────┘
                                    │
                                    ▼
┌────────────────┐     ┌───────────────────────────────┐
│  Orchestrator  │────▶│  Function Runner              │
│                │     │  - Pulls image from registry  │
│                │     │  - Runs as Job/Knative Service│
│                │     │  - Returns result             │
└────────────────┘     └───────────────────────────────┘
```

**Implementation:**
- Store function metadata in PostgreSQL
- Build function as container image (via Kaniko/Buildpacks)
- Run via Knative Service or K8s Job
- Use Dapr service invocation for routing

**Pros:**
- True dynamic function deployment
- Language-agnostic
- Version control via OCI tags
- GitOps friendly

**Cons:** Complex, cold start latency, image management overhead

---

### Option D: CNCF Serverless Workflow DSL (Future-Proof)
Adopt the CNCF Serverless Workflow specification.

```
┌─────────────────┐     ┌───────────────────────────────┐
│  Visual Builder │────▶│  Serverless Workflow DSL      │
│  (JSON/YAML)    │     │  - Vendor-neutral standard    │
└─────────────────┘     │  - CNCF sandbox project       │
                        └───────────────┬───────────────┘
                                        │
                                        ▼
                        ┌───────────────────────────────┐
                        │  Synapse / EventMesh Runtime  │
                        │  - Executes workflows         │
                        │  - Manages function calls     │
                        └───────────────────────────────┘
```

**Pros:** Vendor-neutral, standardized, portable
**Cons:** Less mature than Dapr (sandbox status), migration effort

---

## Recommended Architecture

Based on your requirements (self-hosted K8s, Dapr, production use), I recommend:

### Hybrid: Option A + Option B

**Short-term (Phase 1):** Enhanced Static Registry
- Keep current architecture
- Add plugin auto-discovery
- Improve hot-reload in development

**Medium-term (Phase 2):** Multi-Service Executors
- Split activity-executor into domain-specific services
- Each service is a Knative Service with Dapr sidecar
- Use KEDA for event-driven autoscaling

```
┌────────────────────────────────────────────────────────────────┐
│                    Kubernetes Cluster                          │
│                                                                │
│  ┌──────────────────┐    ┌─────────────────────────────────┐  │
│  │  Next.js App     │    │  workflow-orchestrator          │  │
│  │  (no Dapr)       │───▶│  TypeScript + Dapr Sidecar      │  │
│  └──────────────────┘    │  - Dynamic workflow interpreter │  │
│                          └─────────────┬───────────────────┘  │
│                                        │                       │
│            ┌───────────────────────────┼───────────────────┐  │
│            │                           │                   │  │
│            ▼                           ▼                   ▼  │
│  ┌──────────────────┐    ┌──────────────────┐  ┌────────────┐│
│  │ ai-executor      │    │ comms-executor   │  │ dev-tools  ││
│  │ Knative + Dapr   │    │ Knative + Dapr   │  │ Knative    ││
│  │ - OpenAI         │    │ - Slack          │  │ - GitHub   ││
│  │ - Anthropic      │    │ - Resend         │  │ - Linear   ││
│  │ - Perplexity     │    │ - v0             │  │ - Webflow  ││
│  │ scale: 0-10      │    │ scale: 0-5       │  │ scale: 0-5 ││
│  └──────────────────┘    └──────────────────┘  └────────────┘│
│                                                                │
│  ┌──────────────────┐    ┌──────────────────────────────────┐ │
│  │  KEDA Scalers    │    │  Dapr Components                 │ │
│  │  - Queue depth   │    │  - workflowstatestore (Redis)    │ │
│  │  - HTTP requests │    │  - workflowpubsub (Redis)        │ │
│  └──────────────────┘    │  - azure-keyvault (secrets)      │ │
│                          └──────────────────────────────────┘ │
└────────────────────────────────────────────────────────────────┘
```

### Key Design Decisions

| Decision | Recommendation | Rationale |
|----------|----------------|-----------|
| Dapr deployment | **Sidecar** | Production stability, isolation |
| Function runtime | **Knative** | CNCF graduated, scale-to-zero |
| Autoscaling | **KEDA** | Event-driven, Dapr integration |
| Function persistence | **PostgreSQL** | Already in stack, simple |
| Function images | **OCI Registry** | Versioning, GitOps |
| Routing | **Dapr Service Invocation** | Built-in discovery, mTLS |

---

## Implementation Plan (Full Transformation - 4-6 weeks)

### Target Architecture

```
┌─────────────────────────────────────────────────────────────────────────┐
│                         Kubernetes Cluster                               │
│                                                                          │
│  ┌────────────────┐     ┌─────────────────────────────────────────────┐ │
│  │  Next.js App   │────▶│  workflow-orchestrator                      │ │
│  │  - Define      │     │  - Dynamic workflow interpreter             │ │
│  │    workflows   │     │  - Routes to function-runner via Dapr       │ │
│  │  - Define      │     │  Dapr Sidecar (production recommended)      │ │
│  │    functions   │     └─────────────────────────────────────────────┘ │
│  └───────┬────────┘                          │                          │
│          │                                   │ Dapr Service Invocation  │
│          ▼                                   ▼                          │
│  ┌────────────────┐     ┌─────────────────────────────────────────────┐ │
│  │  PostgreSQL    │     │  function-runner (Knative Service)          │ │
│  │  - workflows   │     │  - Receives execution request               │ │
│  │  - functions   │◀───▶│  - Looks up function in PostgreSQL          │ │
│  │  - executions  │     │  - Dispatches to appropriate handler        │ │
│  └────────────────┘     │  - Scale: 0-20, concurrency: 10             │ │
│                         │  Dapr Sidecar (secrets, state, pubsub)      │ │
│                         └─────────────────────────────────────────────┘ │
│                                              │                          │
│                         ┌────────────────────┼────────────────────┐     │
│                         │                    │                    │     │
│                         ▼                    ▼                    ▼     │
│  ┌──────────────────────────┐ ┌──────────────────┐ ┌──────────────────┐│
│  │  Built-in Handlers       │ │  OCI Function    │ │  HTTP Function   ││
│  │  (TypeScript, bundled)   │ │  (container job) │ │  (webhook call)  ││
│  │  - OpenAI, Slack, etc.   │ │  - User-defined  │ │  - External APIs ││
│  └──────────────────────────┘ └──────────────────┘ └──────────────────┘│
│                                                                          │
│  ┌────────────────────────────────────────────────────────────────────┐ │
│  │  Supporting Infrastructure                                         │ │
│  │  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐  ┌───────────┐ │ │
│  │  │   Redis     │  │   KEDA      │  │ Azure KV    │  │  Gitea    │ │ │
│  │  │   (Dapr)    │  │  Scalers    │  │  (secrets)  │  │ Registry  │ │ │
│  │  └─────────────┘  └─────────────┘  └─────────────┘  └───────────┘ │ │
│  └────────────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────────────┘
```

---

### Phase 1: Foundation (Week 1-2)

#### 1.1 Database Schema for Functions

Add to `lib/db/schema.ts`:

```typescript
export const functions = pgTable("functions", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(), // e.g., "openai/generate-text"
  description: text("description"),
  pluginId: text("plugin_id").notNull(),
  version: text("version").notNull().default("1.0.0"),

  // Execution type
  executionType: text("execution_type").notNull().default("builtin"),
  // "builtin" | "oci" | "http"

  // For OCI functions
  imageRef: text("image_ref"), // e.g., "gitea.local/funcs/my-func:v1"
  command: text("command"),    // Override entrypoint

  // For HTTP functions
  webhookUrl: text("webhook_url"),
  webhookMethod: text("webhook_method").default("POST"),
  webhookHeaders: jsonb("webhook_headers"),

  // Schema
  inputSchema: jsonb("input_schema").$type<JsonSchema>(),
  outputSchema: jsonb("output_schema").$type<JsonSchema>(),

  // Execution config
  timeoutSeconds: integer("timeout_seconds").default(300),
  retryPolicy: jsonb("retry_policy").$type<RetryPolicy>(),

  // Metadata
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
  createdBy: uuid("created_by").references(() => users.id),
});

export const functionExecutions = pgTable("function_executions", {
  id: uuid("id").primaryKey().defaultRandom(),
  functionId: uuid("function_id").references(() => functions.id),
  workflowExecutionId: uuid("workflow_execution_id").references(() => workflowExecutions.id),
  nodeId: text("node_id"),

  status: text("status").notNull().default("pending"),
  // "pending" | "running" | "completed" | "failed"

  input: jsonb("input"),
  output: jsonb("output"),
  error: text("error"),

  startedAt: timestamp("started_at"),
  completedAt: timestamp("completed_at"),
  durationMs: integer("duration_ms"),
});
```

#### 1.2 Seed Built-in Functions

Create migration to seed existing step functions:

```typescript
// lib/db/seeds/functions.ts
const builtinFunctions = [
  {
    slug: "openai/generate-text",
    name: "Generate Text",
    pluginId: "openai",
    executionType: "builtin",
    inputSchema: {
      type: "object",
      properties: {
        aiModel: { type: "string", default: "gpt-4o" },
        aiPrompt: { type: "string" },
        aiFormat: { type: "string", enum: ["text", "object"] },
        aiSchema: { type: "string" },
      },
      required: ["aiPrompt"],
    },
    timeoutSeconds: 120,
  },
  // ... 35+ more functions
];
```

#### 1.3 Add KEDA Autoscaling

Create `k8s/knative/keda-scalers.yaml`:

```yaml
apiVersion: keda.sh/v1alpha1
kind: ScaledObject
metadata:
  name: function-runner-scaler
  namespace: workflow-builder
spec:
  scaleTargetRef:
    apiVersion: serving.knative.dev/v1
    kind: Service
    name: function-runner
  minReplicaCount: 0
  maxReplicaCount: 20
  cooldownPeriod: 30
  triggers:
    - type: prometheus
      metadata:
        serverAddress: http://prometheus.observability:9090
        metricName: http_requests_inflight
        query: |
          sum(rate(http_requests_total{app="function-runner"}[1m]))
        threshold: "10"
    - type: external
      metadata:
        scalerAddress: dapr-scaler.dapr-system:9090
        componentName: workflowpubsub
        topic: function-queue
```

---

### Phase 2: Function Runner Service (Week 2-3)

#### 2.1 New Service Structure

```
services/function-runner/
├── src/
│   ├── index.ts              # Fastify + Dapr init
│   ├── routes/
│   │   ├── execute.ts        # POST /execute
│   │   └── health.ts         # /healthz, /readyz
│   ├── handlers/
│   │   ├── builtin.ts        # Dispatch to step-registry
│   │   ├── oci.ts            # Run OCI container
│   │   └── http.ts           # Call webhook URL
│   ├── core/
│   │   ├── function-loader.ts    # Load from PostgreSQL
│   │   ├── credential-service.ts # Dapr secrets + DB
│   │   └── template-resolver.ts  # {{variable}} resolution
│   └── registry/
│       └── step-registry.ts  # Built-in handlers (copy from activity-executor)
├── Dockerfile
└── package.json
```

#### 2.2 Function Execution Flow

```typescript
// services/function-runner/src/routes/execute.ts
interface ExecuteRequest {
  function_id?: string;      // UUID from DB
  function_slug?: string;    // e.g., "openai/generate-text"
  workflow_id: string;
  node_id: string;
  input: Record<string, unknown>;
  node_outputs: Record<string, unknown>;  // For template resolution
}

export async function executeFunction(req: ExecuteRequest) {
  // 1. Load function definition from PostgreSQL
  const fn = await functionLoader.load(req.function_id || req.function_slug);

  // 2. Resolve templates in input
  const resolvedInput = templateResolver.resolve(req.input, req.node_outputs);

  // 3. Fetch credentials from Dapr secrets
  const credentials = await credentialService.getForPlugin(fn.pluginId);

  // 4. Dispatch based on execution type
  switch (fn.executionType) {
    case "builtin":
      return await builtinHandler.execute(fn.slug, resolvedInput, credentials);
    case "oci":
      return await ociHandler.execute(fn.imageRef, resolvedInput, credentials);
    case "http":
      return await httpHandler.execute(fn.webhookUrl, resolvedInput, credentials);
  }
}
```

#### 2.3 OCI Handler (Container Execution)

```typescript
// services/function-runner/src/handlers/oci.ts
import { KubeConfig, BatchV1Api } from "@kubernetes/client-node";

export async function executeOciFunction(
  imageRef: string,
  input: Record<string, unknown>,
  credentials: Record<string, string>,
  timeout: number = 300
): Promise<{ success: boolean; output?: unknown; error?: string }> {
  const kc = new KubeConfig();
  kc.loadFromCluster();
  const batch = kc.makeApiClient(BatchV1Api);

  const jobName = `fn-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  // Create K8s Job for function execution
  const job = await batch.createNamespacedJob("workflow-builder", {
    metadata: { name: jobName },
    spec: {
      ttlSecondsAfterFinished: 60,
      activeDeadlineSeconds: timeout,
      template: {
        spec: {
          restartPolicy: "Never",
          containers: [{
            name: "function",
            image: imageRef,
            env: [
              { name: "INPUT", value: JSON.stringify(input) },
              ...Object.entries(credentials).map(([k, v]) => ({ name: k, value: v })),
            ],
          }],
        },
      },
    },
  });

  // Wait for completion and get output from pod logs
  return await waitForJobCompletion(batch, jobName, timeout);
}
```

---

### Phase 3: UI for Function Management (Week 3-4)

#### 3.1 Function List Page

Create `app/functions/page.tsx`:
- List all functions (built-in + custom)
- Filter by plugin, execution type
- Show usage statistics

#### 3.2 Function Editor

Create `app/functions/[functionId]/page.tsx`:
- Edit function metadata
- Configure input/output schemas (JSON Schema editor)
- Test function with sample inputs
- View execution history

#### 3.3 Function Creator (for HTTP/OCI)

Create `app/functions/new/page.tsx`:
- Choose execution type (HTTP webhook, OCI container)
- For HTTP: Enter URL, method, headers
- For OCI: Enter image reference, build from Dockerfile
- Define input/output schema
- Test before saving

---

### Phase 4: OCI Build Pipeline (Week 4-5)

#### 4.1 In-Cluster Build with Kaniko

```yaml
# k8s/kaniko-build-job.yaml
apiVersion: batch/v1
kind: Job
metadata:
  name: function-build-{{function-id}}
spec:
  template:
    spec:
      containers:
        - name: kaniko
          image: gcr.io/kaniko-project/executor:latest
          args:
            - "--dockerfile=Dockerfile"
            - "--context=git://github.com/{{repo}}.git#{{branch}}"
            - "--destination=gitea.cnoe.localtest.me:8443/functions/{{name}}:{{version}}"
          volumeMounts:
            - name: docker-config
              mountPath: /kaniko/.docker
      volumes:
        - name: docker-config
          secret:
            secretName: gitea-registry-credentials
      restartPolicy: Never
```

#### 4.2 Function Template Repository

Provide starter templates for common languages:

```
function-templates/
├── typescript/
│   ├── Dockerfile
│   ├── package.json
│   └── src/index.ts  # Reads INPUT env, writes to stdout
├── python/
│   ├── Dockerfile
│   ├── requirements.txt
│   └── main.py
└── go/
    ├── Dockerfile
    └── main.go
```

---

### Phase 5: Integration & Testing (Week 5-6)

#### 5.1 Update Workflow Orchestrator

Modify `services/workflow-orchestrator/src/activities/execute-action.ts`:

```typescript
// Change from direct activity-executor call to function-runner
export async function executeAction(
  ctx: WorkflowActivityContext,
  input: ExecuteActionInput
): Promise<ExecuteActionOutput> {
  const daprClient = new DaprClient();

  // Call function-runner instead of activity-executor
  const result = await daprClient.invoker.invoke(
    "function-runner",  // Changed from "activity-executor"
    "execute",
    HttpMethod.POST,
    {
      function_slug: input.activityId,
      workflow_id: input.workflowId,
      node_id: input.nodeId,
      input: input.config,
      node_outputs: input.nodeOutputs,
    }
  );

  return result;
}
```

#### 5.2 Migration Script

```typescript
// scripts/migrate-to-function-runner.ts
async function migrate() {
  // 1. Seed built-in functions from step-registry
  await seedBuiltinFunctions();

  // 2. Update existing workflow definitions
  // Replace activityId with function_slug
  await updateWorkflowDefinitions();

  // 3. Deploy function-runner service
  await deployFunctionRunner();

  // 4. Update orchestrator to use function-runner
  await updateOrchestrator();
}
```

---

### Files to Create/Modify

| File | Action | Description |
|------|--------|-------------|
| `lib/db/schema.ts` | Modify | Add functions, functionExecutions tables |
| `lib/db/migrations/*.sql` | Create | Database migrations |
| `services/function-runner/` | Create | New function runner service |
| `k8s/knative/function-runner.yaml` | Create | Knative Service manifest |
| `k8s/knative/keda-scalers.yaml` | Create | KEDA autoscaling config |
| `app/functions/page.tsx` | Create | Function list UI |
| `app/functions/[id]/page.tsx` | Create | Function editor UI |
| `app/functions/new/page.tsx` | Create | Function creator UI |
| `services/workflow-orchestrator/src/activities/execute-action.ts` | Modify | Route to function-runner |
| `function-templates/` | Create | Starter templates for custom functions |

---

## Verification Plan

### 1. Unit Tests
- Function loader: Load by ID, load by slug, handle missing
- Template resolver: Variable substitution, nested paths
- Handlers: Builtin dispatch, OCI job creation, HTTP webhook calls

### 2. Integration Tests (DevSpace)
```bash
# Start dev environment
devspace dev --namespace workflow-builder

# Test built-in function execution
curl -X POST http://localhost:8080/execute \
  -H "Content-Type: application/json" \
  -d '{"function_slug":"openai/generate-text","input":{"aiPrompt":"Hello"}}'

# Test workflow with function calls
curl -X POST http://localhost:3000/api/v2/workflows \
  -H "Content-Type: application/json" \
  -d '{"definition":{...},"triggerData":{}}'
```

### 3. Scale-to-Zero Verification
```bash
# Verify initial state (0 pods)
kubectl get pods -n workflow-builder -l app=function-runner
# Should show: No resources found

# Trigger execution
curl -X POST http://function-runner.workflow-builder/execute ...

# Verify scale-up
kubectl get pods -n workflow-builder -l app=function-runner
# Should show: 1/1 Running

# Wait 30s (cooldown), verify scale-down
sleep 35
kubectl get pods -n workflow-builder -l app=function-runner
# Should show: No resources found
```

### 4. KEDA Autoscaling Test
```bash
# Generate load
hey -n 100 -c 20 http://function-runner.workflow-builder/execute

# Watch scaling
kubectl get hpa -n workflow-builder -w
# Should show replicas increasing
```

### 5. Failure Recovery
```bash
# Kill function-runner pod during execution
kubectl delete pod -l app=function-runner -n workflow-builder

# Verify workflow recovers (Dapr retry)
# Check workflow status - should complete after retry
```

### 6. End-to-End Workflow Test
1. Create workflow in UI with AI text generation node
2. Execute workflow
3. Verify function-runner receives request
4. Verify credentials loaded from Dapr secrets
5. Verify output returned to orchestrator
6. Verify workflow completes successfully

---

## Sources

- [Dapr Documentation - Workflows](https://docs.dapr.io/developing-applications/building-blocks/workflow/workflow-overview/)
- [Dapr Shared Deployment](https://docs.dapr.io/operations/hosting/kubernetes/kubernetes-dapr-shared/)
- [KEDA Documentation](https://keda.sh/)
- [Knative CNCF Graduation](https://www.cncf.io/announcements/2025/10/08/cloud-native-computing-foundation-announces-knatives-graduation/)
- [Dapr CNCF Graduation](https://www.cncf.io/announcements/2024/11/12/cloud-native-computing-foundation-announces-dapr-graduation/)
- [Serverless Workflow Specification](https://serverlessworkflow.io/)
- [Diagrid - Dapr Deployment Models](https://www.diagrid.io/blog/dapr-deployment-models)

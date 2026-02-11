# Function-Runner Implementation Progress Report

**Date:** 2026-02-04
**Branch:** `feature/dapr-workflow-infrastructure`
**Commits:**
- `df64c5f` - Add function-runner service for dynamic function execution (workflow-builder)
- `ce68ef8a4` - feat: Add VelaUX dashboard and function-runner app (stacks/main)

---

## Plan vs Progress Summary

| Phase | Description | Status | Notes |
|-------|-------------|--------|-------|
| **Phase 1** | Foundation (Database + KEDA) | **90% Complete** | Schema done, KEDA config done, migrations pending |
| **Phase 2** | Function Runner Service | **100% Complete** | All handlers implemented |
| **Phase 3** | UI for Function Management | **Not Started** | Future work |
| **Phase 4** | OCI Build Pipeline | **50% Complete** | Templates done, Kaniko not integrated |
| **Phase 5** | Integration & Testing | **70% Complete** | Code complete, deployment testing pending |

---

## Completed Work

### Phase 1: Foundation

#### 1.1 Database Schema ✅
- Added `functions` table with all fields from plan:
  - `id`, `name`, `slug`, `description`, `pluginId`, `version`
  - `executionType` (builtin | oci | http)
  - OCI fields: `imageRef`, `command`, `workingDir`, `containerEnv`
  - HTTP fields: `webhookUrl`, `webhookMethod`, `webhookHeaders`, `webhookTimeoutSeconds`
  - Schemas: `inputSchema`, `outputSchema` (JSON Schema)
  - Config: `timeoutSeconds`, `retryPolicy`, `maxConcurrency`
  - Flags: `isBuiltin`, `isEnabled`, `isDeprecated`
- Added `functionExecutions` table for tracking execution history

**File:** `lib/db/schema.ts`

#### 1.2 Seed Script ✅
- Created `scripts/seed-functions.ts` that:
  - Auto-discovers all plugins from manifest
  - Converts `configFields` to JSON Schema format
  - Seeds ~35+ built-in functions with proper metadata

#### 1.3 KEDA Autoscaling ✅
- Kubernetes manifests are managed in the stacks repo (`~/repos/PittampalliOrg/stacks/main/`).
- For scale-to-zero execution, the current stack uses Knative autoscaling.

---

### Phase 2: Function Runner Service ✅

#### 2.1 Service Structure ✅
Created complete service at `services/function-runner/`:
```
services/function-runner/
├── src/
│   ├── index.ts                  # Fastify + health routes
│   ├── routes/
│   │   ├── execute.ts            # POST /execute endpoint
│   │   └── health.ts             # /healthz, /readyz
│   ├── handlers/
│   │   ├── builtin.ts            # Step registry dispatch
│   │   ├── oci.ts                # K8s Job execution
│   │   └── http.ts               # Webhook calls
│   ├── core/
│   │   ├── function-loader.ts    # PostgreSQL loader with cache
│   │   ├── credential-service.ts # Dapr secrets integration
│   │   ├── template-resolver.ts  # {{variable}} resolution
│   │   └── types.ts              # Type definitions
│   └── registry/
│       └── step-registry.ts      # Built-in handlers
├── Dockerfile                    # Multi-stage build
├── build.mjs                     # esbuild configuration
├── package.json
└── tsconfig.json
```

#### 2.2 Handlers ✅

**Builtin Handler (`handlers/builtin.ts`):**
- Dispatches to step-registry based on slug
- Injects credentials into step handlers
- Handles plugin/step ID parsing

**OCI Handler (`handlers/oci.ts`):**
- Creates Kubernetes Jobs for container functions
- Mounts credentials as environment variables
- Captures output from pod logs
- Supports timeout and cleanup (TTL)
- Full error handling with job/pod cleanup

**HTTP Handler (`handlers/http.ts`):**
- Calls external webhooks with configurable method
- Supports custom headers and timeout
- Can inject credentials as headers or body fields

#### 2.3 Supporting Components ✅

**Function Loader (`core/function-loader.ts`):**
- Loads from PostgreSQL by ID or slug
- 60-second in-memory cache
- Falls back to synthetic definition if not in DB

**Credential Service (`core/credential-service.ts`):**
- Fetches secrets from Dapr secret store
- Falls back to database credentials
- Maps plugin types to secret names

---

### Phase 4: Function Templates ✅ (Partial)

Created `function-templates/` with starter templates:

| Language | Files | Features |
|----------|-------|----------|
| **TypeScript** | Dockerfile, src/index.ts, package.json | Zod validation, JSON output |
| **Python** | Dockerfile, main.py, requirements.txt | Pydantic validation |
| **Go** | Dockerfile, main.go | JSON parsing, structured output |

Each template:
- Reads `INPUT` environment variable (JSON)
- Validates input against schema
- Outputs JSON result to stdout
- Includes error handling

---

### Phase 5: Integration ✅ (Partial)

#### 5.1 Orchestrator Update ✅
Modified `services/workflow-orchestrator/src/activities/execute-action.ts`:
- Routes to `function-runner` by default (configurable via `USE_FUNCTION_RUNNER` env)
- Falls back to `activity-executor` if disabled
- Uses Dapr service invocation

---

### Kubernetes Manifests ✅

**Kubernetes manifests:**
- Manifests are managed in the stacks repo at `~/repos/PittampalliOrg/stacks/main/` using the `cnoe://` convention (idpbuilder + ArgoCD).

**stacks/main repo (`packages/components/active-development/`):**
- `apps/function-runner.yaml` - ArgoCD Application
- `manifests/function-runner/` - Full K8s manifest set:
  - Namespace, ServiceAccount, RBAC
  - ConfigMaps (app, otel, dapr)
  - ExternalSecret (Azure Key Vault)
  - Dapr Components (secretstore, azureappconfig)
  - Deployment, Service

**Kargo Pipeline:**
- `Stage-function-runner-local-dev.yaml`
- `Warehouse-function-runner.yaml`
- Added to `images.yaml` for auto-updates

---

### Docker Image ✅

Built and pushed:
```
gitea.cnoe.localtest.me:8443/giteaadmin/function-runner:latest
```

---

## Pending Work

### Database (Requires K8s Cluster)
- [ ] Run Drizzle migrations: `pnpm db:migrate`
- [ ] Execute seed script: `pnpm tsx scripts/seed-functions.ts`

### Deployment
- [ ] Deploy via idpbuilder: `make deploy-kind-thinkpad`
- [ ] Or sync via ArgoCD (manifests already in Gitea)

### Testing (From Verification Plan)
- [ ] Unit tests for function-loader, template-resolver, handlers
- [ ] Integration test: POST /execute with builtin function
- [ ] Scale-to-zero verification
- [ ] KEDA autoscaling test
- [ ] Failure recovery test
- [ ] End-to-end workflow test

### Phase 3: UI (Not Started)
- [ ] `app/functions/page.tsx` - Function list
- [ ] `app/functions/[id]/page.tsx` - Function editor
- [ ] `app/functions/new/page.tsx` - Function creator

### Phase 4: OCI Build Pipeline (Not Started)
- [ ] Kaniko integration for in-cluster builds
- [ ] UI for building custom functions from templates

---

## Architecture Achieved

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
│  │  PostgreSQL    │     │  function-runner (K8s Deployment)           │ │
│  │  - workflows   │     │  - Receives execution request               │ │
│  │  - functions   │◀───▶│  - Looks up function in PostgreSQL          │ │
│  │  - executions  │     │  - Dispatches to appropriate handler        │ │
│  └────────────────┘     │  - Dapr Sidecar (secrets, state)            │ │
│                         └─────────────────────────────────────────────┘ │
│                                              │                          │
│                         ┌────────────────────┼────────────────────┐     │
│                         │                    │                    │     │
│                         ▼                    ▼                    ▼     │
│  ┌──────────────────────────┐ ┌──────────────────┐ ┌──────────────────┐│
│  │  Built-in Handlers       │ │  OCI Function    │ │  HTTP Function   ││
│  │  (TypeScript, bundled)   │ │  (K8s Job)       │ │  (webhook call)  ││
│  │  - 35+ plugin steps      │ │  - User-defined  │ │  - External APIs ││
│  └──────────────────────────┘ └──────────────────┘ └──────────────────┘│
└─────────────────────────────────────────────────────────────────────────┘
```

---

## Git Status

### workflow-builder (feature/dapr-workflow-infrastructure)
```
df64c5f Add function-runner service for dynamic function execution
  - 39 files changed, 4005 insertions(+), 20 deletions(-)
  - Pushed to origin
```

### stacks/main (main)
```
ce68ef8a4 feat: Add VelaUX dashboard and function-runner app
  - function-runner manifests + ArgoCD app
  - Kargo pipeline configuration
  - Pushed to origin
```

---

## Next Steps (Priority Order)

1. **Deploy cluster** - Run `make deploy-kind-thinkpad` or `idpbuilder create`
2. **Run migrations** - Once PostgreSQL is accessible
3. **Seed functions** - Populate built-in functions
4. **Test execution** - Verify function-runner works end-to-end
5. **Monitor scaling** - Verify KEDA autoscaling behavior

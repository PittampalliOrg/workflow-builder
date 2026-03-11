# Workflow Builder Architecture Summary

**Last Updated**: 2026-03-11
**Status**: Production Ready

## System Overview

Visual workflow builder with Dapr workflow orchestration, durable AI agents, and hosted MCP integration on Kubernetes.

## Core Principles

1. **Single Source of Truth**: `actionType` field identifies all functions
2. **Clean Separation**: Action nodes for functions, activity nodes for control flow
3. **Database-Driven**: Functions seeded from plugin registry to PostgreSQL
4. **No Legacy Fields**: All backwards compatibility removed

## Architecture Layers

```
┌─────────────────────────────────────────────────────────┐
│ UI Layer (Next.js + React Flow)                        │
│ - Visual workflow builder                               │
│ - Creates action nodes with actionType                  │
│ - Auto-saves to PostgreSQL                              │
└────────────────┬────────────────────────────────────────┘
                 │
                 ▼ HTTP
┌─────────────────────────────────────────────────────────┐
│ Orchestration Layer (Dapr Workflow)                    │
│ - workflow-orchestrator service                         │
│ - Dynamic workflow interpreter                          │
│ - Executes nodes in topological order                   │
└────────────────┬────────────────────────────────────────┘
                 │
                 ▼ Dapr Service Invocation
┌─────────────────────────────────────────────────────────┐
│ Function Execution Layer                                │
│ - function-router service (smart dispatcher)            │
│ - Routes system actions to fn-system                    │
│ - Routes agent actions to durable-agent                 │
│ - Uses fn-activepieces only as retained AP fallback     │
└────────────────┬────────────────────────────────────────┘
                 │
                 ▼ Direct HTTP
┌─────────────────────────────────────────────────────────┐
│  Runtime Services                                       │
│  • durable-agent - primary AI agent runtime            │
│  • fn-system - built-in system actions                 │
│  • mcp-gateway - hosted MCP entrypoint                 │
│  • fn-activepieces - retained AP fallback              │
│  • legacy/optional MCP services remain in source       │
└─────────────────────────────────────────────────────────┘
```

## Node Types

### Action Nodes (Functions)

**Purpose**: Execute serverless functions
**Type**: `"action"`
**Config Field**: `actionType` (function slug)
**Examples**:
- `openai/generate-text`
- `slack/send-message`
- `github/create-issue`
- `system/http-request`

### Activity Nodes (Control Flow)

**Purpose**: Workflow primitives
**Types**:
- `approval-gate` - External event wait
- `timer` - Delay execution
- `publish-event` - Pub/sub

## Execution Flow

```
User clicks "Run"
    ↓
UI → POST /api/workflows/{id}/execute
    ↓
Orchestrator → Load workflow definition
    ↓
For each node in executionOrder:
    ↓
    If action node:
        ↓
        executeAction activity
            ↓
            Dapr invoke → function-runner
                ↓
                Load function by actionType
                    ↓
                    Execute builtin handler
                        ↓
                        Return result
    ↓
    If activity node:
        ↓
        waitForExternalEvent / createTimer / publishEvent
    ↓
Return workflow result → Save to database → Update UI
```

## Key Components

| Component | Role | Language | Deployment |
|-----------|------|----------|------------|
| workflow-builder | UI + BFF | Next.js 16 | K8s Deployment / DevSpace |
| workflow-orchestrator | Workflow engine | Python | K8s + Dapr |
| durable-agent | Durable agent runtime | TypeScript | K8s + Dapr |
| function-router | Function dispatcher | TypeScript | K8s + Dapr |
| fn-system | System action executor | TypeScript | Service path |
| mcp-gateway | Hosted MCP entrypoint | TypeScript | K8s Deployment |
| fn-activepieces | Retained AP fallback | TypeScript | Not part of current core local runtime |
| postgresql | Workflows & functions | PostgreSQL 15 | StatefulSet |
| redis | Dapr state | Redis 7 | StatefulSet |

## Database Schema

### workflows table
- `id` - Primary key
- `nodes` - JSONB array (React Flow nodes)
- `edges` - JSONB array (React Flow edges)
- Node format: `{ type: "action", config: { actionType: "openai/generate-text", ... } }`

### functions table
- `id` - Primary key
- `slug` - Canonical identifier (e.g., "openai/generate-text")
- `plugin_id` - Plugin name (e.g., "openai")
- `execution_type` - builtin, oci, http
- `is_builtin` - true for plugin functions

### workflow_executions table
- `id` - Primary key
- `workflow_id` - FK to workflows
- `dapr_instance_id` - Dapr workflow ID
- `status` - running, completed, failed
- `result` - JSONB output

## Plugin System

**Plugin Location**: `plugins/{plugin-id}/`

**Structure**:
```
plugins/openai/
  index.ts          # Plugin definition
  steps/
    generate-text.ts  # Function handler
```

**Function Handler**:
```typescript
export const generateText = async (input, context) => {
  const { prompt } = input;
  const { credentials } = context;

  // Execute with credentials from Dapr secrets
  const response = await openai.chat.completions.create({
    model: "gpt-4",
    messages: [{ role: "user", content: prompt }],
    apiKey: credentials.OPENAI_API_KEY,
  });

  return { text: response.choices[0].message.content };
};
```

## Deployment

**Cluster**: Kind (local) or production Kubernetes
**Namespace**: workflow-builder
**Ingress**: https://workflow-builder-ryzen.tail286401.ts.net
**Registry**: Gitea (historical push path: `gitea.cnoe.localtest.me:8443/giteaadmin/`)

**Auto-Deploy Flow** (cluster-recreate):
1. PostgreSQL (wave 10)
2. Admin user seed (wave 20)
3. Functions seed (wave 25) ← 37 functions from plugins
4. Services (wave 30+)

## Development

**Frontend** (hot-reload):
```bash
docker build -f Dockerfile.devspace \
  -t gitea.cnoe.localtest.me/giteaadmin/nodejs-22-devspace:latest .
kind load docker-image \
  gitea.cnoe.localtest.me/giteaadmin/nodejs-22-devspace:latest \
  --name ryzen
devspace dev  # File sync enabled for app/, components/, lib/
```

If `devspace dev` stalls on `ImagePullBackOff`, the shared dev image is missing
from the kind nodes. Load the image, then delete the stuck `workflow-builder-devspace-*`
pod so the ReplicaSet recreates it against the local image cache.

**Backend** (rebuild required):
```bash
docker build -t gitea.cnoe.localtest.me:8443/giteaadmin/workflow-orchestrator:latest \
  -f services/workflow-orchestrator/Dockerfile services/workflow-orchestrator
docker push gitea.cnoe.localtest.me:8443/giteaadmin/workflow-orchestrator:latest
kubectl rollout restart deployment/workflow-orchestrator -n workflow-builder
```

## Migration History

### ✅ Vercel → Dapr (Complete)
- Removed Vercel Workflow DevKit
- Added Dapr workflow orchestrator
- Added dynamic workflow interpreter

### ✅ Legacy Fields → actionType (Complete)
- Removed: `functionSlug`, `activityName`
- Canonical: `actionType` only
- No backwards compatibility

### ✅ Duplicate Activities Removed (Complete)
- Removed duplicate Dapr activities
- Clean plugin registry
- No duplicates in UI

## Production Checklist

- ✅ Database seeding automated
- ✅ Functions auto-seed from plugins
- ✅ Admin user auto-created
- ✅ Credentials via Azure Key Vault
- ✅ All services containerized
- ✅ Health checks configured
- ✅ Monitoring via Jaeger
- ✅ Clean architecture (actionType only)

## Troubleshooting

**Workflow fails with "Function not found"**:
- Check node config has `actionType` field
- Verify function exists: `SELECT * FROM functions WHERE slug = 'openai/generate-text'`
- Re-seed if needed: `kubectl delete job seed-functions && kubectl apply -f ...`

**Function execution fails**:
- Check credentials in Azure Key Vault
- Check function-runner logs: `kubectl logs -l app=function-runner -c function-runner`
- Verify Dapr sidecar running: `kubectl get pods` (should show 2/2)

**UI shows duplicates**:
- Should be fixed - check `dapr-activity-registry.ts` has no legacy activities
- Rebuild workflow-builder if needed

## Next Steps

**Completed**:
- [x] OpenFunction integration (8 serverless functions deployed)

**Future Enhancements**:
- [ ] HTTP webhook functions
- [ ] Function versioning
- [ ] GitOps deployment
- [ ] Multi-tenancy

---

See **CLAUDE.md** for detailed documentation.

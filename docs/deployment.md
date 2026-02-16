# Deployment & Infrastructure

## Kind Cluster

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

## Build Images

```bash
# Next.js app uses project root as context
docker build -t gitea.cnoe.localtest.me:8443/giteaadmin/workflow-builder:latest .

# Python orchestrator uses its own directory
docker build -t gitea.cnoe.localtest.me:8443/giteaadmin/workflow-orchestrator:latest -f services/workflow-orchestrator/Dockerfile services/workflow-orchestrator/

# durable-agent uses service dir as context (NOT project root)
docker build -t gitea.cnoe.localtest.me:8443/giteaadmin/durable-agent:latest -f services/durable-agent/Dockerfile services/durable-agent/

# These use project root as context
docker build -t gitea.cnoe.localtest.me:8443/giteaadmin/mastra-agent-tanstack:latest -f services/mastra-agent-tanstack/Dockerfile .
docker build -t gitea.cnoe.localtest.me:8443/giteaadmin/mastra-agent-mcp:latest -f services/mastra-agent-mcp/Dockerfile .
docker build -t gitea.cnoe.localtest.me:8443/giteaadmin/function-router:latest -f services/function-router/Dockerfile .
docker build -t gitea.cnoe.localtest.me:8443/giteaadmin/fn-activepieces:latest -f services/fn-activepieces/Dockerfile .
docker build -t gitea.cnoe.localtest.me:8443/giteaadmin/fn-system:latest -f services/fn-system/Dockerfile .

# These use their own service dir as context
docker build -t gitea.cnoe.localtest.me:8443/giteaadmin/workflow-mcp-server:latest -f services/workflow-mcp-server/Dockerfile services/workflow-mcp-server/

# These use project root as context
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

```
durable-agent / mastra-agent-tanstack
  → Dapr pub/sub (pubsub / durable-pubsub)
  → workflow-orchestrator subscriptions (or direct service invocation)
  → Next.js app SSE / webhooks
  → Activity Tab UI
```

**Completion event delivery**: durable-agent uses direct Dapr service invocation to orchestrator `/api/v2/workflows/{id}/events` (NOT pub/sub — component scoping mismatch between durable-pubsub and orchestrator's pubsub).

**Event types**: `tool_call`, `tool_result`, `phase_started`, `phase_completed`, `phase_failed`, `llm_start`, `llm_end`, `agent_started`, `agent_completed`, `planning_started`, `planning_completed`, `execution_started`, `execution_completed`

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

## Local Development (DevSpace)

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

## Service Logs

```bash
kubectl logs -n workflow-builder -l app=workflow-orchestrator -c workflow-orchestrator --tail=50
kubectl logs -n workflow-builder -l app=durable-agent -c durable-agent --tail=50
kubectl logs -n workflow-builder -l app=mastra-agent-tanstack --tail=50
kubectl logs -n workflow-builder -l app=function-router -c function-router --tail=50
kubectl logs -n workflow-builder -l app=fn-activepieces --tail=50
kubectl logs -n workflow-builder -l app=fn-system --tail=50
```

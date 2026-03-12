# Deployment & Infrastructure

## Kind Cluster

Current `kind-ryzen` runtime in the `workflow-builder` namespace:
- `workflow-builder` (typically replaced in-place by DevSpace for frontend inner-loop work)
- `workflow-orchestrator` Deployment (1 replica, port 8080) with Dapr sidecar
- `durable-agent` Deployment (port 8001) with Dapr sidecar
- `function-router` Deployment (1 replica, port 8080) with Dapr sidecar
- `fn-system` service path
- `mcp-gateway` Deployment (port 8080)
- `postgresql` StatefulSet (1 replica, port 5432)
- Dapr state/pubsub components and NATS/Redis backing services
- Ingress via Tailscale at `https://workflow-builder-ryzen.tail286401.ts.net`

Additional services still exist in source, but are not part of the current core local runtime:
- `fn-activepieces`
- `workflow-mcp-server`
- `piece-mcp-server`
- `node-sandbox`
- legacy Mastra services

Images are pushed to the Gitea registry at `gitea.cnoe.localtest.me:8443/giteaadmin/`.

## Build Images

```bash
# Next.js app uses project root as context
docker build -t gitea.cnoe.localtest.me:8443/giteaadmin/workflow-builder:latest .

# Python orchestrator uses its own directory
docker build -t gitea.cnoe.localtest.me:8443/giteaadmin/workflow-orchestrator:latest -f services/workflow-orchestrator/Dockerfile services/workflow-orchestrator/

# durable-agent uses service dir as context (NOT project root)
docker build -t gitea.cnoe.localtest.me:8443/giteaadmin/durable-agent:latest -f services/durable-agent/Dockerfile services/durable-agent/

# Core runtime services
docker build -t gitea.cnoe.localtest.me:8443/giteaadmin/function-router:latest -f services/function-router/Dockerfile .
docker build -t gitea.cnoe.localtest.me:8443/giteaadmin/fn-system:latest -f services/fn-system/Dockerfile .
docker build -t gitea.cnoe.localtest.me:8443/giteaadmin/mcp-gateway:latest -f services/mcp-gateway/Dockerfile .

# Optional / retained services (not part of the current core local runtime)
docker build -t gitea.cnoe.localtest.me:8443/giteaadmin/fn-activepieces:latest -f services/fn-activepieces/Dockerfile .
docker build -t gitea.cnoe.localtest.me:8443/giteaadmin/workflow-mcp-server:latest -f services/workflow-mcp-server/Dockerfile services/workflow-mcp-server/

docker build -t gitea.cnoe.localtest.me:8443/giteaadmin/piece-mcp-server:latest -f services/piece-mcp-server/Dockerfile .
docker build -t gitea.cnoe.localtest.me:8443/giteaadmin/node-sandbox:latest -f services/node-sandbox/Dockerfile services/node-sandbox
```

## Dapr Integration

### Service App IDs

| Service | Dapr App ID |
|---------|-------------|
| workflow-orchestrator | `workflow-orchestrator` |
| durable-agent | `durable-agent` |
| function-router | `function-router` |

### Component Scoping

| Component | Scoped To |
|-----------|-----------|
| `workflowstatestore` (Redis) | workflow-orchestrator |
| `pubsub` (Redis) | workflow-orchestrator |
| `durable-statestore` (Redis, actorStateStore) | durable-agent |
| `durable-pubsub` (NATS JetStream) | durable-agent |
| `azure-keyvault` (Secrets) | workflow-orchestrator, function-router, durable-agent |
| `kubernetes-secrets` (Secrets) | workflow-orchestrator (for DATABASE_URL in persist_results_to_db) |

### Credential Resolution Priority

1. **Dapr Secret Store** (Azure Key Vault) - automatic based on plugin type
2. **App Connections** (encrypted in DB) - AP piece credentials via internal decrypt API
3. **Request body** - credentials passed directly in execution request (legacy fallback)

## Event Streaming Pipeline

```
durable-agent
  → direct Dapr service invocation to workflow-orchestrator
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
| `DYNAMIC_WORKFLOW_VERSION` | Default version for `dynamic_workflow` registration/starts | `v1` |
| `AP_WORKFLOW_VERSION` | Default version for `ap_workflow` registration/starts | `v1` |
| `DYNAMIC_WORKFLOW_CONTINUE_AS_NEW_AFTER_NODES` | Node-execution threshold before `dynamic_workflow` compacts history with `continue_as_new` | `150` |
| `MIN_DAPR_RUNTIME_VERSION` | Minimum runtime version required by orchestrator/agent startup checks | `1.17.0` |
| `ENFORCE_MIN_DAPR_VERSION` | Fail startup when sidecar is below minimum version (`true`/`false`) | `false` |
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
| `AI_MODEL` | Durable agent LLM model | configured per environment |

## Dapr 1.17 Verification

Apply the repo-managed workflow runtime config before rolling out workflow-orchestrator and durable-agent sidecars:

```bash
kubectl apply -f dapr/workflow-runtime-config.yaml
```

Use the `workflow-runtime` Dapr configuration on workflow-orchestrator and durable-agent sidecars so both services pick up:
- workflow history retention for terminal runs
- bounded workflow/activity concurrency
- `WorkflowsRemoteActivityReminder` for multi-app workflow activity delivery

Run the end-to-end workflow API verification against the orchestrator service:

```bash
ORCHESTRATOR_URL=http://127.0.0.1:8080 \
WORKFLOW_VERSION=v1 \
pnpm tsx scripts/verify-dapr-117-workflow-apis.ts
```

This validates:
- start workflow with version
- get status
- list workflows
- get history
- pause workflow
- resume workflow
- rerun from event
- terminate workflow
- purge workflow

## Database Migration Source Of Truth

Cluster database migrations are applied by the Argo Sync `db-migrate` job using
Atlas migrations from `atlas/migrations/`.

Important:
- updating `lib/db/schema.ts` is not enough for `kind-ryzen`
- adding a Drizzle migration under `drizzle/` is not enough for `kind-ryzen`
- any schema change needed by the live app must also exist in Atlas and in
  `atlas/migrations/atlas.sum`

For the Dapr 1.17 workflow execution metadata rollout, the live database must
include the `workflow_executions` columns:
- `error_stack_trace`
- `rerun_of_execution_id`
- `rerun_source_instance_id`
- `rerun_from_event_id`

Rollout verification:

```bash
kubectl --context kind-ryzen -n workflow-builder exec postgresql-0 -- \
  psql -U postgres -d workflow_builder -c \
  "select column_name from information_schema.columns where table_schema='public' and table_name='workflow_executions' order by ordinal_position;"
```

App-side compatibility check:

```bash
curl -s http://localhost:3002/api/internal/health/workflow-executions-schema
```

## Local Development (DevSpace)

```bash
devspace dev
```

DevSpace targets the existing Argo-managed `workflow-builder` Deployment in the
`workflow-builder` namespace on the `kind-ryzen` cluster. It does not create a
separate long-lived dev environment outside the cluster.

What DevSpace does:
- replaces the `workflow-builder` container with the shared
  `nodejs-22-devspace` image
- keeps the existing Dapr sidecar and cluster-native service DNS
- syncs the app repo into `/app`
- starts `next dev --turbo` in-cluster
- port-forwards `localhost:3002 -> 3000`
- enables SSH via `ssh app.workflow-builder.devspace`

What's synced:
- `app/`
- `components/`
- `lib/`
- repo-level files needed by the Next.js app

What's excluded:
- `services/` (separate deployments)
- `node_modules/`
- `.next/`
- other generated artifacts

The public URL and auth callback URL for `kind-ryzen` are:
- `https://workflow-builder-ryzen.tail286401.ts.net`

### Shared Dev Image Requirement

The DevSpace pod uses the shared image:

```bash
gitea.cnoe.localtest.me/giteaadmin/nodejs-22-devspace:latest
```

On `kind-ryzen`, the fastest and most reliable path is to load that image
directly into the cluster nodes instead of pushing it to Gitea first.

If the image is not already present on the nodes, build or retag it locally and
load it:

```bash
docker build -f Dockerfile.devspace \
  -t gitea.cnoe.localtest.me/giteaadmin/nodejs-22-devspace:latest .

kind load docker-image \
  gitea.cnoe.localtest.me/giteaadmin/nodejs-22-devspace:latest \
  --name ryzen
```

If you already have the older local tag, retag it and load it:

```bash
docker tag \
  gitea.cnoe.localtest.me:8443/giteaadmin/nodejs-22-devspace:latest \
  gitea.cnoe.localtest.me/giteaadmin/nodejs-22-devspace:latest

kind load docker-image \
  gitea.cnoe.localtest.me/giteaadmin/nodejs-22-devspace:latest \
  --name ryzen
```

### Expected Startup Output

On a healthy start, `devspace dev` will eventually show:

```text
dev:app Selected pod workflow-builder-devspace-...
dev:app ports Port forwarding started on: 3002 -> 3000
dev:app sync  Sync started on: ./ <-> /app
dev:app sync  Initial sync completed
dev:app ssh   Port forwarding started on: 2223 -> 8022
dev:app ssh   Use 'ssh app.workflow-builder.devspace' to connect via SSH
```

### If DevSpace Gets Stuck In `ImagePullBackOff`

This usually means the shared dev image is missing from the cluster under the
exact image name DevSpace requested.

Check the pod events:

```bash
kubectl describe pod -n workflow-builder <devspace-pod-name>
```

If you see:

```text
Failed to pull image "gitea.cnoe.localtest.me/giteaadmin/nodejs-22-devspace:latest": not found
```

load the image into kind and delete the stuck pod so it restarts immediately:

```bash
kind load docker-image \
  gitea.cnoe.localtest.me/giteaadmin/nodejs-22-devspace:latest \
  --name ryzen

kubectl delete pod -n workflow-builder <devspace-pod-name>
```

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
kubectl logs -n workflow-builder -l app=function-router -c function-router --tail=50
kubectl logs -n workflow-builder -l app=fn-activepieces --tail=50
kubectl logs -n workflow-builder -l app=fn-system --tail=50
```

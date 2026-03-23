# Deployment & Infrastructure

This document describes the current deployment model for `workflow-builder` on `kind-ryzen`.

## Current Cluster Shape

Current `workflow-builder` namespace runtime:

- `workflow-builder`
- `workflow-orchestrator`
- `function-router`
- `dapr-agent-runtime`
- `durable-agent`
- `ms-agent-workflow`
- `fn-activepieces`
- `postgresql`
- Dapr sidecars and backing Redis / pub-sub infrastructure

Important distinction:

- app repos build images
- `stacks/main` declares which images and manifests ArgoCD should run

## Two Deployment Modes

### 1. DevSpace inner loop

Use this for fast iteration on app code.

- DevSpace swaps selected workloads with `*-devspace` replacements
- it is useful for hot reload and sync
- it is not the authoritative cluster deployment state

Use DevSpace when you are editing code. Do not use DevSpace alone to prove that the cluster reflects the intended architecture.

### 2. Git-backed cluster rollout

Use this to update the real cluster state.

Typical flow:

1. build the required images
2. push them to the local Gitea registry or load them into KIND
3. update image refs and manifests in `stacks/main`
4. push `stacks/main`
5. let ArgoCD reconcile

On `ryzen`, pushing only the app repo does not change live cluster state.

## Current Coding Stack Rollout

For the validated coding path, a rollout usually involves:

- `workflow-builder`
- `workflow-orchestrator`
- `function-router`
- `dapr-agent-runtime`
- `durable-agent`
- sometimes `ai-chatbot` in its own repo and app

Compatibility services such as `ms-agent-workflow` should only be rebuilt when those code paths change.

## Current Desired Runtime Behavior

The live coding path should be:

1. `workflow-builder` starts a run
2. `workflow-orchestrator` owns the durable parent workflow
3. `function-router` routes `openshell-langgraph/run` to `dapr-agent-runtime`
4. `dapr-agent-runtime` performs planning/execution child work
5. `durable-agent` persists change sets, patches, and file snapshots
6. review APIs serve persisted artifacts back to the UI

If the live cluster is not behaving like that, first check whether the correct image tags are pinned in `stacks/main`.

## Build Guidance

Examples:

```bash
# Next.js app uses repo root as build context
docker build -t gitea.cnoe.localtest.me/giteaadmin/workflow-builder:git-<sha> .

# Python orchestrator
docker build -t gitea.cnoe.localtest.me/giteaadmin/workflow-orchestrator:git-<sha> \
  -f services/workflow-orchestrator/Dockerfile services/workflow-orchestrator/

# LangGraph coding backend
docker build -t gitea.cnoe.localtest.me/giteaadmin/dapr-agent-runtime:git-<sha> \
  -f services/dapr-agent-runtime/Dockerfile .

# Shared artifact service
docker build -t gitea.cnoe.localtest.me/giteaadmin/opencode-durable-agent:git-<sha> \
  -f services/durable-agent/Dockerfile services/durable-agent/

# Router
docker build -t gitea.cnoe.localtest.me/giteaadmin/function-router:git-<sha> \
  -f services/function-router/Dockerfile .
```

## Validation Checklist

After a live rollout, verify:

1. Argo apps are `Synced` and `Healthy`
2. all core pods are `Running` with healthy Dapr sidecars
3. a fresh coding run reaches `awaiting_approval`
4. approval resumes execution
5. tool details stream in the run UI
6. `/changes`, `/patch`, and `/files/snapshot/...` return persisted data for the run

## Operational Notes

### Dapr first

If a pod is healthy at the app container level but the pod is not fully ready, inspect the Dapr control plane before assuming the app rollout is broken.

### Parent workflow owns timeouts

Long-running agent execution should not fail because of a synchronous HTTP timeout between services. The durable parent workflow owns timeout policy.

### Review data must be durable

For new successful text-file coding runs:

- `/changes` should resolve to a real persisted change set
- `/patch` should return a persisted patch
- `/files/snapshot/...` should return durable snapshots

Patch-only fallback is acceptable for historical runs, not for newly persisted ones.

## Key Environment Expectations

Important environment variables and dependencies:

- `DATABASE_URL`
- `INTERNAL_API_TOKEN`
- `WORKFLOW_ORCHESTRATOR_URL`
- `DAPR_HOST`
- `DAPR_HTTP_PORT`
- local Gitea registry reachability from KIND nodes
- healthy `dapr-system`

## Related Docs

- `docs/architecture.md`
- `docs/services.md`
- `../stacks/main/docs/devspace-gitops-promoter-workflow.md`

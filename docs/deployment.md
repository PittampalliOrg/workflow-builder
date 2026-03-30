# Deployment & Infrastructure

This document describes the current deployment model for `workflow-builder`.

## Current Cluster Shape

The active cluster shape is:

- `workflow-builder`
- `workflow-orchestrator`
- `function-router`
- `openshell-agent-runtime`
- `openshell-langgraph-observable`
- `durable-agent`
- `fn-activepieces`
- `postgresql`
- Dapr sidecars and their Redis/pub-sub backing services

## Deployment Truth

There are two different operating modes and they are not equivalent.

### DevSpace inner loop

Use this for fast local iteration:

```bash
./scripts/devspace-dev-ryzen.sh
```

This swaps selected workloads with `*-devspace` replacements and syncs local files into the running pods.

It is useful for:

- UI iteration
- API route iteration
- runtime code debugging

It is not the authoritative cluster deployment state.

### GitOps rollout

Use this to change the real cluster:

1. build images
2. push image tags to the in-cluster registry
3. update `stacks/main`
4. let ArgoCD reconcile

On `ryzen`, changing only this repo does not change the real cluster until the corresponding `stacks/main` change lands.

## Build and Promotion Model

The cluster uses a GitOps and in-cluster build flow:

- app repos contain source
- Tekton builds images in the hub cluster
- Gitea stores the built image tags
- `stacks/main` pins the live image refs
- ArgoCD reconciles the runtime from `stacks/main`

If the live cluster does not match local code, first check whether the image tags and manifests in `stacks/main` were updated.

## Runtime Expectations

The expected live coding path is:

1. `workflow-builder` starts a run
2. `workflow-orchestrator` resolves draft or published execution target
3. `function-router` routes OpenShell workspace, browser, and standard agent actions to `openshell-agent-runtime`
4. `workflow-orchestrator` starts native child workflows for `openshell-langgraph-observable/run`
5. `durable-agent` persists patches, snapshots, and related review artifacts
6. the UI reads persisted artifacts back through the BFF

## Validation Checklist

After a real rollout, verify:

1. Argo apps are `Synced` and `Healthy`
2. all core pods are `Running` with healthy Dapr sidecars
3. `function-router` routes `workspace/*`, `browser/*`, and `openshell/*` to the intended runtimes
4. a fresh OpenShell-backed workflow run progresses through workspace creation and clone
5. coding runs persist patch, change-set, and snapshot artifacts
6. published workflows appear in runtime introspection and can execute by name/version

## Operational Notes

### Dapr health matters

If a pod looks healthy at the app container level but the overall pod is not ready, inspect the Dapr sidecar and control plane before assuming the app rollout is broken.

### Parent workflow owns timeouts

Long-running agent execution should be governed by the parent durable workflow timeout, not by ad hoc inter-service HTTP timeouts.

### Review data must be durable

For successful coding runs:

- `/changes` should resolve from persisted artifacts
- `/patch` should return a durable patch
- `/files/snapshot/...` should return durable snapshots

Patch-only fallback is acceptable for historical runs, not for newly persisted OpenShell runs.

## Environment Expectations

Important runtime dependencies include:

- `DATABASE_URL`
- `INTERNAL_API_TOKEN`
- `WORKFLOW_ORCHESTRATOR_URL`
- `DAPR_HOST`
- `DAPR_HTTP_PORT`
- OpenShell runtime availability
- local Gitea registry reachability from cluster nodes
- healthy `dapr-system`

## Related Docs

- [docs/architecture.md](/home/vpittamp/repos/PittampalliOrg/workflow-builder/main/docs/architecture.md)
- [docs/services.md](/home/vpittamp/repos/PittampalliOrg/workflow-builder/main/docs/services.md)

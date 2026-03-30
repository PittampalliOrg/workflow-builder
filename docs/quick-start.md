# Quick Start

This quick start is for the current internal `workflow-builder` system, not the old starter-template flow.

## Prerequisites

- `pnpm`
- access to the `ryzen` cluster context
- DevSpace installed
- access to the sibling `stacks/main` repo for GitOps changes

## Local Repo Setup

```bash
pnpm install
pnpm fix
pnpm type-check
```

## Fast Inner Loop

Start the DevSpace-based development session:

```bash
./scripts/devspace-dev-ryzen.sh
```

That gives you live iteration against the current OpenShell-based runtime stack.

Use this path when you are:

- editing the UI
- editing BFF routes
- debugging orchestrator or router behavior
- testing workflow changes quickly

## Core Services to Watch

During active development, the most relevant services are:

- `workflow-builder`
- `workflow-orchestrator`
- `function-router`
- `openshell-agent-runtime`
- `openshell-langgraph-observable`

## Create and Run a Workflow

1. Open the app.
2. Create or select a workflow.
3. Save it as a draft.
4. Execute it from the UI.
5. Inspect status, logs, patch, changes, snapshots, and browser artifacts in the run UI.

For OpenShell-backed coding flows, the common starting shape is:

1. `Workspace Profile`
2. `Workspace Clone`
3. `OpenShell Run` or `OpenShell Session Start`

Repo selection should normally be configured on `workspace/clone`, not repeatedly requested in the trigger.

## Publish a Workflow

Publishing is separate from saving.

The normal flow is:

1. save the workflow
2. publish it in the editor
3. restart or redeploy `workflow-orchestrator`
4. verify the published revision is registered in runtime introspection

Draft runs execute through `dynamic_workflow`. Published runs execute as registered named and versioned Dapr workflows.

## Real Cluster Rollout

DevSpace is not enough to change the GitOps-managed cluster.

For a real rollout:

1. build images
2. push them to the in-cluster registry
3. update `stacks/main`
4. let ArgoCD reconcile

If live behavior and local code disagree, check `stacks/main` first.

## Basic Troubleshooting

### Workflow fails before child work starts

Check:

- `workflow-orchestrator` logs
- `function-router` logs
- workflow execution rows and logs in Postgres

### Workspace or clone fails

Check:

- `openshell-agent-runtime` health
- `workspace/profile` and `workspace/clone` routing
- connection/auth resolution on `workspace/clone`

### Published workflow does not run as published

Check:

- the workflow has `publishedRuntime` metadata
- the desired revision exists
- `workflow-orchestrator` has restarted since publish
- runtime introspection shows the published workflow name/version

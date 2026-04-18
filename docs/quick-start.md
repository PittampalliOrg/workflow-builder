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

## Tests

```bash
pnpm test:unit                                      # vitest, pure logic
pnpm test:e2e                                       # playwright, defaults to localhost:3000
BASE_URL=https://workflow-builder.tail286401.ts.net pnpm test:e2e
```

The e2e suite is intentionally thin today — it probes the auth boundary of every CMA-parity endpoint so regressions are caught immediately. Full user-facing E2E awaits a reusable auth fixture. See `docs/cma-parity.md` for the surface map.

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
- `dapr-agent-py`
- `openshell-agent-runtime`
- `dapr-swe` when you are working on the distributed coding flow

## Create and Run a Workflow

1. Open the app.
2. Create or select a workflow.
3. Save it as a draft.
4. Execute it from the UI.
5. Inspect status, logs, patch, changes, snapshots, and browser artifacts in the run UI.

When a workflow requires source control inputs, the execute dialog prompts for the configured SCM connection, owner, repository, and issue context. Repository dropdowns are constrained to the dialog viewport so large repo lists remain selectable. If you choose to create a new repository instead of selecting an existing repository, the UI generates a unique repository name automatically and lets you regenerate it before launching the run.

For OpenShell-backed coding flows, the common starting shape is:

1. `Workspace Profile`
2. `Workspace Clone` when the run needs repository contents, or skip it for a connection-only smoke test
3. `durable/run`

Repo selection should normally be configured on `workspace/clone`, not repeatedly requested in the trigger. For UI-runnable `durable/run` workflows, prefer a trigger prompt field and reference it from the action with `${ .trigger.prompt }`.

For an MCP-enabled agent smoke workflow, configure the MCP server under `durable/run.with.agentConfig.mcpServers` and add `x-workflow-builder.input` metadata so the run dialog renders a prompt textarea. See `docs/mcp-agent-workflows.md` for the current working pattern.

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

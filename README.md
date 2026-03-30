# Workflow Builder

Workflow Builder is the internal visual workflow system used to design, run, publish, and review durable workflows on Kubernetes.

It is not a generic starter template anymore. The live platform is built around:

- `workflow-builder`: Next.js UI and BFF
- `workflow-orchestrator`: Python Dapr Workflow owner
- `function-router`: action router
- `openshell-agent-runtime`: OpenShell workspace, browser, and standard agent runtime
- `openshell-langgraph-observable`: specialized OpenShell LangGraph coding backend
- `durable-agent`: durable artifact and review-data service
- `fn-activepieces`: default SaaS action backend

## Current Model

The system now has two workflow execution modes:

- Draft workflows
  - saved in Postgres
  - executed by the generic Dapr workflow interpreter `dynamic_workflow`
- Published workflows
  - frozen into immutable revision snapshots in `spec.metadata.publishedRuntime`
  - registered at orchestrator startup as named and versioned Dapr workflows
  - executed by stable workflow name and version

The system now has one active sandbox model for agent work:

- OpenShell-only sandboxes for coding, session handoff, workspace actions, and browser validation

Retired paths such as `dapr-agent`, `ms-agent`, `openshell-durable`, and `agent-sandbox` are no longer part of the active runtime.

## Core Concepts

### Workflow definition

Workflows are stored in Postgres with both the visual `nodes` / `edges` representation and a canonical `spec`.

The UI edits saved workflow data. The orchestrator interprets that saved definition at runtime.

### Draft vs published

Saving a workflow does not publish it.

- Save:
  - persists the current workflow definition
  - keeps execution on `dynamic_workflow`
- Publish:
  - creates an immutable revision snapshot
  - assigns a stable workflow name like `wf_<workflowId>`
  - assigns an immutable version like `pub_<...>`
  - requires orchestrator startup to load and register that revision with Dapr

### OpenShell agent actions

The supported OpenShell-backed agent actions are:

- `openshell/run`
- `openshell/session-start`
- `openshell-langgraph-observable/run`

Typical workspace-backed flows use:

- `workspace/profile`
- `workspace/clone`
- `workspace/command`
- `browser/validate`

All of those route to OpenShell-backed runtimes.

## Request Flow

1. The browser calls the `workflow-builder` BFF.
2. The BFF starts or inspects a workflow through `workflow-orchestrator`.
3. `workflow-orchestrator` runs the durable parent workflow.
4. Action nodes are routed through `function-router`.
5. `function-router` sends:
   - `workspace/*`, `browser/*`, and `openshell/*` to `openshell-agent-runtime`
   - `openshell-langgraph-observable/*` to `openshell-langgraph-observable`
   - all other plugin-backed actions to `fn-activepieces`
6. Execution metadata, child-run state, and review artifacts are persisted to Postgres.
7. The UI reads status, logs, patch, change-set, snapshot, and published-workflow metadata back through the BFF.

## Review Data

Successful coding runs should produce durable review data:

- child-run metadata
- patch
- file-change summaries
- file snapshots
- browser artifacts when validation is configured

The UI should prefer persisted artifacts over live workspace state.

## Development

### Local app checks

```bash
pnpm install
pnpm fix
pnpm type-check
```

### DevSpace inner loop

Use the repo script:

```bash
./scripts/devspace-dev-ryzen.sh
```

That is the fast iteration path for the live `ryzen` cluster, but it is not the authoritative cluster deployment state.

### GitOps rollout

The real cluster state is controlled by `stacks/main`.

The normal production-like flow is:

1. build images
2. push tags to the in-cluster registry
3. update `stacks/main`
4. let ArgoCD reconcile

On `ryzen`, changing only this repo does not change the real cluster until `stacks/main` is updated.

## Key APIs

### Workflow management

- `GET /api/workflows`
- `GET /api/workflows/:id`
- `PUT /api/workflows/:id`
- `POST /api/workflows/:id/publish`
- `GET /api/workflows/:id/published/:version`

### Workflow execution

- `POST /api/workflows/:id/execute`
- `POST /api/v2/workflows/execute-by-id`
- `GET /api/workflows/executions/:executionId/status`
- `GET /api/workflows/executions/:executionId/logs`
- `GET /api/workflows/executions/:executionId/changes`
- `GET /api/workflows/executions/:executionId/patch`

## Related Docs

- [ARCHITECTURE.md](/home/vpittamp/repos/PittampalliOrg/workflow-builder/main/ARCHITECTURE.md)
- [docs/architecture.md](/home/vpittamp/repos/PittampalliOrg/workflow-builder/main/docs/architecture.md)
- [docs/services.md](/home/vpittamp/repos/PittampalliOrg/workflow-builder/main/docs/services.md)
- [docs/deployment.md](/home/vpittamp/repos/PittampalliOrg/workflow-builder/main/docs/deployment.md)
- [docs/quick-start.md](/home/vpittamp/repos/PittampalliOrg/workflow-builder/main/docs/quick-start.md)

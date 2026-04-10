# Workflow Builder Architecture

Workflow Builder is a visual workflow system that uses Dapr Workflows for durable orchestration, OpenShell-backed sandboxes for agent execution, and Postgres-backed review artifacts for patches, file snapshots, browser captures, and child-run metadata.

## Current Runtime Model

The active runtime on `kind-ryzen` and the GitOps-managed cluster is:

- `workflow-builder`: SvelteKit UI and BFF
- `workflow-builder-svelte`: alternate Svelte frontend deployment
- `workflow-orchestrator`: Python Dapr durable workflow owner
- `function-router`: action router
- `openshell-agent-runtime`: canonical OpenShell workspace, browser, and standard agent runtime
- `dapr-swe`: separate distributed coding workflow runtime
- `fn-activepieces`: default SaaS action backend
- `postgresql`: workflow definitions, executions, artifacts, approvals, and child-run metadata
- `redis` plus Dapr sidecars: workflow state, pub/sub, service invocation, and actor durability

The active runtime model is OpenShell-only for sandboxed agent work.

## Design Principles

### One durable parent workflow

`workflow-orchestrator` is the orchestration owner for long-running workflows. It owns:

- parent workflow state
- approval gates and timeouts
- child-run scheduling
- final execution phase and status

Agent runtimes do not own orchestration. They execute child work and return normalized results to the parent workflow.

### Data-driven definitions

Workflow Builder stores workflows as data:

- `nodes` and `edges` for the editor
- canonical `spec` for execution and publishing

The system still uses a generic dynamic workflow interpreter for draft workflows. That lets the UI create and save new workflows without rebuilding the orchestrator.

### Published workflows are frozen revisions

Published workflows are not just “saved” workflows.

Publishing:

- freezes the current workflow definition into `spec.metadata.publishedRuntime.revisions[*].definition`
- assigns a stable workflow name such as `wf_<workflowId>`
- assigns an immutable version such as `pub_<...>`
- makes the workflow eligible for versioned registration at orchestrator startup

At startup, `workflow-orchestrator` loads published revisions from Postgres and registers them with Dapr via `register_versioned_workflow`.

That gives the system two execution modes:

- draft: run through `dynamic_workflow`
- published: run through the registered workflow name and revision version

### One sandbox substrate

All active sandbox-backed agent work now runs on OpenShell.

Supported agent actions:

- `durable/run`

Supported workspace/browser actions:

- `workspace/profile`
- `workspace/clone`
- `workspace/command`
- `workspace/cleanup`
- `browser/*`

Those all route to OpenShell-backed runtimes.

### Durable review artifacts

For successful coding runs, the review surface is persisted independently of the live sandbox:

- workflow execution rows
- workflow execution logs
- workflow agent runs
- workflow agent events
- plan artifacts
- file-change summaries
- patches
- file snapshots
- browser artifacts

The UI should prefer persisted artifacts over live workspace state.

## High-Level Architecture

```text
browser
  -> workflow-builder
  -> workflow-orchestrator
     -> function-router
        -> system/* handlers
        -> workspace/* and browser/* -> openshell-agent-runtime
        -> durable/* -> durable-agent
        -> dapr-swe/* -> dapr-swe
        -> _default -> fn-activepieces

workflow-orchestrator
  -> dynamic_workflow for drafts
  -> versioned registered workflows for published revisions

openshell-agent-runtime / dapr-swe
  -> OpenShell sandboxes or dedicated coding workers
  -> PostgreSQL-backed review surfaces
```

## Core Request Paths

### Visual workflow execution

1. The browser starts a run through `workflow-builder`.
2. The BFF calls `workflow-orchestrator`.
3. `workflow-orchestrator` resolves the execution target:
   - draft -> `dynamic_workflow`
   - published -> registered workflow name/version
4. Action nodes are routed through `function-router`.
5. The parent workflow persists status and review data as the run progresses.

### Standard durable agent coding run

1. A workflow node uses `durable/run`.
2. `workflow-orchestrator` schedules the durable child workflow from the parent workflow.
3. `durable-agent` runs the durable control loop.
4. `durable-agent` binds or creates an OpenShell workspace for the workflow execution.
5. All tool and file operations run through `openshell-agent-runtime` against that workspace.
6. Review artifacts are persisted to Postgres.

### Legacy workflow compatibility

1. Older saved workflows may still contain deprecated agent action types.
2. `workflow-orchestrator` rejects deprecated embedded-agent actions at runtime.
3. New workflow definitions must use `durable/run`.

### Browser validation

1. Browser validation runs through `browser/*`.
2. `function-router` routes that to `openshell-agent-runtime`.
3. The runtime materializes the persisted execute result into a browser workspace.
4. The preview server and browser capture run against that materialized state.
5. The resulting artifact is stored durably and exposed back to the UI.

## Component Responsibilities

### workflow-builder

Provides:

- Svelte Flow editor (@xyflow/svelte)
- workflow save and publish UX
- run launch, approval, and review UI
- BFF routes for orchestrator and execution data

### workflow-orchestrator

Provides:

- the generic Dapr workflow interpreter
- published workflow registration
- parent timeout and approval ownership
- child-run scheduling
- normalized execution state in Postgres

Key areas:

- `services/workflow-orchestrator/workflows/dynamic_workflow.py`
- `services/workflow-orchestrator/app.py`
- `services/workflow-orchestrator/activities/call_agent_service.py`
- `services/workflow-orchestrator/activities/track_agent_run.py`

### function-router

Provides:

- route lookup by `actionType`
- routing for `system/*`, `workspace/*`, `browser/*`
- routing for `dapr-swe/*`
- fallback routing to `fn-activepieces`

### openshell-agent-runtime

Provides:

- OpenShell-backed workspace profile, clone, command, and cleanup
- browser materialization and validation

It is a runtime backend, not the orchestration owner.

## Persisted Data Model

### PostgreSQL stores

- workflow definitions
- workflow executions
- workflow execution logs
- approval events
- workflow agent runs and events
- plan artifacts
- workspace sessions
- browser artifacts
- published workflow metadata and revision snapshots

### Dapr stores

Dapr durability is used for:

- workflow state and replay
- timers and external events
- child workflow delivery
- service invocation and pub/sub plumbing

Dapr state is not the review surface. The review surface is the persisted execution artifact set in Postgres.

## Operator Mental Model

When debugging the system, check in this order:

1. Is the parent workflow healthy in `workflow-orchestrator`?
2. Did `workflow-orchestrator` resolve the workflow as draft or published?
3. Did `function-router` route the action to the intended backend?
4. Did the OpenShell runtime or LangGraph runtime produce normalized child-run output?
5. Did the run persist durable review artifacts?
6. Is the UI reading those persisted artifacts instead of a fallback?

## Deployment Truth

On `ryzen`, app code and cluster manifests are separate concerns:

- app repos produce images
- `stacks/main` declares the live image tags and manifests ArgoCD should run

Changing only this repo does not change the real cluster until the corresponding `stacks/main` updates are applied.

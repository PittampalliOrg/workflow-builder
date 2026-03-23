# Workflow Builder Architecture

Workflow Builder is a visual workflow system that uses Dapr Workflows for durable orchestration, a repo-aware agent execution layer for coding tasks, and durable review artifacts for traces, patches, and file snapshots.

## Current Runtime Model

The validated `kind-ryzen` / active-development runtime is:

- `workflow-builder`: Next.js UI and BFF
- `workflow-orchestrator`: Python Dapr durable workflow owner
- `function-router`: repo-aware action router
- `dapr-agent-runtime`: LangGraph / DeepAgents-compatible coding backend for `openshell-langgraph/run`
- `durable-agent`: shared workspace session and durable change-artifact service
- `ms-agent-workflow`: compatibility backend under the same durable parent model
- `fn-activepieces`: default SaaS action backend
- `postgresql`: workflow definitions, execution state, approvals, child-run metadata, and durable review artifacts
- `redis` + Dapr sidecars: workflow state, pub/sub, invocation, actors

Historical docs and older manifests may still mention `openshell-agent-runtime`, `function-runner`, or older `durable-agent` execution ownership. Those are not the current primary execution path on `ryzen`.

## Design Principles

### One durable parent workflow

`workflow-orchestrator` is the orchestration owner for long-running workflows. It owns:

- durable parent workflow state
- approval gates and timeouts
- child-run scheduling
- final workflow status

Agent backends do not own orchestration. They execute child work and report progress/results back to the parent.

### One shared agent lifecycle

The desired contract across agent backends is:

1. load or create a workspace profile
2. clone or reconnect to the target repo
3. execute planning or coding work in the chosen backend
4. persist review artifacts as a durable execution change set
5. expose changes, patch, and file snapshots through the review APIs

This keeps repo preparation and review persistence consistent even when the reasoning backend changes.

### Durable review artifacts

For successful coding runs, review data is persisted independently of the live workspace:

- child-run metadata
- plan artifacts
- traces and trace IDs
- file-change summaries
- unified patches
- file snapshots with `oldContent`, `newContent`, `oldPath`, and `status`

The review UI should read those persisted artifacts, not ephemeral workspace state.

## High-Level Architecture

```text
browser
  -> workflow-builder (Next.js UI + BFF)
  -> workflow-orchestrator (Dapr durable parent workflow)
     -> function-router
        -> system/* and workspace/* handlers
        -> fn-activepieces for SaaS actions
        -> dapr-agent-runtime for openshell-langgraph/run and dapr-agent/run
        -> ms-agent-workflow for ms-agent/run

dapr-agent-runtime
  -> shared workspace/session contract
  -> durable-agent change-artifact service
  -> persisted review artifacts in PostgreSQL
```

## Core Request Paths

### Visual workflow execution

1. Browser starts a run through `workflow-builder`.
2. The BFF calls `workflow-orchestrator`.
3. `workflow-orchestrator` interprets the stored workflow definition.
4. Action nodes are routed through `function-router`.
5. Execution state is persisted durably and exposed back through the BFF.

### Durable coding execution

1. A workflow node selects `openshell-langgraph/run`.
2. `workflow-orchestrator` starts a durable child-run sequence for that node.
3. `function-router` routes the action to `dapr-agent-runtime`.
4. `dapr-agent-runtime` starts the planning child run and returns child identity immediately.
5. The parent workflow persists approval context and waits durably for approval.
6. After approval, the orchestrator starts the execute child run.
7. The backend performs repo-aware coding work through the shared workspace/session contract.
8. `durable-agent` persists the final change set, patch, and file snapshots.
9. The parent workflow records normalized child output and completes.

### Compatibility backends

Compatibility runtimes still exist, but they run under the same parent workflow contract:

- `openshell-langgraph/run` -> `dapr-agent-runtime`
- `dapr-agent/run` -> `dapr-agent-runtime`
- `ms-agent/run` -> `ms-agent-workflow`

## Component Responsibilities

### workflow-builder

Provides:

- React Flow visual builder
- run launch and approval UX
- run review UI for logs, traces, changes, patch, and snapshots
- BFF routes that proxy to orchestrator and internal review endpoints

### workflow-orchestrator

Provides:

- generic Dapr workflow interpreter
- durable approval waits
- child-run scheduling and timeout ownership
- normalized execution state in PostgreSQL
- internal APIs for workflow status and agent review data

Key files:

- `services/workflow-orchestrator/workflows/dynamic_workflow.py`
- `services/workflow-orchestrator/activities/call_agent_service.py`
- `services/workflow-orchestrator/activities/track_agent_run.py`
- `services/workflow-orchestrator/app.py`

### function-router

Provides:

- routing for `system/*` and `workspace/*`
- routing for agent backends
- default routing to `fn-activepieces`
- runtime contract normalization between the parent workflow and child services

Important current routes:

- `openshell-langgraph/*` -> `dapr-agent-runtime`
- `dapr-agent/*` -> `dapr-agent-runtime`
- `ms-agent/*` -> `ms-agent-workflow`
- `_default` -> `fn-activepieces`

### dapr-agent-runtime

Provides:

- LangGraph / DeepAgents-compatible coding execution
- planning and execute child runs
- durable progress events for tool calls and sandbox output
- final execution review artifact publication

It is an execution backend, not the orchestration owner.

### durable-agent

Provides shared durable services around coding runs:

- workspace profiles and repo sessions
- execution change-artifact persistence
- patch and snapshot storage
- durable read APIs for review data

This is where backend-independent review data should live.

### ms-agent-workflow

Provides template-driven Microsoft-agent execution under the same durable parent workflow model. It is a compatibility backend, not the core coding path on `ryzen`.

## Persisted Data Model

### PostgreSQL stores

- workflow definitions
- workflow executions
- approval records
- child-run metadata
- plan artifacts
- execution change sets
- persisted file snapshots

### Dapr stores

Dapr durability is used for:

- workflow state and replay
- timers and external events
- child workflow delivery
- service invocation and pub/sub support

Dapr state is not the review surface. The review surface is the persisted execution artifact set.

## Review Pipeline

For coding runs, the review UI should reason about data in this order:

1. persisted execution change set
2. persisted patch
3. persisted file snapshots
4. historical compatibility fallback only when an old run predates snapshot persistence

For new successful text-file runs, missing snapshots should be treated as a bug signal, not normal behavior.

## Approval and Timeout Semantics

- Parent workflow timeout is authoritative.
- Long-running child execution must not be treated as a long blocking HTTP request.
- Approval waits are durable external events against the parent workflow.
- Child execution can outlive an individual HTTP request, but it must not outlive the parent timeout policy silently.

## Current Operator Mental Model

When debugging `workflow-builder`, think in this order:

1. Is the parent workflow healthy in `workflow-orchestrator`?
2. Did `function-router` route the action to the intended backend?
3. Did the child backend produce durable agent progress events?
4. Did the backend persist a real execution change set?
5. Is the UI reading persisted review data rather than a fallback?

## Deployment Truth

On `ryzen`, app code and cluster manifests are separate concerns:

- app repos produce images
- `stacks/main` declares which image tags and manifests Argo should run

Pushing only app code is not enough to change the live cluster. Live state changes when the required images exist and `stacks/main` is updated to point at them.

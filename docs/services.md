# Services Reference

This document describes the services that make up the current `workflow-builder` runtime on `kind-ryzen`.

## Core Runtime

The primary runtime to reason about today is:

- `workflow-builder`
- `workflow-orchestrator`
- `function-router`
- `openshell-agent-runtime`
- `openshell-langgraph-observable`
- `durable-agent`
- `fn-activepieces`
- `postgresql`

Retained but not on the core path:

- `workflow-mcp-server`
- `piece-mcp-server`
- `mcp-gateway`
- `node-sandbox`

## workflow-builder (Next.js)

Human-facing app and BFF.

- Port: `3000`
- Responsibilities:
  - visual workflow builder
  - run launch and approval UX
  - review UI for logs, traces, changes, patch, and file snapshots
  - proxy/BFF routes into workflow-orchestrator and internal review APIs

## workflow-orchestrator (Python / FastAPI)

Durable workflow owner.

- Port: `8080`
- Dapr app-id: `workflow-orchestrator`
- Responsibilities:
  - interpret workflow definitions
  - own Dapr parent workflow state
  - schedule child runs and timers
  - own approval waits and timeouts
  - normalize execution state into PostgreSQL
- Key endpoints:
  - `POST /api/v2/workflows`
  - `POST /api/v2/workflows/execute-by-id`
  - `GET /api/v2/workflows/{id}/status`
  - `POST /api/v2/workflows/{id}/events`
  - `POST /api/v2/workflows/{id}/terminate`
- Important behavior:
  - long-running agent runs use native Dapr child-workflow semantics
  - parent timeout is authoritative
  - approval waits are durable external events

## function-router (TypeScript)

Repo-aware action router.

- Port: `8080`
- Dapr app-id: `function-router`
- Key endpoint:
  - `POST /execute`
- Responsibilities:
  - route `system/*`, `workspace/*`, and `browser/*`
  - route agent actions to the correct backend
  - default unknown action slugs to `fn-activepieces`
- Important current routes:
  - `workspace/*` -> `openshell-agent-runtime`
  - `browser/*` -> `openshell-agent-runtime`
  - `openshell/run` -> `openshell-agent-runtime`
  - `openshell/session-start` -> `openshell-agent-runtime`
  - `openshell-langgraph-observable/run` -> `openshell-langgraph-observable`
  - `_default` -> `fn-activepieces`

## openshell-agent-runtime (Python)

Canonical OpenShell workspace, browser, and standard agent runtime.

- Port: `8080`
- Dapr app-id: `openshell-agent-runtime`
- Responsibilities:
  - workspace profile/clone/cleanup
  - standard `openshell/run` execution
  - retained `openshell/session-start` execution
  - browser materialization, dev-server startup, and capture
- Important behavior:
  - owns the canonical OpenShell sandbox/session registry for active workspace-backed flows
  - browser validation runs against materialized change artifacts, not stale clones
  - emits sandbox metadata and browser artifacts used by the review UI

## durable-agent (TypeScript / Express)

Shared durable workspace and review-artifact service.

- Port: `8001`
- Dapr app-id: `durable-agent`
- Responsibilities:
  - workspace profile and repo session management
  - change-artifact persistence
  - durable patch and file-snapshot storage
  - artifact read/write APIs shared across backends
- Important behavior:
  - not the primary LangGraph execution backend on `ryzen`
  - is the shared durable service for repo/session/review persistence

## openshell-langgraph-observable (Python)

Specialized OpenShell LangGraph coding backend.

- Port: `8003`
- Dapr app-id: `openshell-langgraph-observable`
- Responsibilities:
  - planning/execute child workflows for complex coding runs
  - repo-aware coding execution in OpenShell sandboxes
  - durable progress events and review artifact publication

## fn-activepieces (TypeScript)

Default SaaS action backend.

- Port: `8080`
- Responsibilities:
  - execute Activepieces piece actions
  - satisfy `_default` routes from `function-router`

## Shared Runtime Contract

Across agent backends, the desired stable behavior is:

1. create/load workspace profile
2. clone or reconnect repo
3. run backend-specific planning/execution
4. persist final patch + file snapshots
5. expose review APIs from persisted artifacts

That contract is part of the platform architecture and should not depend on the specific reasoning backend.

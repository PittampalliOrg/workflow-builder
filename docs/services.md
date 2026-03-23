# Services Reference

This document describes the services that make up the current `workflow-builder` runtime on `kind-ryzen`.

## Core Runtime

The primary runtime to reason about today is:

- `workflow-builder`
- `workflow-orchestrator`
- `function-router`
- `dapr-agent-runtime`
- `durable-agent`
- `fn-activepieces`
- `ms-agent-workflow`
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
  - route `system/*` and `workspace/*`
  - route agent actions to the correct backend
  - default unknown action slugs to `fn-activepieces`
- Important current routes:
  - `openshell-langgraph/*` -> `dapr-agent-runtime`
  - `dapr-agent/*` -> `dapr-agent-runtime`
  - `ms-agent/*` -> `ms-agent-workflow`
  - `_default` -> `fn-activepieces`

## dapr-agent-runtime (Python)

Current coding backend for the validated LangGraph/OpenShell path.

- Port: `8080`
- Dapr app-id: `dapr-agent-runtime`
- Responsibilities:
  - planning and execution child runs
  - LangGraph / DeepAgents-compatible tool execution
  - durable progress events for tool calls and sandbox output
  - final execution artifact publication
- Important behavior:
  - used for `openshell-langgraph/run`
  - returns child-run identity quickly instead of blocking parent orchestration on a long HTTP request
  - emits rich tool details used by the review UI

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

## ms-agent-workflow (Python)

Compatibility backend for Microsoft-agent style workflows.

- Port: `8081`
- Dapr app-id: `ms-agent-workflow`
- Responsibilities:
  - template-driven agent execution
  - compatibility child workflows under the same parent orchestrator contract

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

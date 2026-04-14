# Services Reference

This document describes the current `workflow-builder` runtime.

## Core Runtime

The current core runtime is:

- `workflow-builder`
- `workflow-builder-svelte`
- `workflow-orchestrator`
- `function-router`
- `dapr-agent-py`
- `openshell-agent-runtime`
- `dapr-swe`
- `fn-activepieces`
- `postgresql`

Supporting infrastructure:

- Dapr sidecars
- Redis and pub/sub components
- cluster ingress and secrets infrastructure

## workflow-builder

SvelteKit UI and BFF.

- Port: `3000`
- Responsibilities:
  - visual workflow builder
  - workflow save and publish UI
  - run launch and approval UI
  - run review UI for logs, traces, changes, patch, snapshots, and browser artifacts
  - API routes that proxy to orchestrator and internal review surfaces

## workflow-orchestrator

Python FastAPI service and Dapr workflow owner.

- Port: `8080`
- Dapr app-id: `workflow-orchestrator`
- Responsibilities:
  - execute draft workflows via `dynamic_workflow`
  - register and execute published workflow revisions
  - own parent workflow state, timers, and approvals
  - schedule child runs
  - normalize execution state into Postgres
- Important endpoints:
  - `POST /api/v2/workflows/execute-by-id`
  - `GET /api/v2/workflows/{instanceId}/status`
  - `POST /api/v2/workflows/{instanceId}/events`
  - `POST /api/v2/workflows/{instanceId}/terminate`
  - `GET /api/v2/runtime/introspect`

## function-router

TypeScript action router.

- Port: `8080`
- Dapr app-id: `function-router`
- Key endpoint:
  - `POST /execute`
- Responsibilities:
  - route built-in system and workspace actions
  - route OpenShell-backed workspace and browser actions
  - route native durable agent actions
  - route unclaimed plugin slugs to `fn-activepieces`

Current route contract:

- `workspace/*` -> `openshell-agent-runtime`
- `browser/*` -> `openshell-agent-runtime`
- `durable/run` -> `dapr-agent-py`
- `dapr-agent-py/*` -> `dapr-agent-py`
- `dapr-swe/*` -> `dapr-swe`
- `_default` -> `fn-activepieces`

The function-router image can also receive a mounted registry override from the cluster. Check the live ConfigMap when runtime routing and local code disagree.

## dapr-agent-py

Native Python Dapr agent runtime for `durable/run`.

- Dapr app-id: `dapr-agent-py`
- Responsibilities:
  - run the native durable agent child workflow
  - bind to the OpenShell workspace identified by `workspaceRef`
  - execute the agent loop with built-in workspace tools
  - connect MCP servers from `agentConfig.mcpServers`
  - dispatch MCP tools and close MCP client sessions at run completion

## openshell-agent-runtime

Canonical OpenShell runtime for workspace and browser flows.

- Port: `8080`
- Dapr app-id: `openshell-agent-runtime`
- Responsibilities:
  - `workspace/profile`
  - `workspace/clone`
  - `workspace/command`
  - `workspace/cleanup`
  - `browser/*`

Important behavior:

- uses OpenShell sandboxes as the active sandbox substrate
- owns workspace profile, clone, command, cleanup, and browser materialization
- supports retained Claude session handoff
- runs browser validation against materialized workspace state

## dapr-swe

Separate distributed coding runtime.

- Responsibilities:
  - planner/developer/reviewer style issue workflows
  - execution paths under the `dapr-swe/*` action family

## fn-activepieces

Default SaaS action backend.

- Port: `8080`
- Responsibilities:
  - execute plugin-backed SaaS actions
  - satisfy `_default` routing from `function-router`

## PostgreSQL

Primary persistence layer.

- Responsibilities:
  - workflow definitions
  - workflow executions and logs
  - workflow agent runs and events
  - published workflow revisions
  - plan artifacts
  - browser artifacts
  - workspace session metadata

## Shared Runtime Contract

Across OpenShell-backed workflow actions, the stable contract is:

1. create or resolve a workspace profile
2. clone or reconnect the repo
3. run planning or coding work in the chosen agent runtime
4. persist review artifacts
5. expose those artifacts back to the UI

That contract should stay stable even if the reasoning backend changes.

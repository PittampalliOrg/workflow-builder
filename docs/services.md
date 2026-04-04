# Services Reference

This document describes the current `workflow-builder` runtime.

## Core Runtime

The current core runtime is:

- `workflow-builder`
- `workflow-builder-svelte`
- `workflow-orchestrator`
- `function-router`
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
  - route OpenShell-backed agent and browser actions
  - route unclaimed plugin slugs to `fn-activepieces`

Current route contract:

- `workspace/*` -> `openshell-agent-runtime`
- `browser/*` -> `openshell-agent-runtime`
- `openshell/*` -> `openshell-agent-runtime`
- `dapr-swe/*` -> `dapr-swe`
- `_default` -> `fn-activepieces`

## openshell-agent-runtime

Canonical OpenShell runtime for standard agent and workspace flows.

- Port: `8080`
- Dapr app-id: `openshell-agent-runtime`
- Responsibilities:
  - `workspace/profile`
  - `workspace/clone`
  - `workspace/command`
  - `workspace/cleanup`
  - `openshell/run`
  - `openshell/session-start`
  - `browser/*`

Important behavior:

- uses OpenShell sandboxes as the active sandbox substrate
- owns standard repo-aware OpenShell runs
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
3. run planning or coding work in the chosen OpenShell runtime
4. persist review artifacts
5. expose those artifacts back to the UI

That contract should stay stable even if the reasoning backend changes.

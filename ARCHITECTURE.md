# Workflow Builder Architecture Summary

Last updated: 2026-03-30

## System Overview

Workflow Builder is a Dapr Workflow-based orchestration system with a data-driven workflow editor, OpenShell-only sandbox execution for agent work, and durable review artifacts in Postgres.

## Active Runtime

The active runtime on `ryzen` is:

- `workflow-builder`
- `workflow-orchestrator`
- `function-router`
- `openshell-agent-runtime`
- `openshell-langgraph-observable`
- `durable-agent`
- `fn-activepieces`
- `postgresql`
- `redis` and Dapr sidecars

## Execution Model

### Draft workflows

- saved in the `workflows` table
- executed through `dynamic_workflow@v1`
- interpreted at runtime from stored workflow data

### Published workflows

- created by `POST /api/workflows/:workflowId/publish`
- stored as immutable snapshots in `spec.metadata.publishedRuntime.revisions`
- registered by `workflow-orchestrator` at startup with `register_versioned_workflow`
- executed by stable Dapr workflow name and version

## Routing Model

`function-router` currently resolves:

- `workspace/*` -> `openshell-agent-runtime`
- `browser/*` -> `openshell-agent-runtime`
- `openshell/*` -> `openshell-agent-runtime`
- `openshell-langgraph-observable/*` -> `openshell-langgraph-observable`
- `_default` -> `fn-activepieces`

Retired agent families are no longer part of the supported runtime.

## OpenShell Model

All active agent sandbox work is OpenShell-backed.

That includes:

- repo-aware coding runs via `openshell/run`
- retained handoff sessions via `openshell/session-start`
- complex LangGraph coding flows via `openshell-langgraph-observable/run`
- workspace actions
- browser validation

## Durable Artifacts

Review and execution data is persisted independently of a live sandbox:

- workflow executions
- workflow execution logs
- workflow agent runs and events
- plan artifacts
- workspace sessions
- browser artifacts
- patches and file snapshots

The UI should read persisted execution artifacts, not depend on a live sandbox still being available.

## Deployment Model

There are two distinct modes:

- DevSpace inner loop for fast local iteration
- GitOps rollout through `stacks/main` for real cluster state

The authoritative deployment model is GitOps. DevSpace is a development convenience, not the deployment source of truth.

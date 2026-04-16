# Migration History

Completed migrations for reference. All migrations below are done.

Current note: this file is historical. The current `durable/run` runtime is `dapr-agent-py`; legacy `durable-agent` references below describe earlier migration steps.

## Mastra Agent → Durable Agent

Agent routing has been migrated from mastra-agent-tanstack to durable-agent:
- `agent/*` actions → durable-agent `/api/run` (was mastra-agent-tanstack)
- `mastra/execute` → durable-agent `/api/execute-plan` (was mastra-agent-tanstack)
- `durable/*` → new action type family, routes to durable-agent
- function-router registry: `mastra/*` now routes to durable-agent (was mastra-agent-tanstack)
- legacy mastra-agent service trees have been removed from the source tree, including the archived `services/mastra-agent-tanstack/` service and retired plugin shims

## Standalone fn-* Services → Consolidated

8 legacy standalone Knative services (fn-openai, fn-slack, fn-github, fn-resend, fn-stripe, fn-linear, fn-firecrawl, fn-perplexity) were removed. All function execution now routes through:
- `fn-system` for system/* actions (http-request, database-query, condition)
- `fn-activepieces` for all AP piece actions (default fallback)
- `durable-agent` for agent/mastra/durable actions

## Legacy OpenAI Plugin Removed

The `plugins/openai/` plugin (generate-text, generate-image actions) was removed since `fn-openai` service no longer exists. OpenAI actions are now served via the Activepieces `@activepieces/piece-openai` npm package through fn-activepieces.

## Planner → Mastra Agent → Durable Agent

The original planner agent (OpenAI Agents SDK, Python) was replaced by `mastra-agent-tanstack` (Mastra SDK), which was then superseded by `durable-agent` (Dapr Workflow + AI SDK 6) as the primary agent service. The planner service, its API routes, and all `planner/*` action types have been removed.

## Workflow Orchestrator TS → Python

TypeScript orchestrator was archived and deleted. Python version is the active implementation.

## Legacy Service Cleanup

Removed `activity-executor/` (empty legacy service with no source code) and `workflow-orchestrator-ts-archived/` (replaced by Python orchestrator).

## function-router Narrowed to Sync Credential Broker (2026-04-16)

Three coordinated changes narrowed function-router's scope and switched the orchestrator hop to Dapr service invoke:

- **Native `durable/run` dispatch**: re-enabled `_run_native_durable_agent_child_workflow` in `sw_workflow.py` by adding `durable/run` to `_AGENT_ACTION_TYPES`. Orchestrator now calls `ctx.call_child_workflow("agent_workflow", app_id="dapr-agent-py", ...)` directly; the `agent_workflow` name matches dapr-agent-py's `DurableAgent.register_workflow(self.agent_workflow)` (the prior `durableRunWorkflowV1` name was a placeholder nothing registered).
- **Polling shim deleted**: removed `waitForDaprAgentPyResult`, `waitForDurableRunResult`, dispatch blocks, and the `dapr-agent-py-tracker` module from `services/function-router/src/routes/execute.ts` (~548 LOC). Retry resilience across the orchestrator→agent boundary now comes from `WorkflowRetryPolicy(max_attempts=8)` on the callee side, not hand-rolled HTTP polling retry.
- **Orchestrator → function-router via Dapr invoke**: `execute_action.py` switched from `requests.post` to `DaprClient().invoke_method("function-router", "execute", ...)` via a shared `activities/dapr_invoke.py` helper, recovering mTLS, sidecar trace propagation, and native retry policy on the sync path.

Slug deletions:

- `dapr-agent-py/*` and `dapr-agent-py-testing/*` removed from the registry (ConfigMap + `BUILTIN_FALLBACK_REGISTRY`). The orchestrator had already been rejecting `dapr-agent-py/run` via `_REMOVED_AGENT_ACTION_TYPES`; the registry entries were dead fallback routes.
- `durable/run` removed from the registry (native child-workflow only).
- `_default → fn-activepieces` restored to both the ConfigMap and `BUILTIN_FALLBACK_REGISTRY` (defense-in-depth — the ConfigMap had been missing this fallback, which would have broken all AP piece routing after the cutover).

DB migration `drizzle/0031_deprecate_dapr_agent_py_slug.sql` rewrites any lingering `dapr-agent-py/*` `actionType` in `workflows.nodes` JSONB to `durable/run` (idempotent; 0 rows affected at cutover). Rollback recipe in `drizzle/0032_rollback_dapr_agent_py_slug.sql` (manual-only; not in the journal).

Result: function-router shrank from ~3017 to ~2469 LOC in `execute.ts` and became a coherent single-responsibility service. Dead manifests at `stacks/packages/components/workloads/workflow-builder/` were also removed.

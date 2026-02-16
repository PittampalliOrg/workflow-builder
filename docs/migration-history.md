# Migration History

Completed migrations for reference. All migrations below are done.

## Mastra Agent → Durable Agent

Agent routing has been migrated from mastra-agent-tanstack to durable-agent:
- `agent/*` actions → durable-agent `/api/run` (was mastra-agent-tanstack)
- `mastra/execute` → durable-agent `/api/execute-plan` (was mastra-agent-tanstack)
- `durable/*` → new action type family, routes to durable-agent
- function-router registry: `mastra/*` now routes to durable-agent (was mastra-agent-tanstack)
- mastra-agent-tanstack remains deployed for MCP endpoint and monitoring UI but is no longer the primary agent

## Standalone fn-* Services → Consolidated

8 legacy standalone Knative services (fn-openai, fn-slack, fn-github, fn-resend, fn-stripe, fn-linear, fn-firecrawl, fn-perplexity) were removed. All function execution now routes through:
- `fn-system` for system/* actions (http-request, database-query, condition)
- `fn-activepieces` for all AP piece actions (default fallback)
- `durable-agent` for agent/mastra/durable actions

## Legacy OpenAI Plugin Removed

The `plugins/openai/` plugin (generate-text, generate-image actions) was removed since `fn-openai` service no longer exists. OpenAI actions are now served via the Activepieces `@activepieces/piece-openai` npm package through fn-activepieces.

## Planner → Mastra Agent → Durable Agent

`planner-dapr-agent` (OpenAI Agents SDK, Python) was replaced by `mastra-agent-tanstack` (Mastra SDK), which was then superseded by `durable-agent` (Dapr Workflow + AI SDK 6) as the primary agent service. The planner service, its API routes, and all `planner/*` action types have been removed.

## Workflow Orchestrator TS → Python

TypeScript orchestrator was archived and deleted. Python version is the active implementation.

## Legacy Service Cleanup

Removed `activity-executor/` (empty legacy service with no source code) and `workflow-orchestrator-ts-archived/` (replaced by Python orchestrator).

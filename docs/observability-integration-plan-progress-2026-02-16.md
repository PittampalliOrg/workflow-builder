# Observability Integration Plan and Progress

Date: February 16, 2026
Project: workflow-builder (`/home/vpittamp/repos/PittampalliOrg/workflow-builder/main`)

## Scope and Intent
This document captures the approved observability-first incremental plan, current implementation progress, and remaining tasks for bringing Mastra-style observability/workflow run UX into workflow-builder and wiring it to Dapr workflow APIs, database execution records, and OpenTelemetry/Jaeger traces.

## Approved Plan Baseline
1. Build observability data foundation in workflow-builder.
1. Add observability APIs and type-safe client methods.
1. Add observability pages and navigation (`/observability`, `/observability/[traceId]`).
1. Add workflow run pages (`/workflows/[workflowId]/runs`, `/workflows/[workflowId]/runs/[executionId]`).
1. Correlate traces with Dapr workflow executions using DB + span attributes.
1. Keep unmatched traces hidden by default.
1. Follow existing workflow-builder styling patterns (not 1:1 Mastra component copy).
1. Validate with `pnpm type-check` and `pnpm fix`.

## Decisions Locked During Planning
- Delivery mode: observability-first incremental.
- OTel source: Jaeger query API.
- Routing: add new routes (do not replace existing monitor routes).
- Visibility/scope: project-wide scope (with legacy user fallback where needed).
- Unmatched traces: hidden.
- UI direction: native workflow-builder styling with Mastra-inspired interaction patterns.

## Progress Status

### Completed
1. Added Jaeger configuration support in config service.
1. Added observability domain types and Jaeger normalization/correlation modules:
   - `lib/types/observability.ts`
   - `lib/observability/jaeger-types.ts`
   - `lib/observability/jaeger-client.ts`
   - `lib/observability/normalization.ts`
   - `lib/observability/correlation.ts`
1. Added observability APIs:
   - `app/api/observability/entities/route.ts`
   - `app/api/observability/traces/route.ts`
   - `app/api/observability/traces/[traceId]/route.ts`
1. Added API client observability methods:
   - `api.observability.getEntities`
   - `api.observability.getTraces`
   - `api.observability.getTrace`
1. Added observability hooks:
   - `hooks/use-observability-entities.ts`
   - `hooks/use-observability-trace.ts`
   - `hooks/use-observability-traces.ts`
1. Added observability pages and base components:
   - `/observability`
   - `/observability/[traceId]`
   - Filters, table, status badge, spans table components.
1. Added workflow runs pages and supporting components:
   - `/workflows/[workflowId]/runs`
   - `/workflows/[workflowId]/runs/[executionId]`
   - execution status/log components.
1. Added navigation wiring:
   - Sidebar link to `/observability`.
   - Link from in-canvas runs UI to dedicated runs page.
1. Added richer Mastra-style span drill-down interactions on `/observability/[traceId]`:
   - Hierarchical timeline with expand/collapse.
   - Search and error-only filtering.
   - Per-span detail panel with details/attributes/raw tabs.
   - Quick links to monitor/workflow-run pages from selected span context.
1. Validation completed:
   - `pnpm type-check` passed.
   - `pnpm fix` passed.

### Commits
- `f8401d75` — bulk local workspace integration commit.
- `b454fb57` — observability timeline and span drill-down enhancements.

## Remaining Tasks

### Functional Verification
1. Run structured manual E2E verification in devspace/UI MCP against:
   - `/observability`
   - `/observability/[traceId]`
   - `/workflows/[workflowId]/runs`
   - `/workflows/[workflowId]/runs/[executionId]`
1. Validate trace-to-execution correlation accuracy against real datasets for these cases:
   - `workflow.db_execution_id` match
   - `workflow.instance_id` match
   - `workflow.id` fallback match
1. Validate pagination behavior under larger trace volumes.

### Environment and Operations
1. Confirm `JAEGER_QUERY_URL` / `jaeger-query-url` is correctly set in each active environment.
1. Confirm Jaeger service name filtering strategy (if needed) for production traffic segmentation.
1. Confirm expected behavior when Jaeger is unavailable (error messaging and fallback UX).

### Test Coverage (Not Yet Added)
1. Add unit tests for:
   - `lib/observability/correlation.ts`
   - `lib/observability/normalization.ts`
1. Add API route tests for:
   - `/api/observability/entities`
   - `/api/observability/traces`
   - `/api/observability/traces/[traceId]`

### Optional Parity Enhancements
1. URL deep-link state for selected span/tab in trace detail page.
1. Keyboard next/previous span navigation.
1. Timeline zoom and richer legend controls (if needed).

## Current Overall Status
- Core planned implementation is complete.
- Remaining work is verification, hardening, and optional UX parity improvements.

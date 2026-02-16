# Observability Integration Plan and Progress

Date: February 16, 2026
Project: workflow-builder (`/home/vpittamp/repos/PittampalliOrg/workflow-builder/main`)

## Scope and Intent
This document captures the observability-first incremental plan, current implementation status, and the external/environment-dependent items needed to fully validate production behavior.

## Approved Plan Baseline
1. Build observability data foundation in workflow-builder.
1. Add observability APIs and type-safe client methods.
1. Add observability pages and navigation (`/observability`, `/observability/[traceId]`).
1. Add workflow run pages (`/workflows/[workflowId]/runs`, `/workflows/[workflowId]/runs/[executionId]`).
1. Correlate traces with Dapr workflow executions using DB + span attributes.
1. Keep unmatched traces hidden by default.
1. Follow existing workflow-builder styling patterns.
1. Validate with `pnpm type-check` and `pnpm fix`.

## Decisions Locked During Planning
- Delivery mode: observability-first incremental.
- OTel source: Jaeger query API.
- Routing: add new routes (do not replace existing monitor routes).
- Visibility/scope: project-wide scope (with legacy user fallback where needed).
- Unmatched traces: hidden.
- UI direction: native workflow-builder styling.
- Test strategy: root Vitest for observability unit + API route tests.

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
1. Added observability pages and components:
   - `/observability`
   - `/observability/[traceId]`
   - trace filters/table/status badge/spans table
1. Added workflow runs pages and supporting components:
   - `/workflows/[workflowId]/runs`
   - `/workflows/[workflowId]/runs/[executionId]`
1. Added navigation wiring:
   - Sidebar link to `/observability`
   - Link from in-canvas runs UI to dedicated runs page
1. Added observability automated tests and root test harness:
   - `vitest.config.ts`
   - `tests/setup.ts`
   - `lib/observability/normalization.test.ts`
   - `lib/observability/correlation.test.ts`
   - `app/api/observability/entities/route.test.ts`
   - `app/api/observability/traces/route.test.ts`
   - `app/api/observability/traces/[traceId]/route.test.ts`
1. Added executable Jaeger environment check script:
   - `scripts/check-observability-env.ts`
1. Validation results for this implementation pass:
   - `pnpm test:unit` passed (5 files, 26 tests)
   - `pnpm type-check` passed
   - `pnpm fix` passed
   - `pnpm tsx scripts/check-observability-env.ts` executed; Jaeger URL resolved but reachability failed in local environment (`fetch failed`)

### Commits
- `f8401d75` — bulk local workspace integration commit.
- `b454fb57` — observability detail enhancements.

## Remaining External Validation

### Functional Verification in Live Environment
1. Run manual authenticated UI verification in devspace against:
   - `/observability`
   - `/observability/[traceId]`
   - `/workflows/[workflowId]/runs`
   - `/workflows/[workflowId]/runs/[executionId]`
1. Validate trace-to-execution correlation with real telemetry data for:
   - `workflow.db_execution_id` match
   - `workflow.instance_id` match
   - `workflow.id` fallback match
1. Validate pagination behavior with high-volume real traces.

### Environment and Operations
1. Run:
   - `pnpm tsx scripts/check-observability-env.ts`
1. Confirm expected values exist in each deployment:
   - Dapr config key `jaeger-query-url`
   - env fallback `JAEGER_QUERY_URL`
   - optional segmentation key `JAEGER_QUERY_SERVICE`
1. Confirm outage behavior by temporarily pointing Jaeger URL to an invalid host and verifying:
   - API returns 500 with observability-specific error payload
   - `/observability` UI shows non-crashing error banners

## Current Overall Status
- Core observability implementation and automated hardening work are complete.
- Remaining tasks are live-environment verification tasks that require running infrastructure and real telemetry datasets.

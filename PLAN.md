# Improve Workflow Builder MLflow Tracing

## Summary
Improve the existing MLflow trace finalization path so traces are not only terminal (`OK` / `ERROR`), but also searchable, duration-accurate, and easier to read for async coding workflows. Keep the current OTLP-root-span finalizer model; do not use MLflow trace-state REST APIs or direct SQL.

## Key Changes
- Harden `finalize_mlflow_trace_root` to set trace-level MLflow tags after emitting the synthetic root span.
  - Tags: `mlflow.traceName`, `workflow.id`, `workflow.name`, `workflow.execution.id`, `workflow.status`, `dapr.workflow.instance_id`, `dapr.workflow.name`, `session.id`.
  - Use `MlflowClient().set_trace_tag("tr-<trace_id>", ...)` with a longer bounded retry window because trace row creation can lag OTLP export.
  - Keep failures best-effort and non-fatal; return tag results in the activity payload for logging/debugging.

- Make the synthetic root span duration-accurate.
  - Use `durationMs` already passed into the finalizer to backdate `start_time_unix_nano`; use activity wall-clock time as end.
  - Preserve deterministic span ID from `trace_id + workflow instance id`.
  - Add root attributes `workflow.duration_ms`, `workflow.status`, and `error.message` when present.

- Add curated workflow-node spans without changing workflow scheduling order.
  - Extend existing node logging completion activity behavior rather than adding a new per-node durable activity.
  - For directly logged nodes, emit a synthetic OTLP child span under the deterministic workflow root span.
  - Span attributes: `workflow.node.id`, `workflow.node.name`, `workflow.node.type`, `workflow.action.type`, `workflow.node.status`, `workflow.node.duration_ms`, `workflow.execution.id`, and `error.message`.
  - Use deterministic node span IDs from `trace_id + execution_id + node_id + task sequence`; add a small `taskSequence` field in orchestrator inputs to disambiguate repeated nodes.

- Tighten agent-side trace tagging.
  - Add an explicit trace-id fallback in `services/dapr-agent-py` MLflow tag promotion using the current OTel context or `WORKFLOW_BUILDER_TRACEPARENT`.
  - Keep existing MLflow Anthropic/LiteLLM autologging and prompt-cache/token attributes; do not re-enable MLflow span metrics by default.

## Interfaces
- No public API or database schema changes.
- New optional env knobs:
  - `WORKFLOW_ORCHESTRATOR_MLFLOW_TRACE_TAG_RETRY_SECONDS=15`
  - `WORKFLOW_ORCHESTRATOR_MLFLOW_NODE_SPANS=true`
- Existing gates remain:
  - `WORKFLOW_ORCHESTRATOR_MLFLOW_FINALIZE_ROOT_SPAN=true`
  - `WORKFLOW_ORCHESTRATOR_MLFLOW_EXPORT_SPAN_METRICS=false` by default

## Test Plan
- Unit tests for root finalizer:
  - Root span uses empty parent span ID, deterministic span ID, correct `OK` / `ERROR` status, expected tags, and duration based on `durationMs`.
  - Missing endpoint, missing trace ID, invalid trace ID, HTTP failure, and tag-setting failure all return best-effort results without raising.
  - Tag retry handles transient trace-row/foreign-key errors.

- Unit tests for node spans:
  - `log_node_complete` emits one child span when enabled and `_otel.traceId` exists.
  - Node span parent ID equals deterministic workflow root span ID.
  - Span ID is deterministic for the same execution/node/sequence.
  - Env gate disables node span emission cleanly.

- Workflow tests:
  - Success path still schedules finalizer after result persistence and cleanup.
  - Failure and parse-failure paths still schedule `ERROR` finalization.
  - Added metadata fields do not change activity ordering in replay-sensitive paths.

- Dev-cluster smoke:
  - Run one async coding workflow success and one forced failure.
  - Confirm MLflow `get_trace("tr-<trace_id>")` has state `OK` / `ERROR`.
  - Confirm `search_traces` can find the trace by `workflow.execution.id` and `mlflow.traceName`.
  - Confirm one root span has no parent, node spans appear under it, and no `span_type` encoding or `StartTraceV3` errors appear.

## Assumptions
- There is no dedicated `mlflow` skill available in this session; this plan is based on the workflow-builder skill plus direct repo inspection.
- MLflow accepts tag writes via `MlflowClient().set_trace_tag` once the OTLP-created trace row exists.
- Node spans should be added through existing activity boundaries to avoid introducing new durable workflow scheduling steps.
- Keep the current dev system as the validation baseline and avoid broad UI/schema changes.

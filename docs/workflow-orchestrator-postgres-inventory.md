# Workflow Orchestrator Postgres Inventory

This inventory tracks direct Postgres access that remains while orchestration
persistence moves behind the workflow-data application ports. The intended
runtime boundary is Dapr service invocation to `workflow-builder` internal
workflow-data routes. Postgres remains the first workflow-data infrastructure
adapter, not an orchestrator dependency.

Inventory status: 2026-07-02, after the workflow start/control slice.

## Strict HTTP Runtime Paths

With `WORKFLOW_DATA_API_MODE=http`, these paths route persistence through
`activities/workflow_data_client.py` and must not call `_get_database_url` or
`psycopg2.connect`:

- `app.py` start/control helpers:
  - `_assert_execution_read_model_columns`: read-model readiness check.
  - `_fetch_workflow_from_db`: workflow lookup by id.
  - `_create_workflow_execution`: execution row creation.
  - `_mark_workflow_execution_started`: Dapr instance / trace correlation.
  - `_existing_live_execution_instance`: duplicate-start guard.
  - `_db_execution_status_for_instance`: idempotent scheduler zombie guard.
  - `_mark_workflow_execution_failed_to_start`: failed-start status update.
  - `_list_stale_running_execution_rows` / `_cleanup_stale_instances_on_startup`:
    stale startup cleanup lookup and status update.
- `fetch_child_workflow.py`: workflow lookup by id/name.
- `log_node_execution.py`: node start/complete logs and current-node read model.
- `persist_artifact.py`: workflow artifact upsert.
- `persist_plan_artifact.py`: plan artifact create/update/fetch.
- `persist_results_to_db.py`: final execution read-model/output update.
- `persist_workspace_session.py`: retained workspace-session upsert.
- `publish_event.py`: phase/progress read-model update after Dapr pub/sub publish.
- `register_resumable_workspace.py`: resumable workspace-session upsert.
- `resolve_mcp_config.py`: MCP config resolution.
- `track_agent_run.py`: agent run scheduled/running/completed/failed lifecycle.
- `finalize_otel_trace_root.py`: OTel trace target lookup and lineage upsert.

Strict mode behavior is intentionally not identical for every helper:
readiness, workflow lookup, creation, duplicate-start checks, scheduler attach,
and failed-start updates fail the operation when workflow-data is unavailable.
`_db_execution_status_for_instance` remains best-effort: on workflow-data
failure it returns `None` and does not fall back to DB, matching the preexisting
"do not kill a live run without evidence" zombie-guard posture.

## Documented Rollback Paths

The same migrated activities and `app.py` helpers may still contain direct SQL
branches for `WORKFLOW_DATA_API_MODE=postgres` and
`WORKFLOW_DATA_API_MODE=http-fallback-db`. Those branches are rollback-only.
They should import `psycopg2` lazily inside the Postgres branch where practical
so import-time coupling does not affect strict HTTP mode.
`resolve_mcp_config.py` intentionally keeps a top-level import today because its
fallback tests patch that module object directly.

`app.py` still contains `_get_database_url` and lazy `psycopg2` imports in the
fallback bodies for:

- `_assert_execution_read_model_columns`
- `_fetch_workflow_from_db`
- `_create_workflow_execution`
- `_mark_workflow_execution_started`
- `_existing_live_execution_instance`
- `_db_execution_status_for_instance`
- `_mark_workflow_execution_failed_to_start`
- `_list_stale_running_execution_rows`

`persist_results_to_db.py` also has a legacy MLflow browser-artifact projection
that reads browser artifact rows only when
`WORKFLOW_ORCHESTRATOR_LEGACY_MLFLOW_ENABLED` and `MLFLOW_TRACKING_URI` are set.
Active trace lineage should use OTel fields and workflow-data trace lineage
ports instead.

## BFF / Control-Plane Runtime Seams

The TypeScript workflow-data internal API surface for migrated domains now uses
application services; `rg` shows the new
`src/routes/api/internal/workflow-data/**` routes do not import
`$lib/server/db`. Direct DB imports for those domains are confined to
`src/lib/server/application/adapters/postgres.ts`.

The broader BFF/control-plane still has route-level or service-level
`$lib/server/db` imports and remains the next migration area. Current categories
include:

- workflow execution/start/status routes, including execute/webhook/resume,
  run detail, logs, artifacts, plans, lineage, metrics, sessions, and approvals.
- Lifecycle Controller internals under `src/lib/server/lifecycle/**`.
- session/runtime/workspace helpers under `src/lib/server/sessions/**`,
  `src/lib/server/openshell-sessions.ts`, `src/lib/server/sandbox-sessions.ts`,
  and related API routes.
- MCP/auth/connection resolution and decrypt routes.
- benchmark/evaluation/admin/reporting surfaces.
- startup/migration/bootstrap and UI page loaders.

Those BFF paths are not strict-orchestrator runtime fallbacks; they are product
runtime seams to migrate behind application ports in later checkpoints. Raw DB
access remains acceptable inside adapters, migrations/bootstrap utilities,
explicit rollback branches, and tests.

## Test-Only References

The orchestrator test suite stubs or monkeypatches `psycopg2` to prove strict
HTTP mode does not fall back and to retain rollback-path coverage. Those imports
are test-only and should not be counted as production runtime coupling.

## Invariants

- The orchestrator must not issue raw Dapr PostgreSQL binding SQL for product
  tables; workflow-data application ports own persistence decisions.
- Strict `WORKFLOW_DATA_API_MODE=http` must fail or return the existing
  best-effort error result without falling back to Postgres.
- The centralized `workflowstatestore` remains the only visible Dapr actor state
  store for durable workflows. Do not introduce per-agent or per-session actor
  state stores as part of this migration.

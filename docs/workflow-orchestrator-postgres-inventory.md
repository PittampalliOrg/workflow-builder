# Workflow Orchestrator Postgres Inventory

This inventory tracks direct Postgres access that remains in
`services/workflow-orchestrator` while orchestration persistence moves behind the
workflow-data application ports. The intended runtime boundary is Dapr service
invocation to `workflow-builder` internal workflow-data routes. Postgres remains
the first workflow-data infrastructure adapter, not an orchestrator dependency.

## Strict HTTP Runtime Paths

With `WORKFLOW_DATA_API_MODE=http`, these activities route persistence through
`activities/workflow_data_client.py` and must not call `_get_database_url` or
`psycopg2.connect`:

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

## Documented Rollback Paths

The same migrated activities may still contain direct SQL branches for
`WORKFLOW_DATA_API_MODE=postgres` and `WORKFLOW_DATA_API_MODE=http-fallback-db`.
Those branches are rollback-only. They should import `psycopg2` lazily inside the
Postgres branch where practical so import-time coupling does not affect strict
HTTP mode. `resolve_mcp_config.py` intentionally keeps a top-level import today
because its fallback tests patch that module object directly.

`persist_results_to_db.py` also has a legacy MLflow browser-artifact projection
that reads browser artifact rows only when
`WORKFLOW_ORCHESTRATOR_LEGACY_MLFLOW_ENABLED` and `MLFLOW_TRACKING_URI` are set.
Active trace lineage should use OTel fields and workflow-data trace lineage
ports instead.

## Legacy App Helpers

`services/workflow-orchestrator/app.py` still owns legacy execute-by-id/startup
helpers that fetch `DATABASE_URL` and write workflow execution rows directly:

- `_assert_execution_read_model_columns`
- `_fetch_workflow_from_db`
- `_create_workflow_execution`
- `_mark_workflow_execution_started`
- `_existing_live_execution_instance`
- `_db_execution_status_for_instance`
- `_mark_workflow_execution_failed_to_start`
- `_cleanup_stale_instances_on_startup`

These helpers are outside the current bounded slice and are the remaining
allowed direct DB references after runtime activity persistence is migrated.

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

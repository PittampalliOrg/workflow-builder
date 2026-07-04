# Workflow Orchestrator Postgres Inventory

This inventory tracks direct Postgres access that remains while orchestration
persistence moves behind the workflow-data application ports. The intended
runtime boundary is Dapr service invocation to `workflow-builder` internal
workflow-data routes. Postgres remains the first workflow-data infrastructure
adapter, not an orchestrator dependency.

Inventory status: 2026-07-03, after the workflow start/control slice and the
workspace workflow, service graph, connections, benchmark, top-level
connections redirect, settings OAuth/profile, settings members, admin pieces,
root UI-facing route, MCP connection, and app-connection CRUD/OAuth/decrypt
route slices, the project members API route family, and the usage/cost/live
limits reporting route family, plus sandbox executions/stats, catalog
pieces/functions, workflow execution read/status APIs, internal
run-diff/source-bundle artifact ingest APIs, and internal session-ingest utility
routes, the external events ingest route, the agent-trigger membership check,
the CLI credential capture session-owner lookup, and the ActivePieces resume
execution lookup, plus the GitHub trigger ingress and event-trigger admission
gate, and the internal piece-execution artifact readback route, plus the
workflow trigger management/lifecycle, workflow definition command,
code-checkpoint list/diff/restore, admin GitOps auth-check, and session-goal
storage wiring slices, plus dev-preview database provisioning.
The session spawn/control runtime-target helper now resolves session owner user
ids, workflow execution workspace keys, and session runtime targets through
workflow-data ports. Direct `sessions`/`workflow_executions` reads for those
paths are confined to Postgres application adapters; `spawn.ts`, `control.ts`,
and `runtime-target.ts` no longer import DB or Drizzle for these lookups.
Session workflow spawn now also loads the session row and attaches Dapr runtime
metadata through workflow-data; the legacy `sessions/registry` `getSession` and
`attachRuntime` calls are no longer imported by `spawn.ts`.
Session workflow spawn now also resolves the session's primary agent and
callable peer-agent dispatch metadata through workflow-data application ports;
`spawn.ts` no longer imports the legacy agent registry or registry-sync helpers
for those runtime-start inputs.
Session workflow spawn now also reads initial user events and emits swap-safety
audit events through workflow-data; `spawn.ts` no longer imports the legacy
session event-log helper directly.
Session event-log persistence now lives in
`src/lib/server/application/adapters/session-events.ts` behind the
`SessionEventLog` port. `src/lib/server/sessions/events.ts` is a pure
compatibility export for envelope shaping/sanitization and no longer imports
DB, Drizzle, or schema types.
Interactive-CLI repository mounting during session spawn now delegates through
the session command repository-mounter port; `spawn.ts` no longer imports the
repository-mounter adapter directly. The DB-backed repository mounting helper
now lives under `src/lib/server/application/adapters/session-repositories.ts`.
The session runtime-config helper now takes its persisted
`session.runtime_config` fallback as an injected adapter dependency. The latest
runtime-config event query is confined to `DefaultSessionRuntimeConfigReader`;
`runtime-config.ts` no longer imports DB, schema, or Drizzle.
Lifecycle coordinator ownership checks now use
`PostgresLifecycleCoordinatorOwnerStore`, injected behind workflow-execution and
session lifecycle ports. The user-facing stop/resume/detail services still
preserve `coordinator_owned` behavior, while direct benchmark/eval/session SQL
is confined to the application adapter layer rather than
`src/lib/server/lifecycle`.
Lifecycle cascade side effects now use the Dapr/Postgres adapter in
`src/lib/server/application/adapters/lifecycle-cascade.ts`. The core cascade
engine in `src/lib/server/lifecycle/cascade.ts` remains the pure termination
algorithm with injected `DurableCascadeDeps`; raw `wfstate_state` /
`agent_py_state` state-row deletion is confined to the adapter.
Lifecycle target resolution now uses the Postgres adapter in
`src/lib/server/application/adapters/lifecycle-resolver.ts`. The lifecycle
resolver contract in `src/lib/server/lifecycle/resolvers.ts` owns only DTOs and
deterministic helper logic such as per-session app-id and child-node extraction;
Drizzle row reads, stop-intent writes, and terminal DB finalizers are confined
to the adapter.
The main application `SessionRepository` implementation now owns session
list/get/create and workspace-sandbox update queries directly in
`src/lib/server/application/adapters/sessions.ts`, so workflow-data/session
commands no longer import the legacy DB-backed `src/lib/server/sessions/registry.ts`
shim; that unused shim has been removed. OpenShell session compatibility now routes through
`src/lib/server/application/adapters/openshell-sessions.ts`, leaving
`src/lib/server/openshell-sessions.ts` as a route-facing facade with no direct DB
or registry-shim import.
Goal-loop driver persistence now uses the application `GoalLoopStore` port with
`PostgresGoalLoopStore` as the first adapter. The event-driven loop preserves
the existing exactly-once continuation, budget, and completion behavior, but no
longer imports `src/lib/server/goals/repo.ts`, `$lib/server/db`, Drizzle, or
Drizzle schema types from `src/lib/server/goals/goal-loop.ts`.
Session agent config patch commands now reuse the scoped session already loaded
by workflow-data, with a workflow-data fallback for standalone helper use;
`agent-config-patch.ts` no longer imports the legacy session registry.
The workflow interactive dev-session handoff now resolves execution owner and
project context through workflow-data execution ports instead of querying
`workflow_executions`/`workflows` directly; `dev-session-handoff.ts` no longer
imports DB, schema, Drizzle, the legacy agent registry, or legacy session
registry/event helpers. It delegates the bound session create plus initial
message append to workflow-data.
The capacity active-work fleet activity summary now lives in
`SessionFleetActivityAdapter`; `src/lib/server/sessions/fleet-activity.ts` was
deleted, and the bounded `sessions`/`session_events` reads are confined to the
application adapter layer.
The capacity overview API route now delegates observer loading, ownership
enrichment, and business-work summary construction to
`ApplicationCapacityOverviewService`; route-local imports of capacity
helper modules were removed.
Capacity business-work detail loading and owner resolution now run through
`PostgresCapacityBusinessWorkRepository` and
`PostgresCapacityOwnershipRepository` in the application adapter layer.
`src/lib/server/capacity/business-work.ts` and
`src/lib/server/capacity/ownership.ts` are pure aggregation/linking modules
with injected repositories and no DB, Drizzle, or schema imports.
CLI credential persistence now lives behind `ApplicationCliCredentialsService`
with `PostgresUserCliCredentialStore` and `RawPostgresHostCliCredentialStore`
adapters. The user CLI-token API, internal runtime capture route, workflow
session secret-env resolver, and session spawn helper no longer import the old
DB-owning `users/cli-credentials` or preview host-store modules directly.
The internal CLI workspace command route now routes execution lookup,
CLI-session candidate lookup, file creation, and browser artifact persistence
through workflow-data.
The internal session-events read route now uses `workflowData.listSessionEvents`
instead of importing the DB-backed `sessions/events` helper directly.
The observability goal-flow read model now asks workflow-data for session goal
flows instead of importing the legacy goal repository directly; `goal-flow.ts`
keeps only the pure attempt assembly helper.
The prompt preset, agent skill, and vault "used by/usages" reverse-lookup
routes now load their read models through workflow-data resource usage ports.
The AI assistant message-history route now lists and deletes persisted chat
messages through workflow-data.
The AI assistant build-workflow stream now loads and saves workflow definitions
through existing workflow-data workflow definition ports.
The security audit API now loads its aggregated audit stream through a
workflow-data read model.
The dashboard API now loads its summary, active-session list, recent changes,
and resource counts through a workflow-data dashboard read model.
The project workflow-run list route (`src/routes/api/v1/runs/+server.ts`) now
loads cross-workflow run summaries through `workflowData.listProjectWorkflowRuns`.
The former direct DB helper `src/lib/server/workflows/runs.ts` was removed; its
query now lives in `PostgresWorkflowExecutionRepository` behind the
workflow-data application port.
The dev-preview lifecycle now persists retained workspace rows, resolves
canonical execution ids, marks cleaned previews, and writes source-bundle
artifacts through workflow-data application ports; `dev-preview.ts` no longer
imports DB, Drizzle, workflow artifact, or file-registry modules directly.
Functional preview database create/drop now flows through
`PreviewDatabaseProvisioner`; the first adapter is
`PostgresPreviewDatabaseProvisioner`.
The CLI preview helper now resolves session runtime targets, execution rows, and
interactive-CLI detection through workflow-data ports; direct DB/Drizzle imports
are confined to the Postgres session adapter for that preview lookup.
The dev-mode shell and CLI-terminal WebSocket proxies now resolve session
runtime targets through workflow-data before opening Kubernetes/pod WebSocket
transport; they no longer import the legacy DB-backed runtime-target helper.
The old `src/lib/server/sessions/scope.ts` direct DB guard had no production
callers after the session route migrations and has been deleted.
The obsolete workflow-ops/admin-instances diagnostic surface, the legacy
`/api/monitor` proxy, the unused `/api/orchestrator/workflows` proxy, and the
orphan workflow-ops reminder recovery hook in the Python orchestrator have been
retired instead of migrated; active workflow stop/inspection flows use the
lifecycle controller and workflow execution read-model routes.
The benchmark instance-detail API now loads SWE-bench instance details through
a workflow-data read model, and its contamination-risk audit authorization check
uses workflow-data user/project ports instead of the route utility reading
`users`/`project_members` directly.
The benchmark run-instance scores API now scope-checks the run and instance and
loads scorer rows through a workflow-data read model. The benchmark run-instance
spans API no longer imports the DB for a route-local readiness check; the deeper
trace-bundle service remains a later telemetry/MLflow adapter slice.
The benchmark run-instance detail API now scope-checks the run, loads the
selected run instance, benchmark metadata, and execution payloads through a
workflow-data read model, while keeping response shaping, gold-patch redaction,
host-job extraction, and MLflow URL formatting route-local.
The benchmark run-instance annotations API now reads aggregate annotation
counts, validates/upserts the caller verdict, and deletes the caller annotation
through workflow-data ports. The Postgres adapter preserves the existing
`(run_instance_id, user_id)` upsert target and scoped run-instance lookup.
The benchmark-to-evaluation dataset promotion API now validates the selected
run instance, enforces workspace scope, checks the target evaluation dataset,
and inserts the origin-linked dataset row through a workflow-data command port
instead of route-local Drizzle queries.
The internal benchmark run-instance progress API now reads instance status and
latest session activity through a workflow-data read model; the route no longer
imports `benchmark_run_instances`, `session_events`, or Drizzle.
The internal benchmark run status and capacity-gate APIs now resolve the run's
project scope through workflow-data before delegating to benchmark services,
removing route-local `benchmark_runs`/Drizzle imports.
The internal benchmark artifact upload/read/delete route now uses the
application-owned `BenchmarkArtifactKind` DTO, and benchmark artifact metadata
recording is routed through a workflow-data port. Blob/local object storage
remains in the benchmark artifact storage adapter, while the Postgres lookup of
the source run-instance id and `benchmark_artifacts` insert are confined to the
Postgres workflow-data adapter.
The agent-runtime list/detail/wake/sleep routes and the internal idle-reaper
route now use an application service with explicit Postgres and Kubernetes
ports. Project-scoped agent lookup, admin role checks, active-session lookup,
warm-pool phase derivation, and idle-reap decisions are no longer implemented
inside SvelteKit route handlers. Postgres access is confined to
`PostgresAgentRuntimeRepository`, and SandboxWarmPool access is confined to
`KubernetesAgentRuntimeWarmPoolClient`.
The internal benchmark evaluation-results callback now delegates callback
ingestion to workflow-data application ports. Run lookup, batch instance-result
updates, active-row counting, lifecycle transitions, MLflow/trace sync
scheduling, and coordinator notifications are no longer owned by the route.
The optimized `jsonb_to_recordset` update remains intact inside
`PostgresBenchmarkEvaluationResultRepository`.
The internal benchmark run launch route no longer performs route-local agent
slug lookup through Drizzle. `createBenchmarkRun` accepts `agentSlug` as an
alternate selector and resolves it through the existing benchmark-agent
validation path, preserving archived/published/runtime/model checks inside the
benchmark command service.
The internal benchmark run-instance start route and the public/internal
run-instance terminate route now delegate to
`ApplicationBenchmarkInstanceLifecycleService`. The underlying Dapr workflow
start, Kueue capacity behavior, sandbox cleanup, resource lease release, and
durable termination confirmation remain in the documented legacy benchmark
lifecycle adapter pending the deeper benchmark service extraction.
SWE-bench exact-ready environment validation now runs through
`ApplicationBenchmarkEnvironmentValidationService`. Suite/instance/build-status
queries are confined to `PostgresSwebenchEnvironmentValidationRepository`, and
build submission/sync side effects are behind
`LegacySwebenchEnvironmentBuildProvisioner`. The public/internal validation
routes and internal benchmark run launch route no longer import the
DB-backed environment validation helper directly.

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
- `fetch_child_workflow.py`: workflow lookup by id/name. This activity is
  workflow-data only; its direct Postgres fallback was removed.
- `log_node_execution.py`: node start/complete logs and current-node read
  model. This activity is workflow-data only; its direct Postgres fallback was
  removed.
- `persist_artifact.py`: workflow artifact upsert.
- `persist_plan_artifact.py`: plan artifact create/update/fetch. This activity
  is workflow-data only; its direct Postgres fallback was removed.
- `persist_results_to_db.py`: final execution read-model/output update. This
  activity is workflow-data only; its direct Postgres fallback was removed.
- `persist_workspace_session.py`: retained workspace-session upsert. This
  activity is workflow-data only; its direct Postgres fallback was removed.
- `publish_event.py`: phase/progress read-model update after Dapr pub/sub
  publish. This activity is workflow-data only; its direct Postgres fallback
  was removed.
- `register_resumable_workspace.py`: resumable workspace-session upsert. This
  activity is workflow-data only; its direct Postgres fallback was removed.
- `resolve_mcp_config.py`: MCP config resolution. This activity is
  workflow-data only; its direct Postgres fallback was removed.
- `track_agent_run.py`: agent run scheduled/running/completed/failed lifecycle.
  This activity is workflow-data only; its direct Postgres fallback was removed.
- `finalize_otel_trace_root.py`: OTel trace target lookup and lineage upsert.
  This activity is workflow-data only; its direct Postgres fallback was removed.

Strict mode behavior is intentionally not identical for every helper:
readiness, workflow lookup, creation, duplicate-start checks, scheduler attach,
and failed-start updates fail the operation when workflow-data is unavailable.
`_db_execution_status_for_instance` remains best-effort: on workflow-data
failure it returns `None` and does not fall back to DB, matching the preexisting
"do not kill a live run without evidence" zombie-guard posture.

## Documented Rollback Paths

Some migrated activities and `app.py` helpers may still contain direct SQL
branches for `WORKFLOW_DATA_API_MODE=postgres` and
`WORKFLOW_DATA_API_MODE=http-fallback-db`. Those branches are rollback-only.
They should import `psycopg2` lazily inside the Postgres branch where practical
so import-time coupling does not affect strict HTTP mode.
`fetch_child_workflow.py`, `track_agent_run.py`, `log_node_execution.py`,
`persist_plan_artifact.py`, `persist_results_to_db.py`,
`persist_workspace_session.py`, `publish_event.py`,
`register_resumable_workspace.py`, `resolve_mcp_config.py`, and
`finalize_otel_trace_root.py` no longer have direct Postgres rollback branches
for their runtime persistence paths; their workflow-data endpoints are the only
persistence path.

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

The legacy `persist_results_to_db.py` MLflow browser-artifact projection was
removed. Final-result persistence and trace lineage use workflow-data and OTel
lineage ports instead.

## BFF / Control-Plane Runtime Seams

The TypeScript workflow-data internal API surface for migrated domains now uses
application services; `rg` shows the new
`src/routes/api/internal/workflow-data/**` routes do not import
`$lib/server/db`. Direct DB imports for those domains are confined to
`src/lib/server/application/adapters/postgres.ts`.

UI-facing workflow execution routes continue to move behind application
services:

- `src/routes/api/workflows/executions/[executionId]/artifacts/+server.ts`
  now delegates scoped parent execution lookup, artifact list loading, and
  lookup-failure status mapping to
  `ApplicationWorkflowExecutionArtifactsService`; the route imports no
  workflow-data, Drizzle schema, or `$lib/server/db`.
  `src/routes/api/workflows/executions/[executionId]/artifacts/artifacts-route.test.ts`
  locks both the response behavior and the no-direct-db boundary.
- `src/routes/api/workflows/executions/[executionId]/plan-artifacts/+server.ts`
  now lists, creates, and updates plan artifacts through
  `ApplicationWorkflowPlanService`, which scopes the parent execution before
  touching artifact rows and owns plan-artifact validation/status policy. The
  workflow-data port supplies the execution/artifact reads and writes, with the
  Postgres query confined to
  `src/lib/server/application/adapters/postgres.ts`. The route keeps the legacy
  response `id` field while using the application DTO `artifactRef` internally.
- `src/routes/api/workflows/executions/[executionId]/plan/+server.ts` now reads
  the newest persisted plan through `workflowData` and retains the existing
  Dapr service-invocation fallback to `dapr-agent-py` for older runs.
- `src/routes/api/workflows/executions/[executionId]/lineage/+server.ts` now
  delegates scoped execution access and fork-lineage loading to
  `ApplicationWorkflowExecutionLineageService`. Recursive lineage traversal is
  confined to the Postgres execution repository adapter, and the route imports
  no workflow-data, project-scope, DB, or Drizzle modules.
- `src/routes/api/workflows/executions/[executionId]/+server.ts` now delegates
  detail loading and coordinator-owner shaping to
  `ApplicationWorkflowExecutionControlService.getExecutionDetail`. The service
  reads the execution through workflow-data and checks ownership through the
  lifecycle ownership port; the route imports no workflow-data, lifecycle, or
  project-scope helpers directly.
- `src/routes/api/workflows/[workflowId]/executions/+server.ts` now lists
  workflow executions through `workflowData.listWorkflowExecutions`, preserving
  the existing `summary`/`full` query behavior. The Postgres column selection is
  confined to the execution repository adapter.
- `src/routes/api/workflows/[workflowId]/runs-summary/+server.ts` now loads the
  session/agent run summary through `workflowData.listWorkflowExecutionRunSummaries`.
  Session and agent-run joins are confined to the execution repository adapter.
- `src/routes/api/workflows/executions/[executionId]/status/+server.ts` now
  delegates workspace-scope pre-checks, read-model loading, and serialization to
  `ApplicationWorkflowExecutionControlService.getExecutionStatus`. The service
  reaches the shared execution read-model loader through an application port;
  the route imports no workflow-data, read-model, or project-scope helpers.
- `src/routes/api/workflows/executions/[executionId]/approval-state/+server.ts`
  now delegates scope checking, active-status policy, workflow-spec loading,
  and approval listen-gate detection to
  `ApplicationWorkflowExecutionControlService.getApprovalState`. The route only
  performs auth, parameter validation, and response mapping.
- `src/routes/api/workflows/executions/[executionId]/approve/+server.ts` now
  resolves the execution and Dapr instance through `workflowData` before raising
  the approval event through Dapr service invocation.
- `src/routes/api/workflows/executions/[executionId]/spec-diff/+server.ts` now
  delegates scoped execution access, parent loading, snapshot-unavailable
  detection, task-name comparison, and per-task unified patch generation to
  `ApplicationWorkflowExecutionSpecDiffService`. The route imports no
  workflow-data, diff, spec-mutation, DB, Drizzle, or project-scope modules.
- `src/routes/api/workflows/executions/[executionId]/sessions/+server.ts` now
  delegates scoped execution access, direct plus inherited rerun-lineage
  session loading, and inherited/source response shaping to
  `ApplicationWorkflowExecutionSessionsService`. Ancestor traversal and
  session/project filtering are confined to the execution repository adapter,
  and the route imports no workflow-data, project-scope, DB, or Drizzle
  modules.
- `src/routes/api/workflows/executions/[executionId]/browser-artifacts/+server.ts`
  now requires the caller's authenticated project scope and delegates scoped
  execution access plus browser-artifact listing to
  `ApplicationWorkflowBrowserArtifactsService`. Browser artifact row reads
  remain behind the workflow-data port and Postgres adapter.
- `src/routes/api/workflows/executions/[executionId]/logs/+server.ts` now loads
  the execution, persisted node logs, and session-backed agent events through
  `workflowData`. Node-log and session-event queries are confined to the
  execution repository adapter; route-local logic only normalizes response shape
  and extracts trace ids from the execution output payload.
- `src/routes/api/workflows/executions/[executionId]/artifacts/[artifactId]/diff/+server.ts`
  now delegates scoped execution access, artifact lookup, diff-kind validation,
  and inline/file-backed patch resolution to
  `ApplicationWorkflowExecutionArtifactDiffService`. The route imports no
  workflow-data, project-scope, DB, Drizzle, or run-diff helper modules.
- `src/routes/api/workflows/executions/[executionId]/versions/+server.ts` now
  delegates scoped execution lookup, source-bundle filtering, version DTO
  shaping, promotion metadata extraction, promotion-gate evaluation, and
  outstanding-work policy to `ApplicationWorkflowCodeVersionService`. The route
  only performs auth, parameter validation, and response mapping.
- `src/routes/api/workflows/executions/[executionId]/versions/[artifactId]/promote/+server.ts`
  now delegates source-bundle promotion to
  `ApplicationWorkflowCodeVersionPromotionService`. The service scope-checks the
  execution through `workflowData.getScopedExecutionById`, validates the
  source-bundle artifact, resolves repo/base/mode/title defaults, evaluates the
  promotion gate through a policy port, records durable promotion metadata
  through workflow-data, and hides helper-pod provisioning plus shell command
  execution behind `SourceBundlePromotionRunnerPort`.
- `src/routes/api/workflows/executions/[executionId]/workspace-files/+server.ts`
  and `src/routes/api/workflows/executions/[executionId]/workspace-content/+server.ts`
  now delegate scoped execution lookup, Dapr instance resolution, no-workspace
  handling, workspace tree listing, and file read policy to
  `ApplicationWorkflowExecutionWorkspaceService`. JuiceFS/WebDAV access is
  confined to `JuiceFsWorkflowExecutionWorkspaceAdapter`; the routes only
  perform auth, parameter validation, response mapping, and binary response
  construction.
- `src/routes/api/workflows/executions/[executionId]/files/+server.ts` now
  delegates scoped execution lookup and persisted output-file read-model loading
  to `ApplicationWorkflowExecutionFilesService`. Session/file joins,
  live-sandbox selection, and CLI workspace detection are confined to the
  execution repository adapter; the route only performs auth, parameter
  validation, and response mapping.
- `src/routes/api/workflows/executions/[executionId]/metrics/+server.ts` now
  delegates scoped execution access, lineage-aware token aggregation, cache-hit
  math, per-model cost calculation, and response shaping to
  `ApplicationWorkflowExecutionMetricsService`. The SQL aggregation over
  `session_events`/`sessions` is confined to the execution repository adapter,
  and model pricing is injected as an application dependency rather than
  imported by the route.
- `src/routes/api/workflows/executions/[executionId]/code-checkpoints/+server.ts`
  now lists source-change checkpoints through
  `ApplicationWorkflowCodeCheckpointService`. The route keeps the existing
  `{ checkpoints }` response and generic 500 failure mapping but no longer
  imports the legacy checkpoint helper. The Postgres read is confined to
  `PostgresWorkflowCodeCheckpointStore.listForExecution` and
  `getForExecution`. The diff and restore routes now call
  `ApplicationWorkflowCodeCheckpointService.diffCheckpoint` and
  `restoreCheckpoint`; checkpoint lookup happens in the application store before
  invoking `LegacyWorkflowCodeCheckpointWorkspacePort`, so the legacy helper is
  DB-free and only owns the remaining OpenShell/Dapr/Git transport behavior
  pending a deeper workspace-port split.
- `src/routes/api/workflows/executions/[executionId]/nats-stream/+server.ts`
  now delegates snapshot loading, cursor-based agent-event reads, session-event
  notifications, and terminal detection to
  `ApplicationWorkflowExecutionStreamService`. The route keeps only the legacy
  `/nats-stream` path and SSE response headers for client compatibility. The
  Postgres `LISTEN/NOTIFY` implementation is confined to
  `PostgresWorkflowSessionEventNotificationSource` in the Postgres adapter.
- `src/routes/api/sandboxes/[name]/logs/+server.ts` and
  `src/routes/api/sandboxes/[name]/stream/+server.ts` now read persisted agent
  events through `ApplicationSandboxEventsService`. The shared session-event
  query is confined to `PostgresSandboxAgentEventReadPort` in the application
  adapter layer.
- Execution status/SSE snapshots are now built by
  `ApplicationWorkflowExecutionReadModelService`. Persistence reads/writes flow
  through workflow-data ports, Dapr runtime status is behind
  `DaprWorkflowRuntimeStatusPort`, and trace extraction is injected as an
  application dependency. The old mixed DB/Dapr/ClickHouse execution read-model
  adapter has been removed.
- `src/routes/api/workflows/executions/[executionId]/resume/+server.ts` now
  delegates resume/fork decisions to
  `ApplicationWorkflowExecutionControlService.resumeExecution`. The application
  service loads the source execution, root workspace execution, and current
  workflow spec through `workflowData`, checks coordinator ownership through a
  lifecycle port, and starts the fork through a narrow run-starter port. The
  first run-starter adapter still wraps the canonical `startWorkflowRun` path
  pending the deeper workflow-start service split.
- `src/routes/api/workflows/executions/[executionId]/stop/+server.ts` and
  `src/routes/api/workflows/executions/[executionId]/stop/status/+server.ts`
  now delegate workflow stop request/status behavior to
  `ApplicationWorkflowExecutionControlService`. The application service checks
  execution access, coordinator ownership, stop-mode parsing, Lifecycle
  Controller stop/confirm calls, and existing 200/202/409 response semantics
  through lifecycle ports; the routes import no lifecycle, ownership, or
  project-scope helpers directly.
- `src/routes/api/v1/lifecycle/bulk-stop/+server.ts` now delegates bulk stop
  parsing, dedupe, bounded fan-out, coordinator-owned checks, interrupt goal
  pausing, benchmark/evaluation run cancellation, coordinator cancel
  notification, and summary calculation to
  `ApplicationBulkLifecycleStopService`. The route imports no lifecycle,
  ownership, Dapr client, benchmark/evaluation service, goal repo, or
  project-scope helpers directly.
- `src/routes/api/workflows/[workflowId]/execute/+server.ts` is now a thin
  presentation adapter: it delegates workspace scope checks, trigger-data
  normalization, execution creation, validation, prewarm, Dapr scheduling,
  scheduler attachment, and start-failure marking to
  `ApplicationWorkflowExecutionControlService.executeWorkflow`, which reaches
  workflow-data and the canonical starter only through application ports.
- The `resolveSpecAgentRefs` path used by `startWorkflowRun` no longer imports
  `$lib/server/db`, Drizzle, or `agentSkillRegistry` directly. Attached
  `agentConfig.skills[]` entries are hydrated through
  `AgentSkillHydrationRepository`, with the Postgres query confined to
  `PostgresAgentSkillHydrationRepository`.
- The agent compiled-capabilities debug helper no longer imports DB/Drizzle for
  project resolution; `LegacyAgentCompiledCapabilitiesRepository` supplies the
  project id from the Postgres adapter before invoking the read-only compiler.
- `src/routes/api/workflows/[workflowId]/webhook/+server.ts` is now a thin CORS
  presentation adapter: it parses the body/authorization header and delegates
  workflow lookup, API-key ownership validation, webhook-trigger validation, SW
  1.0 spec validation, duplicate-running-run checks, and execution start to
  `ApplicationWorkflowExecutionControlService.startWebhookExecution`.
- `src/routes/api/workflows/[workflowId]/export/+server.ts` now loads and
  scope-checks workflow definitions through `workflowData`; code emission and
  code-function creation remain behind their existing service boundaries.
- `src/routes/api/workflows/[workflowId]/published/[version]/+server.ts` now
  loads the workflow definition through `workflowData` before extracting the
  requested published revision from the workflow spec metadata.
- `src/routes/api/workflows/[workflowId]/versions/+server.ts` now scope-checks
  the workflow through `workflowData` and loads cross-run source-bundle artifacts
  through `workflowData.listSourceBundleArtifactsByWorkflowId`.
- `src/routes/api/workflows/+server.ts` and
  `src/routes/api/workflows/[workflowId]/+server.ts` now list and fetch
  workflow definitions through workflow-data application ports, while
  create/update/delete commands delegate to
  `ApplicationWorkflowDefinitionCommandService`. Connection-ref sync,
  destructive delete scope checks, active-run guards, and terminal-history FK
  conflict mapping are no longer route-local; direct `workflow_connection_refs`
  writes remain confined to the `LegacyWorkflowConnectionRefSyncPort` adapter
  seam.
- `src/routes/api/workflows/[workflowId]/publish/+server.ts` now reads and
  updates workflow definitions through workflow-data application ports while
  preserving the existing published-runtime metadata shape.
- `src/routes/api/workflows/[workflowId]/triggers/**` now moves trigger
  collection list/create scope checks, trigger-kind validation, reserved config
  sanitization, and dedup-salt command shaping behind
  `ApplicationWorkflowTriggerManagementService`, and item
  activate/deactivate/delete commands behind
  `ApplicationWorkflowTriggerLifecycleService`. The routes no longer import
  workflow-data, project-scope helpers, trigger-registry validation, ID
  generation, or the trigger reconciler directly. Trigger activation
  reconciliation now reads and writes trigger lifecycle state through
  `WorkflowTriggerStore`; direct DB access is confined to
  `PostgresWorkflowTriggerStore.updateLifecycleState`, while the backing
  provision/deprovision side effects remain behind
  `WorkflowTriggerLifecycleAdapter`.
- `src/routes/workspaces/[slug]/workflows/runs/[executionId]/+page.server.ts`
  now resolves the execution through `workflowData.getExecutionById` before
  redirecting to the canonical workflow run URL. The page loader keeps only URL
  shaping and workspace scope checks, and no longer imports Drizzle schema or
  `$lib/server/db`.
- `src/routes/workspaces/[slug]/workflows/+page.server.ts` now delegates the
  workflow list read model to `workflowData.listWorkspaceWorkflowSummaries`.
  Workspace scoping, recent-run lookup, fork counts, running-first ordering, and
  "last active" sorting moved into application-service composition over
  workflow definition/execution ports; SQL remains confined to the Postgres
  adapter.
- `src/routes/workspaces/[slug]/service-graph/+page.server.ts` now delegates
  its workflow/execution picker read model to
  `workflowData.listServiceGraphPickerOptions`. Workflow option lookup, recent
  execution lookup, scoped legacy fallback, default execution selection, and
  selector label formatting moved out of the page loader.
- `src/routes/api/observability/service-graph/+server.ts`,
  `src/routes/api/observability/service-graph/drilldown/+server.ts`, and
  `src/routes/api/observability/workflows/[executionId]/activity-rate/+server.ts`
  now
  resolve scoped execution/workflow graph context through workflow-data before
  invoking the existing observability graph/drilldown helpers and metric
  readers. Route-local direct `workflow_executions`/`workflows`/`sessions` SQL,
  `sessionHostAppId`, and `isResourceInScope` imports were removed; ClickHouse
  and workflow-log aggregation remain inside observability helpers pending the
  deeper telemetry adapter slice.
- `src/routes/api/observability/traces/+server.ts` now resolves its in-scope
  session/execution id sets and trace goal-chip enrichment through workflow-data
  observability trace ports. ClickHouse trace listing and service filter queries
  remain in the route for the later telemetry adapter slice, but route-local
  Drizzle/schema access to `sessions`, `workflow_executions`, and `thread_goals`
  was removed.
- `src/routes/api/observability/traces/[traceId]/**` now scope-checks per-trace
  detail/log/LLM/tool/investigation reads through
  `ApplicationObservabilityTraceAccessService`. ClickHouse trace-owner
  extraction is behind `ClickHouseTraceOwnerResolver`, and `sessions` /
  `workflow_executions` owner authorization is confined to
  `PostgresObservabilityTraceRepository`; the old DB-backed
  `observability/trace-scope.ts` helper was removed.
- The obsolete `/api/monitor` route family was retired with the old admin
  workflow-instance diagnostic page.
- The admin-gated routes `src/routes/api/metrics/aggregate/+server.ts`,
  `src/routes/api/v1/gitops/deployment-metadata/+server.ts`,
  `src/routes/api/v1/gitops/promotions/+server.ts`, and
  `src/routes/api/admin/pieces/[pieceName]/enable/+server.ts` now resolve
  platform-admin status through the workflow-data user profile port instead of
  querying `users.platform_role` directly in route code.
- `src/routes/api/metrics/aggregate/+server.ts`,
  `src/routes/api/v1/capacity/rightsizing/+server.ts`, and
  `src/routes/api/internal/sessions/resource-sample/+server.ts` now delegate
  aggregate metrics, rightsizing read models, and resource sample persistence to
  `ApplicationResourceMetricsService`; Drizzle access for workflow/session
  counts and session resource samples is confined to resource-metrics adapters.
- `src/routes/api/prompt-presets/+server.ts` and
  `src/routes/api/prompt-presets/[id]/+server.ts` now delegate project-scoped
  prompt-preset list/create/update/archive behavior to
  `ApplicationPromptPresetService`. The existing prompt-preset persistence
  module is confined to `LegacyPromptPresetRepository`; route-local behavior is
  limited to auth, JSON parsing, validation-error mapping, and HTTP status
  mapping. The legacy best-effort MLflow prompt sync remains inside that
  adapter seam pending the separate OTel lineage cleanup.
- `src/routes/api/prompt-presets/[id]/usages/+server.ts`,
  `src/routes/api/agent-skills/[id]/used-by/+server.ts`, and
  `src/routes/api/v1/vaults/[id]/usages/+server.ts` now read reverse-lookup
  usage models through workflow-data resource usage ports. Preset binding scans,
  skill attachment JSONB queries, and vault/session JSONB containment queries
  are confined to the Postgres resource-usage adapter.
- `src/routes/api/agent-skills/**` and
  `src/routes/api/admin/agent-skills/**` now delegate list/create/update/delete,
  registry import, zip import, search, status changes, and manage-permission
  checks to `ApplicationAgentSkillService`. The legacy DB-backed agent skill
  implementation moved to `LegacyAgentSkillRepository` under the adapter layer;
  pure bundle parsing/validation remains in `src/lib/server/skill-ingest.ts`.
- `src/routes/api/ai-assistant/messages/[workflowId]/+server.ts` now lists and
  deletes workflow AI chat history through workflow-data. `workflow_ai_messages`
  reads/deletes and row-to-message mapping are confined to the Postgres AI
  assistant message adapter.
- `src/routes/api/ai-assistant/build-workflow/+server.ts` now loads the current
  workflow spec through `workflowData.getWorkflowByRef` and saves generated
  specs through `workflowData.updateWorkflowDefinition`. The route still owns
  the existing SSE generation/validation/execution feedback loop, but no longer
  imports `workflows`, Drizzle, or `$lib/server/db`.
- `src/routes/api/v1/security/audit/+server.ts` now loads the merged
  credential-access, project-member, and runtime-config audit stream through
  workflow-data. The 30-day audit window and source-specific SQL are confined
  to the application service plus Postgres security-audit adapter.
- `src/routes/api/v1/dashboard/+server.ts` now loads dashboard stats, active
  sessions, recent agent/environment version changes, and resource counts
  through workflow-data. Session, agent, environment, and vault SQL is confined
  to the Postgres dashboard read adapter.
- `src/routes/workspaces/[slug]/dev/+page.server.ts`,
  `src/routes/workspaces/[slug]/dev/[executionId]/+page.server.ts`, and the
  public `src/routes/api/dev-environments/**` GET routes now load dev-preview
  hub, service catalog, list, and detail read models through workflow-data and a
  dev-environment read repository port. The existing DB reconstruction helper is
  wrapped as a legacy adapter. Dev-preview provision/teardown routes now call
  `PreviewEnvironmentProvisioner`; per-preview database create/drop is confined
  to `PostgresPreviewDatabaseProvisioner`.
- `src/routes/workspaces/[slug]/+layout.server.ts` and
  `src/lib/server/workspaces/resolve.ts` now validate workspace slug membership
  and stale-slug redirect targets through workflow-data workspace-project
  ports. The workspace layout keeps URL shaping and 401/404/302 presentation
  behavior, while `projects`/`project_members` queries are confined to the
  Postgres adapter.
- `src/routes/workspaces/[slug]/connections/[pieceName]/+page.server.ts` now
  reads piece metadata and per-connection workflow usage through
  `workflowData.getPieceCatalogDetail`. The page loader still owns auth/action
  presentation shaping, while `piece_metadata` and `workflow_connection_ref`
  SQL is confined to the Postgres piece catalog adapter.
- `src/routes/connections/+page.server.ts` now resolves the active project's
  workspace slug through `workflowData.getWorkspaceProjectExternalId` before
  redirecting to the workspace-scoped connections page. The route no longer
  imports `projects`, Drizzle, or `$lib/server/db`.
- `src/routes/settings/members/+page.server.ts` now reads the active project
  membership panel through `workflowData.getWorkspaceProjectMembershipDetail`.
  The page loader no longer imports `projects`, `project_members`, Drizzle, or
  `$lib/server/db`.
- `src/routes/settings/+page.server.ts` now reads profile and platform OAuth
  app configuration through `workflowData.getSettingsPageReadModel`. User,
  platform OAuth app, and OAuth-capable piece metadata queries are confined to
  the Postgres settings adapter; the route keeps only base URL shaping and
  unauthenticated fallback response shape.
- `src/routes/settings/cli-tokens/+page.server.ts` now reads CLI runtime
  enrollment metadata and per-provider credential summaries through
  `ApplicationSettingsCliTokensService`. Runtime-registry access and user CLI
  credential summary lookup are confined to application adapters; the page
  loader no longer imports the runtime registry or credential helper directly.
- `src/routes/api/settings/api-keys/**` now lists, creates, deletes, and rotates
  user API keys through workflow-data application ports. Plaintext key
  generation and hashing moved into the application service, while persisted
  hashed-key SQL is confined to the Postgres API-key adapter.
- `src/routes/api/settings/oauth-apps/+server.ts` now creates, updates, and
  deletes platform OAuth app configuration through workflow-data application
  ports. Platform resolution, encrypted secret persistence, and
  `platform_oauth_apps` upserts/deletes are confined to the settings
  application service plus Postgres settings adapter; the route owns only auth,
  request validation, and response status.
- `src/routes/api/mcp-connections/+server.ts`,
  `src/routes/api/mcp-connections/[id]/{+server.ts,tools/+server.ts}`, and
  `src/routes/api/mcp-connections/catalog/**` now list, create, upsert,
  update, delete, discover tools, fetch per-piece catalog actions, and compose
  the browser-safe MCP catalog through workflow-data application ports.
  Piece-name normalization, piece-backed idempotent upsert, active
  app-connection binding validation, tool-selection metadata mutation,
  hosted-workflow delete protection, metadata-first tool discovery, MCP health
  fallback, action flattening, OAuth configured-state enrichment, and catalog
  search/filtering are application service behavior; `mcp_connection`,
  `app_connection`, `platform_oauth_apps`, and piece metadata SQL is confined to
  Postgres adapters. The MCP connection route family is now free of direct
  `$lib/server/db`, `$lib/server/db/schema`, and `drizzle-orm` imports.
  `src/lib/server/mcp-connections.ts` is now a pure normalization/session helper;
  the stale direct-DB credential binding export was removed because
  `ApplicationWorkflowDataService` owns active app-connection binding
  validation through ports.
- `src/routes/api/v1/projects/[projectId]/mcp-server/+server.ts` and
  `src/routes/api/v1/projects/[projectId]/mcp-server/rotate/+server.ts` now
  read, enable/disable, rotate tokens, project MCP-triggered workflow catalogs,
  and sync the hosted workflow MCP connection through workflow-data application
  ports. Project-role authorization, create-on-read server provisioning,
  encrypted token creation/decryption, MCP trigger parsing, public gateway URL
  fallback, and `hosted_workflow` connection upsert behavior are now owned by
  `ApplicationWorkflowDataService`; `mcp_server`, `mcp_connection`,
  `project_members`, `projects`, and workflow catalog SQL is confined to the
  Postgres hosted MCP server adapter. The public hosted MCP server route family
  is now free of direct `$lib/server/db`, `$lib/server/db/schema`,
  `$lib/server/db/mcp`, and `drizzle-orm` imports.
- `src/routes/api/internal/mcp/projects/[projectId]/server/+server.ts` and
  `src/routes/api/internal/mcp/projects/[projectId]/catalog/+server.ts` now
  bootstrap the mcp-gateway hosted server config and internal project catalog
  through workflow-data application ports. Project id/external-id resolution,
  enabled-connection listing, hosted-connection sync, hosted bearer token
  resolution, and catalog entry shaping are application service behavior;
  `mcp_server`, `mcp_connection`, `projects`, and workflow catalog SQL remains
  confined to Postgres adapters. `src/lib/server/agents/mcp-resolution.ts` is
  now a pure row-to-runtime-config resolver, and
  `src/lib/server/mcp-catalog.ts` imports application-owned MCP connection
  types instead of Drizzle schema types.
- `src/routes/api/internal/mcp/runs/[runId]/+server.ts` and
  `src/routes/api/internal/mcp/runs/[runId]/respond/+server.ts` now read and
  respond to MCP run rows through workflow-data application ports. `mcp_run`
  create/attach/read/respond persistence is behind the Postgres MCP run
  adapter; the poll/respond routes are now free of direct `$lib/server/db/mcp`
  imports.
- `src/routes/api/internal/mcp/projects/[projectId]/tools/[workflowId]/execute/+server.ts`
  now starts hosted workflow MCP tools through workflow-data application ports.
  Project/workflow validation, hosted server status checks, MCP run creation,
  execution read-model row creation, input defaulting/validation, Dapr workflow
  scheduler dispatch, execution instance attachment, and MCP run attachment are
  owned by `ApplicationWorkflowDataService`; `mcp_run` and
  `workflow_executions` SQL remains confined to Postgres adapters. The route now
  owns only internal auth, request parsing, trace-header forwarding, and
  response mapping, and is free of direct `$lib/server/db`,
  `$lib/server/db/schema`, `$lib/server/db/mcp`, `drizzle-orm`, and `daprFetch`
  imports.
- `src/routes/api/v1/projects/[projectId]/members/**` now list, add, update,
  and delete project members through workflow-data application ports. Read
  access, admin-only mutations, same-platform member binding, duplicate-member
  checks, and last-admin guards live in `ApplicationWorkflowDataService`;
  `projects`, `project_members`, and `users` SQL is confined to the
  `PostgresWorkspaceProjectRepository` adapter. The route family imports no
  `$lib/server/db`, `$lib/server/db/schema`, `projectMembers`, or
  `drizzle-orm`.
- `src/routes/api/app-connections/+server.ts` and
  `src/routes/api/app-connections/[connectionId]/+server.ts`,
  `src/routes/api/app-connections/oauth2/{start,complete,authorize}/+server.ts`,
  `src/routes/api/internal/connections/[externalId]/decrypt/+server.ts`, and
  `src/lib/server/app-connections/index.ts` now list, create, update, delete,
  start OAuth, complete OAuth, decrypt credentials, refresh OAuth tokens, and
  expose legacy helper functions through workflow-data application ports.
  Provider/piece enrichment, filter normalization, encrypted value creation,
  scope-aware row creation, project ownership checks, OAuth metadata lookup,
  OAuth app secret resolution, token exchange persistence, decrypt-time refresh,
  platform OAuth client-secret injection, and 404 mapping are application
  service behavior; `app_connection`, `piece_metadata`, and
  `platform_oauth_apps` SQL is confined to the Postgres app-connection adapter.
  The app-connections route/helper family is now free of direct
  `$lib/server/db`, `$lib/server/db/schema`, `drizzle-orm`, `appConnections`,
  `pieceMetadata`, `platformOauthApps`, `encryptObject`, `decryptObject`, and
  `decryptString` imports.
- `src/routes/(admin)/admin/pieces/+page.server.ts`,
  `src/routes/api/admin/pieces/[pieceName]/enable/+server.ts`, and
  `src/routes/api/internal/pieces/**/+server.ts` now read and mutate admin
  piece enablement plus per-piece image lifecycle through workflow-data
  application services. Catalog, disabled-piece, workflow-usage, MCP-usage, and
  per-piece image status SQL is confined to the Postgres admin piece adapter;
  GHCR checks and Tekton build triggers are confined to the admin piece image
  infrastructure adapter.
- `src/routes/+layout.server.ts` reads sidebar profile data through
  `workflowData.getUserProfile`, and `src/routes/+page.server.ts` reads the
  root dashboard profile/recent-session/recent-run model through
  `workflowData.getHomePageReadModel`. The root UI loaders no longer import
  `users`, legacy session/run registries, Drizzle, or `$lib/server/db` for
  dashboard display fields.
- `src/routes/api/agents/+server.ts` and
  `src/routes/api/agents/[id]/+server.ts` now delegate agent list/create,
  detail/update, and archive behavior to `ApplicationAgentCatalogService`.
  Runtime validation, quickstart/builtin template resolution, config merge,
  request-to-command shaping, validation-error mapping, and not-found mapping
  are application-service behavior behind `AgentCatalogRepository`,
  `AgentRuntimeCatalog`, and `AgentTemplateCatalog` ports. The routes no longer
  import the agent registry, runtime registry, template catalog, or builtin
  profile helpers. Duplicate, version, compiled-capabilities, and registry-sync
  agent subroutes remain later bounded slices.
- `src/routes/api/agents/[id]/duplicate/+server.ts`,
  `src/routes/api/agents/[id]/versions/**`,
  `src/routes/api/agents/[id]/usages/+server.ts`, and
  `src/routes/api/agents/usages-summary/+server.ts` now delegate duplicate,
  version list/detail/restore, and agent usage read-model behavior to
  `ApplicationAgentCatalogService`. Those routes no longer import the legacy
  agent registry directly; the registry stays behind `AgentCatalogRepository`
  as the first Postgres-backed adapter. Compiled-capabilities and registry-sync
  agent subroutes remain later bounded slices.
- `src/routes/api/agents/[id]/compiled/+server.ts`,
  `src/routes/api/agents/[id]/registry/+server.ts`, and
  `src/routes/api/agents/[id]/registry/sync/+server.ts` now delegate compiled
  capability inspection, per-agent registry status/deregister, and explicit
  registry/runtime sync to `ApplicationAgentCatalogService`. DB, Dapr
  state-store, runtime registry, MCP resolution, and Kubernetes runtime-sync
  details remain behind `AgentCompiledCapabilitiesRepository` and
  `AgentRegistryRepository` adapters.
- `src/routes/api/v1/agents/import/+server.ts` and
  `src/routes/api/v1/agents/[id]/export/+server.ts` now delegate markdown
  import/export behavior to `ApplicationAgentImportExportService`. Markdown
  parsing/serialization, environment/vault reference resolution, agent
  create/read calls, and missing-reference warnings are application behavior
  behind agent-catalog and reference ports; the routes no longer import the
  legacy agent, environment, or vault registries directly.
- `src/routes/api/agents/registry/+server.ts` now delegates the global Dapr
  registry browser read model to `ApplicationAgentRegistryBrowserService`.
  Registry team/store env parsing and Dapr state HTTP reads are confined to
  `DaprAgentRegistryStateReaderAdapter`; the service owns registry key
  normalization, agent metadata projection, and diagnostics for missing indexes
  or state entries.
- `src/routes/workspaces/[slug]/connections/[pieceName]/+page.server.ts` now
  delegates integration-detail read-model construction to
  `workflowData.getPieceConnectionDetailPage`. Piece slug normalization,
  candidate expansion, auth display projection, action projection, and
  connection-usage mapping are no longer page-loader behavior; the loader only
  obtains workspace context, calls the application service, and maps missing
  pieces to 404.
- The workflow run shim plus the artifacts, sessions, lineage, spec-diff, and
  metrics execution read APIs now use `workflowData.getScopedExecutionById`.
  Project/workspace scoping for these run-detail reads is application-service
  policy rather than route code; the routes authenticate, call the scoped use
  case, map missing/out-of-scope executions to 404, and keep their existing
  read-model response shaping.
- `src/routes/api/workflows/executions/[executionId]/plan/+server.ts` now
  delegates plan lookup to `ApplicationWorkflowPlanService`. The durable
  artifact read remains the primary source through the plan artifact port, and
  the legacy Dapr service-invocation fallback to `dapr-agent-py` is confined to
  `DaprLegacyAgentPlanReader` instead of route code.
- `src/routes/api/v1/agent-runtimes/+server.ts`,
  `src/routes/api/v1/agent-runtimes/[slug]/+server.ts`,
  `src/routes/api/v1/agent-runtimes/[slug]/wake/+server.ts`,
  `src/routes/api/v1/agent-runtimes/[slug]/sleep/+server.ts`, and
  `src/routes/api/internal/agent-runtimes/reap-idle/+server.ts` now delegate to
  `getApplicationAdapters().agentRuntimeControl`. The route family imports no
  Drizzle schema, `$lib/server/db`, or Kubernetes client helpers. SQL lives in
  `PostgresAgentRuntimeRepository`; SandboxWarmPool reads/writes live in
  `KubernetesAgentRuntimeWarmPoolClient`; route-local code is limited to auth,
  parameter parsing, and HTTP status mapping.
- `src/routes/api/internal/benchmarks/runs/[runId]/evaluation-results/+server.ts`
  now delegates evaluator callback ingestion to
  `workflowData.ingestBenchmarkEvaluationResults`. The route imports no direct
  DB, Drizzle, benchmark-service, MLflow, or Dapr client helpers. Result status
  mapping, patch-stat derivation, batch update payload construction, terminal
  run skip semantics, inferencing-to-evaluating transition, completion
  transition, coordinator notification, and MLflow sync scheduling are
  application-service behavior behind ports. SQL lives in
  `PostgresBenchmarkEvaluationResultRepository`, preserving the existing
  single-statement `jsonb_to_recordset` batch update.
- `src/routes/api/internal/benchmarks/runs/+server.ts` no longer imports
  `$lib/server/db`, Drizzle, or the agent schema for `agentSlug -> agentId`
  resolution. Internal callers may pass either `agentId` or `agentSlug`; the
  slug selector is resolved inside `createBenchmarkRun` and still runs through
  the existing SWE-bench agent validation checks before any run is created.
- `src/routes/api/internal/evaluations/runs/[runId]/status/+server.ts` no
  longer imports `$lib/server/db`, Drizzle, or the evaluation run schema for the
  internal run lookup. The route delegates read-model loading to
  `getInternalEvaluationRun` and keeps status transitions in the evaluation
  service.
- `src/routes/api/benchmarks/environments/validate/+server.ts` and
  `src/routes/api/internal/benchmarks/environments/validate/+server.ts` no
  longer import `$lib/server/db` for route-local readiness guards. Both routes
  now delegate planning/submission to the benchmark environment validation
  service and map its `Database not configured` failure to the same HTTP 503
  response.
- `src/routes/api/internal/environments/ensure/+server.ts` no longer imports
  Drizzle, `$lib/server/db`, or benchmark suite/instance schema for SWE-bench
  metadata lookup. It delegates request validation, server metadata merge,
  repo/baseCommit conflict checks, and environment preparation to
  `ensureSwebenchEnvironmentFromInternalRequest`.
- `src/routes/api/v1/auth/sign-in/+server.ts` no longer imports Drizzle,
  `$lib/server/db`, or auth-related schema tables. Password identity lookup,
  bcrypt/scrypt verification, platform/project resolution, and token generation
  now live in `signInWithPassword`; the route sets cookies and maps the
  service result to HTTP.
- `src/routes/api/v1/gitops/events/stream/+server.ts` no longer imports the raw
  Postgres client for `LISTEN`. SSE framing, heartbeat, replay, and abort
  cleanup stay in the route; the Postgres `LISTEN gitops_activity_events`
  implementation is behind `subscribeGitOpsActivityEvents`.
- Evaluation and benchmark callback routes no longer import Drizzle schema types
  for request casts. `EvaluationSubjectTypeInput`,
  `EvaluationRunItemStatusInput`, `EvaluationArtifactKindInput`, and
  `BenchmarkResourceLeaseTypeInput` are route-facing application unions exported
  from the owning service modules.
- `src/lib/server/workflows/start-run.ts` no longer imports the direct
  execution read-model schema probe. Workflow start readiness now calls
  `workflowData.assertExecutionReadModelReady`, and trigger model-catalog
  fallback validation reads enabled models through a workflow-data model catalog
  port instead of importing Drizzle/model schema from `model-validation.ts`.
- Orchestrator strict-mode tests now block `psycopg2` imports, not just
  `psycopg2.connect`, for migrated app.py helpers, workflow-data activity
  migrations, OTel trace finalization, and MCP config resolution. Fallback-mode
  tests still keep explicit fake Postgres modules for rollback coverage.
- `src/routes/workspaces/[slug]/benchmarks/+page.server.ts`,
  `src/routes/workspaces/[slug]/benchmarks/runs/+page.server.ts`, and
  `src/routes/workspaces/[slug]/benchmarks/compare/+page.server.ts` now delegate
  benchmark browser, run-list filter, tag shortcut, and compare read models to
  workflow-data. Suite bootstrap, instance/repo catalog reads, environment-image
  status reads, runnable-agent eligibility, environment coverage, runtime
  capacity shaping, run summary listing, and compare-grid loading are behind
  application ports. Drizzle access is confined to Postgres/legacy benchmark
  read adapters pending the deeper benchmark service extraction.
- `src/routes/api/v1/usage/+server.ts`, `src/routes/api/v1/cost/+server.ts`,
  and `src/routes/api/v1/limits/live/+server.ts` now read reporting snapshots
  through workflow-data application ports. Default time windows, response
  shaping, price-book exposure, and provider-prefixed model pricing resolution
  live in `ApplicationWorkflowDataService`; `sessions`, `session_events`, and
  `agents` SQL is confined to `PostgresUsageReportingRepository`. Live limit
  token windows now use `agent.llm_usage` session events instead of the legacy
  `sessions.usage` JSON field.
- `src/routes/api/sandboxes/[name]/executions/+server.ts` and
  `src/routes/api/sandboxes/stats/+server.ts` now read sandbox execution
  inventory and aggregate stats through workflow-data application ports. Recent
  execution lookup and 24-hour execution counting SQL is confined to
  `PostgresSandboxInventoryRepository`; live OpenShell sandbox listing is behind
  the `SandboxRuntimeInventory` adapter. The routes preserve the legacy
  best-effort behavior by returning empty execution/stat payloads when the
  Postgres adapter is unavailable.
- `src/routes/api/pieces/+server.ts` and
  `src/routes/api/catalog/functions/+server.ts` now read connectable pieces and
  function catalog summaries through workflow-data application ports. Connectable
  piece filtering, code-function-first catalog composition, ActivePieces catalog
  partial-failure reporting, and anonymous code-function omission are
  application service behavior. `piece_metadata` and `code_functions` SQL is
  confined to `PostgresPieceCatalogRepository` and
  `PostgresCodeFunctionCatalogRepository`; the routes import no direct DB,
  schema, Drizzle, or catalog DB helpers.
- `src/routes/api/action-catalog/+server.ts` and
  `src/routes/api/action-catalog/[actionId]/+server.ts` now delegate action
  catalog snapshot/detail loading and detail response shaping to
  `ApplicationActionCatalogService`; the legacy unified action-catalog loader is
  confined to an application adapter. The ActivePieces `piece_metadata` row
  query used by the unified catalog is now in
  `PostgresPieceMetadataActionSourceReader`; `action-catalog/piece-metadata-source.ts`
  only owns row-to-action transformation and no longer imports DB, schema, or
  Drizzle.
- `src/routes/api/action-catalog/[actionId]/options/+server.ts` now delegates
  dynamic option lookup to `ApplicationActionOptionsService`. Action catalog
  lookup, code-function option proxying, connection decrypt/provider validation,
  ActivePieces piece-runtime invocation, and cold-start warming response shaping
  are behind application ports; the route owns only auth, JSON parsing, and HTTP
  response mapping.
- `src/routes/api/code-functions/[id]/execute/+server.ts` now delegates
  user-scoped code-function lookup, preview execution-id generation,
  function-router payload construction, Dapr invocation, and router error
  mapping to `ApplicationCodeFunctionExecutionService`.
- `src/routes/api/internal/workflows/triggers/start/+server.ts` now delegates
  Dapr CloudEvent normalization, deterministic execution-id derivation,
  trigger admission gating, idempotent workflow start, and poison-message ACK
  policy to `ApplicationTriggeredWorkflowStartService`; the route owns only JSON
  parsing and Dapr pub/sub status response mapping.
- `src/routes/api/internal/sessions/spawn-peer/+server.ts` now delegates peer
  session request validation, workflow-data ensure/reuse, skip-spawn dispatch
  context resolution, Dapr `session_workflow` spawning, and accepted spawn-failure
  response shaping to `ApplicationPeerSessionSpawnService`; the route owns only
  internal-token auth, JSON parsing, and HTTP response mapping.
- `src/routes/api/internal/goals/[sessionId]/evaluate/+server.ts` and
  `src/routes/api/internal/goals/[sessionId]/stop-check/+server.ts` now delegate
  evaluator completion authority, goal row completion, completed-workflow
  finalization, rejection event emission, stop-hook goal-loop driving, and current
  goal status reporting to `ApplicationInternalGoalControlService`; the routes
  own only internal-token auth and HTTP response mapping. The deterministic
  evidence evaluator now receives `SessionGoalStore` and workflow-data ports for
  goal lookup, workspace-session lookup, session-detail fallback, and
  interactive-CLI runtime targeting; `src/lib/server/goals/evaluator.ts` no
  longer imports Drizzle, `$lib/server/db`, `workflow_workspace_sessions`,
  or `src/lib/server/sessions/registry.ts`.
- `src/routes/api/workflow/active-executions/+server.ts`,
  `src/routes/api/internal/agent/workflows/executions/+server.ts`, and
  `src/routes/api/internal/agent/workflows/executions/[executionId]/status/+server.ts`
  now read active execution lists, internal-agent execution lists, execution
  rows, workflow metadata, and read-model status updates through workflow-data
  application ports. `workflow_executions`/`workflows` joins and filtered counts
  are confined to `PostgresWorkflowExecutionRepository`; the status route still
  owns the Dapr runtime probe and runtime-status mapping, then persists the
  synchronized read-model patch through `workflowData.updateExecutionReadModel`.
- `src/routes/api/internal/workflows/executions/[executionId]/run-diff/+server.ts`
  and
  `src/routes/api/internal/workflows/executions/[executionId]/source-bundle/+server.ts`
  now fetch execution ownership and persist durable diff/source-bundle artifacts
  through workflow-data application ports. `persistRunDiff`,
  `resolveRunDiffPatch`, and `persistSourceBundle` are now persistence-agnostic
  helper functions over artifact/file ports; route handlers no longer import DB,
  schema, Drizzle, file registry helpers, or workflow artifact tables. The
  Postgres adapter owns file metadata/payload storage through
  `PostgresWorkflowFileStore`, while `PostgresArtifactStore` owns
  `workflow_artifacts` upserts. The artifact diff readback route resolves
  offloaded diff blobs through `workflowData.getWorkflowFileContent`.
- `src/routes/api/internal/dapr/system-events/+server.ts` keeps Dapr System
  dashboard fan-out route-local, while workflow-state event correlation and
  session timeline appends now go through
  `workflowData.findSessionIdByDaprInstanceId` and
  `workflowData.appendSessionEvent`. The best-effort Dapr pub/sub ACK behavior
  is preserved when the bridge fails.
- `src/routes/api/internal/sessions/[id]/outputs/ingest/+server.ts` now resolves
  session file ownership through `workflowData.getSessionFileOwner` and
  persists agent-written output files through `workflowData.createWorkflowFile`.
  Per-file validation and partial-success response shaping remain route-local.
- `src/routes/api/internal/sessions/[id]/events/ingest/+server.ts` now delegates
  session-event append, status mirroring, workflow-session context lookup, code
  checkpoint upsert, and evaluation warning artifact recording to
  `workflowData.ingestSessionEvent`. The route remains the internal HTTP
  adapter for token validation, envelope parsing, and fire-and-forget sandbox
  cleanup when the application service reports a terminal session event.
- `src/routes/api/internal/sessions/provisioning/ingest/+server.ts` now resolves
  provisioning events through
  `workflowData.resolveSessionIdForProvisioningEvent` and appends
  `session.provisioning_*` rows through `workflowData.appendSessionEvent`. It
  preserves the previous no-retry `200` skip behavior for malformed, unmatched,
  and no-DB observer events.
- `src/routes/api/events/ingest/+server.ts` now performs read-model readiness,
  supported workflow lookup, duplicate scan inputs, execution creation,
  scheduler attach, and failed-start status updates through workflow-data
  application ports. The route still owns internal auth, external event parsing,
  trigger normalization, Dapr orchestrator invocation, and trace-header
  forwarding. Duplicate detection in
  `src/lib/server/workflows/external-event-registry.ts` is now a pure helper over
  execution DTOs instead of a direct `workflow_executions` query.
- `src/routes/api/internal/dapr/agent-trigger/+server.ts` now checks acting-user
  project membership through the workspace-project application port instead of
  querying `project_members` directly. The broader command path now delegates
  CloudEvent data normalization, deterministic session id derivation,
  slug/id-based agent resolution, project membership authorization, duplicate
  session detection, session creation, initial user event append, and session
  workflow spawn to `ApplicationSessionCommandService`. The route remains the
  Dapr subscription HTTP adapter: parse JSON, invoke the command, and ack
  `{status:"SUCCESS"}` so poison messages do not wedge delivery.
- `src/routes/api/internal/sessions/spawn-peer/+server.ts` now delegates
  idempotent peer session lookup/creation, parent/peer owner resolution, initial
  user event append, and skip-spawn dispatch metadata resolution to
  workflow-data ports. The route retains token validation, request/response
  shaping, and `spawnSessionWorkflow` as the runtime command that starts the
  Dapr session workflow.
- `src/routes/api/internal/sessions/ensure-for-workflow/+server.ts` now delegates
  workflow-execution owner/project fallback, benchmark session provisioning
  gating, the deterministic workflow-session row lookup/create/update path, and
  terminal per-run host listing, plus agent runtime identity and final wake-slug
  fallback, and published-agent/version resolution to workflow-data ports.
  Workflow-driven evaluator-goal row persistence now delegates to
  `ApplicationSessionGoalService.ensureWorkflowEvaluatorGoal`, so the route no
  longer imports a goal persistence helper. Repository resource
  materialization and best-effort pre-run mounting now delegate to
  `ApplicationSessionCommandService.materializeWorkflowSessionRepositories`, so
  the route no longer imports `src/lib/server/sessions/registry.ts` or the
  repository-mounter adapter directly. Terminal per-run agent-host reaping
  now delegates to
  `ApplicationSessionCommandService.reapTerminatedWorkflowSessionRuntimeHosts`,
  so Kubernetes Sandbox deletion is behind the session sandbox-destroyer port
  instead of the route calling `deleteSandbox` directly. Swap-degraded audit
  events and initial workflow user messages now delegate to
  `ApplicationSessionCommandService`, so the route no longer imports
  the legacy session event helper directly. Published-vs-ephemeral workflow session
  agent selection and runtime-registry sync now also delegate to
  `ApplicationSessionCommandService` through the `WorkflowEphemeralAgentStore`
  and `AgentRuntimeSyncPort` ports, so the route no longer imports
  `src/lib/server/agents/ephemeral.ts` or
  `src/lib/server/agents/registry-sync.ts`. The route still owns runtime command
  ordering, sandbox provisioning/wake, and child-input assembly. It no longer imports
  `$lib/server/db` or Drizzle schema types; published-agent SQL is confined to
  the workflow-data agent adapter, and on-demand legacy MLflow registration is
  no longer created from this hot path.
- `src/routes/api/internal/sessions/[id]/cli-credentials/capture/+server.ts`
  now resolves the session owner through `workflowData.getSessionFileOwner`
  instead of querying `sessions.user_id` directly. Credential bundle validation,
  encrypted storage, and boot-lease release remain behind the existing
  `users/cli-credentials` service seam pending a later user credential store
  slice.
- `src/routes/api/internal/executions/[id]/ap-resume/[requestId]/+server.ts`
  now validates the target execution through `workflowData.getExecutionById`
  instead of querying `workflow_executions` directly. The route remains the
  public ActivePieces callback adapter: it parses callback payloads and raises
  the existing Dapr external event to the orchestrator.
- `src/routes/api/internal/workflows/triggers/github/[triggerId]/+server.ts`
  now loads trigger rows and stamps successful deliveries through workflow-data
  trigger ports instead of querying/updating `workflow_triggers` directly. The
  public webhook behavior is unchanged: HMAC validation remains fail-closed,
  ignored events and pings are acknowledged, publish failures return `502`, and
  `last_fired_at` remains best-effort after successful publish.
- `src/lib/server/workflows/trigger-gate.ts` now counts active triggered runs
  through `workflowData.countActiveTriggeredWorkflowRuns` instead of querying
  `workflow_executions` directly. The gate still admits below cap, defers at
  cap through the existing Dapr pub/sub retry response, and fails open when the
  count path throws.
- `src/routes/api/internal/piece-executions/[idempotencyKey]/+server.ts` now
  reads piece-runtime idempotency/result-offload rows through
  `workflowData.getPieceExecutionByIdempotencyKey` instead of querying
  `piece_execution` directly. The route keeps internal-token auth and the
  existing 404/503/read-model response contract.
- `src/routes/api/internal/workflows/executions/[executionId]/cli-workspace-command/+server.ts`
  now resolves live CLI session candidates through
  `workflowData.listCliWorkspaceCommandCandidates`, reads execution context
  through `workflowData.getExecutionById`, persists image readbacks through
  `workflowData.createWorkflowFile`, and persists browser walkthrough videos
  through `workflowData.saveWorkflowBrowserArtifact`. The route still owns the
  cli-agent-py command transport, chunked file reads, and helper-pod
  adoption/provisioning behavior.
- `src/routes/api/v1/sessions/[id]/provisioning/+server.ts` now loads the
  session-scoped provisioning read model through
  `workflowData.getSessionProvisioningReadModel`. Session ownership/runtime app
  lookup is confined to the session repository adapter, and live Kubernetes
  provisioning reads stay behind the application provisioning reader port.
- `src/routes/api/v1/sessions/[id]/control/context-usage/+server.ts` now loads
  session context usage through `workflowData.getSessionContextUsage`. Session
  ownership, event aggregation, and agent-context JSON extraction are confined
  to the session repository adapter.
- `src/routes/api/v1/sessions/[id]/fork/+server.ts` now delegates fork-session
  creation and event replay to `workflowData.forkSessionFromEvent`. Source
  session lookup, optional experiment-agent creation, forked session creation,
  and ordered replay through `SessionEventLog.appendSessionEvent` are confined
  to application ports/adapters.
- `src/routes/api/v1/sessions/[id]/events/stream/+server.ts` now streams from
  workflow-data application ports. The route still owns the SSE wire contract,
  but snapshot reads, durable event-log drains, and session-event notification
  subscription are no longer direct Postgres or legacy session-helper imports.
- `src/routes/api/v1/sessions/[id]/events/+server.ts` now lists and appends
  session events through workflow-data application ports. User-event appends
  still wake the Dapr session workflow best-effort, but that runtime transport
  is behind `SessionRuntimeEventRaiser` instead of a route-level session helper.
- `src/routes/api/v1/sessions/[id]/events/[eventId]/+server.ts` now scope-checks
  the session through workflow-data and fetches the full event payload through
  the session event-log port instead of importing a direct DB session event
  helper.
- `src/routes/api/v1/sessions/[id]/+server.ts` now reads session detail and
  mutates title/archive/delete state through scoped workflow-data application
  ports. The route still owns HTTP response shaping and preserves the existing
  Lifecycle Controller active-run guard before destructive archive/delete
  commands.
- `src/routes/api/v1/sessions/[id]/runtime-config/+server.ts` now loads runtime
  config through a scoped workflow-data port. Live runtime/Dapr probing remains
  behind the runtime-config reader adapter instead of being imported by the
  presentation route.
- `src/routes/api/v1/sessions/[id]/goal/+server.ts` now scopes session reads
  and native CLI `/goal` command injection through
  `ApplicationSessionGoalService`. Thread-goal create/update/fetch operations
  now use `PostgresSessionGoalStore` with an injected DB from the application
  composition root, and lifecycle goal pausing uses the same store. The
  native-goal capability check now resolves session runtime metadata through
  workflow-data before consulting the runtime registry, instead of using the
  legacy DB-backed runtime-target helper. The deterministic evidence evaluator
  also uses the application goal store plus workflow-data ports. The remaining
  goal-loop driver persistence now uses `GoalLoopStore` and
  `PostgresGoalLoopStore`; the old `src/lib/server/goals/repo.ts` module has
  been removed.
- `src/routes/api/v1/sessions/[id]/goal-flow/+server.ts` now scopes the session
  and builds the observability goal-flow read model through workflow-data
  application ports. The current-goal lookup and bounded goal-flow event read
  over `thread_goals`/`session_events` are confined to the Postgres goal-flow
  read-store adapter; the route owns only auth and response shaping.
- `src/routes/api/v1/sessions/[id]/control/settings/+server.ts` now reads the
  composed settings drawer model through workflow-data. Session scope is enforced
  before agent/environment registry reads, which are confined to the workflow
  agent read adapter.
- `src/routes/api/v1/sessions/[id]/control/mcp-status/+server.ts` now scopes the
  session through workflow-data before using existing agent and vault credential
  read services. Moving credential status behind ports remains a dedicated
  MCP/auth slice.
- `src/routes/workspaces/[slug]/sessions/new/+page.server.ts` now loads
  runtime CLI-auth metadata through workflow-data and a runtime-registry reader
  port. The file-backed runtime registry remains the adapter-side source of
  truth; the page loader no longer imports the runtime registry directly.
- `src/routes/api/v1/sessions/[id]/compute/+server.ts` and
  `src/routes/api/v1/sessions/[id]/runtime-flags/+server.ts` now load their
  full runtime read models through workflow-data. The `sessions`/`agents` join
  and runtime app-id fallback are confined to the session repository adapter;
  Kubernetes pod, metrics, warm-pool, and runtime-registry reads are confined to
  the runtime-status adapter.
- `src/routes/api/v1/sessions/[id]/shell/resolve/+server.ts` and
  `src/routes/api/v1/sessions/[id]/cli-terminal/resolve/+server.ts` now resolve
  runtime debug targets through workflow-data session ports. The live pod
  preflight and shell container selection remain route-local pending a command
  access slice.
- `src/routes/api/v1/sessions/[id]/cli-preview/+server.ts`,
  `src/routes/api/v1/sessions/[id]/cli-preview/view/[...path]/+server.ts`,
  `src/routes/api/workflows/executions/[executionId]/cli-preview/+server.ts`,
  `src/routes/api/workflows/executions/[executionId]/cli-preview/view/[...path]/+server.ts`,
  and `src/routes/api/workflows/executions/[executionId]/preview-info/+server.ts`
  now delegate preview target resolution, preview process start, reverse proxy
  request shaping, and preview-backend detection to
  `ApplicationCliPreviewService`. The SvelteKit handlers no longer import the
  CLI preview helper, Drizzle, or `$lib/server/db` directly.
  `src/lib/server/sessions/cli-preview.ts` now receives workflow-data readers
  for session runtime target lookup, execution lookup, interactive-CLI detection,
  and retained OpenShell fallback metadata; the helper no longer imports direct
  DB/Drizzle modules or the legacy DB-backed runtime-target helper. Kubernetes
  pod/provisioning calls and low-level HTTP proxying still sit behind
  `LegacyCliPreviewGatewayPort`; splitting those runtime/proxy internals into
  narrower ports remains a later preview portability slice.
- `src/routes/api/workflows/executions/[executionId]/sandbox-preview/+server.ts`
  and
  `src/routes/api/workflows/executions/[executionId]/sandbox-preview/[previewId]/[...path]/+server.ts`
  now delegate retained OpenShell sandbox lookup, preview start/stop commands,
  runtime-preview page URL construction, proxy request forwarding, and response
  body/header rewriting to `ApplicationSandboxPreviewService`. The route family
  no longer imports the sandbox-preview helper, runtime-preview URL helper,
  OpenShell runtime client, Drizzle, or `$lib/server/db` directly. Retained
  sandbox metadata is resolved through workflow-data ports; OpenShell runtime
  fetch/proxy behavior remains behind `LegacySandboxPreviewGatewayPort` pending
  a narrower runtime proxy port.
- `src/routes/api/v1/sessions/[id]/control/set-model/+server.ts`,
  `src/routes/api/v1/sessions/[id]/control/set-permission-mode/+server.ts`,
  and `src/routes/api/v1/sessions/[id]/control/update-agent-config/+server.ts`
  now scope and raise session agent-config patches through workflow-data
  application ports. Patch normalization, runtime MCP resolution, and Dapr
  control-event raising stay behind the session agent-config command adapter.
- `src/routes/api/v1/sessions/[id]/resources/+server.ts` and
  `src/routes/api/v1/sessions/[id]/resources/[resourceId]/+server.ts` now list,
  create, and remove session resources through scoped workflow-data application
  ports. `session_resources` SQL and row-to-DTO mapping are confined to the
  session repository adapter. The route still owns request validation and the
  best-effort mid-session live repository mount side effect.
- `src/routes/api/v1/sessions/[id]/sandbox/+server.ts` now keeps its existing
  Lifecycle Controller active-run guard and sandbox delete commands, but reads
  the post-guard session sandbox names through
  `workflowData.getSessionDetail` instead of the legacy session registry.

All `+page.server.ts` files are now free of direct `$lib/server/db`,
`$lib/server/db/schema`, and `drizzle-orm` imports. The scanned workflow API,
workspace/root UI, settings, connections, admin-pieces, project-members, and
usage/cost/live-limits route subset is also clean. The scanned sandbox
executions/stats, catalog pieces/functions, execution read/status, internal
run-diff/source-bundle ingest, internal session-ingest, and external
events-ingest route subsets, plus the agent-trigger route membership check and
the CLI credential capture session-owner lookup and ActivePieces resume
execution lookup, and the GitHub trigger ingress/gate subset, are also clean.
The workflow code-checkpoints list, diff, and restore routes are also clean;
diff/restore now call `ApplicationWorkflowCodeCheckpointService`, and the
Postgres checkpoint reads are confined to `PostgresWorkflowCodeCheckpointStore`.
The legacy workspace adapter no longer imports DB/Drizzle and only owns the
remaining OpenShell/Dapr/Git transport behavior.
The workflow trigger item lifecycle routes are also clean; direct trigger
backing reconciliation remains in the legacy lifecycle adapter seam.
The internal piece-execution artifact readback and CLI workspace command routes
are also clean. The prompt preset, agent skill, and vault resource-usage
reverse-lookup routes are also clean. The AI assistant message-history route is
also clean, and the AI assistant build-workflow stream no longer imports direct
DB modules. The security audit route and admin GitOps promotions remote are
also clean. The scanned session
provisioning, context-usage, control settings/MCP status, session
detail/title/archive/delete, fork, goal,
goal-flow, event list/append/detail, runtime-config, config patch commands,
runtime debug target routes, dev terminal WebSocket preflight, resources, and
event-stream routes are also clean.
The internal session-events positional read route is also clean.
The session/execution CLI preview and OpenShell sandbox preview route families
are also presentation-clean; their persistence lookups now flow through
workflow-data, while remaining Kubernetes/OpenShell transport coupling is
documented inside legacy preview gateway adapters.
Sandbox list owner-session enrichment now resolves through workflow-data
session-owner ports instead of importing DB/Drizzle from
`src/lib/server/sandbox-sessions.ts`.
The dashboard and project workflow-run list routes are also clean.
The sandbox delete and batch-delete routes' active-session guard reads are also
clean; they now call `ApplicationSandboxActiveGuardService`, while
Kubernetes/OpenShell deletion behavior intentionally remains in the route.
Capability bundle CRUD is now clean: `src/routes/api/capability-bundles/**`
delegates list/create/read/update/archive behavior to
`ApplicationCapabilityBundleService`, with Drizzle access confined to
`PostgresCapabilityBundleRepository`. The runtime capability-flattening helper
is still listed below because it participates in effective agent/session config
resolution and needs its own narrower read port before it can move.
The broader BFF/control-plane still has route-level or service-level direct DB
imports outside that subset and remains the next migration area. Current
categories include:

- Lifecycle Controller internals under `src/lib/server/lifecycle/**`, excluding
  the trigger activation reconciler's trigger-row persistence now routed through
  `WorkflowTriggerStore` and pause/resume session-status mirroring now routed
  through workflow-data.
- goal-loop storage helpers under `src/lib/server/goals/**`, which still own
  drivable-goal claiming, usage accrual, idle-event metadata, and continuation
  claim queries.
- remaining session/workspace helpers under `src/lib/server/sessions/**`,
  `src/lib/server/openshell-sessions.ts`, and related API routes, excluding the
  capacity fleet-activity summary now confined to the adapter layer, the
  runtime-config helper's latest-event adapter seam, and session agent config
  patch command session lookup now routed through workflow-data, plus the
  session spawn read/agent-resolution/peer-dispatch/attach-runtime path now
  routed through workflow-data.
- preview runtime/proxy helper internals, where persistence lookups and
  per-preview database create/drop have moved behind ports, but live
  Kubernetes/OpenShell transport still needs narrower runtime/proxy ports.
- benchmark/evaluation/admin/reporting API surfaces outside the migrated
  workspace benchmark browser/run-list/compare loaders.
- startup/migration/bootstrap and remaining non-migrated API route handlers.

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

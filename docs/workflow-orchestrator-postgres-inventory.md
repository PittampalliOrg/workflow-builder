# Workflow Orchestrator Postgres Inventory

This inventory tracks direct Postgres access that remains while orchestration
persistence moves behind the workflow-data application ports. The intended
runtime boundary is Dapr service invocation to `workflow-builder` internal
workflow-data routes. Postgres remains the first workflow-data infrastructure
adapter, not an orchestrator dependency.

Inventory status: 2026-07-02, after the workflow start/control slice and the
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
code-checkpoint diff/restore, admin GitOps auth-check, and session-goal storage
wiring slices.
The internal CLI workspace command route now routes execution lookup,
CLI-session candidate lookup, file creation, and browser artifact persistence
through workflow-data.
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
`resolve_mcp_config.py` now uses a lazy `_connect_postgres` helper for the
rollback branch, and its fallback tests patch that helper directly.

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

The first UI-facing route has also moved behind the application service:

- `src/routes/api/workflows/executions/[executionId]/artifacts/+server.ts`
  now loads the parent execution and artifact list through
  `getApplicationAdapters().workflowData`; the route imports no Drizzle schema
  or `$lib/server/db`.
  `src/routes/api/workflows/executions/[executionId]/artifacts/artifacts-route.test.ts`
  locks both the response behavior and the no-direct-db boundary.
- `src/routes/api/workflows/executions/[executionId]/plan-artifacts/+server.ts`
  now lists, creates, and updates plan artifacts through `workflowData`.
  The application port gained `listPlanArtifactsByExecutionId`, with the
  Postgres query confined to
  `src/lib/server/application/adapters/postgres.ts`. The route keeps the
  legacy response `id` field while using the application DTO `artifactRef`
  internally.
- `src/routes/api/workflows/executions/[executionId]/plan/+server.ts` now reads
  the newest persisted plan through `workflowData` and retains the existing
  Dapr service-invocation fallback to `dapr-agent-py` for older runs.
- `src/routes/api/workflows/executions/[executionId]/lineage/+server.ts` now
  scopes the requested execution through `workflowData.getExecutionById` and
  loads the fork lineage tree through `workflowData.getExecutionLineage`.
  Recursive lineage traversal is confined to the Postgres execution repository
  adapter.
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
  now resolves both execution and workflow spec through `workflowData` before
  detecting an approval listen gate.
- `src/routes/api/workflows/executions/[executionId]/approve/+server.ts` now
  resolves the execution and Dapr instance through `workflowData` before raising
  the approval event through Dapr service invocation.
- `src/routes/api/workflows/executions/[executionId]/spec-diff/+server.ts` now
  loads the forked execution and its parent through `workflowData`; spec
  comparison remains route-local presentation shaping over application DTOs.
- `src/routes/api/workflows/executions/[executionId]/sessions/+server.ts` now
  scope-checks the execution through `workflowData.getExecutionById` and lists
  direct plus inherited rerun-lineage sessions through
  `workflowData.listExecutionSessions`. Ancestor traversal and session/project
  filtering are confined to the execution repository adapter.
- `src/routes/api/workflows/executions/[executionId]/logs/+server.ts` now loads
  the execution, persisted node logs, and session-backed agent events through
  `workflowData`. Node-log and session-event queries are confined to the
  execution repository adapter; route-local logic only normalizes response shape
  and extracts trace ids from the execution output payload.
- `src/routes/api/workflows/executions/[executionId]/artifacts/[artifactId]/diff/+server.ts`
  now scope-checks the execution and fetches the artifact through
  `workflowData.getWorkflowArtifactForExecution`; diff patch resolution remains
  route-local readback over the artifact DTO.
- `src/routes/api/workflows/executions/[executionId]/versions/+server.ts` now
  scope-checks the execution through `workflowData.getExecutionById` and derives
  source-bundle versions from `workflowData.listWorkflowArtifactsByExecutionId`.
  Promotion-gate evaluation remains route-local response shaping over execution
  and artifact DTOs.
- `src/routes/api/workflows/executions/[executionId]/versions/[artifactId]/promote/+server.ts`
  now scope-checks the execution and source-bundle artifact through
  `workflowData`, provisions the existing helper-pod command path as route-local
  orchestration, and records durable promotion metadata through
  `workflowData.updateWorkflowArtifactMetadata`.
- `src/routes/api/workflows/executions/[executionId]/workspace-files/+server.ts`
  and `src/routes/api/workflows/executions/[executionId]/workspace-content/+server.ts`
  now scope-check and resolve the execution's Dapr instance through
  `workflowData.getExecutionById`; JuiceFS/WebDAV access remains behind the
  existing workspace helper service boundary.
- `src/routes/api/workflows/executions/[executionId]/files/+server.ts` now
  scope-checks through `workflowData.getExecutionById` and loads the persisted
  output-file read model through `workflowData.listExecutionOutputFiles`.
  Session/file joins, live-sandbox selection, and CLI workspace detection are
  confined to the execution repository adapter.
- `src/routes/api/workflows/executions/[executionId]/metrics/+server.ts` now
  scope-checks through `workflowData.getExecutionById` and loads lineage-aware
  token aggregates through `workflowData.aggregateExecutionUsageMetrics`.
  The SQL aggregation over `session_events`/`sessions` is confined to the
  execution repository adapter; model pricing remains route-local response
  shaping.
- `src/routes/api/workflows/executions/[executionId]/code-checkpoints/+server.ts`
  now lists source-change checkpoints through
  `ApplicationWorkflowCodeCheckpointService`. The route keeps the existing
  `{ checkpoints }` response and generic 500 failure mapping but no longer
  imports the legacy checkpoint helper. The Postgres read is confined to
  `PostgresWorkflowCodeCheckpointStore.listForExecution`. The diff and restore
  routes now call `ApplicationWorkflowCodeCheckpointService.diffCheckpoint` and
  `restoreCheckpoint`; mixed DB/OpenShell/Dapr/Git behavior remains behind the
  documented `LegacyWorkflowCodeCheckpointWorkspacePort` adapter seam pending a
  deeper workspace-port split.
- `src/routes/api/workflows/executions/[executionId]/nats-stream/+server.ts`
  now delegates snapshot loading, cursor-based agent-event reads, session-event
  notifications, and terminal detection to
  `ApplicationWorkflowExecutionStreamService`. The route keeps only the legacy
  `/nats-stream` path and SSE response headers for client compatibility. The
  Postgres `LISTEN/NOTIFY` implementation is confined to
  `PostgresWorkflowSessionEventNotificationSource` in the Postgres adapter.
  Direct DB/Dapr/ClickHouse access in `src/lib/server/execution-read-model.ts`
  remains behind `LegacyWorkflowExecutionReadModelPort`; splitting that helper
  into narrower workflow-data, runtime-status, artifact, and trace ports remains
  the next read-model portability slice.
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
- `src/routes/api/workflows/[workflowId]/execute/+server.ts` is now a thin
  presentation adapter: it delegates workspace scope checks, trigger-data
  normalization, execution creation, validation, prewarm, Dapr scheduling,
  scheduler attachment, and start-failure marking to
  `ApplicationWorkflowExecutionControlService.executeWorkflow`, which reaches
  workflow-data and the canonical starter only through application ports.
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
  generation, or the trigger reconciler directly; the existing
  direct-DB/Kubernetes/GitHub backing reconciliation remains confined to the
  documented `LegacyWorkflowTriggerLifecyclePort` rollback seam.
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
- `src/routes/api/monitor/+server.ts` still queries the orchestrator first, but
  its database fallback now reads workflow execution summaries through
  workflow-data instead of importing `db`, Drizzle, or schema objects directly.
- The admin-gated routes `src/routes/api/metrics/aggregate/+server.ts`,
  `src/routes/api/v1/gitops/deployment-metadata/+server.ts`,
  `src/routes/api/v1/gitops/promotions/+server.ts`, and
  `src/routes/api/admin/pieces/[pieceName]/enable/+server.ts` now resolve
  platform-admin status through the workflow-data user profile port instead of
  querying `users.platform_role` directly in route code.
- `src/routes/api/prompt-presets/[id]/usages/+server.ts`,
  `src/routes/api/agent-skills/[id]/used-by/+server.ts`, and
  `src/routes/api/v1/vaults/[id]/usages/+server.ts` now read reverse-lookup
  usage models through workflow-data resource usage ports. Preset binding scans,
  skill attachment JSONB queries, and vault/session JSONB containment queries
  are confined to the Postgres resource-usage adapter.
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
  wrapped as a legacy adapter; teardown and internal dev-preview write/canonical
  id paths remain a dedicated lifecycle/internal slice.
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
- `src/routes/(admin)/admin/pieces/+page.server.ts` now reads provisioned and
  available piece enablement state through `workflowData.getAdminPiecesReadModel`
  and mutates the platform disable list through
  `workflowData.setAdminPieceEnabled`. Catalog, disabled-piece, workflow-usage,
  MCP-usage, and per-piece image status SQL is confined to the Postgres admin
  piece adapter. The remaining per-piece image build trigger still delegates to
  the existing `enablePiece` service path.
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
- `src/routes/api/agents/registry/+server.ts` now delegates the global Dapr
  registry browser read model to `ApplicationAgentRegistryBrowserService`.
  Registry team/store env parsing and Dapr state HTTP reads are confined to
  `DaprAgentRegistryStateReaderAdapter`; the service owns registry key
  normalization, agent metadata projection, and diagnostics for missing indexes
  or state entries.
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
  longer imports `src/lib/server/goals/repo.ts`. Repository resource
  materialization and best-effort pre-run mounting now delegate to
  `ApplicationSessionCommandService.materializeWorkflowSessionRepositories`, so
  the route no longer imports `src/lib/server/sessions/registry.ts` or
  `src/lib/server/sessions/repositories.ts`. Terminal per-run agent-host reaping
  now delegates to
  `ApplicationSessionCommandService.reapTerminatedWorkflowSessionRuntimeHosts`,
  so Kubernetes Sandbox deletion is behind the session sandbox-destroyer port
  instead of the route calling `deleteSandbox` directly. Swap-degraded audit
  events and initial workflow user messages now delegate to
  `ApplicationSessionCommandService`, so the route no longer imports
  `src/lib/server/sessions/events.ts`. Published-vs-ephemeral workflow session
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
  the session event-log port instead of importing the legacy session event
  helper directly.
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
  remaining `src/lib/server/goals/repo.ts` direct DB access belongs to the
  goal-loop driver/tick path and remains a later loop-storage adapter slice.
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
  CLI preview helper, Drizzle, or `$lib/server/db` directly. The existing
  `src/lib/server/sessions/cli-preview.ts` helper still owns DB-backed
  execution/session lookup, Kubernetes pod/provisioning calls, and low-level
  HTTP proxying behind `LegacyCliPreviewGatewayPort`; splitting those internals
  into narrower workflow-data, runtime, and proxy ports remains the next
  preview portability slice.
- `src/routes/api/workflows/executions/[executionId]/sandbox-preview/+server.ts`
  and
  `src/routes/api/workflows/executions/[executionId]/sandbox-preview/[previewId]/[...path]/+server.ts`
  now delegate retained OpenShell sandbox lookup, preview start/stop commands,
  runtime-preview page URL construction, proxy request forwarding, and response
  body/header rewriting to `ApplicationSandboxPreviewService`. The route family
  no longer imports the sandbox-preview helper, runtime-preview URL helper,
  OpenShell runtime client, Drizzle, or `$lib/server/db` directly. The existing
  DB-backed retained-sandbox lookup, workspace route lookup, and OpenShell
  runtime fetch remain behind `LegacySandboxPreviewGatewayPort`; splitting those
  internals into narrower workflow-data, workspace-route, and runtime proxy
  ports remains a later preview portability slice.
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
diff/restore now call `ApplicationWorkflowCodeCheckpointService` and leave the
mixed DB/OpenShell/Dapr/Git operations behind the documented
`LegacyWorkflowCodeCheckpointWorkspacePort` adapter seam.
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
runtime debug target routes, resources, and event-stream routes are also clean.
The session/execution CLI preview and OpenShell sandbox preview route families
are also presentation-clean; their remaining direct DB/Kubernetes/OpenShell
coupling is documented inside legacy preview gateway adapters.
The dashboard route is also clean.
The sandbox-delete route's session read is also clean, while its lifecycle and
Kubernetes/OpenShell deletion behavior intentionally remain in the route.
The broader BFF/control-plane still has route-level or service-level direct DB
imports outside that subset and remains the next migration area. Current
categories include:

- Lifecycle Controller internals under `src/lib/server/lifecycle/**`.
- goal-loop storage helpers under `src/lib/server/goals/**`, which still own
  drivable-goal claiming, usage accrual, idle-event metadata, and tick-reaper
  queries.
- session/runtime/workspace helpers under `src/lib/server/sessions/**`,
  `src/lib/server/openshell-sessions.ts`, `src/lib/server/sandbox-sessions.ts`,
  and related API routes.
- dev-preview helpers under `src/lib/server/workflows/dev-preview.ts`, which
  still own DB-backed preview session lookup/teardown and a local
  source-bundle persistence adapter pending a dedicated dev-preview slice.
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

export const meta = {
  name: 'lifecycle-plan-explore',
  description: 'Phase-1 exploration for the workflow/agent stop-terminate-purge implementation plan: benchmark cascade reuse surface, generic target resolution + DB/auth, runtime/orchestrator fixes + UI wiring',
  phases: [{ title: 'Explore' }],
}

const WFB = '/home/vpittamp/repos/PittampalliOrg/workflow-builder/main'
const STACKS = '/home/vpittamp/repos/PittampalliOrg/stacks/main'

const common = `Read-only exploration for an IMPLEMENTATION PLAN. workflow-builder repo: ${WFB}. stacks repo: ${STACKS}. We are generalizing the benchmark cancellation cascade into ONE target-agnostic "Lifecycle Controller" (stopDurableRun) and routing every user "stop" through it, plus fixing root-cause stale-state bugs. The design doc is ${WFB}/docs/workflow-lifecycle-termination.md (read it first for full context). Cite exact file:line and report ACTUAL code shapes (function signatures, params, return types, what each step does) so an implementer can reuse/extract without re-reading. Be concrete and high-signal; return GitHub-flavored markdown. Do NOT propose new code — just map what exists and how it can be reused/parameterized.`

const DIMENSIONS = [
  { key: 'benchmark-cascade-reuse', prompt: `${common}

GOAL: Map the benchmark cancellation cascade as the REFERENCE to generalize. Read ${WFB}/src/lib/server/benchmarks/service.ts and report exact signatures + behavior + the extraction boundary for:
- cancelBenchmarkRun (~1769), scheduleTerminalBenchmarkCleanup / scheduleBenchmarkRunTerminalCleanupByRunId (~1744), retryBenchmarkRunTerminalCleanupByRunId (~1660)
- cleanupBenchmarkDurableWorkflowCascade (~2518) — the core; document each step, its inputs, the per-target loop, the forceStatePurgeOnUnclosed escape hatch (~2822-2831)
- finalizeBenchmarkWorkflowExecutions (~2137)
- durable helpers: graceful cancel event (~2907/3081), terminateBenchmarkWorkflowInstance (~2953), terminateBenchmarkAgentRuntimeInstance (~3129), purge calls orchestrator DELETE ?recursive=true (~3011) + agent DELETE (~3179), wait-for-terminal polling, purgeBenchmarkDurableStateRows raw SQL (~3232)
- per-session app-id resolution: benchmarkAgentRuntimeCleanupRuntimeAppIds (~849), hostSandboxExecutionResourceTargets (~3494), deleteKubeResource (~3883)
- single-instance: terminateBenchmarkRunInstance (~6018), cleanupStalledBenchmarkInstanceWorkflows (~5683), and the cleanupConfirmed/409 fail-closed contract
Classify each piece as (A) GENERALIZABLE core [resolve tree → graceful → terminate → wait-terminal → purge → reap CRs → flip DB → confirm/retry] vs (B) BENCHMARK-SPECIFIC [resource leases, benchmark_run_instances rows, MLflow sync, summary recompute]. Propose the minimal seam to extract a target-agnostic stopDurableRun(target, {mode}) and what target-specific adapters each kind (workflowExecution/session/benchmarkRun/benchmarkInstance/evalRun) would supply.` },

  { key: 'generic-resolution-db-auth', prompt: `${common}

GOAL: Determine how to resolve a NON-benchmark target's durable tree, the DB terminal states to flip, the ID/sandbox derivation, and the auth/scope helpers.
1) CHILD TREE RESOLUTION for a workflowExecution / session: how to enumerate child session_workflow instances + their per-session app-ids + sandbox CR names. Read ${WFB}/src/lib/server/workflow-ops/index.ts (getWorkflowOpsDetail, buildRelationships ~1123, listAgentRuns ~644, candidateAgentRuntimes ~449, runWorkflowOperation ~1484, runAgentRunOperation ~1385), ${WFB}/src/lib/server/sessions/registry.ts (session fields), ${WFB}/src/lib/server/sessions/agent-workflow-host.ts (sessionHostAppId ~66-69, resolve target), ${WFB}/src/lib/server/sessions/runtime-target.ts if present. Document how to derive per-session app-id + Sandbox CR name from a sessionId / child_instance_id, and how workflow_agent_runs.daprInstanceId/agentWorkflowId + sessions.daprInstanceId/runtimeAppId/runtimeSandboxName/sandboxName carry the needed handles.
2) DB STATUS ENUMS + TERMINAL VALUES: read ${WFB}/src/lib/server/db/schema.ts and ${WFB}/src/lib/types/sessions.ts for workflow_executions.status, sessions.status, workflow_agent_runs.status, workflow_workspace_sessions.status, crawl4ai_jobs.state, benchmark_runs/benchmark_run_instances.status. State the exact terminal value the controller must set for each + any unique constraints on deterministic ids (uq_workflow_agent_runs_*).
3) AUTH + SCOPE: read ${WFB}/src/lib/server/workflows/project-scope.ts (isResourceInScope) and grep for requirePlatformAdmin / internal-auth / verifyInternalToken usage in routes. Report the exact helpers + how existing routes (e.g. workflows/executions/[id]/terminate, reminders/delete) apply them, so we can auth-gate /api/workflow-ops/* and scope the new stop routes.
4) Existing kube helpers: ${WFB}/src/lib/server/kube/client.ts deleteKubernetesSandbox (~928) signature + propagation.` },

  { key: 'runtime-orchestrator-ui-scripts', prompt: `${common}

GOAL: Map the runtime/orchestrator fixes, reaper scripts, and UI/api-client surfaces to re-point.
1) dapr-agent-py management surface: read ${WFB}/services/dapr-agent-py/src/main.py — exact route defs for /api/v2/agent-runs/{id}/{terminate,pause,resume} + DELETE purge (~7142-7325), the raise-event endpoint (~7439), _save_session_cancellation_request (~882), check_cancellation_for_instance (~2187), and the cancel-key MISMATCH (write session-cancel:{session_instance} vs read session-cancel:{agent_turn_instance_id=<session>__turn__N}, ~5253-5257). Pin the exact lines to change for the key fix.
2) claude-agent-py parity gap: read ${WFB}/services/claude-agent-py/src/main.py + session_workflow.py + session_config.py — what endpoints/handlers EXIST, where to add terminate/pause/resume/purge + cooperative cancel mirroring dapr-agent-py, and the control-event gap (CONTROL_EVENT_TYPES omits user.interrupt/session.terminate). Note the per-turn when_any timer (~239-250).
3) orchestrator fixes: read ${WFB}/services/workflow-orchestrator/app.py — _workflow_http_post (~611, add query-param forwarding for /purge recursive/force), purge_workflow (~3613), _idempotent_schedule (~886-978, where to terminate+purge a stuck non-terminal before reuse), and ${WFB}/services/workflow-orchestrator/activities/call_agent_service.py terminate_durable_runs_by_parent_execution (~298, fans out only to claude-code-agent — what replacing with per-session app-id fan-out needs).
4) sandbox 409-adopt: ${WFB}/services/sandbox-execution-api/src/app.py (~1371-1373) — what delete-and-recreate (or verify-ownership) needs; note dual-image build requirement for dapr-agent-py.
5) reaper scripts to productionize: ${WFB}/scripts/reconcile-stale-workflow-agent-runs.ts + ${WFB}/scripts/dev-purge-stale-workflows.ts — their shape + how a scheduled reaper (BFF internal route + stacks CronJob like CronJob-agent-runtime-idle-reaper) would call the logic. Also the stacks Sandbox-GC CronJob to mirror into workflow-builder ns (${STACKS} packages/base/manifests/openshell/CronJob-sandbox-gc.yaml) and the split retention Configurations to unify.
6) UI + api-client to re-point: list the Svelte components + handlers for session detail/list, workflow run detail, benchmark/eval run pages, admin instances page; and ${WFB}/src/lib/api-client.ts dead methods (workflows.terminateExecution ~265, orchestrator.terminate ~312). For each, name the current endpoint it calls and what the new vetted endpoint should be.` },
]

phase('Explore')

const reports = await parallel(
  DIMENSIONS.map((d) => () =>
    agent(d.prompt, { label: `explore:${d.key}`, phase: 'Explore', agentType: 'Explore' }).then((md) => ({ key: d.key, md }))
  )
)

return { reports: reports.filter(Boolean) }

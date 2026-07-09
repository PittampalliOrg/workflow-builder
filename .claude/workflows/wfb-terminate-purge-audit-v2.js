export const meta = {
  name: 'wfb-terminate-purge-audit-v2',
  description: 'Audit (free-text) how workflow-builder + stacks stop/terminate/purge workflows, agent sessions, benchmarks, sandboxes — fragmentation, stale-data risks, gaps. No schema.',
  phases: [{ title: 'Analyze' }],
}

const WFB = '/home/vpittamp/repos/PittampalliOrg/workflow-builder/main'
const STACKS = '/home/vpittamp/repos/PittampalliOrg/stacks/main'

const KNOWN = `KNOWN ORCHESTRATOR FACTS (already verified first-hand — do NOT re-derive these; build on them and find what your slice adds or contradicts):
- Orchestrator app.py exposes: POST /api/v2/workflows/{id}/terminate, DELETE /api/v2/workflows/{id} (purge; accepts force+recursive query params), POST .../pause, POST .../resume, POST .../events, POST /api/internal/workflow-ops/instances/{id}/reminders/delete (deletes only new-event-* actor reminders).
- terminate endpoint: HTTP POST to Dapr /v1.0/workflows/dapr/{id}/terminate via _workflow_http_post + a DaprWorkflowClient.terminate_workflow fallback; relies on Dapr "native parent-child cascade" for children; then calls terminate_durable_runs_by_parent_execution.
- CRITICAL: _workflow_http_post(instance_id, suffix) NEVER appends query params, so the purge endpoint's recursive/force flags are NOT forwarded to Dapr (Dapr default is recursive). force only triggers external child cleanup.
- CRITICAL: terminate_durable_runs_by_parent_execution (activities/call_agent_service.py) only fans out to the LEGACY app-id 'claude-code-agent' — it does NOT iterate per-session agent-sandbox app-ids running session_workflow.
- _idempotent_schedule purges TERMINAL instances before reuse, but returns a stuck-RUNNING/PENDING/SUSPENDED instance as "existing" (so a zombie never-terminal prior run blocks re-runs of the same deterministic id).
- _cleanup_stale_instances_on_startup is gated by CLEANUP_STALE_ON_STARTUP=true (default false), STALE_THRESHOLD_MINUTES=60; it terminates stale running instances.
- BFF /api/workflows/executions/[id]/terminate uses a 2s AbortSignal.timeout that swallows TimeoutError as null and proceeds to flip the DB row to 'cancelled' WITHOUT confirming the durable instance died; it never purges.`

const common = `You are auditing the PittampalliOrg workflow-builder system for how it STOPS, TERMINATES, CANCELS, and PURGES things. workflow-builder repo: ${WFB}. stacks (GitOps) repo: ${STACKS}. Architecture: SvelteKit BFF proxies to a Python Dapr workflow-orchestrator; durable/run dispatches a Dapr child workflow "session_workflow" onto per-session ephemeral agent-sandbox pods (each its own app-id). Dapr Workflow state lives in actor state store "workflowstatestore" (Postgres). Dapr control plane is 1.17.9. Read ACTUAL code and cite file:line. Report current behavior factually. Do NOT edit files.

${KNOWN}

REQUIRED OUTPUT FORMAT — return GitHub-flavored markdown with EXACTLY these sections (be specific, cite file:line):
## <subsystem name>
### Summary
(4-8 sentences: how this subsystem stops/terminates/cancels/purges today)
### Mechanisms
(bullet per distinct mechanism: name — entryPoint(file:line/route/UI) — method — does it [terminate durable instance? purge state? recurse to children? delete pods/CRs? clean DB rows?] — notable timeouts/races/error-swallowing)
### Stale / orphaned data risks
(bullets: concrete ways stale/corrupt/orphaned state can be left to break FUTURE runs)
### Gaps vs a single vetted method
(bullets: bugs, missing purge/recursion, divergence from other surfaces, missing user stop affordances)
### User entry points
(bullets: UI buttons/pages/API routes a USER can hit in this slice)
### Key files
(bullets: paths)
Keep it tight and high-signal. Aim for under ~250 lines.`

const DIMENSIONS = [
  { key: 'bff-session-stop', prompt: `${common}

SUBSYSTEM: BFF agent-session stop / interrupt / delete / archive path.
Read: ${WFB}/src/lib/server/sessions/registry.ts (deleteSession, archiveSession, updateSessionTitle, getSession), ${WFB}/src/lib/server/sessions/control.ts (raiseSessionEvent), ${WFB}/src/routes/api/v1/sessions/[id]/+server.ts (GET/PUT/DELETE/PATCH), ${WFB}/src/routes/api/v1/sessions/[id]/control/interrupt/+server.ts, ${WFB}/src/lib/server/sessions/spawn.ts, ${WFB}/src/routes/api/openshell/sessions/[id]/close/+server.ts, and grep sessions/* for terminate/stop/end-turn/autoTerminate.
Focus: How does a USER stop a running agent session? Distinguish interrupt (user.interrupt raise-event) vs DELETE (deleteSession) vs PATCH (archive). When a session is stopped/deleted, what happens to (a) the underlying Dapr session_workflow durable instance — is it terminated/purged at all?, (b) the per-session agent-sandbox pod / Sandbox CR, (c) the sessions row + session_events? Does deleteSession terminate the durable workflow or just delete DB rows (leaving the durable instance + pod alive)? Is there ANY "terminate session durable run" path from the session UI, or only interrupt?` },

  { key: 'agent-runtime-stop', prompt: `${common}

SUBSYSTEM: agent runtime (dapr-agent-py / claude-agent-py) mid-run stop semantics + the terminate-by-parent + agent-runs management endpoints.
Read: ${WFB}/services/dapr-agent-py/src/main.py (session_workflow registration; how it consumes external events like session.user_events / user.interrupt; autoTerminateAfterEndTurn; the empty-response circuit breaker), ${WFB}/services/dapr-agent-py/src/session_host_monitor.py, and grep services/dapr-agent-py/src for "terminate-by-parent", "api/runs/terminate", "/api/v2/agent-runs", raise_event, when_any, create_timer, NONTERMINAL_TIMEOUT_ACTION, user.interrupt. Then look at ${WFB}/services/claude-agent-py/ for the same (whole-loop-in-one-activity model).
Focus: Once a session_workflow runs on a sandbox pod, HOW can it be stopped early? Does the agent listen for a user.interrupt external event and halt, or does interrupt only affect the next turn? Is the only hard stop a Dapr terminate from outside? Confirm there is no in-workflow turn-timer (no when_any/create_timer) and the host-monitor default action is "warn" not "terminate". Does dapr-agent-py expose /api/v2/agent-runs/{id}/terminate|pause|resume|DELETE(purge) and /api/runs/terminate-by-parent (the orchestrator calls these)? Does claude-agent-py expose the same? When the orchestrator terminates the PARENT workflow, does the cross-app-id child session_workflow on the sandbox actually get cancelled, or keep running until end_turn?` },

  { key: 'benchmark-eval-cancel', prompt: `${common}

SUBSYSTEM: benchmark + evaluation run cancellation.
Read: ${WFB}/src/routes/api/benchmarks/runs/[runId]/cancel/+server.ts, ${WFB}/src/routes/api/benchmarks/runs/[runId]/instances/[instanceId]/terminate/+server.ts, ${WFB}/src/routes/api/benchmarks/runs/[runId]/instances/[instanceId]/+server.ts, ${WFB}/src/routes/api/evaluations/runs/[runId]/cancel/+server.ts, ${WFB}/src/lib/server/benchmarks/service.ts, ${WFB}/src/lib/server/benchmarks/dapr-workflow-capacity.ts, ${WFB}/src/lib/server/evaluations/service.ts. Also grep ${WFB}/services/swebench-coordinator (or services/*coordinator*) for cancel/terminate/cleanup/PipelineRun and Kueue workload.
Focus: How is a benchmark run cancelled, and an individual instance terminated? Does it terminate the underlying Dapr workflow + purge, delete K8s Jobs/Tekton TaskRuns/PipelineRuns, release Kueue workloads, and flip DB rows — and in what order? How does evaluation-run cancel differ? Are these CONSISTENT with the workflow-execution terminate path (do they reuse runWorkflowOperation / the orchestrator terminate endpoint) or are they separate divergent implementations? What stale data (lock rows, Kueue workloads, leftover pods, RUNNING DB rows) can a cancel leave behind?` },

  { key: 'sandbox-pod-lifecycle', prompt: `${common}

SUBSYSTEM: agent-sandbox pod / Sandbox CR (agents.x-k8s.io) / Kueue workload lifecycle + cleanup.
Read: ${WFB}/src/lib/server/agent-runtime-sandboxes.ts, ${WFB}/src/lib/server/sandboxes/provision.ts, ${WFB}/src/lib/server/kube/client.ts; grep wfb + stacks for "Sandbox", "agents.x-k8s.io", "selfReap"/"self-reap", autoTerminateAfterEndTurn, SandboxWarmPool, "agent-host-agent-session", Kueue Workload. In stacks look under ${STACKS}/packages for the agent-sandbox controller config, Kueue (ClusterQueue/LocalQueue/ResourceFlavor), warm pool, and any reaping/TTL/GC.
Focus: How is a per-session agent-sandbox pod created and how is it SUPPOSED to self-reap on session end (what triggers reap — autoTerminateAfterEndTurn? a controller? a TTL?)? Document the Sandbox-CR-respawn trap (deleting the pod is futile — the Sandbox CR recreates it; you must delete the CR). On a user-initiated terminate of a workflow/session, does ANY code delete the Sandbox CR, or is the pod left to self-reap (and what if the agent is stuck and never ends its turn)? How does the browser-use SandboxWarmPool differ? What orphaned pods/CRs/Kueue workloads can accumulate, and is there any garbage collection? Is there a documented kubectl recovery (delete sandboxes.agents.x-k8s.io)?` },

  { key: 'db-stale-data', prompt: `${common}

SUBSYSTEM: database stale/orphaned data lifecycle + deterministic instance-ID reuse hazards.
Read: ${WFB}/src/lib/server/db/schema.ts (focus: workflow_executions, sessions, session_events, workflow_agent_runs, workflow_workspace_sessions, crawl4ai_jobs/crawl4ai_cache, benchmark_run* tables — their status enums + which states are terminal). Grep wfb for child_instance_id construction (pattern like <exec>__<kind>__<node>__run__<index>), deterministic instance ids, "j_" crawl jobIds (sha256), and any reset/cleanup SQL in ${WFB}/scripts and ${WFB}/drizzle.
Focus: Which DB tables hold a "status" that can get STUCK non-terminal (running/pending/scheduled/active) when a run is killed or a pod dies (i.e. nothing flips them terminal)? What is the deterministic-instance-ID scheme for child session_workflow and crawl jobs, and what are the REUSE hazards — if a deterministic id's prior durable state was NOT purged, does re-running collide with / replay / get-blocked-by stale state? Which terminate paths fail to set terminal DB state (divergence between Dapr runtime status and DB status)? Is there ANY orphaned-row GC/retention? Enumerate the documented manual SQL resets (crawl4ai_jobs stuck rows, workflow_workspace_sessions revive, etc.) — these reveal where automated cleanup is missing.` },

  { key: 'stacks-dapr-retention', prompt: `${common}

SUBSYSTEM: stacks GitOps Dapr / state-store / retention / reaping configuration.
Search ${STACKS} (esp. packages/components/workloads/workflow-builder and any Dapr Component/Configuration YAML). Grep for: workflowstatestore, actorStateStore, Dapr Component state stores, dapr-agent-py-statestore, "agent-workflow" component, Configuration openshell-sandbox-dapr, retention, ttlInSeconds/TTL, reminder, scheduler, placement, CronJob, Kueue (ClusterQueue/LocalQueue/ResourceFlavor), agent-sandbox controller, Sandbox reaping/GC, "dapr scheduler".
Focus: How is the Dapr workflow actor state store configured (Postgres; any retention/cleanup/TTL; reminder/actor partitioning)? Is there ANY automated retention/TTL/GC on workflow durable state, on Sandbox CRs, or on Kueue workloads? Is there a CronJob or controller that purges terminal workflow instances or orphaned sandboxes? What Dapr scheduler/placement config affects reminders/timers surviving restarts (relevant to orphaned new-event reminders)? Note that Dapr 1.17 purge cleans up associated reminders and adds purge-force — is the cluster positioned to use that? Identify config-level gaps that let stale durable state or orphaned pods accumulate, and any existing knobs (CLEANUP_STALE_ON_STARTUP etc.) and whether they're set.` },

  { key: 'ui-user-surfaces', prompt: `${common}

SUBSYSTEM: front-end USER-facing stop/terminate/cancel/delete affordances (the inventory of "user functionality" that must route through the vetted method).
Search ${WFB}/src/lib/components and ${WFB}/src/routes (Svelte). Grep for handlers/fetches hitting: /terminate, /cancel, /control/interrupt, session DELETE, /purge, and button text "Terminate"/"Stop"/"Cancel"/"Interrupt"/"Delete"/"End session"/"End turn"/"Kill". Look at the workflow run-detail/ops pages, the sessions UI, benchmarks UI, evaluations UI, and any admin/workflow-ops page that calls runWorkflowOperation/runAgentRunOperation.
Focus: Enumerate EVERY user-facing affordance to stop/terminate/cancel/delete: a workflow run, an agent session, a benchmark run/instance, an evaluation, a crawl. For each: which API endpoint it hits and whether that maps to a durable terminate, a durable terminate+purge, a mere DB flip, an interrupt-only, a pod/CR delete, or nothing. Call out INCONSISTENCIES (different surfaces using different endpoints/semantics for the same conceptual "stop") and user actions that LACK any stop affordance (e.g. can a user terminate a running session's durable run from the session page? stop a stuck crawl? purge from the UI?). This is the map of what must be unified onto one vetted method.` },

  { key: 'bff-workflow-terminate-deep', prompt: `${common}

SUBSYSTEM: BFF workflow-execution terminate/purge/rerun glue + the workflow-ops admin operations (cross-check the known facts and go deeper on purge wiring).
Read: ${WFB}/src/routes/api/workflows/executions/[executionId]/terminate/+server.ts, ${WFB}/src/lib/server/workflow-ops/index.ts (runWorkflowOperation, runAgentRunOperation, deleteWorkflowActorReminders), and find which routes call runWorkflowOperation('purge'|'terminate') and runAgentRunOperation — grep src/routes for runWorkflowOperation, runAgentRunOperation, workflow-ops. Also ${WFB}/src/routes/api/orchestrator/workflows/[id]/+server.ts.
Focus: Map the FULL set of BFF→orchestrator lifecycle operations available (terminate/pause/resume/purge/rerun/event/reminders-delete) and which are exposed to USERS vs admin-only vs not wired at all. Specifically: is there ANY user/admin route that calls 'purge' (DELETE /api/v2/workflows/{id})? Does the user-facing execution terminate route (the 2s-timeout one) differ from the workflow-ops 'terminate' operation (5s timeout, via orchestratorJson)? Are there TWO different terminate code paths for the same workflow? Does anything ever purge a user-cancelled execution's durable state, or does terminated state accumulate forever in workflowstatestore? Note the force/recursive query params are passed by runWorkflowOperation purge but dropped by the orchestrator's _workflow_http_post.` },

  { key: 'spawn-id-scheme', prompt: `${common}

SUBSYSTEM: deterministic instance-ID + sandbox naming scheme across spawn paths (the root of stale-state-on-reuse).
Read: ${WFB}/services/workflow-orchestrator/workflows/sw_workflow.py (how child session_workflow instance_id is built — the child_instance_id = <exec>__<kind>__<node>__run__<index> pattern), ${WFB}/services/workflow-orchestrator/activities/spawn_session.py, ${WFB}/src/routes/api/internal/sessions/ensure-for-workflow/+server.ts, ${WFB}/src/lib/server/sessions/spawn.ts. Grep for instance_id construction, deterministic, child_instance_id, sandboxName, _safe_label_value.
Focus: Document every deterministic id / name used for a durable run or sandbox (workflow execution instance id, child session_workflow instance id, direct-session instance id, sandbox pod/CR name, crawl jobId). For each, is it deterministic (reused across reruns of the same node) or random? Where reused: what guarantees the PRIOR durable instance/sandbox was purged/reaped before reuse (vs. the idempotent-schedule returning a stuck zombie, or a Sandbox CR respawning)? This pins down exactly where "stale/corrupt data from a prior run breaks the next run" originates and what the vetted reset must purge.` },
]

phase('Analyze')

const reports = await parallel(
  DIMENSIONS.map((d) => () =>
    agent(d.prompt, { label: `audit:${d.key}`, phase: 'Analyze' }).then((md) => ({ key: d.key, md }))
  )
)

return { reports: reports.filter(Boolean) }

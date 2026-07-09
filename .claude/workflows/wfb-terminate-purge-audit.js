export const meta = {
  name: 'wfb-terminate-purge-audit',
  description: 'Audit how workflow-builder + stacks currently stop/terminate/purge workflows, agent sessions, benchmarks, and sandboxes — find fragmentation, stale-data risks, and gaps',
  phases: [
    { title: 'Analyze' },
  ],
}

const FINDING_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    subsystem: { type: 'string' },
    summary: { type: 'string', description: '3-6 sentence overview of how this subsystem currently handles stop/terminate/cancel/purge' },
    mechanisms: {
      type: 'array',
      description: 'Each distinct stop/terminate/cancel/purge mechanism found',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          name: { type: 'string' },
          entryPoint: { type: 'string', description: 'file:line, API route, or UI component' },
          method: { type: 'string', description: 'e.g. Dapr terminate API / DB status flip only / interrupt control event / pod delete / purge' },
          terminatesDurableInstance: { type: 'boolean', description: 'does it call Dapr terminate on the durable workflow instance?' },
          purgesDurableState: { type: 'boolean', description: 'does it call Dapr purge to remove instance state/history?' },
          recursiveToChildren: { type: 'string', description: 'yes / no / unknown — does it handle child/session/turn sub-workflows?' },
          cleansUpPods: { type: 'boolean' },
          cleansUpDbRows: { type: 'boolean' },
          notes: { type: 'string', description: 'timeouts, error-swallowing, races, ordering, idempotency, anything notable' },
        },
        required: ['name', 'entryPoint', 'method', 'terminatesDurableInstance', 'purgesDurableState', 'recursiveToChildren', 'cleansUpPods', 'cleansUpDbRows', 'notes'],
      },
    },
    staleDataRisks: { type: 'array', items: { type: 'string' }, description: 'concrete ways stale/corrupt/orphaned data can be left behind to break future runs' },
    gaps: { type: 'array', items: { type: 'string' }, description: 'bugs, missing recursion, missing purge, races, divergence from a single vetted method, missing user stop affordances' },
    userEntryPoints: { type: 'array', items: { type: 'string' }, description: 'UI buttons / pages / API routes a USER can hit to stop something in this subsystem' },
    keyFiles: { type: 'array', items: { type: 'string' }, description: 'absolute or repo-relative paths central to this subsystem' },
  },
  required: ['subsystem', 'summary', 'mechanisms', 'staleDataRisks', 'gaps', 'userEntryPoints', 'keyFiles'],
}

const WFB = '/home/vpittamp/repos/PittampalliOrg/workflow-builder/main'
const STACKS = '/home/vpittamp/repos/PittampalliOrg/stacks/main'

const common = `You are auditing the PittampalliOrg workflow-builder system for how it STOPS, TERMINATES, CANCELS, and PURGES things. The workflow-builder repo is at ${WFB} and the stacks (GitOps) repo is at ${STACKS}. Architecture context: SvelteKit BFF (port 3000) proxies to a Python Dapr workflow-orchestrator; durable/run dispatches a Dapr child workflow "session_workflow" onto per-session ephemeral agent-sandbox pods. Dapr Workflow state lives in the actor state store "workflowstatestore" (Postgres). Lifecycle rule: terminate then purge; only COMPLETED/FAILED/TERMINATED instances can be purged; terminate/purge are recursive to child workflows. Read the ACTUAL code — cite file:line. Report current behavior factually, not what you'd wish. Do not edit any files.`

const DIMENSIONS = [
  {
    key: 'bff-workflow-terminate',
    prompt: `${common}

SUBSYSTEM: BFF workflow-execution termination path.
Read and analyze: ${WFB}/src/routes/api/workflows/executions/[executionId]/terminate/+server.ts, ${WFB}/src/lib/server/workflow-ops/index.ts, ${WFB}/src/lib/server/dapr-client.ts, ${WFB}/src/routes/api/orchestrator/workflows/[id]/+server.ts, and any other BFF route that terminates/cancels a workflow execution.
Determine: How does the BFF terminate a running workflow execution? What orchestrator endpoint does it call? Does it ALSO purge durable state, or only terminate + flip the DB row to 'cancelled'? How does it handle the 2-second AbortSignal timeout (note it swallows TimeoutError as null and proceeds — what are the consequences for the durable instance vs the DB row)? Does it terminate child session_workflow instances? What happens to workflow_agent_runs rows? Is there any retry/idempotency? Capture the exact request shape sent to the orchestrator.`,
  },
  {
    key: 'bff-session-stop',
    prompt: `${common}

SUBSYSTEM: BFF agent-session stop / interrupt / delete path.
Read and analyze: ${WFB}/src/routes/api/v1/sessions/[id]/+server.ts, ${WFB}/src/routes/api/v1/sessions/[id]/control/interrupt/+server.ts, ${WFB}/src/lib/server/sessions/registry.ts, ${WFB}/src/lib/server/sessions/events.ts, ${WFB}/src/lib/server/sessions/spawn.ts, ${WFB}/src/lib/server/sessions/runtime-config.ts, ${WFB}/src/routes/api/openshell/sessions/[id]/close/+server.ts.
Determine: How does a USER stop a running agent session? Distinguish interrupt (pause current turn) vs terminate (kill the run) vs delete (remove the session). When a session is stopped, what happens to (a) the underlying Dapr session_workflow durable instance, (b) the per-session agent-sandbox pod / Sandbox CR, (c) the sessions DB row + session_events? Is there a single "terminate session" path or several? Does any path purge durable state? Is there a DELETE handler and what does it actually clean up?`,
  },
  {
    key: 'orchestrator-terminate-purge',
    prompt: `${common}

SUBSYSTEM: workflow-orchestrator terminate/purge internals (Python).
Read and analyze: ${WFB}/services/workflow-orchestrator/app.py (find the terminate, purge, and status endpoints — likely /api/v2/workflows/...), ${WFB}/services/workflow-orchestrator/workflows/sw_workflow.py, ${WFB}/services/workflow-orchestrator/activities/__init__.py, and grep the whole services/workflow-orchestrator tree for terminate, purge, _cleanup_stale_instances_on_startup, DaprWorkflowClient, terminate_workflow, purge_workflow, STALE_THRESHOLD.
Determine: What does the orchestrator's terminate endpoint actually do (terminate only? terminate+purge? recursive=?)? Is there a purge endpoint exposed and is it wired to any user action? How does _cleanup_stale_instances_on_startup work (threshold, what it terminates/purges, whether it purges or just flips DB)? Does the orchestrator use the DaprWorkflowClient terminate_workflow/purge_workflow with the recursive flag? How does it handle terminating instances that belong to a different app-id (per-session sandbox app-ids)? Are there idempotent-purge-on-schedule paths? Capture exact Python signatures + line numbers.`,
  },
  {
    key: 'agent-runtime-stop',
    prompt: `${common}

SUBSYSTEM: agent runtime (dapr-agent-py / claude-agent-py) mid-run stop semantics.
Read and analyze: ${WFB}/services/dapr-agent-py/src/main.py (the session_workflow registration, call_llm, autoTerminateAfterEndTurn, the empty-response circuit breaker), ${WFB}/services/dapr-agent-py/src/session_host_monitor.py, ${WFB}/services/dapr-agent-py/src/dependency_guard.py, and the equivalent in ${WFB}/services/claude-agent-py/. Grep both for terminate, raise_event, interrupt, when_any, create_timer, autoTerminate, host_monitor, NONTERMINAL_TIMEOUT_ACTION.
Determine: Once a session_workflow is running on a sandbox pod, HOW can it be stopped early? Is there an interrupt/raise-event path the agent listens to, or is the only stop a Dapr terminate from outside? Confirm the in-workflow session-turn timer was removed (no when_any/create_timer) and that the host-monitor default action is "warn" not "terminate". What is the empty-response circuit breaker and what does it raise? When the orchestrator terminates the parent, does the child session_workflow on the sandbox pod actually get cancelled, or does it keep running until end_turn? Does claude-agent-py (whole-loop-in-one-activity) differ from dapr-agent-py (per-activity loop) in stoppability?`,
  },
  {
    key: 'benchmark-eval-cancel',
    prompt: `${common}

SUBSYSTEM: benchmark + evaluation run cancellation.
Read and analyze: ${WFB}/src/routes/api/benchmarks/runs/[runId]/cancel/+server.ts, ${WFB}/src/routes/api/benchmarks/runs/[runId]/instances/[instanceId]/terminate/+server.ts, ${WFB}/src/routes/api/benchmarks/runs/[runId]/instances/[instanceId]/+server.ts, ${WFB}/src/routes/api/evaluations/runs/[runId]/cancel/+server.ts, ${WFB}/src/lib/server/benchmarks/service.ts, ${WFB}/src/lib/server/benchmarks/dapr-workflow-capacity.ts, ${WFB}/src/lib/server/evaluations/service.ts. Also grep the swebench-coordinator service for cancel/terminate/cleanup and Tekton PipelineRun cancellation.
Determine: How is a benchmark run and an individual benchmark instance cancelled? Does it terminate the underlying Dapr workflow + purge, delete K8s Jobs/TaskRuns, release Kueue workloads, and flip DB rows — and in what order? How does evaluation-run cancel differ? Are these consistent with the workflow-execution terminate path or a separate divergent implementation? What stale data (lock rows, Kueue workloads, leftover pods, RUNNING DB rows) can a cancel leave behind?`,
  },
  {
    key: 'sandbox-pod-lifecycle',
    prompt: `${common}

SUBSYSTEM: agent-sandbox pod / Sandbox CR / Kueue lifecycle + cleanup.
Read and analyze: ${WFB}/src/lib/server/agent-runtime-sandboxes.ts, ${WFB}/src/lib/server/sandboxes/provision.ts, ${WFB}/src/lib/server/kube/client.ts, and grep wfb + stacks for "Sandbox" (agents.x-k8s.io), "self-reap"/"selfReap", "autoTerminateAfterEndTurn", SandboxWarmPool, "workloads" (Kueue), "agent-host-agent-session". In stacks look under ${STACKS}/packages for agent-sandbox controller config, Kueue config, and any reaping/TTL.
Determine: How is a per-session agent-sandbox pod created and how is it supposed to self-reap on session end? Document the Sandbox-CR-respawn trap (deleting the pod is futile; the CR recreates it — you must delete the CR). On a user-initiated terminate, does anything actually delete the Sandbox CR, or is the pod left to self-reap (and what if it never does)? How does the browser-use warm pool differ? What orphaned pods / CRs / Kueue workloads can accumulate, and is there any GC?`,
  },
  {
    key: 'db-stale-data',
    prompt: `${common}

SUBSYSTEM: database stale/orphaned data lifecycle + deterministic instance-ID reuse.
Read and analyze: ${WFB}/src/lib/server/db/schema.ts (focus on workflow_executions, sessions, session_events, workflow_agent_runs, workflow_workspace_sessions, crawl4ai_jobs/cache, benchmark_run* tables — their status enums and terminal states). Grep wfb for child_instance_id construction (e.g. <exec>__<kind>__<node>__run__<index>), deterministic instance IDs, j_<sha256...> crawl jobIds, and any reset/cleanup SQL in scripts/ or drizzle/.
Determine: Which DB tables hold a "status" that can get stuck non-terminal (running/pending/scheduled/active) when a run is killed or a pod dies? What is the deterministic-instance-ID scheme for child session_workflow and crawl jobs, and what are the REUSE hazards — i.e. if a deterministic ID's prior durable state was not purged, does re-running collide with or replay stale state? Where does the system rely on terminal DB state that the terminate paths might not set? Is there any orphaned-row GC? What manual SQL resets are documented (crawl4ai_jobs stuck rows, workflow_workspace_sessions revive, etc.)?`,
  },
  {
    key: 'stacks-dapr-retention',
    prompt: `${common}

SUBSYSTEM: stacks GitOps Dapr/state-store/retention/reaping configuration.
Search ${STACKS} (especially packages/components/workloads/workflow-builder and any dapr Component/Configuration YAML). Grep for: workflowstatestore, actorStateStore, "Component" Dapr state stores, dapr-agent-py-statestore, agent-workflow component, Configuration (openshell-sandbox-dapr), retention, TTL/ttlInSeconds, reminder, scheduler, CronJob, Kueue (ClusterQueue/LocalQueue/ResourceFlavor), agent-sandbox controller, Sandbox reaping/GC.
Determine: How is the Dapr workflow actor state store configured (Postgres, any retention/cleanup, reminder partitioning)? Is there ANY automated retention/TTL/GC on workflow durable state, on Sandbox CRs, or on Kueue workloads? Is there a CronJob or controller that purges terminal workflow instances or orphaned sandboxes? What is configured for the Dapr scheduler/placement that affects reminders/timers surviving restarts? Identify config-level gaps that let stale durable state or orphaned pods accumulate.`,
  },
  {
    key: 'ui-user-surfaces',
    prompt: `${common}

SUBSYSTEM: front-end USER-facing stop/terminate/cancel/delete affordances.
Search ${WFB}/src/lib/components and ${WFB}/src/routes (Svelte pages/components). Grep for buttons/handlers calling: /terminate, /cancel, /control/interrupt, session DELETE, "Terminate", "Stop", "Cancel", "Interrupt", "Delete", "End session", "End turn". Look at workflow run-detail pages, the sessions UI, benchmarks UI, evaluations UI.
Determine: Enumerate EVERY user-facing affordance to stop/terminate/cancel/delete a workflow run, an agent session, a benchmark run/instance, or an evaluation. For each, which API endpoint does it hit and does it map to a durable terminate, a mere DB flip, an interrupt, or nothing? Identify INCONSISTENCIES (different surfaces using different endpoints/semantics for the same conceptual "stop"), and identify user actions that LACK any stop affordance entirely (e.g. can a user stop a running session from the session page? a stuck workflow? a crawl?). This maps "what user functionality exists today" so we can later route it all through one vetted method.`,
  },
]

phase('Analyze')

const findings = await parallel(
  DIMENSIONS.map((d) => () =>
    agent(d.prompt, { label: `audit:${d.key}`, phase: 'Analyze', schema: FINDING_SCHEMA })
  )
)

return { findings: findings.filter(Boolean) }

export const meta = {
  name: 'cancellation-docs-survey',
  description: 'Survey workflow-builder + stacks repos and shared-skills for cancellation/dispatch docs to update or delete, given the landed architecture',
  phases: [{ title: 'Survey', detail: 'parallel: workflow-builder docs, stacks docs, shared-skills' }],
}

const WFB = '/home/vpittamp/repos/PittampalliOrg/workflow-builder/main'
const STACKS = '/home/vpittamp/repos/PittampalliOrg/stacks/main'
const SKILLS = '/home/vpittamp/repos/vpittamp/nixos-config/main/shared-skills'

// The ACCURATE landed architecture the docs must reflect.
const TRUTH =
  `LANDED ARCHITECTURE (ground truth — docs must match this, correct anything that contradicts it):\n` +
  `1. durable/run dispatch KEEPS the cross-app Dapr sub-orchestration: the orchestrator's sw_workflow.py runs ` +
  `ctx.call_child_workflow("session_workflow", app_id=<per-session agent app-id>) — a child workflow on a SEPARATE per-session task hub. This is the PROVEN, CURRENT mechanism.\n` +
  `2. Fire-and-forget + poll dispatch (a BFF/activity start + status-poll loop replacing call_child_workflow) was TRIED in PRs #74/#75 and ABANDONED/REVERTED in #76 because: per-session Kueue sandboxes aren't Dapr-service-invokable (no <appid>-dapr service; call_child_workflow routes via PLACEMENT not DNS); a start-ready cap broke SWE-bench; and the agent's first turn (delivered via call_child_workflow input.initialEvents / a raised session.user_events) did NOT fire under /internal/sessions/spawn (StartInstance) → "Inference stalled: no session progress for 900s" → empty patch. So fire-and-poll is NOT a drop-in and was dropped. call_child_workflow is the right dispatch.\n` +
  `3. The cross-app STOP WEDGE (a durable/run parent hangs RUNNING awaiting a cross-app child that Dapr's task-hub-bounded recursive terminate can't reach) is solved BFF-side, NOT by changing dispatch: the Lifecycle Controller's confirmDurableStop force-finalizes the wedged parent (force-delete its durable state rows = the mode:"reset" mechanism) after a grace, treating it as DB-state cleanup since the cascade already terminated the agent child. PR #77 introduced it; #78 hardened the gate to require POSITIVE evidence (parent live currentNodeId = a durable/run node whose child session is DB-terminated) + fixed a state-row substring over-delete (GAP-4) + stop-intent retry (GAP-3); #79 closed the LOW items (reaper skips active-coordinator-owned execs, session stop route 409 coordinator_owned, null-linkage fan-out safety, retired the orphan /terminate route, interrupt 503-vs-409, session-detail UI parity).\n` +
  `4. The Lifecycle Controller (workflow-builder src/lib/server/lifecycle/{index,cascade,resolvers,reaper,ownership}.ts) is the SSOT for stop/terminate/purge: modes interrupt|terminate|purge|reset; request/confirm = HTTP 202 "stopping" then confirmed; the lifecycle-terminal-reaper + workflow-builder-sandbox-gc CronJobs (stacks) + unified Dapr stateRetentionPolicy=168h are the GitOps safety nets. Benchmark/eval RUN cancels (coordinator-owned) cascade through the same stopDurableRun(purge).\n` +
  `5. Already-retired earlier mechanisms (should NOT be described as current anywhere): the per-agent AgentRuntime CRD + Kopf agent-runtime-controller (replaced by per-session kubernetes-sigs/agent-sandbox + Kueue); the in-workflow session-turn when_any([child,timer]) cutoff (removed commit 72154581 — replaced by the out-of-band host-monitor + the Lifecycle Controller).`

phase('Survey')

const reports = await parallel([
  () => agent(
    `Survey the workflow-builder repo docs for cancellation/lifecycle/durable-run-dispatch content. ${TRUTH}\n\n` +
    `Read ${WFB}/CLAUDE.md and ${WFB}/docs/*.md (especially workflow-lifecycle-termination.md, mcp-agent-workflows.md, durable-session-runtime-contract.md, agent-runtime-comparison.md, callable-agents.md). ` +
    `Report, with file + section/line refs: (a) where the durable/run dispatch + the Stop/terminate/cancellation lifecycle are documented and whether each matches the LANDED ARCHITECTURE above; ` +
    `(b) any statement that is now STALE or contradicts ground truth (e.g. describes the wedge as unsolved, describes fire-and-poll as current, references retired AgentRuntime CRD/Kopf/session-turn-timer, or out-of-date Stop behavior) — quote it; ` +
    `(c) what should be ADDED to record the current architecture + the fire-and-poll lesson + the #77/#78/#79 cancellation work. ` +
    `Be specific enough that an editor can act. Read only.`,
    { label: 'survey:wfb', phase: 'Survey' },
  ),
  () => agent(
    `Survey the stacks repo for docs/manifests-with-doc-comments that describe the workflow-builder cancellation/lifecycle/durable-run system. ${TRUTH}\n\n` +
    `Search ${STACKS} (READMEs, docs/, and the workflow-builder workload manifests + the lifecycle GitOps safety nets: lifecycle-terminal-reaper CronJob, workflow-builder-sandbox-gc CronJob, the Dapr Configuration stateRetentionPolicy, any phase0-lifecycle runbooks). ` +
    `Report, with file refs: (a) where cancellation/lifecycle/dispatch is documented or commented; (b) anything STALE vs ground truth (old terminate/purge runbooks, references to retired AgentRuntime CRD/Kopf controller, manual SQL cleanup that the reaper/GC now own, fire-and-poll mentions); (c) what to add/update to reflect the landed architecture + the CronJob/retention safety nets. Read only; do NOT modify anything.`,
    { label: 'survey:stacks', phase: 'Survey' },
  ),
  () => agent(
    `Survey the shared-skills directory ${SKILLS} (skills: dapr-agents-workflow, talos-clusters, evaluations, cluster-desired-state, ryzen-spoke-bootstrap, gitops, skaffold-dev-loop, workflow-builder). ${TRUTH}\n\n` +
    `For EACH skill, read its SKILL.md (and any bundled files) and report, with file refs: (a) whether it touches workflow cancellation/stop/terminate, durable/run dispatch (call_child_workflow / cross-app sub-orchestration), the Lifecycle Controller, benchmark/eval cancellation, or the Dapr-workflow architecture; ` +
    `(b) which skills SHOULD carry the cancellation/dispatch knowledge (likely workflow-builder, evaluations, dapr-agents-workflow, gitops) and what specifically each should say; ` +
    `(c) any STALE content contradicting ground truth (fire-and-poll as current, wedge unsolved, retired AgentRuntime CRD/Kopf/session-turn-timer, old Stop behavior) — quote it. ` +
    `Rank which skills most need updating. Read only.`,
    { label: 'survey:skills', phase: 'Survey' },
  ),
])

const labels = ['WORKFLOW-BUILDER REPO', 'STACKS REPO', 'SHARED-SKILLS']
return { report: reports.map((r, i) => `# ${labels[i]}\n\n${r || '(no result)'}`).join('\n\n---\n\n') }

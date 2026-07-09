export const meta = {
  name: 'durability-evaluation',
  description: 'Evaluate long-running agent session durability/resume across WFB Dapr-agent + CLI runtimes and the K8s/Dapr/Postgres substrate',
  phases: [
    { title: 'Investigate', detail: 'parallel durability dimensions: dapr-agent-py, claude/adk, CLI family, goal loop, infra substrate, session-killers' },
    { title: 'Verify', detail: 'adversarially verify each CRITICAL/HIGH durability gap against live code' },
  ],
}

const WFB = '/home/vpittamp/repos/PittampalliOrg/workflow-builder/main'
const STACKS = '/home/vpittamp/repos/PittampalliOrg/stacks/main'

const FINDINGS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['dimension', 'durabilityModel', 'implementationStatus', 'whatSurvives', 'gaps', 'citations'],
  properties: {
    dimension: { type: 'string' },
    durabilityModel: { type: 'string', description: 'Concise: where state lives, granularity, what is the durable record vs ephemeral' },
    implementationStatus: { type: 'string', enum: ['implemented', 'partial', 'prototype', 'absent', 'mixed'], description: 'Is the durability/resume capability actually live in code+manifests at HEAD?' },
    whatSurvives: {
      type: 'array',
      description: 'For each disruption type, does the run survive / how much is restorable',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['disruption', 'survives', 'detail'],
        properties: {
          disruption: { type: 'string', description: 'e.g. agent pod death mid-turn, workflow-worker restart, BFF restart, node failure, image-pin rollout, Postgres restart, placement-server restart' },
          survives: { type: 'string', enum: ['full', 'partial', 'none', 'unknown'] },
          detail: { type: 'string', description: 'what is restored vs lost, with file:line or manifest evidence' },
        },
      },
    },
    gaps: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['title', 'severity', 'evidence', 'multiHourImpact', 'enhancement'],
        properties: {
          title: { type: 'string' },
          severity: { type: 'string', enum: ['critical', 'high', 'medium', 'low'] },
          evidence: { type: 'string', description: 'file:line or manifest path proving the gap exists at HEAD' },
          multiHourImpact: { type: 'string', description: 'why it matters specifically for an hours-long run that gets disrupted' },
          enhancement: { type: 'string', description: 'concrete fix/enhancement to close it' },
        },
      },
    },
    docDrift: { type: 'array', items: { type: 'string' }, description: 'where the SSOT docs disagree with live code at HEAD' },
    citations: { type: 'array', items: { type: 'string' } },
  },
}

const VERDICT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['gapTitle', 'verdict', 'reasoning', 'evidence'],
  properties: {
    gapTitle: { type: 'string' },
    verdict: { type: 'string', enum: ['confirmed', 'refuted', 'partial', 'uncertain'] },
    reasoning: { type: 'string' },
    evidence: { type: 'string', description: 'file:line or manifest content that confirms or refutes' },
    correctedSeverity: { type: 'string', enum: ['critical', 'high', 'medium', 'low', 'non-issue'] },
  },
}

const base = `You are auditing DURABILITY of long-running (multi-HOUR) agent sessions in the workflow-builder system. The user wants: if an hours-long agent run is DISRUPTED, restore a LARGE PORTION instead of starting over. Repos: workflow-builder at ${WFB}, stacks (K8s/GitOps) at ${STACKS}. HEAD of workflow-builder is commit efdc3971; the docs in ${WFB}/docs/ were written 2026-06-07..06-11 and EXPLICITLY say "re-verify before editing" — so VERIFY every claim against live code/manifests, do not just trust the doc. Read actual files; cite file:line or manifest paths. Focus on: what is the DURABLE RECORD, at what GRANULARITY, and what survives each disruption type. Be concrete and skeptical. Ignore node_modules/ and target/ dirs.`

const DIMENSIONS = [
  {
    key: 'dapr-agent-py',
    prompt: `${base}

DIMENSION: dapr-agent-py per-ACTIVITY durability (the strongest runtime).
Read ${WFB}/services/dapr-agent-py/src/ — especially main.py (session_workflow ~5005, agent_workflow ~3779, call_llm activity ~1844, run_tool ~1950, save_tool_results ~1964, WorkflowRetryPolicy max_attempts=8 ~5897, circuit breaker) and compaction/ (engine.py maybe_compact, tokens.py). Verify: (1) each LLM turn + tool call is an independently-checkpointed Dapr activity; (2) messages persist in the dapr-agent-py-statestore actor store; (3) the 16 MiB gRPC payload ceiling + how compaction/Files-offload handles state growth over an HOURS-long run (does entry.messages grow unbounded? what happens at the ceiling?); (4) what survives agent pod death mid-turn, workflow-worker restart, and node failure. For a multi-hour run with hundreds of turns, is there a state-size cliff? Report durabilityModel, implementationStatus, whatSurvives, gaps (esp. unbounded state growth / 16MiB cliff / compaction correctness on replay).`,
  },
  {
    key: 'claude-adk-agent-py',
    prompt: `${base}

DIMENSION: claude-agent-py + adk-agent-py per-TURN durability (the weaker runtimes).
Read ${WFB}/services/claude-agent-py/src/ (session_workflow.py ~228-250 the single call_activity per turn + when_any turn timer ~80,240, RetryPolicy max_attempts=3 ~14-19; claude_sdk_runner.py ~596,604-613,666,679-684 the whole query() drained in ONE activity) and ${WFB}/services/adk-agent-py/src/. Verify: (1) the ENTIRE LLM+tool loop runs inside one opaque activity per turn; (2) a mid-turn crash re-runs query() from the prompt with NO durable record of partial tool results; (3) the 15-min per-turn timer + 3 retries; (4) where does conversation history persist between turns and does it survive pod death/worker restart? For a multi-HOUR single long turn (e.g. a big SWE task), what exactly is lost on disruption? Report durabilityModel, implementationStatus, whatSurvives, gaps.`,
  },
  {
    key: 'cli-family',
    prompt: `${base}

DIMENSION: interactive-cli family (claude-code-cli / codex-cli / agy-cli) per-SESSION durability — the BIGGEST suspected gap. The doc ${WFB}/docs/cli-conversation-durability.md says the chosen solution (JuiceFS-on-Postgres FUSE, option 0b) is "prototype GO" (2026-06-11) and lists a lighter statestore snapshot/restore fallback. CRITICAL: determine the ACTUAL IMPLEMENTATION STATUS at HEAD — is ANY of it built yet, or is the transcript still on ephemeral emptyDir that dies with the pod (no resume)?
- Read ${WFB}/services/cli-agent-py/src/ (look for persist_cli_transcript / restore_cli_transcript / cancellation.py save_state/get_state / resumeFromSessionId / claude --resume wiring / juicefs mounts).
- Read ${WFB}/docs/{cli-conversation-durability,interactive-cli-sessions}.md.
- Search ${STACKS} for any juicefs / juicefs-csi-driver ArgoCD app or component, and search sandbox-execution-api manifests + ${WFB}/services/sandbox-execution-api for per-session PVC/subPath/FUSE mounts for the interactive-cli class.
Verify whether a disrupted multi-hour CLI session (claude code TUI) can resume at all today, or starts over. Report durabilityModel, implementationStatus (be precise: prototype vs absent vs partial), whatSurvives, gaps with the concrete enhancement (JuiceFS CSI rollout vs snapshot/restore fallback).`,
  },
  {
    key: 'goal-loop',
    prompt: `${base}

DIMENSION: goal-loop session-level autonomous continuation durability (the mechanism that DRIVES hours-long autonomous runs across many turns; Codex /goal parity). Doc: ${WFB}/docs/goal-loop.md.
Read ${WFB}/src/lib/server/goals/{goal-loop,repo,render}.ts, ${WFB}/src/lib/server/sessions/events.ts (~207 inline hook), the tick route ${WFB}/src/routes/api/internal/goal-loop/tick/+server.ts, and the stacks CronJob ${STACKS}/packages/components/workloads/workflow-builder/manifests/CronJob-goal-loop-tick.yaml. Verify: (1) the goal row in thread_goals is the durable objective; (2) the 2-min tick CronJob backstop + lost-idle probe (GOAL_LOOP_LOST_IDLE_GRACE_SECONDS=180) survive BFF restarts + dropped idle events; (3) exactly-once continuation injection (atomic claim + idle gate + sourceEventId dedup); (4) pod-reschedule mid-goal preserves history. Focus on: does the AUTONOMOUS DRIVER survive disruption so an hours-long goal keeps making progress, AND does it interop with the per-runtime conversation durability (esp. the CLI family which lacks transcript durability)? Report durabilityModel, implementationStatus, whatSurvives, gaps.`,
  },
  {
    key: 'infra-substrate',
    prompt: `${base}

DIMENSION: the INFRASTRUCTURE durability substrate in stacks (the foundation — if this fails, NO per-activity durability matters). This is UNDER-covered in the docs; investigate thoroughly.
Search ${STACKS}/packages for: (1) the Postgres that backs Dapr workflow state + the app DB — is it HA/replicated? Is there backup / PITR / WAL archiving? Single pod = SPOF? Look for CloudNativePG, Zalando postgres-operator, bare Deployment/StatefulSet, PgBouncer. (2) Component-workflowstatestore.yaml: actorStateStore, maxConns (doc says 16 — a fan-out bottleneck), cleanupInterval ("0"), prefix wfstate_. (3) dapr-placement-server: replicas (doc implies SINGLE replica, replicationFactor=100) — is it a SPOF for workflow scheduling? raft HA? (4) Configuration retention: stateRetentionPolicy=168h (parent + per-session children unified) — is 168h enough headroom for multi-hour runs + does it ever purge a still-running instance? (5) the dapr control plane version (1.17.9) features relevant to durability. (6) image-pin rollout / GitOps sync disruption windows on workflow-orchestrator + agent runtimes during a long run.
Report durabilityModel, implementationStatus, whatSurvives (esp. "Postgres data loss" and "placement-server restart" and "node failure"), gaps ranked by severity. The Postgres backup/HA question is the most important — answer it definitively with manifest evidence.`,
  },
  {
    key: 'session-killers',
    prompt: `${base}

DIMENSION: long-running-session KILLERS (the INVERSE risk — mechanisms that might TERMINATE a legitimately multi-hour run, defeating durability). For each, determine if it can kill/reap a long-but-slow or long-but-idle session that is NOT actually dead.
Investigate: (1) idle reapers — AGENT_RUNTIME_IDLE_TTL_SECONDS (~1800s default), CronJob-agent-runtime-idle-reaper.yaml — does an idle (waiting between goal turns, or human-paused) session get reaped? (2) Kueue admission/preemption/eviction — can a long-running sandbox pod be preempted by higher-priority work? borrowing/reclaim? Look in ${STACKS} for ClusterQueue/LocalQueue/ResourceFlavor + workloadPriorityClass for agent/swebench pods. (3) sandbox-execution-api: JOB_TTL_SECONDS ("30"), NONTERMINAL_TIMEOUT_ACTION ("terminate"), shutdownTime gate — do these terminate a live long run? (4) workflow-builder-sandbox-gc + stuck-workflow-watchdog CronJobs — age-based GC that could hit a legit long run? (5) the 15-min per-turn timer on claude-agent-py. (6) stateRetentionPolicy=168h vs a >7-day run. (7) Kueue/pod activeDeadlineSeconds or maxRunDuration. 
Read the relevant manifests in ${STACKS}/packages/components/workloads/{sandbox-execution-api,agent-sandbox,workflow-builder,dapr-workflow-watchdog} and ${STACKS}/packages/base/manifests/{openshell,agent-sandbox} + ${WFB}/services/sandbox-execution-api/src/app.py. Report durabilityModel (here = "what would wrongly kill a long run"), implementationStatus, whatSurvives, gaps with the threshold/config evidence and the fix (raise/exempt).`,
  },
]

phase('Investigate')
const findings = (await parallel(
  DIMENSIONS.map(d => () => agent(d.prompt, { label: `investigate:${d.key}`, phase: 'Investigate', schema: FINDINGS_SCHEMA }))
)).filter(Boolean)

log(`Investigation complete: ${findings.length}/${DIMENSIONS.length} dimensions. Collecting CRITICAL/HIGH gaps for adversarial verification.`)

// Collect critical/high gaps across all dimensions for adversarial verification
const criticalGaps = findings.flatMap(f =>
  (f.gaps || []).filter(g => g.severity === 'critical' || g.severity === 'high')
    .map(g => ({ ...g, dimension: f.dimension }))
)

log(`${criticalGaps.length} critical/high gaps to verify.`)

phase('Verify')
const verdicts = (await parallel(
  criticalGaps.map(g => () => agent(
    `${base}

ADVERSARIALLY VERIFY this claimed durability gap. Your DEFAULT POSTURE is skeptical — try to REFUTE it. Read the cited code/manifest and confirm whether the gap is REAL at HEAD, already mitigated, or overstated.

DIMENSION: ${g.dimension}
GAP: ${g.title}
CLAIMED SEVERITY: ${g.severity}
CLAIMED EVIDENCE: ${g.evidence}
MULTI-HOUR IMPACT: ${g.multiHourImpact}
PROPOSED ENHANCEMENT: ${g.enhancement}

Open the cited file:line / manifest. Check for an existing mitigation (a CronJob, a guard, a retry, a config that already handles it). Decide verdict (confirmed/refuted/partial/uncertain) and a corrected severity. Cite the exact code/manifest you read.`,
    { label: `verify:${g.title.slice(0, 40)}`, phase: 'Verify', schema: VERDICT_SCHEMA }
  ))
)).filter(Boolean)

return {
  findings,
  verdicts,
  summary: {
    dimensions: findings.length,
    totalGaps: findings.reduce((n, f) => n + (f.gaps || []).length, 0),
    criticalHighGaps: criticalGaps.length,
    confirmed: verdicts.filter(v => v.verdict === 'confirmed').length,
    refuted: verdicts.filter(v => v.verdict === 'refuted').length,
    partial: verdicts.filter(v => v.verdict === 'partial').length,
  },
}

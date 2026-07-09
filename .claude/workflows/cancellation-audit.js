export const meta = {
  name: 'cancellation-audit',
  description: 'Audit every cancellation/stop/terminate/purge surface (code + UI), adversarially verify flagged gaps, synthesize findings + a live test matrix',
  phases: [
    { title: 'Audit', detail: 'parallel: entry-point coverage, UI affordances, lifecycle internals' },
    { title: 'Verify', detail: 'adversarially confirm each flagged gap/bug' },
    { title: 'Synthesize', detail: 'consolidated findings + live test matrix' },
  ],
}

const REPO = '/home/vpittamp/repos/PittampalliOrg/workflow-builder/main'
const CTX =
  `Repo: ${REPO}. The vetted cancellation SSOT is the BFF Lifecycle Controller in src/lib/server/lifecycle/{index,cascade,resolvers,reaper,ownership}.ts ` +
  `(stopDurableRun modes interrupt/terminate/purge/reset; confirmDurableStop; request/confirm = HTTP 202 "stopping" then confirmed; reaper = lifecycle-terminal-reaper CronJob; ` +
  `cross-app child wedge force-finalize just added in PR #77; coordinator-owned redirect = 409 in ownership.ts). ` +
  `Coordinator-owned run cancels: cancelBenchmarkRun (src/lib/server/benchmarks/service.ts), cancelEvaluationRun (src/lib/server/evaluations/service.ts) — both call stopDurableRun(mode purge). ` +
  `Key routes: /api/workflows/executions/[id]/stop(+/stop/status), /api/v1/sessions/[id]/stop(+/stop/status), /api/v1/sessions/[id]/control/interrupt, /api/benchmarks/runs/[id]/cancel, /api/evaluations/runs/[id]/cancel. ` +
  `IMPORTANT: a multi-agent cancellation audit ALREADY ran and HARDENED this (PRs #77/#78/#79, see docs/workflow-lifecycle-termination.md Part 7). #78 made the wedge gate positive-evidence: shouldForceFinalizeCrossAppWedge fires per still-RUNNING parent only when, after the grace, the parent's live currentNodeId (cascade getParentCurrentNode) is a durable/run node whose child session is DB-terminated (resolvers.terminatedChildNodes). Do NOT re-report known/already-fixed items — focus on any REMAINING gap/regression/edge-case in the CURRENT code, and on an accurate live test matrix. Read code only; do NOT touch any cluster.`

const DIM_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['dimension', 'summary', 'findings', 'fileRefs'],
  properties: {
    dimension: { type: 'string' },
    summary: { type: 'string', description: 'overall assessment of this dimension' },
    findings: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false,
        required: ['title', 'detail', 'severity', 'isGap'],
        properties: {
          title: { type: 'string' },
          detail: { type: 'string' },
          surface: { type: 'string', description: 'the route/component/function involved' },
          severity: { type: 'string', enum: ['info', 'low', 'medium', 'high'] },
          isGap: { type: 'boolean', description: 'true if this is a gap/bug/inconsistency (not just a confirmed-good observation)' },
          routedThroughLifecycle: { type: 'string', enum: ['yes', 'no', 'na'], description: 'for entry points: does it route through the vetted lifecycle controller?' },
          file: { type: 'string', description: 'file:line' },
        },
      },
    },
    fileRefs: { type: 'array', items: { type: 'string' } },
  },
}

const VERDICT_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['claim', 'verdict', 'reasoning'],
  properties: {
    claim: { type: 'string' },
    verdict: { type: 'string', enum: ['confirmed', 'refuted', 'partial'] },
    reasoning: { type: 'string', description: 'evidence from the actual code; default to refuted if you cannot substantiate it' },
    file: { type: 'string' },
    severity: { type: 'string', enum: ['info', 'low', 'medium', 'high'] },
  },
}

const SYNTH_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['overall', 'confirmedFindings', 'testMatrix'],
  properties: {
    overall: { type: 'string', description: 'overall health of cancellation across the project' },
    confirmedFindings: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false,
        required: ['title', 'severity', 'recommendation'],
        properties: {
          title: { type: 'string' },
          severity: { type: 'string', enum: ['info', 'low', 'medium', 'high'] },
          detail: { type: 'string' },
          recommendation: { type: 'string' },
          file: { type: 'string' },
        },
      },
    },
    testMatrix: {
      type: 'array',
      description: 'concrete live use cases to test on dev',
      items: {
        type: 'object', additionalProperties: false,
        required: ['useCase', 'surface', 'howToTrigger', 'expected', 'priority'],
        properties: {
          useCase: { type: 'string' },
          surface: { type: 'string', description: 'UI button + API route + mode' },
          howToTrigger: { type: 'string' },
          expected: { type: 'string', description: 'pass criteria: DB + Dapr + UI end state' },
          priority: { type: 'string', enum: ['p0', 'p1', 'p2'] },
        },
      },
    },
  },
}

phase('Audit')
const DIMS = [
  {
    key: 'entrypoints',
    prompt:
      `Dimension: ENTRY-POINT COVERAGE. ${CTX}\n` +
      `Enumerate EVERY user-facing way to cancel/stop/terminate/purge/interrupt/delete-while-running a durable unit ` +
      `(workflow executions, agent sessions, benchmark runs+instances, evaluation runs+items, the cross-app durable/run child). ` +
      `For each: name the API route + handler, and state whether it routes through the vetted lifecycle controller ` +
      `(stopDurableRun / cancelBenchmarkRun / cancelEvaluationRun / confirmDurableStop) or is an AD-HOC path (raw Dapr terminate/purge, direct DB flip, bypassing the controller). ` +
      `Flag (isGap=true) any ad-hoc/bypassing path, any dead/unauthenticated route, any surface that should be stoppable but isn't, and any Delete/Archive that is NOT blocked while a run is active.`,
  },
  {
    key: 'ui',
    prompt:
      `Dimension: UI AFFORDANCES. ${CTX}\n` +
      `Audit the Svelte UI for cancellation. Find every control: Stop, Stop & Reset, Cancel, Interrupt, Delete/Archive-while-active — on session detail, workflow run detail, sessions list, benchmark run detail, evaluation run detail, and any global notification/bell. ` +
      `For each, verify it: (a) calls the right endpoint+mode, (b) handles the 202 "stopping" state (shows "Stopping…" + polls /stop/status to convergence), (c) handles the coordinator_owned 409 (hides generic Stop, links to the owning run's Cancel), (d) blocks Delete/Archive while active. ` +
      `Flag (isGap=true) any surface MISSING a stop affordance, any that does NOT handle 202/poll, any that mishandles coordinator_owned, any inconsistency between surfaces, any button wired to a removed/dead endpoint.`,
  },
  {
    key: 'internals',
    prompt:
      `Dimension: LIFECYCLE INTERNALS CORRECTNESS. ${CTX}\n` +
      `Review src/lib/server/lifecycle/{index,cascade,resolvers,reaper,ownership}.ts for correctness + edge cases. Cover: ` +
      `the four modes (interrupt/terminate/purge/reset) semantics; the request/confirm 202 flow + markStopRequested/finalizeDb (does it ever flip DB before Dapr is terminal? ever lie?); ` +
      `the cross-app child wedge force-finalize (shouldForceFinalizeCrossAppWedge + confirmDurableStop wedge branch + the reaper routing) — is the grace safe, can it false-positive force-purge a legitimately-progressing parent, is it idempotent; ` +
      `the cross-app per-app-id fan-out (terminate+purge each child app-id); the reaper passes (stop-requested, stuck, sessions, wedge) — divergence safety, benchmark-active behavior; ` +
      `ownership.ts coordinator_owned detection. Flag (isGap=true) real bugs/races/edge-cases with severity.`,
  },
]
const dimResults = await parallel(
  DIMS.map((d) => () => agent(d.prompt, { label: `audit:${d.key}`, phase: 'Audit', schema: DIM_SCHEMA })),
)

// Collect flagged gaps (medium/high or isGap) for adversarial verification.
const gaps = []
for (const r of dimResults.filter(Boolean)) {
  for (const f of r.findings || []) {
    if (f.isGap || f.severity === 'medium' || f.severity === 'high') {
      gaps.push({ dimension: r.dimension, ...f })
    }
  }
}
log(`Audit found ${gaps.length} flagged finding(s) to adversarially verify`)

phase('Verify')
const verdicts = await parallel(
  gaps.map((g) => () =>
    agent(
      `Adversarially VERIFY this claimed cancellation gap/bug against the ACTUAL code. ${CTX}\n` +
        `Claim: "${g.title}" — ${g.detail} (surface: ${g.surface || 'n/a'}, file: ${g.file || 'n/a'}). ` +
        `Read the real code. Is it actually true/exploitable, or a false positive (e.g. handled elsewhere, dead code, already-correct)? ` +
        `Default to refuted if you cannot substantiate it from the code.`,
      { label: `verify:${(g.title || '').slice(0, 32)}`, phase: 'Verify', schema: VERDICT_SCHEMA },
    ).then((v) => ({ ...g, verify: v })),
  ),
)
const confirmed = verdicts.filter(Boolean).filter((v) => v.verify && v.verify.verdict !== 'refuted')
log(`${confirmed.length}/${gaps.length} flagged findings survived adversarial verification`)

phase('Synthesize')
const synthesis = await agent(
  `Synthesize a cancellation health report + a LIVE TEST MATRIX for dev. ${CTX}\n` +
    `Per-dimension audit summaries: ${JSON.stringify(dimResults.filter(Boolean).map((r) => ({ dimension: r.dimension, summary: r.summary })))}\n` +
    `Adversarially-CONFIRMED findings (refuted ones already dropped): ${JSON.stringify(confirmed.map((c) => ({ title: c.title, severity: c.verify.severity || c.severity, detail: c.detail, file: c.file, verdict: c.verify.verdict, reasoning: c.verify.reasoning })))}\n` +
    `Produce: (1) overall health; (2) confirmedFindings with recommendations (only real, verified ones); ` +
    `(3) a prioritized testMatrix of concrete cancellation use cases to exercise live on dev — cover: regular workflow execution Stop (terminate + purge), session Interrupt, session terminate/purge, benchmark run Cancel, evaluation run Cancel, coordinator-owned instance 409 redirect, Delete/Archive blocked while active, and the cross-app durable/run Stop (the wedge). For each give the exact UI button + API route + mode, how to trigger on dev, expected DB+Dapr+UI end state, and priority.`,
  { label: 'synthesize', phase: 'Synthesize', schema: SYNTH_SCHEMA },
)

return { dimResults, confirmedCount: confirmed.length, synthesis }

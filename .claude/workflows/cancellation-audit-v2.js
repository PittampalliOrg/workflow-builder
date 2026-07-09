export const meta = {
  name: 'cancellation-audit-v2',
  description: 'Audit every cancellation surface (code + UI) in 3 parallel dimensions, then synthesize findings + a live dev test matrix (prose, no schema)',
  phases: [
    { title: 'Audit', detail: 'parallel: entry-point coverage, UI affordances, lifecycle internals' },
    { title: 'Synthesize', detail: 'consolidated findings + prioritized live test matrix' },
  ],
}

const REPO = '/home/vpittamp/repos/PittampalliOrg/workflow-builder/main'
const CTX =
  `Repo: ${REPO}. The vetted cancellation SSOT is the BFF Lifecycle Controller in src/lib/server/lifecycle/{index,cascade,resolvers,reaper,ownership}.ts ` +
  `(stopDurableRun modes interrupt/terminate/purge/reset; confirmDurableStop; request/confirm = HTTP 202 "stopping" then confirmed; reaper = lifecycle-terminal-reaper CronJob; ` +
  `cross-app child wedge force-finalize added in PR #77 = shouldForceFinalizeCrossAppWedge + a confirmDurableStop wedge branch + the reaper routing stop-requested non-terminal parents through confirmDurableStop; coordinator-owned redirect = 409 in ownership.ts). ` +
  `Coordinator-owned run cancels: cancelBenchmarkRun (src/lib/server/benchmarks/service.ts), cancelEvaluationRun (src/lib/server/evaluations/service.ts) — both call stopDurableRun(mode purge). ` +
  `Key routes: /api/workflows/executions/[id]/stop(+/stop/status), /api/v1/sessions/[id]/stop(+/stop/status), /api/v1/sessions/[id]/control/interrupt, /api/benchmarks/runs/[id]/cancel, /api/evaluations/runs/[id]/cancel. ` +
  `Read code only with Read/Grep/Glob; do NOT touch any cluster. Be concrete: cite file:line. Return a thorough markdown report.`

phase('Audit')

const audits = await parallel([
  () => agent(
    `Dimension: ENTRY-POINT COVERAGE. ${CTX}\n\n` +
    `Enumerate EVERY user-facing way to cancel/stop/terminate/purge/interrupt/delete-while-running a durable unit ` +
    `(workflow executions, agent sessions, benchmark runs+instances, evaluation runs+items, the cross-app durable/run child). ` +
    `For each: name the API route + handler, and state YES/NO whether it routes through the vetted lifecycle controller ` +
    `(stopDurableRun / cancelBenchmarkRun / cancelEvaluationRun / confirmDurableStop) vs an AD-HOC path (raw Dapr terminate/purge, direct DB flip, bypassing the controller). ` +
    `Explicitly call out (as GAPS): any ad-hoc/bypassing path, any dead or unauthenticated stop/terminate/purge route still present, any surface that should be stoppable but isn't, and any Delete/Archive NOT blocked while a run is active. ` +
    `End with a bullet list of GAPS (each: severity high/med/low, file:line, why).`,
    { label: 'audit:entrypoints', phase: 'Audit' },
  ),
  () => agent(
    `Dimension: UI AFFORDANCES. ${CTX}\n\n` +
    `Audit the Svelte UI (src/routes/**, src/lib/components/**) for cancellation. Find every control: Stop, Stop & Reset, Cancel, Interrupt, Delete/Archive-while-active — on session detail, workflow run detail, sessions list, benchmark run detail, evaluation run detail, and any global notification/bell. ` +
    `For each verify: (a) calls the right endpoint+mode; (b) handles the 202 "stopping" state (shows "Stopping…" + polls /stop/status to convergence); (c) handles the coordinator_owned 409 (hides generic Stop, links to the owning run's Cancel); (d) blocks Delete/Archive while active. ` +
    `Explicitly call out (as GAPS): any surface MISSING a stop affordance, any that does NOT handle 202/poll, any that mishandles coordinator_owned, any inconsistency between surfaces, any button wired to a removed/dead endpoint. ` +
    `End with a bullet list of GAPS (each: severity, file:line, why).`,
    { label: 'audit:ui', phase: 'Audit' },
  ),
  () => agent(
    `Dimension: LIFECYCLE INTERNALS CORRECTNESS. ${CTX}\n\n` +
    `Review src/lib/server/lifecycle/{index,cascade,resolvers,reaper,ownership}.ts + the cross-app wedge fix for correctness + edge cases. Cover: ` +
    `the four modes (interrupt/terminate/purge/reset) semantics; the request/confirm 202 flow + markStopRequested/finalizeDb (does it EVER flip DB terminal before Dapr is terminal? ever report a false success?); ` +
    `the cross-app child wedge force-finalize (shouldForceFinalizeCrossAppWedge + the confirmDurableStop wedge branch + reaper routing) — is the grace safe, can it false-positively force-purge a legitimately-progressing parent, is it idempotent, what if agent status polls error transiently; ` +
    `the cross-app per-app-id fan-out; the reaper passes (stop-requested, stuck, sessions, wedge) — divergence safety + behavior during benchmark activity; ownership.ts coordinator_owned detection. ` +
    `Explicitly call out (as GAPS): real bugs/races/edge-cases. End with a bullet list of GAPS (each: severity, file:line, why). Be adversarial — try to find a way each guarantee breaks.`,
    { label: 'audit:internals', phase: 'Audit' },
  ),
])

const labels = ['ENTRY-POINTS', 'UI', 'INTERNALS']
const merged = audits.map((a, i) => `# ${labels[i]}\n\n${a || '(no result)'}`).join('\n\n---\n\n')

phase('Synthesize')
const synthesis = await agent(
  `You are consolidating a cancellation audit of the workflow-builder project into (1) a findings report and (2) a LIVE TEST MATRIX for dev. ${CTX}\n\n` +
  `Here are the three dimension reports:\n\n${merged}\n\n` +
  `Produce a markdown document with:\n` +
  `## Overall health — one paragraph.\n` +
  `## Confirmed findings — ONLY real, code-substantiated gaps/bugs (drop anything speculative or already-handled). For each: severity (high/med/low), file:line, what's wrong, and a concrete recommendation. If there are none, say so plainly.\n` +
  `## Live test matrix — a prioritized table (p0/p1/p2) of concrete cancellation use cases to exercise on dev. MUST cover: regular workflow execution Stop (terminate AND purge), session Interrupt, session terminate/purge, benchmark run Cancel, evaluation run Cancel, coordinator-owned instance 409 redirect, Delete/Archive blocked while active, and the cross-app durable/run Stop (the wedge). For each row give: use case | exact UI control + API route + mode | how to trigger on dev | expected DB+Dapr+UI end state (pass criteria) | priority. ` +
  `Be precise enough that an operator could run each test directly.`,
  { label: 'synthesize', phase: 'Synthesize' },
)

return { synthesis, dimensionReports: merged }

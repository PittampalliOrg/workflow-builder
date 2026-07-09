export const meta = {
  name: 'lifecycle-diff-review',
  description: 'High-effort 8-angle review of the CLI-lifecycle hardening diff, 1-vote verify',
  phases: [
    { title: 'Find', detail: '8 independent finder angles over the diff' },
    { title: 'Verify', detail: 'one recall-biased verifier per deduped candidate' },
  ],
}

const DIFF = '/tmp/claude-1000/-home-vpittamp-repos-PittampalliOrg-workflow-builder-main/340d7cd1-682b-4261-86c0-76d1690cd450/scratchpad/review-diff.patch'
const REPO = '/home/vpittamp/repos/PittampalliOrg/workflow-builder/main'

const CONTEXT = `Repo: ${REPO} (SvelteKit BFF + Python cli-agent-py service). The full unified diff under review (working tree vs HEAD, INCLUDING new untracked files appended as diffs against /dev/null) is at ${DIFF} — Read it. The change hardens CLI-agent sandbox lifecycle tracking: (W1) new 'failed' session status + session.status_errored ingest handler + 'crashed'/'error' stop reasons; (W2) sessions.last_event_at column, throttled bump on ingest, migration drizzle/0095; (W3) cli-agent-py StopFailure hook -> turn.failed workflow event -> session.status_errored publish, subagent transcript filter, idle-reaper TOCTOU guard (services/cli-agent-py/src/{hooks_api,session_workflow,session_supervisor,cli_adapters/claude_code}.py + tests); (W4) session liveness reconciler (src/lib/server/lifecycle/session-reconciler.ts pure core + application/adapters/session-reconciler-deps.ts wiring + application/session-reconciler-service.ts + routes /api/internal/sessions/reconcile and /job/session-liveness-reconcile + startup.ts Dapr Job scheduling + FinalizeOutcome threading through lifecycle/{resolvers,index}.ts and adapters/lifecycle-resolver.ts + listLivenessReconcileCandidates in adapters/sessions.ts). CRITICAL SYSTEM INVARIANTS to check against: no new wait_for_external_event subscriptions in session_workflow.py (single re-armed subscription pattern); deterministic source_event_id on every publish + is_replaying guards (Dapr workflow replay safety); anything marking a session terminal must route through the Lifecycle Controller cascade; any 'unknown' reconciler evidence must skip (never converge on flaky kube/Dapr APIs); goal loop drives continuations ONLY on end_turn idles.`

const FINDINGS = {
  type: 'object', additionalProperties: false, required: ['findings'],
  properties: { findings: { type: 'array', maxItems: 6, items: {
    type: 'object', additionalProperties: false, required: ['file', 'line', 'summary', 'failure_scenario'],
    properties: { file: { type: 'string' }, line: { type: 'integer' }, summary: { type: 'string' }, failure_scenario: { type: 'string' } },
  } } },
}

const VERDICT = {
  type: 'object', additionalProperties: false, required: ['verdict', 'reason'],
  properties: { verdict: { type: 'string', enum: ['CONFIRMED', 'PLAUSIBLE', 'REFUTED'] }, reason: { type: 'string' } },
}

const ANGLES = [
  { key: 'line-scan', prompt: 'ANGLE A — line-by-line diff scan. Read every hunk in the diff, line by line. Then Read the enclosing function in the repo for each hunk — bugs in unchanged lines of a touched function are in scope. For every line ask: what input, state, timing, or platform makes this line wrong? Inverted/wrong conditions, off-by-one, null/undefined deref, missing await, falsy-zero checks, wrong-variable copy-paste, error swallowed in catch, unescaped regex metachars, Python asyncio lock misuse, dict-key assumptions on hook payloads.' },
  { key: 'removed-behavior', prompt: 'ANGLE B — removed-behavior auditor. For every line the diff DELETES or replaces, name the invariant or behavior it enforced, then search the new code for where that invariant is re-established. Removed guards, dropped error paths, narrowed validation, changed test assertions that were covering a real case (note: 9 pre-existing session_workflow tests were mechanically updated to drive new best-effort sync yields — check no assertion was weakened; the claude_code adapter one-shot branch used to POP hooks entirely and now keeps StopFailure — check nothing depended on hooks being absent in one-shot mode).' },
  { key: 'cross-file', prompt: 'ANGLE C — cross-file tracer. For each function the diff changes, Grep for its callers and check whether the change breaks any call site: new precondition, changed return shape, new exception, timing/ordering dependency. Key traces: finalizeDb(reason, outcome?) — every implementor/caller of the ResolvedDurableTarget closure across lifecycle resolvers and adapters/lifecycle-resolver.ts; the new turn.failed event vs every consumer of the lifecycle event batch in session_workflow.py; session.status_errored vs every session-event consumer (transcript model, SSE stream lists, benchmark outcome derivation in adapters/session-events.ts, timings); the SessionStatus union widening vs exhaustive switches or status sets anywhere (Grep for "terminated" adjacency); bumpSessionLastEventAt port vs ALL SessionRepository implementors (are there fakes/mocks/lite implementations that now miss the method?); request_graceful_exit lock acquisition vs its callers (could stop_cli_activity path deadlock with an in-flight injection holding _pane_write_lock?).' },
  { key: 'reuse', prompt: 'CLEANUP ANGLE — reuse. Flag new code that re-implements something the codebase already has — Grep shared/utility modules and files adjacent to the change; name the existing helper to call instead. Candidates: the reconciler evidence probes vs existing lifecycle/cascade deps; the Dapr Jobs fetch helper vs any existing dapr-client.ts; env-knob parsing vs existing config helpers; the internal route shape vs reap-idle.' },
  { key: 'simplify', prompt: 'CLEANUP ANGLE — simplification. Flag unnecessary complexity the diff adds: redundant or derivable state, copy-paste with slight variation, deep nesting, dead code. Check the reconciler decision core for redundant branches, the session-reconciler-deps wiring for derivable values, the new tests for copy-paste that a helper would collapse, and the hooks_api StopFailure branch vs the Stop branch (should shared logic be factored?).' },
  { key: 'efficiency', prompt: 'CLEANUP ANGLE — efficiency. Flag wasted work: redundant computation or repeated I/O, independent operations run sequentially that could parallelize, blocking work added to startup or hot paths. Key spots: the per-ingest last_event_at bump (is the throttle actually avoiding a write per event? is it an extra round-trip on EVERY ingest even when throttled?), the reconciler probing evidence serially per candidate, the startup.ts Dapr Job scheduling blocking boot, listLivenessReconcileCandidates query cost (correlated EXISTS), closures capturing large scopes in long-lived deps objects.' },
  { key: 'altitude', prompt: 'ALTITUDE ANGLE. Check each change is implemented at the right depth, not as a fragile bandaid: is the status_errored handling a special case where a general status map belongs? Is FinalizeOutcome threaded cleanly or bolted on? Is the /job/ callback route generic enough for future Dapr jobs or a one-off that will be copy-pasted? Is the subagent transcript filter the right layer (hooks_api) vs adapter? Special cases layered on shared infrastructure are the smell.' },
  { key: 'conventions', prompt: 'CONVENTIONS ANGLE (CLAUDE.md). Read ' + REPO + '/CLAUDE.md and ~/.claude/CLAUDE.md if present, plus any CLAUDE.md in ancestor dirs of changed files. Check the diff for CLEAR violations of stated rules — quote the exact rule and the exact violating line. Relevant rule areas: Lifecycle Controller as single stop authority; Dapr Component visibility; "the live cluster is mutated only by ArgoCD"; internal-token route auth; drizzle as single schema owner; no restoration of retired endpoints (/api/internal/lifecycle/reap-terminal etc. — is the new reconcile endpoint meaningfully different from the retired reap-terminal? judge by the stated rationale); goal-loop invariants. Only flag with rule + line quoted.' },
]

phase('Find')
const results = await pipeline(
  ANGLES,
  a => agent(
    `${CONTEXT}\n\nYou are ONE independent finder angle in a high-effort code review optimizing for RECALL. ${a.prompt}\n\nReturn up to 6 candidate findings. Every candidate needs file (repo-relative), line (1-indexed, in the NEW file version), a one-line summary, and a CONCRETE failure_scenario (inputs/state -> wrong outcome; for cleanup angles: the concrete cost). Pass through every candidate with a nameable failure scenario — do NOT silently drop half-believed candidates. Return an empty findings array only if you genuinely found nothing.`,
    { label: `find:${a.key}`, phase: 'Find', schema: FINDINGS }
  ),
  (r, a) => (r?.findings ?? []).map(f => ({ ...f, angle: a.key }))
)

const all = results.filter(Boolean).flat()
log(`${all.length} raw candidates from ${ANGLES.length} angles`)

// dedup: same file + same defect locus (line within 5) + similar summary start
const deduped = []
for (const f of all) {
  const dup = deduped.find(g => g.file === f.file && Math.abs(g.line - f.line) <= 5 &&
    g.summary.toLowerCase().slice(0, 40) === f.summary.toLowerCase().slice(0, 40))
  if (!dup) deduped.push(f)
}
log(`${deduped.length} candidates after dedup`)

phase('Verify')
const verified = await parallel(deduped.map(f => () =>
  agent(
    `${CONTEXT}\n\nYou are a single recall-biased VERIFIER in a code review. Candidate finding (from angle "${f.angle}"):\nFILE: ${f.file}\nLINE: ${f.line}\nSUMMARY: ${f.summary}\nFAILURE SCENARIO: ${f.failure_scenario}\n\nRead the diff at ${DIFF} and the relevant file(s) in ${REPO} (and callers/callees as needed). Return exactly one verdict:\n- PLAUSIBLE by default — do NOT refute for being "speculative" or "depends on runtime state" when the state is realistic (races, rare-but-reachable paths, falsy-zero, boundary off-by-one, retry storms, lost anchors).\n- REFUTED only when constructible from the code: factually wrong (quote the actual line); provably impossible (show the type/constant/invariant); already handled in this diff (cite the guard); or pure style with no observable effect. For cleanup/altitude/conventions candidates, REFUTE if the claimed duplicate/simplification/rule does not actually exist as claimed.\n- CONFIRMED when you can demonstrate the failure concretely from the code.\nGive a tight reason citing the decisive line(s).`,
    { label: `verify:${f.file.split('/').pop()}:${f.line}`, phase: 'Verify', schema: VERDICT }
  ).then(v => ({ ...f, verdict: v?.verdict ?? 'PLAUSIBLE', reason: v?.reason ?? 'verifier died; kept per recall bias' }))
))

const kept = verified.filter(Boolean).filter(f => f.verdict !== 'REFUTED')
log(`${kept.length} findings survived (of ${deduped.length} verified)`)
return { kept, refuted: verified.filter(Boolean).filter(f => f.verdict === 'REFUTED').map(f => ({ file: f.file, line: f.line, summary: f.summary, reason: f.reason })) }
export const meta = {
  name: 'review-39-durable-records',
  description: 'Adversarial 3-lens review of the #39 durable pr-preview records diff',
  phases: [{ title: 'Review' }, { title: 'Verify' }],
}
const DIFF = '/tmp/claude-1000/-home-vpittamp-repos-PittampalliOrg-stacks-main/7a87c5ef-dba9-454a-b799-5ad8aab337dd/scratchpad/pr39.diff'
const REPO = '/home/vpittamp/repos/PittampalliOrg/workflow-builder/main'
const CONTEXT = `The diff (at ${DIFF}, repo worktree at ${REPO}, branch fix/d1-durable-pr-preview-records) makes the D1 pr-preview pipeline's run state durable: new drizzle table pr_previews (hand-written migration drizzle/0094_pr_previews.sql + journal entry, matching the repo's hand-written 0092/0093 convention — NO meta snapshot, that is intentional), new PrPreviewRecordStore port + DrizzlePrPreviewRecordStore/InMemoryPrPreviewRecordStore adapters, and ApplicationPrPreviewService reworked: async up() persisting before dispatch, 30s heartbeat patch({}) while a pipeline runs, status() reading the store from any replica and atomically claiming stale (>=120s, states provisioning/seeding only) orphaned records for an idempotent resume, structured console logs per stage, down() deleting the record. Operational context: the BFF runs 2 replicas; the hub Tekton dispatch Task polls GET status every 15s conntrack-pinned to one replica and greps the FIRST "state":"..." occurrence in the response JSON; the pipeline stages call SEA claim (exactly-one-wins), dev-pod adopt, helper-pod seed — all idempotent per alias.`
const FINDINGS = {
  type: 'object', required: ['findings'],
  properties: { findings: { type: 'array', items: {
    type: 'object', required: ['title', 'detail', 'severity'],
    properties: { title: {type:'string'}, detail: {type:'string'}, severity: {enum:['critical','major','minor']}, file: {type:'string'} } } } }
}
const VERDICT = { type: 'object', required: ['real', 'reason'], properties: { real: {type:'boolean'}, reason: {type:'string'} } }
const LENSES = [
  { key: 'concurrency', prompt: `${CONTEXT}\n\nYou are a hostile concurrency reviewer. Read the diff and the touched files in the repo. Hunt ONLY real race/lifecycle defects: double-dispatch windows (two replicas, up+resume, up+up), claim/heartbeat interplay (can a live run be stolen? heartbeat 30s vs stale 120s under event-loop stalls?), down-vs-running-up races (record resurrection? patch-after-delete?), the inFlight map vs async up() (is the duplicate guard racy within one replica?), and whether a resumed run can run CONCURRENTLY with the original if the original was not dead (only stalled). Report only defects with a concrete failure scenario.` },
  { key: 'schema', prompt: `${CONTEXT}\n\nYou are a database/migration reviewer. Verify: the hand-written 0094 SQL exactly matches the drizzle schema.ts table (column names/types/defaults/nullability — read both); the journal entry is consistent with the repo's convention (compare 0092/0093 entries); drizzle timestamp mode handling in the adapter (Date vs string round-trip, toISOString on a drizzle timestamp column); jsonb default parity; PGlite/lite-profile compatibility (drizzle-kit push from schema.ts — anything in this table PGlite cannot handle?); onConflictDoUpdate correctness; and whether claimStale's guarded UPDATE...RETURNING is actually atomic in postgres AND in the in-memory reference. Report only real defects.` },
  { key: 'behavior', prompt: `${CONTEXT}\n\nYou are a behavioral-contract reviewer. Compare the reworked service against the pre-diff behavior (git show HEAD:src/lib/server/application/pr-previews.ts in the repo) and the consumers: the two routes under src/routes/api/internal/pr-previews and the hub Tekton dispatch Task's poll contract (first "state" occurrence in JSON, terminal = ready|error|capacity_full). Hunt: JSON key-order regressions affecting the grep, status semantics changes (absent/unknown/ready fallback), up() now async (route updated?), settled() still correct for tests, resume input reconstruction (headSha/changedFiles/verify) producing WRONG behavior vs the original request, and error paths that now write to a deleted record. Report only real defects.` },
]
phase('Review')
const results = await pipeline(
  LENSES,
  l => agent(l.prompt, { label: `review:${l.key}`, phase: 'Review', schema: FINDINGS }),
  (r, l) => parallel((r?.findings ?? []).map(f => () =>
    agent(`${CONTEXT}\n\nA reviewer claims this defect in the diff:\nTITLE: ${f.title}\nDETAIL: ${f.detail}\n\nAdversarially VERIFY by reading the actual code in ${REPO} (branch checked out). Default to real=false unless you can articulate the concrete failing sequence against the real code. Nitpicks/style/already-documented-tradeoffs are real=false.`,
      { label: `verify:${l.key}`, phase: 'Verify', schema: VERDICT })
      .then(v => ({ ...f, lens: l.key, verdict: v }))))
)
const confirmed = results.flat().filter(Boolean).filter(f => f.verdict?.real)
return { confirmed, totalRaw: results.flat().filter(Boolean).length }
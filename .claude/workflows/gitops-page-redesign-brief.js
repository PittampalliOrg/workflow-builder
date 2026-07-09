export const meta = {
  name: 'gitops-page-redesign-brief',
  description: 'Audit the /admin/gitops/system GitOps pipeline page and synthesize a crisp, testable redesign brief (the GAN intent)',
  phases: [{ title: 'Audit' }, { title: 'Synthesize' }],
}

const REPO = '/home/vpittamp/repos/PittampalliOrg/workflow-builder/main'
const PAGE = `${REPO}/src/routes/(admin)/admin/gitops/system`

const AUDIT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    findings: { type: 'array', items: { type: 'object', additionalProperties: false, properties: {
      area: { type: 'string' },
      observation: { type: 'string' },
      kind: { type: 'string', enum: ['noise', 'gap', 'keep', 'confusing'] },
      severity: { type: 'string', enum: ['high', 'med', 'low'] },
    }, required: ['area', 'observation', 'kind', 'severity'] } },
    summary: { type: 'string' },
  },
  required: ['findings', 'summary'],
}

phase('Audit')
const lenses = [
  { key: 'render-map', prompt: `Read the GitOps "system" pipeline page + its components and MAP what it renders and how dense/noisy it is. Files: ${PAGE}/+page.svelte, ${PAGE}/+page.server.ts, and everything under ${REPO}/src/lib/components/gitops/ (especially pipeline/, AttentionBanner.svelte, PromotionStrip.svelte, ServiceRail.svelte, ServiceTable.svelte, ServiceDetail.svelte, EnvCard.svelte, BuildActivity.svelte, GateChip.svelte, InventoryFooter.svelte, GitopsFilters.svelte). This is the "Kargo lens" event-driven GitOps pipeline view for dev + ryzen. For each section/component, record what data it shows and whether it is NOISE (redundant/dense/firehose), a GAP (missing), KEEP (essential), or CONFUSING. Be concrete and cite the component.` },
  { key: 'data-model', prompt: `Read the GitOps data/model layer and surface conceptual confusion + redundancy that leaks to the UI. Files under ${REPO}/src/lib/gitops/ (activity-overlay.ts, change-journey.ts, freight-journey.ts, gates.ts, kargo-colors.ts, kargo-status.ts, pipeline-layout.ts, pipeline-model.ts if present, gitops-flow.svelte.ts, notification-detect.ts) and ${REPO}/src/lib/server/gitops/. Map the core concepts (freight, gates, promotion, stages, event-vs-inventory sourcing, commit→build→pin→promote→deploy) and flag which are CONFUSING, redundant, or over-exposed to end users. Return findings.` },
  { key: 'understandability', prompt: `Adopt a USER lens for /admin/gitops/system. First list the top ~6 questions a user genuinely needs answered at a glance (e.g. "Is my latest change live on each cluster?", "Is anything broken or stuck right now?", "What is in flight?", "How long from commit to live?", "What, if anything, do I need to do?"). Then read ${PAGE}/+page.svelte to judge which the current page answers WELL vs POORLY/NOT-AT-ALL. Return findings tagged gap/keep/confusing, and in summary name the single biggest understandability failure of the page today.` },
  { key: 'reference', prompt: `You are a senior product designer for developer tools. Identify what makes best-in-class continuous-delivery / GitOps pipeline UIs low-noise and instantly understandable — Kargo, ArgoCD, Vercel/Netlify deploy views, GitHub Actions, Spinnaker, Google Cloud Build/Deploy. Return findings as concrete, adoptable patterns framed as things THIS page should adopt: progressive disclosure, exactly one clear status per environment, a commit→live lead-time, a single unified "attention/needs-you" surface, quiet/calm steady-state (no motion or firehose when nothing is wrong), timeline vs graph trade-offs. No repo reading needed; kind should mostly be "gap" or "keep".` },
]
const audits = (await parallel(lenses.map(l => () =>
  agent(l.prompt, { label: `audit:${l.key}`, phase: 'Audit', schema: AUDIT_SCHEMA, agentType: 'Explore' }),
))).filter(Boolean)

phase('Synthesize')
const BRIEF_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    targetIA: { type: 'array', items: { type: 'string' }, description: 'ordered top-to-bottom sections of the redesigned page' },
    lessNoisyRules: { type: 'array', items: { type: 'string' } },
    mustKeepSignals: { type: 'array', items: { type: 'string' } },
    cutOrDemote: { type: 'array', items: { type: 'string' } },
    acceptanceCriteria: { type: 'array', items: { type: 'string' }, description: '6-8 concrete, browser-verifiable criteria a skeptical Playwright critic can check' },
    ganIntent: { type: 'string', description: 'ONE tight, vivid paragraph (the change request) to hand the GAN planner as the redesign direction' },
  },
  required: ['targetIA', 'lessNoisyRules', 'mustKeepSignals', 'cutOrDemote', 'acceptanceCriteria', 'ganIntent'],
}
const brief = await agent(
  `Synthesize these four audits of the /admin/gitops/system GitOps pipeline page into ONE crisp redesign brief.\n\n` +
  `NORTH STAR: the easiest, most understandable, LEAST NOISY way for a user to understand what is happening in the GitOps system — the commit → build → pin → promote → deploy flow across the dev and ryzen clusters. Favor progressive disclosure, exactly one unambiguous status per environment, a single "attention/needs-you" surface, a clear commit→live answer, and a calm steady-state (nothing screaming when all is healthy). Keep the essential signals; cut the firehose. The redesign must preserve the real data sources (inventory + the event SSE stream) — this is a re-presentation, not a rewrite of the backend.\n\n` +
  `Produce: targetIA (ordered sections), lessNoisyRules, mustKeepSignals, cutOrDemote, acceptanceCriteria (6-8, browser-verifiable), and ganIntent (one vivid paragraph the GAN planner will act on).\n\nAUDITS:\n${JSON.stringify(audits)}`,
  { label: 'synthesize-brief', phase: 'Synthesize', schema: BRIEF_SCHEMA, effort: 'high' },
)
return brief
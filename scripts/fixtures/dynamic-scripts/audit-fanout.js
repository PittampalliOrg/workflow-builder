export const meta = {
  name: 'audit-fanout',
  description:
    'Map-reduce audit: one reviewer agent per item, then adversarially verify each finding before reporting (the canonical "audit many files for the same issue" shape).',
  phases: [{ title: 'Review' }, { title: 'Verify' }, { title: 'Report' }],
}

// `args.items` is a list of { id, text } to audit. Falls back to a small
// built-in set so the workflow is runnable with no input.
const items =
  Array.isArray(args?.items) && args.items.length
    ? args.items
    : [
        { id: 'login', text: 'function login(req){ return db.user(req.body.name) }' },
        { id: 'transfer', text: 'function transfer(a,b,amt){ a.bal-=amt; b.bal+=amt }' },
        { id: 'health', text: 'app.get("/health", ()=> res.send("ok"))' },
      ]

phase('Review')
log(`Reviewing ${items.length} item(s) for security issues`)

const FINDING = {
  type: 'object',
  required: ['hasIssue', 'severity', 'summary'],
  properties: {
    hasIssue: { type: 'boolean' },
    severity: { type: 'string', enum: ['none', 'low', 'medium', 'high'] },
    summary: { type: 'string' },
  },
}

const VERDICT = {
  type: 'object',
  required: ['confirmed', 'reason'],
  properties: { confirmed: { type: 'boolean' }, reason: { type: 'string' } },
}

// Stage 1 reviews each item; stage 2 adversarially verifies only the items that
// reported an issue. pipeline() runs each item's chain independently (no barrier).
const results = await pipeline(
  items,
  (item) =>
    agent(
      `Review this code for a security vulnerability. Respond with the finding.\n\n${item.text}`,
      { label: `review:${item.id}`, phase: 'Review', schema: FINDING },
    ),
  (finding, item) => {
    if (!finding || !finding.hasIssue) return { item: item.id, confirmed: false, finding }
    return agent(
      `A reviewer claims this code has a ${finding.severity} issue: "${finding.summary}". ` +
        `Try to REFUTE it. Only confirm if the issue is genuinely exploitable.\n\n${item.text}`,
      { label: `verify:${item.id}`, phase: 'Verify', schema: VERDICT },
    ).then((v) => ({ item: item.id, confirmed: !!(v && v.confirmed), finding, verdict: v }))
  },
)

phase('Report')
const confirmed = results.filter((r) => r && r.confirmed)
log(`${confirmed.length}/${items.length} findings survived adversarial verification`)

return {
  audited: items.length,
  confirmed: confirmed.map((r) => ({ item: r.item, severity: r.finding.severity, summary: r.finding.summary })),
}

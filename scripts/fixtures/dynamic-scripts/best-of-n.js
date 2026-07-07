export const meta = {
  name: 'best-of-n',
  description:
    'Judge panel / best-of-N: draft a plan from several independent angles in parallel, score each with independent judges, then synthesize from the winner. Beats one-attempt-iterated when the solution space is wide.',
  phases: [{ title: 'Draft' }, { title: 'Judge' }, { title: 'Synthesize' }],
}

const question =
  typeof args?.question === 'string' && args.question.trim()
    ? args.question.trim()
    : 'How should a small team roll out feature flags to a monolith with no existing infra?'

// Three deliberately different framings so the drafts diverge.
const ANGLES = [
  { key: 'mvp', lens: 'the simplest thing that could possibly work first' },
  { key: 'risk', lens: 'what is most likely to go wrong and how to de-risk it' },
  { key: 'scale', lens: 'what this needs to look like at 10x the current size' },
]

phase('Draft')
log(`Drafting ${ANGLES.length} candidate plans from different angles`)
const drafts = await parallel(
  ANGLES.map((a) => () =>
    agent(`Propose a concrete plan for: ${question}\nFrame it around ${a.lens}. Keep it under 150 words.`, {
      label: `draft:${a.key}`,
      phase: 'Draft',
    }).then((text) => ({ angle: a.key, text })),
  ),
)

phase('Judge')
const SCORE = {
  type: 'object',
  required: ['score', 'rationale'],
  properties: { score: { type: 'number' }, rationale: { type: 'string' } },
}
const valid = drafts.filter((d) => d && d.text)
const scored = await parallel(
  valid.map((d) => () =>
    agent(
      `Score this plan from 0-10 on feasibility and completeness. Plan:\n${d.text}`,
      { label: `judge:${d.angle}`, phase: 'Judge', schema: SCORE },
    ).then((s) => ({ ...d, score: s ? Number(s.score) : 0, rationale: s?.rationale })),
  ),
)

const winner = scored.filter(Boolean).sort((a, b) => b.score - a.score)[0]
phase('Synthesize')
log(`Winner: ${winner?.angle} (score ${winner?.score}); synthesizing final answer`)
const final = await agent(
  `Write the final recommended plan for: ${question}\n` +
    `Base it on this winning draft, but graft in the best ideas from the others.\n` +
    `Winner (${winner?.angle}):\n${winner?.text}\n\n` +
    `Others:\n${scored.filter((d) => d && d.angle !== winner?.angle).map((d) => `- ${d.angle}: ${d.text}`).join('\n')}`,
  { label: 'synthesize', phase: 'Synthesize' },
)

return { question, winningAngle: winner?.angle, scores: scored.map((d) => ({ angle: d.angle, score: d.score })), final }

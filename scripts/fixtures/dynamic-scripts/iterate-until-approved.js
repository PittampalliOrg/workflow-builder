export const meta = {
  name: 'iterate-until-approved',
  description:
    'Generator/critic loop: a writer drafts, an independent critic approves or returns feedback, and the writer redrafts until approved or the round cap is hit (the "keep fixing until a check passes" shape). The critic — not the writer — holds completion authority.',
  phases: [{ title: 'Iterate' }],
}

const task =
  typeof args?.task === 'string' && args.task.trim()
    ? args.task.trim()
    : 'Write a one-paragraph release note for a change that adds rate limiting to the public API.'
const maxRounds = Number.isFinite(args?.maxRounds) ? Number(args.maxRounds) : 3

const REVIEW = {
  type: 'object',
  required: ['approved', 'feedback'],
  properties: { approved: { type: 'boolean' }, feedback: { type: 'string' } },
}

phase('Iterate')
let draft = null
let feedback = null
let round = 0
let approved = false

while (round < maxRounds && !approved) {
  round += 1
  const prompt =
    feedback == null
      ? `${task}`
      : `Revise the draft to address this critic feedback.\nFeedback: ${feedback}\n\nPrevious draft:\n${draft}`
  draft = await agent(prompt, { label: `write:round-${round}`, phase: 'Iterate' })

  const review = await agent(
    `You are a strict independent editor. Approve ONLY if the text fully satisfies: "${task}". ` +
      `Otherwise give one concrete fix. Draft:\n${draft}`,
    { label: `critic:round-${round}`, phase: 'Iterate', schema: REVIEW },
  )
  approved = !!(review && review.approved)
  feedback = review?.feedback ?? null
  log(`Round ${round}: ${approved ? 'APPROVED' : 'needs revision — ' + (feedback || '').slice(0, 60)}`)
}

return { task, approved, rounds: round, finalDraft: draft, lastFeedback: approved ? null : feedback }

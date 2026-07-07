export const meta = {
  name: 'discover-until-dry',
  description:
    'Loop-until-dry discovery: keep spawning finder agents in rounds, dedup each round against everything seen, and stop once N consecutive rounds surface nothing new (the "find issues until the list stops growing" shape). Simple count<N loops miss the tail.',
  phases: [{ title: 'Discover' }],
}

const topic =
  typeof args?.topic === 'string' && args.topic.trim()
    ? args.topic.trim()
    : 'ways a REST API can leak sensitive data in error responses'
const dryThreshold = Number.isFinite(args?.dryThreshold) ? Number(args.dryThreshold) : 2
const maxRounds = Number.isFinite(args?.maxRounds) ? Number(args.maxRounds) : 5

const BATCH = {
  type: 'object',
  required: ['items'],
  properties: { items: { type: 'array', items: { type: 'string' } } },
}

phase('Discover')
const seen = new Set()
const all = []
let dry = 0
let round = 0

while (dry < dryThreshold && round < maxRounds) {
  round += 1
  const known = all.length ? `\nAlready found (do NOT repeat these):\n- ${all.join('\n- ')}` : ''
  const batch = await agent(
    `List concrete, distinct items for: ${topic}. Return 2-4 items as short phrases.${known}`,
    { label: `find:round-${round}`, phase: 'Discover', schema: BATCH },
  )
  const items = (batch?.items || []).map((s) => String(s).trim()).filter(Boolean)
  // Dedup against EVERYTHING seen (not just this round) — the loop-until-dry invariant.
  const fresh = items.filter((s) => {
    const key = s.toLowerCase()
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
  if (fresh.length === 0) {
    dry += 1
  } else {
    dry = 0
    all.push(...fresh)
  }
  log(`Round ${round}: +${fresh.length} new (total ${all.length}, dry streak ${dry})`)
}

return { topic, rounds: round, stoppedDry: dry >= dryThreshold, count: all.length, items: all }

export const meta = {
  name: 'summarize-child',
  description:
    'Reusable child workflow: summarizes one source into a structured {title, points} object. Invoked on its own or via workflow() from a parent (one-level nesting).',
  phases: [{ title: 'Summarize' }],
}

const source =
  typeof args?.source === 'string' && args.source.trim() ? args.source.trim() : 'an unspecified topic'

phase('Summarize')
const SUMMARY = {
  type: 'object',
  required: ['title', 'points'],
  properties: { title: { type: 'string' }, points: { type: 'array', items: { type: 'string' } } },
}
const summary = await agent(
  `Summarize the key ideas of: ${source}. Return a short title and 2-3 bullet points.`,
  { label: 'summarize', phase: 'Summarize', schema: SUMMARY },
)

return { source, summary }

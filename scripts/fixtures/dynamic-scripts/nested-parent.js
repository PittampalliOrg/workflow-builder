export const meta = {
  name: 'nested-parent',
  description:
    'Composition via workflow(): fan out a reusable child workflow (summarize-child) over several sources — one nested run each — then synthesize across their structured returns. Demonstrates one-level nesting; the child cannot itself call workflow().',
  phases: [{ title: 'Summarize sources' }, { title: 'Synthesize' }],
}

const sources =
  Array.isArray(args?.sources) && args.sources.length
    ? args.sources
    : [
        'the trade-offs of monorepos versus polyrepos',
        'the trade-offs of REST versus gRPC for internal services',
      ]

// The child workflow must be saved as a dynamic-script workflow named 'summarize-child'.
const childRef = typeof args?.childRef === 'string' && args.childRef.trim() ? args.childRef.trim() : 'summarize-child'

phase('Summarize sources')
log(`Running the '${childRef}' child workflow for ${sources.length} source(s)`)
const summaries = await parallel(
  sources.map((s) => () =>
    workflow(childRef, { source: s }).then((r) => (r && r.summary ? r.summary : { title: s, points: [] })),
  ),
)

phase('Synthesize')
const valid = summaries.filter(Boolean)
const combined = valid
  .map((s) => `${s.title}: ${(s.points || []).join('; ')}`)
  .join('\n')
const synthesis = await agent(
  `These are summaries of related sources. Write a 2-3 sentence synthesis of the common themes.\n${combined}`,
  { label: 'synthesize', phase: 'Synthesize' },
)

return { childRef, sourceCount: sources.length, summaries: valid, synthesis }

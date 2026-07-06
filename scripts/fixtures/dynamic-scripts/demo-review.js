/**
 * Demo dynamic-script workflow (engineType `dynamic-script`).
 *
 * Exercises the three orchestration primitives across three phases:
 *   1. Review    — pipeline() over two dimensions (no barrier; per-item agent()).
 *   2. Verify    — parallel() verification agents with a small JSON schema (barrier).
 *   3. Summarize — one agent() consuming the accumulated results.
 *
 * Globals available in the sandbox: agent, parallel, pipeline, phase, log,
 * workflow, args, budget. Determinism is enforced by the evaluator (Date.now /
 * Math.random / timers / fetch are banned).
 */

export const meta = {
	name: 'Demo Review',
	description:
		'Three-phase review: analyze two dimensions, verify them in parallel, then summarize.',
	phases: [{ title: 'Review' }, { title: 'Verify' }, { title: 'Summarize' }]
};

const target = (args && args.target) || 'the target codebase';
const dimensions = ['correctness', 'readability'];

// Phase 1 — Review: pipeline maps each dimension through a review agent. No
// barrier: items stream through independently.
phase('Review');
log(`Reviewing ${target} across ${dimensions.length} dimensions`);
const reviews = await pipeline(dimensions, (dimension) =>
	agent(`Review ${target} for ${dimension}. Give 2-3 concrete, actionable findings.`, {
		label: `review:${dimension}`,
		phase: 'Review'
	})
);

// Phase 2 — Verify: parallel verification with a JSON schema (barrier — all
// verdicts resolve before Summarize starts). Schema'd calls return a parsed
// object (or null after max structured-output retries).
phase('Verify');
log('Verifying findings in parallel');
const verifySchema = {
	type: 'object',
	properties: {
		dimension: { type: 'string' },
		ok: { type: 'boolean' },
		issues: { type: 'array', items: { type: 'string' } }
	},
	required: ['dimension', 'ok'],
	additionalProperties: false
};
const verdicts = await parallel(
	dimensions.map((dimension, index) => () =>
		agent(
			`Verify this ${dimension} review and return JSON {dimension, ok, issues}. Review:\n${
				reviews[index] || '(no review produced)'
			}`,
			{ label: `verify:${dimension}`, phase: 'Verify', schema: verifySchema }
		)
	)
);

// Phase 3 — Summarize: one agent consumes everything.
phase('Summarize');
log('Summarizing the review');
const summary = await agent(
	`Write a short summary of the review of ${target}.\nReviews: ${JSON.stringify(
		reviews
	)}\nVerdicts: ${JSON.stringify(verdicts)}`,
	{ label: 'summary', phase: 'Summarize' }
);

return { target, dimensions, reviews, verdicts, summary };

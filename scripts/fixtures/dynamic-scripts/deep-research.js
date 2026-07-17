/**
 * deep-research — a dynamic-script mimic of Claude Code's built-in `deep-research`
 * workflow, running on the workflow-builder engine (Kimi K3 by default).
 *
 * Structure (built-in → our primitives):
 *   Plan       decompose the question into distinct angles      agent() + schema
 *   Research   multi-modal web sweep, one agent per sub-question parallel()  ← WebSearch + WebFetch
 *   Critique   completeness critic: "what's missing?"           agent() + schema
 *   (loop Research↔Critique until saturated / budget / maxRounds)
 *   Synthesize a sourced research brief                          agent()
 *
 * Our dapr-agent-py agents ship the Claude-Code tool set, so the research
 * agents do GENUINE web research via the WebSearch + WebFetch tools. When the
 * sandbox can't reach the network they fall back to model knowledge and say so.
 *
 * args: { question: string, breadth?: number (2-6, default 4),
 *         maxRounds?: number (1-5, default 3) }
 * Set a run budgetTotal to bound the loop (each round costs a few k tokens).
 */

export const meta = {
	name: 'deep-research',
	description:
		'Multi-round web research: decompose a question, research each sub-question in parallel with WebSearch + WebFetch, then a completeness critic finds gaps and drives another round until the topic is saturated (or the token budget runs low), then synthesizes a sourced brief. Mimics the built-in deep-research workflow.',
	phases: [{ title: 'Plan' }, { title: 'Research' }, { title: 'Critique' }, { title: 'Synthesize' }]
};

const question =
	typeof args?.question === 'string' && args.question.trim()
		? args.question.trim()
		: 'What are current best practices for rolling out feature flags in a monolith with no existing infrastructure?';
const breadth = Number.isFinite(args?.breadth) ? Math.max(2, Math.min(6, Number(args.breadth))) : 4;
const maxRounds = Number.isFinite(args?.maxRounds) ? Math.max(1, Math.min(5, Number(args.maxRounds))) : 3;

const SUBQ_SCHEMA = {
	type: 'object',
	required: ['subQuestions'],
	additionalProperties: false,
	properties: { subQuestions: { type: 'array', items: { type: 'string' } } }
};
const GAP_SCHEMA = {
	type: 'object',
	required: ['saturated', 'gaps'],
	additionalProperties: false,
	properties: {
		saturated: { type: 'boolean' },
		gaps: { type: 'array', items: { type: 'string' } }
	}
};

// Phase 1 — Plan: decompose into distinct, non-overlapping research angles.
phase('Plan');
log(`Planning research for: ${question}`);
const plan = await agent(
	`You are planning web research for this question:\n"${question}"\n\n` +
		`Break it into ${breadth} DISTINCT, non-overlapping sub-questions that together cover the topic well. ` +
		`Return JSON {subQuestions: string[]}.`,
	{ label: 'plan', phase: 'Plan', schema: SUBQ_SCHEMA }
);
let openQuestions = (plan?.subQuestions || []).map((s) => String(s)).slice(0, breadth);
if (!openQuestions.length) openQuestions = [question];

const findings = []; // { subQuestion, notes }
const seen = new Set();
let round = 0;

// Research ↔ Critique loop, bounded by maxRounds and (when set) the token budget.
while (round < maxRounds && openQuestions.length && (budget.total == null || budget.remaining() > 20000)) {
	round++;

	phase('Research');
	log(`Round ${round}: researching ${openQuestions.length} sub-question(s)`);
	const roundFindings = await parallel(
		openQuestions.map((sq) => () =>
			agent(
				`Research this sub-question:\n"${sq}"\n\n` +
					`Use the WebSearch tool for 1-2 focused queries, open the 1-2 most relevant results with WebFetch, ` +
					`and write a concise, SOURCED finding (include the URLs you actually used). ` +
					`If the web tools are unavailable, answer from your own knowledge and clearly say so. Max 130 words.`,
				{ label: `research:${sq.slice(0, 40)}`, phase: 'Research' }
			).then((notes) => ({ subQuestion: sq, notes: notes || '(no findings)' }))
		)
	);
	for (const f of roundFindings.filter(Boolean)) {
		findings.push(f);
		seen.add(f.subQuestion);
	}

	// Completeness critic — the "what's missing?" step that makes this DEEP.
	phase('Critique');
	const critique = await agent(
		`Original question: "${question}"\n\nResearch gathered so far:\n` +
			findings.map((f, i) => `${i + 1}. ${f.subQuestion}\n${f.notes}`).join('\n\n') +
			`\n\nIs this research SATURATED (the original question is now well-answered), or are there important GAPS still unaddressed? ` +
			`Return JSON {saturated: boolean, gaps: string[]}. List at most 3 gaps, phrased as NEW sub-questions not already covered above.`,
		{ label: `critique:r${round}`, phase: 'Critique', schema: GAP_SCHEMA }
	);
	if (!critique || critique.saturated) break;
	openQuestions = (critique.gaps || [])
		.map((g) => String(g))
		.filter((g) => g.trim() && !seen.has(g))
		.slice(0, 3);
}

// Final synthesis — grounded ONLY in what was gathered.
phase('Synthesize');
log(`Synthesizing across ${findings.length} finding(s) over ${round} round(s)`);
const brief = await agent(
	`Write a well-structured research brief that answers:\n"${question}"\n\n` +
		`Ground it ONLY in these findings, and cite the sources they mention:\n` +
		findings.map((f, i) => `${i + 1}. ${f.subQuestion}\n${f.notes}`).join('\n\n') +
		`\n\nEnd with a short "Open questions" section if anything remains uncertain.`,
	{ label: 'synthesize', phase: 'Synthesize' }
);

return {
	question,
	rounds: round,
	subQuestionsResearched: findings.map((f) => f.subQuestion),
	brief
};

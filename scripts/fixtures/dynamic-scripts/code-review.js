/**
 * code-review — a dynamic-script mimic of Claude Code's built-in `/code-review`
 * (and the heavier `ultrareview`) running on workflow-builder (Kimi K3 default).
 *
 * Structure (built-in → our primitives) — the canonical pipeline pattern:
 *   Review   one finder per review DIMENSION, in parallel     pipeline() stage 1 (schema'd findings)
 *   Verify   each finding faced by N adversarial skeptics      pipeline() stage 2: parallel(findings → parallel(refuters))
 *            who try to REFUTE it; a finding survives only on
 *            a majority "real" vote (kills plausible-but-wrong)
 *   Report   rank the SURVIVING findings by severity           agent()
 *
 * pipeline() gives per-dimension streaming: a dimension's findings start
 * verifying the moment that dimension's finder returns — no barrier.
 *
 * args: { code?: string, label?: string,
 *         dimensions?: [{key, lens}], verifyVotes?: number (1-3, default 2) }
 * With no `code`, it reviews a small built-in buggy sample so the demo is
 * self-contained. Agents review the code INLINE (no tools); pass file contents
 * or a diff via args.code, or adapt the finder prompt to use Read/Grep on a
 * mounted repo.
 */

export const meta = {
	name: 'code-review',
	description:
		'Multi-dimension code review with adversarial verification: parallel finders per dimension (correctness, security, performance, tests, readability), each finding independently challenged by skeptics that try to REFUTE it, keeping only majority-confirmed findings, then a severity-ranked report. Mimics the built-in /code-review workflow.',
	phases: [{ title: 'Review' }, { title: 'Verify' }, { title: 'Report' }]
};

const SAMPLE = [
	'function getActiveUser(req, db) {',
	'  var id = req.query.id;',
	'  var q = "SELECT * FROM users WHERE id = " + id;   // build query',
	'  var rows = db.execSync(q);',
	'  for (var i = 0; i <= rows.length; i++) {',
	'    if (rows[i].active) return rows[i];',
	'  }',
	'  return null;',
	'}'
].join('\n');

const code = typeof args?.code === 'string' && args.code.trim() ? args.code : SAMPLE;
const label = typeof args?.label === 'string' && args.label.trim() ? args.label.trim() : 'the sample function';
const verifyVotes = Number.isFinite(args?.verifyVotes) ? Math.max(1, Math.min(3, Number(args.verifyVotes))) : 2;
const DIMENSIONS =
	Array.isArray(args?.dimensions) && args.dimensions.length
		? args.dimensions
		: [
				{ key: 'correctness', lens: 'logic errors, off-by-one, null/undefined access, wrong conditions, resource leaks' },
				{ key: 'security', lens: 'injection, missing authz/validation, unsafe deserialization, secret handling, integer/underflow abuse' },
				{ key: 'performance', lens: 'needless O(n^2), repeated work, allocations in hot loops, N+1 queries' },
				{ key: 'tests', lens: 'missing edge cases, untested error paths, weak or missing assertions' },
				{ key: 'readability', lens: 'unclear names, dead code, tangled control flow, missing docs' }
			];

const FINDINGS_SCHEMA = {
	type: 'object',
	required: ['findings'],
	additionalProperties: false,
	properties: {
		findings: {
			type: 'array',
			items: {
				type: 'object',
				required: ['title', 'severity', 'detail'],
				additionalProperties: false,
				properties: {
					title: { type: 'string' },
					severity: { type: 'string', enum: ['low', 'medium', 'high'] },
					detail: { type: 'string' },
					line: { type: 'string' }
				}
			}
		}
	}
};
const VERDICT_SCHEMA = {
	type: 'object',
	required: ['real', 'reason'],
	additionalProperties: false,
	properties: { real: { type: 'boolean' }, reason: { type: 'string' } }
};

// Triple-backticks in a single-quoted string (avoids escaping inside a template).
const codeBlock =
	'\n\nCode under review (' + label + '):\n```\n' + code + '\n```\nReview the code above directly; do NOT use any tools.';

// Review → Verify pipeline: each dimension's findings begin verifying as soon as
// that dimension's finder returns (no barrier between the stages).
const perDimension = await pipeline(
	DIMENSIONS,
	(d) =>
		agent(
			`Review the code for ${String(d.key).toUpperCase()}. Look specifically for: ${d.lens}. ` +
				`Report 0-4 CONCRETE findings as JSON {findings:[{title, severity(low|medium|high), detail, line?}]}. ` +
				`Only real, actionable issues — an empty list is perfectly fine.${codeBlock}`,
			{ label: `review:${d.key}`, phase: 'Review', schema: FINDINGS_SCHEMA }
		).then((r) => ({ dimension: d.key, findings: (r?.findings || []) })),
	(review) =>
		parallel(
			review.findings.map((f) => () =>
				parallel(
					Array.from({ length: verifyVotes }, (_v, i) => () =>
						agent(
							`You are an adversarial reviewer. Try to REFUTE the following ${review.dimension} finding. ` +
								`If it is NOT a real, actionable issue in the code as written, answer real=false. Default to real=false if you are uncertain.\n\n` +
								`Finding: "${f.title}" — ${f.detail}${codeBlock}\n\nReturn JSON {real: boolean, reason: string}.`,
							{ label: `verify:${review.dimension}:${i}`, phase: 'Verify', schema: VERDICT_SCHEMA }
						)
					)
				).then((votes) => {
					const cast = votes.filter(Boolean);
					const realVotes = cast.filter((v) => v.real).length;
					return {
						...f,
						dimension: review.dimension,
						votesReal: realVotes,
						votesTotal: cast.length,
						confirmed: cast.length > 0 && realVotes > cast.length / 2
					};
				})
			)
		)
);

const all = perDimension.flat().filter(Boolean);
const confirmed = all.filter((f) => f.confirmed);
const sevRank = { high: 0, medium: 1, low: 2 };
confirmed.sort((a, b) => (sevRank[a.severity] ?? 3) - (sevRank[b.severity] ?? 3));

// Report — only the findings that survived adversarial verification.
phase('Report');
log(`Confirmed ${confirmed.length}/${all.length} findings; writing report`);
const report = await agent(
	`Write a concise code-review report for ${label}. Group the CONFIRMED findings by severity (most severe first), ` +
		`each with a one-line fix. If there are none, state the code is clean for the reviewed dimensions.\n\n` +
		`Confirmed findings:\n` +
		(confirmed.map((f) => `- [${f.severity}] (${f.dimension}) ${f.title}: ${f.detail}`).join('\n') || '(none)'),
	{ label: 'report', phase: 'Report' }
);

return {
	label,
	dimensionsReviewed: DIMENSIONS.map((d) => d.key),
	totalFindings: all.length,
	confirmedFindings: confirmed.length,
	droppedByVerification: all.length - confirmed.length,
	confirmed: confirmed.map((f) => ({
		dimension: f.dimension,
		severity: f.severity,
		title: f.title,
		votes: `${f.votesReal}/${f.votesTotal}`
	})),
	report
};

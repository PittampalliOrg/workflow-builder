import { error, json } from '@sveltejs/kit';
import { sql } from 'drizzle-orm';
import type { RequestHandler } from './$types';
import { db } from '$lib/server/db';
import { costFor, formatCurrency } from '$lib/server/pricing/model-pricing';

/**
 * GET /api/workflows/executions/[executionId]/metrics
 *
 * Authoritative aggregate metrics for ONE workflow run, summed across every
 * session it spawned. Tokens are aggregated directly from the run's
 * `agent.llm_usage` session events grouped by their reported `model` — the
 * SAME source the per-session SessionPulse uses, so the rollup is consistent
 * AND correct for every runtime (the server-side `sessions.usage` rollup is
 * not populated for CLI-family sessions, which would otherwise read zero).
 * Per-model cost uses the shared pricing table (`costFor`), as in
 * `/api/v1/cost`. Duration/status counts are derived by the caller from the
 * sessions list; live tokens/sec come from the execution SSE stream.
 */
export const GET: RequestHandler = async ({ params, locals }) => {
	if (!locals.session?.userId) return error(401, 'Authentication required');
	if (!db) return error(503, 'Database not configured');

	type Row = {
		model_spec: string | null;
		input_tokens: number;
		output_tokens: number;
		cache_read: number;
		cache_create: number;
	};

	// Aggregate from agent.llm_usage events of every session in this execution.
	// `input_tokens` is NET of cache reads (system invariant), matching costFor.
	const rows = await db.execute<Row>(sql`
		SELECT
			coalesce(se.data->>'model', se.data->>'providerModel', 'unknown') AS model_spec,
			coalesce(sum((se.data->>'input_tokens')::bigint), 0) AS input_tokens,
			coalesce(sum((se.data->>'output_tokens')::bigint), 0) AS output_tokens,
			coalesce(sum((se.data->>'cache_read_input_tokens')::bigint), 0) AS cache_read,
			coalesce(sum((se.data->>'cache_creation_input_tokens')::bigint), 0) AS cache_create
		FROM session_events se
		JOIN sessions s ON s.id = se.session_id
		WHERE s.workflow_execution_id = ${params.executionId}
			AND se.type = 'agent.llm_usage'
			${locals.session.projectId ? sql`AND s.project_id = ${locals.session.projectId}` : sql``}
		GROUP BY coalesce(se.data->>'model', se.data->>'providerModel', 'unknown')
	`);

	const totals = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreateTokens: 0 };
	let totalCost = 0;
	const byModel: Array<{
		model: string;
		inputTokens: number;
		outputTokens: number;
		cacheReadTokens: number;
		cacheCreateTokens: number;
		cost: number;
	}> = [];

	for (const row of rows) {
		const usage = {
			inputTokens: Number(row.input_tokens),
			outputTokens: Number(row.output_tokens),
			cacheReadTokens: Number(row.cache_read),
			cacheCreateTokens: Number(row.cache_create)
		};
		const cost = costFor(row.model_spec, usage);
		totalCost += cost;
		totals.inputTokens += usage.inputTokens;
		totals.outputTokens += usage.outputTokens;
		totals.cacheReadTokens += usage.cacheReadTokens;
		totals.cacheCreateTokens += usage.cacheCreateTokens;
		byModel.push({ model: row.model_spec ?? 'unknown', ...usage, cost });
	}

	byModel.sort((a, b) => b.cost - a.cost);

	const totalTokens =
		totals.inputTokens + totals.outputTokens + totals.cacheReadTokens + totals.cacheCreateTokens;
	const cacheablePrompt = totals.inputTokens + totals.cacheReadTokens;
	const cacheHitPct =
		cacheablePrompt > 0 ? Math.round((totals.cacheReadTokens / cacheablePrompt) * 100) : null;

	return json({
		totals: { ...totals, totalTokens },
		cacheHitPct,
		totalCost,
		totalCostLabel: formatCurrency(totalCost),
		byModel
	});
};

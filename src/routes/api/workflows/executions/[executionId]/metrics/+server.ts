import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getApplicationAdapters } from '$lib/server/application';
import { assertInScope } from '$lib/server/workflows/project-scope';
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

	const workflowData = getApplicationAdapters().workflowData;
	const execution = await workflowData.getExecutionById(params.executionId);
	assertInScope(execution, locals.session, 'Execution not found');
	const rows = await workflowData.aggregateExecutionUsageMetrics({
		executionId: params.executionId,
		projectId: locals.session.projectId,
		includeAncestors: true
	});

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
			inputTokens: row.inputTokens,
			outputTokens: row.outputTokens,
			cacheReadTokens: row.cacheReadTokens,
			cacheCreateTokens: row.cacheCreateTokens
		};
		const cost = costFor(row.modelSpec, usage);
		totalCost += cost;
		totals.inputTokens += usage.inputTokens;
		totals.outputTokens += usage.outputTokens;
		totals.cacheReadTokens += usage.cacheReadTokens;
		totals.cacheCreateTokens += usage.cacheCreateTokens;
		byModel.push({ model: row.modelSpec ?? 'unknown', ...usage, cost });
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

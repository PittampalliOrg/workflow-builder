import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getApplicationAdapters } from '$lib/server/application';
import { guardAnalystAccess } from '../guard';

/**
 * GET ?maxNodes= — compact span waterfall for the whole execution: a
 * name/service/duration/status hierarchy with repetitive siblings collapsed
 * and a hard node cap, so an analyst sees the run's SHAPE in one bounded
 * read before drilling with the span/LLM/tool/log tools.
 */
export const GET: RequestHandler = async ({ params, request, url }) => {
	const guard = await guardAnalystAccess(request, params.executionId);
	if (!guard.ok) return guard.res;
	const maxNodes = Math.min(800, Math.max(20, Number(url.searchParams.get('maxNodes')) || 300));
	const result = await getApplicationAdapters().workflowDiagnostics.getSpanTree({
		execution: guard.execution,
		maxNodes
	});
	return json(result.body, { status: result.httpStatus ?? 200 });
};

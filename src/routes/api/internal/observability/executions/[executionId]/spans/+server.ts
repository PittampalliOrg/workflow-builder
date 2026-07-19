import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getApplicationAdapters } from '$lib/server/application';
import { guardAnalystAccess } from '../guard';
import { decodePageCursor, encodePageCursor, pageCursorScope } from '../pagination';

/**
 * GET ?query=&errorsOnly=&limit= — search the run's connected spans by
 * substring over operation/service/status message + session id. Returns lean
 * rows (no attribute dumps) so the analyst's context stays small.
 */
export const GET: RequestHandler = async ({ params, request, url }) => {
	const guard = await guardAnalystAccess(request, params.executionId);
	if (!guard.ok) return guard.res;
	const query = (url.searchParams.get('query') ?? '').toLowerCase();
	const errorsOnly = url.searchParams.get('errorsOnly') === 'true';
	const limit = Math.min(100, Math.max(1, Number(url.searchParams.get('limit')) || 40));
	const cursorScope = pageCursorScope('spans', {
		executionId: guard.execution.id,
		query,
		errorsOnly,
		limit
	});
	const offset = decodePageCursor(url.searchParams.get('cursor'), cursorScope);
	if (offset == null) return json({ error: 'Invalid span cursor' }, { status: 400 });
	const result = await getApplicationAdapters().workflowDiagnostics.searchSpans({
		execution: guard.execution,
		query,
		errorsOnly,
		limit,
		offset,
		encodeCursor: (nextOffset) => encodePageCursor(nextOffset, cursorScope)
	});
	return json(result.body, { status: result.httpStatus ?? 200 });
};

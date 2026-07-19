import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getApplicationAdapters } from '$lib/server/application';
import { guardAnalystAccess } from '../guard';
import { decodePageCursor, encodePageCursor, pageCursorScope } from '../pagination';

/** GET ?spanId=&errorsOnly=&limit= — correlated logs for the run (optionally one span). */
export const GET: RequestHandler = async ({ params, request, url }) => {
	const guard = await guardAnalystAccess(request, params.executionId);
	if (!guard.ok) return guard.res;
	const spanId = url.searchParams.get('spanId');
	const query = url.searchParams.get('query')?.trim() || undefined;
	const errorsOnly = url.searchParams.get('errorsOnly') === 'true';
	const limit = Math.min(200, Math.max(1, Number(url.searchParams.get('limit')) || 50));
	const cursorScope = pageCursorScope('logs', {
		executionId: guard.execution.id,
		spanId: spanId ?? null,
		query: query ?? null,
		errorsOnly,
		limit
	});
	const offset = decodePageCursor(url.searchParams.get('cursor'), cursorScope);
	if (offset == null) return json({ error: 'Invalid log cursor' }, { status: 400 });
	const result = await getApplicationAdapters().workflowDiagnostics.searchLogs({
		execution: guard.execution,
		spanId: spanId ?? undefined,
		query,
		errorsOnly,
		limit,
		offset,
		encodeCursor: (nextOffset) => encodePageCursor(nextOffset, cursorScope)
	});
	return json(result.body, { status: result.httpStatus ?? 200 });
};

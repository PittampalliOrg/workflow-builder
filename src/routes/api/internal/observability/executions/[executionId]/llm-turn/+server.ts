import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getApplicationAdapters } from '$lib/server/application';
import { guardAnalystAccess } from '../guard';
import { decodePageCursor, encodePageCursor, pageCursorScope } from '../pagination';

/** Exact, bounded LLM transcript evidence for one span or child session. */
export const GET: RequestHandler = async ({ params, request, url }) => {
	const guard = await guardAnalystAccess(request, params.executionId);
	if (!guard.ok) return guard.res;
	const spanId = url.searchParams.get('spanId')?.trim() || undefined;
	const sessionId = url.searchParams.get('sessionId')?.trim() || undefined;
	if (Boolean(spanId) === Boolean(sessionId)) {
		return json({ error: 'Provide exactly one of spanId or sessionId' }, { status: 400 });
	}
	const requestedLimit = Math.min(3, Math.max(1, Number(url.searchParams.get('limit')) || 3));
	const limit = spanId ? 1 : requestedLimit;
	const cursorScope = pageCursorScope('llm-turns', {
		executionId: guard.execution.id,
		spanId: spanId ?? null,
		sessionId: sessionId ?? null,
		limit
	});
	const offset = decodePageCursor(url.searchParams.get('cursor'), cursorScope);
	if (offset == null) return json({ error: 'Invalid LLM-turn cursor' }, { status: 400 });
	const result = await getApplicationAdapters().workflowDiagnostics.getLlmTurns({
		execution: guard.execution,
		spanId,
		sessionId,
		limit,
		offset,
		encodeCursor: (nextOffset) => encodePageCursor(nextOffset, cursorScope)
	});
	return json(result.body, { status: result.httpStatus ?? 200 });
};

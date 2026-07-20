import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getApplicationAdapters } from '$lib/server/application';
import { guardAnalystAccess } from '../guard';
import { decodePageCursor, encodePageCursor, pageCursorScope } from '../pagination';

/**
 * GET ?spanId=&sessionId=&toolName=&errorsOnly=&limit= — bounded tool-call
 * evidence (curated obs.tool_spans): name, arguments, result, status per
 * call. The what-did-the-agent-actually-do view that flat span search can't
 * answer without N per-span drills.
 */
export const GET: RequestHandler = async ({ params, request, url }) => {
	const guard = await guardAnalystAccess(request, params.executionId);
	if (!guard.ok) return guard.res;
	const spanId = url.searchParams.get('spanId')?.trim() || undefined;
	const sessionId = url.searchParams.get('sessionId')?.trim() || undefined;
	const toolName = url.searchParams.get('toolName')?.trim() || undefined;
	const errorsOnly = url.searchParams.get('errorsOnly') === 'true';
	const limit = Math.min(50, Math.max(1, Number(url.searchParams.get('limit')) || 20));
	const cursorScope = pageCursorScope('tool-calls', {
		executionId: guard.execution.id,
		spanId: spanId ?? null,
		sessionId: sessionId ?? null,
		toolName: toolName ?? null,
		errorsOnly,
		limit
	});
	const offset = decodePageCursor(url.searchParams.get('cursor'), cursorScope);
	if (offset == null) return json({ error: 'Invalid tool-call cursor' }, { status: 400 });
	const result = await getApplicationAdapters().workflowDiagnostics.getToolCalls({
		execution: guard.execution,
		spanId,
		sessionId,
		toolName,
		errorsOnly,
		limit,
		offset,
		encodeCursor: (nextOffset) => encodePageCursor(nextOffset, cursorScope)
	});
	return json(result.body, { status: result.httpStatus ?? 200 });
};

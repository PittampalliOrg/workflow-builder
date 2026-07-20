import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getApplicationAdapters } from '$lib/server/application';
import {
	decodePageCursor,
	encodePageCursor,
	pageCursorScope
} from '$lib/server/application/diagnostic-pagination';

const PAGE_SIZE = 100;

/** Workspace-scoped compact span continuation for the run Trace UI. */
export const GET: RequestHandler = async ({ params, locals, url }) => {
	if (!locals.session?.userId) return error(401, 'Authentication required');
	const application = getApplicationAdapters();
	const context = await application.workflowData.getObservabilityServiceGraphContext({
		userId: locals.session.userId,
		projectId: locals.session.projectId ?? null,
		executionId: params.executionId
	});
	if (!context?.execution) return error(404, 'Execution not found');

	const cursorScope = pageCursorScope('public-execution-spans', {
		executionId: context.execution.id,
		query: '',
		errorsOnly: false,
		limit: PAGE_SIZE
	});
	const offset = decodePageCursor(url.searchParams.get('cursor'), cursorScope);
	if (offset == null) return json({ error: 'Invalid span cursor' }, { status: 400 });

	const result = await application.workflowDiagnostics.searchSpans({
		execution: context.execution,
		query: '',
		errorsOnly: false,
		limit: PAGE_SIZE,
		offset,
		encodeCursor: (nextOffset) => encodePageCursor(nextOffset, cursorScope)
	});
	return json(result.body, {
		status: result.httpStatus ?? 200,
		headers: { 'cache-control': 'no-store' }
	});
};

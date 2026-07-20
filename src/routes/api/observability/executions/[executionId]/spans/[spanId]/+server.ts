import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getApplicationAdapters } from '$lib/server/application';

/** Workspace-scoped span evidence for the run UI's selected execution. */
export const GET: RequestHandler = async ({ params, locals }) => {
	if (!locals.session?.userId) return error(401, 'Authentication required');
	const application = getApplicationAdapters();
	const context = await application.workflowData.getObservabilityServiceGraphContext({
		userId: locals.session.userId,
		projectId: locals.session.projectId ?? null,
		executionId: params.executionId
	});
	if (!context?.execution) return error(404, 'Execution not found');

	const result = await application.workflowDiagnostics.getSpan({
		execution: context.execution,
		spanId: params.spanId
	});
	return json(result.body, {
		status: result.httpStatus ?? 200,
		headers: { 'cache-control': 'no-store' }
	});
};

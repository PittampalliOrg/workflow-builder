import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getApplicationAdapters } from '$lib/server/application';

/**
 * GET /api/workflows/[workflowId]/executions
 *
 * Lists executions for a specific workflow from the database.
 *
 * Query params:
 *   include=summary (default) — drops input/output JSONB. Use for list views/polling.
 *   include=full — returns input/output. Use only when callers actually render them.
 */
export const GET: RequestHandler = async ({ params, url }) => {
	const { workflowId } = params;
	const limit = parseInt(url.searchParams.get('limit') || '20');
	const include = url.searchParams.get('include') === 'full' ? 'full' : 'summary';

	try {
		const executions = await getApplicationAdapters().workflowData.listWorkflowExecutions({
			workflowId,
			limit,
			include,
		});
		return json(executions);
	} catch (err) {
		console.error(`[Executions API] Error listing executions for ${workflowId}:`, err);
		return json([]);
	}
};

import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getApplicationAdapters } from '$lib/server/application';

/**
 * GET /api/workflows/executions/[executionId]/logs
 *
 * Returns normalized per-step logs for the execution.
 * Sources: workflowExecutionLogs table, then falls back to output.outputs from the execution record.
 */
export const GET: RequestHandler = async ({ params, locals }) => {
	const result = await getApplicationAdapters().workflowExecutionLogs.getLogs({
		executionId: params.executionId,
		userId: locals.session?.userId,
		projectId: locals.session?.projectId,
	});
	if (result.status === "error") {
		return error(result.httpStatus, result.message);
	}
	return json(result.body);
};

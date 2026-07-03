import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getApplicationAdapters } from '$lib/server/application';
import type { WorkflowExecutionControlResult } from '$lib/server/application/workflow-execution-control';

/**
 * GET /api/workflows/executions/[executionId]
 *
 * Returns the full execution row by id, including the input/output JSONB.
 * Used by callers (e.g. the runs panel) that have polled a summary list and
 * now need full detail for a specific row without re-pulling the whole list.
 */
export const GET: RequestHandler = async ({ params, locals }) => {
	const { executionId } = params;

	return workflowExecutionControlResponse(
		await getApplicationAdapters().workflowExecutionControl.getExecutionDetail({
			executionId,
			projectId: locals.session?.projectId ?? null,
			userId: locals.session?.userId ?? null,
		})
	);
};

function workflowExecutionControlResponse(result: WorkflowExecutionControlResult) {
	if (result.status === 'error') return error(result.httpStatus, result.message);
	return json(result.body, { status: result.httpStatus ?? 200 });
}

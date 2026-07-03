import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getApplicationAdapters } from '$lib/server/application';
import type { WorkflowExecutionControlResult } from '$lib/server/application/workflow-execution-control';

/**
 * GET /api/workflows/executions/[executionId]/status
 *
 * Returns the execution read model using the same shaping logic as the
 * realtime stream endpoint. This keeps the legacy status route aligned with
 * the new SSE-backed run page.
 */
export const GET: RequestHandler = async ({ params, url, locals }) => {
	const { executionId } = params;
	const includeAgentEvents = url.searchParams.get('includeAgentEvents') === 'true';

	return workflowExecutionControlResponse(
		await getApplicationAdapters().workflowExecutionControl.getExecutionStatus({
			executionId,
			includeAgentEvents,
			projectId: locals.session?.projectId ?? null,
			userId: locals.session?.userId ?? null
		})
	);
};

function workflowExecutionControlResponse(result: WorkflowExecutionControlResult) {
	if (result.status === 'error') return error(result.httpStatus, result.message);
	return json(result.body, { status: result.httpStatus ?? 200 });
}

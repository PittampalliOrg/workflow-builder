import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getApplicationAdapters } from '$lib/server/application';

/**
 * GET /api/workflows/executions/[executionId]/plan
 *
 * Fetches the plan content for an execution. The artifact table is the durable
 * source of truth; the dapr-agent-py state endpoint is retained as a legacy
 * fallback for older runs.
 */
export const GET: RequestHandler = async ({ params }) => {
	const { executionId } = params;
	return json(await getApplicationAdapters().workflowPlan.getExecutionPlan({ executionId }));
};

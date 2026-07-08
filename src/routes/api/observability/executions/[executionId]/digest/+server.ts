import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getApplicationAdapters } from '$lib/server/application';
import { buildRunDigestForExecution } from '$lib/server/observability/run-digest-loader';

/**
 * GET /api/observability/executions/[executionId]/digest
 *
 * Deterministic run digest (phases, totals, cache hit, critical path, budget,
 * issues) — zero LLM calls. Workspace-scoped like the service-graph route.
 */
export const GET: RequestHandler = async ({ params, locals }) => {
	if (!locals.session?.userId) return error(401, 'Authentication required');
	const context = await getApplicationAdapters().workflowData.getObservabilityServiceGraphContext({
		userId: locals.session.userId,
		projectId: locals.session.projectId ?? null,
		executionId: params.executionId
	});
	if (!context?.execution) return error(404, 'Execution not found');
	const digest = await buildRunDigestForExecution(context.execution);
	return json(digest);
};

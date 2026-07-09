import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getApplicationAdapters } from '$lib/server/application';
import { buildExecutionInvestigation } from '$lib/server/observability/investigation';
import { resolveExecutionTraceIds } from '$lib/server/otel/service-graph';

/**
 * GET /api/observability/executions/[executionId]/investigation
 *
 * Full investigation payload for a single workflow run. This is execution-scoped
 * like the service graph and digest routes, so dynamic-script runs do not depend
 * on a session.id scan to find their workflow trace.
 */
export const GET: RequestHandler = async ({ params, locals }) => {
	if (!locals.session?.userId) return error(401, 'Authentication required');

	const context = await getApplicationAdapters().workflowData.getObservabilityServiceGraphContext({
		userId: locals.session.userId,
		projectId: locals.session.projectId ?? null,
		executionId: params.executionId
	});
	if (!context?.execution) return error(404, 'Execution not found');

	try {
		const traceIds = await resolveExecutionTraceIds(context.execution);
		const payload = await buildExecutionInvestigation(params.executionId, traceIds);
		return json(payload);
	} catch (err) {
		return error(
			502,
			`Failed to build investigation payload: ${err instanceof Error ? err.message : String(err)}`
		);
	}
};

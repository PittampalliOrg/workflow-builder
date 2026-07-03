import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getApplicationAdapters } from '$lib/server/application';
import { buildExecutionInvestigation } from '$lib/server/observability/investigation';
import { resolveExecutionTraceIds } from '$lib/server/otel/service-graph';
import {
	filterInvestigationToSelection,
	selectionServiceScope
} from '$lib/server/observability/drilldown';
import { parseSelection, type ServiceGraphMode } from '$lib/types/service-graph';

/**
 * GET /api/observability/service-graph/drilldown?executionId=&sel=node:<id>|edge:<src>__<dst>&nodeKind=
 *
 * Returns an ObservabilityInvestigationPayload scoped to one graph node/edge of a
 * single execution, for the service-graph drill-down drawer. Reuses
 * buildSessionInvestigation (whole run) + filterInvestigationToSelection.
 */
export const GET: RequestHandler = async ({ url, locals }) => {
	if (!locals.session?.userId) return error(401, 'Authentication required');

	const executionId = url.searchParams.get('executionId');
	const sel = url.searchParams.get('sel');
	const nodeKind = url.searchParams.get('nodeKind');
	if (!executionId) return error(400, 'executionId is required');

	const selection = parseSelection(sel, nodeKind);
	if (!selection) return error(400, 'Invalid or missing sel');
	const mode = (url.searchParams.get('mode') as ServiceGraphMode) === 'step' ? 'step' : 'service';

	const context = await getApplicationAdapters().workflowData.getObservabilityServiceGraphContext({
		userId: locals.session.userId,
		projectId: locals.session.projectId ?? null,
		executionId
	});
	if (!context?.execution) {
		return error(404, 'Execution not found');
	}

	try {
		const traceIds = await resolveExecutionTraceIds(context.execution);
		const serviceScope = selectionServiceScope(selection, mode) ?? undefined;
		const full = await buildExecutionInvestigation(executionId, traceIds, serviceScope);
		const scoped = filterInvestigationToSelection(full, selection);
		return json(scoped);
	} catch (err) {
		return error(502, `Failed to build drill-down: ${err instanceof Error ? err.message : String(err)}`);
	}
};

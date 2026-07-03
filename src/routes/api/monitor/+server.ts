import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { daprFetch, getOrchestratorUrl } from '$lib/server/dapr-client';
import { getApplicationAdapters } from '$lib/server/application';
import type { WorkflowMonitorFallbackExecutionReadModel } from '$lib/server/application/ports';

/**
 * GET /api/monitor
 *
 * List workflow instances. Tries the orchestrator first, falls back to DB.
 * Query params: limit (default 50), status (optional filter)
 */
export const GET: RequestHandler = async ({ url }) => {
	const limit = parseInt(url.searchParams.get('limit') || '50');
	const statusFilter = url.searchParams.get('status');

	// Try orchestrator first
	try {
		const orchestratorUrl = getOrchestratorUrl();
		const params = new URLSearchParams({ limit: String(limit) });
		if (statusFilter) params.set('status', statusFilter);

		const response = await daprFetch(
			`${orchestratorUrl}/api/v2/workflows?${params.toString()}`,
			{ method: 'GET', maxRetries: 1 }
		);

		if (response.ok) {
			const data = await response.json();
			return json(data);
		}
	} catch {
		// Orchestrator unavailable, fall through to DB
	}

	// Fallback: query workflow execution read model through workflow-data.
	let result: WorkflowMonitorFallbackExecutionReadModel[];
	try {
		result = await getApplicationAdapters().workflowData.listWorkflowMonitorFallbackExecutions({
			limit,
		});
	} catch {
		return json([]);
	}

	// Normalize to a consistent shape
	const normalized = result.map((row) => ({
		instanceId: row.instanceId || row.id,
		workflowId: row.workflowId,
		workflowName: row.workflowName || 'Unknown',
		status: row.status,
		phase: row.phase,
		progress: row.progress,
		startedAt: row.startedAt,
		completedAt: row.completedAt,
		duration: row.duration
	}));

	return json(normalized);
};

import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { daprFetch, getOrchestratorUrl } from '$lib/server/dapr-client';
import { db } from '$lib/server/db';
import { workflowExecutions, workflows } from '$lib/server/db/schema';
import { desc, eq } from 'drizzle-orm';

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

	// Fallback: query workflowExecutions table
	if (!db) return json([]);

	const result = await db
		.select({
			id: workflowExecutions.id,
			instanceId: workflowExecutions.daprInstanceId,
			workflowId: workflowExecutions.workflowId,
			workflowName: workflows.name,
			status: workflowExecutions.status,
			phase: workflowExecutions.phase,
			progress: workflowExecutions.progress,
			startedAt: workflowExecutions.startedAt,
			completedAt: workflowExecutions.completedAt,
			duration: workflowExecutions.duration
		})
		.from(workflowExecutions)
		.leftJoin(workflows, eq(workflowExecutions.workflowId, workflows.id))
		.orderBy(desc(workflowExecutions.startedAt))
		.limit(limit);

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

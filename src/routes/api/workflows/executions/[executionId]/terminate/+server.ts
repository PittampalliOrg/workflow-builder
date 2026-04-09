import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { and, eq, inArray } from 'drizzle-orm';
import { daprFetch, getOrchestratorUrl } from '$lib/server/dapr-client';
import { db } from '$lib/server/db';
import { workflowAgentRuns, workflowExecutions } from '$lib/server/db/schema';

/**
 * POST /api/workflows/executions/[executionId]/terminate
 *
 * Terminates a running workflow execution by proxying
 * to the Dapr orchestrator terminate endpoint.
 */
export const POST: RequestHandler = async ({ params, request }) => {
	const { executionId } = params;
	if (!db) {
		throw error(503, { message: 'Database not configured' });
	}

	let body: Record<string, unknown> = {};
	try {
		body = await request.json();
	} catch {
		// No body is fine
	}

	const reason =
		typeof body?.reason === 'string' && body.reason.trim()
			? body.reason.trim()
			: undefined;

	const orchestratorUrl = getOrchestratorUrl();
	const [execution] = await db
		.select({
			id: workflowExecutions.id,
			daprInstanceId: workflowExecutions.daprInstanceId
		})
		.from(workflowExecutions)
		.where(eq(workflowExecutions.id, executionId))
		.limit(1);

	if (!execution) {
		throw error(404, { message: 'Execution not found' });
	}

	const instanceId = execution.daprInstanceId || execution.id;

	const response = await daprFetch(
		`${orchestratorUrl}/api/v2/workflows/${instanceId}/terminate`,
		{
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ reason })
		}
	);

	if (!response.ok) {
		const errorBody = await response.json().catch(() => ({ error: 'Unknown error' }));
		throw error(response.status, {
			message: errorBody.error ?? errorBody.message ?? 'Failed to terminate execution'
		});
	}

	const result = await response.json();
	const completedAt = new Date();

	await db
		.update(workflowExecutions)
		.set({
			status: 'cancelled',
			completedAt
		})
		.where(eq(workflowExecutions.id, executionId));

	await db
		.update(workflowAgentRuns)
		.set({
			status: 'cancelled',
			completedAt,
			updatedAt: completedAt,
			error: reason ?? 'Execution terminated by user'
		})
		.where(
			and(
				eq(workflowAgentRuns.workflowExecutionId, executionId),
				inArray(workflowAgentRuns.status, ['scheduled', 'running'])
			)
		);

	return json({
		success: result.success ?? true,
		executionId,
		instanceId: result.instanceId ?? instanceId
	});
};

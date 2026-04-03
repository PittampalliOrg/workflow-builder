import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { daprFetch, getOrchestratorUrl } from '$lib/server/dapr-client';

/**
 * POST /api/workflows/executions/[executionId]/terminate
 *
 * Terminates a running workflow execution by proxying
 * to the Dapr orchestrator terminate endpoint.
 */
export const POST: RequestHandler = async ({ params, request }) => {
	const { executionId } = params;

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

	const response = await daprFetch(
		`${orchestratorUrl}/api/workflows/${executionId}/terminate`,
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

	return json({
		success: result.success ?? true,
		executionId,
		instanceId: result.instanceId ?? null
	});
};

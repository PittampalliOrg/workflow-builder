import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { daprFetch, getOrchestratorUrl } from '$lib/server/dapr-client';

/**
 * GET /api/orchestrator/workflows/[id]
 *
 * Get workflow instance details from the orchestrator.
 */
export const GET: RequestHandler = async ({ params }) => {
	const { id } = params;
	const orchestratorUrl = getOrchestratorUrl();

	const response = await daprFetch(`${orchestratorUrl}/api/workflows/${id}`, {
		method: 'GET'
	});

	if (!response.ok) {
		const errorBody = await response.json().catch(() => ({ error: 'Unknown error' }));
		throw error(response.status, {
			message: errorBody.error ?? errorBody.message ?? 'Failed to get workflow instance'
		});
	}

	const result = await response.json();
	return json(result);
};

/**
 * DELETE /api/orchestrator/workflows/[id]
 *
 * Purge a workflow instance from the orchestrator.
 */
export const DELETE: RequestHandler = async ({ params, url }) => {
	const { id } = params;
	const orchestratorUrl = getOrchestratorUrl();

	const force = url.searchParams.get('force') === 'true';
	const recursive = url.searchParams.get('recursive') === 'true';

	const queryParams = new URLSearchParams();
	if (force) queryParams.set('force', 'true');
	if (recursive) queryParams.set('recursive', 'true');
	const query = queryParams.toString();

	const response = await daprFetch(
		`${orchestratorUrl}/api/workflows/${id}${query ? `?${query}` : ''}`,
		{ method: 'DELETE' }
	);

	if (!response.ok) {
		const errorBody = await response.json().catch(() => ({ error: 'Unknown error' }));
		throw error(response.status, {
			message: errorBody.error ?? errorBody.message ?? 'Failed to purge workflow instance'
		});
	}

	const result = await response.json();
	return json(result);
};

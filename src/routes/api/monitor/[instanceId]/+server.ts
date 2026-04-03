import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { daprFetch, getOrchestratorUrl } from '$lib/server/dapr-client';

/**
 * GET /api/monitor/[instanceId]
 *
 * Get detailed status for a specific workflow instance from the orchestrator.
 */
export const GET: RequestHandler = async ({ params }) => {
	const { instanceId } = params;
	const orchestratorUrl = getOrchestratorUrl();

	try {
		const response = await daprFetch(
			`${orchestratorUrl}/api/v2/workflows/${instanceId}/status`,
			{ method: 'GET' }
		);

		if (!response.ok) {
			const errorBody = await response.json().catch(() => ({ error: 'Orchestrator error' }));
			return error(response.status, {
				message: errorBody.error ?? errorBody.message ?? 'Failed to get instance status'
			});
		}

		const data = await response.json();
		return json(data);
	} catch (err) {
		return error(502, {
			message: `Failed to reach orchestrator: ${err instanceof Error ? err.message : 'unknown error'}`
		});
	}
};

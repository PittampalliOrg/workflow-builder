import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { daprFetch, getOrchestratorUrl } from '$lib/server/dapr-client';

/**
 * POST /api/orchestrator/workflows
 *
 * Start a workflow via the orchestrator service.
 * Proxies the full request body to the orchestrator's workflow start endpoint.
 */
export const POST: RequestHandler = async ({ request }) => {
	const body = await request.json();
	const orchestratorUrl = getOrchestratorUrl();

	const response = await daprFetch(`${orchestratorUrl}/api/v2/sw-workflows`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify(body)
	});

	if (!response.ok) {
		const errorBody = await response.json().catch(() => ({ error: 'Orchestrator error' }));
		throw error(response.status, {
			message: errorBody.error ?? errorBody.message ?? 'Failed to start workflow'
		});
	}

	const result = await response.json();
	return json(result);
};

/**
 * GET /api/orchestrator/workflows
 *
 * List active workflows from the orchestrator.
 */
export const GET: RequestHandler = async ({ url }) => {
	const orchestratorUrl = getOrchestratorUrl();
	const queryString = url.searchParams.toString();
	const fullUrl = `${orchestratorUrl}/api/v2/workflows${queryString ? `?${queryString}` : ''}`;

	const response = await daprFetch(fullUrl, { method: 'GET' });

	if (!response.ok) {
		const errorBody = await response.json().catch(() => ({ error: 'Orchestrator error' }));
		throw error(response.status, {
			message: errorBody.error ?? errorBody.message ?? 'Failed to list workflows'
		});
	}

	const result = await response.json();
	return json(result);
};

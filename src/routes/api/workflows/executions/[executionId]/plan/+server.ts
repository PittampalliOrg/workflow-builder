import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';

/**
 * GET /api/workflows/executions/[executionId]/plan
 *
 * Fetches the plan content from dapr-agent-py via Dapr service invocation.
 * The agent persists plans at key "plan:{executionId}" in its state store
 * and exposes them via GET /plan/{executionId}.
 */
export const GET: RequestHandler = async ({ params }) => {
	const { executionId } = params;

	const DAPR_HOST = process.env.DAPR_HOST || '127.0.0.1';
	const DAPR_HTTP_PORT = process.env.DAPR_HTTP_PORT || '3500';

	try {
		// Use Dapr service invocation to call dapr-agent-py's /plan endpoint
		// This works regardless of state store scoping since we invoke the service directly
		const invokeUrl = `http://${DAPR_HOST}:${DAPR_HTTP_PORT}/v1.0/invoke/dapr-agent-py/method/plan/${encodeURIComponent(executionId)}`;
		const res = await fetch(invokeUrl, {
			headers: { 'Content-Type': 'application/json' }
		});

		if (!res.ok) {
			return json({ plan: null });
		}

		const data = await res.json();
		return json({ plan: data.plan ?? null });
	} catch {
		return json({ plan: null });
	}
};

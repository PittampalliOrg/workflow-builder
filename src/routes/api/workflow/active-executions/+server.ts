import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getApplicationAdapters } from '$lib/server/application';

/**
 * GET /api/workflow/active-executions
 *
 * Returns executions with status "pending" or "running" for the authenticated user.
 * Security: Session auth (cookie or Bearer token).
 */
export const GET: RequestHandler = async ({ request, cookies }) => {
	try {
		const adapters = getApplicationAdapters();
		const session = await adapters.authSession.getSession({ request, cookies });
		if (!session) {
			return error(401, 'Unauthorized');
		}

		return json(
			await adapters.workflowData.listActiveWorkflowExecutionsForUser(
				session.user.id
			)
		);
	} catch (err) {
		if (err instanceof Error && err.message === 'Database not configured') {
			return error(503, 'Database not configured');
		}
		console.error('Failed to fetch active executions:', err);
		return json({ error: 'Internal server error' }, { status: 500 });
	}
};

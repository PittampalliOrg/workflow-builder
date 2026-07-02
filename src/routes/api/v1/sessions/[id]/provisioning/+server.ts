import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getApplicationAdapters } from '$lib/server/application';

/**
 * GET /api/v1/sessions/[id]/provisioning
 *
 * Sandbox-provisioning phase + timeline for a session (admitted → scheduling →
 * pulling → initializing → starting → running, with durations). Prefers the
 * capacity-observer's richer projection, falling back to a direct-pod read.
 * Lets the Live view explain the gap before the agent emits its first event.
 * Terminal/running sessions return phase=running (provisioning is over).
 */
export const GET: RequestHandler = async ({ params, locals }) => {
	if (!locals.session?.userId) return error(401, 'Authentication required');

	const result = await getApplicationAdapters().workflowData.getSessionProvisioningReadModel({
		sessionId: params.id,
		projectId: locals.session.projectId ?? null
	});
	if (result.status === 'not_found') return error(404, 'Session not found');
	return json(result.data);
};

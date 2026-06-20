import { error, json } from '@sveltejs/kit';
import { and, eq } from 'drizzle-orm';
import type { RequestHandler } from './$types';
import { db } from '$lib/server/db';
import { sessions } from '$lib/server/db/schema';
import { getSessionProvisioning } from '$lib/server/sessions/provisioning';

/**
 * GET /api/v1/sessions/[id]/provisioning
 *
 * Coarse sandbox-provisioning phase for a session (queued → scheduling →
 * pulling → initializing → starting → running), read from the session's pod.
 * Lets the Live view explain the gap before the agent emits its first event.
 * Terminal/running sessions return phase=running (provisioning is over).
 */
export const GET: RequestHandler = async ({ params, locals }) => {
	if (!locals.session?.userId) return error(401, 'Authentication required');
	if (!db) return error(503, 'Database not available');

	const conditions = [eq(sessions.id, params.id)];
	if (locals.session.projectId) conditions.push(eq(sessions.projectId, locals.session.projectId));

	const [row] = await db
		.select({ id: sessions.id, status: sessions.status })
		.from(sessions)
		.where(and(...conditions))
		.limit(1);

	if (!row) return error(404, 'Session not found');

	// Once the session is live or finished, provisioning is no longer the story.
	if (row.status === 'running' || row.status === 'idle' || row.status === 'terminated') {
		return json({
			phase: 'running',
			label: row.status === 'terminated' ? 'Ended' : 'Sandbox ready',
			detail: null,
			podName: null,
			podPhase: null
		});
	}

	const provisioning = await getSessionProvisioning(params.id);
	return json(provisioning);
};

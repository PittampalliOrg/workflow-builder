import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getApplicationAdapters } from '$lib/server/application';

/**
 * GET /api/v1/sessions/[id]/goal-flow — the goal-evaluator flow for a session,
 * segmented into attempts + verdicts (same model the trace viewer renders).
 * Returns `{ goalFlow: null }` when the session has no goal.
 */
export const GET: RequestHandler = async ({ params, locals }) => {
	if (!locals.session?.userId) return error(401, 'Authentication required');
	const result = await getApplicationAdapters().workflowData.getSessionGoalFlow({
		sessionId: params.id,
		projectId: locals.session.projectId ?? null,
		userId: locals.session.userId,
	});
	if (result.status === 'not_found') return error(404, 'Session not found');
	return json({ goalFlow: result.goalFlow });
};

import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getSession } from '$lib/server/sessions/registry';
import { isResourceInScope } from '$lib/server/workflows/project-scope';
import { buildGoalFlow } from '$lib/server/observability/goal-flow';

/**
 * GET /api/v1/sessions/[id]/goal-flow — the goal-evaluator flow for a session,
 * segmented into attempts + verdicts (same model the trace viewer renders).
 * Returns `{ goalFlow: null }` when the session has no goal.
 */
export const GET: RequestHandler = async ({ params, locals }) => {
	if (!locals.session?.userId) return error(401, 'Authentication required');
	const session = await getSession(params.id);
	if (!session) return error(404, 'Session not found');
	if (
		'projectId' in session &&
		'userId' in session &&
		!isResourceInScope(
			{ projectId: (session as { projectId: string | null }).projectId, userId: (session as { userId: string }).userId },
			locals.session,
		)
	) {
		return error(404, 'Session not found');
	}
	const goalFlow = await buildGoalFlow([params.id]);
	return json({ goalFlow });
};

import type { RequestHandler } from './$types';
import { error, json } from '@sveltejs/kit';

import { getApplicationAdapters } from '$lib/server/application';

/**
 * Compact runtime-flags read for the session detail page. Tells the UI
 *  - whether the agent has a browser sidecar at all (gates the Browser
 *    state panel),
 *  - whether the Browser state panel can render right now (pod Active +
 *    chromium + playwright-mcp ready),
 *  - whether the Shell tab is available (pod Active — shell works for
 *    any runtime pod, not just browser ones), and
 *  - which container names the shell dropdown should offer.
 *
 * Polled every 10s by the session page — cheap enough to not warrant
 * caching. Workspace-scoped via locals.session.projectId.
 */
export const GET: RequestHandler = async ({ params, locals }) => {
	if (!locals.session?.userId) return error(401, 'Authentication required');

	const sessionId = params.id!;
	const flags = await getApplicationAdapters().workflowData.getSessionRuntimeFlags({
		sessionId,
		projectId: locals.session.projectId ?? null,
		userId: locals.session.userId,
	});
	if (!flags) return error(404, 'Session not found in workspace');

	return json(flags);
};

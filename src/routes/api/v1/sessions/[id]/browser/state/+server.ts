import type { RequestHandler } from './$types';
import { error, json } from '@sveltejs/kit';

import { getApplicationAdapters } from '$lib/server/application';

/** Metadata companion to /browser/screenshot — returns URL/title/console.
 * Polled at ~2s cadence by the Browser state panel. */
export const GET: RequestHandler = async ({ params, locals }) => {
	if (!locals.session?.userId) return error(401, 'Authentication required');

	const sessionId = params.id!;
	const result = await getApplicationAdapters().sessionBrowser.getState({
		sessionId,
		projectId: locals.session.projectId,
	});
	if (result.status === 'not_found') return error(404, 'Session not found in workspace');
	if (result.status === 'not_ready') return error(503, 'Browser not ready');

	return json(result.data);
};

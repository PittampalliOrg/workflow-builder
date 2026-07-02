import type { RequestHandler } from './$types';
import { error } from '@sveltejs/kit';

import { getApplicationAdapters } from '$lib/server/application';

/**
 * Polled by the Browser state panel (~1 fps). Returns a raw JPEG the UI
 * can render in an <img> without base64 overhead. Workspace-scoped via
 * locals.session.projectId.
 */
export const GET: RequestHandler = async ({ params, locals }) => {
	if (!locals.session?.userId) return error(401, 'Authentication required');

	const sessionId = params.id!;
	const result = await getApplicationAdapters().sessionBrowser.takeScreenshot({
		sessionId,
		projectId: locals.session.projectId,
	});
	if (result.status === 'not_found') return error(404, 'Session not found in workspace');
	if (result.status === 'not_ready') return error(503, 'Browser not ready');

	const body = new Uint8Array(result.data.jpeg);
	return new Response(body, {
		headers: {
			'content-type': result.data.contentType,
			'cache-control': 'no-store, max-age=0',
			'content-length': String(body.byteLength),
		},
	});
};

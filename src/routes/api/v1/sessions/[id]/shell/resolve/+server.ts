import type { RequestHandler } from './$types';
import { error, json } from '@sveltejs/kit';

import { getApplicationAdapters } from '$lib/server/application';
import type { SessionRuntimeAccessResult } from '$lib/server/application/session-runtime-access';

/**
 * Preflight for the prod shell WS proxy (src/server-prod.js). Validates
 * the user's cookie + workspace scope + container allow-list, then
 * returns the live pod's name/namespace so server-prod.js can open a
 * raw Kubernetes pods/exec WebSocket.
 *
 * Dev mode goes through ws-kube-exec-proxy.ts directly (ssrLoadModule
 * in vite.config.ts) so this endpoint exists only to keep the prod
 * wrapper thin.
 */
export const POST: RequestHandler = async ({ params, url, locals }) => {
	if (!locals.session?.userId) return error(401, 'Authentication required');

	const container = url.searchParams.get('container') ?? 'chromium';
	return sessionRuntimeAccessResponse(
		await getApplicationAdapters().sessionRuntimeAccess.resolveShell({
			sessionId: params.id!,
			projectId: locals.session.projectId ?? null,
			userId: locals.session.userId,
			container,
		}),
	);
};

function sessionRuntimeAccessResponse(result: SessionRuntimeAccessResult) {
	if (result.status === 'error') return error(result.httpStatus, result.message);
	return json(result.body);
}

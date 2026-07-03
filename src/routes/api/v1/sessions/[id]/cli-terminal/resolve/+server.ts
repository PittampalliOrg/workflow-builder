import type { RequestHandler } from './$types';
import { error, json } from '@sveltejs/kit';

import { getApplicationAdapters } from '$lib/server/application';
import type { SessionRuntimeAccessResult } from '$lib/server/application/session-runtime-access';

/**
 * Preflight for the CLI-terminal WS proxy (server-prod.js +
 * ws-cli-terminal-proxy.ts). Validates the user's cookie/JWT + workspace
 * scope, gates on the session runtime's `interactiveTerminal` capability,
 * and returns the live per-session pod's IP + the cli-agent-py host port so
 * the proxy can open `ws://{podIp}:8002/terminal/{terminalId}` with the
 * INTERNAL_API_TOKEN header. Token-less response by design — the internal
 * token is attached server-side by the proxy, never sent to the browser.
 */
export const POST: RequestHandler = async ({ params, locals }) => {
	if (!locals.session?.userId) return error(401, 'Authentication required');

	return sessionRuntimeAccessResponse(
		await getApplicationAdapters().sessionRuntimeAccess.resolveCliTerminal({
			sessionId: params.id!,
			projectId: locals.session.projectId ?? null,
			userId: locals.session.userId,
		}),
	);
};

function sessionRuntimeAccessResponse(result: SessionRuntimeAccessResult) {
	if (result.status === 'error') return error(result.httpStatus, result.message);
	return json(result.body);
}

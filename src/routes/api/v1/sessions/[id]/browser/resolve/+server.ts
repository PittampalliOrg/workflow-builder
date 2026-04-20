import type { RequestHandler } from './$types';
import { error, json } from '@sveltejs/kit';
import { and, eq } from 'drizzle-orm';

import { db } from '$lib/server/db';
import { agents, sessions } from '$lib/server/db/schema';
import { getAgentRuntimePodIP } from '$lib/server/kube/client';

/**
 * Internal resolver for the live browser WS proxy. The production upgrade
 * handler in server-prod.js calls this endpoint to (a) authenticate the
 * caller via their session cookie, (b) resolve the session -> agent slug,
 * and (c) look up the agent-runtime pod's IP. The proxy then dials
 * <podIP>:5901 directly and pipes the client WebSocket.
 *
 * Returning a 4xx here causes the WS upgrade to close with the same status,
 * so the client sees a clean error instead of a generic 1006. We do not
 * leak pod identity cross-workspace: when the caller has an active
 * projectId, we only resolve agents belonging to that project.
 */
export const POST: RequestHandler = async ({ params, locals }) => {
	if (!locals.session?.userId) return error(401, 'Authentication required');
	if (!db) return error(500, 'Database not configured');

	const sessionId = params.id!;
	const rows = await db
		.select({ slug: agents.slug })
		.from(sessions)
		.innerJoin(agents, eq(agents.id, sessions.agentId))
		.where(
			and(
				eq(sessions.id, sessionId),
				locals.session.projectId
					? eq(agents.projectId, locals.session.projectId)
					: undefined,
			),
		)
		.limit(1);
	if (rows.length === 0) return error(404, 'Session not found in workspace');

	const podIP = await getAgentRuntimePodIP(rows[0].slug);
	if (!podIP) return error(503, 'Agent browser is not ready');

	return json({ podIP, slug: rows[0].slug });
};

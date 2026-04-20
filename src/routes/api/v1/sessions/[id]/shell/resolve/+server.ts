import type { RequestHandler } from './$types';
import { error, json } from '@sveltejs/kit';
import { and, eq } from 'drizzle-orm';

import { db } from '$lib/server/db';
import { agents, sessions } from '$lib/server/db/schema';
import { getAgentRuntimePod } from '$lib/server/kube/client';

const ALLOWED_CONTAINERS = new Set(['chromium', 'playwright-mcp', 'dapr-agent-py']);

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
	if (!db) return error(500, 'Database not configured');

	const container = url.searchParams.get('container') ?? 'chromium';
	if (!ALLOWED_CONTAINERS.has(container)) return error(400, 'Invalid container');

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

	const pod = await getAgentRuntimePod(rows[0].slug);
	if (!pod) return error(503, 'Agent pod not running');
	if (!pod.containers.some((c) => c.name === container && c.ready)) {
		return error(503, `${container} container not ready`);
	}

	return json({ pod: pod.name, namespace: pod.namespace, container });
};

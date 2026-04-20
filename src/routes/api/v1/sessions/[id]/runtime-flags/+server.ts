import type { RequestHandler } from './$types';
import { error, json } from '@sveltejs/kit';
import { and, eq } from 'drizzle-orm';

import { db } from '$lib/server/db';
import { agents, sessions } from '$lib/server/db/schema';
import { getAgentRuntime } from '$lib/server/kube/client';

/**
 * Compact runtime-flags read for the session detail page. Tells the UI
 * whether this session's agent has a browser sidecar at all, and whether
 * the Live browser tab can connect right now (pod phase == Active).
 *
 * Polled every 10s by the session page — cheap enough to not warrant
 * caching. Workspace-scoped via locals.session.projectId.
 */
export const GET: RequestHandler = async ({ params, locals }) => {
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

	const slug = rows[0].slug;
	const cr = await getAgentRuntime(slug);
	const browserSidecarEnabled = cr?.spec?.browserSidecar?.enabled === true;
	const phase = cr?.status?.phase ?? 'Unknown';
	const liveBrowserAvailable = browserSidecarEnabled && phase === 'Active';

	return json({
		agentSlug: slug,
		browserSidecarEnabled,
		liveBrowserAvailable,
		phase,
	});
};

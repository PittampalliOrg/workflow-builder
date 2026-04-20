import type { RequestHandler } from './$types';
import { error, json } from '@sveltejs/kit';
import { and, eq } from 'drizzle-orm';

import { db } from '$lib/server/db';
import { agents, sessions } from '$lib/server/db/schema';
import { getBrowserState } from '$lib/server/playwright-mcp-client';

/** Metadata companion to /browser/screenshot — returns URL/title/console.
 * Polled at ~2s cadence by the Browser state panel. */
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

	const state = await getBrowserState(rows[0].slug);
	if (!state) return error(503, 'Browser not ready');

	return json({
		pageUrl: state.pageUrl,
		pageTitle: state.pageTitle,
		consoleTail: state.consoleTail,
		lastUpdatedAt: new Date().toISOString(),
	});
};

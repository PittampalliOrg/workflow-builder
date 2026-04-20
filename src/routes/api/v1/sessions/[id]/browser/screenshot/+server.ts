import type { RequestHandler } from './$types';
import { error } from '@sveltejs/kit';
import { and, eq } from 'drizzle-orm';

import { db } from '$lib/server/db';
import { agents, sessions } from '$lib/server/db/schema';
import { takeScreenshot } from '$lib/server/playwright-mcp-client';

/**
 * Polled by the Browser state panel (~1 fps). Returns a raw JPEG the UI
 * can render in an <img> without base64 overhead. Workspace-scoped via
 * locals.session.projectId.
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

	const shot = await takeScreenshot(rows[0].slug);
	if (!shot) return error(503, 'Browser not ready');

	const body = new Uint8Array(shot.jpeg);
	return new Response(body, {
		headers: {
			'content-type': 'image/jpeg',
			'cache-control': 'no-store, max-age=0',
			'content-length': String(body.byteLength),
		},
	});
};

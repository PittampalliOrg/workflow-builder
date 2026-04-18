import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { db } from '$lib/server/db';
import { sessions } from '$lib/server/db/schema';
import { and, asc, eq } from 'drizzle-orm';

/**
 * GET /api/workflows/executions/[executionId]/sessions
 *
 * List sessions spawned by this workflow execution's `durable/run` nodes.
 * Scoped to the caller's active project — cross-workspace executions still
 * only surface sessions the user can open.
 */
export const GET: RequestHandler = async ({ params, locals }) => {
	if (!locals.session?.userId) return error(401, 'Authentication required');
	if (!db) return error(500, 'Database not available');

	const conditions = [eq(sessions.workflowExecutionId, params.executionId)];
	if (locals.session.projectId) {
		conditions.push(eq(sessions.projectId, locals.session.projectId));
	}

	const rows = await db
		.select({
			id: sessions.id,
			title: sessions.title,
			status: sessions.status,
			agentId: sessions.agentId,
			createdAt: sessions.createdAt,
			completedAt: sessions.completedAt,
		})
		.from(sessions)
		.where(and(...conditions))
		.orderBy(asc(sessions.createdAt));

	return json({
		sessions: rows.map((r) => ({
			id: r.id,
			title: r.title,
			status: r.status,
			agentId: r.agentId,
			createdAt: r.createdAt?.toISOString() ?? null,
			completedAt: r.completedAt?.toISOString() ?? null,
		})),
	});
};

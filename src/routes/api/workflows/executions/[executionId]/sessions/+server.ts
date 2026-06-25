import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { db } from '$lib/server/db';
import { sessions, workflowExecutions } from '$lib/server/db/schema';
import { and, asc, eq, inArray } from 'drizzle-orm';

/**
 * GET /api/workflows/executions/[executionId]/sessions
 *
 * List sessions spawned by this workflow execution's `durable/run` nodes.
 *
 * Resume/fork: a forked run only re-runs the suffix from `resumeFromNode` onward, so
 * the SKIPPED prefix's agent sessions live on the SOURCE run, not the fork. Without
 * this, a fork's detail page shows "no activity" (especially when the resumed suffix
 * has no agent nodes). So we walk the rerun lineage (`rerunOfExecutionId`) and include
 * the ancestor runs' sessions too, tagged `inherited` + `sourceExecutionId`.
 *
 * Scoped to the caller's active project — cross-workspace executions still only
 * surface sessions the user can open.
 */
export const GET: RequestHandler = async ({ params, locals }) => {
	if (!locals.session?.userId) return error(401, 'Authentication required');
	if (!db) return error(500, 'Database not available');

	// This run + its rerun ancestors (resume/fork lineage), nearest-first.
	const execIds: string[] = [params.executionId];
	let cursor: string | null = params.executionId;
	for (let hops = 0; hops < 20 && cursor; hops++) {
		const rows: Array<{ parent: string | null }> = await db
			.select({ parent: workflowExecutions.rerunOfExecutionId })
			.from(workflowExecutions)
			.where(eq(workflowExecutions.id, cursor))
			.limit(1);
		const parent: string | null = rows[0]?.parent ?? null;
		if (parent && !execIds.includes(parent)) {
			execIds.push(parent);
			cursor = parent;
		} else {
			cursor = null;
		}
	}

	const conditions = [inArray(sessions.workflowExecutionId, execIds)];
	if (locals.session.projectId) {
		conditions.push(eq(sessions.projectId, locals.session.projectId));
	}

	const rows = await db
		.select({
			id: sessions.id,
			title: sessions.title,
			status: sessions.status,
			agentId: sessions.agentId,
			workflowExecutionId: sessions.workflowExecutionId,
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
			// True when this session came from a source run the current run was forked
			// from — the UI labels it as inherited/replayed activity.
			inherited: r.workflowExecutionId !== params.executionId,
			sourceExecutionId:
				r.workflowExecutionId !== params.executionId ? r.workflowExecutionId : null,
			createdAt: r.createdAt?.toISOString() ?? null,
			completedAt: r.completedAt?.toISOString() ?? null,
		})),
	});
};

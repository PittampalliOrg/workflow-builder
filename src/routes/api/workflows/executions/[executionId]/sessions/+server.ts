import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getApplicationAdapters } from '$lib/server/application';

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
	const workflowData = getApplicationAdapters().workflowData;
	const execution = await workflowData.getScopedExecutionById({
		executionId: params.executionId,
		userId: locals.session.userId,
		projectId: locals.session.projectId,
	});
	if (!execution) return error(404, 'Execution not found');

	const rows = await workflowData.listExecutionSessions({
		executionId: params.executionId,
		projectId: locals.session.projectId,
		includeAncestors: true,
	});

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

import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { getApplicationAdapters } from "$lib/server/application";

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
	if (!locals.session?.userId) return error(401, "Authentication required");
	const result = await getApplicationAdapters().workflowExecutionSessions.listSessions({
		executionId: params.executionId,
		userId: locals.session.userId,
		projectId: locals.session.projectId,
	});
	if (result.status === "error") {
		return error(result.httpStatus, result.message);
	}
	return json(result.body);
};

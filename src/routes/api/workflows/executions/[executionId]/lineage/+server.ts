import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { getApplicationAdapters } from "$lib/server/application";

/**
 * GET /api/workflows/executions/[executionId]/lineage
 *
 * The fork lineage TREE for a run: its rerun ancestors (walk `rerunOfExecutionId` up to
 * the root) PLUS all descendants (runs forked from it, recursively). Forks are
 * first-class — this powers the collapsible lineage tree on the run page + the canvas
 * run-picker so a user can see "run → fork@node → fork@node" branches and navigate them.
 *
 * Returns a flat node list (the client builds the tree) rooted at the lineage ROOT, each:
 *   { id, status, fromNodeId, parentId, startedAt, completedAt, durationMs, isCurrent }
 * `fromNodeId` is the node this branch forked from (NULL for the root / non-fork runs).
 *
 * Workspace-scoped: the requested run must be in the caller's scope; the lineage is then
 * confined to that workflow's runs.
 */

export const GET: RequestHandler = async ({ params, locals }) => {
	if (!locals.session?.userId) return error(401, "Authentication required");
	const result = await getApplicationAdapters().workflowExecutionLineage.getLineage({
		executionId: params.executionId,
		userId: locals.session.userId,
		projectId: locals.session.projectId,
	});
	if (result.status === "error") {
		return error(result.httpStatus, result.message);
	}
	return json(result.body);
};

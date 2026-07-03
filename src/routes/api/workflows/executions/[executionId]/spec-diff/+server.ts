import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { getApplicationAdapters } from "$lib/server/application";

/**
 * GET /api/workflows/executions/[executionId]/spec-diff
 *
 * The per-branch spec diff: what NODES changed between a forked run and its parent.
 * Forks run a fresh copy of the (possibly edited) spec; each run snapshots the spec it
 * executed in `executionIr.spec` (start-run.ts), so we compare this run's spec against
 * its `rerunOfExecutionId` parent's. Returns a node-level summary (added/removed/changed)
 * + a unified diff per changed node — so a fork is self-explanatory ("changed: refine").
 *
 * `snapshotUnavailable` is true for runs created before spec snapshots were persisted.
 */

export const GET: RequestHandler = async ({ params, locals }) => {
	if (!locals.session?.userId) return error(401, "Authentication required");
	const result = await getApplicationAdapters().workflowExecutionSpecDiff.getSpecDiff({
		executionId: params.executionId,
		userId: locals.session.userId,
		projectId: locals.session.projectId,
	});
	if (result.status === "error") {
		return error(result.httpStatus, result.message);
	}
	return json(result.body);
};

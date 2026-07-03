import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { getApplicationAdapters } from "$lib/server/application";

/**
 * GET /api/workflows/executions/[executionId]/metrics
 *
 * Authoritative aggregate metrics for ONE workflow run, summed across every
 * session it spawned. Tokens are aggregated directly from the run's
 * `agent.llm_usage` session events grouped by their reported `model` — the
 * SAME source the per-session SessionPulse uses, so the rollup is consistent
 * AND correct for every runtime (the server-side `sessions.usage` rollup is
 * not populated for CLI-family sessions, which would otherwise read zero).
 * Per-model cost uses the shared pricing table (`costFor`), as in
 * `/api/v1/cost`. Duration/status counts are derived by the caller from the
 * sessions list; live tokens/sec come from the execution SSE stream.
 */
export const GET: RequestHandler = async ({ params, locals }) => {
	if (!locals.session?.userId) return error(401, "Authentication required");
	const result = await getApplicationAdapters().workflowExecutionMetrics.getMetrics({
		executionId: params.executionId,
		userId: locals.session.userId,
		projectId: locals.session.projectId,
	});
	if (result.status === "error") {
		return error(result.httpStatus, result.message);
	}
	return json(result.body);
};

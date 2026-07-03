import { json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { getApplicationAdapters } from "$lib/server/application";
import { requireInternal } from "$lib/server/internal-auth";

/**
 * POST /api/internal/goals/[sessionId]/evaluate
 *
 * Evaluator-gated completion. Called when a doer agent REQUESTS completion
 * (e.g. the goal-MCP `update_goal(complete)`). Runs the goal's declared evidence
 * commands in the session workspace; on success marks the goal complete + drives
 * the normal finalize/terminate path; on failure leaves the goal active and
 * returns the failing output so the caller can relay it to the agent.
 *
 * Internal-token gated. Returns { met, skipped, feedback }.
 */
export const POST: RequestHandler = async ({ params, request }) => {
	requireInternal(request);
	const result = await getApplicationAdapters().internalGoalControl.evaluateCompletion({
		sessionId: params.sessionId,
	});
	return json(result.body, { status: result.httpStatus ?? 200 });
};

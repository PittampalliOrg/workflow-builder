import { json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { requireInternal } from "$lib/server/internal-auth";
import { evaluateGoalCompletion } from "$lib/server/goals/evaluator";
import { markGoalComplete } from "$lib/server/goals/repo";
import { finalizeCompletedWorkflowGoal } from "$lib/server/goals/goal-loop";

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
	const sessionId = params.sessionId;
	if (!sessionId) return json({ met: false, feedback: "sessionId required" }, { status: 400 });

	const verdict = await evaluateGoalCompletion(sessionId);

	if (verdict.met) {
		// Authority to complete lives here, not with the doer. Idempotent.
		await markGoalComplete(sessionId);
		await finalizeCompletedWorkflowGoal(sessionId);
	}

	return json({
		met: verdict.met,
		skipped: verdict.skipped,
		feedback: verdict.feedback,
		results: verdict.results,
	});
};

import { json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { requireInternal } from "$lib/server/internal-auth";
import { evaluateGoalCompletion } from "$lib/server/goals/evaluator";
import { getCurrentGoal, markGoalComplete } from "$lib/server/goals/repo";
import { finalizeCompletedWorkflowGoal } from "$lib/server/goals/goal-loop";
import { appendEvent } from "$lib/server/sessions/events";

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
	} else if (!verdict.skipped) {
		// Record the evaluator REJECT so each submit→evaluate→verdict cycle shows
		// as a distinct attempt in the Goal view — the MCP fast-path (agent calls
		// update_goal and resubmits within one turn) never reaches the idle
		// backstop's emitter, so without this those rejects are invisible.
		const goal = await getCurrentGoal(sessionId);
		await appendEvent(sessionId, {
			type: "session.goal_rejected",
			data: {
				feedback: verdict.feedback,
				iteration: goal?.iterations ?? 0,
				results: verdict.results,
				source: "update_goal",
			},
			processedAt: null,
			sourceEventId: `goal-rejected:${sessionId}:mcp:${Date.now()}`,
		});
	}

	return json({
		met: verdict.met,
		skipped: verdict.skipped,
		feedback: verdict.feedback,
		results: verdict.results,
	});
};

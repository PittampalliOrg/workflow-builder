import { json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { requireInternal } from "$lib/server/internal-auth";
import {
	listCompletedUnterminatedWorkflowGoalSessions,
	listStalledDrivableSessions,
} from "$lib/server/goals/repo";
import {
	finalizeCompletedWorkflowGoal,
	kickGoalLoop,
} from "$lib/server/goals/goal-loop";

/**
 * POST /api/internal/goal-loop/tick
 *
 * Crash-safe backstop for the goal-loop driver, driven by the stacks
 * `goal-loop-tick` CronJob. The inline session-event hook (appendEvent) is the
 * fast path; this re-drives any goal whose session is idle but hasn't been
 * continued recently — covering a missed idle event, a goal set after its idle
 * fired, a raise that failed because the runtime pod wasn't ready, or a BFF
 * restart mid-loop. driveContinuationIfIdle re-checks the idle gate + claims
 * atomically, so re-driving never double-posts. Internal-token gated.
 *
 * Body: { staleSeconds?, limit? }.
 */
export const POST: RequestHandler = async ({ request }) => {
	requireInternal(request);
	const body = (await request.json().catch(() => ({}))) as Record<
		string,
		unknown
	>;
	const staleSeconds =
		typeof body.staleSeconds === "number" ? body.staleSeconds : 30;
	const limit = typeof body.limit === "number" ? body.limit : 100;

	const sessionIds = await listStalledDrivableSessions(staleSeconds, limit);
	let kicked = 0;
	for (const sessionId of sessionIds) {
		// allowStaleIdleProbe: the reaper is the recovery path for the lost-idle
		// crash window (idle event dropped while the BFF was down).
		await kickGoalLoop(sessionId, { allowStaleIdleProbe: true });
		kicked += 1;
	}

	// Backstop for goals marked complete (via the goal MCP) on a session that
	// then never idled — the idle-gated emit→terminate can't fire, so finalize
	// here (emit goal_completed + raise terminate) to unwedge the parent run.
	const completed = await listCompletedUnterminatedWorkflowGoalSessions(limit);
	let finalized = 0;
	for (const sessionId of completed) {
		await finalizeCompletedWorkflowGoal(sessionId);
		finalized += 1;
	}

	return json({
		scanned: sessionIds.length,
		kicked,
		completedScanned: completed.length,
		finalized,
	});
};

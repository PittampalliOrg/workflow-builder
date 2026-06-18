import { json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { requireInternal } from "$lib/server/internal-auth";
import { kickGoalLoop } from "$lib/server/goals/goal-loop";
import { getCurrentGoal } from "$lib/server/goals/repo";

/**
 * POST /api/internal/goals/[sessionId]/stop-check
 *
 * Synchronous, in-process equivalent of the idle-event-driven goal drive — the
 * dapr-agent-py Stop hook calls this at the end of each real turn so goal
 * evaluation/continuation is triggered RELIABLY (not dependent on the
 * fire-and-forget status_idle ingest landing + the 180s cron backstop).
 *
 * It runs the same `driveContinuationIfIdle` the idle loop does, with
 * `fromStopHook` to bypass only the "latest must be status_idle" gate (the Stop
 * hook fires after the turn completes). All other guards + exactly-once
 * (atomic claim, sourceEventId dedup, idempotent completion) are preserved, so
 * a duplicate call (or the cron backstop firing too) is harmless. No active
 * evaluator-mode goal → no-op (getDrivableGoal returns null inside the drive).
 *
 * Internal-token gated. Returns { goalStatus }.
 */
export const POST: RequestHandler = async ({ params, request }) => {
	requireInternal(request);
	const sessionId = params.sessionId;
	if (!sessionId) return json({ error: "sessionId required" }, { status: 400 });

	await kickGoalLoop(sessionId, { fromStopHook: true });

	const goal = await getCurrentGoal(sessionId).catch(() => null);
	return json({ goalStatus: goal?.status ?? null });
};

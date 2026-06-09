import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { inspectDurableRun } from "$lib/server/lifecycle";
import { isResourceInScope } from "$lib/server/workflows/project-scope";
import { getSession } from "$lib/server/sessions/registry";
import {
	createOrReplaceGoal,
	getCurrentGoal,
	markGoalComplete,
	pauseGoal,
} from "$lib/server/goals/repo";
import { kickGoalLoop } from "$lib/server/goals/goal-loop";

/**
 * GET /api/v1/sessions/[id]/goal — the session's current goal (or null).
 */
export const GET: RequestHandler = async ({ params, locals }) => {
	if (!locals.session?.userId) return error(401, "Authentication required");
	const session = await getSession(params.id);
	if (!session) return error(404, "Session not found");
	const goal = await getCurrentGoal(params.id);
	return json({ goal });
};

/**
 * POST /api/v1/sessions/[id]/goal — set (or replace) the session goal and kick
 * the autonomous continuation loop. Body: { objective, tokenBudget?, maxIterations? }.
 * Mirrors codex `thread/goal/set` (a new objective resets usage accounting).
 */
export const POST: RequestHandler = async ({ params, request, locals }) => {
	if (!locals.session?.userId) return error(401, "Authentication required");
	const inspected = await inspectDurableRun({ kind: "session", id: params.id });
	if (inspected.notFound) return error(404, "Session not found");
	if (inspected.scope && !isResourceInScope(inspected.scope, locals.session)) {
		return error(404, "Session not found");
	}

	const body = (await request.json().catch(() => ({}))) as Record<
		string,
		unknown
	>;
	const objective =
		typeof body.objective === "string" ? body.objective.trim() : "";
	if (!objective) return error(400, "objective is required");
	const tokenBudget =
		typeof body.tokenBudget === "number" ? body.tokenBudget : null;
	const maxIterations =
		typeof body.maxIterations === "number" ? body.maxIterations : undefined;

	const session = await getSession(params.id);
	const goal = await createOrReplaceGoal({
		sessionId: params.id,
		objective,
		tokenBudget,
		maxIterations,
		workflowExecutionId: session?.workflowExecutionId ?? null,
	});

	// Kick the loop now: if the session is already idle, the inline status_idle
	// hook won't fire again, so post the first continuation directly. (No-op if
	// the session is mid-turn — the turn-end idle drives it.)
	await kickGoalLoop(params.id);

	return json({ goal });
};

/**
 * PATCH /api/v1/sessions/[id]/goal — manual status change. Body: { status }.
 * Only `complete` and `paused` are user-settable here (active/budget_limited
 * transitions are owned by the agent + the loop driver).
 */
export const PATCH: RequestHandler = async ({ params, request, locals }) => {
	if (!locals.session?.userId) return error(401, "Authentication required");
	const inspected = await inspectDurableRun({ kind: "session", id: params.id });
	if (inspected.notFound) return error(404, "Session not found");
	if (inspected.scope && !isResourceInScope(inspected.scope, locals.session)) {
		return error(404, "Session not found");
	}
	const body = (await request.json().catch(() => ({}))) as Record<
		string,
		unknown
	>;
	const status = typeof body.status === "string" ? body.status : "";
	if (status !== "complete" && status !== "paused") {
		return error(400, "status must be 'complete' or 'paused'");
	}
	const goal =
		status === "complete"
			? await markGoalComplete(params.id)
			: await pauseGoal(params.id);
	if (!goal) return error(404, "No active goal for this session");
	return json({ goal });
};

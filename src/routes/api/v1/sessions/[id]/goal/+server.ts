import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { inspectDurableRun } from "$lib/server/lifecycle";
import { isResourceInScope } from "$lib/server/workflows/project-scope";
import { getSession } from "$lib/server/sessions/registry";
import { sessionUsesNativeGoal } from "$lib/server/sessions/runtime-target";
import { appendEvent } from "$lib/server/sessions/events";
import { raiseSessionUserEvents } from "$lib/server/sessions/spawn";
import {
	createOrReplaceGoal,
	getCurrentGoal,
	markGoalComplete,
	pauseGoal,
} from "$lib/server/goals/repo";
import { kickGoalLoop } from "$lib/server/goals/goal-loop";

/**
 * Type the given text into the live CLI TUI composer. Interactive-cli runtimes
 * (claude-code-cli/codex-cli/agy-cli) run their OWN native `/goal` loop inside
 * the vendor CLI, so we don't drive a BFF continuation loop for them — we just
 * type `/goal <objective>` (or `/goal clear`) into the terminal and let the
 * CLI's native goal harness take over. Delivery uses the same readiness-gated
 * injection path as the legacy continuation driver (Dapr buffers the raise
 * until the CLI's composer is ready), so it works for both fresh and live
 * sessions.
 */
async function injectCliCommand(
	sessionId: string,
	text: string,
): Promise<void> {
	const userMessage = {
		type: "user.message",
		content: [{ type: "text", text }],
		// Lets the UI style/hide it like the legacy hidden continuation turns.
		origin: "goal-native",
	};
	await appendEvent(sessionId, {
		type: "user.message",
		data: userMessage,
		processedAt: null,
		sourceEventId: `goal-native:${sessionId}:${Date.now()}`,
	});
	await raiseSessionUserEvents(sessionId, [userMessage]);
}

/**
 * GET /api/v1/sessions/[id]/goal — the session's current goal (or null).
 */
export const GET: RequestHandler = async ({ params, locals }) => {
	if (!locals.session?.userId) return error(401, "Authentication required");
	const session = await getSession(params.id);
	if (!session) return error(404, "Session not found");
	// Interactive-cli runtimes own goal state inside the vendor CLI's native
	// `/goal` harness — there is no BFF-tracked goal row to return.
	if (await sessionUsesNativeGoal(params.id)) {
		return json({ goal: null, native: true });
	}
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

	// CLI cutover: type `/goal <objective>` into the vendor CLI and let its
	// native goal harness drive the loop. No thread_goals row, no BFF
	// continuation driver, no goal-MCP completion contract for CLI sessions.
	if (await sessionUsesNativeGoal(params.id)) {
		await injectCliCommand(params.id, `/goal ${objective}`);
		return json({ native: true, objective });
	}

	const session = await getSession(params.id);
	const goal = await createOrReplaceGoal({
		sessionId: params.id,
		objective,
		tokenBudget,
		maxIterations,
		workflowExecutionId: session?.workflowExecutionId ?? null,
	});

	// Kick the loop now with kickoff=true: post continuation #1 immediately
	// without waiting for a status_idle. A freshly-set goal has no turn in flight,
	// so this avoids the slow first-turn start for runtimes that don't emit an
	// idle before their first turn (agy). Dapr buffers the raise until the agent
	// is ready; subsequent turns are driven by the turn-end idle as usual.
	await kickGoalLoop(params.id, { kickoff: true });

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
	// CLI cutover: clearing/completing a goal means stopping the CLI's native
	// `/goal` loop — type `/goal clear` into the terminal (aliases: stop/off/
	// reset/cancel). No BFF goal row to mutate.
	if (await sessionUsesNativeGoal(params.id)) {
		await injectCliCommand(params.id, "/goal clear");
		return json({ native: true });
	}
	const goal =
		status === "complete"
			? await markGoalComplete(params.id)
			: await pauseGoal(params.id);
	if (!goal) return error(404, "No active goal for this session");
	return json({ goal });
};

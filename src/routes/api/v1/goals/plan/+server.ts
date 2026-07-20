import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { getApplicationAdapters } from "$lib/server/application";
import {
	planGoal,
	finalizeGoalSpecFromText,
	type PlanGoalContext,
} from "$lib/server/goals/plan-goal";

/**
 * POST /api/v1/goals/plan
 *
 * Session-less goal authoring for the interactive Goal Workbench. Turns a user's
 * raw intent into a drafted goalSpec (objective + acceptanceCriteria + evidence
 * commands) + a rationale + static lint warnings. The user reviews/edits the
 * draft and commits it via POST /api/v1/sessions/[id]/goal (unchanged) — this
 * endpoint never persists anything.
 *
 * Body: { intent: string, context?: { repo, cwd, runtime, notes }, model? }
 * Returns: { goalSpec, rationale, lint }.
 */
export const POST: RequestHandler = async ({ request, locals }) => {
	if (!locals.session?.userId) return error(401, "Authentication required");
	const body = (await request.json().catch(() => ({}))) as Record<
		string,
		unknown
	>;
	// `fromText` mode: recover a validated goalSpec from a planner agent's
	// free-text output (no LLM call).
	const fromText = typeof body.fromText === "string" ? body.fromText : "";
	if (fromText.trim()) {
		try {
			return json(finalizeGoalSpecFromText(fromText));
		} catch (err) {
			return error(422, err instanceof Error ? err.message : "extract failed");
		}
	}
	const intent = typeof body.intent === "string" ? body.intent.trim() : "";
	if (!intent) return error(400, "intent or fromText is required");
	const context = (body.context ?? undefined) as PlanGoalContext | undefined;
	const model = typeof body.model === "string" ? body.model : undefined;

	try {
		const result = await planGoal(intent, context, {
			model,
			modelCompletion: getApplicationAdapters().modelCompletion,
		});
		return json(result);
	} catch (err) {
		return error(502, err instanceof Error ? err.message : "planGoal failed");
	}
};

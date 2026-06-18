import { json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { requireInternal } from "$lib/server/internal-auth";
import { planGoal, type PlanGoalContext } from "$lib/server/goals/plan-goal";

/**
 * POST /api/internal/goals/plan
 *
 * Server-to-server goal authoring. Used by the workflow `goal/plan` activity
 * (function-router proxies to here so the BFF stays the single owner of the LLM
 * keys + the one planGoal implementation, same boundary as the evaluator).
 *
 * Body: { intent: string, context?: { repo, cwd, runtime, notes }, model? }
 * Returns: { goalSpec, rationale, lint }.
 */
export const POST: RequestHandler = async ({ request }) => {
	requireInternal(request);
	const body = (await request.json().catch(() => ({}))) as Record<
		string,
		unknown
	>;
	const intent = typeof body.intent === "string" ? body.intent.trim() : "";
	if (!intent) return json({ error: "intent is required" }, { status: 400 });
	const context = (body.context ?? undefined) as PlanGoalContext | undefined;
	const model = typeof body.model === "string" ? body.model : undefined;

	try {
		const result = await planGoal(intent, context, { model });
		return json(result);
	} catch (err) {
		return json(
			{ error: err instanceof Error ? err.message : String(err) },
			{ status: 502 },
		);
	}
};

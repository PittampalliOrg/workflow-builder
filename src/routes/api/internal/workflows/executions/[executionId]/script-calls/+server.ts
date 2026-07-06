/**
 * GET /api/internal/workflows/executions/[executionId]/script-calls
 *
 * Internal-only: the orchestrator's `evaluate_script` activity loads the journal
 * (dynamic-script call results) from here to forward to the script-evaluator.
 * Returns { scriptCalls: ScriptCallRecord[] } ordered by issue order (seq).
 *
 * Auth: requires INTERNAL_API_TOKEN.
 */

import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { requireInternal } from "$lib/server/internal-auth";
import { getApplicationAdapters } from "$lib/server/application";

export const GET: RequestHandler = async ({ params, request }) => {
	requireInternal(request);
	const { executionId } = params;
	if (!executionId) return error(400, "executionId required");
	try {
		const calls = await getApplicationAdapters().scriptCalls.listInternal(executionId);
		return json({ scriptCalls: calls });
	} catch (err) {
		const message = err instanceof Error ? err.message : "script-calls read failed";
		if (message === "Database not configured") return error(503, message);
		throw err;
	}
};

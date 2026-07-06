/**
 * GET /api/internal/workflows/executions/[executionId]/llm-usage
 *
 * Internal-only: the orchestrator's `aggregate_script_usage` activity reads the
 * script `budget` accrual from here — SUM of the goal-loop `tokensFromUsage`
 * (input + output + cache_creation) over `agent.llm_usage` session events for
 * every session linked to this execution.
 *
 * Returns { totalTokens: number }.
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
		const { totalTokens } = await getApplicationAdapters().scriptCalls.llmUsage(executionId);
		return json({ totalTokens });
	} catch (err) {
		const message = err instanceof Error ? err.message : "llm-usage read failed";
		if (message === "Database not configured") return error(503, message);
		throw err;
	}
};

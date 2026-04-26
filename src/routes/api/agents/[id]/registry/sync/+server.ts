import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { registerAgent, syncAgentRuntimeCR } from "$lib/server/agents/registry-sync";

/**
 * POST /api/agents/{id}/registry/sync
 *
 * Force-register the agent's current version to the Dapr agent registry.
 * Idempotent — safe to call repeatedly.
 */
export const POST: RequestHandler = async ({ params, locals }) => {
	if (!locals.session?.userId) return error(401, "Authentication required");
	const result = await registerAgent(params.id);
	await syncAgentRuntimeCR(params.id);
	return json(result);
};

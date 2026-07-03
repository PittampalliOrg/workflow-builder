import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { getApplicationAdapters } from "$lib/server/application";

/**
 * POST /api/agents/{id}/registry/sync
 *
 * Force-register the agent's current version to the Dapr agent registry.
 * Idempotent — safe to call repeatedly.
 */
export const POST: RequestHandler = async ({ params, locals }) => {
	if (!locals.session?.userId) return error(401, "Authentication required");
	const { agentCatalog } = getApplicationAdapters();
	const result = await agentCatalog.syncAgentRegistry(params.id);
	return json(result);
};

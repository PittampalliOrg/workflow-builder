import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import {
	deregisterAgent,
	getRegistryStatus,
} from "$lib/server/agents/registry-sync";

/**
 * GET /api/agents/{id}/registry
 *
 * Returns the Dapr-registry sync status for an agent as recorded in Postgres
 * (source of truth), plus optional `?includeMetadata=1` to also read the
 * current blob back from the state store for display.
 */
export const GET: RequestHandler = async ({ params, url, locals }) => {
	if (!locals.session?.userId) return error(401, "Authentication required");
	const includeMetadata = url.searchParams.get("includeMetadata") === "1";
	const view = await getRegistryStatus(params.id, { includeMetadata });
	if (!view) return error(404, "Agent not found");
	return json(view);
};

/**
 * DELETE /api/agents/{id}/registry
 *
 * Force-deregister without archiving the agent. Useful for cleanup when the
 * Dapr state got out of sync (e.g., after a restore from a backup).
 */
export const DELETE: RequestHandler = async ({ params, locals }) => {
	if (!locals.session?.userId) return error(401, "Authentication required");
	const result = await deregisterAgent(params.id);
	return json(result);
};

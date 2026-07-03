import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { getApplicationAdapters } from "$lib/server/application";

/**
 * GET /api/v1/vaults/[id]/usages
 *
 * Returns agents that reference this vault in `defaultVaultIds` + the
 * count of active sessions that attached it. Mirrors the "Used by" card
 * pattern on the agent and environment detail pages.
 */
export const GET: RequestHandler = async ({ params, locals }) => {
	if (!locals.session?.userId) return error(401, "Authentication required");

	const vaultId = params.id;
	if (!vaultId) return error(400, "vault id is required");

	try {
		const result = await getApplicationAdapters().workflowData.getVaultUsages({
			vaultId,
		});
		return json(result);
	} catch (err) {
		const message = err instanceof Error ? err.message : "";
		if (/Database not configured/.test(message)) {
			return error(503, "Database not configured");
		}
		throw err;
	}
};

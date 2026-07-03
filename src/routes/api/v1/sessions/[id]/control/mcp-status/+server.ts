import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { getApplicationAdapters } from "$lib/server/application";

/**
 * Per-MCP-server credential health for the session. Iterates the agent's
 * declared mcp_servers, looks up a matching credential across the session's
 * attached vault_ids, and reports whether each server has valid auth.
 *
 * No Dapr event — pure internal query.
 */
export const GET: RequestHandler = async ({ params, locals }) => {
	if (!locals.session?.userId) return error(401, "Authentication required");
	const result = await getApplicationAdapters().sessionMcpStatus.getStatus({
		sessionId: params.id,
		projectId: locals.session.projectId ?? null,
		userId: locals.session.userId,
	});
	if (result.status === "not_found") return error(404, result.message);
	return json(result.body);
};

import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { getApplicationAdapters } from "$lib/server/application";

/**
 * Read-only "compiled capabilities" debug view: the effective `AgentConfig` the
 * runtime receives at spawn (flattened bundles + project-resolved MCP servers +
 * swap-safety verdict), secrets redacted.
 */
export const GET: RequestHandler = async ({ params, locals }) => {
	if (!locals.session?.userId) return error(401, "Authentication required");
	const { agentCatalog } = getApplicationAdapters();
	const result = await agentCatalog.compileCapabilities(params.id);
	if (result.status === "not_found") return error(404, result.message);
	return json({ compiled: result.compiled });
};

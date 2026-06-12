import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { compileAgentCapabilities } from "$lib/server/agents/compiled-capabilities";

/**
 * Read-only "compiled capabilities" debug view: the effective `AgentConfig` the
 * runtime receives at spawn (flattened bundles + project-resolved MCP servers +
 * swap-safety verdict), secrets redacted. See
 * `$lib/server/agents/compiled-capabilities.ts`.
 */
export const GET: RequestHandler = async ({ params, locals }) => {
	if (!locals.session?.userId) return error(401, "Authentication required");
	const compiled = await compileAgentCapabilities(params.id);
	if (!compiled) return error(404, "Agent not found");
	return json({ compiled });
};

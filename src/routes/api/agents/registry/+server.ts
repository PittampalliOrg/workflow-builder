import { json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { getApplicationAdapters } from "$lib/server/application";

/**
 * GET /api/agents/registry
 *
 * List Dapr Agents from the Dapr Agent Registry state component. This
 * diagnostics endpoint intentionally does not read workflow-builder database
 * tables.
 */
export const GET: RequestHandler = async () => {
	const { agentRegistryBrowser } = getApplicationAdapters();
	return json(await agentRegistryBrowser.listRegistryAgents());
};

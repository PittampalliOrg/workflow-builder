import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { getApplicationAdapters } from "$lib/server/application";

/**
 * GET /api/agents/usages-summary
 *
 * Returns a map of agentId → {workflowCount, nodeCount} computed in a
 * single DB scan over workflows.nodes + workflows.spec.do. Used by the
 * agents list page to render a "Used by" column without N round-trips.
 */
export const GET: RequestHandler = async ({ locals }) => {
	if (!locals.session?.userId) return error(401, "Authentication required");
	const { agentCatalog } = getApplicationAdapters();
	const counts = await agentCatalog.findAllAgentUsageCounts();
	return json({ counts });
};

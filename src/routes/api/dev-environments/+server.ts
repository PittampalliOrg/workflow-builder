import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { getApplicationAdapters } from "$lib/server/application";

/**
 * List the project's active dev environments (per-run dev previews + their bound
 * interactive coding-agent session). Drives the Dev hub grid.
 */
export const GET: RequestHandler = async ({ locals }) => {
	if (!locals.session?.userId) return error(401, "Authentication required");
	const environments = await getApplicationAdapters().workflowData.listDevEnvironments({
		projectId: locals.session.projectId,
	});
	return json({ environments });
};

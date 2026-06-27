import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { listDevEnvironments } from "$lib/server/workflows/dev-environments";

/**
 * List the project's active dev environments (per-run dev previews + their bound
 * interactive coding-agent session). Drives the Dev hub grid.
 */
export const GET: RequestHandler = async ({ locals }) => {
	if (!locals.session?.userId) return error(401, "Authentication required");
	const environments = await listDevEnvironments(locals.session.projectId);
	return json({ environments });
};

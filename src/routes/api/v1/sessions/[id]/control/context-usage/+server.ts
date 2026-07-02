import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { getApplicationAdapters } from "$lib/server/application";

/**
 * Synchronous read: token usage + event stats. Used by the usage panel in
 * the session UI to estimate how close we are to the model's context window.
 */
export const GET: RequestHandler = async ({ params, locals }) => {
	if (!locals.session?.userId) return error(401, "Authentication required");
	const usage = await getApplicationAdapters().workflowData.getSessionContextUsage({
		sessionId: params.id,
		projectId: locals.session.projectId ?? null,
	});
	if (!usage) return error(404, "Session not found");
	return json(usage);
};

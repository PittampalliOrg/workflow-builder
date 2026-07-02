import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { getApplicationAdapters } from "$lib/server/application";

/**
 * Synchronous read: session row + agent config + environment config.
 * Used by the session UI's settings drawer. No event raised.
 */
export const GET: RequestHandler = async ({ params, locals }) => {
	if (!locals.session?.userId) return error(401, "Authentication required");
	const settings = await getApplicationAdapters().workflowData.getSessionControlSettings({
		sessionId: params.id,
		projectId: locals.session.projectId ?? null,
		userId: locals.session.userId,
	});
	if (!settings) return error(404, "Session not found");

	return json(settings);
};

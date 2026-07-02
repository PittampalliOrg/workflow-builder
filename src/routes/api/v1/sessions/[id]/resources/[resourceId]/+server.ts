import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { getApplicationAdapters } from "$lib/server/application";

export const DELETE: RequestHandler = async ({ params, locals }) => {
	if (!locals.session?.userId) return error(401, "Authentication required");
	const ok = await getApplicationAdapters().workflowData.removeSessionResource({
		sessionId: params.id,
		resourceId: params.resourceId,
		projectId: locals.session.projectId ?? null,
		userId: locals.session.userId,
	});
	if (!ok) return error(404, "Resource not found");
	return json({ removed: true });
};

import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { getOpenShellSession } from "$lib/server/openshell-sessions";

export const GET: RequestHandler = async ({ params, locals }) => {
	if (!locals.session?.userId) return error(401, "Authentication required");
	const session = await getOpenShellSession(params.id, {
		userId: locals.session.userId,
		projectId: locals.session.projectId,
	});
	if (!session) return error(404, "OpenShell session not found");
	return json({ session });
};

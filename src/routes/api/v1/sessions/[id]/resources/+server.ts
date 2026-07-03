import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { getApplicationAdapters } from "$lib/server/application";

export const GET: RequestHandler = async ({ params, locals }) => {
	if (!locals.session?.userId) return error(401, "Authentication required");
	const resources = await getApplicationAdapters().workflowData.listSessionResources({
		sessionId: params.id,
		projectId: locals.session.projectId ?? null,
		userId: locals.session.userId,
	});
	if (!resources) return error(404, "Session not found");
	return json({ resources });
};

export const POST: RequestHandler = async ({ params, request, locals }) => {
	if (!locals.session?.userId) return error(401, "Authentication required");
	const body = (await request.json().catch(() => ({}))) as Record<
		string,
		unknown
	>;
	const result = await getApplicationAdapters().sessionCommands.addSessionResource({
		sessionId: params.id,
		projectId: locals.session.projectId ?? null,
		userId: locals.session.userId,
		body,
	});
	if (result.status === "invalid") return error(400, result.message);
	if (result.status === "not_found") return error(404, result.message);
	return json({ resource: result.resource }, { status: 201 });
};

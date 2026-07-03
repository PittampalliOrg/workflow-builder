import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { getApplicationAdapters } from "$lib/server/application";

export const GET: RequestHandler = async ({ params, locals }) => {
	if (!locals.session?.userId) return error(401, "Authentication required");
	const { agentCatalog } = getApplicationAdapters();
	const result = await agentCatalog.getAgent(params.id);
	if (result.status === "not_found") return error(404, result.message);
	return json({ agent: result.agent });
};

export const PUT: RequestHandler = async ({ params, request, locals }) => {
	if (!locals.session?.userId) return error(401, "Authentication required");
	const body = (await request.json().catch(() => ({}))) as Record<
		string,
		unknown
	>;
	const { agentCatalog } = getApplicationAdapters();
	const result = await agentCatalog.updateAgent({
		agentId: params.id,
		userId: locals.session.userId,
		body,
	});
	if (result.status === "invalid") return error(400, result.message);
	if (result.status === "not_found") return error(404, result.message);
	return json({ agent: result.agent });
};

export const DELETE: RequestHandler = async ({ params, locals }) => {
	if (!locals.session?.userId) return error(401, "Authentication required");
	const { agentCatalog } = getApplicationAdapters();
	const result = await agentCatalog.archiveAgent(params.id);
	if (result.status === "not_found") return error(404, result.message);
	return json({ archived: true });
};

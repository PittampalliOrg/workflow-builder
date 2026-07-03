import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { getApplicationAdapters } from "$lib/server/application";

export const GET: RequestHandler = async ({ params, locals }) => {
	if (!locals.session?.userId) return error(401, "Authentication required");
	const { agentCatalog } = getApplicationAdapters();
	const result = await agentCatalog.getVersion({
		agentId: params.id,
		version: params.version,
	});
	if (result.status === "invalid") return error(400, result.message);
	if (result.status === "not_found") return error(404, result.message);
	return json(result.version);
};

export const POST: RequestHandler = async ({ params, locals }) => {
	if (!locals.session?.userId) return error(401, "Authentication required");
	const { agentCatalog } = getApplicationAdapters();
	const result = await agentCatalog.restoreVersion({
		agentId: params.id,
		version: params.version,
		userId: locals.session.userId,
	});
	if (result.status === "invalid") return error(400, result.message);
	if (result.status === "not_found") return error(404, result.message);
	return json({ agent: result.agent });
};

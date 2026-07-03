import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { getApplicationAdapters } from "$lib/server/application";

export const GET: RequestHandler = async ({ params, locals }) => {
	if (!locals.session?.userId) return error(401, "Authentication required");
	const { agentCatalog } = getApplicationAdapters();
	const versions = await agentCatalog.listVersions(params.id);
	return json({ versions });
};

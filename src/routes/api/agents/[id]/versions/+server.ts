import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { listVersions } from "$lib/server/agents/registry";

export const GET: RequestHandler = async ({ params, locals }) => {
	if (!locals.session?.userId) return error(401, "Authentication required");
	const versions = await listVersions(params.id);
	return json({ versions });
};

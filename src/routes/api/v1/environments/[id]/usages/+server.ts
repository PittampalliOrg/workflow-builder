import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { findEnvironmentUsages } from "$lib/server/environments/registry";

export const GET: RequestHandler = async ({ params, locals }) => {
	if (!locals.session?.userId) return error(401, "Authentication required");
	const usages = await findEnvironmentUsages(params.id);
	return json({ usages, totalAgents: usages.length });
};

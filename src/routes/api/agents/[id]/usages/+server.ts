import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { findAgentUsages } from "$lib/server/agents/registry";

export const GET: RequestHandler = async ({ params, locals }) => {
	if (!locals.session?.userId) return error(401, "Authentication required");
	const usages = await findAgentUsages(params.id);
	return json({ usages, totalWorkflows: usages.length });
};
